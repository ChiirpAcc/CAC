# CHIIRP LTV:CAC

The unit economics of a SaaS platform for home services trades, read as a
site rather than as a thirty tab spreadsheet.

**Live: https://chiirpacc.github.io/CAC/**

The analysis used to live in a Google Sheets workbook with a 280 KB Apps
Script behind it. It worked and it could not be handed to anyone. The
workbook is now a pipeline that computes and pushes; this repository reads
what it pushes and is the only place the analysis exists.

```
Stripe S1, S2  ─┐
                ├─► Sigma ─► workbook pipeline ─► data/*.json ─► site
QuickBooks P&L ─┘             (Apps Script)       (by commit)
```

Nothing here fetches anything. The pipeline commits one file per tab
directly to `main`, and a commit touching `data/**` redeploys the site
automatically, so a push is live in about thirty seconds.

## What you need to know before reading the charts

### The base is right. Departures are not.

Active logos for 2026-08 read **1,048** against a reported ~1,017, within 3%.
The presence correction has fully landed and the site reads presence from
`event_type`: the live types are `new`, `reactivation`, `flat`, `expansion`
and `contraction`, and counting them reproduces `active_logos` exactly across
all 93 months. Treat the base as sound.

What is not sound is the count of customers leaving.

`churned_logos` books a departure when the pipeline sees the transition. A
customer whose subscription drops out of the Stripe export never produces one:
present one month, absent the next, nothing recorded. In 2026 that is **182
customers**, and they are not test accounts — 179 carried cash in their last
six months, $573,144 between them, and the subscription export itself marks
156 as churned with an end date.

Three counts of the same year:

| | 2026 departures |
|---|---|
| `churned_logos` as pushed | 310 |
| Customers that actually left the file | **492** |
| The business's own figure | 456 |

Over the last six months the push books 240 and the file loses 399, 66% more.
The difference decides the direction of the business: at the reported rate the
base converges to about 1,365, up 30%; at the observed rate it converges to
about 821, down 22%.

The site now draws both on chart 5 and labels which is which. Read the derived
line as the rate and `churned_logos` as a floor.

### There are three counts of a new logo and they disagree

| Month | Cohort | Waterfall | Reported |
|---|---|---|---|
| 2026-01 | 35 | 41 | 47 |
| 2026-06 | 28 | 34 | 20 |
| 2026-08 | 4 | 9 | 29 |

Cohort is what this build can observe, waterfall is the monthly summary,
reported is the business figure. They disagree **in both directions**, which
matters: missing lapsed customers can only make the derived figure too low,
so June finding more than the business reports cannot be a data gap. It is a
definition nobody has written down, and it will not resolve when the presence
fix lands.

Every chart that divides by a logo count names which one it used. The
reconciliation carries all three.

### What is solid and what is not

Solid, and independent of any assumption:

- the active logo base and its shape
- monthly flows of new, reactivated and churned logos
- retention curves, which need no cost allocation

Not solid:

- **LTV:CAC and payback**, which depend on a cost per logo that divides by a
  different population than the gross profit it is compared against
- **per class margins**. Platform 75.7% comes from the P&L. Usage 60% and
  one-time 90% are estimates, and how the classes divide recognised MRR is
  inferred from the shape of the data rather than stated by the push
- **anything involving lapse**, because the presence bug above cannot
  distinguish a lapse from a cancellation

## The decisions that used to be adjustable

These were sliders. They are settled, applied in the pipeline, and stated in
prose at the foot of the site instead.

| | |
|---|---|
| Customer Success | **0%** of acquisition cost. Retention work, including its commissions, which are paid on retention. |
| Partnerships | **100%**. It sources customers. |
| Technical Account Manager | **Cost of sales**, not acquisition. $1.06m, excluded from every cost figure on the site. |

Counting Customer Success as acquisition overstated acquisition cost by
$1.87m across the period, about 22%.

A slider invites a reader to move a number until they like the answer, and
deciding was meant to stop that. The arithmetic is still parameterised in
`site/data.js`, so a different decision is a one line change rather than a
rebuild.

## Repository

```
.github/workflows/pages.yml           deploy on push to data/** or site/**
.github/workflows/validate-data.yml   check a data push, open an issue
scripts/validate_data.py              the checks
data/*.json                           pushed by the pipeline, never edited
site/index.html                       structure
site/styles.css                       design
site/data.js                          loading, parsing, derivation
site/charts.js                        hand drawn SVG
site/app.js                           wiring and prose
```

No build step. The site is vanilla HTML, CSS and modules, and the charts are
SVG written by hand rather than pulled from a library, because every chart
here needs something a general purpose library fights: blanks that stay
blank, reference lines at a chosen goal, and a series that is the sum of two
others drawn differently from them.

### Standing it up

Nothing to install. Serve `site/` with `data/` beside it:

```bash
mkdir -p _site && cp -r site/. _site/ && cp -r data/. _site/data/
cd _site && python -m http.server 8000
```

Then open http://localhost:8000. Note that browsers cache ES modules
aggressively; if an edit does not appear, hard refresh.

### Validation

`scripts/validate_data.py` runs on every data push. It checks the two rules
that have actually bitten, plus row count floors, index against file
disagreement, unrecognised bucket values, and the presence signature
described above.

It **does not block the deploy**. The site publishes either way and an issue
is opened instead, because a page carrying a warning is more useful than no
page.

Run it locally with `python scripts/validate_data.py`.

## Known open items

- **The presence ladder has not landed.** Base reads 871 against a reported
  1,017. This is the one that matters.
- **Three logo counts disagree in both directions.** A definition problem
  rather than a data gap.
- **697 accounts never carried revenue**, 19% of the file, in neither column
  of the reconciliation. 39 have a subscription record, 658 do not, and all
  of them received cash at some point. First bill failures, internal accounts
  and unconverted trials mixed together.
- **`canonical_id` arrives empty** on all 51,102 rows, so migration pairs are
  matched through `migration_key.json` instead.
- **The second Stripe environment carries 0.24% of rows.** A young
  environment rather than a broken feed.
- **No CSM assignment per account.** Without it, whether accounts that lost a
  CSM churned differently from accounts that kept one cannot be answered, and
  no correlation over 24 months substitutes for it.
- **Sales cycle length is untested.** The cost per logo assumes a month of
  spend bought that month of logos. A 60 day cycle would put spend on the
  wrong cohort throughout.
