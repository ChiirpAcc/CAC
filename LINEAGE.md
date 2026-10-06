# Data lineage

Every chart and report on the page, with the tab it comes from, the
columns it reads and what is done to them in between.

Written against push `2026-09-24T16:34:23` (pipeline v119), 50,117 rows and
40 columns. The chart rows in section 4 were revised after the chart audit
of 2026-10-01, against the push of `2026-10-02T11:21:05`.
Figures quoted from the data are recomputed on every load and will move.

---

## 1. Sources

The pipeline pushes ten files. The site loads eight of them.

| Tab | File | Rows | Loaded | Used for |
|---|---|---|---|---|
| Customer Waterfall | `customer_waterfall.json` | 50,117 | yes | Everything per-customer: cohorts, retention, churn, pricing |
| Waterfall Summary | `waterfall_summary.json` | 93 | yes | Month-level logo and MRR totals |
| CAC Monthly | `cac_monthly.json` | 33 | yes | Acquisition cost per month |
| Serve Monthly | `serve_monthly.json` | 33 | yes | Cost to serve, cost of sales by team, measured margin |
| QB Expenses | `qb_expenses.json` | 2,243 | yes | Every expense line by account and month |
| QB Accounts | `qb_accounts.json` | 119 | fetched, not returned | `load()` reads it and puts nothing from it on `data`; the bucket and section columns the cost charts use come from QB Expenses |
| New Customer Cohorts | `signup_pricing.json` | 314 | yes | Signup price and start type |
| Subscription Lifetimes | `subscription_lifetimes.json` | 1,199 | yes | Fallback subscription spans |
| Cash Detail | `cash_detail.json` | 45,635 | **yes** | Revenue decomposition, residual, and the page's own reconciliation |
| Event Costs | `event_costs.json` | 36 | yes | The Events tab: sponsor and travel per event. The tab is the fee; `EVENT_FEE_DECISIONS` settles disputed fees and `EVENT_PACKAGES` splits shared ones. A row with no month is kept, undated |

`Cash Detail` is loaded as of this session. Its identity is
`accounted_for + residual = net_cash`, where `accounted_for` is the sum of
the named classes, and it holds on all 45,635 rows with zero failures. The
page reconciles its own revenue against it and prints the result in the
stamp.

Every listed tab is now read; Event Costs feeds the Events tab.

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
| `is_annual` | `isAnnual` | Read but not acted on — the pipeline spreads annuals from v116 |
| `annual_line_gross` | `annualGross` | As above |
| `subscription_status` | `subscriptionStatus` | Drives chart 43 |
| `unpaid_due`, `unpaid_invoice_count` | `unpaidDue`, `unpaidInvoices` | As above |
| `start_type` | `startType` | |
| `event_type` | `active` | **Transformation**: `LIVE_EVENTS.has(event_type)` |

**The one transformation that matters.** `active` is a boolean derived
from a closed set: `new`, `reactivation`, `flat`, `expansion`,
`contraction`. Anything else — `churn`, `inactive`, or a type the
pipeline invents — is treated as absent. Presence is an event type, not
an amount, so a customer booked to zero MRR is still a live logo.

**There is a guard on it now.** `checkVocabulary()` compares the event
types that arrived against both `KNOWN_EVENTS` and the counts the push
declares in its own `event_type_counts` header, and a red banner above the
charts names any type the page does not know, with its row count, plus any
disagreement with the header.

It exists because a push once introduced an `inactive` type on 21,018 rows
and the page rendered half the business — 541 logos and $308k of MRR —
with every chart drawn and no error anywhere.

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

### `buildCohorts(data)`

Groups `data.customers` into cohorts.

- **Cohort month** is the first month a customer carried revenue, not the
  first month they appear. A signed customer sitting at zero for months
  would otherwise credit the wrong month with the acquisition and stretch
  every retention curve.
- **Gross profit per month** is `grossProfit(row, marginsAt(month))`,
  where the platform margin is solved per month rather than assumed.
- Emits `usageRevenue[]`, `oneTimeRevenue[]`, `passThroughRevenue[]`,
  `joiningFee[]` and `recurringRevenue[]` alongside the logo counts.
- **The first month of the window is the censoring boundary.** A customer
  whose first revenue falls there is left out unless Stripe gives a start
  date, so that month's cohort is small and `logosStarted` reports no count
  for it.

### `logosStarted(data, cohorts)`

The page's one count of a logo arriving: cohort size by month, with the
boundary month null. Charts 7, 13, 26, 27, 36, 40, 41 and 47 divide by it;
the summary's `new_logos` is a second definition and the cost charts no
longer read it.

### `platformMargins(data)`

Solves the platform margin from the cost ledger instead of assuming it:

```
platform = (all revenue - cost of sales - 0.60 x usage - 0.90 x one-time)
           / platform revenue
```

Months landing outside [0,1] are rejected. On current data: **54.9% mean,
44.5% to 66.5% across 32 months**, against the flat 75.7% it replaced.
Cross-checked against the pipeline's published `gross_margin`, which is a
narrower measure — `(mrr - cogs) / mrr`, leaving usage and one-time out.
That gap was 0.95% when the check was built and is now **7.16%, in
2025-12**, because usage revenue went from roughly nothing to $40-90k a
month once the classification work landed. The definitions have not moved;
the classes they treat differently have grown. The page says so itself
when the gap passes two points.

### `serveSpend(data, month)` and `accountServeCost(data)`

`serveSpend` is the month's spend in the five serve layers, lifted out of
`ongoingCostPerLogo` so that chart 39 (per paying logo) and chart 49 (per
account) read the same figure. `accountServeCost` spreads it: fixed layers
per paying logo, variable per dollar of revenue, zero-MRR live accounts
carrying variable cost only. Per environment per month it reports paying
and live counts, revenue and cost per account, and accounts under water.

### Three guards and checks added since

**`checkVocabulary(doc, customers)`** — above. Silent when the push uses
words the page understands.

**`revenueCheck(data)`** — reconciles the page's revenue against Cash
Detail, the only independent statement of it in the push. Reports whether
the two tie, what share of cash carries no product name, and the published
residual. Printed in the stamp.

**`silentLogos(data, { months = 6 })`** — customers still counted present
who have had no cash and no MRR for six months or more, walked backwards
from the trailing month so it never counts a month before the customer
existed. Counted rather than removed: deciding that silence is departure
would move the base, the churn rate and every per-logo figure, which is a
judgement for a person.

---

## 4. Charts

### Cohort and retention

| # | Chart | Source | Transformation |
|---|---|---|---|
| **1** | LTV:CAC by cohort, at equal age | `cohorts`, `data.cacMonthly` | `ltvAtAge`. Every cohort cut at the same age, so an old cohort is not credited for having had longer. Cohorts short of the age are projected along `donorTrajectory`, walked on `recurringRevenue` so a fee-free cohort is not handed the fee era's month-1 drop, and drawn hatched. The joining charge stays in gross profit because it was real cash. |
| **2** | Expected payback by cohort | `cohorts`, `data.cacMonthly` | `cohortEconomics` + `projectedBreakEven`. Cumulative gross profit against acquisition cost; the crossing point is payback. Projections on the same recurring donor path as chart 1; the joining charge stays in. |
| **3** | Cumulative gross profit vs cost, by age | same | Same series as curves, offset 0 labelled M0. The shape survives the margin or the split being wrong; the month a curve crosses 100% does not. |
| **4** | Blended retention, logos vs revenue | `cohorts` | `blendedRetention`. Whole book pooled, drawn while at least 4 cohorts and 150 customers remain, to 24 months. Both lines indexed to month 1, the second month, not month 0, which carries the joining charge booked as MRR until mid-2025. The month-12 sentence counts revenue steps by the calendar year cohorts reached that age in. |
| **5** | Monthly logo churn rate | `data.customers`, `data.waterfall` | `departures` for the solid line (present one month, absent the next); the dashed line is the summary's `churned_logos` over its prior `active_logos`. Arrivals in the annotation are the cohort count. |
| **6** | Retention at months 3, 6 and 12 | `cohorts` | `retentionAtAge`, indexed to the signup month. A cohort is plotted only once that age is behind it, otherwise its last observed month doubles as its retention and every recent cohort reads as perfect. |
| **8** | Retention by era, logos kept | `cohorts` | `retentionByYear`. At age k the denominator is every customer of that year whose cohort has had k months to run, and **a point is dropped under 20 customers, the only rule that decides where a line stops**, so the far end of the newest year can rest on one cohort. The finding prints the cohorts and customers behind the point. The curve can rise: that is the sample shrinking, not customers returning. |
| **9** | Same cohorts, revenue kept | `cohorts` | Same function, capped gross revenue retention indexed to month 1, the second month. |
| **11 / 12** | Logos and revenue kept, year against year | `data.customers`, `cohorts` | `seasonalSurvival`. The same calendar window this year, twelve and twenty-four months back, one fixed set each. Revenue is recurring MRR, with the starting month's own intake valued at its second month so the joining charge does not sit in the base. |

### Flow and churn

| # | Chart | Source | Transformation |
|---|---|---|---|
| **7** | Cost per logo against revenue per logo | `data.cacMonthly`, `cohorts` | `unitCostSeries`. Acquisition cost over `logosStarted`, the count charts 1, 2 and 17 use, and the same cohort's month-0 MRR per logo. Both indexed to the median month of the first year, so neither absolute needs to be right; the boundary month is blank. |
| **10** | Monthly logo flows | `data.waterfall` | Read as pushed: new, reactivated, churned and net logos from the summary. New is first appearance, not the cohort count. |
| **18** | Forward survival from every start month | `data.customers` | `forwardSurvival`. Take everyone active in a month and follow that exact set forward. A start month counts only once its full window exists. A different question from cohort retention. |
| **19** | Survival by starting month | same | Same series, one point per start month; the worse of the two period averages is the red rule. |
| **20** | Customer Success capacity against churn | `data.expenses`, `data.customers`, `data.waterfall` | `capacityAnalysis` at a four-month horizon. Spend per live logo for Customer Success, Technical Account Manager and Support together, since headcount is not in the data, against the share of each month's base gone four months later. Correlations on the measured months with Fisher intervals. `data.waterfall` supplies the arrivals series. No control: the CS split is settled. |
| **21** | Is either relationship moving | same | Rolling twelve-month correlations of four series against churn: arrivals, CS spend, the whole retention function and signup price. |
| **22** | Does churn rise when fewer arrive | `data.customers`, `data.waterfall` | `arrivalsAgainstChurn`. x is the summary's `new_logos`. Slope per ten fewer arrivals with a 95% interval, because a correlation on two dozen points is easy to over-read. Starting months anchored to those a six-month window has elapsed for. |
| **23** | Churn against arrivals, one to six months | same | The same test at every horizon on the same anchored starting months, because a thin month and a bad month can be the same month for unrelated reasons. |
| **24** | The same, split by what customers pay | `data/customer_waterfall.json` **direct** | Static GIF, `media/arrivals_vs_churn_by_price.gif`. Built by `scripts/make_gifs.py`, which reads the pushed JSON itself rather than going through `load()`, on the same window `load()` derives (`site_window`), so its starting months are chart 23's. Each month split at its **own median** subscription, not a fixed price; the lower half holds every customer paying nothing. Its axes are its own. |
| **25** | The same question, month by month | same | Static GIF, `media/arrivals_by_month.gif`. One frame per starting month, fixed axes across every frame, because rescaling each frame would make the movement invisible. The finding is computed by `renderArrivalAnimations` from `arrivalsAgainstChurn` at one month. |
| **31** | Monthly churn by tenure | `data.customers` | `churnByTenure`, cut at 3/6/12 months, tenure from first presence. Describes the standing book, not an intake. A band with no members yet is blank. |
| **32** | Present but paying nothing | `data.customers` | `zeroMrrShare`. Live logos carrying zero MRR, with the never-paid accounts left out of both the count and the base. |

### Price

| # | Chart | Source | Transformation |
|---|---|---|---|
| **13** | Price at signup against volume | `data.customers`, `cohorts` | `signupPriceHistory` for price (second-month MRR of new customers still paying, with booked `new_mrr` drawn behind) and `logosStarted` for volume. |
| **14** | What each price band returns | `data.customers` | `priceBands`, edges at 0 / 500 / 750 / 1000 / 1500, **banded on what a customer pays from their second month**, not the booked `new_mrr` that carried the joining charge. Each band followed the same number of months, survival read at month horizon - 1 with the signup month as 0. |
| **16** | How a month starts: start type mix | `data.signups` | `signupEconomics`. Coverage against billed new events can exceed 100%. |
| **17** | What a logo cost, and when it came back | `cohorts`, `data.cacMonthly` | `projectedBreakEven`. Table form of chart 2, on the same recurring donor path; the 90% range resamples single donor cohorts. |

### Cost

| # | Chart | Source | Transformation |
|---|---|---|---|
| **26** | Acquisition cost by category | `data.expenses`, `data.cacMonthly`, `cohorts` | `acquisitionCosts`, divided by `logosStarted`. CAC Monthly's `cac_total_actual` is carried as `reported` for the drift sentence. |
| **27** | The same cost per logo, by category | `data.expenses`, `cohorts` | `acquisitionCosts`, each category over `logosStarted`. Categories with no money are not lines. |
| **28** | What a customer pays, and what is left | `data.serve`, `data.customers`, `data.expenses`, `data.cacMonthly` | Revenue per logo from `costToServe`; cost from `costRates` over the same count (never-paid out); acquisition spread over the active base is the last switch, on by default. One line governed by the switches. |
| **29** | Cost of sales per logo, by team | `data.serve` | Team columns matched on `/^\d{4}-\d{2} /`; five largest drawn and the rest summed, all over the page's active count, so the lines sum to the dashed total. |
| **33** | Everything a cohort returned against everything it cost | `cohorts`, `data.expenses`, `data.cacMonthly` | `fullCostRecovery`. Chart 1 with the assumed margin removed: the numerator is revenue itself and every cost sits in the denominator where it can be seen and switched off. Toggleable by cost group and revenue group. Ongoing cost from `costRates`; projections on the booked donor path, recency-weighted on a nine-month half-life. |
| **39** | What it costs to keep one customer, by layer | `data.expenses`, `data.customers` | `ongoingCostPerLogo`. Divided by **paying** logos, since a zero-MRR account cannot carry fixed cost. Includes G&A and R&D. Acquisition excluded, because it belongs to the cohort that caused it. The finding ranks layers on six-month medians. |
| **40** | What the business spends to run, by layer | `data.expenses`, `data.customers`, `cohorts` | `costLedger` layer subtotals; acquisition per logo over `logosStarted`. The finding restates the latest month at its usual variable share where that month is an outlier. |
| **41** | Every cost line by account, last six months | `data.expenses` | `costLedger` at line granularity; the bucket comes from QB Expenses. |
| **49** | What each account costs to keep, across S1 and S2 | `data.expenses`, `data.customers` | `accountServeCost`. Chart 39 per account. Platform, people, G&A and R&D per **paying** logo, variable at the month's rate on the account's own revenue, so the accounts in a month sum back to chart 39's layers exactly. Both functions read the month's spend from `serveSpend`, the one implementation. Contribution is all revenue less platform, people and variable; the latest month is also stated at the window's median variable rate, because a month pulled before its credits were posted overstates variable cost (Aug 2026: 117 under water as booked, 113 at the usual rate). CSV of every account and month from the figure. |
| **43** | Customers being billed who are not paying | `data.customers` | `pastDueNow`. The latest month only: live logos by `subscription_status`, and the count and share reading `past_due` or `unpaid`. The status is each customer's current value stamped on every month (no customer carries two), so it is not drawn as a series. |
| **44** | Revenue a cohort has lost, as it ages | `cohorts` | `cohortRevenueRetention`. Departures weighted by second-month MRR, by intake year; stops under 3 intakes or a $25k base. Downgrades in the hover. |
| **45** | Revenue still arriving at fixed ages | `cohorts` | `revenueRetentionAtAges`. Capped gross revenue retention at 3, 6, 9, 12 and 18 months, one point per signing month; short cohorts carried along the all-cohort shape with a drift correction, dashed. |
| **46** | Retention curve for a chosen run of signing months | `cohorts` | `windowRetentionCurve`. A window of signing months blended into one capped revenue curve, measured as far as its youngest cohort has lived and carried beyond. Opens on the newest three-month window with a full year. |
| **47** | Every lever, against what it does to revenue | `data.customers`, `cohorts`, `data.expenses` | `leverProjection`. The book decays along the capped revenue retention of every cohort, new business along the six newest cohorts with a year; costs from `costRunRates`, payroll and acquisition held at the last three months; cost to win a logo from `acquisitionCosts`. |
| **48** | Where the costs go, twelve months out | `data.expenses`, `data.customers` | `costForecast` on chart 47's path. Each of chart 33's cost groups carried on its driver in `COST_DRIVERS`; depreciation shown and left out of the totals. |

### The Events tab

| Report | Source | Transformation |
|---|---|---|
| What each event cost, and what its customers have paid since | `data.eventCosts` (Event Costs tab), `EVENT_EXTRA_COSTS`, `data.customers` (`lead_source`, `lead_medium`, v120), `accountServeCost` | `eventRoi`. Cost is the tab's sponsor plus travel. A fee in `EVENT_FEE_DECISIONS` replaces the tab's only while the tab still carries the value it replaces; a fee in `EVENT_PACKAGES` is split by the number of events it covers, membership by name pattern and month window. `EVENT_FEES_QB` explains each fee and says where QuickBooks and the tab differ; it replaces nothing. `EVENT_EXTRA_COSTS` adds an event not yet on the tab until a row with its words and month (within one) appears. Customers are those whose lead source names the event, matched through `EVENT_ALIASES` or by name and year, credited only if their first payment (`firstPaymentMonths`, revenue or cash) is in or after the event's month; earlier payers are shown as already paying, except a win-back: a former customer with no paying month in the `WINBACK_GAP` (3) months before the event who pays again from its month, credited with only what they paid from then. HubSpot stores the 2025 Blue Sky Mastermind option as "Blue Sky Mastermind (Tradesformation) (contact)"; `leadMediumOf` reads that value as the event, not the partner. A source whose month (`EVENT_UPCOMING`) or year is after the data is upcoming: no cost, blank results. Events with a cost and no tagged customer stay on the list at zero. Collected is net cash; contribution is chart 49's per customer, with a month the ledger had not closed (`accountServeCost.outliers`) read at the usual variable rate (`eventContributionRows`) in every Events figure. Sourcing, not attribution: the partnerships 60-day rule will disagree. |
| Last or first touch (switch) | `eventRoi` `touch`, `lead_source_first` (v138) | Last touch reads the lead source HubSpot shows now, the last event a contact touched. First touch reads the first value the field ever held, falling back to the current tag where there is no history; a first-touch value takes the medium the pipeline gives that value as a current tag, or event if it carries a year. Tag timing uses `lead_source_first_at` in first-touch mode. |
| Which customers an event is credited with (switch) | `eventRoi` `creditRule`, `CREDIT_RULES` | Every tagged customer who first paid in or after the event's month (default); or only those whose HubSpot record existed by the end of the month after the event; or only those who first paid within 3 or 6 months of it; or only those whose won deal (`won_deal_source`, Oct 2026) names no other source, so an event whose deal was lost keeps the lead and not the revenue (a won deal naming the same event, by value, alias or words and year, counts as the event's; no won deal linked stays in). Already-paying customers and win-backs are decided as before. Applies to every Events figure and each event's page. |
| Ranking at a chosen age, and the scatter | `eventRoi`, `eventReports` recovery | Each event with a cost above zero and a month (`eventHasReturn`) read at the same number of months from its event month (slider, 1 to 12): contribution by then less cost. Events younger than the age are listed faded, not ranked. With none paid back, the closest by share recovered is named. The scatter plots cost against contribution at that age. |
| When each event pays for itself | `eventReports` payback, `projectBase` | Paid: first month cumulative contribution covered cost. Otherwise each live credited customer is carried at the median of their last three months since first payment, kept on at `projectBase` survival for their age; projected is the first month the total covers cost within 36 months of the event, else not expected. No credited customer: none, or too new under three months old. |
| Share of cost recovered by month from the event | `eventReports` | Contribution from the customers each event brought, summed from the event's month and divided by its cost; null past the last month of data, so events are compared at equal age. Median drawn where five or more events reach a month. |
| By organiser, by kind of event | `eventReports`, `EVENT_META`, `ORGANISER_PARTNER_SOURCES` | Events summed by who runs them and by kind. Organiser, kind and 2027 status are editorial, set in `EVENT_META` (read by name, or by words and year if renamed); a costed event without an entry is "Not yet classified", and the tab says if organisers or kinds fail to add up to total spend. An organiser whose only events are under three months old with no customer is not counted as behind. The cost of an event still ahead, or whose cost is still settling (v133 `cost_source`), is shown as committed beside the organiser's and kind's cost and kept out of their net; the two together add up to total spend. Customers tagged with the standing partnership (no year) are counted beside the organiser and never added to its events. |
| Spend with no customer | `eventReports` | Costed events at least three months old where no tagged customer started paying in or after the event's month. Younger ones are named as too new. |
| Events against other channels | `eventReports`, `CHANNEL_SPEND` | Customers who started inside the window, by lead medium, against untagged: median first MRR, paid per paying month, share live 6 and 12 months after first payment (blank under ten). Spend from QuickBooks 6100-05 by vendor for digital over `CHANNEL_SPEND.from` to `to`, divided by tagged starters in those months (a ceiling); webinars and the podcast carry no recorded cost. |
| How the tags were made | `eventRoi` `tagEvidence`, `lead_date`, `lead_set_at`, `lead_bulk` (v128, v129) | For each credited customer: HubSpot record created within a month of the event, before it, or later; created on any day the pipeline flags a list import for their source (every burst is read); and, once `lead_set_at` is filled, tagged by the end of the month after the event (at the time), later, or not dated. A dated note records the v129 removal of the HSF 2025 September import. A notice at the top of the tab shows while `lead_set_at` is blank on every tagged customer. |
| Disputed fees, settled | `EVENT_FEE_DECISIONS`, `EVENT_REPORT_NOV2025` | Each disputed fee with the evidence that settled it: the Nov 2025 Event ROI sheet and the QuickBooks bill. The tab's current fee is shown beside the fee used. A changed fee applies only while the Event Costs tab still carries the value it replaces; a decision whose event is no longer on the tab is flagged. |
| Fees that paid for more than one event | `EVENT_PACKAGES` | Each shared fee whole, with the events it has covered so far, their share of the fee plus travel, customers, collected and net. Blank where no event has happened yet. |
| Sponsorship in no event | `EVENT_UNASSIGNED_QB` | 6100-07 lines in the QuickBooks export that belong to no event on the calendar, listed in the events note. |
| Stripe customers missing from the waterfall | `scripts/validate_data.py` `check_missing_customers` | Not a chart. Customers in Subscription Lifetimes or New Customer Cohorts with no waterfall rows (the workbook's payment pull does not pick them up, and the pipeline is not being changed). Checked against Stripe's own Sigma pull on 5 Oct 2026: 44 such customers, all at $0 of new MRR in Stripe (refunded, never paid, or a card check), so no revenue is added for them; the validator reports them by id on every push and warns if those who paid a first invoice pass 8% of cohort signups. Companies already present under another Stripe id are ignored. |
| One event's page (`#event=<name>`) | `eventRoi` (cost row, `customerRows`), `eventReports`, `eventLeads` | Every figure the Events tab holds for one event: fee used and the tab's fee, travel, total, cost source and note, the settled-fee evidence or shared-fee split, the Nov 2025 report line; customers credited, already paying, live, MRR, collected, contribution, net, payback and recovery at 3, 6 and 12 months with the curve; leads from Lead Counts; how the tags were made; and each credited customer with first payment, MRR now, collected, contribution and tag dates. |
| Cost per earned lead, by event | `data.leadCounts` (Lead Counts tab, hs-v23), `eventLeads` | Earned leads (booth scan, meeting, form, rep, chat; never a loaded list) per lead source, matched to the event's cost by the same rules as customers. Before and after the event are shown where the event has a date but not divided into cost, because later list loads land after it. Confirmed and contradicted as the pipeline counts them. |
| Tagging coverage | `eventReports` | New customers by first-payment month, share carrying any lead source and an event source. |

### Projection and pricing decisions

| # | Chart | Source | Transformation |
|---|---|---|---|
| **34 / 35 / 36** | Logos, revenue and contribution, twelve months out | `data.customers`, `data.waterfall`, `data.serve`, `data.expenses`, `cohorts` | `projectBase` + `arrivalScenarios`. Cohort roll-forward with age-specific survival pooled over every month pair; revenue is logos by age times what a logo of that age pays, scaled so the starting month reproduces observed MRR. Backtested on every load from twelve months back with the summary's arrivals; the error is printed on chart 34. Chart 36's cost to win a logo is `acquisitionCosts` over six complete months. |
| **37** | Every paying customer against what they cost | `data.expenses`, `data.customers` | `priceFloors`. **Two floors, and confusing them is the expensive mistake.** The marginal floor is what one more or fewer customer changes — licence, hosting, merchant fee, revenue share. The allocated floor spreads every fixed cost over payers. Median-based rather than mean, for robustness to credit-note timing. |
| **38** | Cutting them against re-pricing them | same | `repriceOutcomes`. Cutting is modelled to its conclusion: revenue and variable cost go, fixed cost stays, the floor rises for everyone left, repeat. It does not converge, which is the finding. |
| **42** | Cost per customer, to your own definition | `data.expenses`, `data.customers` | `costCalculator`. A 50-50 blend of the last six and three months. Toggleable cost layers and logo types. Excludes logos that have never paid above $0. |

### The Upgrade list tab

| Report | Source | Transformation |
|---|---|---|
| Campaign calculator | `data.customers`, `data.expenses` | `campaign` + `ruleSpread`, each rule on its own viable pool. The pricing rule and the churn assumption are both switches, because nobody has run this campaign. Accounts excluded by the eligibility rules keep paying in the after figure. |
| Band economics | `ENGAGEMENT` constant, `priceFloors` | `bandEconomics` / `bandCampaign`. Contribution basis rather than revenue: a dormant account and a heavy user paying the same are worth different amounts. The merchant fee is charged once, in the variable rate. A separate scenario from the calculator. |
| Accounts worth a conversation | `data.customers` | `upgradeList`. Eligibility is **12 months of age or more** and **above $2 MRR**: a dollar a month is a free account with a token charge, not a cheap customer. Every target is a flat $600, or $500 and $750 under the tiered rule. `settledPeaks`, which excludes each customer's first month because it carries the joining charge, decides only "held it before" and viability. |

---

### Two charts that do not go through the loader

Charts 24 and 25 are animated GIFs, not SVG drawn at load. They are built
by `scripts/make_gifs.py`, which reads `data/customer_waterfall.json`
directly and applies its own presence rule rather than importing
`data.js`. The deploy workflow regenerates them on every push
(`.github/workflows/pages.yml`), so they are current, but they are a
second, independent implementation of the same presence logic and of the
window (`site_window()` mirrors `load()`), and nothing checks that the two
agree beyond their printing the same correlations.

Chart 24's finding is **hardcoded in `index.html`**, not computed. Chart
25's is computed by `renderArrivalAnimations` on the site's own series.

---

## 4a. The window, as of v120

`load()` admits a month only if it is no earlier than `data.historyStarts`,
before the reader's current month, and no later than the last complete
month: the earlier of the last month whose QB Expenses total is at least
half the median of the six months before it (`ledgerThrough`) and the last
month the Waterfall Summary carries. The ledger condition exists because
Stripe closes a month when it ends and QuickBooks weeks later: the 1 October
push carried all of September's revenue against $114,865 of ledger. Until a
month's ledger closes, the whole page stops at the month before it.

`data.historyStarts` is the first month QB Expenses carries (2024-01), and
never more than 32 months before the last complete month. It used to be the
reader's clock less 32 months, which slid the window forward a month on the
first of every month with nothing pushed.

## 5. What runs between a push and a chart

| Step | Where | What it does |
|---|---|---|
| Validate | `.github/workflows/validate-data.yml` -> `scripts/validate_data.py` | Runs on every data push. Checks month format is `YYYY-MM` text, that blank is null and never zero, that presence is not read from payment, and that departures reconcile. **Does not block the deploy** — it opens an issue instead, on the reasoning that a site with a warning beside it beats no site. |
| Build GIFs | `.github/workflows/pages.yml` | Regenerates charts 24 and 25 from the pushed data. |
| Deploy | same | Publishes `site/` and `data/` to Pages on any commit touching either. |

On the current push the validator returns **no errors and no warnings**.

It still does not check that `event_type` values are ones the site
understands — when a push introduced an `inactive` type on 21,018 rows,
the validator passed, the deploy went out, and the page rendered half the
business without an error. **The site now guards that itself** (see
`checkVocabulary` above), so the failure is caught after the deploy rather
than before it. Moving the check upstream into `validate_data.py` would
catch it earlier still.

---

## 6. Assumptions that are not in the data

| Constant | Value | Where | Status |
|---|---|---|---|
| `LEGACY_PLATFORM_MARGIN` | 0.757 | data.js | Fallback only, and never reached on current data: 32 months solve cleanly. |
| `CLASS_MARGINS.usage` | 0.60 | data.js | Immaterial. Usage is 0.47% of revenue; swinging this and one-time across 0 to 1 moves the platform margin by 0.56 points. |
| `CLASS_MARGINS.oneTime` | 0.90 | same | Immaterial, as above. |
| `passThrough`, `recognisedElsewhere` | 0 | same | Deliberate. Pass-through is carrier fees, sitting in revenue and cost of sales at once. Recognised-elsewhere is already carried by a couponed subscription. |
| `ENGAGEMENT` | 150 accounts, 3 bands | data.js | **Hand-entered** from an export dated 2026-09-22. The `usageMultiple` values (2.2 / 0.6 / 0.05) are estimates, not measurements. No pipeline source exists. |
| `halfLife` | 9 months | donor weighting | A modelling choice with no true value to discover. |
| Churn and pricing presets | various | `CHURN_PRESETS`, `PRICING_PRESETS` | Deliberately exposed as switches. |

### Decisions taken on 2 October 2026

| Question | Decision | Why |
|---|---|---|
| Which count is a month's new customers | The cohort count (`logosStarted`) everywhere a month's arrivals are an input: charts 7, 20 to 27, the pricing scenarios and the GIFs (`make_gifs.py` `cohort_sizes`, checked equal month for month). The projection (34 to 36) enters first appearances (`logosAppeared`), because it counts everyone present and that is what enters such a base. The Waterfall Summary's `new_logos` is read only by chart 10, which says so. | One count of a new customer, as CLAUDE.md asks. The summary books everyone already present as new in the window's first month (59 against 20); that month is blank on the cohort count. Chart 22 reads +0.30 at four months on it, not significant, so the conclusion stands. |
| Age of a customer present when the window opens | The oldest bucket (24 months) in `projectBase`, unless Subscription Lifetimes gives a real start date. | Dating 767 long-standing customers from 2024-01 made them most of the age-0 to age-12 survival curve through 2024. Chart 31 already puts the same customers in its oldest band. The twelve-month logo backtest improves from 2.2% to 0.3% off; MRR is unchanged at 3.8%. |
| Where merchant processing sits in `COST_GROUPS` | With revenue share, not platform. | Card fees are charged on every payment and scale with the bill. `COST_LAYERS`, `serveSpend` and `priceFloors` already grouped them that way; chart 48's forecast now carries them on revenue rather than per customer. Defaults are unchanged in total. |
| The two variable rates, 9.0% and 9.7% | Kept, both stated. | One merchant and revenue-share spend on two denominators: chart 49 divides by everything an account pays, the price floors by subscription revenue. Chart 49's finding now gives both. |
| Chart 33's carried cost rate | Each group carried on its `COST_DRIVERS` rule, the one chart 48 uses: payroll at the mean of three months, platform at the mean of six, merchant fees and revenue share at the median of six. | A flat mean of three carried August's revenue-share bill, pulled before its credit was posted, into every projected month. |

---

## 7. Columns present but not read

20 of 40 waterfall columns are unused. Most are redundant — `bop_mrr`,
`expansion_mrr` and the other flow components are re-derived from
`eop_mrr` transitions. These are the ones that would change something:

| Column | What it would enable |
|---|---|
| `sub_start`, `sub_end`, `has_live_sub` | **The biggest one left.** Both date columns are now clean — 0 malformed of 33,506 — so real subscription tenure is available and the age-eligibility rule on the Upgrade tab still infers it from first revenue |
| `platform_mrr`, `upgrade_mrr` | Which part of MRR moved. **Not a decomposition** — the gap to `eop_mrr` is revenue nobody could name, and it has closed to under 2% of MRR |
| `fidelity` | 33,627 rows are `amount_only` against 12,361 `resolved`. Recent months are fine; anything over the full window rests mostly on revenue classified by size |
| `unclassified_revenue` | Was ~6% of recent cash when this was written. **Now 0.4%** — the ladder work closed it |
| `invoice_discounts`, `credit_notes` | Separate couponed and credited accounts from phantom MRR. 284 and 16 rows respectively |
| `last_paid_at` | **Fixed.** Was 91% September; now 36.6%, and 91% of customers live in the trailing month last paid in the trailing month or the one after |

Three that were on this list have come off it: `subscription_status` and
`unpaid_due` now drive chart 43, and `is_annual` is read but deliberately
not acted on, because the pipeline spreads annuals from v116 and doing it
here as well would overwrite ordinary MRR on any customer who has both.

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

### The Marketing tab

| Report | Source | Transformation |
|---|---|---|
| Spend by category, by month | `data.expenses` (6100-05 total), `MARKETING_AD_VENDORS`, `eventRoi` | Meta and podcast sponsorships split out of 6100-05 by vendor from the QuickBooks Transaction Detail export (Sep 2025 to Aug 2026); the rest of 6100-05 is other advertising, so categories add back to the ledger. Event spend is the Events tab's cost by event month; event fees booked under advertising are taken out of advertising so they count once. |
| Leads, deals opened, deals won | `data.marketingMonthly` (Marketing Monthly tab, v143), `marketingCategoryOf`; `MARKETING_SNAPSHOT` (HubSpot, read 5 Oct 2026) only when the tab is absent | Contacts created by Original Traffic Source and drill-down (paid social, search and direct, other digital; a drill-down naming a webinar or the Revenue Optimization Lab is a webinar lead; Offline Sources left out), plus earned event leads by event month from Lead Counts. Deals opened and won, signed MRR won and deals opened on a bulk day by the deal's lead source, or its sub-source where set, read the way the waterfall's `lead_medium` reads that value. The window starts where `MARKETING_AD_VENDORS` does (Sep 2025), since the tab runs back to 2019. |
| Paying customers | `data.customers`, `firstPaymentMonths` | Stripe customers by the month of their first payment and the category of their HubSpot tag; untagged where there is none. |
| Cost per lead, won deal, paying customer | `marketingReport` | Category spend divided by its leads, won deals or paying customers over the window; by month, spend over the three months to date divided by deals won in them. Categories with no direct spend show none. |
| Headline figures, source ranking and funnels | `marketingReport` (`totals`, `detail`, `paidRoi`) | Spend, deals won, paying customers, contribution and MRR still arriving from customers who started in the window. Each source: spend with cost per lead, won deal and customer; contribution so far and the next twelve months projected for its live customers (median of their last three months since first paying, kept on at the `projectBase` survival curve, no new customers); ROI to date and with twelve more months. Funnel: leads (first arrival), deals opened and won (deal lead source), paying customers (Stripe, by tag), with won over opened and paying over won. |
| One source's page (`#source=<name>`) | `marketingReport.detail` | Headline figures, spend and contribution added up month by month, leads, won deals and paying customers by month, cost per paid-social lead by month, the funnel, and each customer with first payment, MRR now, billed, collected and contribution. |

