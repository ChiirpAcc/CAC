# Data lineage

Every chart and report on the page, with the tab it comes from, the
columns it reads and what is done to them in between.

Written against push `2026-09-23T15:11:50` — 49,115 rows, 39 columns.

---

## 1. Sources

The pipeline pushes ten files. The site loads eight of them.

| Tab | File | Rows | Loaded | Used for |
|---|---|---|---|---|
| Customer Waterfall | `customer_waterfall.json` | 49,115 | yes | Everything per-customer: cohorts, retention, churn, pricing |
| Waterfall Summary | `waterfall_summary.json` | 93 | yes | Month-level logo and MRR totals |
| CAC Monthly | `cac_monthly.json` | 33 | yes | Acquisition cost per month |
| Serve Monthly | `serve_monthly.json` | 33 | yes | Cost to serve, cost of sales by team, measured margin |
| QB Expenses | `qb_expenses.json` | 2,243 | yes | Every expense line by account and month |
| QB Accounts | `qb_accounts.json` | 119 | yes | Account to bucket and section mapping |
| New Customer Cohorts | `signup_pricing.json` | 314 | yes | Signup price and start type |
| Subscription Lifetimes | `subscription_lifetimes.json` | 1,199 | yes | Fallback subscription spans |
| **Cash Detail** | `cash_detail.json` | 44,993 | **no** | Revenue decomposition, residual |
| **Event Costs** | `event_costs.json` | 36 | listed, unused | — |

`Cash Detail` is not in `REQUIRED_TABS` or `OPTIONAL_TABS`
(data.js:103). It carries the identity `recurring + usage + onetime +
passthrough + unclassified + tax - credits - refunds + residual =
net_cash`, which holds on all 44,993 rows with zero failures.

---

## 2. The loader

`load()` reads `index.json`, fetches each tab, and maps it to one
collection. Renaming is camelCase only; no arithmetic happens here except
where noted.

### `data.customers` from Customer Waterfall

| Source column | Becomes | Note |
|---|---|---|
| `customer_id` | `id` | |
| `canonical_id` | `canonicalId` | Set only where two Stripe records were matched as one business |
| `company_name` | `name` | |
| `source` | `source` | S1 / S2 |
| `month` | `month` | |
| `eop_mrr` | `eopMrr` | Comma-stripped by `num()` — arrives as `"2,300.00"` |
| `new_mrr` | `newMrr` | |
| `net_cash` | `netCash` | After refunds; can be negative |
| `usage_revenue` | `usage` | |
| `onetime_revenue` | `oneTime` | |
| `passthrough_revenue` | `passThrough` | |
| `recognised_elsewhere_revenue` | `recognisedElsewhere` | |
| `starting_mrr` | `startingMrr` | |
| `start_type` | `startType` | |
| `event_type` | `active` | **Transformation**: `LIVE_EVENTS.has(event_type)` |

**The one transformation that matters.** `active` is a boolean derived
from a closed set: `new`, `reactivation`, `flat`, `expansion`,
`contraction`. Anything else — `churn`, `inactive`, or a type the
pipeline invents — is treated as absent. Presence is an event type, not
an amount, so a customer booked to zero MRR is still a live logo.

There is currently no guard on this. When a push introduced an
`inactive` type on 21,018 rows, the page rendered half the business
without an error.

### `data.waterfall` from Waterfall Summary

`month`, `bop_mrr`, `eop_mrr`, `new_mrr`, `churn_mrr`, `active_logos`,
`new_logos`, `reactivated_logos`, `churned_logos`, `net_logo_change`.
Renamed only.

### `data.serve` from Serve Monthly

`active_logos`, `cogs_total`, `cogs_per_logo`, `from_split`,
`opex_total`, `opex_per_logo`, `total_cost`, `total_per_logo`,
`gross_margin`, `net_margin`, plus `teams[]` built from every column
matching `/^\d{4}-\d{2} /` (the per-team cost of sales lines). Rows
without `cogs_per_logo` or `active_logos` are dropped.

### `data.expenses` from QB Expenses

`month`, `account`, `amount`, `bucket`, `section`. Renamed only.

### `data.cacMonthly` from CAC Monthly

`month`, `cac_total_actual`, `logos_basis`. The pipeline has already
applied the settled splits — Customer Success at 0% of acquisition,
Partnerships at 100%, Technical Account Manager to cost of sales — so the
site reads the total rather than re-deriving it.

### `data.signups` from New Customer Cohorts

`startingMrr`, `platformMrr`, `upgradeMrr`, `setupFee`, `nonMrr`,
`startType`, `firstPayment`, `canceledAt`, `state`, `status`.

### `data.lifetimes` from Subscription Lifetimes

`start`, `end`, `status`, `account`. A fallback for subscription spans.

---

## 3. The derived layer

Two things are computed once at load and used by most charts.

### `buildCohorts(data)` — data.js:329

Groups `data.customers` into cohorts.

- **Cohort month** is the first month a customer carried revenue, not the
  first month they appear. A signed customer sitting at zero for months
  would otherwise credit the wrong month with the acquisition and stretch
  every retention curve.
- **Gross profit per month** is `grossProfit(row, marginsAt(month))`,
  where the platform margin is solved per month rather than assumed.
- Emits `usageRevenue[]`, `oneTimeRevenue[]`, `passThroughRevenue[]`,
  `joiningFee[]` and `recurringRevenue[]` alongside the logo counts.

### `platformMargins(data)` — data.js:4490

Solves the platform margin from the cost ledger instead of assuming it:

```
platform = (all revenue - cost of sales - 0.60 x usage - 0.90 x one-time)
           / platform revenue
```

Months landing outside [0,1] are rejected. On current data: **55.0% mean,
45.1% to 66.4% across 32 months**, against the flat 75.7% it replaced.
Cross-checked against the pipeline's published `gross_margin`, which is a
narrower measure — `(mrr - cogs) / mrr`, leaving usage and one-time out —
and currently differs by at most 0.95%.

---

## 4. Charts

### Cohort and retention

| # | Chart | Source | Transformation |
|---|---|---|---|
| **1** | LTV:CAC by cohort, at equal age | `cohorts`, `data.cacMonthly` | `ltvAtAge`. Every cohort cut at the same age, so an old cohort is not credited for having had longer. Cohorts short of the age are projected from a donor trajectory and drawn hatched. |
| **2** | Expected payback by cohort | `cohorts`, `data.cacMonthly` | `cohortEconomics` + `projectedBreakEven`. Cumulative gross profit against acquisition cost; the crossing point is payback. |
| **3** | Cumulative gross profit vs cost, by age | same | Same series as curves. The one chart that survives the margin being wrong, because the shape does not depend on the level. |
| **4** | Blended retention, logos vs revenue | `cohorts` | `blendedRetention`. Whole book pooled. **Both lines indexed to month 1, not month 0** — month 0 carries the joining charge booked as MRR until mid-2025, so indexing there turns a one-off ending into a false cliff. |
| **5** | Monthly logo churn rate | `data.customers` | `departures`. Presence-based: present one month, absent the next. |
| **6** | Retention at months 3, 6 and 12 | `cohorts` | `retentionAtAge`. A cohort is plotted only once that age is behind it, otherwise its last observed month doubles as its retention and every recent cohort reads as perfect. |
| **8** | Retention by era, logos kept | `cohorts` | `retentionByYear`. At age k the denominator is every customer of that year whose cohort has had k months to run. The curve can rise — that is the sample shrinking, not customers returning. |
| **9** | Same cohorts, revenue kept | `cohorts` | Same function, revenue basis. |
| **11 / 12** | Logos and revenue kept, year against year | `data.customers` | `seasonalSurvival`. The same calendar window this year, twelve and twenty-four months back. Like-for-like months, so seasonality is not mistaken for decline. |

### Flow and churn

| # | Chart | Source | Transformation |
|---|---|---|---|
| **7** | Cost per logo against revenue per logo | `data.cacMonthly`, `cohorts` | Both indexed to 100 at the first month with recorded acquisition cost, so the divergence reads without either absolute needing to be right. |
| **10** | Monthly logo flows | `data.customers` | `departures`. New, reactivated, churned, net. |
| **18** | Forward survival from every start month | `data.customers` | `forwardSurvival`. Take everyone active in a month and follow that exact set forward. A start month counts only once its full window exists. A different question from cohort retention. |
| **19** | Survival by starting month | same | Same series, one point per start month. |
| **20** | Customer Success capacity against churn | `data.expenses`, `data.customers` | `capacityAnalysis`. Spend per customer, since headcount is not in the data. Salaries carried separately from the total, because bonuses move with outcomes rather than staff. **Not affected by the CS slider** — that slider changes what counts as acquisition cost, not the spend. |
| **21** | Is either relationship moving | same | Rolling windows over the same two series. |
| **22** | Does churn rise when fewer arrive | `data.customers`, `data.waterfall` | `arrivalsAgainstChurn`. Slope per ten fewer arrivals with a 95% interval, because a correlation on two dozen points is easy to over-read. |
| **23** | Churn against arrivals, one to six months | same | The same test at every horizon, because a thin month and a bad month can be the same month for unrelated reasons. |
| **24** | The same, split by what customers pay | `data/customer_waterfall.json` **direct** | Static GIF, `media/arrivals_vs_churn_by_price.gif`. Built by `scripts/make_gifs.py`, which reads the pushed JSON itself rather than going through `load()`. Each month split at its **own median** subscription, not a fixed price, so the rise in price across the window does not leak into the split. |
| **25** | The same question, month by month | same | Static GIF, `media/arrivals_by_month.gif`. One frame per starting month, fixed axes across every frame — rescaling each frame would make the movement invisible. |
| **31** | Monthly churn by tenure | `data.customers` | `churnByTenure`, cut at 3/6/12 months. Describes the standing book, not an intake. |
| **32** | Present but paying nothing | `data.customers` | `zeroMrrShare`. Live logos carrying zero MRR — the gap between the logo and revenue retention curves. |

### Price

| # | Chart | Source | Transformation |
|---|---|---|---|
| **13** | Price at signup against volume | `data.signups`, `data.customers` | `signupEconomics`. Volume and price separated, because fewer customers at a higher price is a different business from fewer customers. |
| **14** | What each price band returns | `data.customers` | `priceBands`, edges at 0 / 500 / 750 / 1000 / 1500. Each band followed the same number of months, so the comparison is age-matched. |
| **16** | How a month starts: start type mix | `data.signups` | `signupPriceHistory`. |
| **17** | What a logo cost, and when it came back | `cohorts`, `data.cacMonthly` | `projectedBreakEven`. Table form of chart 2. |

### Cost

| # | Chart | Source | Transformation |
|---|---|---|---|
| **26** | Acquisition cost by category | `data.expenses`, `data.cacMonthly` | `acquisitionCosts`. Divided by **new** logos. |
| **27** | The same cost per logo, by category | `data.expenses`, `data.waterfall` | `costRates`. Everything ongoing divides by **active** logos; acquisition divides by cohort size and is flagged `once`. The two denominators answer different questions and are not interchangeable. |
| **28** | What a customer pays, and what is left | `data.serve`, `data.customers` | `costToServe`. Gross contribution (pay less cost to serve) and net contribution (also less G&A and R&D) kept deliberately apart. |
| **29** | Cost of sales per logo, by team | `data.serve` | Team columns matched on `/^\d{4}-\d{2} /`. |
| **33** | Everything a cohort returned against everything it cost | `cohorts`, `data.expenses`, `data.cacMonthly` | `fullCostRecovery`. Chart 1 with the assumed margin removed: the numerator is revenue itself and every cost sits in the denominator where it can be seen and switched off. Toggleable by cost group and revenue group. |
| **39** | What it costs to keep one customer, by layer | `data.expenses`, `data.customers` | `ongoingCostPerLogo`. Divided by **paying** logos, since a zero-MRR account cannot carry fixed cost. Acquisition excluded — it belongs to the cohort that caused it. |
| **40** | What the business spends to run, by layer | `data.expenses` | `costLedger`. |
| **41** | Every cost line by account, last six months | `data.expenses`, QB Accounts | `costLedger` at line granularity. |

### Projection and pricing decisions

| # | Chart | Source | Transformation |
|---|---|---|---|
| **34 / 35 / 36** | Logos, revenue and cash, twelve months out | `cohorts`, `data.serve`, `data.waterfall` | `projectBase` + `arrivalScenarios`. Cohort roll-forward with age-specific survival and recency-weighted donor pooling on a 9-month half-life. Backtested on every load: within 3.4% on logos and 2.6% on MRR over twelve months. Three arrival rates, each a volume the business has actually run. |
| **37** | Every paying customer against what they cost | `data.expenses`, `data.customers` | `priceFloors`. **Two floors, and confusing them is the expensive mistake.** The marginal floor is what one more or fewer customer changes — licence, hosting, merchant fee, revenue share. The allocated floor spreads every fixed cost over payers. Median-based rather than mean, for robustness to credit-note timing. |
| **38** | Cutting them against re-pricing them | same | `repriceOutcomes`. Cutting is modelled to its conclusion: revenue and variable cost go, fixed cost stays, the floor rises for everyone left, repeat. It does not converge, which is the finding. |
| **42** | Cost per customer, to your own definition | `data.expenses`, `data.customers` | `costCalculator`. A 50-50 blend of the last six and three months. Toggleable cost layers and logo types. Excludes logos that have never paid above $0. |

### The Upgrade list tab

| Report | Source | Transformation |
|---|---|---|
| Campaign calculator | `data.customers`, `data.expenses` | `campaign` + `ruleSpread`. The pricing rule and the churn assumption are both switches, because nobody has run this campaign. |
| Band economics | `ENGAGEMENT` constant, `priceFloors` | `bandEconomics` / `bandCampaign`. Contribution basis rather than revenue: a dormant account and a heavy user paying the same are worth different amounts. |
| Accounts worth a conversation | `data.customers` | `upgradeList`. Eligibility is **12 months of age or more** and **above $2 MRR** — a dollar a month is a free account with a token charge, not a cheap customer. Target price from `settledPeaks`, which excludes each customer's first month because it carries the onboarding fee. |

---

### Two charts that do not go through the loader

Charts 24 and 25 are animated GIFs, not SVG drawn at load. They are built
by `scripts/make_gifs.py`, which reads `data/customer_waterfall.json`
directly and applies its own presence rule rather than importing
`data.js`. The deploy workflow regenerates them on every push
(`.github/workflows/pages.yml`), so they are current — but they are a
second, independent implementation of the same presence logic, and
nothing checks that the two agree.

Their findings are **hardcoded in `index.html`**, not computed. If the
underlying relationship changes, the GIF moves and the sentence under it
does not.

---

## 5. What runs between a push and a chart

| Step | Where | What it does |
|---|---|---|
| Validate | `.github/workflows/validate-data.yml` -> `scripts/validate_data.py` | Runs on every data push. Checks month format is `YYYY-MM` text, that blank is null and never zero, that presence is not read from payment, and that departures reconcile. **Does not block the deploy** — it opens an issue instead, on the reasoning that a site with a warning beside it beats no site. |
| Build GIFs | `.github/workflows/pages.yml` | Regenerates charts 24 and 25 from the pushed data. |
| Deploy | same | Publishes `site/` and `data/` to Pages on any commit touching either. |

On the current push the validator returns **no errors and no warnings**.

It does not check that `event_type` values are ones the site understands.
That is the gap: when a push introduced an `inactive` type on 21,018
rows, the validator passed, the deploy went out, and the page rendered
half the business without an error.

---

## 6. Assumptions that are not in the data

| Constant | Value | Where | Status |
|---|---|---|---|
| `LEGACY_PLATFORM_MARGIN` | 0.757 | data.js:4438 | Fallback only, and never reached on current data — 32 months solve cleanly. |
| `CLASS_MARGINS.usage` | 0.60 | data.js:4442 | Immaterial. Usage is 0.47% of revenue; swinging this and one-time across 0 to 1 moves the platform margin by 0.56 points. |
| `CLASS_MARGINS.oneTime` | 0.90 | same | Immaterial, as above. |
| `passThrough`, `recognisedElsewhere` | 0 | same | Deliberate. Pass-through is carrier fees, sitting in revenue and cost of sales at once. Recognised-elsewhere is already carried by a couponed subscription. |
| `ENGAGEMENT` | 150 accounts, 3 bands | data.js:1970 | **Hand-entered** from an export dated 2026-09-22. The `usageMultiple` values (2.2 / 0.6 / 0.05) are estimates, not measurements. No pipeline source exists. |
| `halfLife` | 9 months | donor weighting | A modelling choice with no true value to discover. |
| Churn and pricing presets | various | `CHURN_PRESETS`, `PRICING_PRESETS` | Deliberately exposed as switches. |

---

## 7. Columns present but not read

24 of 39 waterfall columns are unused. Most are redundant — `bop_mrr`,
`expansion_mrr` and the other flow components are re-derived from
`eop_mrr` transitions. These are the ones that would change something:

| Column | What it would enable |
|---|---|
| `unclassified_revenue` | Roughly 6% of recent cash, currently invisible to every revenue class |
| `subscription_status`, `unpaid_due` | Past-due share is rising, 5.0% to 5.7% over four months, and is a leading churn indicator |
| `is_annual`, `annual_line_gross` | Two customers distort `new_mrr` by 17-20% in June and July |
| `sub_start`, `sub_end`, `has_live_sub` | Real tenure instead of inferred, for the age-eligibility rule |
| `fidelity` | Two thirds of the file is `amount_only`; anything computed over the full window rests mostly on revenue classified by size |
| `invoice_discounts` | Separates couponed accounts from phantom MRR |
| `platform_mrr`, `upgrade_mrr` | Which part of MRR moved. **Not a decomposition** — the gap to `eop_mrr` is revenue nobody could name |
| `last_paid_at` | Would separate billed-not-collected from stopped-paying. **Currently corrupt** — 91% of values fall in September |

---

## 8. Known gaps in the sources

- **Revenue classes start 2025-09.** Earlier months are effectively
  platform-only, and that line falls in the middle of the S1-to-S2
  migration and the joining-charge change, so three step changes overlap
  in the same six months.
- **The joining charge.** Until mid-2025 the setup fee was booked as
  recurring revenue, so month 0 carries roughly $750 to $1,100 that is
  not run rate. This is why every retention curve indexes to month 1.
- **Cost is not split by environment and cannot be.** QuickBooks is one
  company. There is no S1 or S2 in the ledger, so cost per logo is
  blended even though logo counts are split.
- **No internal account id and no customer email** in any source the
  pipeline reads. `canonical_id` is not this — it is populated only where
  two Stripe records were matched as one business, and holds the
  surviving Stripe id.
- **Signup coverage** is maintained by hand and not backfilled. Use
  `new_mrr` from the customer file for price series.
