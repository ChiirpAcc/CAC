# Cost inputs tied to QuickBooks

Written by `scripts/reconcile_ledger.py` on 2026-10-01 against push `2026-09-24T16:34:23` (pipeline v119) and a QuickBooks Transaction Detail by Account export covering 2025-09 to 2026-09.

The export is not in the repository: it carries customer and vendor names on every line. Only account-by-month totals are read from it and only those appear here. Re-run the script with a fresh export to refresh this file.

## 1. Expense and revenue lines, by account and month

Months compared in full: 2025-09 to 2026-08, 12 months, 113 accounts, 1,024 account-months.
Not compared: 2026-09, partial on at least one side (the push is dated 2026-09, the export ends 2026-09).

| Result | Account-months | Dollars of difference |
|---|---|---|
| Tie to the dollar | 1,006 | $0 |
| Close timing (month not yet closed when the pipeline pulled it) | 18 | $1,783,737 gross |
| Unexplained | 0 | $0 gross |

Over the 11 closed months (2025-09 to 2026-07) the pipeline holds $18,783,511 across every profit and loss account and the export holds $18,783,511; the difference is $0.

Unclosed in the pipeline's copy: 2026-08. The test is that 4000-96 Revenue Clearing still carries a balance there, which it only does until the month closes. Every difference in such a month is the close itself: the clearing balance moving to the revenue accounts, and the month's adjusting entries.

### Close timing, by account

| Account | Month | Pipeline | QuickBooks now | Difference |
|---|---|---|---|---|
| 4000-96 Revenue Clearing | 2026-08 | $844,849 | $0 | $844,849 |
| 4000-11 Platform Revenue - Recurring | 2026-08 | $13,447 | $761,448 | -$748,001 |
| 6100-06 S&M - Affiliate Marketing | 2026-08 | $112,360 | $42,512 | $69,848 |
| 4000-22 MMS Revenue - Usage Based | 2026-08 |  | $43,491 | -$43,491 |
| 4000-31 Ai Revenue - Recurring | 2026-08 |  | $27,025 | -$27,025 |
| 4000-98 Refunds | 2026-08 | -$22,808 | $0 | -$22,808 |
| 6100-02 S&M - Software | 2026-08 | $15,779 | $8,330 | $7,449 |
| 4000-21 MMS Revenue - Recurring | 2026-08 |  | $7,171 | -$7,171 |
| 4000-40 Setup Revenue | 2026-08 |  | $3,495 | -$3,495 |
| 6200-15 G&A - Swag & Gifts | 2026-08 | $1,863 | $3,818 | -$1,956 |
| 6100-05 S&M - Advertising | 2026-08 | $11,661 | $9,705 | $1,956 |
| 7000-00 Other Income/expenses | 2026-08 | $1,212 |  | $1,212 |
| 7000-02 Other Miscellaneous Income | 2026-08 |  | $1,212 | -$1,212 |
| 5050-22 Technical Account Manager - Bonus | 2026-08 | $6,800 | $7,800 | -$1,000 |
| 6999-99 Uncategorized Expense | 2026-08 | $1,000 |  | $1,000 |
| 4000-33 Ai Voice - Recurring | 2026-08 |  | -$600 | $600 |
| 4000-50 Other Revenue | 2026-08 |  | $564 | -$564 |
| 4000-32 Ai Revenue - Usage Based | 2026-08 |  | $100 | -$100 |

The next data push will carry the closed figures and these rows will tie.

No account-month in a closed month differs by more than a dollar.

Accounts present on one side only in the compared months (their amounts are in the tables above where they differ):

- `6999-99 Uncategorized Expense`: pipeline only
- `7000-00 Other Income/expenses`: pipeline only
- `4000-12 Platform Revenue - Usage Based`: export only

## 2. Stripe cash against QuickBooks revenue

Stripe net cash is what customers paid, after refunds, in the month it landed. QuickBooks revenue is the 4000 accounts, net of refunds, discounts and chargebacks, in the month it was recognised. They differ by design in two ways. Stripe collects sales tax, which QuickBooks books to a liability rather than revenue, so it is shown and taken out. And QuickBooks books an invoice when raised while Stripe books cash when it arrives, so an annual invoice or a late payment moves a month on one side and not the other; that part is timing and is not itemised here.

| Month | Stripe net cash | Of which tax | Stripe ex tax | QuickBooks revenue | Gap | Gap % |
|---|---|---|---|---|---|---|
| 2025-09 | $869,767 | $0 | $869,767 | $879,753 | $9,987 | +1.1% |
| 2025-10 | $877,723 | $0 | $877,723 | $833,129 | -$44,594 | -5.1% |
| 2025-11 | $830,068 | $0 | $830,068 | $830,577 | $510 | +0.1% |
| 2025-12 | $873,121 | $0 | $873,121 | $845,295 | -$27,826 | -3.2% |
| 2026-01 | $830,679 | $2,871 | $827,808 | $900,104 | $72,296 | +8.7% |
| 2026-02 | $861,247 | $3,387 | $857,860 | $888,480 | $30,620 | +3.6% |
| 2026-03 | $890,348 | $5,736 | $884,612 | $910,443 | $25,832 | +2.9% |
| 2026-04 | $912,948 | $8,734 | $904,214 | $921,503 | $17,290 | +1.9% |
| 2026-05 | $884,635 | $10,591 | $874,043 | $864,967 | -$9,076 | -1.0% |
| 2026-06 | $855,090 | $12,515 | $842,575 | $840,868 | -$1,707 | -0.2% |
| 2026-07 | $828,464 | $15,706 | $812,757 | $835,592 | $22,834 | +2.8% |
| 2026-08 | $841,097 | $16,115 | $824,982 | $835,387 | $10,405 | +1.3% |
| **Total** | **$10,355,184** | **$75,655** | **$10,279,529** | **$10,386,099** | **$106,570** | **+1.0%** |

Over the period QuickBooks recognised $106,570 more than Stripe collected ex tax, +1.0% of cash. A positive gap is revenue invoiced ahead of its cash, which is what annual billing and past-due accounts produce; chart 43 on the page counts the past-due accounts behind part of it.

## 3. What this does and does not establish

- Every cost line the site derives from, in every closed month the export covers, is the QuickBooks figure. Charts 26, 27, 33, 39, 40, 41, 48 and 49 and the price floors all sum these rows.
- Months before the export begins are not checked by this run. Take a longer export to check them.
- The grouping of accounts into layers (platform, people, variable, G&A, R&D, acquisition) is editorial and lives in `site/data.js` as `COST_LAYERS`; this script checks amounts, not grouping.
- Stripe and QuickBooks are reconciled at the month, not the invoice. A per-invoice tie needs the QuickBooks customer ledger, which is not pushed.

