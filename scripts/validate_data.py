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
LIVE_EVENTS = {"new", "reactivation", "flat", "expansion", "contraction"}

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


def check_presence_is_not_payment(waterfall, customers):
    """Catch presence being decided by whether cash arrived.

    A customer who is billed but misses a payment drops to zero, reads as
    churned, and reads as a reactivation when they pay again. Presence and
    payment are different questions, and treating them as one inflates both
    sides of the funnel while the base drifts down.

    Neither check below looks at a single month, because a single month never
    breaches a sensible threshold. The signature is a rate that stays high.
    """
    rows = [r for r in waterfall.get("rows", []) if MONTH.match(str(r.get("month", "")))]
    rows.sort(key=lambda r: r["month"])

    # A base does not reactivate a large share of itself every year. Twelve
    # months smooths out a seasonal return and still catches a standing rate.
    window = rows[-13:]
    if len(window) >= 13:
        reactivated = sum(number(r.get("reactivated_logos")) or 0 for r in window[1:])
        bases = [number(r.get("active_logos")) or 0 for r in window[:-1]]
        average = sum(bases) / len(bases) if bases else 0
        if average >= 200 and reactivated / average > 0.15:
            report("error", "Waterfall Summary",
                   f"{reactivated:,.0f} reactivations over the last twelve months against an "
                   f"average base of {average:,.0f}, {reactivated / average:.0%}. A base does "
                   f"not reactivate that share of itself in a year. This is the signature of "
                   f"presence being decided by whether a payment arrived: a billed customer "
                   f"who misses a month reads as churned and reads as reactivated when they "
                   f"pay again. Churn and acquisition are both inflated and the base drifts "
                   f"down.")

    # The same fault seen per customer rather than in the totals.
    #
    # A revenue gap is not the fault and never was. A billed customer who pays
    # late has a zero month and belongs in the base throughout, which is why
    # presence is read from event_type. The fault is that gap being recorded as
    # a departure: a churn with revenue on both sides of it, which invents a
    # loss and an acquisition out of one late payment.
    if not customers:
        return
    by_customer = {}
    for row in customers.get("rows", []):
        by_customer.setdefault(row.get("customer_id"), {})[row.get("month")] = (
            number(row.get("eop_mrr")) or 0, str(row.get("event_type") or ""))

    spurious = 0
    paying = 0
    gap_only = 0
    for months in by_customer.values():
        keys = sorted(k for k in months if k)
        live = [i for i, k in enumerate(keys) if months[k][0] > 0]
        if not live:
            continue
        paying += 1
        first, last = live[0], live[-1]
        interior = range(first + 1, last)
        if any(months[keys[i]][0] == 0 for i in interior):
            gap_only += 1
        if any(months[keys[i]][1] == "churn" for i in interior):
            spurious += 1

    if paying and spurious / paying > 0.05:
        report("error", "Customer Waterfall",
               f"{spurious:,} of {paying:,} paying customers ({spurious / paying:.0%}) are "
               f"marked churned in a month that has revenue on both sides of it. A customer "
               f"who was there in March and there in May did not leave in April, so presence "
               f"is being read from payment rather than from a subscription or a base "
               f"membership.")
    elif gap_only:
        report("note", "Customer Waterfall",
               f"{gap_only:,} of {paying:,} paying customers ({gap_only / paying:.0%}) have a "
               f"zero revenue month with revenue on both sides. None of them is recorded as a "
               f"departure, which is the expected shape: these are late payments, and "
               f"presence is carried by event_type rather than by the amount.")


def check_departures_are_booked(waterfall, customers):
    """Catch customers leaving the base without a churn event.

    churned_logos books a departure when the pipeline sees the transition. A
    customer whose subscription drops out of the Stripe export never produces
    one: they are present one month, absent the next, and nothing is recorded.
    Those are real departures, not test accounts, and leaving them uncounted
    understates churn by enough to reverse the direction of the base.
    """
    if not customers:
        return
    live = {}
    for row in customers.get("rows", []):
        month = str(row.get("month", ""))
        if not MONTH.match(month) or row.get("event_type") not in LIVE_EVENTS:
            continue
        live.setdefault(month, set()).add(row.get("customer_id"))

    months = sorted(live)
    if len(months) < 8:
        return
    window = months[-6:]

    left = 0
    for month in window:
        previous = months[months.index(month) - 1]
        left += len(live[previous] - live[month])

    booked = 0
    for row in waterfall.get("rows", []):
        if str(row.get("month", "")) in window:
            booked += number(row.get("churned_logos")) or 0

    if booked and left > booked * 1.15:
        report("error", "Waterfall Summary",
               f"over {window[0]} to {window[-1]} the push books {booked:,.0f} departures "
               f"while {left:,} customers present in one month are absent the next, "
               f"{left / booked - 1:.0%} more. A customer whose subscription drops out of "
               f"the source stops appearing without generating a churn event, so churn is "
               f"understated. Check the derived figure before using churned_logos.")
    elif booked:
        report("note", "Waterfall Summary",
               f"departures reconcile: {booked:,.0f} booked against {left:,} observed over "
               f"the last six months.")


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
        customers = load("customer_waterfall.json")
        check_presence_is_not_payment(waterfall, customers)
        check_departures_are_booked(waterfall, customers)

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
    # Notes record a check that passed in a way worth stating, so a reader can
    # tell "this was tested and is fine" from "this was never looked at".
    notes = [f for f in findings if f["level"] == "note"]

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
    if notes:
        lines.append(f"## {len(notes)} note{'s' if len(notes) != 1 else ''}\n")
        lines += [f"- **{f['tab']}** - {f['message']}" for f in notes]
        lines.append("")
    if errors or warnings:
        lines.append("The site still deployed. Nothing here blocks publishing, because a "
                     "site carrying a warning is more useful than no site.")
    else:
        lines.append("No errors or warnings. The notes above are checks that passed.")

    body = "\n".join(lines)
    print(body)
    Path("validation-report.md").write_text(body, encoding="utf-8")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
