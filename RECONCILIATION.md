# Cost inputs tied to QuickBooks

Written by `scripts/reconcile_ledger.py` on 2026-10-19 against push `2026-10-19T15:00:33` (pipeline v176) and a QuickBooks Transaction Detail by Account export covering 2025-09 to 2026-10.

The export is not in the repository: it carries customer and vendor names on every line. Only account-by-month totals are read from it and only those appear here. Re-run the script with a fresh export to refresh this file.

## 1. Expense and revenue lines, by account and month

Months compared in full: 2025-09 to 2026-09, 13 months, 111 accounts, 1,107 account-months.
Not compared: 2026-10, partial on at least one side (the push is dated 2026-10, the export ends 2026-10).

| Result | Account-months | Dollars of difference |
|---|---|---|
| Tie to the dollar | 1,098 | $0 |
| Close timing (month not yet closed when the pipeline pulled it) | 0 | $0 gross |
| Unexplained | 9 | $16,775 gross |

Over the 13 closed months (2025-09 to 2026-09) the pipeline holds $21,801,689 across every profit and loss account and the export holds $21,796,013; the difference is $5,675.

### Unexplained

| Account | Month | Pipeline | QuickBooks now | Difference |
|---|---|---|---|---|
| 7000-01 Interest Income | 2025-12 | $10,025 | $5,408 | $4,617 |
| 5000-02 COS - Software | 2026-07 | $82,794 | $86,770 | -$3,976 |
| 5000-02 COS - Software | 2026-08 | $79,991 | $76,016 | $3,976 |
| 6100-01 S&M - Professional Services | 2026-08 | $33,351 | $31,293 | $2,058 |
| 6200-01 G&A - Professional Services | 2026-08 | $13,255 | $14,255 | -$1,000 |
| 6100-02 S&M - Software | 2026-06 | $8,831 | $9,390 | -$559 |
| 6100-02 S&M - Software | 2026-08 | $8,889 | $8,330 | $559 |
| 6200-07 G&A - Company Meals | 2026-06 | $2,033 | $2,048 | -$15 |
| 6200-06 G&A - Office Supplies, Snacks and Misc Expenses | 2026-06 | $4,148 | $4,133 | $15 |

These are in closed months and need a reason: a journal posted after the push, an account recoded, or a pipeline mapping that drops a line.

Accounts present on one side only in the compared months (their amounts are in the tables above where they differ):

- `4000-12 Platform Revenue - Usage Based`: export only
- `4000-96 Revenue Clearing`: export only

## 2. Stripe cash against QuickBooks revenue

Stripe net cash is what customers paid, after refunds, in the month it landed. QuickBooks revenue is the 4000 accounts, net of refunds, discounts and chargebacks, in the month it was recognised. They differ by design in two ways. Stripe collects sales tax, which QuickBooks books to a liability rather than revenue, so it is shown and taken out. And QuickBooks books an invoice when raised while Stripe books cash when it arrives, so an annual invoice or a late payment moves a month on one side and not the other; that part is timing and is not itemised here.

| Month | Stripe net cash | Of which tax | Stripe ex tax | QuickBooks revenue | Gap | Gap % |
|---|---|---|---|---|---|---|
| 2025-09 | $869,767 | $0 | $869,767 | $879,753 | $9,987 | +1.1% |
| 2025-10 | $877,723 | $0 | $877,723 | $833,129 | -$44,594 | -5.1% |
| 2025-11 | $830,068 | $0 | $830,068 | $830,577 | $510 | +0.1% |
| 2025-12 | $873,121 | $0 | $873,121 | $845,295 | -$27,826 | -3.2% |
| 2026-01 | $830,617 | $2,871 | $827,746 | $900,104 | $72,358 | +8.7% |
| 2026-02 | $860,475 | $3,387 | $857,088 | $888,480 | $31,392 | +3.7% |
| 2026-03 | $889,576 | $5,736 | $883,840 | $910,443 | $26,604 | +3.0% |
| 2026-04 | $912,176 | $8,734 | $903,442 | $921,503 | $18,062 | +2.0% |
| 2026-05 | $883,863 | $10,591 | $873,271 | $864,967 | -$8,304 | -1.0% |
| 2026-06 | $854,328 | $12,515 | $841,813 | $840,868 | -$945 | -0.1% |
| 2026-07 | $826,662 | $15,706 | $810,956 | $835,592 | $24,636 | +3.0% |
| 2026-08 | $837,768 | $16,115 | $821,653 | $842,594 | $20,941 | +2.5% |
| 2026-09 | $800,443 | $15,141 | $785,303 | $804,187 | $18,885 | +2.4% |
| **Total** | **$11,146,585** | **$90,796** | **$11,055,789** | **$11,197,493** | **$141,704** | **+1.3%** |

Over the period QuickBooks recognised $141,704 more than Stripe collected ex tax, +1.3% of cash. A positive gap is revenue invoiced ahead of its cash, which is what annual billing and past-due accounts produce; chart 43 on the page counts the past-due accounts behind part of it.

## 3. What this does and does not establish

- Every cost line the site derives from, in every closed month the export covers, is the QuickBooks figure. Charts 26, 27, 33, 39, 40, 41, 48 and 49 and the price floors all sum these rows.
- Months before the export begins are not checked by this run. Take a longer export to check them.
- The grouping of accounts into layers (platform, people, variable, G&A, R&D, acquisition) is editorial and lives in `site/data.js` as `COST_LAYERS`; this script checks amounts, not grouping.
- Stripe and QuickBooks are reconciled at the month, not the invoice. A per-invoice tie needs the QuickBooks customer ledger, which is not pushed.

