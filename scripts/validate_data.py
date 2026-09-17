#!/usr/bin/env python3
"""Check a data push and report what looks wrong.

The workbook used to carry its own checks. Those were removed when it became
a pipeline, and the site derives everything now, so nothing between the Stripe
export and a chart looks at the numbers. A bad push lands silently and the
first person to notice is whoever reads a wrong chart and believes it.

This does not block the deploy. A push that fails here still publishes,
because a site showing questionable data with a warning beside it is more
useful than no site. It opens an issue instead.

Two rules run through all of it, and they are the two that have actually
bitten. Months are YYYY-MM text, because Sheets reparses an unprotected
2025-01 and 2025-1 sorts after 2025-10. And blank is null, never zero,
because a cohort that never recovered has no payback number and zero plots
as instant payback.
"""

import json
import re
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

REQUIRED_TABS = {
    "Waterfall Summary": {
        "file": "waterfall_summary.json",
        "min_rows": 24,
        "months": ["month"],
        "not_all_blank": ["active_logos", "new_logos", "churned_logos"],
    },
    "CAC Monthly": {
        "file": "cac_monthly.json",
        "min_rows": 12,
        "months": ["month"],
        "not_all_blank": ["cac_total_actual"],
    },
    "QB Expenses": {
        "file": "qb_expenses.json",
        "min_rows": 100,
        "months": ["month"],
        "not_all_blank": ["amount"],
        "allowed": {"bucket": ["CAC", "COGS", "SPLIT", "OPEN", "EXCLUDED", "UNMAPPED"]},
    },
    "Customer Waterfall": {
        "file": "customer_waterfall.json",
        "min_rows": 1000,
        "months": ["month"],
        "not_all_blank": ["eop_mrr"],
    },
}

findings = []


def report(level, tab, message):
    findings.append({"level": level, "tab": tab, "message": message})


def number(value):
    """Parse a cell the way the site does, so the checks see what charts see."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("$", "")
    if text in ("", "-", "--") or text.lower() in ("n/a", "na"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def load(name):
    path = DATA / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def check_tab(tab, spec, doc):
    rows = doc.get("rows", [])

    if len(rows) < spec["min_rows"]:
        report("error", tab,
               f"{len(rows)} rows, fewer than the {spec['min_rows']} expected. "
               f"The tab was probably not rebuilt, or a filter is hiding rows.")

    stated = doc.get("row_count")
    if stated is not None and stated != len(rows):
        report("error", tab,
               f"row_count says {stated} but there are {len(rows)} rows. "
               f"The push was interrupted partway through writing this file.")

    for column in spec.get("months", []):
        bad = [r.get(column) for r in rows
               if not (r.get(column) and MONTH.match(str(r[column])))]
        if bad:
            sample = ", ".join(repr(v) for v in list(dict.fromkeys(map(str, bad)))[:4])
            report("error", tab,
                   f"column {column!r} has {len(bad)} values that are not YYYY-MM text "
                   f"({sample}). The column lost its plain-text format and Sheets reparsed "
                   f"it as a date. As text 2025-1 sorts after 2025-10, so cost months stop "
                   f"lining up with cohort months without looking wrong.")

    for column in spec.get("not_all_blank", []):
        values = [number(r.get(column)) for r in rows]
        if all(v in (None, 0) for v in values):
            report("error", tab,
                   f"column {column!r} is entirely blank or zero across {len(rows)} rows. "
                   f"A column this central is never legitimately all zero.")

    for column, allowed in spec.get("allowed", {}).items():
        permitted = set(allowed)
        bad = sorted({str(r.get(column)) for r in rows
                      if r.get(column) is not None and r.get(column) not in permitted})
        if bad:
            report("error", tab,
                   f"column {column!r} holds values outside {sorted(permitted)}: "
                   f"{', '.join(bad[:5])}. Either a new classification was introduced "
                   f"upstream or a typo crept in.")


def check_zero_for_blank(doc, tab, columns):
    """A column that is suspiciously free of nulls where nulls are expected."""
    rows = doc.get("rows", [])
    for column in columns:
        if column not in doc.get("columns", []):
            continue
        nulls = sum(1 for r in rows if r.get(column) is None)
        zeros = sum(1 for r in rows if number(r.get(column)) == 0)
        if nulls == 0 and zeros > len(rows) * 0.3:
            report("warning", tab,
                   f"column {column!r} has no nulls but {zeros} zeros across {len(rows)} "
                   f"rows. Blanks may be arriving as zero, which plots as a real "
                   f"observation and means the opposite of missing.")


def main():
    index = load("index.json")
    if index is None:
        report("error", "index.json", "missing from the push, so nothing can be read")
        return finish()

    present = {entry["tab"]: entry for entry in index.get("files", [])}

    for tab, spec in REQUIRED_TABS.items():
        if tab not in present:
            report("error", tab, "not listed in index.json")
            continue

        doc = load(present[tab]["file"])
        if doc is None:
            report("error", tab, f"index.json lists {present[tab]['file']} but it is not there")
            continue

        listed = present[tab].get("rows")
        if listed is not None and listed != len(doc.get("rows", [])):
            report("error", tab,
                   f"index.json says {listed} rows, the file holds "
                   f"{len(doc.get('rows', []))}. The index was written against a different "
                   f"version of this file.")

        check_tab(tab, spec, doc)

    waterfall = load("waterfall_summary.json")
    if waterfall:
        check_zero_for_blank(waterfall, "Waterfall Summary", ["new_mrr", "churn_mrr"])

        # The base count is the one number that needs no interpretation, so a
        # sharp move in it is worth a look even when nothing is malformed.
        rows = [r for r in waterfall["rows"] if MONTH.match(str(r.get("month", "")))]
        rows.sort(key=lambda r: r["month"])
        # Only recent months, and only once the base is large enough that a
        # step means a rule changed rather than the company growing. Early
        # years legitimately move 15% a month and a check that fires on those
        # is a check somebody turns off.
        recent = rows[-24:]
        for previous, current in zip(recent, recent[1:]):
            before = number(previous.get("active_logos"))
            after = number(current.get("active_logos"))
            if before and after and before >= 200 and abs(after - before) / before > 0.12:
                report("warning", "Waterfall Summary",
                       f"active logos moved {before:,.0f} to {after:,.0f} between "
                       f"{previous['month']} and {current['month']}, more than 12%. "
                       f"Real bases do not step like that, so check whether a "
                       f"membership rule changed.")

    return finish()


def finish():
    errors = [f for f in findings if f["level"] == "error"]
    warnings = [f for f in findings if f["level"] == "warning"]

    if not findings:
        print("No problems found.")
        return 0

    lines = []
    if errors:
        lines.append(f"## {len(errors)} error{'s' if len(errors) != 1 else ''}\n")
        lines += [f"- **{f['tab']}** - {f['message']}" for f in errors]
        lines.append("")
    if warnings:
        lines.append(f"## {len(warnings)} warning{'s' if len(warnings) != 1 else ''}\n")
        lines += [f"- **{f['tab']}** - {f['message']}" for f in warnings]
        lines.append("")
    lines.append("The site still deployed. Nothing here blocks publishing, because a "
                 "site carrying a warning is more useful than no site.")

    body = "\n".join(lines)
    print(body)
    Path("validation-report.md").write_text(body, encoding="utf-8")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
