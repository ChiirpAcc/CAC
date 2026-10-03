# The metric set

What the business is measured on beyond LTV:CAC, each one defined once, with
the chart that draws it and the function that computes it. Written for the
Q4 2026 unit economics work: the metric list the price-increase round and the
2027 budget read from.

Three rules hold for every line below.

- **One implementation.** A metric is computed in one function in
  `site/data.js` and every chart that quotes it calls that function. If two
  charts need the same number they share the code, not the answer.
- **The ledger is the ledger.** Every cost figure is a sum of rows in
  `data/qb_expenses.json`, which `scripts/reconcile_ledger.py` ties to a
  QuickBooks export account by account and month by month
  (see `RECONCILIATION.md`). Where a site figure disagrees with QuickBooks,
  QuickBooks is right.
- **Blank is blank.** A month with no measurement is null and plots as a gap.
  A cohort that has not recovered its cost has no payback number, not zero.

Vocabulary is the page's: S1 and S2 are the two Stripe environments and one
customer relationship. A logo is an account present in a month; a paying logo
carried subscription revenue that month. A cohort is the month an account
first carried revenue. Pass-through is 10DLC and carrier fees collected on a
customer's behalf.

## 1. Acquisition

| Metric | Definition | Chart | Function |
|---|---|---|---|
| **Acquisition cost per new logo** | Acquisition spend in the month, divided by new logos that month. Spend is every 6100 line except revenue share, plus every 6150 payroll line except Customer Success (6150-3): Customer Success at 0% and Partnerships at 100%, settled. One rule, `isAcquisition`, and every chart that divides by a cost per logo goes through it. | 26, 27 | `acquisitionCosts`, `costRates`, `isAcquisition` |
| **Payback, months** | Age at which a cohort's cumulative gross profit crosses what it cost to acquire. Null until it does. | 2, 17 | `projectedBreakEven` |
| **Cost recovered at age six** | Share of a cohort's acquisition cost returned by month six, on measured cost of sales. A share rather than a multiple, because a healthy cohort at six months is legitimately below one. | 33 | `costRecovery`, `fullCostRecovery` |
| **LTV:CAC at equal age** | Every cohort cut at the same age so an older cohort is not credited for having had longer. Cohorts short of the age are projected and drawn hatched. | 1 | `ltvAtAge` |

Acquisition divides by **new** logos and nothing else on this list does. The
per-logo figures on charts 26 and 27 are not comparable with any per-logo
figure below.

## 2. Retention and churn

| Metric | Definition | Chart | Function |
|---|---|---|---|
| **Monthly logo churn** | Accounts live last month and not this month, over accounts live last month. Presence-based, so a late payment that leaves a zero month does not count as a departure. | 5, 10 | `departures` |
| **Churn by tenure** | The same rate with the book cut at three, six and twelve months of age. Describes the standing book, not an intake. | 31 | `churnByTenure` |
| **Logo retention at 3, 6, 12 months** | Share of a cohort still live at each age. A cohort is plotted only once that age is behind it. | 6, 8 | `retentionAtAge`, `retentionByYear` |
| **Gross revenue retention** | Revenue still arriving from a cohort at 3, 6, 9, 12 and 18 months as a share of its starting revenue. Starting revenue is each customer's second month, because the first carried the joining charge until mid-2025, and each customer is capped at what they started on so expansion cannot lift a cohort back over its own base. | 44, 45 | `cohortRevenueRetention`, `revenueRetentionAtAges` |
| **Net revenue retention** | The same with expansion left in. Reported beside the gross figure, never instead of it. | 44, 45 | same |
| **Zero-MRR share** | Live logos carrying no subscription this month, as a share of live logos. The gap between the logo and revenue retention curves. | 32 | `zeroMrrShare` |
| **Past due share** | Live logos whose Stripe status is past due or unpaid. Starts at the first month the push carries a status at all. | 43 | `pastDueTrend` |

### The one churn number for the executive board

**Monthly logo churn, trailing three months, from chart 5.** Departures over
the opening base, averaged across the last three complete months. Stated
with the gross revenue retention at twelve months beside it, from chart 45,
so a reader sees both the count leaving and the money leaving.

Three months rather than one because a single month moves by a point on
noise alone; trailing rather than calendar quarter so it is the same
measure in every board pack. Logo rather than revenue as the headline because
the cost side divides by logos and the two have to be read together. This
is a proposal, shown under the page stamp as "Board churn number (proposed)" and
computed on every load, so agreeing it is a decision, not a build.

## 3. Revenue per account

| Metric | Definition | Chart | Function |
|---|---|---|---|
| **Average revenue per paying account** | Everything a live, previously paying account pays in a month (subscription, usage, one-off, pass-through) over paying logos. Subscription only is carried beside it, never swapped for it: comparing a full cost base against subscription alone understates revenue by about a tenth, which is most of the margin. | 28, 39 | `costToServe`, `ongoingCostPerLogo` |
| **Price at signup** | Starting subscription for each new cohort, with the volume that came in at that price. | 13, 16 | `signupEconomics`, `signupPriceHistory` |
| **Price band return** | What each starting price band returned, age-matched. | 14 | `priceBands` |

## 4. Cost to serve

| Metric | Definition | Chart | Function |
|---|---|---|---|
| **Cost to keep one paying customer, by layer** | The month's spend in five layers over paying logos: platform (5000-02, 5000-03), people (5050 and the split customer-facing lines), variable (merchant fees 5000-04 and revenue share 6100-06), G&A (6200, 8000), R&D (6300). Acquisition is absent; it belongs to the cohort that caused it. | 39 | `ongoingCostPerLogo`, `serveSpend` |
| **Cost to keep each account, by month, S1 and S2** | The same five layers spread per account. Platform, people, G&A and R&D per paying logo, exactly as chart 39 divides them; variable at the month's rate on the account's own revenue. Summing the accounts in a month returns chart 39's figure for every layer. | 49 | `accountServeCost`, `serveSpend` |
| **Contribution per account** | What the account paid, less its platform, people and variable cost. Loaded contribution also takes G&A. R&D is carried in the download and in neither, because charging tomorrow's product to today's customers concludes that a company investing in product has worse unit economics than one that is not. | 49 | `accountServeCost` |
| **Accounts under water** | Paying accounts whose contribution is below zero, counted in the month and across the last six months, so one odd month cannot put an account on the list. | 49 | `accountServeCost`. The Upgrade list tab does not use it: `upgradeList` selects on price, under $500, not on contribution |
| **Platform margin, measured** | All revenue less cost of sales, less 60% of usage and 90% of one-time revenue, over platform revenue, solved month by month from the ledger so the class margins and the whole book add up to what the ledger says. It runs between 0.45 and 0.66 across the window; the flat 75.7% it replaces is kept as a named fallback for a push with no ledger. | 28 | `platformMargins` |
| **The ledger** | Every cost line by account for the last six months, in the layers above. Every other cost figure on the page is a sum of some subset of these rows. | 40, 41 | `costLedger` |

## 5. Price floors

| Metric | Definition | Chart | Function |
|---|---|---|---|
| **Marginal floor** | What one more or one fewer customer changes: licence, hosting, merchant fee and revenue share. The line for deciding whether to keep an individual account. | 37 | `priceFloors` |
| **Serve floor** | Platform plus support and success, per paying logo, grossed up for the variable rate. What a customer has to pay to be worth keeping as a customer. | 37 | `priceFloors` |
| **Allocated floor** | Every fixed cost except R&D spread over paying logos, grossed up. The line for pricing new business and for setting a discount limit. | 37, 38 | `priceFloors`, `repriceOutcomes` |
| **Fully loaded floor** | The allocated floor with R&D put back. Shown so a reader can choose to charge for it. | 37 | `priceFloors` |

All four are medians over the last six months rather than means, because the
ledger books an invoice and its credit note in different months and a mean
over a window that closes between them counts the charge and never the
reversal. The months that trip that rule are reported, not smoothed.

## 5a. Events

| Metric | Definition | Chart | Function |
|---|---|---|---|
| **Event cost** | Sponsorship plus travel for one event. Sponsorship is what QuickBooks booked where it differs from the Event Costs tab; a fee that paid for several events is split equally across them and also reported as a package. | Events tab | `eventRoi`, `EVENT_FEES_QB`, `EVENT_PACKAGES` |
| **Event return** | For customers whose HubSpot lead source names the event: net cash collected since the window opened, and contribution on chart 49's basis. Net of cost is contribution less event cost. Sourcing, not the partnerships 60-day attribution, and tagged customers only. | Events tab | `eventRoi` |

## 6. Forward

| Metric | Definition | Chart | Function |
|---|---|---|---|
| **Book, revenue and cash twelve months out** | Cohort roll-forward with age-specific survival, backtested on every load. | 34, 35, 36 | `projectBase`, `arrivalScenarios` |
| **Revenue against every lever** | The book on the shelf decaying along chart 44's curve and new business along chart 46's, under chosen churn, arrival and price settings. | 47 | `leverProjection` |
| **Cost twelve months out** | The seven cost groups of chart 33 carried forward on what actually moves each one, with the payroll lines held flat or scaled with revenue. Contribution is recurring revenue less all cash costs. | 48 | `costForecast` |

## What is not on the list, and why

- **Anything from HubSpot, except one field.** The Events tab reads the
  HubSpot lead source the pipeline matches to Stripe (v120), to say which
  customers an event brought. Nothing else on the page uses HubSpot.
- **A cost per account by CSM.** There is no assignment per account in the
  data, so people cost is spread evenly. The day the pipeline carries an
  owner, chart 49 can divide the people layer by it without changing
  anything else.
- **Sales cycle length.** The cost per logo assumes a month of selling
  precedes the month of starting. Untested, and stated on the page.
- **Churn by reason.** Stripe records a cancellation, not why.

## Where the inputs come from

```
Stripe S1, S2  ─┐
                ├─► Sigma ─► workbook pipeline ─► data/*.json ─► site
QuickBooks P&L ─┘             (Apps Script)       (by commit)
```

A push lands as one commit per tab and redeploys the site; nothing here is
refreshed by hand. `scripts/validate_data.py` runs on every push and
`scripts/reconcile_ledger.py` runs on demand against a QuickBooks export,
which is the one manual step and is a check rather than an input.
