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
| Resolved source or first recorded value (switch) | `eventRoi` `touch`, `lead_source`, `lead_source_first` (v138, v156) | The default reads `lead_source`, which since v156 is the pipeline's resolved source: the earliest attributable source at the company, by origin (deal tag, then contact tag, then campaign) and then arrival (the later of the record's creation and the event it names), ties broken by contact id. The other reads `lead_source_first`, the first value the HubSpot property ever held, falling back to the resolved source where there is no history; it takes the medium the pipeline gives that value, or event if it carries a year. Tag timing uses `lead_source_first_at` in that mode. Until v156 the default was the tag HubSpot showed, which was last touch. |
| Which customers an event is credited with (switch) | `eventRoi` `creditRule`, `CREDIT_RULES`, `DEFAULT_CREDIT_RULE` | The default since 7 Oct 2026 is 'won': every tagged customer who first paid in or after the event's month, except one whose event deal was lost and whom another source's deal won; on the Marketing tab that customer is counted under the winning source. The others: every tagged customer who first paid in or after the event's month; or only those whose HubSpot record existed by the end of the month after the event; or only those who first paid within 3 or 6 months of it; or only those whose won deal (`won_deal_source`, Oct 2026) names no other source, so an event whose deal was lost keeps the lead and not the revenue (a won deal naming the same event, by value, alias or words and year, counts as the event's; no won deal linked stays in). Already-paying customers and win-backs are decided as before. Applies to every Events figure and each event's page. |
| How strong each event's evidence is | `event_credit`, `event_lag_months` (v147, rules v148), `eventRoi` `evidence` | Each credited customer who has paid carries the pipeline's grade against their current tag: direct (won deal names the event; record on or after it or within 45 days before), indirect (won deal names something else, or an older record), tag only (no won deal). Shown per event as a split, with cost per direct customer beside cost per tagged customer, and months to first payment as a median and range (below zero is a win-back). An event is dated where Lead Counts carries a date or any of its customers has a lag; otherwise it is marked undated. 'Only direct customers' is a credit option. The validator warns where a customer is graded direct with no lag. |
| Confidence, per event and per source | `eventConfidence`, `sourceConfidence` | How sound the data going in is, not how far a result has had time to run (since 9 Oct 2026): a week-old event with its fee and travel recorded, a date and customers its own deals closed reads High, and neither the number of customers nor the event's age lowers it. Event, Low: a fee expected and not found (`absent`), no cost found yet (`pending`), or no cost. Event, Medium: a modelled cost, travel not known, no event date while it has customers, or fewer than half its customers closed by its own deal. Source, Low: untagged, or three or more won deals per paying customer (deals and customers tagged differently). Source, Medium: events under 60% direct, 40% or more of won deals under a generic label, spend from the one-off QuickBooks export, or webinars counting the Revenue Optimization Lab. Shown beside each event and source, in the Marketing summary, and as a panel on each page. |
| Merged event names | `SOURCE_MERGE`, `EVENT_ROWS_MERGED` | The 2026 Wealthy Plumber event and Home Service Hoorah 2026 are one event (Josh, 9 Oct 2026). `2026 - Wealthy Plumber` is read as `2026 - Home Service Hoorah` in lead_source, lead_source_first and won_deal_source; its Lead Counts row is added into Hoorah's, keeping Hoorah's date; the `Wealthy Plumber 2026` cost row is dropped as a duplicate. Hoorah 2026 is a partner network event organised by The Wealthy Plumber. |
| Upcoming events from the Event Hub | `EVENT_EXTRA_COSTS`, `EVENT_META` | Four events on the CHIIRP Event Hub (read 9 Oct 2026) that the Event Costs tab does not carry: CertainPath Connect 2026 (Oct, no fee entered), Build it to Sell it 2026 (Dec, no fee), Table of Titans 2027 (Jan, $7,995) and EGIA Epic 2027 (Feb, no fee). Added as 'not yet', listed under Not scored yet, and replaced by the tab's row as soon as it carries the event. `2026 - HSF Freedom`, a misspelt option with one contact, is read as `2026 - Home Service Freedom`. |
| Event attribution: leads each event produced, and how far they went | `data.eventLeadRows` (Event Leads tab, hs-v82), `eventFunnel`, `leadState` | One row per contact tagged to an event, matched to its event through Lead Counts and the cost rows; year-prefixed webinars and podcasts are left out. New leads are rows with after_the_event yes that did not arrive in a loaded list (arrived_as list): a file is not someone who did something, and Lead Counts has always left lists out of earned leads. Until 12 Oct 2026 the funnel counted them, which put Pantheon 2025's attendee list of 986, loaded on 11 Nov 2025, among its new leads (2,454 list arrivals across all events); they are now their own state, not counted, with their deals and wins said on the event page. An existing contact from a list whose deal the event re-engaged still counts. An existing contact (no) counts as re-engaged when its deal opened within 90 days after the event, or in the 45 days before it through a conversion naming the event (its meetings link or form; decided 12 Oct 2026, since the date alone credited Pantheon 2026 with deals from a Lab session and general demo forms); the rest are shown apart and not counted: tagged with no deal, or with a deal opened well before the event or long after (back-tagging); an undated event shows every tagged contact and is labelled. Booked is a setter recorded, sat is a deal existing (HubSpot creates one only once a demo is sat), won is the deal winning. Each rate carries its numerator and denominator and fades under ten. Won deal amount is the deal's amount, an estimate, never summed as revenue. On each event's page: the count in each of the seven states and the deals listed (the push carries no company name). How the counted leads came in (12 Oct 2026): through its own link or form when the conversion carries every distinctive word of the source, its first two, or its first when that is a brand (`conversionNamesEvent`; "home service" alone never matches); through something else when another conversion is recorded. These replace Lead Counts' confirmed and contradicted on the event page and the Events leads table, because in v169 contradicted repeated confirmed (Pantheon 2026 56 and 56, System Forward, Facebook, BCSG); Lead Counts' confirmed is used only for an event with no Event Leads rows. |
| Sales: setters and deal owners | `salesReport`, `personName`, `data.setterRows` (Setters tab) | From Event Leads, events only: setters (booked_by) with leads booked, sat, won; deal owners (demoed_by, the proxy for who ran the demo, since there is no AE field) with deals, wins and close rate on closed deals; a setter-by-event grid. A blank setter is its own 'not recorded' line, never spread across people. The Setters tab is shown as it arrives: every lead source per person (leads, sits, wins). A person the pull could not name shows as 'HubSpot user <id>'. |
| Campaigns named for an event or a webinar | `campaignTarget`, `campaignContext` | A Marketing Monthly lead row whose campaign drill-down matches an event source's words (and year) counts as that event's leads, unless Lead Counts already holds its campaign contacts; one matching a Webinars tab title counts as Webinars. Only rows from the event's month on count (12 Oct 2026): before it a campaign is promotion and stays in its own channel, so the 2026 Wealthy Plumber list of June and July (97 contacts) is not Home Service Hoorah 2026's, which counts from the event as Hoorah 2025 did. The Events source page lists each event with cost, leads (campaign contacts shown apart), booked, sat, won, paying customers, contribution and confidence. |
| Ranking at a chosen age, and the scatter | `eventRoi`, `eventReports` recovery | Each event with a cost above zero and a month (`eventHasReturn`) read at the same number of months from its event month (slider, 1 to 12): contribution by then less cost. Events younger than the age are listed faded, not ranked. With none paid back, the closest by share recovered is named. The scatter plots cost against contribution at that age. |
| When each event pays for itself | `eventReports` payback, `projectBase` | Paid: first month cumulative contribution covered cost. Otherwise each live credited customer is carried at the median of their last three months since first payment, kept on at `projectBase` survival for their age; projected is the first month the total covers cost within 36 months of the event, else not expected. No credited customer: none, or too new under three months old. |
| Coupons and free months | `invoice_discounts`, `freeMonth` on each customer row | A month whose invoice discounts took the whole charge, with no MRR and no cash, is a free month: the customer stays live and is not a departure, and the month counts in contribution as cost with no revenue. Projections (event payback, Marketing's next 12 months) take the median of the last three months a customer paid, skipping free months, so a coupon does not project as a lost customer. MRR a coupon is holding back now (the discount) is shown as paused beside MRR now, per source, per event and in the Marketing headline. 171 free months in the 7 Oct 2026 push, mostly one or two months long and mid-life rather than at signup. |
| An ended month QuickBooks has not closed | `load`, `estimatedMonth` | Decided 9 Oct 2026: the month after the last closed one is carried on estimated costs once it has ended and Stripe has it, rather than left out. Each QB Expenses account is the larger (by size) of what is posted and its median over the three months before; Serve Monthly's cost totals take the same medians, with per-logo figures and margins recomputed from the month's own active logos and revenue. Acquisition spend follows from the estimated lines through `isAcquisition`. Revenue, customers and cash are Stripe's actuals. The footer names the month; the estimate stops when the real close passes the ledger test. The Marketing tab stays at the last month of the QuickBooks vendor split, since a later month would carry paid social's leads without its spend. |
| Share of cost recovered by month from the event | `eventReports` | Contribution from the customers each event brought, summed from the event's month and divided by its cost; null past the last month of data, so events are compared at equal age. Median drawn where five or more events reach a month. |
| By organiser, by kind of event | `eventReports`, `EVENT_META`, `ORGANISER_PARTNER_SOURCES` | Events summed by who runs them and by kind. Organiser, kind and 2027 status are editorial, set in `EVENT_META` (read by name, or by words and year if renamed); a costed event without an entry is "Not yet classified", and the tab says if organisers or kinds fail to add up to total spend. An organiser whose only events are under three months old with no customer is not counted as behind. The cost of an event still ahead, or whose cost is still settling (v133 `cost_source`), is shown as committed beside the organiser's and kind's cost and kept out of their net; the two together add up to total spend. Customers tagged with the standing partnership (no year) are counted beside the organiser and never added to its events. |
| Spend with no customer | `eventReports` | Costed events at least three months old where no tagged customer started paying in or after the event's month. Younger ones are named as too new. |
| Events against other channels | `eventReports`, `CHANNEL_SPEND` | Customers who started inside the window, by lead medium, against untagged: median first MRR, paid per paying month, share live 6 and 12 months after first payment (blank under ten). Spend from QuickBooks 6100-05 by vendor for digital over `CHANNEL_SPEND.from` to `to`, divided by tagged starters in those months (a ceiling); webinars and the podcast carry no recorded cost. |
| How the tags were made | `eventRoi` `tagEvidence`, `lead_date`, `lead_set_at`, `lead_bulk` (v128, v129) | For each credited customer: HubSpot record created within a month of the event, before it, or later; created on any day the pipeline flags a list import for their source (every burst is read); and, once `lead_set_at` is filled, tagged by the end of the month after the event (at the time), later, or not dated. A dated note records the v129 removal of the HSF 2025 September import. A notice at the top of the tab shows while `lead_set_at` is blank on every tagged customer. |
| Disputed fees, settled | `EVENT_FEE_DECISIONS`, `EVENT_REPORT_NOV2025` | Each disputed fee with the evidence that settled it: the Nov 2025 Event ROI sheet and the QuickBooks bill. The tab's current fee is shown beside the fee used. A changed fee applies only while the Event Costs tab still carries the value it replaces; a decision whose event is no longer on the tab is flagged. |
| Fees that paid for more than one event | `EVENT_PACKAGES` | Each shared fee whole, with the events it has covered so far, their share of the fee plus travel, customers, collected and net. Blank where no event has happened yet. |
| Sponsorship in no event | `EVENT_UNASSIGNED_QB` | 6100-07 lines in the QuickBooks export that belong to no event on the calendar, listed in the events note. |
| Stripe customers missing from the waterfall | `scripts/validate_data.py` `check_missing_customers` | Not a chart. Customers in Subscription Lifetimes or New Customer Cohorts with no waterfall rows (the workbook's payment pull does not pick them up, and the pipeline is not being changed). Checked against Stripe's own Sigma pull on 5 Oct 2026: 44 such customers, all at $0 of new MRR in Stripe (refunded, never paid, or a card check), so no revenue is added for them; the validator reports them by id on every push and warns if those who paid a first invoice pass 8% of cohort signups. Companies already present under another Stripe id are ignored. |
| One event's page (`#event=<name>`) | `eventRoi` (cost row, `customerRows`), `eventReports`, `eventLeads` | Every figure the Events tab holds for one event: fee used and the tab's fee, travel, total, cost source and note, the settled-fee evidence or shared-fee split, the Nov 2025 report line; customers credited, already paying, live, MRR, collected, contribution, net, payback and recovery at 3, 6 and 12 months with the curve; leads from Lead Counts; how the tags were made; and each credited customer with first payment, MRR now, collected, contribution and tag dates. A credited customer whose won deal (`won_deal_source`) names another source is marked won on another deal; the won-deal credit rule leaves them out. |
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
| Leads, deals opened, deals won | `data.marketingMonthly` (Marketing Monthly tab, v143), `marketingCategoryOf`; `MARKETING_SNAPSHOT` (HubSpot, read 5 Oct 2026) only when the tab is absent | Contacts created by Original Traffic Source and drill-down (paid social, search and direct, other digital; a drill-down naming a webinar or the Revenue Optimization Lab is a webinar lead; Offline Sources left out), plus earned event leads by event month from Lead Counts. Deals opened and won, signed MRR won and deals opened on a bulk day by the deal's lead source, or its sub-source where set, read the way the waterfall's `lead_medium` reads that value. The window starts where `MARKETING_AD_VENDORS` does (Sep 2025). Won deals whose close date is in the future, which v147 labels as probable renewal placeholders (27 in Oct 2026, $20,374 a month signed), are left out of every count (`MARKETING_PLACEHOLDER`). |
| Paying customers | `data.customers`, `firstPaymentMonths` | Stripe customers by the month of their first payment and the category of their HubSpot tag; untagged where there is none. |
| Cost per lead, won deal, paying customer | `marketingReport` | Category spend divided by its leads, won deals or paying customers over the window; by month, spend over the three months to date divided by deals won in them. Categories with no direct spend show none. |
| Headline figures, source ranking and funnels | `marketingReport` (`totals`, `detail`, `paidRoi`) | Spend, deals won, paying customers, contribution and MRR still arriving from customers who started in the window. Each source: spend with cost per lead, won deal and customer; contribution so far and the next twelve months projected for its live customers (median of their last three months since first paying, kept on at the `projectBase` survival curve, no new customers); ROI to date and with twelve more months. Funnel: leads (first arrival), deals opened and won (deal lead source), paying customers (Stripe, by tag), with won over opened and paying over won. |
| One source's page (`#source=<name>`) | `marketingReport.detail` | Headline figures, spend and contribution added up month by month, leads, won deals and paying customers by month, cost per paid-social lead by month, the funnel, and each customer with first payment, MRR now, billed, collected and contribution. What it is made of: each Marketing Monthly value behind the source (`marketingValueLabel`; form and meeting links grouped, campaign ids dropped) with leads, deals opened and in bulk loads, deals won and signed MRR. On Webinars, one row per webinar from the Webinars tab once it is pushed. The Revenue Optimization Lab ("LAB" deals and its invitation emails) is read as Webinars throughout (`customerCategory`). |
| Editions and the 2027 plan | `laterEdition`, `EVENT_SERIES` | The 2027 plan is about a series, so it shows on an event's latest edition only; an earlier one (Pantheon 2025 beside Pantheon 2026) does not carry the chip. Editions are matched on the event's words without the year; Wealthy Plumber Hoorah 2025 and Home Service Hoorah 2026 are one series, as are HSF 2025 and Home Service Freedom 2026. The organiser roll-up still reads every edition's plan. |
| Lead record links | `companyLink`, `contactLink`, `stripeByCompany`, `stripeLink` | Each lead listed on an event page links to its HubSpot company (Event Leads' company_link, hs-v87) and, once the push carries it, its contact. The Stripe customer comes from the waterfall's stripe_link, which the pipeline builds because only it knows which of the two accounts a customer is in; until that arrives, a lead's company is matched to a customer by name only where exactly one customer carries that name, and the cell says so. |
| Three signals on an event's leads (v170) | `eventFunnel` `signals`, `cameFromElsewhere`, `ORIGINAL_ELSEWHERE` | Shown side by side and never merged into a score: in HubSpot before the event (re-engaged contacts), began with marketing (HubSpot's original source is search, social, email or a campaign; offline, direct traffic and referrals are how an event's contacts arrive), and already a prospect (deals_before above zero: the company had a deal before the lead arrived, counted by the pipeline from deals it can see rather than HubSpot's rollup). Each lead row shows its original source and deals before. |
| Win window (12 Oct 2026) | `WIN_WINDOW_MONTHS`, credit rule `won6` (the default), `winInWindow` | A tagged customer is credited to an event only if their first Stripe payment falls from the event's month to six months after it, and no other source's deal won them. A business tagged at an event and sold the next year is not the event's win or revenue (Rhoden Roofing: Pantheon 2025, lost at the event, won through the website in June 2026). Of customers the event's own deal won, 95% first paid within six months; the rule drops nine customers who first paid seven to eleven months on. In the lead funnel a win counts only when the deal opened within six months of the event, since Event Leads carries no close date; later wins show as "Won after the window". The earlier rule, without the window, stays in the selector. |
| What a lead became (12 Oct 2026) | `stripeByCompany`, `becameCell` | Event Leads (contacts) and the waterfall (Stripe customers) share no id, so a lead's company is matched to a Stripe customer by name: exactly, or where the HubSpot name starts the Stripe one, is at least two words, fits one customer only, is not a franchise brand and is not followed by "of <place>". Under where each lead stands the page says when the company first paid, its MRR now, the deal that won it when that is not this event's, and whether this event is credited with it. Customers credited to the event with no lead row (their tag is on the company or a deal, not on a contact tagged to the event) are listed under the table. An id on each lead (brief item 14) would replace the name match. |
| Upsells (12 Oct 2026) | `eventUpsells`, `bookExpansionRate`, `eventUpsellPanel` | An existing customer (active and paying the month before the event) whose contact came in through a form or meetings link named for the event (`conversionNamesEvent`; a tag alone is not enough), matched to Stripe by company name. The change is the MRR at the end of the win window (six months after the event, or the last closed month while it is open) against the month before. Expected anyway is that MRR times the book's gross expansion a month (customers paying in both months, last twelve months; 1.8% in v172) times the months elapsed. Credited contribution is the contribution on the MRR above the pre-event level, month by month at the account's own margin, scaled to the part of the increase above expected. Shown on each event page and as an Events tab column, and as "with upsells" under Net so far; never added to the event's return, rankings or ROI. Customers who paid less or left after coming through the event's form are listed too. |
| Stripe decides, on the lead list (12 Oct 2026) | `eventFunnel` states `upsell` and `wonElsewhere`, `mrrGoingInto`, `becameCell` | Revenue is always Stripe's. A lead whose company was paying going into the event, or who came through the event's upsell form or link (and is not a former customer), is an upsell lead: out of the new-customer funnel and its wins, and watched in the Upsells panel from the MRR it paid going in, even before a month after the event has closed (Pantheon 2026). A deal marked won whose Stripe customer was won through another source is 'Won, credited elsewhere' and is not the event's win (ABC Plumbing, Pantheon 2025: Powerhouse Consulting). Every lead linked to a Stripe customer says why it is or is not credited: credited, won through another source, first paid outside the window, or Stripe's customer tagged elsewhere. Customers credited to the event with no lead row are listed as rows with Stripe's revenue and link; their HubSpot deal link needs the pipeline (brief item 23). |
| Tag-only credit needs a tag written at the time (12 Oct 2026) | `won6`, `listDayOf` | Under the default rule a customer resting on the tag alone (no won deal naming the event) is credited only if the tag was written by the end of the month after the event and not on a day twenty or more contacts were loaded as a list into that source. A won deal naming the event stays credited however late it was written. Pantheon 2025 drops Schar Heating, Plumb Line and R&R Plumbing (tagged 11 Nov 2025, the attendee-list day) and keeps Popsicle Air and First Class Home Services, both won by a deal naming Pantheon; nine tag-only customers drop across events. |
| Attribution audit (12 Oct 2026) | `attributionAudit`, `scripts/audit_attribution.mjs` | Fourteen checks that every attribution rule in ATTRIBUTION.md holds in what the site computed: credit window, not won elsewhere, tag evidence, default rule, no lists, no back-tags, upsells apart, wins checked against Stripe, wins window, totals, Lead Counts agreement, Sales equals Events, upsells not also new, upsell baseline. Runs in GitHub on every push (validate-data workflow), on the Events tab, and by hand. The Sales tab now reads the funnel's classified leads and wins, so it and the Events tab count the same 700 leads. |
| Payback projection and its 80% range (12 Oct 2026) | `eventReports` payback, `projectionBand`, `multiLineChart` bands | The dashed projection never assumes revenue grows: the change a month used is the lower of zero and the event's blended own and book rate (shown as measured, not assumed to continue). The shaded band is the 5th to 95th percentile of 500 seeded runs (widened 12 Oct 2026). In each run every live customer stays or leaves month by month at the book survival curve raised to the event's churn hazard (the hazard scaled each run by exp(N(0, 1/sqrt(churns behind it)))), and may downgrade or upgrade each month with the chance and size the book's customers showed over the last twelve months (`bookPlanChanges`: a downgrade in 2.5% of months, 36% off on average). Upgrades are thinned so the run's average monthly change is the projection's, never above zero. The 12-month ROI KPI carries the range while it is projected, and the note says in what share of runs the event pays back within 36 months. |
| Provisional payback, and one-off charges not projected (12 Oct 2026) | `eventReports` payback (`provisional`, `recurringShareOf`) | An event whose cost is still settling gets its money-back curve and projection on its own page, marked provisional, and stays out of the ranking, payback table and counts until the cost settles. The projection's monthly rate is each customer's median of its last three months of contribution, scaled to the recurring share of each month's revenue: a one-off charge such as a setup fee is received once and never projected forward (Home Service Hoorah 2026's only customer: $2,500 a month plus $1,005 once). |
| Event audit fixes (12 Oct 2026) | `mrrGoingInto`, `companyKey`, `eventRoi` paid | A company paying in any of the three months before an event is a customer going in (one skipped month no longer makes it a former customer, so its event form is an upsell lead, not a new win; Summit Roofing, HSF 2025). An event counts a company once across both Stripe environments (Sierra Pacific, Lennox Live Anaheim 2026), and keeps all its Stripe revenue. Audit check `credit-company-once` added. |
| Sales KPIs (12 Oct 2026) | `salesReport` totals, pairing, setters, owners | On the event leads the Events tab counts: a set is a lead with a setter recorded; a show is a set whose deal exists (HubSpot opens one only once a demo is sat); a sale is a won deal Stripe agrees with, inside the win window. Per setter: sets, shows, sales, close rate of shows, and the win rate when they also owned the demo against when another deal owner took it. Per salesperson (deal owner, the only AE proxy): demos, sales, close rate, Stripe MRR sold (what Stripe first billed each won customer, matched by company name), the deal amount as an estimate, and win rate by who set the lead (themselves, a setter, none recorded). The Events tab's booked, sat and won totals are now the sums of its event rows, undated events included, so both tabs read 59 sales; the audit checks it. The all-sources Setters table gains a totals row. |
| HubSpot users who have left (12 Oct 2026) | `HUBSPOT_USER_NAMES`, the loader's `person` | A deactivated HubSpot user arrives as a bare id or "user <id> (no longer active)"; the loader maps a known id to the person before anything groups by name, so their deals, sets and the same-person comparison are one line with the rest of their work. 629850185 is Parker Joos, a salesperson who has left (Josh): 113 event demos, 29 sales. Seven more inactive users are named (Josh, 13 Oct 2026): Danielle Cheesman, Jackson Tolman, James Goff, Nick Bright, Benjamin Clawson, Glenn Dickman and Tavi Carvajal, then Jared Walker, Chelsea Allred, Jared Hunsaker and Mike Harper. |
| Won-deal fallback and the event audit table (13 Oct 2026) | `eventRoi` (sourceOf fallback), `eventAuditRows`, `renderEventAudit` | A customer whose earliest-relationship event cannot credit them (first paid outside its window) and whose won deal names another dated event, inside that event's window, is credited to that event as direct (Bacon Plumbing: Nexstar 2025 first, won by a Lennox Live New Orleans 2026 deal). Found by comparing every won deal HubSpot tags to an event in the year to September 2026 with the site's credit: 47 of 62 credited to the same event, 13 not credited for a stated rule. The Events tab's Event audit table checks every past event in one row, with a Last 12 months button. |
| Sales by quarter, and events attended without lead capture (13 Oct 2026) | `salesReport` byQuarter, `renderSalesQuarters`, `EVENT_META` presence/conflict/eventDate | Per person per quarter on event leads: sets (a setter recorded, dated by the later of the lead's arrival and its event), shows (their sets reaching a demo), demos completed as deal owner and sales (dated by when the deal opened; the leads carry no booking or close date), and Stripe MRR first billed. A quarter picker opens on this quarter with Ryan Peterson's sets and shows as the headline (Josh), an every-quarter grid, and CSV downloads for one quarter or all. Setters and salespeople tables gain totals rows. Goettl Training, the HCS Marketing Summit and Lennox Live Roadshow are attended or speaking events with no lead capture (planning sheet), dated, so no leads is expected; Redwood Leadership Summit is dated and keeps QuickBooks' $10,000 with the conflict against the sheet's registration only said in the audit. |
| Events summary tab (13 Oct 2026) | `eventsOverview`, `renderSummary` | The executive's first look, #summary: over the last 12 months or every event, the events' spend, contribution earned back, net and return on cost so far, the 12-month return (actual where an event is a year old, projected with its 90% range where not, events still settling included), new customers and the MRR still paying, cost per new customer against the company's (acquisition cost over new logos, same months), how many events have paid for themselves and how many are on track within a year; spend against contribution cumulative by month; the lead, demo and sale funnel; the five best and worst events by net; each kind of event; and what is committed next. Every figure sums the Events tab's own event figures. |
| Event page headline cards (13 Oct 2026) | `renderEventPage` headCards | Five cards head every event page (Josh): Total cost (fee and travel, settling or committed said); Demos booked (the event's counted leads that booked through its meetings link, have a setter, or reached a deal; how many sat beneath); Closed deals (customers Stripe confirms the event won, so it agrees with Revenue; beneath, how many its own deal closed, won deals not billed yet, and lost); Revenue (net cash Stripe collected from them since the event, and MRR now); ROI to date (on contribution, after the cost to serve). The other figures follow in a smaller row. |
| Proof of cost on event pages (13 Oct 2026) | `scripts/build_event_cost_lines.py`, `site/event_cost_lines.json`, `costProofPanel` | Each event page shows the fee as the Event Hub records it (with payment status) and every Ramp card charge the month-end cost run matched to the event, grouped by cardholder and in date order, each with merchant, label, city, amount, confidence and why it was matched, plus the charges reviewed and not counted. Both tie out against the fee and travel the event is charged here. Built from CHIIRP Event Costs.xlsx by the script; it is the site's own file, not a pipeline tab. Shown publicly with names (Josh, 13 Oct 2026). Covers events from 26 Aug 2026; earlier events need their attendees from the Event Hub, then a Ramp export. |
| Deal attribution only switch (13 Oct 2026) | `eventRoi` creditRule `deal`, `eventsOverview` creditRule, `dealOnlyNow`/`eventCreditRule` | One switch on the Events tab, each event page and the Events summary (Josh): credit an event only with customers whose won deal names it, last touch on the deal, whatever the contact or company was tagged and with no window. Kept in the browser so it holds across pages; it greys out the credit rule picker while on. In the year to September 2026 it moves one customer of 50 out of the summary (12-month return −19% to −21%); by event, HSF 2025 gains 3 and Nexstar 2025 loses 2. |
| Proof of cost for events before the Event Hub (13 Oct 2026) | `scripts/build_event_cost_lines.py` older(), `costProofPanel` feeLines | Events from Sep 2025 to May 2026 get the same proof from a second workbook, CHIIRP Event Costs 2025-26 (QuickBooks).xlsx: every 6100-07 Tradeshows & Events bill as the fee (vendor, date, number, the month it was expensed), and every travel charge on any company card (Ramp, Divvy, the company Chase card) from the QuickBooks travel accounts, matched to the event by attendee (2026 Events/Travel planning sheet), travel window and, for Ramp charges, the merchant city from the Ramp export. 26 of the fees tie to the site; BDR Spark (17,900 billed against 17,500), Pantheon 2025 (a 1,616 late graphics bill) and Network ST (3,660 of Australia event costs against none) do not. $51.7k of Sep-Oct 2025 flights and hotels were booked through TravelPerk with no traveller named, so they sit in review until a TravelPerk trip report names them; Blue Sky and The Huge precede the QuickBooks detail. |
| Fees settled from the bills, Hoorah 2026 travel and wins (13 Oct 2026) | `EVENT_FEE_DECISIONS`, `EVENT_TRAVEL_DECISIONS`, `reengaged`, event page Closed deals card | Pantheon 2025 $31,616.25 (adds Shepard's $1,616.25 late graphics bill), Network ST $3,660 (Home First Services' Australia event costs, taken off the unassigned list) and BDR Spark 2026 $17,900 (the bill), each applied only while the Event Costs tab still carries the old figure. Home Service Hoorah 2026 travel is $2,360.45: Ryan Fenn's $3,451.73 is off it (Josh: he did not go), on the cost and in its proof. A won deal tagged to an event and opened in the 45 days before it now counts as re-engaged (Riverstone Plumbing, Hoorah 2026; Bold City Heating and Air, Pantheon 2026, the only other). The Closed deals card counts every deal won in HubSpot that counts for the event, billed in Stripe or not yet; Revenue stays Stripe's. |
| Event audit against HubSpot and the cards (13 Oct 2026) | `HUBSPOT_WON_DEAL_LINKS`, `eventRoi` won-deal fallback, `build_event_cost_lines.py` older() via match rules | A live check of all 136 won deals tagged to an event since Jul 2025 against each event page's Closed deals. 11 won deals HubSpot links to a Stripe customer were missing from the push; they are linked on the site until it carries them, which credits Pinnacle Roofing and Control Tech to HSF 2025. The won-deal fallback now moves a customer to the event their won deal names whenever that event can credit them, not only when the tag's event cannot (otherwise the default rule credited them nowhere). The rest differ for stated reasons: deals closed before the event (eight HSF 2025 deals closed Jul-Aug 2025), cancellations and upsells, first payment more than six months on, a partner or webinar that came first keeps the credit, or no Stripe payment yet. Card charges: a memo that names an event now decides it, whoever's card paid, and hotels Alicia Schmaling booked for the team count for the next event in the hotel's city and follow the event their other bookings at that hotel name; her fares with no event in the memo wait in review. |
| Won leads matched to Stripe (13 Oct 2026) | `buildStripeMatch`, `HUBSPOT_COMPANY_STRIPE` | Event Leads carries no Stripe id (brief item 14), so leads meet Stripe by company name. Of 63 won event leads, 40 matched; now 54 do, every one with a paying Stripe account: names compared without spaces (TemperaturePro / Temperature Pro Kalamazoo), a shorter Stripe name the HubSpot name starts with (Aether Mechanical), one business under the same name in two Stripe accounts read as one (Sierra Pacific), and, where the names differ outright, the Stripe account on the HubSpot company record from a live check (Tuckers, Doornbos, First Class Heating & Air, PlumbingPro Austin, Outdoor Lighting Perspectives). The other 9 won but have never paid in Stripe (Bold City, Riverstone, Opus, Luxor, Midway, LGM, Big Time Roofing, Charlotte Plumbing, Lamar). Closed deals no longer counts a billed customer twice when its lead failed to match. |
| Travel set to the proven card charges on three events (13 Oct 2026) | `EVENT_TRAVEL_DECISIONS`, event page cost notes | Josh: where the proof finds more than the Event Costs tab, use the proof. Hardi $5,148.70 (tab $2,835; includes the $3,916.16 Wynn booking Alicia Schmaling made), Goettl Training $4,385.40 (tab $2,485; her flights and Tempe rooms for the team), RynoX 2026 $3,897.96 (tab $2,850; Garret Clarke added). Each applies only while the tab still carries the old figure, and the event page says so. Events where the proof finds less keep the tab's figure until the fares in review are placed. |
| Travel set to the proof on 17 events, by judgement (13 Oct 2026) | `EVENT_TRAVEL_DECISIONS`, match rules (judged charges, home-airport parking) | Josh: use your judgement. 30 reviewed charges were placed by judgement, each marked 'judgement' with its reason and a Low or Medium confidence on the event page (Alicia Schmaling's December fares by airline and timing, Tavi Carvajal's two Redwood fares, Blake Fenn's October fares and Charleston rooms, hotel charges just outside a window in the event's own place); home-airport parking (Salt Lake City, Provo, San Jose) counts in the window. Travel is then the proof for every event from Nov 2025 whose proof reaches 80% of the Event Costs tab or more, and for Legacy and Network ST, where the proof is above the tab: 17 events, replacing the three set earlier. Sep-Oct 2025 events otherwise keep the tab (TravelPerk), as do BCSG 2025, WinSupply and Raising GOATS, whose flights are on no card. The 12-month return on the Events summary moves from -19% to -23%. |
| Setters named on event forms; audit stops flagging empty fields (13 Oct 2026) | `setterNamedIn`, `setterOf`, `salesReport`, `eventAuditRows` | Where HubSpot records no setter, the rep an event form names ("Form: BDR - Spark - 2026 (Ky Decker)", "Stan Wesemann's Demo Scheduling Form") is the setter when a deal followed: checked against 267 leads with both, the form's rep is the recorded setter 246 times. Personal meetings links are not used: their owner gave the demo (26 of 26) and set it 4 times in 26. Today every form-named lead with a deal already has its setter, so the counts are unchanged; the rule fills future gaps. Josh: if a field is empty and the context doesn't help, don't flag it, so the audit no longer lists a low setter share or a credited customer with no Event Leads row. The Lennox Premier day is recorded as attended, free, with no lead capture. |
| Qualified Remodeler Top 500 2026 fee (13 Oct 2026) | `EVENT_FEE_DECISIONS` | $20,000 from SOLA Group's Gold Sponsorship bill for October 2026 (19 Aug 2026); SOLA publishes Qualified Remodeler. The tab had no fee. SOLA's $10,000 of sponsorship media stays on the unassigned list. |
| TravelPerk trips placed by traveller, route and dates (14 Oct 2026) | `build_event_cost_lines.py` (QuickBooks workbook), `EVENT_TRAVEL_DECISIONS` | The TravelPerk report (TravelPerk 2025 Expenses.csv, 243 rows, 62 trips, $49,475, 15 Aug to 24 Dec 2025) names each booking's travellers, route and travel dates. Every trip is placed by who went where and when, and replaces the QuickBooks TRAVELPERK lines, which named only the booker: $48,440 to 19 events, $1,034 not an event's (Lani Fenn's Las Vegas flight during HSF, a cancelled booking, Colton Lingmann's Oklahoma City trip in late October, TravelPerk's fees). It adds attendees the planning sheet missed: Justin Judd at LB Roofing and Hardi, Ryan Peterson at Clover; Devon Maresco flew to HSF. Alicia Schmaling's 2 Dec 2025 Delta fare, judged to be LB Roofing's, is not (the TravelPerk flights were booked in October) and is back in review. Travel is the proof for every event from Sep 2025 whose proof reaches 80% of the Event Costs tab: 29 events. HSF 2025, Nexstar 2025, Wealthy Plumber 2025, Service World and Raising GOATS keep the tab, as do Blue Sky and The Huge (before the QuickBooks detail). |
| Estimates where no record exists (14 Oct 2026) | `EVENT_TRAVEL_DECISIONS` (estimate: true, was: null for a blank tab), `EVENT_FEE_DECISIONS` | Josh: if the information doesn't exist, estimate. A missing piece of a trip is priced at the median of the 29 trips proven in full: $662 a return flight, $260 a hotel night, $97 a person a day for meals and ground (25th to 75th percentile gives the range). Where the tab's travel falls outside that range the estimate replaces it: Nexstar 2025 $5,358 (tab $7,669; Ryan Peterson's and Korth Rushdi's hotels), Wealthy Plumber 2025 $3,960 (tab $5,312; Parker's and Ky's hotels), Service World $6,288 (tab $4,606; three hotel stays), Raising GOATS $1,839 (tab $1,547; Ryan Fenn's flight). HSF 2025's $12,270 is inside its range and stays; Blue Sky and The Huge keep the tab, the only record. Upcoming events get committed travel from what is booked plus the medians (CertainPath Connect $5,565, QR Top 500 $6,932, HSF 2026 $6,713, Table of Titans $3,466) or a guess (Build it to Sell it $3,466, EGIA Epic 2027 $3,153), and fees where none is recorded: CertainPath Connect $0 (the Event Hub says the sponsorship is covered), EGIA Epic 2027 $16,445 (the 2026 price), Build it to Sell it $10,000 (a guess, the middle 2026 fee). Every one is labelled an estimate or a guess on its page. TravelPerk travellers Gustavo Carvajal and Richard Stanley Wesemann are Tavi Carvajal and Stan Wesemann. |
| Pending charges for events not yet held (14 Oct 2026) | `build_event_cost_lines.py` (pending, upcoming), `costProofPanel` | Josh: some events have not happened yet, so list their charges as pending. A charge the month-end run puts on the review tab as "upcoming" for an event (named in full or by its first two words) and every charge matched to an event whose start is still ahead are listed on the event as pending: who paid, merchant, label, city, amount and why, with a pending total against the event's expected or estimated travel, not tied out as its cost. Today: Qualified Remodeler Top 500, two Caesars Palace deposits ($451.26); CertainPath Connect, two Hilton Cancun prepayments ($2,628). Where the Event Hub has no fee, the panel shows the fee the site uses and says where it came from. |
| Event page rates row (14 Oct 2026) | `renderEventPage` rateCards | Under the five headline cards (Josh): cost per demo (total cost over demos booked), cost per closed deal (total cost over closed deals, billed or won and not billed yet), booked to won (closed deals over demos booked, and over demos sat), ROI now (on contribution, months since the event's date) and 12-month ROI (twelve months from the event's date, actual or projected with its likely range). The 12-month ROI card moves here from the lower row. |
| Events summary rates row (14 Oct 2026) | `eventCardFigures`, `eventsOverview` rates, `renderSummary` | The event pages' rates row over every event in the range: cost per demo, cost per closed deal, booked to won (and of demos sat), ROI now and 12-month ROI, each event counted from its own date. The event page and the summary count demos and closed deals with one function, so they always agree. |
| Wealthy Contractor ACC 2027 (19 Oct 2026) | `EVENT_EXTRA_COSTS`, `EVENT_META`, `EVENT_TRAVEL_DECISIONS` | Found in the 19 Oct QuickBooks Transaction Detail export: a 2 Oct 2026 bill from The Wealthy Contractor Inc. for a Gold annual sponsorship of ACC27, $29,950, deferred to Feb 2027. Added as an upcoming event with that fee and a guessed $3,466 of travel until its dates and attendees are known. The same export's September tie-out showed the 19 Oct push still carries September before the close ($114,865 against QuickBooks' $1,508,853), so September stays estimated until a push carries the close. |
| September 2026 closed and tied (19 Oct 2026) | `RECONCILIATION.md`, page text | Push v176 carries QuickBooks' September close: $1,508,853 across the P&L accounts, every one of 85 accounts tying to a Transaction Detail export of 1 Sep-19 Oct 2026, 6100-07 $28,614. The site's September estimate switched itself off. The same push re-closes August: the $844,849 revenue clearing balance moves into the revenue accounts and affiliate marketing falls from $112,360 to $42,512 as its revenue-share credit posts. Tied over Sep 2025 to Sep 2026 (two exports merged, September from the newer): 1,098 of 1,107 account-months tie; the nine that do not are reclassifications booked after the older export, net $5,675, $4,617 of it interest income no figure uses. The page's tie-out wording and the revenue-share notes are updated to match. |
| HubSpot wins with no lead row (19 Oct 2026) | `HUBSPOT_EVENT_WINS`, `eventCardFigures` | A won deal tagged to an event whose company has no Event Leads row and no Stripe payment yet is on no event. From a live check: Mac 5 Services, a 2026 - Pantheon deal won 15 Oct 2026 ($2,300), whose contact carries no event tag. Counted on Pantheon 2026's Closed deals as won and not billed, matched on the exact source, until Event Leads or Stripe carries it. |
| Events still ahead have no leads yet (19 Oct 2026) | `eventLeads` (ahead, taggedAhead), event page Leads panel, ranking cost cell, `EVENT_META` | Josh: Home Service Freedom 2026 showed 82 new leads a week before it ran. Every one of its 173 tagged contacts predates it (50 were created around HSF 2025, 92 came from a list): an event still ahead was read on earned contacts. It now has no new leads until its date; contacts tagged before it show apart as "tagged ahead of it". The ranking's cost cell shows the lead count beside cost per lead (CCN: 10 new leads, $1,115 each), which read as no leads at $1,115 a lead. CCN Elevate, Dirty Dozen and QR Top 500 get a type and organiser. |
| Consistency audit across views (19 Oct 2026) | `renderEventPage`, payback roi, `eventCardFigures` wonFromDemos, `EVENT_TRAVEL_DECISIONS` kept | Josh: we had these mistakes, find the others. A cross-check of every event's figures found five kinds: (1) an event held after the last month of revenue data read as upcoming (Pantheon 2026, 5 Oct: "happens Oct '26"), now "held Oct 5; revenue shows with October's data"; (2) ROI now and 12-month ROI read -100% for events under three months old with no customer yet (CCN, Dirty Dozen, Nexstar 2026, Grosso), now blank and "too early", which also takes them out of the summary's 12-month return; (3) booked to won passed 100% (Network ST 4 of 3) because closed deals include customers credited on the tag with no demo, now wins through a booked demo over demos booked, with the rest said beside it; (4) two new-lead counts on one page (Nexstar 2026: 8 in the Leads panel, 5 in the headline), now the rules' count throughout with the pipeline's said beside it; (5) travel kept at the tab with no reason given where the proof is partial (HSF 2025, Blue Sky, The Huge), now explained. Held events' pending deposits say they await the month-end run. |
| No guessed fees for future events (20 Oct 2026) | `EVENT_FEE_DECISIONS`, `EVENT_TRAVEL_DECISIONS`, event cost card, Events summary committed | Josh: show it as fee unknown, and do the same for future events. An upcoming event's fee comes only from the Event Costs tab, the Event Hub or a bill; with none it reads "fee unknown" and adds nothing to committed. Travel is estimated only where someone is listed as going; otherwise it is unknown too. Build it to Sell it 2026 and EGIA Epic 2027 (fee and travel) and Wealthy Contractor ACC 2027 (travel) drop their guesses. |
| Guard against guessed costs for future events (20 Oct 2026) | `eventRoi` costRows (ahead), `attributionAudit` no-guess-ahead, ATTRIBUTION.md 1.3.7, EVENT_COSTS_MONTHLY.md | Josh: audit the workflow so it doesn't apply a guess to future events again. For an event past the last month of data the code ignores any guessed fee decision (estimate or weak) and any travel estimate that names no confirmed attendees; the three upcoming travel estimates that stay name their attendees. The audit's sixteenth check, no-guess-ahead, fails if a future event carries a guess or one is put on file, tested by planting both kinds. Table of Titans 2027 drops its travel estimate (its two names are not registered). The monthly cost runbook says to record only what exists for future events. |
| New leads, sat, won: no booked stage (20 Oct 2026) | `eventCardFigures` (leads, wonFromLeads), event page cards, Events summary, Events tab funnel tables, lead states | Josh: demos booked should be all the event's contacts; new leads and booked are the same, so the funnel is new leads, then sat, then won. HubSpot opens a deal only once a demo is held, so "booked" was a setter field, not a booking. The Demos booked card is now New leads (sat and won beneath); Cost per demo is Cost per lead; Booked to won is Lead to won (won from new leads over new leads, with the rate of those sat and the wins that were not new leads said beside it). The Booked columns leave both funnel tables; a lead with no deal reads "not sat yet". Last 12 months: $1,000 a new lead, 8% lead to won, 24% of those sat. |
| Won equals Closed deals (20 Oct 2026) | `eventCardFigures` (leads, demosSat, wonOutsideLeads), event cards, Events summary, audit funnel-ends-on-closed | Josh: closed deals should be the same as won deals. CertainPath Spring Expo read 1 won (from new leads) and 2 closed: Edison Electric was won by the event's deal from a contact HubSpot already held. Every company the event wins now counts in its leads and sat, as an existing contact won, so the funnel ends on Closed deals: CertainPath 14 leads (13 new + 1), 3 sat, 2 won = 2 closed. The seventeenth audit check holds it on every event. Last 12 months: 425 leads (24 existing contacts won), 150 sat, 55 won, 13% lead to won, $944 a lead. |
| Event page as a report, template 1 (20 Oct 2026) | `eventCustomerLedger`, `eventStaying`, `eventCardFigures` (wonLeads, notBilledRows, by company), `renderEventPage`, `eventsOverview` (origins, ways, ledgerRows), Events summary | Josh chose template 1. Each event page now runs headline, rates (ROI now moves to the headline; Still paying joins the rates), the funnel leads to sat to won with known prospects shaded, the customers credited with origin, first paid and end date (Stripe's subscription end, else the last month paid), the contribution curve above a month-by-month payment grid with a running total against the cost, upsells as before-and-after bars, what sits beside the return, and four charts: origin, months to first payment, how the leads arrived, and whether the customers stay against the book at the same ages. The leads list, cost proof per cardholder and how-we-count are folded. Counting fix: a company with an account in each Stripe environment (Sierra Pacific, Lennox Live Anaheim 2026) had added a phantom known prospect to leads and sat; wins are now counted by company. The Events summary's funnel now uses the same leads, sat and won as the pages, and adds origin by event plus pooled arrival methods and staying. Last 12 months: event customers 64% still paying against 77% for the whole book at the same ages. |
| Funnel adds up; upsells are leads (20 Oct 2026) | `eventCardFigures` satSplit (closedLost, stillOpen, demosSat), event page funnel, `eventUpsellPanel` | Josh: the sat numbers did not add up with the bars; use churned for churned customers and lost on sat; an upsell through the event is only a lead. Every demo sat now ends in exactly one place: won (still paying, churned, or not billed yet), lost, still open, another contact at a company it won (sat counts contacts, won counts companies), won through another source, or won after the window. The Won row draws those parts, so it sums to Sat, and the Sat row's grey is the leads that did not sit, so it sums to Leads (HSF 2025: 97 sat = 35 won + 60 lost + 2 second contacts). The Upsells panel is now Upsell leads: an existing customer coming in through the event is a lead, not a win, and the panel says no upsell was won unless the MRR rose; bars only where an MRR moved. The duplicate upsell fact leaves Beside the return; the rule moves to How we count. |
