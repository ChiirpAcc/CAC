# Working in this repository

The site is the only place this analysis exists. The workbook that used to
carry it is a pipeline now, with about 2,600 lines of charts and cohort
logic removed, because building it twice meant two implementations drifting
apart and the one nobody looked at was the one that stayed wrong.

That is the governing constraint here. Anything computed twice will disagree
eventually, and it will disagree quietly.

## Rules that are not negotiable

**Months are strings, `YYYY-MM`.** Sheets parses an unprotected `2025-01` as
a date and hands it back as `2025-1` or `1/1/2025`. As text `2025-1` sorts
after `2025-10`, so cost months stop lining up with cohort months and every
per month comparison is wrong without looking wrong. Compare months as
strings; the format sorts correctly.

**Blank is `null`, never `0`.** A cohort that never recovered its cost has no
payback number. Zero plots as instant payback, which is the opposite of the
truth. Keep blanks blank from the push through to the chart, and break lines
at gaps rather than dropping them to the axis.

**One implementation of a number.** The page has already produced three
answers to what a logo costs and two to when a cohort paid back. If two
places need the same figure, one of them calls the other.

**Never chart a partial period.** Drop the trailing incomplete month before
computing anything. A forward looking window is only drawn once it has fully
elapsed, otherwise the most recent point is flattered by losses that have not
happened yet, which points the finding the wrong way.

## Vocabulary

Getting these wrong produces confident, wrong charts.

**S1 and S2** are two Stripe environments. A customer moving between them is
one continuous relationship, not a churn plus a new logo.

**Logo** is a business in the base, which is not the same as one that paid.
Billed and not collecting is lapsed, which is at risk rather than churned.
Never paid at all is a pending first bill failure, which is neither.

**Cohort** is grouped by the first month a customer carried revenue, not the
first month they appear. A signed customer can sit at zero for months.

**Left censored** describes a customer whose first observed month is the
first month of the data window. They existed before it and we cannot see
when, so they are excluded rather than dated to the boundary. A real Stripe
start date in `subscription_lifetimes.json` overrides that.

**Pass-through** is 10DLC carrier fees. They sit in revenue and in cost of
sales at once, so any margin applied to them credits profit that does not
exist.

**Recognised elsewhere** is a buyout or prepayment whose monthly value is
already carried by a couponed subscription. Counting both double counts.

## What is solid and what is not

The base count, the monthly flows and the retention curves hold whatever
anyone decides about cost allocation. LTV:CAC, payback and anything involving
margin do not.

The site makes this distinction visible rather than footnoting it, and that
is the most important thing about its design. Every chart carries what it
says, what it assumes and what it means, and the assumptions are the half
that stops a reader taking a number for a fact.

Realised is not projected. Gross profit on this page is what a cohort has
actually returned to date, so a young cohort sits low because it is young.
Cohorts under six months are withheld from the ratio charts for that reason,
and the charts say so on themselves.

## House style

Comments explain why, not what. If a line needs a comment to say what it
does, rename something instead. The comments worth writing are the ones that
record a decision somebody will otherwise undo: why a blank stays blank, why
a window is dropped, why two numbers that look interchangeable are not.

No em dashes.

Prose on the site is written for an operator rather than an analyst. Say the
finding, then say what would make it wrong.

## Before changing a chart

Check what else uses the number. Cost per logo, gross profit and payback are
each shared between at least two views, and the last three defects in this
repository were all the same shape: two implementations of one figure that
happened to agree until they did not.
