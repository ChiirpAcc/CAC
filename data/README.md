# data/

One JSON file per workbook tab. **These files arrive by commit, pushed from
the Apps Script behind the LTV:CAC workbook.** Nothing in this repository
fetches them, and nothing here is edited by hand.

The workbook stays the source of truth and stays the thing that computes.
This directory is a readable copy of the tabs the site needs, and only those
tabs.

The report tabs are deliberately not pushed: Master, CAC Dashboard, Payback
Forecast, Cohort Retention, Logo Evidence, Customer Matrix. They are laid out
for a human, with mastheads and merged cells and charts anchored to a band, so
they break the first time a section moves. Everything in them is derived from
the tabs below anyway.

## Shape

Every tab file:

```json
{
  "tab": "Waterfall Summary",
  "pushed_at": "2026-09-16T13:04:11Z",
  "columns": ["month", "beginning_mrr", "..."],
  "row_count": 33,
  "rows": [{ "month": "2025-01", "beginning_mrr": 412000 }]
}
```

And `index.json`, which the site reads first to learn what is available:

```json
{
  "pushed_at": "2026-09-16T13:04:11Z",
  "files": [{ "tab": "Waterfall Summary", "file": "waterfall_summary.json", "rows": 33 }]
}
```

Note the two spellings. A tab file carries `row_count`; an entry in
`index.json` carries `rows`. They mean the same thing.

## Two rules the push has to honour

**Months are strings, `YYYY-MM`.** Sheets parses an unprotected `2025-01` as a
date and renders it back as `2025-1` or `1/1/2025`. As text, `2025-1` sorts
*after* `2025-10`, so cost months quietly stop lining up with cohort months
and every per-month comparison on the site is wrong without looking wrong. The
workbook writes these as plain text deliberately. The push must read them with
`FORMATTED_VALUE`, never `UNFORMATTED_VALUE`.

**Blank is `null`, never `0`.** A cohort that never recovers its CAC has no
payback number. Zero plots as instant payback, which is the opposite of the
truth. Keep blanks blank from the sheet through to the chart.

## Files the site expects

| File | Tab | Notes |
|---|---|---|
| `index.json` | n/a | Written every push. |
| `waterfall_summary.json` | Waterfall Summary | Monthly MRR and logo movement. Feeds the hero chart. |
| `cac_monthly.json` | CAC Monthly | Acquisition cost and logo counts by month. |
| `qb_expenses.json` | QB Expenses | P&L lines by account and month, with bucket classification. |
| `qb_accounts.json` | QB Accounts | The account classification itself. |
| `customer_waterfall.json.gz` | Customer Waterfall | About 51,000 rows, so gzipped. Cohorts are derived from this. |
| `recognised_mrr.json` | Recognised MRR | Optional. Absent until somebody runs the pivot pull. |
| `active_logos.json` | Active Logos | Optional, same. |

Anything over roughly 5,000 rows should be gzipped. Everything smaller stays
plain so the diff stays readable, since these land as commits.

## Columns

Header names are lowercase with underscores. The site reads these keys
directly, so renaming one in the workbook breaks a chart.

**`waterfall_summary.json`**
`month`, `beginning_mrr`, `new_mrr`, `reactivation_mrr`, `expansion_mrr`,
`contraction_mrr`, `churn_mrr`, `ending_mrr`, `net_cash`, `active_logos`,
`new_logos`, `reactivated_logos`, `churned_logos`, `net_logo_change`.
Everything but `month` is numeric.

**`cac_monthly.json`**
`month`, `new_logos`, `cac_total_actual`, `cac_per_logo`, `logos_basis`,
`churned_logos`, `beginning_logos`, `ending_logos`, `logo_churn_rate`.
Everything but `month` and `logos_basis` is numeric.

**`qb_expenses.json`**
`account`, `section`, `month`, `amount`, `bucket`, `driver`, `tier`, `source`.
`amount` is numeric. `bucket` is one of `CAC`, `COGS`, `SPLIT`, `OPEN`,
`EXCLUDED`, `UNMAPPED`.

**`qb_accounts.json`**
`account`, `section`, `bucket`, `driver`, `tier`, `notes`. Same `bucket`
values.

**`customer_waterfall.json.gz`**
`customer_id`, `company_name`, `month`, `beginning_mrr`, `new_mrr`,
`reactivation_mrr`, `expansion_mrr`, `contraction_mrr`, `churn_mrr`,
`ending_mrr`, `net_cash`, `event`. The MRR and cash columns are numeric.

Cohorts are derived from this file in the browser. A customer's cohort is the
first month where `ending_mrr > 0`, which is not the same as the first month
they appear, because a signed customer can sit at $0 for months.

## When something looks wrong

There is no validation step in this repository any more, so a bad push lands
silently. The site is the only place a problem will show, which means these
are worth checking by eye after a push that looks odd.

**Months rendering as `2025-1` or `1/1/2025`.** The column lost its plain-text
formatting in the workbook, so Sheets reparsed it. Fix it in the sheet: select
the column, set Format to Plain text, rewrite the months. The symptom looks
nothing like the cause, which is why it is first on this list.

**A chart showing instant payback for a cohort that never recovered.** A blank
was written as `0` somewhere in the push. Blank must stay `null`.

**Row counts far below what the tab holds.** The tab was not rebuilt before
the push, or a filter was hiding rows.

**A bucket value the site does not recognise.** A new bucket was introduced in
the workbook without the site being told about it.
