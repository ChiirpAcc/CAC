# data/

One JSON file per workbook tab, written by `scripts/pull_sheet.py` and
committed by the `Sync data` workflow. Nothing in here is edited by hand.

The workbook stays the source of truth. This directory is a readable copy of
the tabs the site needs, and only those tabs. The report tabs (Master, CAC
Dashboard, Payback Forecast, Cohort Retention, Logo Evidence, Customer
Matrix) are deliberately not pulled. They are laid out for a human, so they
break the first time a section moves, and everything in them is derived from
the tabs listed in `manifest.json` anyway.

## Files

| File | Tab | Notes |
|---|---|---|
| `manifest.json` | n/a | What to pull and how to validate it. The one file here that is edited by hand. |
| `index.json` | n/a | Written every run. Lists each file and its row count. |
| `waterfall_summary.json` | Waterfall Summary | Monthly MRR and logo movement. Feeds the hero chart. |
| `cac_monthly.json` | CAC Monthly | Acquisition cost and logo counts by month. |
| `qb_expenses.json` | QB Expenses | P&L lines by account and month, with bucket classification. |
| `qb_accounts.json` | QB Accounts | The account classification itself. |
| `customer_waterfall.json.gz` | Customer Waterfall | About 51,000 rows, so gzipped. Cohorts are derived from this. |
| `recognised_mrr.json` | Recognised MRR | Optional. Absent until somebody runs the pivot pull. |
| `active_logos.json` | Active Logos | Optional, same. |

Each file holds `{tab, pulled_at, columns, row_count, rows}`. Anything over
5,000 rows is gzipped, everything smaller stays plain so the diff is
readable.

**Blanks are `null`, never `0`.** A cohort that never recovers its CAC has no
payback number. Zero would plot as instant payback, which is the opposite of
the truth. Keep blanks blank all the way through to the chart.

**Months are strings in `YYYY-MM` form.** They are read with
`FORMATTED_VALUE` on purpose. See the troubleshooting entry below, because
this is the failure whose cause looks nothing like its symptom.

## Setting up the service account

The sync authenticates as a Google service account, which is an identity
rather than a person. It needs no IAM roles at all. The only permission that
matters is the spreadsheet being shared with it.

1. Create a Google Cloud project, or pick an existing one.
2. Enable the **Google Sheets API** on that project.
3. Create a service account. Skip the optional "grant this service account
   access to the project" step. It genuinely needs no roles.
4. On the service account, create a **JSON key** and download it.
5. Open the key file and copy its `client_email`, which looks like
   `something@project-id.iam.gserviceaccount.com`.
6. **Share the spreadsheet with that address as Viewer.** This is the step
   people skip, and skipping it produces a 404 rather than a permission
   error.
7. In this repository, go to Settings, then Secrets and variables, then
   Actions, and add a repository secret named `GOOGLE_SERVICE_ACCOUNT_JSON`
   whose value is the entire contents of the key file, braces included.
8. Optionally add a repository variable named `SPREADSHEET_ID`. When it is
   absent the script falls back to the `spreadsheet_id` in `manifest.json`.

Then run the workflow by hand from the Actions tab to confirm it works.

Do not commit the key file. `.gitignore` blocks `key.json`,
`credentials.json` and `service-account*.json` everywhere including this
directory, but the surest protection is not putting it in the working tree.

## Troubleshooting

Every validation failure exits 1 and prints what probably caused it. This is
intentional. A sync that fetches the wrong rows is worse than one that stops,
because the wrong rows ship silently and somebody reads them.

### `column 'month' has N value(s) that are not YYYY-MM text`

The cause is nothing like the symptom. The month column lost its plain-text
formatting in the workbook, so Sheets reparsed `2025-01` as a date and wrote
it back as `2025-1` or `1/1/2025`.

This matters more than it looks. As text, `2025-1` sorts *after* `2025-10`,
so cost months quietly stop lining up with cohort months and every per-month
comparison on the site is wrong without looking wrong.

Fix it in the workbook: select the column, set Format to Plain text, and
rewrite the months. Do not fix it in the script.

### `returned N rows, fewer than the M expected`

The tab was not rebuilt, or a filter is hiding rows, or the pull that feeds
the tab failed upstream. Open the tab and look at it before changing
`min_rows` in the manifest. Lowering the threshold to make the error go away
is how bad data ships.

### `column 'X' is entirely zero or blank across N rows`

A formula behind that column is broken, or its source range is empty. Columns
this central are never legitimately all zero.

### `is missing required column(s)`

A column was renamed or reordered, or a title row was inserted above the
headers. The error prints what row 1 actually contains and what those
headings normalised to, so compare the two lists.

Headings are normalised loosely: lowercased, with runs of punctuation and
spaces collapsed to underscores. `Beginning MRR` and `beginning_mrr` both
land on `beginning_mrr`, so retitling a column for readability is safe.
Renaming it to something different is not.

### `column 'bucket' holds N value(s) outside [...]`

Either a new bucket was introduced in the workbook without being added to
`manifest.json`, or a typo crept into the classification. Blank buckets are
tolerated and reported as a note, since an unfilled trailing cell is not the
same thing as a misclassification.

### `contains the sheet error #REF!`

A formula in the workbook is broken. Fix it there. The script refuses to read
sheet errors as missing data, because that hides the breakage.

### `The Sheets API returned 404`

Almost always the service account cannot see the spreadsheet. The API returns
404 rather than 403 in that case, which sends people looking for a missing
file. Share the sheet with the service account `client_email` as Viewer.

### `The Sheets API returned 403`

Either the Sheets API is not enabled on the service account Cloud project, or
the key has been disabled.

### `GOOGLE_SERVICE_ACCOUNT_JSON is not set`

The repository secret is missing. Note that adding it is only half the setup.
The spreadsheet still has to be shared with the service account.
