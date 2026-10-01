#!/usr/bin/env python3
"""Tie the pipeline's cost inputs to QuickBooks, and Stripe cash to QuickBooks revenue.

Every cost figure on the site is a sum of rows in data/qb_expenses.json, which
the workbook pipeline pulls from QuickBooks and pushes here. Nothing between
QuickBooks and the chart checks that the push still says what the ledger says.
This does, against a Transaction Detail by Account export taken from
QuickBooks itself (Reports > Transaction Detail by Account, all accounts, the
period you want to tie, exported to Excel). The export carries customer and
vendor names, so it stays outside the repository; only account-by-month
totals are read from it and only those appear in the report.

Two reconciliations, one report:

1. Expense and revenue accounts, by account and month. The pipeline amount
   and the export amount either agree to the dollar or they do not. A month
   that had not closed when the pipeline pulled it will not agree, because
   the close reclassifies the revenue clearing account and books the month's
   adjustments; such a month is recognisable because 4000-96 Revenue Clearing
   still carries a balance in the pipeline's copy. Differences there are
   reported as close timing. Differences in any other month are unexplained
   and fail the run.

2. Stripe cash against QuickBooks revenue, by month. data/cash_detail.json
   is what Stripe actually collected; the 4000 accounts are what QuickBooks
   recognised. They are not the same quantity and are not expected to tie to
   the dollar: Stripe collects sales tax that QuickBooks holds as a
   liability, and QuickBooks books an invoice when it is raised while Stripe
   books the cash when it lands. The report shows both, the gap, and the tax
   component, so a reader can see how much of the gap is accounted for.

Exit code 0 when every closed month ties; 1 otherwise. Months are YYYY-MM
text throughout; blank is null, never zero.

    python scripts/reconcile_ledger.py --export "path/to/Transaction Detail by Account.xlsx"
"""

import argparse
import collections
import datetime as dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

PL_ACCOUNT = re.compile(r"^[4-9]\d{3}-\d{2} ")
CLEARING = "4000-96"
TOLERANCE = 1.0


def month_of(value):
    """Month as YYYY-MM from whatever the export put in the date column."""
    if isinstance(value, (dt.date, dt.datetime)):
        return f"{value.year:04d}-{value.month:02d}"
    text = str(value or "").strip()
    slashed = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", text)
    if slashed:
        return f"{slashed.group(3)}-{int(slashed.group(1)):02d}"
    iso = re.match(r"^(\d{4})-(\d{2})", text)
    return f"{iso.group(1)}-{iso.group(2)}" if iso else None


def number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("$", "")
    if text in ("", "-", "--"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def read_export(path):
    """Account x month totals from a Transaction Detail by Account export.

    The sheet is a header block, then for each account a title row (column A
    set, column B blank), its transaction rows, and a 'Total for <account>'
    row. Only profit and loss accounts (4000 to 9999) are kept; balance sheet
    accounts are in the export but have no counterpart in the pipeline.
    Parent accounts appear as '<name> (with sub-accounts)' totals and are
    skipped so nothing is counted twice.
    """
    from openpyxl import load_workbook

    ws = load_workbook(path, data_only=True, read_only=True).active
    totals = collections.defaultdict(float)
    period = [None, None]
    account = None
    amount_col = None
    for row in ws.iter_rows(min_row=1, values_only=True):
        first = row[0]
        if amount_col is None and first is None and row[1]                 and str(row[1]).strip().lower() in ("date", "transaction date"):
            amount_col = next((i for i, c in enumerate(row)
                               if str(c or "").strip().lower() == "amount"), 7)
            continue
        if first is not None and str(first).startswith("Total for"):
            account = None
            continue
        if first is not None and row[1] is None:
            account = str(first).strip()
            continue
        if account is None or row[1] is None or amount_col is None:
            continue
        if not PL_ACCOUNT.match(account) or "with sub-accounts" in account:
            continue
        month = month_of(row[1])
        amount = number(row[amount_col])
        if not month or amount is None:
            continue
        totals[(account, month)] += amount
        period[0] = month if period[0] is None or month < period[0] else period[0]
        period[1] = month if period[1] is None or month > period[1] else period[1]
    if not totals:
        raise SystemExit(f"nothing readable in {path}: is it a Transaction Detail by Account export?")
    return totals, period


def read_rows(file):
    doc = json.loads((DATA / file).read_text(encoding="utf-8"))
    cols = doc["columns"]
    rows = doc["rows"]
    if doc.get("row_format", "arrays") == "arrays":
        rows = [dict(zip(cols, r)) for r in rows]
    return doc, rows


def read_pipeline():
    doc, rows = read_rows("qb_expenses.json")
    totals = collections.defaultdict(float)
    months = set()
    for r in rows:
        amount = number(r.get("amount"))
        month = r.get("month")
        if amount is None or not month:
            continue
        totals[(str(r["account"]).strip(), month)] += amount
        months.add(month)
    return doc, totals, sorted(months)


def read_stripe():
    try:
        doc, rows = read_rows("cash_detail.json")
    except FileNotFoundError:
        return None, {}
    by_month = collections.defaultdict(lambda: collections.defaultdict(float))
    for r in rows:
        m = r.get("month")
        if not m:
            continue
        for key in ("net_cash", "tax_collected", "refunded"):
            v = number(r.get(key))
            if v is not None:
                by_month[m][key] += v
    return doc, by_month


def money(v):
    if v is None:
        return ""
    sign = "-" if v < -0.5 else ""
    return f"{sign}${abs(v):,.0f}"


def reconcile(export_path, out_path):
    export, (first, last) = read_export(export_path)
    pipeline_doc, pipeline, pipeline_months = read_pipeline()
    stripe_doc, stripe = read_stripe()

    today = dt.date.today().strftime("%Y-%m")
    # Months both sides hold in full. The month the push was taken in and the
    # month the export was taken in are each partial, so the comparison stops
    # at the last full month on both sides.
    pushed = (pipeline_doc.get("pushed_at") or "")[:7]
    cutoff = min(pushed or today, today)
    full = [m for m in pipeline_months if first <= m <= last and m < cutoff]
    partial = [m for m in pipeline_months if first <= m <= last and m not in full]

    # A month the pipeline pulled before QuickBooks closed it still carries a
    # revenue clearing balance. That is the rule for 'close timing'.
    def clearing(m):
        return sum(v for (a, mm), v in pipeline.items() if mm == m and a.startswith(CLEARING))
    unclosed = {m for m in full if abs(clearing(m)) > TOLERANCE}

    accounts = sorted({a for (a, m) in list(pipeline) + list(export) if m in full})
    ties, timing, unexplained = [], [], []
    for a in accounts:
        for m in full:
            p = pipeline.get((a, m))
            x = export.get((a, m))
            if p is None and x is None:
                continue
            diff = (p or 0.0) - (x or 0.0)
            row = (a, m, p, x, diff)
            if abs(diff) <= TOLERANCE:
                ties.append(row)
            elif m in unclosed:
                timing.append(row)
            else:
                unexplained.append(row)

    closed = [m for m in full if m not in unclosed]
    sum_p = sum(v for (a, m), v in pipeline.items() if m in closed)
    sum_x = sum(v for (a, m), v in export.items() if m in closed)

    lines = []
    w = lines.append
    w("# Cost inputs tied to QuickBooks")
    w("")
    w(f"Written by `scripts/reconcile_ledger.py` on {dt.date.today().isoformat()} against push "
      f"`{pipeline_doc.get('pushed_at', '?')}` (pipeline {pipeline_doc.get('pipeline_version', '?')}) "
      f"and a QuickBooks Transaction Detail by Account export covering {first} to {last}.")
    w("")
    w("The export is not in the repository: it carries customer and vendor names on every line. "
      "Only account-by-month totals are read from it and only those appear here. "
      "Re-run the script with a fresh export to refresh this file.")
    w("")
    w("## 1. Expense and revenue lines, by account and month")
    w("")
    w(f"Months compared in full: {full[0] if full else 'none'} to {full[-1] if full else 'none'}, "
      f"{len(full)} months, {len(accounts)} accounts, "
      f"{len(ties) + len(timing) + len(unexplained):,} account-months.")
    if partial:
        w(f"Not compared: {', '.join(partial)}, partial on at least one side "
          f"(the push is dated {pushed or 'unknown'}, the export ends {last}).")
    w("")
    w("| Result | Account-months | Dollars of difference |")
    w("|---|---|---|")
    w(f"| Tie to the dollar | {len(ties):,} | {money(0)} |")
    w(f"| Close timing (month not yet closed when the pipeline pulled it) | {len(timing):,} | "
      f"{money(sum(abs(r[4]) for r in timing))} gross |")
    w(f"| Unexplained | {len(unexplained):,} | {money(sum(abs(r[4]) for r in unexplained))} gross |")
    w("")
    if closed:
        w(f"Over the {len(closed)} closed months ({closed[0]} to {closed[-1]}) the pipeline holds "
          f"{money(sum_p)} across every profit and loss account and the export holds {money(sum_x)}; "
          f"the difference is {money(sum_p - sum_x)}.")
        w("")
    if unclosed:
        w(f"Unclosed in the pipeline's copy: {', '.join(sorted(unclosed))}. "
          "The test is that 4000-96 Revenue Clearing still carries a balance there, which it only "
          "does until the month closes. Every difference in such a month is the close itself: the "
          "clearing balance moving to the revenue accounts, and the month's adjusting entries.")
        w("")
    if timing:
        w("### Close timing, by account")
        w("")
        w("| Account | Month | Pipeline | QuickBooks now | Difference |")
        w("|---|---|---|---|---|")
        for a, m, p, x, d in sorted(timing, key=lambda r: -abs(r[4])):
            w(f"| {a} | {m} | {money(p)} | {money(x)} | {money(d)} |")
        w("")
        w("The next data push will carry the closed figures and these rows will tie.")
        w("")
    if unexplained:
        w("### Unexplained")
        w("")
        w("| Account | Month | Pipeline | QuickBooks now | Difference |")
        w("|---|---|---|---|---|")
        for a, m, p, x, d in sorted(unexplained, key=lambda r: -abs(r[4])):
            w(f"| {a} | {m} | {money(p)} | {money(x)} | {money(d)} |")
        w("")
        w("These are in closed months and need a reason: a journal posted after the push, an account "
          "recoded, or a pipeline mapping that drops a line.")
        w("")
    else:
        w("No account-month in a closed month differs by more than a dollar.")
        w("")
    only_p = sorted({a for (a, m) in pipeline if m in full} - {a for (a, m) in export if m in full})
    only_x = sorted({a for (a, m) in export if m in full} - {a for (a, m) in pipeline if m in full})
    if only_p or only_x:
        w("Accounts present on one side only in the compared months "
          "(their amounts are in the tables above where they differ):")
        w("")
        for a in only_p:
            w(f"- `{a}`: pipeline only")
        for a in only_x:
            w(f"- `{a}`: export only")
        w("")

    w("## 2. Stripe cash against QuickBooks revenue")
    w("")
    if not stripe:
        w("`data/cash_detail.json` is not in this push, so this section is empty.")
        w("")
    else:
        w("Stripe net cash is what customers paid, after refunds, in the month it landed. QuickBooks "
          "revenue is the 4000 accounts, net of refunds, discounts and chargebacks, in the month it was "
          "recognised. They differ by design in two ways. Stripe collects sales tax, which QuickBooks "
          "books to a liability rather than revenue, so it is shown and taken out. And QuickBooks books "
          "an invoice when raised while Stripe books cash when it arrives, so an annual invoice or a late "
          "payment moves a month on one side and not the other; that part is timing and is not itemised "
          "here.")
        w("")
        w("| Month | Stripe net cash | Of which tax | Stripe ex tax | QuickBooks revenue | Gap | Gap % |")
        w("|---|---|---|---|---|---|---|")
        tot = collections.defaultdict(float)
        for m in full:
            s = stripe.get(m)
            if not s:
                continue
            qb = sum(v for (a, mm), v in pipeline.items() if mm == m and a.startswith("4"))
            ex_tax = s["net_cash"] - s["tax_collected"]
            gap = qb - ex_tax
            for k, v in (("net", s["net_cash"]), ("tax", s["tax_collected"]), ("ex", ex_tax),
                         ("qb", qb), ("gap", gap)):
                tot[k] += v
            pct = f"{gap / ex_tax * 100:+.1f}%" if ex_tax else ""
            w(f"| {m} | {money(s['net_cash'])} | {money(s['tax_collected'])} | {money(ex_tax)} | "
              f"{money(qb)} | {money(gap)} | {pct} |")
        pct = f"{tot['gap'] / tot['ex'] * 100:+.1f}%" if tot["ex"] else ""
        w(f"| **Total** | **{money(tot['net'])}** | **{money(tot['tax'])}** | **{money(tot['ex'])}** | "
          f"**{money(tot['qb'])}** | **{money(tot['gap'])}** | **{pct}** |")
        w("")
        w(f"Over the period QuickBooks recognised {money(tot['gap'])} more than Stripe collected ex tax, "
          f"{pct} of cash. A positive gap is revenue invoiced ahead of its cash, which is what annual "
          "billing and past-due accounts produce; chart 43 on the page counts the past-due accounts "
          "behind part of it.")
        w("")
    w("## 3. What this does and does not establish")
    w("")
    w("- Every cost line the site derives from, in every closed month the export covers, is the "
      "QuickBooks figure. Charts 26, 27, 33, 39, 40, 41, 48 and 49 and the price floors all sum "
      "these rows.")
    w("- Months before the export begins are not checked by this run. Take a longer export to check "
      "them.")
    w("- The grouping of accounts into layers (platform, people, variable, G&A, R&D, acquisition) is "
      "editorial and lives in `site/data.js` as `COST_LAYERS`; this script checks amounts, not "
      "grouping.")
    w("- Stripe and QuickBooks are reconciled at the month, not the invoice. A per-invoice tie needs "
      "the QuickBooks customer ledger, which is not pushed.")
    w("")
    Path(out_path).write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

    print(f"compared {len(full)} months, {len(accounts)} accounts")
    print(f"  tie: {len(ties):,}   close timing: {len(timing):,}   unexplained: {len(unexplained):,}")
    print(f"wrote {out_path}")
    return 0 if not unexplained else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--export", required=True,
                    help="QuickBooks Transaction Detail by Account .xlsx")
    ap.add_argument("--out", default=str(ROOT / "RECONCILIATION.md"))
    args = ap.parse_args()
    sys.exit(reconcile(args.export, args.out))


if __name__ == "__main__":
    main()
