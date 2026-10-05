import {
  policySignals,
  load, buildCohorts, cohortEconomics,
  blendedRetention, retentionByYear, retentionAtAge, mean, monthDiff,
  monthAdd,
  forwardSurvival, correlate, projectedBreakEven, capacityAnalysis,
  seasonalSurvival,
  hasRevenueClasses, CLASS_MARGINS, LEGACY_PLATFORM_MARGIN, environmentSplit,
  signupEconomics, priceAgainstRetention,
  arrivalsAgainstChurn, departures, acquisitionCosts,
  ltvAtAge, signupPriceHistory, priceBands, projectionBasis, pricingScenarios, priceComparison,
  costToServe, costRecovery, churnByTenure, zeroMrrShare,
  fullCostRecovery, COST_GROUPS, REVENUE_GROUPS, platformMargins, costRates,
  projectBase, arrivalScenarios, priceFloors, repriceOutcomes, upgradeList,
  ongoingCostPerLogo, costLedger, neverPaidIds, accountServeCost, eventRoi, eventReports, EVENT_FEE_DECISIONS, WINBACK_GAP,
  eventLeads, marketingReport, MARKETING_CATEGORIES,
  EVENT_UNASSIGNED_QB, EVENT_UNCLASSIFIED, CHANNEL_SPEND, eventHasReturn,
  unclosedMonths,
  costCalculator, COST_LAYERS, LOGO_TYPES, CALC_PRESETS,
  campaign, CHURN_PRESETS, PRICING_PRESETS, ruleSpread,
  bandEconomics, bandCampaign, ENGAGEMENT, KNOWN_EVENTS, pastDueNow, revenueCheck,
  cohortRevenueRetention, revenueRetentionAtAges, windowRetentionCurve,
  leverProjection, CHURN_MODES, PROSPECT_MODES, SCENARIO_CARDS, costForecast, COST_BASES,
  silentLogos, logosStarted,
} from './data.js';
import {
  lineChart, multiLineChart, columnChart, stackedColumnChart, flowChart, scatterOverTime,
  scatterXY, dualAxisChart, barList, scatterBreakEven, fmt, INK,
} from './charts.js';

// Settled, and applied in the pipeline rather than here. Kept as named
// constants so a different decision stays a one line change: the controls are
// gone, the flexibility is not.
// margin here is the old flat assumption. It is kept as a named fallback for
// the case where no cost ledger has been pushed, and as the figure the page
// quotes when it explains what changed. Everything that can be measured is
// measured: see platformMargins.
const SETTLED = { csShare: 0, partnershipsShare: 1, margin: 0.757 };

// Filled at boot from the ledger, so a chart can say which basis it is on.
let MARGIN = null;

// First month the second environment appears, read from the data.
let S2_FIRST = '';


// Ranges quoted by calendar era, recomputed rather than written down.
//
// Both of these replaced sentences that were true when typed and silently
// false afterwards: a payback range that no longer matched any cohort, and a
// cost comparison between two endpoints that had converged until the sentence
// asserted a gap its own figures denied.
function byEra(rows, pick) {
  const eras = new Map();
  for (const row of rows) {
    const year = row.month.slice(0, 4);
    if (!eras.has(year)) eras.set(year, []);
    eras.get(year).push(pick(row));
  }
  return [...eras.entries()].sort();
}

function paybackByEra(recovered) {
  const eras = byEra(recovered.filter(c => c.payback !== null), c => c.payback);
  if (eras.length < 2) return 'Too few recovered cohorts to compare eras.';
  const part = eras.map(([year, v]) =>
    `${year} in ${Math.min(...v)} to ${Math.max(...v)}`).join(', ');
  return `Payback by the year a cohort started, counting only those that have recovered: ${part} months.`;
}

function costByEra(shown) {
  const eras = byEra(shown.filter(c => c.costPerLogo !== null), c => c.costPerLogo);
  if (eras.length < 2) return 'Too few cohorts to compare eras.';
  const avg = eras.map(([year, v]) => [year, v.reduce((s, x) => s + x, 0) / v.length]);
  const first = avg[0], last = avg[avg.length - 1];
  return `Cost per logo has risen across the eras shown, averaging `
    + `${fmt.money(first[1])} for ${first[0]} against ${fmt.money(last[1])} for ${last[0]}`
    + `, which is most of why the older cohorts sit higher.`;
}




// The hatched part of a bar is a model. These two sentences say which model
// and whether it can be trusted, because "projected" on its own invites a
// reader either to ignore the bar or to believe it, and neither is right.
function projectionNote(b) {
  if (!b || !b.donors) return null;
  // The share is a ratio of two small numbers and lands at or just over one,
  // so printing it as a percentage gives a precision it does not have.
  const share = b.churnShareOfDecay;
  const how = share === null ? ''
    : share >= 0.9 ? 'essentially all of that decay is'
    : `roughly ${fmt.pct(share, 0)} of that decay is`;
  return `The projection is a churn projection. It carries the pooled month-on-month revenue `
    + `path of the ${b.donors} cohorts with at least ${b.minMonths} months behind them, which `
    + `settles at ${(b.terminal * 100).toFixed(1)}% of the previous month`
    + (how
        ? `. Monthly survival across those donors is ${fmt.pct(b.donorSurvival, 1)}, so ${how} `
          + `customers leaving rather than survivors paying less: revenue per surviving customer `
          + `is roughly flat once the first month is past.`
        : '.')
    + ' The path is walked on recurring revenue, with the old joining charge taken out of '
    + 'each donor\'s month 0, so a cohort that never paid the charge is not handed the month-1 '
    + 'drop of one that did.';
}

// The margin chart 3 actually applies to the cohorts it draws, read from the
// same monthly figure buildCohorts uses rather than the flat assumption.
function recoveryMarginSentence(drawn) {
  if (!MARGIN || !MARGIN.measured) {
    return `Platform revenue is carried at the flat ${fmt.pct(SETTLED.margin, 1)} margin because `
      + 'no cost ledger was pushed to measure it from.';
  }
  const months = new Set();
  for (const c of drawn) {
    for (let k = 0; k <= c.maxOffset; k += 1) months.add(monthAdd(c.month, k));
  }
  const values = [...months].map(m => MARGIN.byMonth.get(m)).filter(v => v !== undefined);
  if (!values.length) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return `Platform revenue carries the margin measured in the month it was earned, `
    + `${fmt.pct(lo, 0)} to ${fmt.pct(hi, 0)} over the months these cohorts have lived, not a `
    + `flat figure. Usage is carried at ${fmt.pct(CLASS_MARGINS.usage, 0)}, one-time at `
    + `${fmt.pct(CLASS_MARGINS.oneTime, 0)}, and pass-through and recognised-elsewhere at zero.`;
}

// The donors behind every projection, read from the data rather than typed.
function donorSpan() {
  const b = projectionBasis(cohorts);
  return b && b.firstDonor
    ? `the ${b.donors} cohorts from ${fmt.monthLabel(b.firstDonor)} to ${fmt.monthLabel(b.lastDonor)}`
    : 'every cohort with six months behind it';
}

// The decision on the joining charge, said once and used by every chart that
// reads gross profit as it was booked.
const JOINING_CHARGE_NOTE = 'The old joining charge was real cash, so it stays in gross profit '
  + 'here: a 2024 cohort\'s first month carries it and a 2026 cohort\'s does not, which is part '
  + 'of why the earlier cohorts recover sooner.';

// The failure this projection could have, tested rather than asserted.
function projectionCheck(b) {
  if (!b || b.recentSurvival === null || b.donorSurvival === null) return null;
  const gap = Math.abs(b.donorToSix - b.recentToSix) * 100;
  return `Those donors are the older cohorts by construction, so if the newer ones churned `
    + `faster the projection would flatter them. `
    + (b.recentSurvival < b.donorSurvival && gap >= 2 ? 'On this push they do: ' : 'On this push they do not: ')
    + `monthly survival runs `
    + `${fmt.pct(b.donorSurvival, 1)} for the donors against ${fmt.pct(b.recentSurvival, 1)} `
    + `for ${b.recentCohorts === 1 ? 'the one newer cohort' : `the ${b.recentCohorts} newer cohorts`} `
    + `with six months behind them, and survival to month six `
    + `${fmt.pct(b.donorToSix, 1)} against ${fmt.pct(b.recentToSix, 1)}, `
    + `${gap < 2 ? 'which is the same within noise' : `a gap of ${gap.toFixed(1)} points`}. `
    + (b.recentCohorts < 3
        ? `That comparison rests on ${b.recentCohorts === 1 ? 'one cohort' : `${b.recentCohorts} cohorts`}, `
          + 'so it can rule out a large difference and not a small one. '
        : '')
    + `What it does not assume is that churn worsens: it carries today's rate forward `
    + `unchanged, so a bar far past its last observed month is an extrapolation, not a forecast.`;
}

// The redraw is a parameter. It was hardcoded to renderFullCost, so chart 28
// reused this helper and silently redrew chart 33 instead of itself: ticking a
// box moved nothing a reader could see.
function buildToggles(id, definitions, onChange = renderFullCost) {
  const box = $(id);
  if (!box || box.dataset.ready) return;

  const grid = document.createElement('div');
  grid.className = 'toggles';
  for (const g of definitions) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = g.key;
    input.checked = g.defaultOn;
    const text = document.createElement('span');
    text.innerHTML = `<span class="${g.once ? 'group-once' : ''}">${g.label}</span>`
      + `<span class="group-hint">${g.hint}</span>`;
    label.append(input, text);
    grid.append(label);
  }
  box.append(grid);
  box.addEventListener('change', onChange);
  box.dataset.ready = '1';
}

function wireCostToggles() {
  buildToggles('full-cost-revenue', REVENUE_GROUPS);
  buildToggles('full-cost-groups', COST_GROUPS);
}

const ticked = id => new Set(
  [...$(id).querySelectorAll('input:checked')].map(i => i.value));


// How fast cost per logo has moved against what a logo returns, between the
// halves of chart 1 at the slider's age. Kept here so the finding and the
// "what it means" paragraph read the same two numbers: the paragraph used to
// say "about four times as fast" while the finding beside it said 3.3.
let ltvPace = null;
// Read by the "what it means" paragraphs of charts 5 and 6, which are written
// at module load and filled in from the figures renderAnnotations computes.
let churnPicture = null;
let ageLosses = null;
// Survival lost between months 0, 3, 6 and 12, pooled over the cohorts that
// have had a full year, in points of the starting count.
function ageLossIntervals(group) {
  const year = group.filter(c => c.maxOffset >= 12 && c.survivors[0] > 0);
  if (!year.length) return null;
  const base = year.reduce((s, c) => s + c.survivors[0], 0);
  const at = k => year.reduce((s, c) => s + c.survivors[k], 0) / base;
  return { cohorts: year.length, early: (1 - at(3)) * 100,
           middle: (at(3) - at(6)) * 100, late: (at(6) - at(12)) * 100 };
}
const risenBy = v => (v >= 0 ? `risen ${fmt.pct(v, 0)}` : `fallen ${fmt.pct(-v, 0)}`);
function ltvPaceSentence(p) {
  if (!p) return '';
  if (p.cost <= 0) return 'What one costs has not risen between the halves.';
  if (p.worth <= 0) return 'What a customer returns has not risen at all. What one costs has.';
  if (p.cost <= p.worth) return 'What a customer returns has kept pace with what one costs.';
  return `What one costs has risen ${(p.cost / p.worth).toFixed(1)} times as fast as what a `
    + 'customer returns.';
}

// 1. LTV:CAC at a chosen age, redrawn whenever the age changes.
//
// The version this replaced measured every cohort to today, so a 2024 cohort
// had two years to return its cost and a 2026 one had two months. The bars
// sloped whether or not anything had changed. Cutting all of them at the same
// age is the only way the comparison means anything, and the slider is there
// because the right age genuinely depends on the question: month 3 says who
// starts well, month 12 says who pays back.
function renderLtvAtAge() {
  const age = Number($('ltv-age').value);
  $('ltv-age-value').textContent = age;

  const rows = ltvAtAge(data, cohorts, {
    age,
    // Only reached for a cohort with no recorded profit at all; the cohort's
    // own realised margin wins wherever it exists, and that is now built on
    // the measured monthly figure rather than the flat assumption.
    margin: MARGIN && MARGIN.measured ? MARGIN.mean : state.margin,
  });
  const shown = rows.filter(r => r.ratio !== null);

  if (!shown.length) {
    $('chart-ltv-cac').innerHTML = '<p class="empty">No cohort has reached this age yet.</p>';
    $('ltv-finding').textContent = '';
    return;
  }

  const partial = shown.filter(r => !r.complete);
  const settled = shown.filter(r => r.complete);
  const verdict = v => (v >= 3 ? INK.positive : v >= 1 ? INK.tertiary : INK.negative);

  stackedColumnChart($('chart-ltv-cac'), {
    yTitle: 'Lifetime value per dollar of CAC',
    labels: shown.map(r => fmt.monthLabel(r.month)),
    observed: shown.map(r => r.observed),
    projected: shown.map(r => r.projected),
    yFormat: v => v.toFixed(1) + 'x',
    colourFor: v => verdict(v),
    refs: [
      { value: 3, label: '3.0x', variant: 'ref-goal' },
      { value: 1, label: '1.0x break-even', variant: 'ref-floor' },
    ],
    legendItems: [
      { label: 'At or above 3.0x', colour: 'var(--series-pos)' },
      { label: 'Between 1.0x and 3.0x', colour: 'var(--series-3)' },
      { label: 'Below break-even', colour: 'var(--series-neg)' },
      { label: 'Hatched: projected, not yet observed', colour: 'var(--depends)' },
    ],
    describe: i => {
      const r = shown[i];
      const head = `<strong>${r.month} cohort at month ${age}</strong>
        <span>LTV:CAC ${fmt.ratio(r.ratio)}</span>`;
      const split = r.complete
        ? '<span class="muted">Fully observed</span>'
        : `<span>Observed ${fmt.ratio(r.observed)} through month ${r.monthsObserved}</span>
           <span>Projected ${fmt.ratio(r.projected)} over the next `
           + `${age - r.monthsObserved} month${age - r.monthsObserved === 1 ? '' : 's'}</span>`;
      return head + split + `
        <span>Cost per logo ${fmt.money(r.costPerLogo)}</span>
        <span>Gross profit per logo ${fmt.money(r.gpPerLogo)}</span>
        <span class="muted">${fmt.int(r.size)} logos, ${fmt.pct(r.survival, 0)} still there `
        + `${r.survivalAt} month${r.survivalAt === 1 ? '' : 's'} after the first</span>`;
    },
  });

  // Halves rather than endpoints. The first cohort in the window is the
  // censored boundary one, small and unrepresentative, and reading the story
  // off it and the last bar made the comparison swing on two noisy numbers.
  const above = shown.filter(r => r.ratio >= 1).length;
  const observedAbove = shown.filter(r => (r.observed || 0) >= 1).length;
  const cut = Math.floor(shown.length / 2);
  const early = shown.slice(0, cut);
  const late = shown.slice(cut);
  const avg = (g, k) => g.reduce((s, r) => s + r[k], 0) / g.length;
  const move = (a, b) => {
    const pct = (b / a - 1) * 100;
    return `${Math.abs(pct).toFixed(0)}% ${pct >= 0 ? 'higher' : 'lower'}`;
  };
  ltvPace = {
    age,
    cost: avg(late, 'costPerLogo') / avg(early, 'costPerLogo') - 1,
    worth: avg(late, 'gpPerLogo') / avg(early, 'gpPerLogo') - 1,
  };
  $('ltv-finding').innerHTML =
    ''
    // Two counts, because at a long age they diverge sharply and the headline
    // is the sentence that gets quoted. At month 24 every cohort clears its
    // cost, but only half of them do it on revenue anyone has seen: the rest
    // is the donor trajectory. Reporting the first number alone reads as "the
    // unit economics are fine" when what it means is "the model says so".
    + `<strong>At month ${age}, ${above} of ${shown.length} cohorts have covered their cost`
    + (observedAbove < above
        ? `, ${observedAbove} of them on revenue already observed.</strong> `
        : `.</strong> `)
    + `The earlier half averaged ${fmt.ratio(avg(early, 'ratio'))} and the later half `
    + `${fmt.ratio(avg(late, 'ratio'))}. Cost per logo is `
    + `${move(avg(early, 'costPerLogo'), avg(late, 'costPerLogo'))}, `
    + `${fmt.money(avg(early, 'costPerLogo'))} against ${fmt.money(avg(late, 'costPerLogo'))}, `
    + `while gross profit per logo is `
    + `${move(avg(early, 'gpPerLogo'), avg(late, 'gpPerLogo'))}, `
    + `${fmt.money(avg(early, 'gpPerLogo'))} against ${fmt.money(avg(late, 'gpPerLogo'))}. `
    + ltvPaceSentence(ltvPace)
    + (partial.length
        ? ` ${partial.length} of these columns are part projection, so the later half is `
          + `the half carrying most of that assumption.`
        : '');

  const basis = projectionBasis(cohorts);
  const bestCohort = shown.reduce((x, y) => (y.ratio > x.ratio ? y : x));
  const worstCohort = shown.reduce((x, y) => (y.ratio < x.ratio ? y : x));

  // Chart 1's annotation is written here rather than in renderAnnotations,
  // because both it and the chart depend on the age the slider sets. Left
  // there it went on describing the lifetime measure this chart replaced.
  annotate('chart-ltv-cac', [
    `<strong>${shown.length - above} of ${shown.length} cohorts are still below 1.0x at month ${age}</strong>, meaning they have not yet returned what they cost to win.`,
    `The best is ${bestCohort.month} at ${fmt.ratio(bestCohort.ratio)} on ${fmt.money(bestCohort.costPerLogo)} a logo; the worst is ${worstCohort.month} at ${fmt.ratio(worstCohort.ratio)} on ${fmt.money(worstCohort.costPerLogo)}.`,
    `Averaged across the halves: cost per logo ${fmt.money(avg(early, 'costPerLogo'))} then ${fmt.money(avg(late, 'costPerLogo'))}, gross profit per logo ${fmt.money(avg(early, 'gpPerLogo'))} then ${fmt.money(avg(late, 'gpPerLogo'))}.`,
  ], [
    `Cutting every cohort at the same age is what makes these comparable. A cohort that has not reached month ${age} yet carries what it has returned so far plus a projection of the rest, drawn hatched, so the bar shows which part is measured: ${settled.length} of ${shown.length} are fully observed here and ${partial.length} carry some projection.`,
    projectionNote(basis),
    projectionCheck(basis),
    'Cost per logo assumes a month of spend bought that month of logos. A long sales cycle would push spend into the wrong cohort.',
    censorNote(data, shown),
  ]);

  $('ltv-note').textContent =
    'Every cohort cut at the same age, so none of the slope is the calendar. '
    + (partial.length
        ? `${settled.length} of ${shown.length} cohorts have actually reached month ${age}; `
          + `the other ${partial.length} are drawn solid up to their last observed month and `
          + `hatched beyond it. The hatched part is not evidence. It carries the pooled donor `
          + `trajectory, the same projection the break-even chart uses, and each cohort's own `
          + `realised margin rather than the flat assumption. `
        : `Every cohort has actually reached month ${age}, so nothing here is projected. `)
    + 'Cost per logo is the month acquisition cost over the cohort count, the same denominator '
    + 'on both halves of the ratio. ' + JOINING_CHARGE_NOTE + ' A projection is worth least '
    + 'exactly where it is longest, so read the newest columns as a question rather than an answer.';
}


// 14. What each price band actually returns.
//
// This exists because chart 13 invites a conclusion it cannot support. Two
// lines on two scales appear to cross somewhere, and a crossing looks like an
// optimum: price here, capture the most revenue. It is not one. The scales can
// be slid until the lines meet anywhere on the chart, so the meeting point
// carries no information at all.
//
// The question underneath it is a good one, and this is where it can be asked.
// Group customers by what they were charged, follow every band the same number
// of months, and see what each returns. If there were a revenue-maximising
// price, it would show as a hump here.
function renderPriceBands() {
  const horizon = Number($('band-horizon').value) || 6;
  $('band-horizon-value').textContent = horizon + (horizon === 1 ? ' month' : ' months');

  const pb = priceBands(data, { horizon });
  if (!pb.bands.length) {
    $('chart-price-bands').innerHTML = '<p class="empty">Not enough matured signups yet.</p>';
    return;
  }

  const labels = pb.bands.map(b => b.label);
  dualAxisChart($('chart-price-bands'), {
    labels,
    left: {
      label: `Cash per customer over ${horizon} months`,
      colour: INK.primary,
      values: pb.bands.map(b => b.cashPerCustomer),
      format: v => '$' + Math.round(v).toLocaleString(),
    },
    right: {
      label: 'Returned per $1 of monthly price',
      colour: INK.secondary,
      values: pb.bands.map(b => b.perDollar),
      format: v => v.toFixed(1) + 'x',
    },
    describe: i => {
      const b = pb.bands[i];
      return `<strong>${b.label} a month from their second month</strong>
        <span>${fmt.int(b.n)} customers, average ${fmt.money(b.price)}</span>
        <span>${fmt.money(b.cashPerCustomer)} of cash over ${horizon} months</span>
        <span>${b.perDollar.toFixed(1)}x the monthly price</span>
        <span>${fmt.pct(b.feeEraShare, 0)} started before ${fmt.monthLabel(pb.feeEraEnds)}</span>
        <span class="muted">${fmt.pct(b.survival, 0)} still there at month ${horizon - 1}</span>`;
    },
  });

  const rows = pb.bands.map(b => `<tr>
      <td>${b.label}</td>
      <td class="n">${fmt.int(b.n)}</td>
      <td class="n">${fmt.money(b.price)}</td>
      <td class="n">${fmt.pct(b.survival, 0)}</td>
      <td class="n">${fmt.money(b.cashPerCustomer)}</td>
      <td class="n">${b.perDollar.toFixed(1)}x</td>
    </tr>`).join('');
  $('price-bands-table').innerHTML =
    '<thead><tr><th>Pays a month</th><th class="n">Customers</th><th class="n">Average price</th>'
    + `<th class="n">Alive at month ${horizon - 1}</th><th class="n">Cash each</th>`
    + '<th class="n">Per $1 of price</th></tr></thead><tbody>' + rows + '</tbody>';

  const best = pb.bands.reduce((a, b) => (b.cashPerCustomer > a.cashPerCustomer ? b : a));
  const top = pb.bands[pb.bands.length - 1];
  // Every adjacent pair, not the top band against the best: the old test
  // printed "keeps rising" over a band that returned less than the one below.
  const steps = pb.bands.slice(1).map((b, i) => b.cashPerCustomer - pb.bands[i].cashPerCustomer);
  const cashRises = steps.every(d => d > 0);
  const perSteps = pb.bands.slice(1).map((b, i) => b.perDollar - pb.bands[i].perDollar);
  const perDirection = perSteps.every(d => d > 0) ? 'rises'
    : perSteps.every(d => d < 0) ? 'falls' : 'moves without a direction';
  const dips = pb.bands.slice(1).filter((b, i) => steps[i] <= 0);
  const first = pb.bands[0];

  $('price-bands-finding').innerHTML = (cashRises
    ? `<strong>No ceiling is visible inside the range we charge.</strong> Cash per customer rises `
      + `with every band, ${fmt.money(first.cashPerCustomer)} in ${first.label} against `
      + `${fmt.money(top.cashPerCustomer)} in ${top.label}. `
    : best === top
      ? `<strong>The dearest band returns the most cash</strong>, ${fmt.money(top.cashPerCustomer)} `
        + `against ${fmt.money(first.cashPerCustomer)} in ${first.label}, but not at every step: `
        + `${dips.map(b => b.label).join(' and ')} ${dips.length === 1 ? 'returns' : 'return'} less than the band below. `
      : `<strong>Cash per customer peaks in the ${best.label} band</strong> at `
        + `${fmt.money(best.cashPerCustomer)}, on ${fmt.int(best.n)} customers. `)
    + `The return per dollar of monthly price ${perDirection} with price, `
    + `${first.perDollar.toFixed(1)}x at ${first.label} and ${top.perDollar.toFixed(1)}x at ${top.label}`
    + (perDirection === 'rises'
      ? ', so a dearer customer does not just pay more, they pay it for longer.'
      : perDirection === 'falls'
        ? ', so higher prices bring in more, just less than proportionally more.'
        : '.');

  $('price-bands-note').textContent =
    'Every customer who signed in the window and has had ' + horizon + ' full months since, '
    + fmt.int(pb.n) + ' of them, grouped by what they paid a month from their second month. '
    + 'The booked signup price is not used, because until mid-2025 it carried a joining charge '
    + 'that came off the month after: banded on it, ' + fmt.int(pb.bookedBandChanged)
    + ' of these customers sit in a different band, and the fee era fills the dearest bands. '
    + 'A customer with no paid second month is '
    + 'banded on the booked price. The cash is everything they paid, so the first month still '
    + 'carries the charge, and the tooltip gives each band\'s share of starts from before '
    + fmt.monthLabel(pb.feeEraEnds) + '. Alive at month ' + (horizon - 1) + ' counts the signup '
    + 'month as month 0, as chart 8 does. Bands with fewer than ten customers are dropped. Read '
    + 'this as what each kind of customer did, not as a demand curve: we never offered a price '
    + 'outside this range, so it cannot say how many customers a price we have not charged '
    + 'would win. It is also selection rather than causation, because a customer who pays more '
    + 'is usually a larger business, not the same business charged more.';
}



// The settled allocations, in the footer, sized from the ledger.
//
// These were written down once and drifted: the page claimed $1.87m of
// Customer Success and $1.06m of Technical Account Manager where the window
// now holds $1.60m and $0.89m. They are the figures that justify two of the
// three decisions on this page, so they are read rather than remembered.
function renderSettledTotals(data) {
  const sum = test => data.expenses
    .filter(e => test(e))
    .reduce((s, e) => s + (e.amount || 0), 0);

  // Both read by account rather than by bucket. Technical Account Manager sat
  // in OPEN while the decision was open and has since been moved to COGS,
  // which is the decision being carried out; reading the bucket made the
  // footer report $0 for it the moment that happened.
  const cs = sum(e => /Customer Success/i.test(e.account || ''));
  const tam = sum(e => /Technical Account Manager/i.test(e.account || ''));
  const cac = data.cacMonthly.reduce((s, r) => s + (r.cacTotalActual || 0), 0);

  const money = v => (v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'm' : fmt.money(v));
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set('cs-total', money(cs));
  set('cs-share', cac + cs ? fmt.pct(cs / (cac + cs), 0) : '–');
  set('tam-total', money(tam));
}

// 26. What acquisition costs, by category and month.
//
// Every other chart on this page reads the acquisition total as one number.
// This is the number opened up, because the question the total cannot answer
// is which line moved. The bottom three rows are the whole CAC calculation:
// what was spent, what arrived, and the division of one by the other.
function renderCostTable(data) {
  // Back to January 2025 rather than a rolling twelve months, so the table
  // covers the period the rest of the page argues over rather than only the
  // most recent year of it. Counted from the last month in the file so it
  // extends itself as new months land.
  // Was pinned to 2025-01 when the page could not reach further back anyway.
  // It runs to the start of the window now, which is as far as the acquisition
  // ledger goes.
  const FROM = data.historyStarts;
  const span = data.lastMonth && FROM
    ? monthDiff(FROM, data.lastMonth) + 1
    : 12;
  const c = acquisitionCosts(data, { months: Math.max(span, 12), cohorts });
  if (!c.months.length) {
    $('cost-table').innerHTML = '<tbody><tr><td>No acquisition spend in the window.</td></tr></tbody>';
    return;
  }

  const money = v => (v ? '$' + Math.round(v).toLocaleString() : '–');
  const head = '<thead><tr><th>Category</th>'
    + c.months.map(m => `<th class="n">${fmt.monthLabel(m)}</th>`).join('')
    + `<th class="n total-col">${c.months.length} months</th></tr></thead>`;

  const sum = vals => vals.reduce((s, v) => s + v, 0);
  const body = c.categories
    .filter(cat => sum(cat.values) > 0)
    .sort((a, b) => sum(b.values) - sum(a.values))
    .map(cat => `<tr><td>${cat.label}</td>`
      + cat.values.map(v => `<td class="n">${money(v)}</td>`).join('')
      + `<td class="n total-col">${money(sum(cat.values))}</td></tr>`)
    .join('');

  const totalRow = `<tr class="rule-above"><td><strong>Total acquisition cost</strong></td>`
    + c.totals.map(v => `<td class="n"><strong>${money(v)}</strong></td>`).join('')
    + `<td class="n total-col"><strong>${money(sum(c.totals))}</strong></td></tr>`;

  const logoRow = `<tr><td>Logos started</td>`
    + c.logos.map(v => `<td class="n">${v === null ? '–' : fmt.int(v)}</td>`).join('')
    + `<td class="n total-col">${fmt.int(c.logos.reduce((s, v) => s + (v || 0), 0))}</td></tr>`;

  // Per logo only over months that have a count, so the boundary month's spend
  // is not divided by logos it never had.
  const counted = c.months.map((m, i) => i).filter(i => c.logos[i] !== null);
  const totalLogos = counted.reduce((s, i) => s + c.logos[i], 0);
  const countedSpend = counted.reduce((s, i) => s + c.totals[i], 0);
  const perLogoOver = idx => {
    const n = idx.reduce((s, i) => s + c.logos[i], 0);
    return n ? idx.reduce((s, i) => s + c.totals[i], 0) / n : null;
  };
  const cplRow = `<tr class="rule-above emphasis"><td><strong>Cost per logo</strong></td>`
    + c.costPerLogo.map(v => `<td class="n"><strong>${v === null ? '–' : money(v)}</strong></td>`).join('')
    + `<td class="n total-col"><strong>${totalLogos ? money(countedSpend / totalLogos) : '–'}</strong></td></tr>`;

  $('cost-table').innerHTML = head + '<tbody>' + body + totalRow + logoRow + cplRow + '</tbody>';

  // Does this build's total agree with the one the workbook publishes?
  const drift = c.months.map((m, i) =>
    (c.reported[i] === null ? null : c.totals[i] - c.reported[i]));
  const worst = drift.reduce((a, b) => (b !== null && Math.abs(b) > Math.abs(a || 0) ? b : a), 0);

  const headcount = c.categories.filter(x =>
    ['ae', 'sdr', 'salesmgmt', 'partnerships'].includes(x.key));
  const headcountTotal = sum(headcount.map(x => sum(x.values)));
  const grand = sum(c.totals);

  // First and last six months that carry a count. The last six used to be
  // slice(6), every month after the first six, which put a 25 month average
  // under the words "the last six".
  const firstSix = counted.slice(0, 6);
  const lastSix = counted.slice(-6);
  $('cost-finding').innerHTML =
    `<strong>${money(countedSpend)} bought ${fmt.int(totalLogos)} logos, ${money(countedSpend / totalLogos)} each.</strong> `
    + `People you employ to sell are ${fmt.pct(headcountTotal / grand, 0)} of it. `
    + `Cost per logo averaged ${money(perLogoOver(firstSix))} `
    + `over the first six months with a count, ${fmt.monthLabel(c.months[firstSix[0]])} to `
    + `${fmt.monthLabel(c.months[firstSix[firstSix.length - 1]])}, and `
    + `${money(perLogoOver(lastSix))} `
    + `over the last six, to ${fmt.monthLabel(c.months[lastSix[lastSix.length - 1]])}. `
    + `Month by month it swings from ${money(Math.min(...c.costPerLogo.filter(v => v !== null)))} `
    + `to ${money(Math.max(...c.costPerLogo.filter(v => v !== null)))}, so a single month is a `
    + `poor summary of it.`;

  const drift12 = drift.reduce((s, v) => s + (v || 0), 0);
  const above = drift.filter(v => v !== null && v > 0);
  const below = drift.filter(v => v !== null && v < 0);
  const worstMonth = c.months[drift.indexOf(worst)];
  const boundaryNote = c.logos[0] === null
    ? ` ${fmt.monthLabel(c.months[0])} has spend and no count: it opens the window, so only `
      + 'customers with a Stripe start date can be dated to it, and its spend is left out of '
      + 'the per logo figures rather than divided by a partial count.'
    : '';
  $('cost-note').innerHTML =
    'Categories are matched from the account name, so a renamed account falls into Other '
    + 'rather than disappearing, and they sum to the total underneath them. '
    + '<strong>This total is the one every other chart divides by.</strong> Cost per logo, '
    + 'LTV:CAC, payback and break-even all take acquisition cost from these same lines, so the '
    + 'categories here account for the whole of it and nothing on the page is dividing by a '
    + 'number you cannot see broken out. '
    + 'The pipeline publishes its own figure in CAC Monthly, and the two do not agree: it is '
    + money(Math.abs(drift12)) + ' ' + (drift12 < 0 ? 'higher' : 'lower') + ' over these '
    + c.months.length + ' months, the net of ' + money(sum(above)) + ' by which the lines run '
    + 'above it in ' + above.length + ' months and ' + money(Math.abs(sum(below))) + ' below '
    + 'it in ' + below.length + ', and ' + money(Math.abs(worst)) + ' apart in the worst single '
    + 'month, ' + fmt.monthLabel(worstMonth) + '. The gap is spread across the window rather '
    + 'than sitting in one or two months. The lines win here because each one is an account '
    + 'that can be checked; the published figure is carried alongside so the gap stays visible. '
    + 'Logos are the customers whose first revenue fell in that month, the same count the '
    + 'cohort charts divide by, not the monthly summary\'s new logos.' + boundaryNote
    + (() => {
      const open = unclosedMonths(data).filter(m => c.months.includes(m));
      return open.length
        ? ` ${open.map(fmt.monthLabel).join(' and ')} had not closed in QuickBooks when this push `
          + `was taken (its revenue still sits in the clearing account), so ${open.length > 1
            ? 'their' : 'its'} acquisition lines may still move when the books close.`
        : '';
    })();
}

// A cohort this young cannot have returned its acquisition cost whatever its
// quality, because the measure is profit realised to date rather than a
// projection. Drawing them invites the age bias to be read as decline.
const MIN_COHORT_AGE = 6;

const state = { ...SETTLED };
let data = null;
let cohorts = null;

const $ = id => document.getElementById(id);

const COHORT_WINDOW = 24;
const CHURN_THRESHOLD = 0.05;


// The pricing comparison table, in the reading view.
//
// One row per strategy, one column per elasticity, showing money left after
// acquisition cost. The winner is marked in every column, because the point
// of the table is that the ranking does not depend on the elasticity anyone
// believes.
function renderPricing(data) {
  const node = $('pricing-table');
  if (!node) return;

  // Elasticity drives the whole comparison and is the one thing this data
  // cannot pin down, so it is a control rather than a constant. Moving it does
  // not change the conclusion, only which of the two fixed prices is the worse
  // mistake, and watching that swap is most of the lesson.
  const slider = $('pricing-elasticity');
  const elasticity = slider ? Number(slider.value) : -0.5;
  if ($('pricing-elasticity-value')) {
    $('pricing-elasticity-value').textContent = elasticity.toFixed(2);
  }

  const c = priceComparison(data, { elasticity });
  const s = pricingScenarios(data);
  const money = v => '$' + Math.round(v).toLocaleString();
  const best = c.rows[c.rows.length - 1];

  const head = '<thead><tr><th>How you price</th>'
    + '<th class="n">Logos a month</th>'
    + '<th class="n">New MRR a month</th>'
    + '<th class="n">Left on the table</th></tr></thead>';

  const body = c.rows.map(row => {
    const won = row.left <= 1;
    return `<tr${won ? ' class="rule-above"' : ''}>`
      + `<td><strong>${row.label}</strong><br><span class="muted">${row.detail}</span></td>`
      + `<td class="n">${row.logos.toFixed(0)}</td>`
      + `<td class="n${won ? ' emphasis' : ''}">${money(row.mrr)}`
      + (won ? ' <span class="best">most</span>' : '') + '</td>'
      + `<td class="n">${won ? '–' : money(row.left)}</td>`
      + '</tr>';
  }).join('');

  const worse = c.rows[0].left > c.rows[1].left ? c.rows[0] : c.rows[1];
  const milder = c.rows[0].left > c.rows[1].left ? c.rows[1] : c.rows[0];

  node.innerHTML = head + '<tbody>' + body + '</tbody>';

  // The method sits under the table rather than inside it. As a full width
  // row it was a paragraph wearing a table's clothes, and it pushed the three
  // numbers that matter off the bottom of the frame.
  $('pricing-note').textContent =
    `A single price wins one rectangle under the demand curve: the price, times however many `
    + `customers will pay it. Negotiating each deal down from a ${money(c.anchor)} anchor `
    + `toward a ${money(c.floor)} floor collects what each customer is actually willing to pay, `
    + `which is the area under that curve rather than a rectangle inside it. Buyers above the `
    + `anchor still only pay the anchor and buyers below the floor are not served at all, so `
    + `none of these three is credited with reading minds. Demand is ${c.baseQ.toFixed(0)} `
    + `logos a month at ${money(c.baseP)}, which is what the business ran before it began `
    + `raising price, scaled by the elasticity above.`;

  $('pricing-finding').innerHTML =
    `<strong>Whatever one price you pick, you are leaving `
    + `${money(Math.min(c.rows[0].left, c.rows[1].left))} a month or more on the table.</strong> `
    + `Price high at ${money(c.anchor)} and you win ${c.rows[0].logos.toFixed(0)} logos and lose `
    + `everyone who would have paid something between the floor and the anchor. Price low at `
    + `${money(c.floor)} and you win ${c.rows[1].logos.toFixed(0)} but collect `
    + `${money(c.floor)} from customers who would have gone far higher. At this elasticity the `
    + `worse of the two is ${worse.label.toLowerCase()}, at ${money(worse.left)} against `
    + `${money(milder.left)}. <strong>Neither is the choice.</strong> Anchoring high and `
    + `negotiating down to a floor collects ${money(best.mrr)} a month, because it charges each `
    + `customer something close to what they were willing to pay rather than charging all of `
    + `them the same thing. Move the slider: which single price is the bigger mistake changes, `
    + `and the negotiated answer wins at every setting.`;

  // The two controls that depend on the fit's own limits, written from the
  // numbers so they cannot go stale.
  if ($('control-range') && s.bands.length) {
    const lowest = s.bands[0];
    const top = s.topBand;
    $('control-range').innerHTML =
      `<strong>Only prices actually charged are observed</strong>, roughly `
      + `${fmt.money(lowest.price)} to ${fmt.money(s.fitCeiling)}. The top band the fit rests `
      + `on holds ${top.n} customers against ${lowest.n} in the lowest, so the upper end of the `
      + `line is the thin end of the evidence. ${s.everAboveCeiling} customers have ever started `
      + `above ${fmt.money(s.fitCeiling)} and only ${s.aboveCeiling} of them have a full `
      + `${s.horizon} months behind them, which is too few to read either way. The `
      + `recommendation deliberately goes past this edge, which is why it is put as a test to `
      + `run rather than a change to make.`;
  }
  if ($('control-extrapolation')) {
    $('control-extrapolation').innerHTML =
      `<strong>The demand curve is fitted, not observed, above `
      + `${fmt.money(s.fitCeiling)}.</strong> Of ${fmt.int(s.startPrices.length)} customers ever `
      + `started, exactly ${fmt.int(s.startPrices.filter(v => v >= 2500).length)} began at `
      + `$2,500 or more, so the anchor sits in a stretch of the curve nothing in this file has `
      + `tested. Elasticity is not identified either: measured against volume it is `
      + `${'−'}0.20, it does not clear significance, and adding a time trend flips the `
      + `sign. That is the reason for a slider rather than a number, and the reason the `
      + `recommendation is a test.`;
  }
}


// 8 and 9. Retention by era, in logos and in money.
//
// The same cohorts measured two ways, because they do not say the same thing.
// On logos the three years sit within a few points of each other and the era
// looks settled. Capped at what each customer arrived on, the years pull
// apart and 2026 pulls furthest, because a head count cannot see a customer
// who stays and stops paying. Reading only the logo line would close a
// question the money line reopens.
//
// Chart 8 runs from month 0 and chart 9 from month 1, the second month, which is where its own
// base is set: until mid-2025 the first month carried a joining charge booked
// as MRR and reversed the month after, and a part-billed first month leaves a
// customer under the rate they arrive on. The logo figures quoted next to the
// money ones are reindexed to month 1 to match.
// The callout's comparison of the head count with the money, read at the
// deepest month every year has reached rather than typed: the typed version
// called 2026 the best year on the count when it had become the worst.
function eraCalloutGap(eras) {
  const age = Math.min(6, ...eras.map(e => e.points.reduce((last, v, i) => (v === null ? last : i), 0)));
  const ready = eras.filter(e => e.points[age] != null && e.grossRevenue[age] != null);
  if (ready.length < 2) return 'Too few years have reached the same age to set the two side by side yet.';
  const newest = ready[ready.length - 1];
  const earlier = ready.slice(0, -1);
  const rankOf = key => [...ready].sort((a, b) => b[key][age] - a[key][age]).indexOf(newest);
  const place = rank => (rank === 0 ? 'the best' : rank === ready.length - 1 ? 'the worst' : 'in the middle');
  const onCount = place(rankOf('points'));
  const onMoney = place(rankOf('grossRevenue'));
  return `At month ${age} ${newest.year} is ${onCount} of the ${ready.length} years on the head `
    + `count, ${fmt.pct(newest.points[age], 1)} kept against `
    + `${earlier.map(e => `${fmt.pct(e.points[age], 1)} in ${e.year}`).join(' and ')}, and `
    + `${onMoney} on the money, ${fmt.pct(newest.grossRevenue[age], 1)} against `
    + `${earlier.map(e => `${fmt.pct(e.grossRevenue[age], 1)}`).join(' and ')}. `
    + (onCount === onMoney
      ? 'The two agree on the order; what the policy changes is how far apart the years sit '
        + 'on each.'
      : 'The order changes between them, and the difference is the policy.');
}

function renderEra() {
  // The same cohorts drawn twice, because logos and money do not say the same
  // thing about them. On logos the three years sit within a few points of each
  // other and the era looks settled. Weighted by what the customers were worth
  // the years pull apart, and a year can sit either side of its own logo line
  // depending on whether the accounts it lost were larger or smaller than the
  // ones it kept. Reading only the count would close a question the money
  // reopens, so both are drawn rather than hidden behind a switch somebody has
  // to know to flip.
  const MAX_AGE = 12;
  const eras = retentionByYear(cohorts, { maxMonths: MAX_AGE });
  const eraColours = [INK.tertiary, INK.secondary, INK.negative];
  if (!eras.length) {
    $('chart-era').innerHTML = '<p class="empty">Not enough cohorts yet.</p>';
    $('chart-era-revenue').innerHTML = '<p class="empty">Not enough cohorts yet.</p>';
    for (const id of ['era-finding', 'era-note', 'era-revenue-finding', 'era-revenue-note']) {
      if ($(id)) $(id).textContent = '';
    }
    return;
  }
  const labels = Array.from({ length: MAX_AGE }, (_, i) => `M${i}`);

  // One point per slider position, laid out year by year: 2024 fills from
  // month 1 to its last, then 2025 starts again at month 1 with 2024 left
  // standing, then 2026. Each era is drawn in against the ones already
  // finished, which is the comparison the chart exists to make.
  const steps = [];
  eras.forEach((era, ei) => {
    era.points.forEach((v, mi) => {
      if (v !== null && Number.isFinite(v)) steps.push({ ei, mi, year: era.year });
    });
  });

  const slider = $('era-depth');
  if (slider && !slider.dataset.ready) {
    slider.max = String(steps.length);
    slider.value = String(steps.length);
    slider.dataset.ready = '1';
  }
  const position = slider
    ? Math.min(Math.max(Number(slider.value) || steps.length, 1), steps.length)
    : steps.length;
  const here = steps[position - 1] || steps[steps.length - 1];
  const depth = here ? here.mi : MAX_AGE - 1;
  if ($('era-depth-value')) {
    $('era-depth-value').textContent = here
      ? `${here.year}, month ${here.mi} (${position} of ${steps.length})` : '--';
  }

  // Eras already finished stay whole, the one being drawn is cut at the
  // current month, and the ones after it are not drawn at all. What the axes
  // are sized from ignores all of this, so the lines grow into a fixed frame
  // rather than the frame closing around them.
  const cutFor = (eraIndex, arr) => arr.map((v, i) => {
    if (!here) return v;
    if (eraIndex < here.ei) return v;
    if (eraIndex > here.ei) return null;
    return i <= here.mi ? v : null;
  });

  // The deepest age all three reach, so the eras are never compared at their
  // own line ends: that would set a 2026 cohort at month 6 against a 2024 one
  // at month 12 and call the difference a trend.
  const depthOf = pick => Math.min(...eras.map(e =>
    pick(e).filter(v => v !== null && Number.isFinite(v)).length));
  const valueAt = (era, pick, depth) =>
    pick(era).filter(v => v !== null && Number.isFinite(v))[depth - 1];

  const draw = (node, pick, { money }) => {
    // The money chart starts at month 1, the second month, where its own base is set. See the
    // note in retentionByYear: month 1 is not a clean 100% once each customer
    // is capped at the rate they arrive on, because a part-billed first month
    // leaves them under it.
    // Month 0 is the signup month and is 100% by construction on the count.
    // The money line has no month 0 at all, because it is indexed to month 1.
    const from = money ? 1 : 0;
    const shift = arr => arr.slice(from);
    const real = eras.flatMap(e => pick(e)).filter(v => v !== null && Number.isFinite(v));
    multiLineChart($(node), {
      labels: labels.slice(from),
      series: eras.map((era, i) => ({
        label: `${era.year} cohorts`,
        colour: eraColours[i],
        values: shift(cutFor(i, pick(era))),
      })),
      yFormat: v => fmt.pct(v),
      yTitle: money ? 'Share of revenue kept, indexed to month 1, the second month'
        : 'Share of the cohort still there',
      yMin: Math.min(0.5, Math.floor(Math.min(...real) * 20) / 20),
      yMax: Math.max(1, Math.ceil(Math.max(...real) * 20) / 20),
      xTitle: 'Months since first revenue',
      refs: [],
      describe: i => `<strong>Month ${i + from}</strong>` + eras.map(era => {
        const v = pick(era)[i + from];
        return `<span>${era.year} ${v === null || !Number.isFinite(v) ? 'not yet' : fmt.pct(v, 1)}</span>`;
      }).join(''),
    });
  };

  const logos = e => e.points;
  const money = e => e.grossRevenue;
  draw('chart-era', logos, { money: false });
  draw('chart-era-revenue', money, { money: true });

  const newest = eras[eras.length - 1];
  // Everything below is read at whatever month the slider is showing, not at a
  // fixed month 6, so the text describes the picture rather than a picture the
  // reader cannot currently see. A year only enters the comparison once it has
  // actually reached that age: coercing a year that has not got there to zero
  // once put the spread at 79 points, which is the whole of the leading year
  // rather than a gap between years.
  const at = (era, key) => {
    const v = era[key] ? era[key][depth] : null;
    return v === null || v === undefined || !Number.isFinite(v) ? null : v;
  };
  // Only years the chart has actually drawn by this point in the sequence. An
  // era the slider has not reached yet has the number in the data but not on
  // the screen, and quoting it would describe a line the reader cannot see.
  const drawn = eras.filter((e, i) => !here || i <= here.ei);
  const ready = drawn.filter(e => at(e, 'points') !== null);
  const waiting = drawn.filter(e => !ready.includes(e));
  const logoSpread = ready.length > 1
    ? Math.max(...ready.map(e => at(e, 'points'))) - Math.min(...ready.map(e => at(e, 'points')))
    : null;
  const moneyReady = drawn.filter(e => at(e, 'grossRevenue') !== null);

  $('era-finding').innerHTML =
    (logoSpread === null
      ? `<strong>Only ${ready.length ? ready[0].year : 'one year'} has reached month ${depth} `
        + `so far.</strong> `
      : `<strong>On logos the ${ready.length} years sit within `
        + `${(logoSpread * 100).toFixed(1)} points of each other at month ${depth}.</strong> `)
    // The sample behind the point, not the year's total: at the far end of the
    // newest line the point can rest on one cohort while the year holds eight.
    + ready.map(e => `${e.year} ${fmt.pct(at(e, 'points'), 1)} on `
      + `${e.cohortsAt[depth] === 1 ? 'one cohort' : `${e.cohortsAt[depth]} cohorts`} and `
      + `${fmt.int(e.atRisk[depth])} customers`).join(', ')
    + (waiting.length ? `. ${waiting.map(e => e.year).join(' and ')} `
      + `${waiting.length === 1 ? 'has' : 'have'} not reached month ${depth} yet` : '')
    + (logoSpread === null
      ? `. Pull the slider further out to compare the eras.`
      : logoSpread < 0.05
        ? `. That is a narrow spread on thin samples, so at this age there is no clear `
          + `difference between the eras.`
        : ready.some(e => e.cohortsAt[depth] < 3)
          ? `. The years have parted by this age, but `
            + `${ready.filter(e => e.cohortsAt[depth] < 3).map(e => e.year).join(' and ')} `
            + `rests on fewer than three cohorts here, so the gap is one or two intakes rather `
            + `than a year.`
          : `. The years have separated by this age.`)
    + (moneyReady.length
      ? ` Chart 9 asks the same question in money, weighting each customer by what they `
        + `arrived on: at month ${depth} it reads `
        + `${moneyReady.map(e => `${e.year} ${fmt.pct(at(e, 'grossRevenue'), 1)}`).join(', ')}.`
      : '');

  // Both read at the slider's month off the month 1 base, so the gap between
  // them is downgrades and departures rather than a difference in indexing.
  const gAt = e => at(e, 'grossRevenue');
  const lAt = e => at(e, 'logosFromMonth2');
  const gap = e => (gAt(e) || 0) - (lAt(e) || 0);
  const ranked = [...eras].sort((a, b) => gap(a) - gap(b));
  // Only years that have both numbers at the slider's month, for the same
  // reason as above.
  const paired = drawn.filter(e => gAt(e) !== null && lAt(e) !== null);
  const rankedPairs = [...paired].sort((a, b) => gap(a) - gap(b));
  const worst = rankedPairs[0];
  const mildest = rankedPairs[rankedPairs.length - 1];
  const pts = e => Math.abs(gap(e) * 100).toFixed(1);

  $('era-revenue-finding').innerHTML = !paired.length
    ? `<strong>Nothing to compare yet at month ${depth}.</strong> This line is indexed to `
      + `month 1, the second month, so pull the slider past it.`
    : `<strong>${(() => {
        // Do not assert the direction. A year keeps more revenue than customers
        // whenever the accounts it lost were smaller than the ones it kept, and
        // 2024 currently does exactly that. The old wording said every year
        // loses more revenue and called a positive gap "a shortfall".
        const behind = paired.filter(e => gap(e) < 0);
        if (!behind.length) {
          return 'Every year keeps more of its revenue than of its customers, so the '
            + 'accounts being lost are the smaller ones';
        }
        if (behind.length === paired.length) {
          const widening = paired.every((e, i) => i === 0 || gap(e) <= gap(paired[i - 1]));
          return 'Every year loses more revenue than it loses customers'
            + (widening ? ', and the gap widens with each one' : '');
        }
        return `${behind.map(e => e.year).join(' and ')} `
          + `${behind.length === 1 ? 'loses' : 'lose'} more revenue than customers; `
          + `${paired.filter(e => gap(e) >= 0).map(e => e.year).join(' and ')} `
          + `${paired.filter(e => gap(e) >= 0).length === 1 ? 'does' : 'do'} the opposite`;
      })()}.</strong> Measured from month 1, the second month, at month ${depth} the `
    + `${paired.length === 1 ? 'one year so far keeps' : `${paired.length} years keep`} `
    + `${paired.map(e => `${e.year} ${fmt.pct(gAt(e), 1)}`).join(', ')} of their revenue, `
    + `against ${paired.map(e => `${fmt.pct(lAt(e), 1)}`).join(', ')} of their customers. `
    + `That is ${paired.map(e => `${pts(e)} points ${gap(e) < 0 ? 'short' : 'ahead'} in ${e.year}`).join(', ')}. `
    + (paired.length > 1
      ? `${worst.year} is the worst of them: it keeps ${fmt.pct(lAt(worst), 1)} of the `
        + `customers it had at month 1 and ${fmt.pct(gAt(worst), 1)} of the money, `
        + `${pts(worst)} points apart, against ${pts(mildest)} in ${mildest.year}. ` : '')
    + (paired.some(e => gap(e) < 0)
        ? `Where the money line sits below the count, the head count is the flattering `
          + `number: a customer who stays and stops paying still counts as kept.`
        : `The count is not flattering the picture here: the money line is at or above `
          + `it, which means the accounts leaving are smaller than the ones staying.`);

  const lastPoint = e => e.points.reduce((last, v, i) => (v === null ? last : i), 0);
  const shared =
    'Every cohort lined up by age rather than by calendar date, so month 0 is each cohort\'s '
    + 'first month whenever that happened, then pooled into one line per starting year. '
    + eras.map(e => `${e.year}: ${e.cohorts} cohorts`).join(', ')
    + `. At each age a year is pooled over the cohorts that have reached it, so the sample is `
    + `recomputed at every point and thins as the line runs right. The ${newest.year} line `
    + `holds ${newest.cohorts} cohorts at month 0 and ${newest.cohortsAt[lastPoint(newest)]} at `
    + `its last point, month ${lastPoint(newest)}, and will move as more months land.`
    + (drawn.length < eras.length
      ? ` The slider is part way through: `
        + `${eras.slice(drawn.length).map(e => e.year).join(' and ')} `
        + `${eras.length - drawn.length === 1 ? 'is' : 'are'} not drawn yet.`
      : '');

  // The sample rule selects the oldest cohorts of a part-finished year, which
  // in 2026 means the only three with no first month departures at all. Said
  // in the finding rather than the note, because a reader who takes the left
  // hand end of that line at face value has been misled by it.
  // Every cohort of the year is now used at every age it has reached, so the
  // old warning about which cohorts were drawn no longer applies. What does
  // apply is the opposite: the sample shrinks as the line runs right, and
  // where a bad intake ages out of it the line reads better than the month
  // before. Named here rather than left for a reader to trip over.
  const ready1 = eras.filter(e => e.month1MedianAll !== null);
  const medianLine = ready1.map(e => `${e.year} ${fmt.pct(e.month1MedianAll, 1)}`).join(', ');
  const newestYear = ready1[ready1.length - 1];
  const outlier = newestYear && newestYear.month1WorstCohort;
  const skewed = outlier && newestYear.month1LossAll !== null
    && newestYear.month1LossAll - newestYear.month1MedianAll > 0.03;
  const kinked = eras.filter(e => e.rises && e.rises.length);

  $('era-finding').innerHTML +=
    ` Across every cohort of each year the median loses ${medianLine} in its first month.`
    + (skewed
      ? ` The mean for ${newestYear.year} reads ${fmt.pct(newestYear.month1LossAll, 1)}, but `
        + `that is one cohort: ${outlier.month} lost ${fmt.pct(outlier.loss, 1)} in a month. `
        + `Without it the rest of ${newestYear.year} averages `
        + `${fmt.pct(newestYear.month1ExWorst, 1)}, so it is worth treating as its own problem `
        + `rather than as the year's rate.`
      : '')
    + (kinked.length
      ? ` <strong>Where a line rises, the sample changed and not the customers.</strong> `
        + kinked.map(e => e.rises.map(r =>
          `${e.year} reads ${fmt.pct(r.to, 1)} at month ${r.age} against `
          + `${fmt.pct(r.from, 1)} at month ${r.age - 1} because ${fmt.int(r.lostFromSample)} `
          + `customers are too recent to have reached that age and drop out of the count`)
          .join('; ')).join('; ')
      + `. Survival here only falls, so a rise is always the denominator moving.`
      : '');

  $('era-note').textContent = shared
    + ' Month 0 is the month a customer first paid, so it is 100% by construction, and month 1'
    + ' is that year’s customers one month after signing up.'
    + ' At each age the count behind the point is every customer of that year whose cohort has'
    + ' had that long to run. Cohorts too young are in neither the numerator nor the'
    + ' denominator, which is why a line stops where it does and why the count beneath it'
    + ' falls as it runs right. The count at the slider\'s month is in the finding above, and a'
    + ' point is dropped once fewer than twenty customers are left behind it, which is the only'
    + ' rule that decides where a line stops.'
    + ' First month figures are medians rather than means, because a single bad intake moves a'
    + ' mean by several points and a year holds only a handful of cohorts. The earliest year'
    + ' covers only the months inside the data window, so it is a part year rather than a full'
    + ' one.'
    + ' One caveat about the newest year. Every year loses cohorts as its line runs right, but'
    + ' the current year loses them fastest, because only those old enough to have reached an'
    + ' age can be in it. Its deep points therefore rest on its earliest intakes rather than on'
    + ' all of them, which is why the line can rise, and why it can disagree with the'
    + ' calendar-position charts further down about which year looks worst.';

  // Why the 2026 line is flat, from the business rather than from the file,
  // with the file checked against it. Both changes keep a customer in this
  // chart and take their money out of chart 9, which is the gap between them.
  const signals = policySignals(data);
  const pol = signals.stopPaying;
  const free = signals.freeStart;
  // Said whichever way the rate actually moved. It has risen, which makes the
  // point more strongly than a flat rate would: the list price is going up
  // while the free periods multiply, so these are not cheaper subscriptions.
  const rateBefore = signals.medianStart.before;
  const rateAfter = signals.medianStart.after;
  const rateMoved = rateBefore && rateAfter
    && Math.abs(rateAfter - rateBefore) / rateBefore > 0.02;
  const rateNote = !rateBefore || !rateAfter
    ? 'the rate customers start on has not moved'
    : rateMoved
      ? `the median rate a customer starts on has ${rateAfter > rateBefore ? 'risen' : 'fallen'} `
        + `to ${fmt.money(rateAfter)} from ${fmt.money(rateBefore)}`
      : `the median rate a customer starts on has held at ${fmt.money(rateAfter)}`;
  $('era-callout').innerHTML =
    '<h4>Two changes behind the 2026 line</h4>'
    + `<p>Going into 2026 the business began <strong>requiring customers to serve out their `
    + `next billing period before a cancellation takes effect</strong>, and began `
    + `<strong>offering coupons more freely</strong>. Both keep a customer in this chart `
    + `after their revenue has stopped, so some of what the 2026 line keeps is a change `
    + `in what counts as leaving rather than a change in who leaves.</p>`
    + `<p>The file agrees on both. Among customers who were present and paying the month `
    + `before, the share whose revenue drops to nothing while they stay on the books runs at `
    + `${fmt.pct(pol.after, 1)} a month from ${fmt.monthLabel(signals.split)}, against `
    + `${fmt.pct(pol.before, 1)} before it. And the coupons are not discounts off the rate: `
    + `${rateNote}, while the share of new customers whose second month books no MRR at all `
    + `has gone from ${fmt.pct(free.before, 0)} to ${fmt.pct(free.after, 0)}. Those are free `
    + `periods, not cheaper subscriptions.</p>`
    + `<p>This is the reconciliation between the head count here and the revenue in chart 9. `
    + eraCalloutGap(eras)
    + `</p>`;
  $('era-revenue-note').textContent = shared
    + ' Gross revenue retention: every customer is capped at what they were paying in their '
    + 'second month, so this falls both when a customer leaves and when one stays on less than '
    + 'they arrived on, and expansion cannot lift it. Capping is what makes it comparable to '
    + 'the count above; a line that nets expansion against churn can sit above its own starting '
    + 'point and stops answering the same question. Chart 4 is the netted version. The second '
    + 'month is the base rather than the first because until mid-2025 the first carried a '
    + 'joining charge booked as MRR that came off again the next month, and because a '
    + 'part-billed first month leaves a customer under the rate they arrive on. The line is '
    + 'drawn from month 1 for the same reason, and the logo figures quoted beside it are '
    + 'reindexed to month 1 so the gap is not an artefact of where each line starts. It is not '
    + 'strictly monotonic: a customer who downgrades and later returns to their original rate '
    + 'adds that money back. Much of the fall is customers still recorded as present with MRR '
    // Recomputed rather than quoted: these drifted 2.7 points in a day.
    + 'booked to zero, which at month 6 is ' + (() => {
        // The page's own cohorts, so these shares cannot drift from the chart
        // above them: buildCohorts already leaves out the censored customers,
        // honours a Stripe start date and drops the shifted-forward starts,
        // which a second inline build here did not.
        const row = new Map(data.customers.filter(r => r.active).map(r => [r.id + '|' + r.month, r]));
        const parts = [];
        for (const yr of ['2024', '2025', '2026']) {
          let present = 0;
          let zero = 0;
          for (const c of cohorts) {
            if (!c.month.startsWith(yr) || c.maxOffset < 6) continue;
            const at = monthAdd(c.month, 6);
            for (const id of c.ids) {
              const hit = row.get(id + '|' + at);
              if (!hit) continue;
              present += 1;
              if (!(hit.eopMrr > 0)) zero += 1;
            }
          }
          if (present) parts.push(fmt.pct(zero / present, 1) + ' of ' + yr);
        }
        return parts.join(', ');
      })() + '.';
}

// The views: every chart, the Upgrade list, Events and Marketing.
function showView(which) {
  $('view-all').hidden = which !== 'all';
  if ($('view-list')) $('view-list').hidden = which !== 'list';
  if ($('view-events')) $('view-events').hidden = which !== 'events';
  if ($('view-marketing')) $('view-marketing').hidden = which !== 'marketing';
  if ($('view-event')) $('view-event').hidden = which !== 'event';
  // Leaving an event's page drops its address, so the same event can be
  // opened again from the list.
  if (which !== 'event' && /^#event=/.test(location.hash)) {
    history.replaceState(null, '', which === 'events' ? '#events' : location.pathname + location.search);
  }
  for (const [id, on] of [['tab-all', which === 'all'], ['tab-list', which === 'list'],
                          ['tab-events', which === 'events' || which === 'event'],
                          ['tab-marketing', which === 'marketing']]) {
    if (!$(id)) continue;
    $(id).setAttribute('aria-selected', String(on));
    $(id).classList.toggle('is-on', on);
  }
  window.scrollTo({ top: 0 });
}

function wireTabs() {
  $('tab-all').addEventListener('click', () => showView('all'));
  if ($('tab-list')) $('tab-list').addEventListener('click', () => showView('list'));
  if ($('tab-events')) $('tab-events').addEventListener('click', () => showView('events'));
  if ($('tab-marketing')) $('tab-marketing').addEventListener('click', () => showView('marketing'));
  // An event's own page is #event=<name>; #events returns to the list.
  const route = () => {
    const m = location.hash.match(/^#event=(.+)$/);
    if (m) { renderEventPage(decodeURIComponent(m[1])); showView('event'); return true; }
    if (location.hash === '#events') { showView('events'); return true; }
    return false;
  };
  window.addEventListener('hashchange', route);
  if (!route()) showView('all');
}

// 27. Acquisition cost per logo, one line per category.
//
// The table above it holds every number and is unreadable as a shape. This is
// the same window divided by the same new logo counts, which turns "what did
// we spend" into "what did each customer cost, and which line moved".
function renderCostDrivers() {
  const span = data.lastMonth && data.historyStarts
    ? monthDiff(data.historyStarts, data.lastMonth) + 1
    : 12;
  const c = acquisitionCosts(data, { months: Math.max(span, 12), cohorts });
  if (!c.months.length) return;

  const sum = vals => vals.reduce((s, v) => s + v, 0);
  const perLogo = cat => cat.values.map((v, i) => {
    const n = c.logos[i];
    return n ? v / n : null;
  });

  // Five lines is the most a reader can follow. Everything else is summed into
  // one so the total still reconciles rather than quietly losing money.
  // A category with no money in the window is not a line, and counting it in
  // "Everything else" named six categories where five carried a dollar.
  const ranked = c.categories.filter(cat => sum(cat.values) > 0)
    .sort((a, b) => sum(b.values) - sum(a.values));
  const shown = ranked.slice(0, 5);
  const rest = ranked.slice(5);
  const palette = [INK.primary, INK.secondary, INK.tertiary, INK.accent, INK.negative];

  const series = shown.map((cat, i) => ({
    label: cat.label, colour: palette[i], values: perLogo(cat),
  }));
  if (rest.length) {
    series.push({
      label: 'Everything else (' + rest.length + ')',
      colour: 'var(--ink-soft)',
      thin: true,
      values: c.months.map((m, i) => {
        const n = c.logos[i];
        return n ? rest.reduce((s, cat) => s + cat.values[i], 0) / n : null;
      }),
    });
  }
  series.push({
    label: 'Total per logo', colour: 'var(--ink)', dashed: true, values: c.costPerLogo,
  });

  const labels = c.months.map(fmt.monthLabel);
  multiLineChart($('chart-cost-drivers'), {
    yTitle: 'Cost per logo, per month',
    labels, series, yFormat: fmt.money,
    describe: i => labels[i] + ': ' + fmt.money(c.costPerLogo[i]) + ' per logo on '
      + fmt.int(c.logos[i]) + ' logos started. '
      + series.slice(0, -1).map(s => s.label + ' ' + fmt.money(s.values[i])).join(', '),
  });

  // Which line actually moved. Comparing the first and last quarter of the
  // window rather than two single months, so one bad month does not decide it.
  const q = Math.max(Math.round(c.months.length / 4), 1);
  const meanOf = (vals, from, to) => {
    const slice = vals.slice(from, to).filter(v => v !== null);
    return slice.length ? slice.reduce((s, v) => s + v, 0) / slice.length : null;
  };
  const moves = shown.map(cat => {
    const v = perLogo(cat);
    const early = meanOf(v, 0, q);
    const late = meanOf(v, c.months.length - q);
    return { label: cat.label, early, late, delta: (late || 0) - (early || 0) };
  }).sort((a, b) => b.delta - a.delta);

  const totalEarly = meanOf(c.costPerLogo, 0, q);
  const totalLate = meanOf(c.costPerLogo, c.months.length - q);
  const top = moves[0];
  const shareOfMove = totalLate - totalEarly ? top.delta / (totalLate - totalEarly) : null;

  $('cost-drivers-finding').innerHTML =
    '<strong>Cost per logo went from ' + fmt.money(totalEarly) + ' to '
    + fmt.money(totalLate) + ', and ' + top.label.toLowerCase() + ' is '
    + (shareOfMove === null ? 'most' : fmt.pct(shareOfMove)) + ' of the move.</strong> '
    + 'That line alone went from ' + fmt.money(top.early) + ' to '
    + fmt.money(top.late) + ' per logo. '
    + (moves[1] && moves[1].delta > 0
        ? moves[1].label + ' added ' + fmt.money(moves[1].delta) + ' on top of it. '
        : '')
    + 'Read this against the logo counts in the table above rather than on its '
    + 'own: a category can rise here without anybody spending an extra dollar, '
    + 'because the denominator is logos started and that is the number that fell.';

  $('cost-drivers-note').textContent =
    'Each category from the table above, divided by the logos that started in the '
    + 'same month, so this is the cost table read per customer rather than per month. '
    + 'A category with no spend in a month sits at zero rather than leaving a gap, '
    + 'because zero is the true value there. The dashed line is the total and equals '
    + 'the bottom row of the table. Months with no new logos have no cost per logo '
    + 'and break the lines rather than dropping them to the axis. '
    + 'One category break to know about before reading a trend into it: marketing '
    + 'salaries, which sit in Other acquisition and so in the Everything else line here, '
    + 'ran about $12,000 a month to 2025-07, sat at zero from 2025-09 to 2025-12 and came '
    + 'back at around $3,500 from 2026-02, while the same work moved into agencies and '
    + 'services. Both are acquisition so no total moves, but the two are not comparable '
    + 'across that break: a fall in one and a rise in the other there is a reclassification '
    + 'rather than a decision.';
}


// 28. What a customer pays against what is left after serving them.
//
// The first chart on this page built on measured cost rather than an assumed
// margin, which is why the finding leads with the gap between the two.
function renderContribution() {
  const c = costToServe(data);
  if (!c) return;

  // Acquisition was left off this chart on the grounds that it divides by NEW
  // logos where everything else divides by ACTIVE ones. That is a real
  // objection to netting them per logo, and a bad reason to leave the question
  // unanswerable: "are we making money overall" is the first thing anyone
  // asks. It is the last switch, on by default with every other cost, spreading
  // the month's whole acquisition bill across the active base. That is a
  // different basis from the rest of the chart, and the hint, the tooltip and
  // the note all read the switch rather than assuming its state.
  const acqByMonth = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const ACQ_SPREAD = {
    key: 'acqspread',
    label: 'Acquisition, spread over the active base',
    defaultOn: true,
    hint: 'The whole month’s acquisition bill divided by every active logo, not just '
        + 'the new ones. A different basis from the rows above: it answers whether '
        + 'the business as a whole washes its face.',
  };
  // Chart 28 opens with every cost ticked, because what is left after
  // everything is the question people actually ask of it. Chart 33 keeps the
  // gross defaults, since there acquisition is charged properly against the
  // cohort that caused it and the gross view is what outside comparisons use.
  // The two charts share the definitions and not the starting state.
  const groups = COST_GROUPS.filter(g => !g.once)
    .map(g => ({ ...g, defaultOn: true }))
    .concat(ACQ_SPREAD);
  buildToggles('contribution-groups', groups, renderContribution);
  const on = ticked('contribution-groups');

  const rates = costRates(data);
  const keys = groups.filter(g => on.has(g.key) && g.key !== 'acqspread').map(g => g.key);
  const acqAt = month => {
    if (!on.has('acqspread')) return 0;
    const row = c.months.find(x => x.month === month);
    const spend = acqByMonth.get(month);
    return row && row.activeLogos && spend ? spend / row.activeLogos : 0;
  };
  const chargeAt = month => {
    const row = rates.rates.has(month) ? rates.rates.get(month) : rates.carried;
    return keys.reduce((sum, k) => sum + (row[k] || 0), 0) + acqAt(month);
  };

  const months = c.months.filter(m => rates.rates.has(m.month));
  if (!months.length) return;
  const labels = months.map(m => fmt.monthLabel(m.month));
  const left = months.map(m => m.arpa - chargeAt(m.month));

  multiLineChart($('chart-contribution'), {
    yTitle: 'Dollars per logo, per month',
    labels,
    yFormat: fmt.money,
    series: [
      { label: 'What a customer pays', colour: INK.primary, values: months.map(m => m.arpa) },
      { label: keys.length ? 'Left after the ticked costs' : 'Nothing taken off',
        colour: keys.length === groups.length ? INK.negative : INK.secondary, values: left },
    ],
    describe: i => {
      const m = months[i];
      const charge = chargeAt(m.month);
      return `<strong>${labels[i]}</strong>`
        + `<span>Pays ${fmt.money(m.arpa)} across ${fmt.int(m.activeLogos)} active logos</span>`
        + groups.filter(g => on.has(g.key)).map(g => {
            const row = rates.rates.get(m.month) || rates.carried;
            const amount = g.key === 'acqspread' ? acqAt(m.month) : (row[g.key] || 0);
            return `<span class="muted">less ${g.label.toLowerCase()} ${fmt.money(amount)}</span>`;
          }).join('')
        + `<span>Leaves ${fmt.money(m.arpa - charge)}, `
        + `${fmt.pct(m.arpa ? (m.arpa - charge) / m.arpa : 0, 1)} of what they pay</span>`
        + `<span class="muted">${on.has('acqspread')
          ? 'Acquisition spread over the active base is in this figure'
          : 'Acquisition is not in this figure'}</span>`;
    },
  });

  const recent = months.slice(-6);
  const meanArpa = recent.reduce((s, m) => s + m.arpa, 0) / recent.length;
  const meanLeft = recent.reduce((s, m) => s + (m.arpa - chargeAt(m.month)), 0) / recent.length;
  const all = groups.every(g => on.has(g.key));
  const perDollar = (() => {
    const spend = recent.reduce((s, m) => s + chargeAt(m.month), 0) / recent.length;
    return spend ? meanLeft / spend : null;
  })();
  const cogsOnly = keys.length && keys.every(k => ['platform', 'support', 'revshare'].includes(k));

  $('contribution-finding').innerHTML =
    `<strong>The average customer pays ${fmt.money(meanArpa)} a month and `
    + `${fmt.money(meanLeft)} of it survives the costs ticked above.</strong> `
    + (all
        ? `That is every cost the business carries including acquisition, so it is the `
          + `whole picture on one line: ${fmt.money(meanArpa - meanLeft)} of cost against `
          + `${fmt.money(meanArpa)} of revenue, or about `
          + `$${(perDollar === null ? 0 : perDollar * 5).toFixed(2)} kept for every $5 spent. `
          + 'What a customer pays here is everything they pay: subscription, usage and '
          + 'message credits, setup, and 10DLC pass-through. An earlier version of this '
          + 'chart counted subscription alone, which understated revenue by about a tenth '
          + 'and made the same months read as break-even when they are not. '
        : cogsOnly
          ? 'That is cost of sales only, so it is gross contribution: the figure to use '
            + 'for ratios and for any outside comparison, and not a profit. '
          : 'Tick every box for what a customer contributes to the whole company; tick '
            + 'only the cost-of-sales rows for the gross figure outside comparisons use. ')
    + (on.has('acqspread')
        ? 'Acquisition is in that figure, spread across the active base rather than '
          + 'charged to the new logos that caused it, which is the only way to put it on '
          + 'a per-active-logo chart. It answers whether the business as a whole washes '
          + 'its face; it does not tell you whether an individual customer pays back, '
          + 'because the spend lands in one month and the return arrives over the '
          + 'following year. Chart 33 is where that question is answered properly.'
        : '<strong>Acquisition is unticked, so it is not in this figure.</strong> What it '
          + 'cost to win the customer is several thousand of one-off spend per new logo '
          + 'against a few hundred a month of recurring contribution, and leaving it out '
          + 'is what separates a contribution figure from a profit one. '
          + 'Tick the last box to spread acquisition across the '
          + 'active base and see the all-in number, or read chart 33, which puts both '
          + 'sides together over a cohort’s life.');

  $('contribution-note').textContent =
    'What a customer pays is everything they pay, subscription MRR plus usage and '
    + 'message credits, setup and one-time charges, and 10DLC and carrier pass-through, '
    + 'across every active logo, divided by that logo count. Accounts that have never once '
    + 'carried a subscription are excluded from the count: a test account or an agency '
    + 'monitoring seat is not a customer whose cost anybody should be spreading. '
    + 'The costs are the real monthly figures from the finance tab over the same count, '
    + 'never-paid accounts left out of both sides'
    + (c.logosAgree
        ? ', and the pipeline\'s own active count agrees with it in every month'
        : '; the pipeline\'s own active count, which keeps them, differs from it')
    + '. G&A and R&D are spread evenly across active logos, because nothing ties a '
    + 'landlord or a developer to a particular customer. '
    + (on.has('acqspread')
      ? 'Acquisition is ticked, spread over the active base: it divides by NEW logos where '
        + 'everything else here divides by ACTIVE ones, so it says whether the business as '
        + 'a whole covers its costs, not whether a customer pays back. '
      : 'Acquisition is unticked: it divides by NEW logos where everything here divides by '
        + 'ACTIVE ones, and spreading it is a choice the last switch leaves to you. ')
    + 'The August revenue share in this push is the figure QuickBooks held before the '
    + 'month closed, well over twice a usual month, so the six-month mean in the finding '
    + 'carries it. Cost of sales alone gives gross contribution, which is what ratios and '
    + 'outside benchmarks use; everything ticked gives what a customer contributes toward '
    + 'the whole business. Neither is the other and neither is profit.';
}


// 29. Cost of sales per logo, split by the team carrying it.
function renderServeTeams() {
  const c = costToServe(data);
  if (!c || !c.teamTotals.length) return;

  const labels = c.months.map(m => fmt.monthLabel(m.month));
  const palette = [INK.primary, INK.secondary, INK.tertiary, INK.accent, INK.negative];
  // Five lines is the most a reader can follow; the rest are summed into one
  // so the lines still add up to the dashed total. The tab carries seven teams
  // now, and drawing five while the note said five summed to the total left
  // Customer Support and Hosting out of a chart that claimed to hide nothing.
  const top = c.teamTotals.slice(0, 5);
  const rest = c.teamTotals.slice(5);
  const perLogo = (m, amount) => (m.activeLogos ? amount / m.activeLogos : null);
  const teamAt = (m, label) => (m.teams.find(t => t.label === label)?.amount || 0);

  const series = top.map((team, i) => ({
    label: team.label,
    colour: palette[i],
    values: c.months.map(m => perLogo(m, teamAt(m, team.label))),
  }));
  if (rest.length) {
    series.push({
      label: rest.length === 1 ? rest[0].label : `${rest.map(t => t.label).join(' and ')}`,
      colour: 'var(--ink-soft)', thin: true,
      values: c.months.map(m => perLogo(m, rest.reduce((s, t) => s + teamAt(m, t.label), 0))),
    });
  }
  // The total over the same count as the lines, so the lines sum to it. The
  // tab's own cogs_per_logo divides by its own active count, which keeps the
  // never-paid accounts, and drawing it here put two denominators on one chart.
  series.push({
    label: 'All cost of sales', colour: 'var(--ink)', dashed: true,
    values: c.months.map(m => perLogo(m, m.teams.reduce((s, t) => s + (t.amount || 0), 0))),
  });

  multiLineChart($('chart-serve-teams'), {
    yTitle: 'Cost of sales per logo, per month',
    labels, series, yFormat: fmt.money,
    describe: i => labels[i] + ': ' + fmt.money(c.months[i].cogsPerLogo)
      + ' per active logo. '
      + series.slice(0, -1).map(s => s.label + ' ' + fmt.money(s.values[i])).join(', '),
  });

  const grand = c.teamTotals.reduce((s, t) => s + t.amount, 0);
  const biggest = c.teamTotals[0];
  // Which kind of cost is larger, read from the team names rather than
  // asserted: the finding used to say "people, not infrastructure" while
  // software and hosting were the larger of the two.
  const sumOf = test => c.teamTotals.filter(t => test.test(t.label)).reduce((s, t) => s + t.amount, 0);
  const infra = sumOf(/Software|Hosting/i);
  const people = sumOf(/Customer Success|Technical Account|Support/i);
  $('serve-teams-finding').innerHTML =
    '<strong>' + biggest.label + ' is ' + fmt.pct(biggest.amount / grand)
    + ' of what it costs to serve the base.</strong> ' + fmt.money(biggest.amount)
    + ' of ' + fmt.money(grand) + ' across ' + c.months.length + ' months. '
    + c.teamTotals.slice(1, 4).map(t => t.label + ' ' + fmt.pct(t.amount / grand)).join(', ')
    + '. This is the chart to argue over if the answer to thin margins is to serve '
    + 'customers more cheaply rather than to charge more, because it names where the '
    + 'money actually goes. Software and hosting together are ' + fmt.money(infra) + ', '
    + fmt.pct(infra / grand) + ' of it; the three teams of people who look after customers '
    + 'are ' + fmt.money(people) + ', ' + fmt.pct(people / grand) + '. '
    + (infra > people
      ? 'So the larger lever is what the platform costs to run, not headcount, '
      : 'So the larger lever is headcount, not what the platform costs to run, ')
    + 'and a pricing answer is the other one on the table.';

  $('serve-teams-note').textContent =
    'Every account booked to cost of sales, divided by active logos in the same '
    + 'month, never-paid accounts left out. The pushed tab carries ' + c.teamTotals.length
    + ' teams; the five largest are drawn and '
    + (rest.length ? 'the other ' + rest.length + ' are summed into the faint line, so ' : 'so ')
    + 'the lines add up to the dashed total over the same count, and nothing is hidden or '
    + 'counted twice. One line here '
    + 'has a spike in the latest month that is not a cost increase. QuickBooks dates a '
    + '$69,848 vendor credit against the August revenue share invoice on the 31st, inside '
    + 'August, but this push pulled August before that credit was posted, so the charge is '
    + 'in and the reversal is not and August reads about $70,000 high. The next push carries '
    + 'the closed month, and underlying August is close to July. One more line '
    + 'is worth explaining, because it looks wrong and is not: the Sales & Marketing '
    + 'line inside cost of sales. That is the Service Titan revenue share and partner '
    + 'rebates, both paid on what customers who have already been won go on to bill. '
    + 'They scale with those customers’ usage, they recur while the customer '
    + 'stays, and they would carry on if acquisition stopped tomorrow, so they belong '
    + 'here rather than in the acquisition table. Strictly they are contra-revenue '
    + 'and sit in cost of sales because there is nothing to net them against. They '
    + 'are counted once: the acquisition total reconciles from its own categories '
    + 'with no affiliate line in it.';
}


// 31. Monthly churn split by tenure.
//
// Several notes on this page assert that what went wrong is not only a new
// customer problem. This is the measurement behind that claim.
function renderTenureChurn() {
  const CUTS = [3, 6, 12];
  // A band with no members yet is blank, not a reason to drop the month: the
  // 6 to 12 month band cannot fill until seven months into the window, and
  // dropping every row with a blank silently started the chart eight months in.
  const rows = churnByTenure(data, { cuts: CUTS })
    .filter(r => r.bands.some(b => b.rate !== null));
  if (!rows.length) return;
  const firstFull = rows.find(r => r.bands.every(b => b.rate !== null));

  const bands = rows.bands || rows[0].bands;
  const palette = [INK.negative, INK.secondary, INK.primary, INK.tertiary];

  // Four lines is one more than this chart can carry legibly, so which of them
  // are drawn is a switch. The arithmetic runs on all four either way: the
  // shares below are each band against everyone who left, not against the
  // bands on screen, so turning a line off never changes another line's number.
  const box = $('tenure-bands');
  if (box && !box.dataset.ready) {
    const grid = document.createElement('div');
    grid.className = 'toggles';
    bands.forEach((b, i) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(i);
      input.checked = true;
      const text = document.createElement('span');
      text.innerHTML = `<span>${b.label}</span>`;
      label.append(input, text);
      grid.append(label);
    });
    box.append(grid);
    box.addEventListener('change', renderTenureChurn);
    box.dataset.ready = '1';
  }
  const on = box
    ? new Set([...box.querySelectorAll('input:checked')].map(i => Number(i.value)))
    : new Set(bands.map((_, i) => i));

  const labels = rows.map(r => fmt.monthLabel(r.month));
  const series = bands
    .map((b, i) => ({ i, b }))
    .filter(({ i }) => on.has(i))
    .map(({ i, b }) => ({
      label: b.label,
      colour: palette[i] || INK.tertiary,
      values: rows.map(r => r.bands[i].rate),
    }));

  if (!series.length) {
    $('chart-tenure-churn').innerHTML = '<p class="empty">No bands selected.</p>';
    return;
  }

  multiLineChart($('chart-tenure-churn'), {
    yTitle: 'Share of the band’s logos lost that month',
    labels,
    yFormat: v => fmt.pct(v, 1),
    series,
    describe: i => {
      const r = rows[i];
      return `<strong>${labels[i]}</strong>`
        + r.bands.map(b =>
            `<span>${b.label}: ${fmt.pct(b.rate, 1)} of ${fmt.int(b.base)} left, `
            + `${fmt.pct(b.shareOfLosses)} of the month’s losses</span>`).join('')
        + `<span class="muted">${fmt.int(r.totalGone)} of ${fmt.int(r.base)} gone in total</span>`;
    },
  });

  const recent = rows.slice(-6).filter(r => r.bands.every(b => b.rate !== null));
  const meanRate = i => recent.reduce((s, r) => s + r.bands[i].rate, 0) / recent.length;
  const meanShare = i => recent.reduce((s, r) => s + r.bands[i].shareOfLosses, 0) / recent.length;
  const rates = bands.map((_, i) => meanRate(i));
  const shares = bands.map((_, i) => meanShare(i));
  const worst = rates.indexOf(Math.max(...rates));
  const oldest = bands.length - 1;

  $('tenure-churn-finding').innerHTML =
    `<strong>${bands[worst].label.replace(/^U/, 'u')} churns hardest at `
    + `${fmt.pct(rates[worst], 1)} a month, but the longest-tenured band is `
    + `${fmt.pct(shares[oldest])} of everyone who actually leaves.</strong> `
    + bands.map((b, i) => `${b.label.toLowerCase()} ${fmt.pct(rates[i], 1)}`).join(', ')
    + `. Rate and share answer different questions and point at different teams: the `
    + `rate is "are we selling to the wrong people", the share is "where would fixing `
    + `it actually help". `
    + (rates[0] > rates[1]
        ? `The first three months churn harder than the three after them, so the damage `
          + `is at the very front.`
        : `The first three months are not the worst of it, which rules out the simplest `
          + `story, that customers arrive, take one look and go. The worst band sits `
          + `after onboarding has ended.`);

  $('tenure-churn-note').textContent =
    'Presence month to month across the whole standing base, cut at '
    + CUTS.slice(0, -1).join(', ') + ' and ' + CUTS[CUTS.length - 1]
    + ' months of tenure. Not a cohort chart: it describes the book as it stood each '
    + 'month rather than a single intake followed forward, so a customer moves from one '
    + 'band to the next as they age. Customers already present when the data window '
    + 'opens have no knowable signup date and go in the oldest band, which is the '
    + 'conservative choice: it puts them in the band this chart is trying not to '
    + 'blame, and it is also why that band is the largest. '
    + (firstFull && firstFull !== rows[0]
      ? 'A band with no members yet is left blank rather than drawn at zero, which is why the '
        + 'longer bands only start at ' + fmt.monthLabel(firstFull.month) + '. '
      : '')
    + 'Tenure runs from the first month a customer is present, which can be before they '
    + 'first pay. A customer booked down to '
    + 'zero MRR is still present here, because presence on this page is an event type '
    + 'and not an amount. Share of losses is each band against everyone who left that '
    + 'month, so the four shares sum to one and the rates do not; the switches change '
    + 'only what is drawn, never what is counted.';
}


// 25. The same question, month by month.
// 24 and 25 are pre-rendered animations, so their findings cannot come from
// the drawing the way every other chart's does. They were written by hand and
// left as assertions: "the recent months land inside the same cloud as the
// early ones" stayed true only for as long as nobody checked.
//
// The claim is testable against the same series the GIF is built from, so it
// is tested here and the sentence is written from the answer. If the recent
// months ever do sit apart, the page will say so.
function renderArrivalAnimations() {
  const box = $('arrivals-month-finding');
  if (!box) return;
  const a = arrivalsAgainstChurn(data, { horizon: 1 });
  if (!a || !a.points || a.points.length < 8) return;

  const points = [...a.points].sort((x, y) => x.month.localeCompare(y.month));
  const split = Math.max(4, points.length - 6);
  const earlier = points.slice(0, split);
  const recent = points.slice(split);

  const churns = earlier.map(p => p.y).sort((x, y) => x - y);
  const q = f => churns[Math.min(churns.length - 1, Math.floor(f * (churns.length - 1)))];
  const lo = q(0.1);
  const hi = q(0.9);
  const outside = recent.filter(p => p.y < lo || p.y > hi);

  const inside = recent.length - outside.length;
  const better = outside.filter(p => p.y < lo);
  const worse = outside.filter(p => p.y > hi);
  // Which side of the band they sit on is the operator's point: "sit apart"
  // reads as worse, and three of the four were better.
  const sides = [
    better.length && `${better.length} below it, losing fewer customers than the earlier months did`,
    worse.length && `${worse.length} above it, losing more`,
  ].filter(Boolean).join(', and ');
  box.innerHTML = outside.length
    ? `<strong>${outside.length} of the last ${recent.length} starting months sit outside `
      + `the range the earlier ones occupied: ${sides}.</strong> `
      + outside.map(p => `${fmt.monthLabel(p.month)} at ${fmt.pct(p.y, 1)}`).join(', ')
      + `, against a 10th-to-90th percentile band of ${fmt.pct(lo, 1)} to ${fmt.pct(hi, 1)} `
      + `across the ${earlier.length} months before them. By chance about one in five of them `
      + `would land outside a band that wide, so ${outside.length} of ${recent.length} is worth `
      + `reading, and the direction is what to read.`
    : `<strong>The recent months land inside the same cloud as the early ones.</strong> `
      + `All ${inside} of the last ${recent.length} starting months fall within the `
      + `${fmt.pct(lo, 1)} to ${fmt.pct(hi, 1)} band that the previous ${earlier.length} `
      + `occupied. Chart 22 draws every month at once, so nothing on it says which came `
      + `first and a relationship that had changed would be invisible. Adding them one at `
      + `a time is what makes that checkable.`;
}

// 44. The same question as chart 31, asked in money.
function renderRevTenure() {
  if (!$('chart-rev-tenure')) return;
  const r = cohortRevenueRetention(cohorts);
  if (!r || !r.blended.length) {
    $('chart-rev-tenure').innerHTML = '<p class="empty">Not enough history yet.</p>';
    return;
  }
  const palette = [INK.negative, INK.secondary, INK.primary, INK.tertiary];

  // Which intakes are drawn is a switch, the same one chart 31 carries. The
  // arithmetic runs on all of them either way: the blended line is every
  // cohort, not the ones on screen, so turning a vintage off never moves it.
  const box = $('rev-tenure-bands');
  if (box && !box.dataset.ready) {
    const grid = document.createElement('div');
    grid.className = 'toggles';
    r.series.forEach((s, i) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(i);
      input.checked = true;
      const text = document.createElement('span');
      text.innerHTML = `<span>${s.label}</span>`;
      label.append(input, text);
      grid.append(label);
    });
    box.append(grid);
    box.addEventListener('change', renderRevTenure);
    box.dataset.ready = '1';
  }
  const on = box
    ? new Set([...box.querySelectorAll('input:checked')].map(i => Number(i.value)))
    : new Set(r.series.map((_, i) => i));

  const labels = r.blended.map(p => `M${p.age}`);
  const pad = points => labels.map((_, i) => {
    const p = points.find(x => x.age === i);
    return p ? p.departed : null;
  });

  const series = r.series
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => on.has(i))
    .map(({ s, i }) => ({ label: s.label, colour: palette[i] || INK.tertiary, values: pad(s.points) }));
  series.push({
    label: 'Every cohort blended',
    colour: INK.tertiary,
    dashed: true,
    values: r.blended.map(p => p.departed),
  });

  const drawn = series.flatMap(s => s.values).filter(v => v !== null && Number.isFinite(v));
  multiLineChart($('chart-rev-tenure'), {
    yTitle: 'Share of the cohort’s opening revenue lost',
    labels,
    yMin: 0,
    yMax: Math.ceil(Math.max(...drawn) * 20) / 20,
    yFormat: v => fmt.pct(v, 0),
    xTitle: 'Months since first revenue',
    series,
    describe: i => {
      const b = r.blended.find(p => p.age === i);
      const rows = r.series.map(s => {
        const p = s.points.find(x => x.age === i);
        return p
          ? `<span>${s.label}: ${fmt.pct(p.departed, 1)} of its starting revenue walked out `
            + `with a departing customer, against ${fmt.pct(1 - p.logos, 1)} of the logos. `
            + `Counting downgrades too, ${fmt.pct(p.churned, 1)} of it is no longer `
            + `arriving</span>`
          : `<span class="muted">${s.label}: not this old yet</span>`;
      }).join('');
      return `<strong>Month ${i} after signing</strong>${rows}`
        + (b ? `<span class="muted">Blended ${fmt.pct(b.departed, 1)} departed, `
               + `${fmt.pct(b.churned, 1)} including downgrades, across ${b.cohorts} cohorts `
               + `and ${fmt.money(b.base)} of starting revenue</span>` : '');
    },
  });

  const last = r.blended[r.blended.length - 1];
  const half = r.atHalf;
  const year = r.atYear;

  // Whether a later intake is losing faster than an earlier one, read at the
  // oldest age they all reach rather than at a fixed month that some of them
  // have not lived through.
  const common = r.series.reduce(
    (n, s) => Math.min(n, s.points[s.points.length - 1].age), Infinity);
  const atCommon = r.series
    .map(s => ({ label: s.label.replace(' intake', ''),
                 value: (s.points.find(p => p.age === common) || {}).departed }))
    .filter(x => x.value !== null && x.value !== undefined);
  const spread = atCommon.length > 1
    ? (Math.max(...atCommon.map(x => x.value)) - Math.min(...atCommon.map(x => x.value))) * 100
    : null;
  const newest = atCommon[atCommon.length - 1];
  const older = atCommon.slice(0, -1);
  const olderMean = older.length
    ? older.reduce((s, x) => s + x.value, 0) / older.length : null;

  // The step the anniversary cuts into the line, found rather than named.
  const jumps = r.blended.slice(1)
    .map((p, i) => ({ age: p.age, size: p.departed - r.blended[i].departed }))
    .filter(x => Number.isFinite(x.size));
  const typical = [...jumps].map(x => x.size).sort((a, b) => a - b)[Math.floor(jumps.length / 2)];
  const step = jumps.filter(x => x.size > typical * 2.5).sort((a, c) => c.size - a.size)[0];
  const stepInMany = step
    ? r.series.filter(s => {
        const at = s.points.find(p => p.age === step.age);
        const before = s.points.find(p => p.age === step.age - 1);
        return at && before && at.departed - before.departed > typical * 2;
      }).length
    : 0;

  $('rev-tenure-finding').innerHTML =
    `<strong>By the time a cohort is a year old, `
    + `${year ? fmt.pct(year.departed, 0) : 'a third'} of the revenue it arrived with has `
    + `walked out with a customer who left`
    + (half ? `, and ${fmt.pct(half.departed, 0)} of it by six months` : '')
    + `.</strong> `
    + `That is the drawn line, and it only counts departures, so it is a running total that `
    + `cannot come back down. `
    + (year
        ? `<strong>Count the downgrades as well and it is ${fmt.pct(year.churned, 0)} at a `
          + `year.</strong> The gap between those two numbers, `
          + `${((year.churned - year.departed) * 100).toFixed(0)} points of a cohort's opening `
          + `revenue, is customers who are still here and paying less. It is the larger half `
          + `of the problem and it is in the hover at every point, not on the line, because it `
          + `is not a running total: a customer who downgrades and later goes back up puts the `
          + `money back. `
        : '')
    + (typical && step
        ? `The line is not a smooth slope. It gives up about `
          + `${fmt.pct(typical, 1)} of the opening revenue in a normal month and `
          + `${fmt.pct(step.size, 1)} at month ${step.age}`
          + (stepInMany > 1
              ? `, and that step falls in ${stepInMany} of the intakes, so it is the contract `
                + `anniversary rather than something that happened to the book in one calendar `
                + `month. `
              : `. `)
        : '')
    + (spread !== null && newest && olderMean !== null && spread >= 3
        ? `<strong>The vintages do not lie on top of each other.</strong> At month ${common}, `
          + `the oldest age every intake has reached, ${newest.label} has lost `
          + `${fmt.pct(newest.value, 0)} against ${fmt.pct(olderMean, 0)} for `
          + `${older.map(x => x.label).join(' and ')}. On the sample so far the newest money is `
          + (older.every(x => newest.value > x.value)
            ? 'leaving faster than any intake before it. '
            : older.every(x => newest.value < x.value)
              ? 'leaving slower than any intake before it. '
              : `leaving ${newest.value > olderMean ? 'faster' : 'slower'} than the earlier `
                + `intakes on average, but not ${newest.value > olderMean ? 'faster' : 'slower'} `
                + 'than every one of them. ')
        : '')
    + `Because departures are weighted by what each customer was worth rather than counted, `
    + `this line and the logo curve on chart 4 sit within a few points of each other the whole `
    + `way: the customers who leave outright are not much bigger or smaller than average. `
    + `Everything that makes revenue behave differently from head count is in the downgrade `
    + `gap, which is why that number is quoted above. `
    + (r.blended.dips && r.blended.dips.length
        ? `Where the blended line falls it is the sample changing and not money returning, `
          + `which departures forbid: `
          + r.blended.dips.map(d => `month ${d.age} dips as ${d.lostFromSample} `
              + `${d.lostFromSample === 1 ? 'cohort ages' : 'cohorts age'} out of the count`)
              .join(', ')
          + `.`
        : '');

  const row = s => {
    const cell = (age, key) => {
      const p = s.points.find(x => x.age === age);
      return `<td class="n">${p ? fmt.pct(p[key], 1) : '-'}</td>`;
    };
    return `<tr><td>${s.label}</td><td class="n">${fmt.money(s.points[0].base)}</td>`
      + cell(3, 'departed') + cell(6, 'departed') + cell(12, 'departed')
      + cell(18, 'departed')
      + `<td class="n muted">${(() => {
          const p = s.points.find(x => x.age === 12);
          return p ? fmt.pct(p.churned, 1) : '-';
        })()}</td>`
      + `<td class="n">${s.points[s.points.length - 1].age}</td></tr>`;
  };
  $('rev-tenure-table').innerHTML =
    '<thead><tr><th>Intake</th><th class="n">Starting revenue</th>'
    + '<th class="n">Departed by M3</th><th class="n">by M6</th><th class="n">by M12</th>'
    + '<th class="n">by M18</th><th class="n">M12 incl. downgrades</th>'
    + '<th class="n">Oldest age</th></tr></thead><tbody>'
    + r.series.map(row).join('')
    + `<tr class="muted"><td>Every cohort blended</td>`
    + `<td class="n">${fmt.money(r.blended[0].base)}</td>`
    + [3, 6, 12, 18].map(a => {
        const p = r.blended.find(x => x.age === a);
        return `<td class="n">${p ? fmt.pct(p.departed, 1) : '-'}</td>`;
      }).join('')
    + `<td class="n">${(() => {
        const p = r.blended.find(x => x.age === 12);
        return p ? fmt.pct(p.churned, 1) : '-';
      })()}</td>`
    + `<td class="n">${last.age}</td></tr></tbody>`;

  $('rev-tenure-note').textContent =
    'Each line is one intake year. The base is what that intake was paying when it arrived, '
    + 'and the drawn line is how much of those same dollars left with a customer who is no '
    + 'longer here. A cohort that started on $100,000 and has since lost customers who were '
    + 'paying $20,000 of it reads 20%. Departure is survival, so per cohort the line cannot '
    + 'come back down; where the blended line dips it is a cohort ageing out of the sample, '
    + 'and the finding names the ages where that happens. Revenue lost to customers who stayed '
    + 'and paid less is not on the line, because that one is not a running total: a customer '
    + 'who downgrades and later returns to their old rate puts the money back, and a line that '
    + 'can fall is not a cumulative loss. It is the larger number, and it is in the hover at '
    + 'every point and in the last column of the table. Starting revenue is a customer’s '
    + 'second month rather than their first, because until mid-2025 a joining charge was '
    + 'booked as MRR and came off again the month after; indexing on month 0 would turn that '
    + 'one-off ending into a cliff, which is the same reason chart 4 indexes where it does. At '
    + 'each age only the cohorts that have had that long to run are counted, so the sample '
    + 'thins to the right and each line stops before it rests on fewer than three intakes. '
    + 'Customers already present in the first month of the window have no knowable start date '
    + 'and are in no cohort. Chart 45 asks about the rate month by month over calendar time '
    + 'rather than the running total over a cohort’s life.';
}

// 45. Revenue retained at a fixed age, by signing month.
function renderRevChurnTenure() {
  if (!$('chart-rev-churn')) return;
  const r = revenueRetentionAtAges(cohorts);
  if (!r || r.rows.length < 4) {
    $('chart-rev-churn').innerHTML = '<p class="empty">Not enough history yet.</p>';
    return;
  }
  const palette = [INK.primary, INK.secondary, INK.tertiary, INK.negative, INK.muted || INK.primary];
  const colourAt = i => palette[i % palette.length];

  const box = $('rev-churn-bands');
  if (box && !box.dataset.ready) {
    const grid = document.createElement('div');
    grid.className = 'toggles';
    r.ages.forEach((age, i) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(i);
      input.checked = true;
      const text = document.createElement('span');
      text.innerHTML = `<span>${age} months out</span>`;
      label.append(input, text);
      grid.append(label);
    });
    box.append(grid);
    box.addEventListener('change', renderRevChurnTenure);
    box.dataset.ready = '1';
  }
  const on = box
    ? new Set([...box.querySelectorAll('input:checked')].map(i => Number(i.value)))
    : new Set(r.ages.map((_, i) => i));

  const labels = r.rows.map(row => fmt.monthLabel(row.cohort));
  const cell = (row, i) => row.points[i];

  // Measured and carried are drawn as two series so the carried part can be
  // dashed, and the last measured point is repeated into the dashed one so the
  // two meet rather than leaving a gap at the join.
  const series = [];
  const legendItems = [];
  r.ages.forEach((age, i) => {
    if (!on.has(i)) return;
    const colour = colourAt(i);
    const seen = r.rows.map(row => (cell(row, i).forecast ? null : cell(row, i).value));
    const carried = r.rows.map((row, k) => {
      const p = cell(row, i);
      if (p.forecast) return p.value;
      // the join: the last measured point before the carried run begins
      const next = r.rows[k + 1];
      return next && cell(next, i).forecast ? p.value : null;
    });
    series.push({ label: `${age} months out`, colour, values: seen });
    if (carried.some(v => v !== null && Number.isFinite(v))) {
      series.push({ label: `${age} months out, carried forward`, colour, dashed: true,
                    thin: true, values: carried });
    }
    legendItems.push({ label: `${age} months out`, colour });
  });

  if (!series.length) {
    $('chart-rev-churn').innerHTML = '<p class="empty">No horizons selected.</p>';
    return;
  }

  multiLineChart($('chart-rev-churn'), {
    yTitle: 'Share of opening revenue still arriving',
    labels,
    yMin: 0,
    yMax: 1,
    yFormat: v => fmt.pct(v, 0),
    xTitle: 'Month the customers signed',
    series,
    legendItems,
    describe: k => {
      const row = r.rows[k];
      return `<strong>Signed ${labels[k]}</strong>`
        + `<span class="muted">${fmt.int(row.logos)} customers, ${fmt.money(row.start)} of `
        + `starting revenue, ${row.age} months of life so far</span>`
        + row.points.map(p => {
          if (p.value === null) return `<span class="muted">${p.age} months out: too young</span>`;
          if (!p.forecast) {
            return `<span>${p.age} months out: ${fmt.pct(p.value, 1)} still arriving, so `
              + `${fmt.pct(1 - p.value, 1)} gone</span>`;
          }
          return `<span class="muted">${p.age} months out: ${fmt.pct(p.value, 1)} carried `
            + `forward from month ${p.from}`
            + (p.lo !== null ? `, ${fmt.pct(p.lo, 0)} to ${fmt.pct(p.hi, 0)} at 95%` : '')
            + `</span>`;
        }).join('');
    },
  });

  // Is a horizon drifting? Measured readings only, first third against last
  // third, so a trend is not read off the carried part of the line.
  const drift = r.ages.map((age, i) => {
    const seen = r.rows.map(row => ({ row, p: cell(row, i) })).filter(x => !x.p.forecast);
    if (seen.length < 6) return null;
    const cut = Math.floor(seen.length / 3);
    const avg = xs => xs.reduce((s, x) => s + x.p.value * x.row.start, 0)
      / xs.reduce((s, x) => s + x.row.start, 0);
    const first = avg(seen.slice(0, cut));
    const last = avg(seen.slice(-cut));
    return { age, first, last, move: (last - first) * 100, n: seen.length,
             fromMonth: seen[0].row.cohort, toMonth: seen[seen.length - 1].row.cohort };
  }).filter(Boolean);

  const twelve = drift.find(d => d.age === 12) || drift[drift.length - 1];
  const three = drift.find(d => d.age === 3) || drift[0];
  const carriedCount = r.rows.reduce(
    (n, row) => n + row.points.filter(p => p.forecast && p.value !== null).length, 0);
  const pooled12 = r.pooled.find(p => p.age === 12);

  $('rev-churn-finding').innerHTML =
    (twelve
      ? `<strong>A year after signing, the earliest intakes still had `
        + `${fmt.pct(twelve.first, 0)} of their revenue and the latest ones had `
        + `${fmt.pct(twelve.last, 0)}`
        + (Math.abs(twelve.move) < 2
            ? `, which is the same number.</strong> `
            : `, ${Math.abs(twelve.move).toFixed(0)} points `
              + `${twelve.move < 0 ? 'worse' : 'better'}.</strong> `)
      : '')
    + (three
        ? `At three months the same comparison runs ${fmt.pct(three.first, 0)} to `
          + `${fmt.pct(three.last, 0)}`
          + (Math.abs(three.move) < 2 ? ', flat' : `, ${Math.abs(three.move).toFixed(0)} points `
            + `${three.move < 0 ? 'worse' : 'better'}`)
          + `. `
        : '')
    + (twelve && three && Math.abs(twelve.move) > Math.abs(three.move) + 2
        ? `The damage is not at the front door. A cohort looks much the same at three months as `
          + `it always did and much worse a year in, which points at what happens between `
          + `those two readings rather than at who is being sold to. `
        : '')
    + (pooled12
        ? `Pooled across the ${pooled12.cohorts} intakes old enough to have the reading, a year `
          + `out leaves ${fmt.pct(pooled12.value, 0)} of the opening revenue. `
        : '')
    + `The dashed ends are carried, not measured: ${fmt.int(carriedCount)} of the points on `
    + `this chart are a young cohort's own last reading taken forward along the average shape, `
    + `and the hover gives the month it was carried from and a 95% range around it. The range `
    + `is not assumed. It is how far cohorts have actually drifted from that shape over a gap `
    + `of the same length, so a reading carried two months is tight and one carried twelve is `
    + `not.`;

  $('rev-churn-note').textContent =
    'One point per signing month. The base is what that month’s intake was paying when it '
    + 'arrived, and each line is how much of those same dollars was still arriving a fixed '
    + 'number of months later. A point above January 2024 on the twelve-month line is what the '
    + 'January 2024 intake had left in January 2025. Read down a column and you have chart '
    + '44’s curve for that intake; read along a line and you have whether the business is '
    + 'getting better or worse at holding what it sells. Both ways a dollar leaves are in it: '
    + 'the customer going, and the customer staying on less. Each customer is capped at what '
    + 'they were paying at the start, so expansion cannot lift a point above 100%. Starting '
    + 'revenue is a customer’s second month rather than their first, for the reason given '
    + 'on chart 44. A dashed end is carried forward rather than measured, because a cohort '
    + 'that signed nine months ago has no twelve-month reading and stopping the line there '
    + 'hides the part of the chart worth looking at; it is the cohort’s own last reading '
    + 'scaled by the average shape between those two ages, and a cohort with under two months '
    + 'of life behind it is not carried at all. Customers already present in the first month '
    + 'of the window have no knowable start date and are in no cohort, which is why January '
    + '2024 is small.';
}

// 46. The retention curve for a chosen run of signing months.
function renderWindowCurve() {
  if (!$('chart-window-curve')) return;
  const probe = windowRetentionCurve(cohorts, { span: 3 });
  if (!probe) {
    $('chart-window-curve').innerHTML = '<p class="empty">Not enough history yet.</p>';
    return;
  }
  const box = $('window-controls');
  if (box && !box.dataset.ready) {
    const spans = document.createElement('div');
    spans.className = 'toggles';
    [3, 6, 12].forEach(n => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'window-span';
      input.value = String(n);
      input.checked = n === 3;
      const text = document.createElement('span');
      text.innerHTML = `<span>${n} months</span>`;
      label.append(input, text);
      spans.append(label);
    });
    const slide = document.createElement('div');
    slide.className = 'slider-row';
    const range = document.createElement('input');
    range.type = 'range';
    range.id = 'window-start';
    range.min = '0';
    // Opens on the newest three-month window that has a full measured year,
    // rather than on the oldest window in the book. The oldest is the best
    // intake on the page and the furthest from what is being signed now, which
    // is the opposite of the window the finding tells a reader to build on.
    const ageOf = new Map(cohorts.map(c => [c.month, c.maxOffset]));
    let opening = 0;
    for (let i = 0; i + 3 <= probe.months.length; i += 1) {
      const youngest = Math.min(...probe.months.slice(i, i + 3).map(m => ageOf.get(m) ?? -1));
      if (youngest >= 12) opening = i;
    }
    range.max = String(Math.max(0, probe.months.length - 3));
    range.value = String(opening);
    const read = document.createElement('output');
    read.id = 'window-start-label';
    slide.append(range, read);
    box.append(spans, slide);
    box.addEventListener('input', renderWindowCurve);
    box.addEventListener('change', renderWindowCurve);
    box.dataset.ready = '1';
  }

  const spanInput = box && box.querySelector('input[name="window-span"]:checked');
  const span = spanInput ? Number(spanInput.value) : 3;
  const range = $('window-start');
  // The slider cannot run past the point where the window would fall off the
  // end of the data, and the span changes where that point is.
  const maxStart = Math.max(0, probe.months.length - span);
  if (range) {
    range.max = String(maxStart);
    if (Number(range.value) > maxStart) range.value = String(maxStart);
  }
  const startAt = range ? Number(range.value) : 0;
  const r = windowRetentionCurve(cohorts, { from: probe.months[startAt], span });
  if (!r || !r.curve.length) {
    $('chart-window-curve').innerHTML = '<p class="empty">No cohorts in that window.</p>';
    return;
  }
  const windowLabel = r.span === 1
    ? fmt.monthLabel(r.start)
    : `${fmt.monthLabel(r.start)} to ${fmt.monthLabel(r.end)}`;
  if ($('window-start-label')) $('window-start-label').textContent = windowLabel;

  const labels = r.reference.map(p => `M${p.age}`);
  const pick = (points, key, want) => labels.map((_, age) => {
    const p = points.find(x => x.age === age);
    if (!p) return null;
    if (want === 'measured' && p.forecast) return null;
    if (want === 'carried' && !p.forecast) {
      const next = points.find(x => x.age === age + 1);
      return next && next.forecast ? p[key] : null;
    }
    return p[key];
  });

  const series = [
    { label: `${windowLabel} intake`, colour: INK.primary,
      values: pick(r.curve, 'value', 'measured') },
    { label: 'Every intake, for comparison', colour: INK.tertiary, dashed: true, thin: true,
      values: r.reference.map(p => p.value) },
  ];
  const carried = pick(r.curve, 'value', 'carried');
  if (carried.some(v => v !== null && Number.isFinite(v))) {
    series.splice(1, 0, { label: `${windowLabel}, carried forward`, colour: INK.primary,
                          dashed: true, values: carried });
  }

  multiLineChart($('chart-window-curve'), {
    yTitle: 'Share of opening revenue still arriving',
    labels,
    yMin: 0,
    yMax: 1,
    yFormat: v => fmt.pct(v, 0),
    xTitle: 'Months since first revenue',
    series,
    legendItems: [
      { label: `${windowLabel} intake`, colour: INK.primary },
      { label: 'Every intake', colour: INK.tertiary },
    ],
    describe: age => {
      const p = r.curve.find(x => x.age === age);
      const ref = r.reference.find(x => x.age === age);
      if (!p) {
        return `<strong>Month ${age}</strong>`
          + (ref ? `<span class="muted">Every intake: ${fmt.pct(ref.value, 1)}</span>` : '');
      }
      return `<strong>Month ${age} after signing</strong>`
        + (p.forecast
            ? `<span class="muted">${windowLabel}: ${fmt.pct(p.value, 1)} carried from month `
              + `${p.from}`
              + (p.lo !== null ? `, ${fmt.pct(p.lo, 0)} to ${fmt.pct(p.hi, 0)} at 95%` : '')
              + `</span>`
            : `<span>${windowLabel}: ${fmt.pct(p.value, 1)} of its revenue still arriving`
              + (p.logos !== null ? `, ${fmt.pct(p.logos, 1)} of its logos` : '') + `</span>`)
        + (ref ? `<span class="muted">Every intake at this age: ${fmt.pct(ref.value, 1)}`
                 + `</span>` : '');
    },
  });

  const year = r.atYear;
  const refYear = r.reference.find(p => p.age === 12);
  const gap = year && refYear ? (year.value - refYear.value) * 100 : null;
  const carriedCount = r.curve.filter(p => p.forecast).length;

  $('window-curve-finding').innerHTML =
    `<strong>${r.cohorts} intake${r.cohorts === 1 ? '' : 's'} signed between `
    + `${windowLabel}: ${fmt.int(r.logos)} customers on ${fmt.money(r.startingRevenue)} of `
    + `opening revenue.</strong> `
    + (year
        ? `A year in they ${year.forecast ? 'are on track to keep' : 'kept'} `
          + `${fmt.pct(year.value, 0)} of it`
          + (year.forecast && year.lo !== null
              ? ` on a range of ${fmt.pct(year.lo, 0)} to ${fmt.pct(year.hi, 0)}`
              : '')
          + (gap !== null
              ? `, against ${fmt.pct(refYear.value, 0)} for the book as a whole, `
                + `${Math.abs(gap).toFixed(0)} points ${gap < 0 ? 'worse' : 'better'}. `
              : '. ')
        : '')
    + `Measured out to month ${r.anchorAge}, as far as every intake in the window has lived`
    + (carriedCount
        ? `, then carried along the average shape for ${carriedCount} more, with a per-month `
          + `correction and a range measured the way chart 45 measures its own. `
        : `. `)
    + `Move the slider to walk the window through the book. What the forecast should be built `
    + `on is whichever window you think looks like the customers you are signing now, not the `
    + `dashed line, which has two years of better cohorts in it.`;

  $('window-curve-note').textContent =
    'One window of signing months at a time, blended into a single curve, against every intake '
    + 'blended as a dashed reference. The slider moves the window through the book and the '
    + 'radio buttons set how many signing months it covers: three months is responsive and '
    + 'noisy, twelve is smooth and slow to notice a change. The base is what those intakes '
    + 'were paying when they arrived and the line is how much of those same dollars is still '
    + 'arriving at each age. Each customer is capped at what they started on, so expansion '
    + 'cannot lift the line above its own base, and the loss counts both a customer leaving '
    + 'and a customer staying on less. A window is measured only as far as its own youngest '
    + 'cohort has lived, so every solid point rests on every intake in it; past that the line '
    + 'is dashed and carried along the reference shape, with a per-month correction and a 95% '
    + 'range measured across every cohort the way chart 45 measures its own. The slider opens '
    + 'on the newest window with a full measured year. A narrow '
    + 'window near the right-hand end of the slider is carried a long way on very little, so '
    + 'read the range rather than the point. Customers already present in the first month of '
    + 'the window have no knowable start date and are in no cohort.';
}

// 47. Every lever, against what it does to revenue.
const MEASURES = [
  { key: 'mrr', label: 'Revenue', headline: 'Monthly recurring revenue',
    blurb: 'What the book bills a month. The line at a million is the target.',
    yTitle: 'Monthly recurring revenue', format: v => fmt.money(v) },
  { key: 'contribution', label: 'After costs', headline: 'Revenue less cost to serve and acquisition',
    blurb: 'Cost to serve is chart 48’s rollup: platform per active customer and revenue '
      + 'share on revenue at their six-month rates, support, G&A and R&D payroll held at the '
      + 'last three months. Acquisition spend is held at its last three months because it '
      + 'is mostly salaries.',
    yTitle: 'Monthly contribution', format: v => fmt.money(v) },
  { key: 'logos', label: 'Customers', headline: 'Active customers on the book',
    blurb: 'Head count, on the same churn and arrival assumptions as the revenue.',
    yTitle: 'Active customers', format: v => fmt.int(v) },
];
const leverState = { card: 'band', floor: 1500, ceiling: 2500, measure: 'mrr',
                     costBasis: 'staffed',
                     churn: { trend: true }, prospects: { expected: true } };

function renderLevers() {
  if (!$('chart-levers')) return;
  const probe = leverProjection(data, cohorts, {});
  if (!probe) {
    $('chart-levers').innerHTML = '<p class="empty">Not enough history yet.</p>';
    return;
  }
  const outlook = probe.outlook;

  const singleSelect = (id, list, stateKey, onPick) => {
    const box = $(id);
    if (!box) return;
    if (!box.dataset.ready) {
      list.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'scenario-card';
        b.dataset.key = c.key;
        b.innerHTML = `<strong>${c.label}</strong><span>${c.headline}</span>`
          + `<em>${c.detail || c.blurb}</em>`;
        box.append(b);
      });
      box.addEventListener('click', event => {
        const b = event.target.closest('.scenario-card');
        const c = b && list.find(x => x.key === b.dataset.key);
        if (!c) return;
        onPick(c);
        renderLevers();
      });
      box.dataset.ready = '1';
    }
    [...box.querySelectorAll('.scenario-card')].forEach(b => {
      b.classList.toggle('is-on', b.dataset.key === leverState[stateKey]);
    });
  };
  singleSelect('lever-cards', SCENARIO_CARDS, 'card', c => {
    leverState.card = c.key;
    leverState.floor = c.floor;
    leverState.ceiling = c.ceiling;
  });
  singleSelect('lever-measure', MEASURES, 'measure', c => { leverState.measure = c.key; });
  // The cost basis lives on chart 48, where the costs are, but chart 47's
  // after-costs view follows it so the two never disagree.
  singleSelect('cost-basis', COST_BASES, 'costBasis', c => { leverState.costBasis = c.key; });

  // Each switch is a card with its own reasoning under it, so a reader who has
  // never seen the page knows what "trying hard" means before they tick it.
  // They multi-select: every combination ticked is a line.
  const drift = probe.drift || 0;
  const driftSe = probe.driftSe || 0;
  const yearly = perMonth => (Math.exp(perMonth * 12) - 1) * 100;
  const signed = v => (v >= 0 ? '+' : '\u2212') + Math.abs(v).toFixed(1) + '%';
  const numberFor = m => {
    if (m.key === 'trend') return `Churn ${signed(yearly(drift))} a year`;
    if (m.key === 'effort') return `Churn ${signed(yearly(drift + 1.96 * driftSe))} a year`;
    if (m.key === 'expected') return `${fmt.int(outlook ? outlook.base : 30)} new customers a month`;
    if (m.key === 'upper') {
      return `${fmt.int(outlook ? outlook.base + 1.96 * outlook.sd : 40)} new customers a month`;
    }
    return m.label;
  };
  const toggles = (id, list, stateKey, defaultKey) => {
    const box = $(id);
    if (!box || box.dataset.ready) return;
    const grid = document.createElement('div');
    grid.className = 'scenario-cards toggle-cards';
    list.forEach(m => {
      const card = document.createElement('label');
      card.className = 'scenario-card toggle-card';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = m.key;
      input.checked = m.key === defaultKey;
      card.append(input);
      const body = document.createElement('div');
      body.innerHTML = `<strong>${m.numbered ? numberFor(m) : m.label}</strong>`
        + `<span>${m.numbered ? m.label + ' \u00b7 ' + m.headline : m.headline}</span>`
        + `<em>${m.blurb}</em>`;
      card.append(body);
      grid.append(card);
    });
    box.append(grid);
    box.addEventListener('change', () => {
      leverState[stateKey] = Object.fromEntries(
        [...box.querySelectorAll('input:checked')].map(i => [i.value, true]));
      [...box.querySelectorAll('.toggle-card')].forEach(c => {
        c.classList.toggle('is-on', c.querySelector('input').checked);
      });
      renderLevers();
    });
    [...box.querySelectorAll('.toggle-card')].forEach(c => {
      c.classList.toggle('is-on', c.querySelector('input').checked);
    });
    box.dataset.ready = '1';
  };
  toggles('lever-churn', CHURN_MODES, 'churn', 'trend');
  toggles('lever-prospects', PROSPECT_MODES, 'prospects', 'expected');
  const churnOn = CHURN_MODES.filter(m => leverState.churn[m.key]);
  const churnModes = churnOn.length ? churnOn : [CHURN_MODES[0]];
  const prosOn = PROSPECT_MODES.filter(m => leverState.prospects[m.key]);
  const prosModes = prosOn.length ? prosOn : [PROSPECT_MODES[0]];

  const setBox = $('lever-settings');
  if (setBox && !setBox.dataset.ready) {
    setBox.innerHTML =
      '<div class="chart-control range-pair-row">'
      + '<label for="lever-band-lo">The band you will price inside</label>'
      + '<div class="range-pair">'
      + '<div class="range-fill" id="lever-band-fill"></div>'
      + '<input type="range" id="lever-band-lo" min="800" max="3000" step="25">'
      + '<input type="range" id="lever-band-hi" min="800" max="3000" step="25">'
      + '</div>'
      + '<output id="lever-band-value"></output></div>';
    setBox.addEventListener('input', event => {
      leverState.card = null;
      const GAP = 100;
      if (event.target.id === 'lever-band-lo') {
        leverState.floor = Math.min(Number(event.target.value), leverState.ceiling - GAP);
      } else {
        leverState.ceiling = Math.max(Number(event.target.value), leverState.floor + GAP);
      }
      renderLevers();
    });
    setBox.dataset.ready = '1';
  }
  if ($('lever-band-lo')) $('lever-band-lo').value = String(leverState.floor);
  if ($('lever-band-hi')) $('lever-band-hi').value = String(leverState.ceiling);
  if ($('lever-band-fill')) {
    const lo = $('lever-band-lo');
    const min = Number(lo.min);
    const span = Number(lo.max) - min;
    const a = ((leverState.floor - min) / span) * 100;
    const b = ((leverState.ceiling - min) / span) * 100;
    $('lever-band-fill').style.left = a.toFixed(2) + '%';
    $('lever-band-fill').style.width = Math.max(0, b - a).toFixed(2) + '%';
  }

  const measure = MEASURES.find(m => m.key === leverState.measure) || MEASURES[0];
  const colours = { trend: INK.primary, effort: INK.positive };
  const runs = [];
  for (const pm of prosModes) {
    for (const cm of churnModes) {
      runs.push({ pm, cm, r: leverProjection(data, cohorts, {
        floor: leverState.floor, ceiling: leverState.ceiling,
        prospects: pm.key, churn: cm.key, costBasis: leverState.costBasis,
      }) });
    }
  }
  const lead = runs[0].r;
  const at = (x, key, i) => x.r.paths[x.cm.key][key][i];
  if ($('lever-band-value')) {
    $('lever-band-value').textContent = fmt.money(leverState.floor) + ' to '
      + fmt.money(leverState.ceiling) + ' · ' + fmt.int(lead.settledVolume)
      + ' close a month at ' + fmt.money(lead.settledPrice);
  }

  const labels = lead.path.map((_, i) => `M${i + 1}`);
  const refs = measure.key === 'mrr'
    ? [{ value: 1e6, label: 'A million a month' },
       { value: lead.book, label: 'Where the book is today', variant: 'soft' }]
    : measure.key === 'logos'
      ? [{ value: lead.logosNow, label: 'Customers today', variant: 'soft' }]
      : [{ value: 0, label: 'Break-even', variant: 'soft' },
         { value: lead.book - lead.logosNow * lead.servePerLogo - lead.acquisitionPerMonth,
           label: 'Today, on the same basis', variant: 'soft' }];
  const drawn = runs.flatMap(x => x.r.paths[x.cm.key][measure.key]);
  multiLineChart($('chart-levers'), {
    labels,
    yMin: Math.min(0, ...drawn),
    yTitle: measure.yTitle,
    xTitle: 'Months from today',
    yFormat: measure.format,
    series: runs.map(x => ({
      label: `${numberFor(x.cm)}, ${numberFor(x.pm).toLowerCase()}`,
      colour: colours[x.cm.key] || INK.primary,
      dashed: x.pm.key === 'upper',
      values: x.r.paths[x.cm.key][measure.key],
    })),
    refs,
    describe: i => `<strong>Month ${i + 1}</strong>`
      + runs.map(x => `<span>${x.cm.label}, ${x.pm.label.toLowerCase()}: `
        + `${fmt.money(at(x, 'mrr', i))} revenue, ${fmt.int(at(x, 'logos', i))} customers, `
        + `${fmt.money(at(x, 'contribution', i))} after costs</span>`).join('')
      + (outlook && outlook.forward[i]
          ? `<span class="muted">${fmt.int(outlook.forward[i].expected)} new customers expected `
            + `that month, up to ${fmt.int(outlook.forward[i].hi)}</span>` : ''),
  });

  const card = SCENARIO_CARDS.find(c => c.key === leverState.card);
  const reached = runs.filter(x => x.r.reaches[x.cm.key]);
  const m12 = i => runs.map(x => ({ x, mrr: at(x, 'mrr', i), logos: at(x, 'logos', i),
                                    contribution: at(x, 'contribution', i) }));
  const first12 = m12(11)[0];
  $('levers-finding').innerHTML =
    (card ? `<strong>${card.label}.</strong> ` : '<strong>Band set by hand.</strong> ')
    + `Matching willingness to pay between ${fmt.money(lead.ceiling)} and `
    + `${fmt.money(lead.floor)} closes about ${fmt.int(lead.settledVolume)} a month at an `
    + `average of ${fmt.money(lead.settledPrice)}, which is ${fmt.money(lead.newMrr)} of new `
    + `revenue a month. `
    + (reached.length
        ? `<strong>${reached.map(x => `${x.cm.label}, ${x.pm.label.toLowerCase()} reaches a `
            + `million in month ${x.r.reaches[x.cm.key]}`).join('; ')}.</strong> `
        : `<strong>Nothing on screen reaches a million inside ${lead.months} months.</strong> `)
    + `A year out on the first line drawn, the book is ${fmt.int(first12.logos)} customers `
    + `against ${fmt.int(lead.logosNow)} today, and after ${fmt.money(lead.servePerLogo)} a `
    + `month to serve each of them and ${fmt.money(lead.acquisitionPerMonth)} a month of `
    + `acquisition spend it contributes ${fmt.money(first12.contribution)} a month. `
    + `Acquisition spend is mostly salaries, so cost per new customer is spend divided by `
    + `closes: ${fmt.money(lead.cacNow)} over the last six months, and it rises in any month `
    + `closes fall.`;

  const rows = runs.map(x =>
    `<tr><td>${x.cm.label}, ${x.pm.label.toLowerCase()}</td>`
    + `<td class="n">${fmt.money(at(x, 'mrr', 5))}</td>`
    + `<td class="n">${fmt.money(at(x, 'mrr', 11))}</td>`
    + `<td class="n">${fmt.money(at(x, 'mrr', lead.months - 1))}</td>`
    + `<td class="n">${fmt.int(at(x, 'logos', 11))}</td>`
    + `<td class="n">${fmt.money(at(x, 'contribution', 11))}</td>`
    + `<td class="n">${x.r.reaches[x.cm.key] ? 'month ' + x.r.reaches[x.cm.key]
        : 'not inside ' + lead.months + ' months'}</td></tr>`);
  $('levers-table').innerHTML =
    '<thead><tr><th>Assumptions</th><th class="n">Revenue, 6 mo</th><th class="n">12 mo</th>'
    + `<th class="n">${lead.months} mo</th><th class="n">Customers, 12 mo</th>`
    + '<th class="n">After costs, 12 mo</th><th class="n">Reaches a million</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody>`;

  $('levers-note').textContent =
    'Three inputs. The band is the price range you will sell inside: everyone above the '
    + 'floor pays what they are willing to, capped at the top. Churn is the measured trend in '
    + 'how fast revenue falls away after signing, and trying hard is the top of that '
    + 'estimate’s 95% interval. New customers a month is the last six months with the '
    + 'season taken out and put back, and the upper end is the top of its 95% interval. '
    + 'One assumption sits underneath: how demand falls with price is September’s slope, '
    + 'nine at $2,500 against fourteen at a $1,500 floor, and how many close at the tested '
    + 'band in a full month is set at twenty-five, the middle of what the business expects. '
    + 'The year’s own prices cannot answer either, because they are a price list rather '
    + 'than a market: forty customers at exactly $1,000 and a hundred and seventy-nine of two '
    + 'hundred and twenty-six on one of fifteen round numbers. Customers follow the same '
    + 'cohorts in head count, by survival. Cost to serve is the same rollup chart 48 draws, '
    + 'platform per active customer at its six-month rate, revenue share at the median of '
    + 'its six-month rate on revenue, and support, G&A and R&D payroll held at the last three '
    + 'months, so it includes overhead and divides by every active customer rather than '
    + 'chart 39’s paying ones. Acquisition is the last three months of spend held flat, '
    + 'because it is mostly salaries and the last quarter is the staffing there is now. '
    + 'After costs is on recurring revenue '
    + 'only: usage, one-off and pass-through revenue are not in it, and they run at about a '
    + 'tenth on top, so a month that reads just below break-even here is about level in cash. '
    + 'The book already on the shelf decays '
    + 'along the capped revenue retention of every cohort blended together, '
    + 'and new business along the curve of the six newest cohorts with a full year behind '
    + 'them, each carried forward with a per-month correction measured across every cohort '
    + 'the way chart 45 measures its own.';

  renderCostForecast({ ...lead.paths[churnModes[0].key], book: lead.book });
}

// 48. Where the costs go, twelve months out. Follows chart 47's levers.
function renderCostForecast(projection) {
  if (!$('chart-cost-forecast') || !projection) return;
  const basis = leverState.costBasis;
  const f = costForecast(data, projection, { months: 12, basis });
  const other = costForecast(data, projection, {
    months: 12, basis: basis === 'scales' ? 'staffed' : 'scales',
  });
  if (!f) {
    $('chart-cost-forecast').innerHTML = '<p class="empty">No expense lines in this push.</p>';
    return;
  }
  const labels = f.revenuePath.map((_, i) => `M${i + 1}`);
  multiLineChart($('chart-cost-forecast'), {
    labels,
    yMin: Math.min(0, ...f.contributionPath),
    yTitle: 'Dollars a month',
    xTitle: 'Months from today',
    yFormat: fmt.money,
    series: [
      { label: 'Recurring revenue', colour: INK.primary, values: f.revenuePath },
      { label: 'All cash costs', colour: INK.negative, values: f.totalPath },
      { label: 'Of which acquisition', colour: INK.negative, dashed: true, thin: true,
        values: f.acquisitionPath },
      { label: 'Contribution', colour: INK.positive, values: f.contributionPath },
    ],
    refs: [{ value: 0, label: 'Break-even', variant: 'soft' }],
    describe: i => `<strong>Month ${i + 1}</strong>`
      + `<span>Revenue ${fmt.money(f.revenuePath[i])}</span>`
      + f.groups.map(g => `<span class="${g.nonCash ? 'muted' : ''}">${g.label}: `
        + `${fmt.money(g.path[i])}${g.nonCash ? ', non-cash' : ''}</span>`).join('')
      + `<span><strong>Contribution ${fmt.money(f.contributionPath[i])}</strong></span>`,
  });

  const driverWord = { fixed: 'Held flat', perLogo: 'Per customer', perRevenue: 'On revenue' };
  const basisCard = COST_BASES.find(b => b.key === basis) || COST_BASES[0];
  const otherCard = COST_BASES.find(b => b.key !== basis) || COST_BASES[1];
  const row = g =>
    `<tr${g.nonCash ? ' class="muted"' : ''}><td>${g.label}</td>`
    + `<td>${driverWord[g.driver]}${g.driver === 'perLogo'
        ? ` · ${fmt.money(g.rate)} each` : g.driver === 'perRevenue'
        ? ` · ${fmt.pct(g.rate, 1)}` : ''}</td>`
    + `<td class="n">${fmt.money(g.runRate)}</td>`
    + `<td class="n">${fmt.money(g.path[5])}</td>`
    + `<td class="n">${fmt.money(g.path[11])}</td>`
    + `<td class="n">${fmt.money(g.total)}</td></tr>`;
  const cash = f.groups.filter(g => !g.nonCash);
  const sum = (key, i) => cash.reduce((s, g) => s + (i === null ? g[key] : g[key][i]), 0);
  $('cost-forecast-table').innerHTML =
    '<thead><tr><th>Cost group</th><th>Moves with</th><th class="n">Run rate now</th>'
    + '<th class="n">Month 6</th><th class="n">Month 12</th><th class="n">Twelve months</th>'
    + '</tr></thead><tbody>'
    + f.groups.map(row).join('')
    + `<tr><td><strong>All cash costs</strong></td><td></td>`
    + `<td class="n"><strong>${fmt.money(sum('runRate', null))}</strong></td>`
    + `<td class="n"><strong>${fmt.money(sum('path', 5))}</strong></td>`
    + `<td class="n"><strong>${fmt.money(sum('path', 11))}</strong></td>`
    + `<td class="n"><strong>${fmt.money(sum('total', null))}</strong></td></tr>`
    + `<tr><td><strong>Recurring revenue</strong></td><td></td>`
    + `<td class="n">${fmt.money(projection.book || f.revenuePath[0])}</td>`
    + `<td class="n">${fmt.money(f.revenuePath[5])}</td>`
    + `<td class="n">${fmt.money(f.revenuePath[11])}</td>`
    + `<td class="n">${fmt.money(f.revenuePath.reduce((a, b) => a + b, 0))}</td></tr>`
    + `<tr><td><strong>Contribution</strong></td><td></td>`
    + `<td class="n">${fmt.money((projection.book || f.revenuePath[0]) - sum('runRate', null))}</td>`
    + `<td class="n"><strong>${fmt.money(f.contributionPath[5])}</strong></td>`
    + `<td class="n"><strong>${fmt.money(f.contributionPath[11])}</strong></td>`
    + `<td class="n"><strong>${fmt.money(f.contributionPath.reduce((a, b) => a + b, 0))}</strong></td></tr>`
    + '</tbody>';

  const grows = cash.filter(g => g.path[11] > g.runRate * 1.05)
    .sort((a, b) => (b.path[11] - b.runRate) - (a.path[11] - a.runRate));
  const largest = [...cash].sort((a, b) => b.total - a.total)[0];
  const twelve = sum('total', null);
  const rev12 = f.revenuePath.reduce((a, b) => a + b, 0);
  const otherTwelve = other ? other.totalPath.reduce((a, b) => a + b, 0) : null;
  $('cost-forecast-finding').innerHTML =
    `<strong>${basisCard.label}: on the levers set above, the next twelve months cost `
    + `${fmt.money(twelve)} to run against ${fmt.money(rev12)} of recurring revenue, leaving `
    + `${fmt.money(rev12 - twelve)}.</strong> `
    + (otherTwelve !== null
        ? `${otherCard.label} instead, the same year costs ${fmt.money(otherTwelve)} and leaves `
          + `${fmt.money(rev12 - otherTwelve)}; the ${fmt.money(Math.abs(otherTwelve - twelve))} `
          + `between them is the payroll question. `
        : '')
    + `${largest.label} is the largest line at ${fmt.money(largest.total)}. `
    + (grows.length
        ? `${grows.map((g, i) => (i ? g.label.toLowerCase() : g.label)).join(' and ')} `
          + `${grows.length > 1 ? 'grow' : 'grows'} with the book, from `
          + `${grows.map(g => fmt.money(g.runRate)).join(' and ')} a month now to `
          + `${grows.map(g => fmt.money(g.path[11])).join(' and ')} in month twelve; `
        : '')
    + (basis === 'scales'
        ? `the four payroll lines keep their last-quarter share of revenue, which is what two `
          + `years of history did, so every line moves with the book. `
        : `the four payroll lines are held where the last quarter left them, so the whole `
          + `change in cost is the customer-driven lines following the book. `)
    + `Contribution goes from ${fmt.money((projection.book || f.revenuePath[0]) - sum('runRate', null))} `
    + `a month today to ${fmt.money(f.contributionPath[11])} in month twelve.`;

  $('cost-forecast-note').textContent =
    'The seven groups are chart 33’s, carried forward on whatever actually moves each '
    + 'one. Acquisition, support, general and administrative and research and development '
    + 'are payroll: they step when someone is hired or let go and otherwise sit still, so '
    + 'each is either held at the average of the last three months or carried at its '
    + 'last-quarter share of recurring revenue, and the cards above choose which. Three '
    + 'months rather than six because support has fallen a third in that time and a '
    + 'six-month average would carry staffing that has already gone. Two years of history '
    + 'says these lines ran as a fairly steady share of revenue, acquisition at about a '
    + 'quarter of MRR and G&A at about a fifth, which is the case for the second basis; the '
    + '2026 cuts are the case for the first. Platform cost of sales, software and hosting, '
    + 'follows the customer and is a rate per '
    + 'active logo over the last six months, applied to the customers chart 47 projects. '
    + 'Merchant fees and revenue share follow the bill and are a rate on recurring revenue; the rate is the '
    + 'median of the last six months rather than the mean, because this push pulled August '
    + 'before its revenue-share credit was posted, so August carries the invoice without the '
    + 'credit and the mean would carry it for a year. Depreciation is shown and left out of every total, because it is not '
    + 'cash. Revenue here is recurring only; usage, one-off and pass-through run at about a '
    + 'tenth on top and are not in the contribution line. Chart 47’s after-costs view '
    + 'uses exactly this rollup, so the two agree to the dollar.';
}

// Wide tables on a phone.
//
// Twelve tables on the page and they are not all the same animal. Nine are a
// header row and plain rows, and those stack on a narrow screen: each cell
// becomes a labelled line, the label copied from its column header, the first
// cell the row's heading. Three should not stack and are left to scroll: the
// month-by-month cost matrix with thirty-four columns, where thirty-four
// labelled lines per row would be worse than a sideways scroll; the ledger,
// whose spanning section rows a naive label pass would mislabel; and the calc
// table, which is layout and has no header to take labels from.
//
// Every render on this page writes a table's innerHTML afresh, so the stamping
// is done by an observer on each table rather than by finding every render and
// adding a call. The table element itself is never replaced, only its rows.
const STACK_MAX_COLUMNS = 10;
function stampTable(table) {
  const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  const spans = table.querySelector('[rowspan], [colspan]');
  const eligible = heads.length > 0 && heads.length <= STACK_MAX_COLUMNS && !spans;
  table.classList.toggle('is-stackable', eligible);
  if (!eligible) return;
  for (const row of table.querySelectorAll('tbody tr')) {
    [...row.children].forEach((cell, i) => {
      if (heads[i] !== undefined) cell.dataset.label = heads[i];
    });
  }
}
// The fade on a scrolling table wrapper is only shown when there is something
// to scroll to. Measured, because a table that fits should not look cut off.
function markScrollable() {
  for (const wrap of document.querySelectorAll('.table-scroll')) {
    wrap.classList.toggle('is-scrollable', wrap.scrollWidth > wrap.clientWidth + 1);
  }
}
function watchTables() {
  for (const table of document.querySelectorAll('table.data-table')) {
    stampTable(table);
    new MutationObserver(() => { stampTable(table); markScrollable(); })
      .observe(table, { childList: true, subtree: true });
  }
  markScrollable();
  window.addEventListener('resize', markScrollable);
}

// 43. Billed and not paying.
//
// One month, not a series. The status in the push is each customer's status
// today, stamped onto every month they appear in, so a line of it rose by
// construction: today's flags projected back over a smaller base. See
// pastDueNow. The latest month is the only one it describes.
function renderPastDue() {
  if (!$('chart-pastdue')) return;
  const t = pastDueNow(data);
  if (!t) {
    $('chart-pastdue').innerHTML =
      '<p class="empty">No subscription status in this push.</p>';
    return;
  }

  const bad = s => s === 'past_due' || s === 'unpaid';
  columnChart($('chart-pastdue'), {
    yTitle: `Live logos in ${fmt.monthLabel(t.month)}, by subscription status`,
    labels: t.byStatus.map(b => b.status.replace('_', ' ')),
    values: t.byStatus.map(b => b.n),
    yFormat: fmt.int,
    colourFor: (v, i) => (bad(t.byStatus[i].status) ? INK.negative : INK.tertiary),
    refs: [],
    legendItems: [
      { label: 'Billed and not paying', colour: 'var(--series-neg)' },
      { label: 'Every other status', colour: 'var(--series-3)' },
    ],
    describe: i => {
      const b = t.byStatus[i];
      return `<strong>${b.status.replace('_', ' ')}</strong>`
        + `<span>${fmt.int(b.n)} of ${fmt.int(t.live)} live logos, ${fmt.pct(b.n / t.live, 1)}</span>`;
    },
  });

  $('pastdue-finding').innerHTML =
    '<strong>' + fmt.int(t.atRisk) + ' of ' + fmt.int(t.live) + ' live logos, '
    + fmt.pct(t.share, 1) + ', are being billed and not paying in '
    + fmt.monthLabel(t.month) + '.</strong> ' + fmt.int(t.pastDue) + ' are past due and '
    + fmt.int(t.unpaid) + ' unpaid, carrying ' + fmt.money(t.mrrAtRisk) + ' of MRR that is '
    + 'counted in every revenue figure on this page and is not arriving as cash'
    + (t.due ? ', with ' + fmt.money(t.due) + ' of balance outstanding' : '') + '. '
    + 'A customer stops paying before they cancel, so some of this is churn that has '
    + 'already happened and has not been booked yet. They stay in the base because an '
    + 'invoice going unpaid is a customer with a problem rather than a departure, and '
    + 'treating them as gone would book the loss twice.';

  $('pastdue-note').textContent =
    'This is a snapshot, not a trend. The subscription status in the push is each '
    + 'customer\'s status today, stamped onto every month they appear in: of '
    + fmt.int(t.customersWithStatus) + ' customers carrying a status, '
    + (t.changing
      ? fmt.int(t.changing) + ' carry more than one, so some months may be dated, but most are not. '
      : 'none carries more than one value across their months. ')
    + 'A line through the months would therefore be today\'s flags projected back over a '
    + 'smaller base, and would rise by construction, which is why only the latest month is '
    + 'drawn. Whether the level is rising needs a status as of each month end, which the '
    + 'pipeline does not yet push. The share is against every logo counted present in '
    + fmt.monthLabel(t.month) + '. Departed accounts with an unpaid balance are excluded, '
    + 'because that is a collections question rather than a warning about the standing base.';
}

// 32. Customers present in every count who are paying nothing.
function renderZeroMrr() {
  const rows = zeroMrrShare(data).filter(r => r.base >= 50);
  if (!rows.length) return;

  const labels = rows.map(r => fmt.monthLabel(r.month));
  multiLineChart($('chart-zero-mrr'), {
    yTitle: 'Share of live logos paying nothing',
    labels,
    yFormat: v => fmt.pct(v, 1),
    series: [
      { label: 'Active, but no MRR booked', colour: INK.negative,
        values: rows.map(r => r.share) },
      { label: 'Active, and no money at all', colour: INK.secondary,
        values: rows.map(r => r.noMoneyShare) },
    ],
    describe: i => {
      const r = rows[i];
      return labels[i] + ': ' + fmt.int(r.zero) + ' of ' + fmt.int(r.base)
        + ' active logos (' + fmt.pct(r.share, 1) + ') carry no MRR, and '
        + fmt.int(r.noMoneyAtAll) + ' (' + fmt.pct(r.noMoneyShare, 1)
        + ') have no cash, usage or one-off charges either.';
    },
  });

  const last = rows[rows.length - 1];
  const first = rows[0];
  $('zero-mrr-finding').innerHTML =
    '<strong>' + fmt.pct(last.share, 1) + ' of the active base pays nothing, against '
    + fmt.pct(first.share, 1) + ' at the start of the window.</strong> That is '
    + fmt.int(last.zero) + ' logos counted as present in every logo retention curve on '
    + 'this page and contributing nothing to any revenue curve. '
    + fmt.int(last.noMoneyAtAll) + ' of them have no cash, no usage and no one-off '
    + 'charges at all, which makes them hard to describe as customers in any sense '
    + 'that matters. This is a good part of the gap between the logo lines and the '
    + 'money lines earlier on, and it is the plainest argument for a floor: a customer '
    + 'discounted to nothing still costs what chart 28 says it costs to serve them.';

  $('zero-mrr-note').textContent =
    'Presence on this page is an event type rather than an amount, so a customer '
    + 'booked down to zero is still a live logo in every count that follows. The two '
    + 'lines separate two different problems: the upper one includes customers whose '
    + 'MRR is simply not booked but who are paying in some other way, and the lower '
    + 'one is the subset with nothing attached at all. Months with fewer than fifty '
    + 'active logos are dropped, because a share of a small base moves for reasons '
    + 'that have nothing to do with pricing. '
    // Part of this line is measurement rather than behaviour, and a reader
    // watching it rise deserves to know which part.
    + 'Some of this population is here because the pipeline cannot name what they '
    + 'bought rather than because they stopped paying. A customer whose product the '
    + 'revenue classifier does not recognise carries real cash and no MRR, and reads '
    + 'here as paying nothing. In ' + fmt.monthLabel(last.month) + ' '
    + fmt.int(last.zero - last.noMoneyAtAll) + ' customers carry money of some kind and '
    + 'no MRR, the gap between the two lines, so a rise in the upper line is not '
    + 'automatically customers going quiet: it can equally be the product catalogue '
    + 'moving ahead of the classifier. The ' + fmt.int(neverPaidIds(data).size)
    + ' accounts that never carried a subscription at all are left out of both the count '
    + 'and the base, because they are records to clean up rather than customers who '
    + 'stopped paying. '
    // The other half of the same design limit, computed rather than asserted.
    + (() => {
        const q = silentLogos(data);
        if (!q || !q.silent.length) return '';
        return 'And presence is an event type rather than an amount, so a customer the '
          + 'pipeline has not booked as departed stays a live logo however long they go '
          + 'without paying. ' + fmt.int(q.silent.length) + ' of ' + fmt.int(q.live)
          + ' logos counted live in the trailing month (' + fmt.pct(q.share, 1) + ') have '
          + 'had no cash and no MRR for six months or more, the longest for '
          + q.longest + ' months, carrying ' + fmt.money(q.lifetimeCash) + ' of lifetime '
          + 'cash between them. Some are late payers and some stopped without anyone '
          + 'booking it, and nothing in the data separates the two. They are counted here '
          + 'rather than removed, because deciding that silence is departure would move '
          + 'the base, the churn rate and every per-logo figure on this page.';
      })();
}


// 33. Chart 1 with the assumed margin taken out and every real cost put in.
//
// Chart 1 multiplies revenue by a fixed margin and compares the result against
// acquisition alone, which buries the entire cost of keeping a customer inside
// one number nobody can argue with. Here the numerator is revenue and every
// cost is a line in the denominator that a reader can switch off and watch the
// answer move. Ticking every box is the question "does a customer at these
// prices pay for the whole company", and the default four, acquisition and the
// cost of sales, is the question every outside benchmark actually asks.


const horizonOf = rows => (rows.length ? rows[0].horizon : 60);

function renderFullCost() {
  wireCostToggles();
  const age = Number($('full-cost-age').value);
  $('full-cost-age-value').textContent = age;

  const on = ticked('full-cost-groups');
  const revOn = ticked('full-cost-revenue');

  if (!on.size || !revOn.size) {
    $('chart-full-cost').innerHTML = '<p class="empty">'
      + (!revOn.size
          ? 'No revenue selected, so there is nothing to recover with.'
          : 'No costs selected, so there is nothing to divide by.')
      + '</p>';
    $('full-cost-finding').textContent = '';
    return;
  }

  const rows = fullCostRecovery(data, cohorts,
    { age, groups: on, revenueGroups: revOn });
  const shown = rows.filter(r => r.ratio !== null);
  if (!shown.length) {
    $('chart-full-cost').innerHTML = '<p class="empty">No cohort has reached this age yet.</p>';
    $('full-cost-finding').textContent = '';
    return;
  }

  const verdict = v => (v >= 3 ? INK.positive : v >= 1 ? INK.tertiary : INK.negative);
  const chosen = COST_GROUPS.filter(g => on.has(g.key));

  stackedColumnChart($('chart-full-cost'), {
    yTitle: 'Returned per dollar the cohort has cost',
    labels: shown.map(r => fmt.monthLabel(r.month)),
    observed: shown.map(r => r.observed),
    projected: shown.map(r => r.projected),
    yFormat: v => v.toFixed(1) + 'x',
    colourFor: v => verdict(v),
    refs: [
      { value: 3, label: '3.0x', variant: 'ref-goal' },
      { value: 1, label: '1.0x, cost covered', variant: 'ref-floor' },
    ],
    legendItems: [
      { label: 'At or above 3.0x', colour: 'var(--series-pos)' },
      { label: 'Between 1.0x and 3.0x', colour: 'var(--series-3)' },
      { label: 'Below cost', colour: 'var(--series-neg)' },
      { label: 'Hatched: projected, not yet observed', colour: 'var(--depends)' },
    ],
    columnLabelTitle: 'Months to full break-even',
    columnLabels: shown.map(r =>
      (r.breakEven === null ? r.horizon + '+' : String(r.breakEven))),
    describe: i => {
      const r = shown[i];
      const head = `<strong>${r.month} cohort at month ${age}</strong>
        <span>Returned ${fmt.ratio(r.ratio)} of what it cost</span>`;
      const split = r.complete
        ? '<span class="muted">Fully observed</span>'
        : `<span>Observed ${fmt.ratio(r.observed)} through month ${r.monthsObserved}</span>
           <span>Projected ${fmt.ratio(r.projected)} over the next `
           + `${age - r.monthsObserved} month${age - r.monthsObserved === 1 ? '' : 's'}</span>`;
      return head + split + `
        <span>Revenue per logo ${fmt.money(r.revenuePerLogo)}</span>
        <span>Cost per logo ${fmt.money(r.costPerLogo)}</span>
        <span class="muted">Acquisition ${fmt.money(r.acquisitionPerLogo)}, `
        + `ongoing ${fmt.money(r.ongoingPerLogo)} over ${age} month`
        + `${age === 1 ? '' : 's'}</span>
        <span>${r.breakEven === null
          ? 'Not covered inside ' + r.horizon + ' months'
          : 'Full break-even at month ' + r.breakEven
            + (r.breakEvenProjected ? ', projected' : ', observed')}</span>
        <span class="muted">${fmt.int(r.size)} logos</span>`;
    },
  });

  const above = shown.filter(r => r.ratio >= 1).length;
  const observedAbove = shown.filter(r => (r.observed || 0) >= 1).length;
  const cut = Math.floor(shown.length / 2);
  const avg = (g, k) => g.reduce((s, r) => s + r[k], 0) / g.length;
  const early = avg(shown.slice(0, cut), 'ratio');
  const late = avg(shown.slice(cut), 'ratio');
  const assumed = avg(shown, 'assumedCostShare');

  // What ticking or unticking the boxes actually did, stated in money rather
  // than left for the reader to infer from the bars moving.
  const meanCost = avg(shown, 'costPerLogo');
  const meanAcq = avg(shown, 'acquisitionPerLogo');
  const meanOngoing = avg(shown, 'ongoingPerLogo');

  // Break-even is reported as a median rather than a mean, because the cohorts
  // that never cover themselves have no number to average and dropping them
  // would report the survivors as though they were everybody.
  const covered = shown.filter(r => r.breakEven !== null);
  const never = shown.length - covered.length;
  const ranked = covered.map(r => r.breakEven).sort((a, b) => a - b);
  const median = ranked.length
    ? (ranked.length % 2
        ? ranked[(ranked.length - 1) / 2]
        : (ranked[ranked.length / 2 - 1] + ranked[ranked.length / 2]) / 2)
    : null;
  const observedBreak = covered.filter(r => !r.breakEvenProjected).length;

  $('full-cost-finding').innerHTML =
    `<strong>Charging ${chosen.length} cost group${chosen.length === 1 ? '' : 's'}, `
    + `${above} of ${shown.length} cohorts have covered their cost by month ${age}`
    + (observedAbove < above
        ? `, ${observedAbove} of them on revenue already observed.</strong> `
        : `.</strong> `)
    + `The average cohort has cost ${fmt.money(meanCost)} a logo by then, `
    + `${fmt.money(meanAcq)} to win and ${fmt.money(meanOngoing)} to keep, against `
    + `${fmt.money(avg(shown, 'revenuePerLogo'))} of revenue. The earlier half sits at `
    + `${fmt.ratio(early)} and the later half at ${fmt.ratio(late)}. `
    + (on.has('ga') && on.has('rd')
        ? 'With G&A and R&D switched on this is the whole company, so 1.0x means a '
          + 'customer pays for every desk behind them and not just their own service.'
        : 'G&A and R&D are off, so 1.0x here means a customer covers what it took to '
          + 'win and serve them and nothing else. Switch them on for the question of '
          + 'whether they pay for the company.')
    + (assumed > 0.15
        ? ` At this age ${fmt.pct(assumed)} of the cost side is a carried rate rather `
          + `than a measured one, so read the level loosely and the ordering closely.`
        : '')
    // The row of numbers along the top, summarised. It does not move with the
    // slider: break-even is a property of the cohort, not of the age you
    // happen to be looking at.
    + (median === null
        ? ` No cohort covers itself inside ${horizonOf(shown)} months on these costs.`
        : ` The numbers along the top are months to full break-even, and they do not `
          + `move with the slider. The median cohort covers everything charged here `
          + `in ${median} months`
          + (observedBreak
              ? `, ${observedBreak} of ${covered.length} of them on months the ledger `
                + `has actually seen`
              : ', every one of them on projected months rather than observed ones')
          + (never
              ? `. ${never} of ${shown.length} never cover themselves inside `
                + `${horizonOf(shown)} months and are marked ${horizonOf(shown)}+.`
              : '.'));

  $('full-cost-note').textContent =
    'One bar per cohort, every one measured at the same age, so a young cohort is '
    + 'not penalised for being young. The numerator is revenue rather than gross '
    + 'profit: applying a margin here as well as charging the cost lines would take '
    + 'the same cost off twice. Revenue here is everything a customer pays: '
    + 'subscription, message and AI usage, setup and 10DLC registration, and carrier '
    + 'pass-through. One of those needs flagging where the early columns are '
    + 'concerned: until mid-2025 a joining charge was booked into MRR in a customer’s '
    + 'first month, so every 2024 cohort collects roughly double in month 0 and recovers '
    + 'much of its acquisition cost immediately. That is real money and is counted, but '
    + 'it is a one-off rather than recurring revenue, so it is separated out of MRR and '
    + 'sits under the setup switch. Turning that switch off is the only way to compare a '
    + '2024 cohort with a 2026 one on equal terms, and it moves every 2024 break-even later, '
    + 'by a month or more. The remaining streams are '
    + 'about a tenth more than subscription alone. The cohort charts above count '
    + 'subscription only, so this one reads a little better than they do on the same '
    + 'cohorts, as charts 28, 39, 40, 42 and 49 do on theirs, and the difference is real money '
    + 'rather than a change of method: the hosting and carrier lines in the '
    + 'denominator are largely there to serve exactly that usage. '
    + 'Ongoing costs are charged month by month against the '
    + 'logos still present, at that month’s real cost per active logo, so a cohort '
    + 'that loses customers stops paying for them. Acquisition is charged once, in '
    + 'full, in the month the cohort arrived, and divides by that cohort rather than '
    + 'by the active base. Months a cohort has not lived through yet are projected on '
    + 'the pooled donor path, both the revenue and the logos, because carrying '
    + 'revenue forward while the cost of serving it stops would be the flattering '
    + 'version of this chart. That path is age-specific rather than one churn rate '
    + 'applied flat: each step is the pooled month-to-month ratio at that age, so '
    + 'month 4 is projected on how cohorts behave at month 4. Donors are weighted by '
    + 'recency on a nine month half-life, because a cohort that arrived last month '
    + 'will live in this year’s conditions rather than in 2024’s, and an '
    + 'unweighted pool would project recent intakes on the era chart 8 argues is '
    + 'over. That correction is not a level shift and could not be done with one '
    + 'multiplier: recent cohorts retain better at month 1, because deferred '
    + 'cancellation holds a leaver in for another billing period, and about two '
    + 'points a month worse by months four to seven. Past month 15 the donor pool '
    + 'thins and a single terminal rate takes over, which is the one place a '
    + 'constant churn assumption does any work. Chart 1 and the projected break-even chart '
    + 'still use an unweighted pool, walked on recurring revenue with the joining charge '
    + 'taken out, so they read a little kinder on recent cohorts than this one does. This '
    + 'one walks the booked revenue, because the setup switch decides whether the charge '
    + 'counts. Months past the end of the ledger carry the mean cost '
    + 'rate of the last three, with no age curve at all: the cost side is projected '
    + 'forward just as the revenue side is, and the finding says how much of it is '
    + 'carried rather than measured whenever that passes 15%. The ongoing costs divide by '
    + 'active logos other than the accounts that never carried a subscription, the same '
    + 'count chart 28 uses. The groups partition the '
    + 'expense file: every cost row '
    + 'belongs to exactly one, so ticking everything counts each dollar once and '
    + 'nothing is missed. Revenue and taxes sit outside all of them. '
    + 'The numbers along the top are months to full break-even, the month cumulative '
    + 'revenue first covers cumulative cost with the signup month counted as month 1. '
    + 'They are a property of the cohort rather than of the age being shown, so they '
    + 'do not move when the slider does, only when the cost boxes change. A cohort '
    + 'that never covers itself inside five years is marked 60+ rather than given a '
    + 'number, because that is a different statement from a large one.';
}


// 34, 35 and 36. The next twelve months, on three arrival rates.
//
// Drawn together from one model so the three charts cannot disagree with each
// other: same survival, same pricing curve, same scenarios, one call.
function renderProjection() {
  const p = projectBase(data, { months: 12 });
  if (!p) return;
  const scenarios = arrivalScenarios(data);
  if (!scenarios.length) return;

  const paths = scenarios.map(s => ({ ...s, rows: p.run(s.rate) }));
  const histLabels = p.history.map(h => fmt.monthLabel(h.month));
  const futLabels = paths[0].rows.map(r => fmt.monthLabel(r.month));
  const labels = histLabels.concat(futLabels);
  const pad = new Array(p.history.length - 1).fill(null);
  const palette = [INK.positive, INK.primary, INK.negative];

  // History and projection share an axis, and the observed line is carried one
  // step into the projection so the two visibly join rather than floating
  // apart by a month.
  const joinAt = h => h[h.length - 1];

  const accuracy =
    `Backtested: run from ${fmt.monthLabel(p.backtest.from)} with the arrivals that `
    + `actually happened, this model lands `
    + `${fmt.pct(Math.abs(p.backtest.logoError), 1)} out on logos and `
    + `${fmt.pct(Math.abs(p.backtest.mrrError), 1)} out on revenue after twelve months.`;

  // ---------------------------------------------------------------- 34 logos
  multiLineChart($('chart-projection-logos'), {
    yTitle: 'Live logos',
    labels,
    yFormat: fmt.int,
    series: [
      { label: 'Observed', colour: 'var(--ink)',
        values: p.history.map(h => h.logos).concat(new Array(12).fill(null)) },
      ...paths.map((s, i) => ({
        label: `${s.label} (${s.rate} a month)`,
        colour: palette[i], dashed: true,
        values: pad.concat([joinAt(p.history).logos], s.rows.map(r => r.logos)),
      })),
    ],
    describe: i => {
      if (i < p.history.length) {
        return `<strong>${labels[i]}</strong><span>${fmt.int(p.history[i].logos)} active, observed</span>`;
      }
      const k = i - p.history.length;
      return `<strong>${labels[i]}</strong>`
        + paths.map(s => `<span>${s.label}: ${fmt.int(s.rows[k].logos)}</span>`).join('');
    },
  });

  const now = joinAt(p.history).logos;
  const ends = paths.map(s => s.rows[11].logos);
  const best = Math.max(...ends);
  const worst = Math.min(...ends);
  // How many arrivals a month it would take to stand still, solved by walking
  // the same model rather than by algebra on an average churn rate.
  const holdRate = (() => {
    for (let rate = 0; rate <= 200; rate += 1) {
      const end = p.run(rate)[11].logos;
      if (end >= now) return rate;
    }
    return null;
  })();

  // Written off the model rather than around it. The first draft asserted that
  // the base shrinks on every path, which the numbers immediately contradicted:
  // at the long-run arrival rate it grows. The replacement rate is the honest
  // headline, because it is the one number that does not depend on which
  // scenario a reader believes.
  const above = paths.filter(s => s.rows[11].logos >= now);
  const below = paths.filter(s => s.rows[11].logos < now);
  const move = end => (end - now) / now;

  $('projection-logos-finding').innerHTML =
    (holdRate !== null
      ? `<strong>It takes ${holdRate} new customers a month just to stand still, and the `
        + `last three months have averaged ${(paths.find(s => s.key === 'recent') || paths[0]).rate}.</strong> `
      : '<strong>The base is falling on the rates the business is currently running.</strong> ')
    + `From ${fmt.int(now)} logos today, twelve months out lands between `
    + `${fmt.int(worst)} and ${fmt.int(best)} depending on how many arrive: `
    + paths.map(s => `${s.label.toLowerCase()} at ${s.rate} a month gives `
        + `${fmt.int(s.rows[11].logos)} (${move(s.rows[11].logos) >= 0 ? '+' : ''}`
        + `${fmt.pct(move(s.rows[11].logos), 1)})`).join(', ')
    + '. '
    + (above.length && below.length
        ? `The replacement rate sits inside the range the business has actually run, `
          + `which is the whole finding: ${above.length} of these three paths `
          + `${above.length === 1 ? 'grows' : 'grow'} the base and ${below.length} `
          + `${below.length === 1 ? 'shrinks' : 'shrink'} it, and nothing about retention `
          + `has to change for either to happen. `
        : above.length
          ? 'Every one of these rates grows the base, so the arrival side is not currently '
            + 'the constraint. '
          : 'None of these rates holds the base, so on current retention the business '
            + 'shrinks whatever it sells. ')
    + `Standing still is therefore a sales target rather than a given, and it moves `
    + `whenever retention does: every point of monthly churn avoided lowers the `
    + `${holdRate === null ? 'replacement' : holdRate + ' a month'} it takes to hold.`;

  $('projection-logos-note').textContent =
    'A cohort roll-forward. Every customer sits in a bucket by how many months they '
    + 'have been here; each month a bucket keeps its measured age-specific survival rate '
    + 'and the survivors age by one; a new bucket arrives at age zero. Survival is pooled '
    + 'over every month-pair in the window, and ages with fewer than thirty observations '
    + 'fall back to the blended rate of '
    + fmt.pct(p.blended, 1) + ' rather than carrying a number built on a handful of '
    + 'customers. ' + accuracy + ' The three arrival rates are volumes the business has '
    + 'actually run, not forecasts: new-logo volume is a decision rather than a '
    + 'prediction, which is why it is the one input drawn three ways. Nothing here models '
    + 'a price change, because nothing in the file forecasts one.';

  // ---------------------------------------------------------------- 35 revenue
  multiLineChart($('chart-projection-mrr'), {
    yTitle: 'Monthly recurring revenue',
    labels,
    yFormat: fmt.money,
    series: [
      { label: 'Observed', colour: 'var(--ink)',
        values: p.history.map(h => h.mrr).concat(new Array(12).fill(null)) },
      ...paths.map((s, i) => ({
        label: `${s.label} (${s.rate} a month)`,
        colour: palette[i], dashed: true,
        values: pad.concat([joinAt(p.history).mrr], s.rows.map(r => r.mrr)),
      })),
    ],
    describe: i => {
      if (i < p.history.length) {
        return `<strong>${labels[i]}</strong><span>${fmt.money(p.history[i].mrr)}, observed</span>`;
      }
      const k = i - p.history.length;
      return `<strong>${labels[i]}</strong>`
        + paths.map(s => `<span>${s.label}: ${fmt.money(s.rows[k].mrr)}</span>`).join('');
    },
  });

  const mrrNow = joinAt(p.history).mrr;
  const mrrEnds = paths.map(s => s.rows[11].mrr);
  const mrrBest = Math.max(...mrrEnds);
  const mrrWorst = Math.min(...mrrEnds);
  const logoFall = (now - Math.max(...ends)) / now;
  const mrrFall = (mrrNow - mrrBest) / mrrNow;

  const mrrMove = v => (v - mrrNow) / mrrNow;
  const logoMoveBest = (Math.max(...ends) - now) / now;
  const mrrMoveBest = (mrrBest - mrrNow) / mrrNow;

  // What a logo pays by age, read from the model rather than typed: the typed
  // version said "well over a thousand" where the curve read $936.
  const secondYear = Array.from({ length: 12 }, (_, k) => p.pays(12 + k));
  const ageSentence = `a first-month logo pays ${fmt.money(p.pays(0))} a month and one in its `
    + `second year about ${fmt.money(secondYear.reduce((s, v) => s + v, 0) / secondYear.length)}`;
  const worseEverywhere = paths.every(s => mrrMove(s.rows[11].mrr) < move(s.rows[11].logos));
  const betterEverywhere = paths.every(s => mrrMove(s.rows[11].mrr) >= move(s.rows[11].logos));
  $('projection-mrr-finding').innerHTML =
    (worseEverywhere
      ? `<strong>Revenue does worse than the logo count on every path, because the base is `
        + `ageing and an older logo pays less.</strong> `
      : betterEverywhere
        ? `<strong>Revenue does at least as well as the logo count on every path, because `
          + `the customers arriving pay more than the ones they replace.</strong> `
        : `<strong>Revenue does better than the logo count on some paths and worse on `
          + `others.</strong> `)
    + `From ${fmt.money(mrrNow)} a month today to between ${fmt.money(mrrWorst)} and `
    + `${fmt.money(mrrBest)}: `
    + paths.map(s => `${s.label.toLowerCase()} ${fmt.money(s.rows[11].mrr)} `
        + `(${mrrMove(s.rows[11].mrr) >= 0 ? '+' : ''}${fmt.pct(mrrMove(s.rows[11].mrr), 1)})`)
        .join(', ')
    + '. '
    + (mrrMoveBest < logoMoveBest
        ? `On the best path the base moves ${logoMoveBest >= 0 ? '+' : ''}`
          + `${fmt.pct(logoMoveBest, 1)} while revenue moves `
          + `${mrrMoveBest >= 0 ? '+' : ''}${fmt.pct(mrrMoveBest, 1)}, and the difference is `
          + `mix rather than churn: ${ageSentence}, so replacing an old customer `
          + `with a new one flatters the headcount and not the revenue for long. `
        : `On the best path the base moves ${logoMoveBest >= 0 ? '+' : ''}`
          + `${fmt.pct(logoMoveBest, 1)} and revenue ${mrrMoveBest >= 0 ? '+' : ''}`
          + `${fmt.pct(mrrMoveBest, 1)}: ${ageSentence}, so a path that keeps arriving keeps `
          + `topping the book up with its best-paying customers, and ageing does not cost `
          + `revenue faster than heads. `)
    + `The spread between the best and worst of these three is `
    + `${fmt.money((mrrBest - mrrWorst) * 12)} of annual revenue, which is what the `
    + `arrival rate is worth over a year.`;

  $('projection-mrr-note').textContent =
    'Revenue is the projected logo count at each age multiplied by what a logo of that '
    + 'age actually pays, measured across the last six months so the curve reflects '
    + 'current pricing rather than the whole window’s. That curve falls with age: '
    + ageSentence + ', so a base that is ageing loses revenue even where it '
    + 'holds its headcount. Applied to today\'s base the six-month curve gives '
    + fmt.pct(1 / p.calibration, 1) + ' of what it actually bills, so every path is scaled to '
    + 'start from the observed ' + fmt.money(mrrNow) + ' and only the movement from there is '
    + 'the model\'s; unscaled, every path would start ' + (p.calibration > 1 ? 'below' : 'above')
    + ' today\'s revenue before anybody had left. '
    + 'Same model, same scenarios and same backtest as the chart '
    + 'above. No price change is modelled in either direction.';

  // ---------------------------------------------------------------- 36 cash
  const served = costToServe(data);
  const costPerLogo = served ? served.months.slice(-6)
    .reduce((s, m) => s + m.cogsPerLogo, 0) / 6 : 0;
  // The cost to win a logo from the same function chart 47 uses, over the same
  // six complete months on both sides of the division and the cohort count.
  // This used to divide six months of spend ending in a partial month by six
  // months of summary logos ending a month earlier.
  const acq6 = acquisitionCosts(data, { months: 6, cohorts });
  const cacPerLogo = (() => {
    const counted = acq6.months.map((m, i) => i).filter(i => acq6.logos[i] !== null);
    const spend = counted.reduce((s, i) => s + acq6.totals[i], 0);
    const logos = counted.reduce((s, i) => s + acq6.logos[i], 0);
    return logos ? spend / logos : 0;
  })();

  const net = paths.map(s => ({
    ...s,
    values: s.rows.map(r => r.mrr - r.logos * costPerLogo - s.rate * cacPerLogo),
  }));

  multiLineChart($('chart-projection-cash'), {
    yTitle: 'Monthly contribution after serving and acquiring',
    labels: futLabels,
    yFormat: fmt.money,
    series: net.map((s, i) => ({
      label: `${s.label} (${s.rate} a month)`, colour: palette[i], values: s.values,
    })),
    refs: [{ value: 0, label: 'covers its own costs', variant: 'ref-goal' }],
    describe: i => `<strong>${futLabels[i]}</strong>`
      + net.map(s => `<span>${s.label}: ${fmt.money(s.values[i])} after serving and `
        + `acquiring</span>`).join(''),
  });

  const first = net.map(s => s.values[0]);
  const lastV = net.map(s => s.values[11]);
  const bestEnd = Math.max(...lastV);
  const worstEnd = Math.min(...lastV);
  const cheapest = net[net.length - 1];

  // The first draft said the high-spend path "never catches up", which the
  // numbers contradicted. Whether the lines cross inside the year moves with
  // every push, so the headline branches on it rather than asserting either.
  const top = net[0];
  const bottom = net[net.length - 1];
  const gapAt = k => bottom.values[k] - top.values[k];
  const closed = net[0].values.findIndex((_, k) => gapAt(k) <= 0);
  const cum = s => s.values.reduce((a, v) => a + v, 0);

  const cumGap = cum(bottom) - cum(top);
  $('projection-cash-finding').innerHTML =
    (closed >= 0
      ? `<strong>Spending more on acquisition costs ${fmt.money(gapAt(0))} a month at the `
        + `start, and the two paths cross in month ${closed + 1}: by the end of the year the `
        + `higher rate is ${fmt.money(-gapAt(11))} a month ahead.</strong> `
      : `<strong>Spending more on acquisition costs ${fmt.money(gapAt(0))} a month at the `
        + `start and ${fmt.money(gapAt(11))} a month by the end of the year.</strong> `)
    + `At ${fmt.money(cacPerLogo)} to win a logo and ${fmt.money(costPerLogo)} a month to `
    + `serve one, ${top.rate} arrivals a month starts at ${fmt.money(top.values[0])} and `
    + `ends at ${fmt.money(top.values[11])}, while ${bottom.rate} a month starts at `
    + `${fmt.money(bottom.values[0])} and ends at ${fmt.money(bottom.values[11])}. `
    + (closed >= 0 ? ''
      : `The gap has closed from ${fmt.money(gapAt(0))} to ${fmt.money(gapAt(11))}, so `
        + `the crossover sits outside this window. `)
    + (cumGap >= 0
      ? `Cumulatively the cheaper path is still ${fmt.money(cumGap)} ahead over the year, `
        + `which is the price of growth rather than an argument against it: the spend that `
        + `looks expensive here is what fills the cohorts chart 33 follows to break-even. `
      : `Cumulatively the higher rate is already ${fmt.money(-cumGap)} ahead over the year. `)
    + `<strong>The real conclusion is about retention, not `
    + `acquisition.</strong> Both paths flatten toward the same number because the base `
    + `underneath them is decaying at the same rate, and no arrival rate in this range `
    + `changes that.`;

  $('projection-cash-note').textContent =
    'Projected revenue less the cost of serving the projected base less the cost of '
    + 'acquiring that month’s new logos, at '
    + fmt.money(costPerLogo) + ' per active logo a month and ' + fmt.money(cacPerLogo)
    + ' per logo started, both over the last six complete months. It is a monthly contribution '
    + 'line and not a cash-flow forecast: it excludes G&A and R&D, which are real and '
    + 'add roughly ' + (served ? fmt.money(served.months.slice(-1)[0].opexPerLogo) : '--')
    + ' per active logo a month, and it excludes everything the business does that is not '
    + 'winning or serving customers. Acquisition is charged in the month the logo arrives '
    + 'even though the return arrives over the following year, which is what makes the '
    + 'higher arrival rates look worse inside a twelve-month window and better outside '
    + 'one.';
}


// 37 and 38. Which customers are worth keeping, and what to do about the rest.
function renderFloors() {
  const r = repriceOutcomes(data);
  if (!r) return;
  const f = r.floors;

  // ------------------------------------------------------------------ 37
  // Two of the edges are the floors themselves, read from priceFloors, so a
  // band never straddles a verdict. They were typed as the floors of an older
  // push, $120 and $665, and the $300 to $499 band came to straddle a $475
  // allocated floor while being coloured as wholly below it.
  const marginalEdge = Math.ceil(f.marginalFloor);
  const allocatedEdge = Math.ceil(f.allocatedFloor);
  const fixedEdges = [300, 900, 1200, 1600].filter(e => e > marginalEdge && e !== allocatedEdge);
  const edges = [...new Set([0, 1, marginalEdge, allocatedEdge, ...fixedEdges])]
    .sort((a, b) => a - b).concat(Infinity);
  const names = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    if (lo === 0) return 'Pays nothing';
    return hi === Infinity ? `$${lo.toLocaleString()}+`
      : `$${lo.toLocaleString()}-${(hi - 1).toLocaleString()}`;
  });
  const counts = names.map(() => 0);
  const money = names.map(() => 0);
  for (const v of f.paying) {
    for (let i = 1; i < edges.length - 1 + 1; i += 1) {
      if (v >= edges[i] && v < edges[i + 1]) { counts[i] += 1; money[i] += v; break; }
    }
  }
  counts[0] = f.zeros;

  // Three colours for three verdicts, because the whole chart is an argument
  // about which of them a customer falls into.
  const verdict = i => {
    const lo = edges[i];
    if (lo < f.marginalFloor) return INK.negative;
    if (lo < f.allocatedFloor) return INK.secondary;
    return INK.positive;
  };

  columnChart($('chart-floor'), {
    yTitle: 'Customers in the band',
    labels: names,
    values: counts,
    yFormat: fmt.int,
    colourFor: (v, i) => verdict(i),
    refs: [],
    legendItems: [
      { label: `Costs more than it brings, below ${fmt.money(f.marginalFloor)}`,
        colour: 'var(--series-neg)' },
      { label: `Contributes cash but not its share of the company`,
        colour: 'var(--series-2)' },
      { label: `Covers everything, above ${fmt.money(f.allocatedFloor)}`,
        colour: 'var(--series-pos)' },
    ],
    describe: i => `<strong>${names[i]}</strong>`
      + `<span>${fmt.int(counts[i])} customers, `
      + `${fmt.pct(counts[i] / (f.paying.length + f.zeros), 1)} of the base</span>`
      + `<span>${fmt.money(money[i])} a month between them, `
      + `${fmt.pct(money[i] / f.totalMrr, 1)} of revenue</span>`
      + (edges[i] < f.marginalFloor
          ? '<span class="muted">Below the marginal floor: leaving would save money</span>'
          : edges[i] < f.allocatedFloor
            ? '<span class="muted">Above marginal, below allocated: worth keeping, worth re-pricing</span>'
            : '<span class="muted">Covers its full allocated cost</span>'),
  });

  const belowMarginal = f.paying.filter(v => v < f.marginalFloor);
  const belowAllocated = f.paying.filter(v => v < f.allocatedFloor);
  const cutList = belowMarginal.length + f.zeros;

  $('floor-finding').innerHTML =
    `<strong>Only ${fmt.int(cutList)} accounts actually cost more than they bring, and `
    + `${fmt.int(f.zeros)} of those already pay nothing.</strong> `
    + `One more or one fewer customer changes ${fmt.money(f.marginalPerLogo)} of licence `
    + `and hosting plus ${fmt.pct(f.variablePct, 1)} of what they pay, so the price at `
    + `which a customer starts putting cash in the bank is `
    + `${fmt.money(f.marginalFloor)} a month, not `
    + `${fmt.money(f.allocatedFloor)}. `
    + `${fmt.int(belowMarginal.length)} paying customers sit under that, between them `
    + `worth ${fmt.money(belowMarginal.reduce((s, v) => s + v, 0))} a month. `
    + `<strong>The other ${fmt.int(belowAllocated.length - belowMarginal.length)} `
    + `customers below the allocated floor are a pricing problem, not a cutting `
    + `problem.</strong> Cutting one of them at ${fmt.money(300)} a month loses `
    + `${fmt.money(300)} and saves ${fmt.money(300 * f.variablePct + f.marginalPerLogo)}, `
    + `because support, customer success, G&A and R&D do not leave with the customer. `
    + `The allocated floor is what to price new business at and what to refuse to `
    + `discount below. It is not a cull list.`;

  $('floor-note').textContent =
    'Every active logo in ' + fmt.monthLabel(f.month) + ', bucketed by what it pays. '
    + 'Two floors, and the difference between them is the point. The marginal floor of '
    + fmt.money(f.marginalFloor) + ' counts only what moves when one customer arrives or '
    + 'leaves: per-seat software at ' + fmt.money(f.components.software) + ' a logo, '
    + 'hosting at ' + fmt.money(f.components.hosting) + ', and the merchant fee and '
    + 'revenue share that follow a payment at ' + fmt.pct(f.variablePct, 1) + ' of it. '
    + 'The allocated floor of ' + fmt.money(f.allocatedFloor) + ' adds support, customer '
    + 'success and G&A spread across the paying base, which is right for '
    + 'pricing and wrong for keep-or-cut, because none of it is saved by losing one '
    + 'customer. R&D is in neither floor: charging tomorrow’s product to today’s '
    + 'customers would conclude that a company investing in product has worse unit '
    + 'economics than one that is not. Acquisition is not in either floor: it belongs '
    + 'to the cohort that caused it, which is chart 33. Of the fixed cost, roughly '
    + fmt.money(f.removablePayrollPerLogo) + ' a logo is payroll that could come out if '
    + 'enough customers went for headcount to follow. That is a step change across '
    + 'hundreds of accounts, not a saving available one at a time. The two lowest band '
    + 'edges above zero are the floors themselves, so every bar sits wholly on one side of '
    + 'each. '
    + 'Every rate here is the median of the last six months rather than the pooled '
    + 'mean, because a push taken before a month closes can carry an invoice without '
    + 'the credit that reverses it, which this one does for August, and a mean would '
    + 'count that charge as though it stood.'
    + (f.outliers.length
        ? ' ' + f.outliers.map(o => fmt.monthLabel(o.month) + ' at '
            + fmt.pct(o.rate, 1)).join(', ')
          + ' sits far enough from the median to be one of those, against a usual '
          + fmt.pct(f.variablePct, 1) + '. A median ignores it without anyone having '
          + 'to hand-pick which month to drop.'
        : '');

  // ------------------------------------------------------------------ 38
  const labels = r.acceptance.map(a => fmt.pct(a.rate, 0) + ' accept');
  multiLineChart($('chart-reprice'), {
    yTitle: 'Monthly recurring revenue',
    labels,
    yFormat: fmt.money,
    // The floor the survivors then need is a few hundred dollars on an axis
    // that runs to about $800k, where it drew flat on the baseline. It is in
    // the hover and the finding instead.
    series: [
      { label: 'Monthly revenue after the exercise', colour: INK.primary,
        values: r.acceptance.map(a => a.mrr) },
    ],
    refs: [{ value: f.totalMrr, label: 'revenue today', variant: 'ref-goal' }],
    describe: i => {
      const a = r.acceptance[i];
      return `<strong>${labels[i]}</strong>`
        + `<span>${fmt.int(a.upgraded)} re-priced, ${fmt.int(a.churned)} leave</span>`
        + `<span>${fmt.int(a.logos)} paying logos left</span>`
        + `<span>Revenue ${fmt.money(a.mrr)}, `
        + `${a.change >= 0 ? 'up' : 'down'} ${fmt.money(Math.abs(a.change))}</span>`
        + `<span class="muted">New floor ${fmt.money(a.floor)}</span>`;
    },
  });

  // The last row is the base going into the final round, not what is left
  // after it. When everyone in that round is below the floor the round
  // removes them all, and the base ends at nothing.
  const end = r.spiral[r.spiral.length - 1];
  const emptied = end.below === end.logos;
  const finalCount = end.logos - end.below;
  $('reprice-finding').innerHTML =
    `<strong>Cutting everyone below the allocated floor does not converge: it `
    + `runs the base from ${fmt.int(f.paying.length)} paying logos to `
    + (emptied
      ? `none, over ${r.spiral.length} rounds. The last round starts with `
        + `${fmt.int(end.logos)} logos and every one of them is under a `
        + `${fmt.money(end.floor)} floor.</strong> `
      : `${fmt.int(finalCount)} after ${r.spiral.length} rounds.</strong> `)
    + `The fixed cost stays when the customer goes, so `
    + `every round raises the floor and pushes more customers under it: `
    + r.spiral.slice(0, 4).map(s =>
        `${fmt.int(s.logos)} logos at a ${fmt.money(s.floor)} floor`).join(', then ')
    + `. Re-pricing is the other path, and it turns on how many accept. `
    + (r.breakEven !== null
        ? `<strong>Below about ${fmt.pct(r.breakEven, 0)} acceptance you are worse off `
          + `than doing nothing.</strong> `
        : '')
    + `At full acceptance revenue goes to ${fmt.money(r.acceptance[4].mrr)}, `
    + `${fmt.money(r.acceptance[4].change)} up. At half it is `
    + `${fmt.money(r.acceptance[2].change)}, and the customers who stayed now need `
    + `${fmt.money(r.acceptance[2].floor)} rather than ${fmt.money(f.allocatedFloor)}, `
    + `because the ones who left took their share of the overhead with them and left the `
    + `overhead behind. `
    + `<strong>The cheapest move is neither.</strong> Converting the `
    + `${fmt.int(f.zeros)} accounts that pay nothing adds payers to the denominator `
    + `instead of removing them, which drops the floor for every existing customer from `
    + `${fmt.money(f.allocatedFloor)} to ${fmt.money(r.floorIfZerosConvert)} without `
    + `anyone paying more.`;

  $('reprice-note').textContent =
    'Both paths start from the same place: '
    + fmt.int(r.below.length) + ' paying customers below the allocated floor of '
    + fmt.money(f.allocatedFloor) + ', worth '
    + fmt.money(r.below.reduce((s, v) => s + v, 0)) + ' a month between them. The cutting '
    + 'path removes them, leaves the fixed cost where it is, recomputes the floor on the '
    + 'survivors and repeats. The re-pricing path moves them to the floor and assumes '
    + 'anyone who refuses leaves, cheapest first, which is the kind end of that '
    + 'assumption. Neither models a change in churn behaviour after a price rise, which '
    + 'is the largest thing this cannot tell you: the acceptance rate on the axis is the '
    + 'assumption, not a finding. Acquisition is excluded throughout, so these are '
    + 'operating numbers on the existing book rather than a view of the whole business.';
}


// The upgrade list tab. A working document rather than a chart: the point is
// that somebody can read a row, look the account up and make a call.
function renderUpgradeList() {
  if (!$('list-low-table')) return;
  const l = upgradeList(data, { lowBand: 500, floor: 600, minMrr: 2, minTenure: 12,
    rule: (typeof CAMP !== 'undefined' && CAMP.rule) || 'floor' });
  if (!l) return;

  const money = v => (v ? fmt.money(v) : '–');
  const spark = series => series
    .map(v => (v === null ? '<span class="muted">·</span>' : (v > 0 ? fmt.int(v) : '0')))
    .join(' <span class="muted">→</span> ');

  const table = (rows, target) => {
    const head = '<thead><tr><th>Company</th><th>Stripe ID</th>'
      + '<th class="n">Now</th><th class="n">Settled peak</th>'
      + '<th class="n">Ask for</th><th class="n">Multiple</th><th>Call</th>'
      + '<th class="n">Months here</th><th>Env</th>'
      + '<th>Last six months</th></tr></thead>';
    const body = rows.map(r => '<tr>'
      + `<td>${r.name ? r.name : '<span class="muted">no name in the file</span>'}</td>`
      + `<td class="mono">${r.id}</td>`
      + `<td class="n">${money(r.mrr)}</td>`
      + `<td class="n">${money(r.settledPeak)}</td>`
      + `<td class="n"><strong>${money(r.target)}</strong></td>`
      + `<td class="n">${r.ask === null ? '–' : r.ask.toFixed(1) + 'x'}</td>`
      + `<td>${!r.viable
          ? '<span class="notviable">not viable</span>'
          : r.heldBefore
            ? '<span class="held">held it before</span>'
            : '<span class="muted">new price</span>'}</td>`
      // An account present in the window's first month may be older than the
      // window, so its tenure is a floor and is shown as one.
      + `<td class="n">${r.tenure === null ? '–' : fmt.int(r.tenure) + (r.since === data.historyStarts ? '+' : '')}</td>`
      + `<td>${r.source || '–'}</td>`
      + `<td class="trend">${spark(r.series)}</td>`
      + '</tr>').join('');
    return head + '<tbody>' + body + '</tbody>';
  };

  $('list-low-title').textContent =
    `Paying something, under ${fmt.money(l.lowBand)}: ${fmt.int(l.low.length)} accounts`;
  $('list-low-table').innerHTML = table(l.low, l.lowBand);

  const viable = l.low.filter(r => r.viable);
  const held = l.low.filter(r => r.heldBefore);
  const cleanup = l.low.filter(r => !r.viable);
  $('list-low-finding').innerHTML =
    `<strong>${fmt.int(l.low.length)} accounts are eligible, of which `
    + `${fmt.int(viable.length)} are worth asking and ${fmt.int(held.length)} have already `
    + `held the price.</strong> They pay ${fmt.money(l.totals.lowMrr)} a month between them; `
    + `the ${fmt.int(viable.length)} worth asking pay ${fmt.money(l.totals.lowViableMrr)} and `
    + `their targets sum to ${fmt.money(l.totals.lowViableTarget)}. `
    + `<strong>Start with the "held it before" names.</strong> Asking a customer to return `
    + `to a price they once accepted is a different conversation from inventing one, and `
    + `treating that as half the churn risk is the single assumption this list rests on: `
    + `the first calls will test it. `
    + (cleanup.length
        ? `${fmt.int(cleanup.length)} are marked not viable: reaching the floor would mean `
          + `a multiple nobody is going to ask for and they have never held that price, so `
          + `they are a cancellation decision rather than a sale. `
        : '')
    + `${fmt.int(l.totals.lowBeforeRules - l.low.length)} more sit under `
    + `${fmt.money(l.lowBand)} and are excluded by the eligibility rules: `
    + `${fmt.int(l.totals.excludedTooCheap)} pay ${fmt.money(l.minMrr)} or less, which is a `
    + `free account with a token charge rather than a cheap customer, and `
    + `${fmt.int(l.totals.excludedTooYoung)} are under ${l.minTenure} months old, where `
    + `re-pricing means negotiating against your own onboarding.`;

  // Counted live: the note used to type "33 accounts, $1,200 against $200",
  // which moved with every push.
  const inflated = l.low.filter(r => r.peakEver > r.settledPeak);
  const inflatedGaps = inflated.map(r => r.peakEver - r.settledPeak).sort((a, b) => a - b);
  const worstInflated = inflated.reduce((a, b) =>
    (!a || b.peakEver - b.settledPeak > a.peakEver - a.settledPeak ? b : a), null);
  const capped = l.low.filter(r => r.since === data.historyStarts).length;
  const canonicalHere = l.low.filter(r => r.canonicalId).length;
  $('list-note').textContent =
    'Active accounts in ' + fmt.monthLabel(l.month) + ' paying more than '
    + fmt.money(l.minMrr) + ' and less than ' + fmt.money(l.lowBand)
    + ' a month, with at least ' + l.minTenure + ' months behind them. Every account is asked '
    + 'for the same flat ' + fmt.money(600) + ' under the floor rule, or ' + fmt.money(500)
    + ' at $300 or less and ' + fmt.money(750) + ' above it under the tiered rule; nothing is '
    + 'scaled to the account. The settled peak, the highest month after the first, decides '
    + 'only whether an account has held the price before and whether it is worth asking. The '
    + 'first month is left out of that peak because until mid-2025 a joining charge was '
    + 'booked into MRR there, so a raw peak can be a one-off dressed as a subscription: '
    + (inflated.length
      ? fmt.int(inflated.length) + ' accounts on this list carry an inflated peak, median '
        + fmt.money(inflatedGaps[inflatedGaps.length >> 1]) + ' too high, the worst reading '
        + fmt.money(worstInflated.peakEver) + ' against a settled price of '
        + fmt.money(worstInflated.settledPeak) + '. '
      : 'none on this list does now. ')
    + fmt.money(600) + ' rather than the ' + (() => {
        const pf = priceFloors(data);
        if (!pf) return 'allocated floor';
        // A third of the accounts ASKED, which is the viable ones, not the
        // whole list. The floor is spread over everyone still paying.
        const lost = viable.length / 3;
        const after = (pf.fixedPerMonth / (pf.paying.length - lost)) / (1 - pf.variablePct);
        return fmt.money(pf.allocatedFloor) + ' the cost base needs today, because losing a '
          + 'third of the ' + fmt.int(viable.length) + ' accounts asked pushes that floor to '
          + 'about ' + fmt.money(after);
      })()
    + ' and a target set at the floor would '
    + 'be underwater the month it landed. Charts 37 and 38 have that arithmetic, and '
    + 'tenure and usage were tested as multipliers on top of peak and made the result '
    + 'worse, so they are not used. The Stripe identifier is '
    + 'the one in the billing export and is present for every account. The Chiirp '
    + 'identifier is not in the pushed data for these accounts: canonical_id is populated on '
    + fmt.int(canonicalHere) + ' of the ' + fmt.int(l.low.length) + ' here, so neither the '
    + 'table nor the export carries it. '
    + (l.totals.namesMissing
        ? fmt.int(l.totals.namesMissing) + ' accounts have no company name in the file and '
          + 'will need looking up by Stripe ID. '
        : '')
    + (capped
      ? 'Months here counts from the first month the window holds, so the ' + fmt.int(capped)
        + ' accounts already present then show their count with a plus: they are at least that '
        + 'old. '
      : '')
    + 'The settled peak is over the whole window, so an account showing one above its '
    + 'current figure has paid more at some point rather than always been small; the last six '
    + 'months beside it say whether that was recent. They run '
    + 'oldest to newest and a dot means the account was not active that month. Nothing '
    + 'here is a churn risk score: it is what each account pays against what it costs, '
    + 'and the judgement about which are worth a call is yours.';

  // A sales list that cannot be exported is a list nobody uses.
  const csv = () => {
    const head = ['group', 'company', 'stripe_id', 'mrr_now', 'settled_peak', 'target',
      'ask_multiple', 'held_before', 'viable', 'uplift', 'months_here', 'environment',
      'cash_last_month', 'usage_last_month'].concat(l.window);
    const line = (group, r) => [group, r.name || '', r.id,
      r.mrr, r.settledPeak, r.target, r.ask === null ? '' : r.ask.toFixed(2),
      r.heldBefore ? 'yes' : 'no', r.viable ? 'yes' : 'no',
      Math.max(0, r.target - r.mrr), r.tenure === null ? '' : r.tenure,
      r.source || '', r.cash, r.usage]
      .concat(r.series.map(v => (v === null ? '' : v)))
      .map(v => {
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    return [head.join(',')]
      .concat(l.zeros.map(r => line('pays_nothing', r)))
      .concat(l.low.map(r => line('under_' + l.lowBand, r)))
      .join('\n');
  };

  const button = $('list-download');
  if (button && !button.dataset.ready) {
    button.addEventListener('click', () => {
      const blob = new Blob([csv()], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chiirp-upgrade-list-${l.month}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      $('list-status').textContent =
        `${fmt.int(l.low.length + l.zeros.length)} accounts exported: ${fmt.int(l.low.length)} `
        + `paying under ${fmt.money(l.lowBand)} and ${fmt.int(l.zeros.length)} paying nothing.`;
    });
    button.dataset.ready = '1';
  }
}


// 39. Cost to keep one paying customer, in layers, over time.
function renderOngoing() {
  const rows = ongoingCostPerLogo(data);
  if (!rows || !rows.length) return;
  const labels = rows.map(r => fmt.monthLabel(r.month));

  const layers = [
    { key: 'admin',    label: 'G&A',                 colour: INK.negative },
    { key: 'people',   label: 'Support and success', colour: INK.secondary },
    { key: 'platform', label: 'Platform',            colour: INK.primary },
    { key: 'product',  label: 'R&D',                 colour: INK.accent },
    { key: 'variable', label: 'Merchant and rev share', colour: INK.tertiary },
  ];

  multiLineChart($('chart-ongoing'), {
    // Keep, not serve: the total carries G&A and R&D. Chart 49 leaves both out
    // of what it calls serving, and the floors in chart 37 leave out R&D.
    yTitle: 'Cost to keep one paying logo, per month',
    labels,
    yFormat: fmt.money,
    series: [
      { label: 'What a paying customer pays', colour: 'var(--ink)',
        values: rows.map(r => r.arpa) },
      { label: 'Everything it costs to keep them', colour: INK.negative,
        dashed: true, values: rows.map(r => r.total) },
      ...layers.map(l => ({ label: l.label, colour: l.colour, thin: true,
        values: rows.map(r => r[l.key]) })),
    ],
    describe: i => {
      const r = rows[i];
      return `<strong>${labels[i]}</strong>`
        + `<span>Pays ${fmt.money(r.arpa)}, costs ${fmt.money(r.total)}, `
        + `leaves ${fmt.money(r.arpa - r.total)}</span>`
        + layers.map(l => `<span class="muted">${l.label} ${fmt.money(r[l.key])}</span>`).join('')
        + `<span class="muted">${fmt.int(r.paying)} paying of `
        + `${fmt.int(r.activeLogos)} active</span>`;
    },
  });

  const a = rows[0];
  const b = rows[rows.length - 1];
  // The latest month carries a revenue-share invoice whose credit, dated the
  // 31st inside the month, was posted after this push pulled it, so its
  // variable layer is roughly double. Leading a finding with it would quote the
  // one month on the chart worth distrusting.
  const medianOf = pick => {
    const s = rows.slice(-6).map(pick).sort((x, y) => x - y);
    const i = s.length >> 1;
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
  };
  const typical = medianOf(r => r.total);
  const typicalArpa = medianOf(r => r.arpa);
  // Ranked on the same six-month medians as the headline. Ranking on the raw
  // last month named merchant and revenue share the largest rise on the very
  // month the sentence before it said to distrust.
  const ranked = layers
    .map(l => {
      const to = medianOf(r => r[l.key]);
      return { ...l, from: a[l.key], to, delta: to - a[l.key],
               move: a[l.key] ? (to - a[l.key]) / a[l.key] : null };
    })
    .sort((x, y) => y.delta - x.delta);
  const worst = ranked[0];
  const flattest = [...ranked].sort((x, y) => Math.abs(x.move ?? 0) - Math.abs(y.move ?? 0))[0];
  const overhead = ['admin', 'people'].includes(worst.key);

  $('ongoing-finding').innerHTML =
    `<strong>Keeping a customer cost ${fmt.money(a.total)} a month in `
    + `${fmt.monthLabel(a.month)} and ${fmt.money(typical)} now, while what they pay, `
    + `subscription, usage, setup and pass-through together, went `
    + `from ${fmt.money(a.arpa)} to ${fmt.money(typicalArpa)}.</strong> `
    + `Both figures are the median of the last six months rather than the last one, `
    + `because ${fmt.monthLabel(b.month)} was pulled before its revenue-share credit was `
    + `posted, so it carries the invoice without the credit and reads ${fmt.money(b.total)} as a result. `
    + `Cost per logo has risen `
    + `${fmt.pct((typical - a.total) / a.total, 0)} against `
    + `${fmt.pct((typicalArpa - a.arpa) / a.arpa, 0)} on price, which is `
    + `why the margin has narrowed even though the average customer pays more than they `
    + `used to. `
    // "the whole of the increase" was asserted. Say the share instead, on the
    // medians, so the ranking and the headline read the same months.
    + `<strong>${worst.label} is the largest part of the increase</strong>: `
    + `${fmt.money(worst.from)} to ${fmt.money(worst.to)} a logo on the six-month median, `
    + `${fmt.pct(worst.move, 0)}, which is `
    + `${(() => {
        const rise = ranked.filter(l => l.delta > 0).reduce((s, l) => s + l.delta, 0);
        return rise ? fmt.pct(worst.delta / rise, 0) : 'most';
      })()} of the total rise. `
    + `${ranked[1] && ranked[1].delta > worst.delta * 0.6
        ? `${ranked[1].label} is close behind at ${fmt.money(ranked[1].from)} to `
          + `${fmt.money(ranked[1].to)}, so this is not a single line running away. `
        : ''}`
    + `${flattest.label} has moved least, ${fmt.money(flattest.from)} to `
    + `${fmt.money(flattest.to)}. `
    + (overhead && flattest.key === 'platform'
      ? `So the product scales with the customer count and the company does not. That is `
        + `the distinction worth carrying out of this chart: little of the rise is the cost `
        + `of running software for more people. It is the cost of being a bigger company, `
        + `spread over a base that has stopped growing.`
      : overhead
        ? `Most of the rise is overhead rather than the cost of running software for more `
          + `people: the cost of being a bigger company, spread over a base that has `
          + `stopped growing.`
        : `The largest rise follows the customer rather than the company, so it is a cost `
          + `of serving more usage, not of overhead.`);

  $('ongoing-note').textContent =
    'Every recurring cost the business carries, divided by PAYING logos rather than all of '
    + 'them, because an account at zero MRR cannot carry any of this and dividing by it '
    + 'flatters every month. Acquisition is deliberately absent: it belongs to the cohort '
    + 'that caused it, and chart 33 charges it there. G&A and R&D are in, because this '
    + 'asks what it costs to keep the company running per customer; chart 49 and the floors '
    + 'in chart 37, which ask what a customer costs to serve, leave R&D out, since charging tomorrow\'s product '
    + 'to today\'s customers would make a company investing in product look worse. The '
    + 'layers are exclusive and sum to '
    + 'the dashed line. Platform is per-seat software and hosting; support and success is '
    + 'every person who looks after customers whichever account they sit in; merchant and '
    + 'revenue share are the two costs that follow a payment rather than a customer, so '
    + 'they are the only layer that moves with price. The last month of the variable layer '
    + 'is overstated: QuickBooks dates the credit against that month\'s revenue-share invoice '
    + 'on the 31st, inside the month, but this push pulled the month before the credit was '
    + 'posted. Chart 37 handles it by taking medians, and the next push carries the closed month. '
    + 'Both denominators are shown in the tooltip, because the gap between paying and '
    + 'active logos is itself part of why this line rises.';
}


// 49. What each account costs to keep, month by month, across S1 and S2.
// Chart 39 per account: the same five layers, spread the way each behaves,
// with the accounts that pay less than they cost named underneath.
function renderAccountServe() {
  if (!$('chart-account-serve')) return;
  const a = accountServeCost(data);
  if (!a) {
    $('chart-account-serve').innerHTML = '<p class="empty">No expense lines in this push.</p>';
    return;
  }
  const shown = a.byMonth.slice(-12);
  const labels = shown.map(m => fmt.monthLabel(m.month));
  const env = (m, key, field) => (m.envs[key] ? m.envs[key][field] : null);

  multiLineChart($('chart-account-serve'), {
    labels,
    yTitle: 'Per paying account, a month',
    yFormat: fmt.money,
    series: [
      { label: 'S1 pays', colour: INK.primary, values: shown.map(m => env(m, 'S1', 'revenuePerAccount')) },
      { label: 'S1 costs to keep', colour: INK.primary, dashed: true,
        values: shown.map(m => env(m, 'S1', 'servePerAccount')) },
      { label: 'S2 pays', colour: INK.secondary, values: shown.map(m => env(m, 'S2', 'revenuePerAccount')) },
      { label: 'S2 costs to keep', colour: INK.secondary, dashed: true,
        values: shown.map(m => env(m, 'S2', 'servePerAccount')) },
    ],
    describe: i => {
      const m = shown[i];
      const line = key => {
        const e = m.envs[key];
        if (!e) return `<span class="muted">${key}: no paying accounts</span>`;
        return `<span>${key}: ${fmt.int(e.paying)} paying, pay ${fmt.money(e.revenuePerAccount)}, `
          + `cost ${fmt.money(e.servePerAccount)}, ${fmt.int(e.under)} under water</span>`;
      };
      return `<strong>${labels[i]}</strong>${line('S1')}${line('S2')}`
        + `<span class="muted">Platform ${fmt.money(m.perLogo.platform)}, people `
        + `${fmt.money(m.perLogo.people)} a paying logo; variable `
        + `${fmt.pct(m.variableRate, 1)} of revenue</span>`;
    },
  });

  const l = a.last;
  // The price floors divide the same merchant and revenue-share spend by
  // subscription revenue, chart 49 by everything an account pays. One cost,
  // two denominators, so both are stated rather than one silently differing.
  const floorsRate = (priceFloors(data) || {}).variablePct ?? null;
  const s1 = l.envs.S1;
  const s2 = l.envs.S2;
  const outlier = a.outliers.includes(l.month);
  const paying = a.latest.filter(r => r.paying);
  const underNow = paying.filter(r => r.contribution < 0);
  const underAtMedian = paying.filter(r => r.contributionAtMedianRate < 0);
  const chronic = paying.filter(r => r.monthsUnder >= a.window.length);
  const shortfall = underNow.reduce((s, r) => s - r.contribution, 0);
  const envSentence = (key, e) => (e
    ? `${key === 'S1' ? 'an S1' : 'an S2'} account paid ${fmt.money(e.revenuePerAccount)} and cost `
      + `${fmt.money(e.servePerAccount)} to keep, ${fmt.int(e.under)} of ${fmt.int(e.paying)} under water`
    : `${key} had no paying accounts`);

  $('account-serve-finding').innerHTML =
    `<strong>In ${fmt.monthLabel(l.month)} ${envSentence('S1', s1)}; ${envSentence('S2', s2)}.</strong> `
    + `Between them ${fmt.int(underNow.length)} paying accounts paid less than it cost to keep them, `
    + `a shortfall of ${fmt.money(shortfall)} for the month, and ${fmt.int(chronic.length)} of those `
    + `have been under water in every one of the last ${a.window.length} months. `
    + (outlier
        ? `${fmt.monthLabel(l.month)} carries merchant and revenue-share spend at `
          + `${fmt.pct(l.variableRate, 1)} of all revenue against a usual ${fmt.pct(a.medianRate, 1)} `
          + `(the price floors state the same cost as ${fmt.pct(floorsRate, 1)} of subscription revenue), `
          + `because the push was taken before the month's revenue-share credit was posted, so `
          + `it overstates the variable cost of every account; at the usual rate ${fmt.int(underAtMedian.length)} `
          + `accounts are under water rather than ${fmt.int(underNow.length)}. The table ranks by `
          + `months under water rather than by the one month for that reason. `
        : `The table ranks by months under water, so one odd month cannot put an account on it. `)
    + (s2 && s1
        ? `S2 is ${fmt.int(s2.paying)} accounts against ${fmt.int(s1.paying)}, young and small, so `
          + `its line moves with single customers and is read for direction rather than level.`
        : '');

  const ranked = paying
    .filter(r => r.monthsUnder > 0 || r.contribution < 0)
    .sort((x, y) => (y.monthsUnder - x.monthsUnder) || (x.contribution - y.contribution))
    .slice(0, 25);
  const nameCell = r => `${r.name ? r.name : '<span class="muted">unnamed</span>'}`
    + `<br><span class="mono">${r.id}</span>`;
  $('account-serve-table').innerHTML =
    '<thead><tr><th>Account</th><th>Env</th><th>Status</th><th class="n">MRR</th>'
    + '<th class="n">All revenue</th><th class="n">Costs to keep</th><th class="n">Contribution</th>'
    + `<th class="n">Under, last ${a.window.length}</th></tr></thead><tbody>`
    + ranked.map(r => `<tr><td>${nameCell(r)}</td><td>${r.source || '–'}</td>`
      + `<td class="muted">${r.status || '–'}</td>`
      + `<td class="n">${fmt.money(r.mrr)}</td><td class="n">${fmt.money(r.revenue)}</td>`
      + `<td class="n">${fmt.money(r.serve)}</td>`
      + `<td class="n">${r.contribution < 0 ? '<span class="notviable">' : ''}`
      + `${fmt.money(r.contribution)}${r.contribution < 0 ? '</span>' : ''}</td>`
      + `<td class="n">${fmt.int(r.monthsUnder)}</td></tr>`).join('')
    + '</tbody>';

  $('account-serve-note').textContent =
    `Chart 39 per account. The month's spend in each layer is the same figure chart 39 draws, `
    + `and summing this table's accounts in a month returns it exactly; the only new thing here `
    + `is how it is spread. Platform, support and success, G&A and R&D are divided equally among `
    + `paying accounts, as chart 39 divides them. Merchant fees and revenue share follow the `
    + `payment, so each account carries the month's rate on its own revenue: an account paying `
    + `ten times as much carries ten times the variable cost. Costs to keep is platform, people `
    + `and variable; contribution is everything the account paid, subscription, usage, one-off `
    + `and pass-through, less that. G&A and R&D are in the download and not in the table, for the `
    + `reason chart 39 gives. Live accounts at zero MRR this month carry only their variable cost `
    + `and are not listed. S1 and S2 accounts are costed on the same ledger, because the ledger `
    + `does not know which environment a customer is in; the environment only decides which `
    + `line an account is counted on. The download holds every account for every month since `
    + `${fmt.monthLabel(a.months[0])}, ${fmt.int(a.rows.length)} rows, with the five layers apart.`;

  const button = $('account-serve-download');
  if (button && !button.dataset.ready) {
    const csv = () => {
      const head = ['customer_id', 'company_name', 'source', 'month', 'subscription_status',
        'paying', 'mrr', 'revenue', 'net_cash', 'platform', 'people', 'variable', 'ga', 'rd',
        'serve_cost', 'contribution', 'loaded_cost', 'loaded_contribution'];
      const cell = v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
        const t = String(v);
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      };
      const line = r => [r.id, r.name, r.source, r.month, r.status, r.paying ? 1 : 0, r.mrr,
        r.revenue, r.netCash, r.platform, r.people, r.variable, r.admin, r.product, r.serve,
        r.contribution, r.loaded, r.loadedContribution].map(cell).join(',');
      return [head.join(',')].concat(a.rows.map(line)).join('\n');
    };
    button.addEventListener('click', () => {
      const blob = new Blob([csv()], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `chiirp-cost-to-keep-by-account-${a.last.month}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      $('account-serve-status').textContent =
        `${fmt.int(a.rows.length)} account-months exported.`;
    });
    button.dataset.ready = '1';
  }
}

// The Events tab. What each event cost and what the customers it brought have
// paid since, then the same figures by age, organiser, kind, channel and
// tagging coverage. Sourcing, not attribution: see eventRoi.
const EVENT_TYPE_INK = {
  'Conference sponsorship': INK.primary,
  'Partner network event': INK.secondary,
  'Small room': INK.accent,
  'Training': INK.tertiary,
  [EVENT_UNCLASSIFIED]: 'var(--ink-soft)',
};
// The Marketing tab. What each way of winning customers cost, month by month,
// against the leads, deals and paying customers it produced. Spend is
// QuickBooks, leads and deals are HubSpot, paying customers are Stripe.
const MARKETING_INK = {
  'Paid social': INK.primary,
  'Events': INK.secondary,
  'Podcasts': INK.accent,
  'Other digital': INK.tertiary,
  'Website and search': INK.positive,
  'Webinars': 'var(--ink-soft)',
  'Partners and referrals': INK.negative,
};
function renderMarketing() {
  if (!$('chart-mkt-spend')) return;
  const r = marketingReport(data);
  if (!r) {
    $('chart-mkt-spend').innerHTML = '<p class="empty">No months to show yet.</p>';
    return;
  }
  const money = v => (v === null || v === undefined ? '–' : fmt.money(v));
  const int = v => (v === null || v === undefined ? '–' : fmt.int(v));
  const labels = r.months.map(fmt.monthLabel);
  const span = `${fmt.monthLabel(r.months[0])} to ${fmt.monthLabel(r.months[r.months.length - 1])}`;
  const cat = name => r.totals.find(t => t.category === name);
  const meta = cat('Paid social');
  const ev = cat('Events');

  $('mkt-source').textContent = `Spend is QuickBooks; leads and deals are HubSpot as read on `
    + `${r.snapshotAsOf}; paying customers are Stripe. ${span}.`;

  $('mkt-finding').innerHTML =
    `<strong>${money(r.spendAll)} of marketing spend over ${r.months.length} months against `
    + `${fmt.int(r.wonAll)} won deals, ${money(r.blendedPerWon)} a deal across every channel.</strong> `
    + `Paid social cost ${money(meta.spend)}: ${fmt.int(meta.leads)} leads at ${money(meta.costPerLead)} each, `
    + `${fmt.int(meta.won)} won deals at ${money(meta.costPerWon)} each. Events cost ${money(ev.spend)} for `
    + `${fmt.int(ev.won)} won deals, ${money(ev.costPerWon)} each. Partners, referrals, website and search `
    + `win deals with no spend recorded here, which is why the blended figure is below every paid channel’s.`;

  // Spend by month.
  const spendSeries = ['Paid social', 'Events', 'Podcasts'].map(c => ({
    label: c, colour: MARKETING_INK[c], values: r.byMonth.map(x => x.spend[c] || null),
  }));
  spendSeries.push({ label: 'Other advertising', colour: 'var(--ink-soft)', dashed: true,
    values: r.byMonth.map(x => (x.adsOther > 0 ? x.adsOther : null)) });
  multiLineChart($('chart-mkt-spend'), {
    labels, series: spendSeries, yFormat: v => fmt.money(v), yMin: 0, yTitle: 'Spend in the month',
    describe: i => `<strong>${labels[i]}</strong>` + spendSeries.map(s => `<span>${s.label}: `
      + `${money(s.values[i])}</span>`).join(''),
  });

  // The category table.
  $('mkt-table').innerHTML =
    '<thead><tr><th>Category</th><th class="n">Spend</th><th class="n">Leads</th><th class="n">Deals opened</th>'
    + '<th class="n">Deals won</th><th class="n">Paying customers</th><th class="n">Per lead</th>'
    + '<th class="n">Per won deal</th><th class="n">Per paying customer</th></tr></thead><tbody>'
    + r.totals.map(t => `<tr${t.hasSpend ? '' : ' class="muted"'}><td>${t.category}</td>`
      + `<td class="n">${t.hasSpend ? money(t.spend) : '–'}</td><td class="n">${t.leads ? int(t.leads) : '–'}</td>`
      + `<td class="n">${int(t.created)}</td><td class="n">${int(t.won)}</td><td class="n">${int(t.customers)}</td>`
      + `<td class="n">${money(t.costPerLead)}</td><td class="n">${money(t.costPerWon)}</td>`
      + `<td class="n">${money(t.costPerCustomer)}</td></tr>`).join('')
    + `<tr><td>Other advertising</td><td class="n">${money(r.byMonth.reduce((s, x) => s + x.adsOther, 0))}</td>`
    + '<td class="n">–</td><td class="n">–</td><td class="n">–</td><td class="n">–</td><td class="n">–</td>'
    + '<td class="n">–</td><td class="n">–</td></tr>'
    + `<tr><td><strong>Every channel</strong></td><td class="n"><strong>${money(r.spendAll)}</strong></td>`
    + `<td class="n">–</td><td class="n">–</td><td class="n"><strong>${int(r.wonAll)}</strong></td>`
    + `<td class="n"><strong>${int(r.customersAll)}</strong></td><td class="n">–</td>`
    + `<td class="n"><strong>${money(r.blendedPerWon)}</strong></td>`
    + `<td class="n"><strong>${money(r.blendedPerCustomer)}</strong></td></tr></tbody>`;

  // Cost per won deal by month, over the three months to date.
  const cpw = r.paid.map(c => ({ label: c, colour: MARKETING_INK[c],
    values: r.costPerWon[c].map(x => x.trailing) }));
  multiLineChart($('chart-mkt-cpw'), {
    labels, series: cpw, yFormat: v => fmt.money(v), yMin: 0, yTitle: 'Spend per won deal, three months to date',
    describe: i => `<strong>${labels[i]}</strong>` + r.paid.map(c => {
      const x = r.costPerWon[c][i];
      return `<span>${c}: ${money(x.trailing)} over three months, ${money(x.single)} that month</span>`;
    }).join(''),
  });
  const last = r.costPerWon['Paid social'].at(-1);
  $('mkt-cpw-finding').innerHTML = last && last.trailing
    ? `<strong>Paid social cost ${money(last.trailing)} per won deal over the three months to `
      + `${fmt.monthLabel(last.month)}.</strong> The line is spend over the three months to date divided by the deals `
      + `won in them, because a lead bought in one month often closes in a later one; a single month's figure `
      + `is in the hover and swings with when deals happen to close.`
    : '';

  // Leads and won deals by month.
  const leadCats = ['Paid social', 'Website and search', 'Other digital', 'Events'];
  multiLineChart($('chart-mkt-leads'), {
    labels, yMin: 0, yTitle: 'Leads in the month',
    series: leadCats.map(c => ({ label: c, colour: MARKETING_INK[c], values: r.byMonth.map(x => x.leads[c]) })),
    describe: i => `<strong>${labels[i]}</strong>` + leadCats.map(c => `<span>${c}: `
      + `${int(r.byMonth[i].leads[c])}</span>`).join('')
      + `<span class="muted">Entered by hand or imported: ${int(r.byMonth[i].leads.Offline)}</span>`,
  });
  const cats = r.totals.filter(t => t.won || t.spend).map(t => t.category);
  $('mkt-month-table').innerHTML =
    '<thead><tr><th>Month</th>' + cats.map(c => `<th class="n">${c}</th>`).join('')
    + '<th class="n">Spend</th></tr></thead><tbody>'
    + r.byMonth.map(x => `<tr><td>${fmt.monthLabel(x.month)}</td>`
      + cats.map(c => `<td class="n">${int(x.won[c])}${x.spend[c] && x.won[c]
          ? `<br><span class="muted">${money(x.spend[c] / x.won[c])} each</span>` : ''}</td>`).join('')
      + `<td class="n">${money(MARKETING_CATEGORIES.reduce((s, c) => s + (x.spend[c] || 0), 0) + x.adsOther)}</td></tr>`).join('')
    + '</tbody>';

  $('mkt-note').textContent =
    'Spend: Meta and podcast sponsorships are split out of QuickBooks 6100-05 Advertising by vendor; '
    + 'everything else in it, ClickFunnels landing pages and $34 of Google Ads included, is other advertising, so the categories add '
    + 'back to the ledger. Event spend is the Events tab’s cost for each event, in its month, including '
    + 'travel; event fees booked under advertising are counted there once. Webinars, website, search and '
    + 'partners carry no direct spend; partners are paid in revenue share, which this page counts as a cost '
    + 'of keeping customers. Leads are HubSpot contacts created, by Original Traffic Source, because the lead '
    + 'source field is set on almost no digital lead; event leads are the earned leads in the Lead Counts tab. '
    + 'Contacts entered by hand or imported (Offline Sources) are left out of the lead lines. Deals are by the '
    + 'deal’s own lead source: Digital Marketing deals from before Meta (Ads) came into use in December 2025 '
    + 'may be Meta, and the large numbers of deals opened in March, April and July 2026 are bulk loads, so deals opened '
    + 'is not a demand measure. Paying customers are Stripe customers by the month of their first payment and '
    + 'their HubSpot tag. Leads and deals are a snapshot until the pipeline pushes them.';
}

// One event on its own page: every cost behind it, where each figure came
// from, the leads, the customers it is credited with and what they have paid.
// Reached from any event name on the Events tab as #event=<name>.
const eventHref = label => `#event=${encodeURIComponent(label)}`;
function renderEventPage(label) {
  const box = $('event-page');
  if (!box) return;
  const promptOnly = Boolean($('events-prompt-only') && $('events-prompt-only').checked);
  const r = eventReports(data, { promptTagsOnly: promptOnly });
  const e = r ? r.roi.events.find(x => x.label === label) : null;
  if (!e) {
    box.innerHTML = `<p class="empty">No event called "${label}" in this push.</p>`;
    return;
  }
  const money = v => (v === null || v === undefined ? '–' : fmt.money(v));
  const signed = v => (v === null || v === undefined ? '–' : (v < 0 ? '−' : '+') + fmt.money(Math.abs(v)));
  const pct = v => (v === null || v === undefined ? '–' : fmt.pct(v, 0));
  const int = v => (v === null || v === undefined ? '–' : fmt.int(v));
  const c = e.cost;
  const rc = r.recovery.find(x => x.label === label);
  const pb = r.payback.find(x => x.label === label);
  const el = eventLeads(data, r.roi);
  const lead = el ? el.events.find(x => x.label === label) : null;
  const pack = c && c.packageKey ? r.roi.packages.find(p => p.key === c.packageKey) : null;
  const row = (k, v, note = '') => `<tr><th scope="row">${k}</th><td class="n">${v}</td><td>${note}</td></tr>`;

  const costRows = c
    ? row('Sponsorship fee used', money(c.sponsor), c.feeFrom ? `From ${c.feeFrom === 'settled' ? 'a settled decision'
        : c.feeFrom === 'shared fee' ? 'a fee shared with other events' : 'QuickBooks, agreeing with the tab'}.` : 'As the Event Costs tab carries it.')
      + (c.tabSponsor !== c.sponsor ? row('Event Costs tab fee', money(c.tabSponsor), 'What the tab carries; replaced as below.') : '')
      + row('Travel', money(c.travel), c.extra && c.costSource === 'modelled' ? 'Modelled: the partnerships team’s estimate.'
        : 'Airfare, ground transport, lodging and meals on the Event Costs tab.')
      + row('<strong>Total cost</strong>', `<strong>${money(e.spend)}</strong>`, '')
      + row('Cost source on the tab', c.costSource || '–', c.note || '')
    : row('Cost', '–', e.upcoming ? `Happens in ${fmt.monthLabel(e.upcoming)}, after the data.` : 'No row on the Event Costs tab.');

  const resultRows =
    row('Customers credited', int(e.paid), (e.winbacks ? `Including ${int(e.winbacks)} won back. ` : '')
      + 'First paid in or after the event’s month.')
    + row('Tagged, already paying', int(e.alreadyPaying), 'Carry the tag but were paying before the event; not credited.')
    + row('Live now', int(e.liveNow), `In ${fmt.monthLabel(r.roi.lastMonth)}.`)
    + row('MRR now', money(e.mrrNow), '')
    + row('Collected', money(e.collected), 'Net cash from the credited customers.')
    + row('Contribution', money(e.contribution), 'What they paid less platform, people and variable cost (chart 49).')
    + row('<strong>Net of cost</strong>', `<strong>${signed(e.net)}</strong>`, '')
    + row('Collected per $1 spent', e.cashMultiple === null ? '–' : `${e.cashMultiple.toFixed(1)}x`, '')
    + (pb ? row('Pays for itself', pb.status === 'paid' ? `Month ${pb.paidAt}` : pb.status === 'projected'
        ? `Projected, month ${pb.projectedAt}` : pb.status === 'too new' ? 'Too new to tell'
        : pb.status === 'none' ? 'No customer' : 'Not expected', `${pct(pb.recovered)} of cost recovered so far.`) : '')
    + (rc ? [3, 6, 12].map(k => row(`Recovered by month ${k}`, rc.at[k] ? pct(rc.at[k].recovered) : 'not yet', '')).join('') : '');

  const leadRows = lead
    ? row('Earned leads', int(lead.leads), 'A booth scan, meeting, form, rep or chat.')
      + row('From a list', int(lead.list), lead.listShare ? `${pct(lead.listShare)} of every contact with this tag; not counted.` : '')
      + (lead.dated ? row('Before / after the event', `${int(lead.before)} / ${int(lead.after)}`, `Event date ${lead.eventDate}.`) : '')
      + row('Confirmed / contradicted', `${int(lead.confirmed)} / ${int(lead.contradicted)}`,
        'An at-event form or meeting names this event / names a different one.')
      + row('Cost per earned lead', money(lead.costPerLead), '')
      + (lead.readAs ? row('Pipeline note', '', lead.readAs) : '')
    : row('Leads', '–', 'This event has no row in the Lead Counts tab.');

  const t = e.tags;
  const tagRows = t
    ? row('Record created around the event', int(t.atEvent), 'The month before to the month after.')
      + row('Record already existed', int(t.before), '')
      + row('Record created later', int(t.after), '')
      + row('Tagged by the end of the following month', t.setPrompt + t.setLater ? int(t.setPrompt) : '–', '')
      + row('Tagged later than that', t.setPrompt + t.setLater ? int(t.setLater) : '–', '')
      + (t.bulk ? row('Created on a list-import day', int(t.inBulk),
        t.bulk.map(b => `${fmt.int(b.count)} contacts on ${b.date}`).join('; ')) : '')
    : '';

  const custRows = (e.customerRows || []).map(x => `<tr><td>${x.name}${x.winback ? ' <span class="muted">won back</span>' : ''}</td>`
    + `<td>${x.firstPaid ? fmt.monthLabel(x.firstPaid) : '–'}</td><td>${x.live ? 'Live' : 'Gone'}</td>`
    + `<td class="n">${money(x.mrrNow)}</td><td class="n">${money(x.collected)}</td>`
    + `<td class="n">${money(x.contribution)}</td><td>${x.leadDate || '–'}</td><td>${x.leadSetAt || '–'}</td></tr>`).join('');

  box.innerHTML =
    `<p><a href="#events" class="back-link">Back to all events</a></p>`
    + `<header class="story-head"><h2>${e.label}</h2>`
    + `<p>${e.month ? fmt.monthLabel(e.month) : e.upcoming ? `Happens ${fmt.monthLabel(e.upcoming)}` : 'Undated'}`
    + `${e.type ? ` · ${e.type}` : ''}${e.organiser ? ` · ${e.organiser}` : ''}${e.plan2027 ? ` · ${e.plan2027}` : ''}`
    + `${e.source ? ` · HubSpot source "${e.source}"` : ''}</p></header>`
    + `<p class="finding"><strong>${e.spend === null ? 'No cost recorded' : `Cost ${money(e.spend)}`}`
    + `${e.net !== null ? `, net ${signed(e.net)} so far` : ''}.</strong> `
    + (e.upcoming ? `It happens after the last month of data, so nothing is credited to it yet.</p>`
      : `${int(e.paid)} customer${e.paid === 1 ? '' : 's'} credited, ${int(e.liveNow)} still live, `
        + `${money(e.collected)} collected.</p>`)
    + `<figure class="card wide"><figcaption><h3>What it cost</h3></figcaption>`
    + `<div class="table-scroll"><table class="data-table"><tbody>${costRows}</tbody></table></div>`
    // The basis already carries a settled decision's or a shared fee's text,
    // which have their own notes below; show it only when it adds something.
    + (c && !c.decided && !pack ? `<p class="note">${c.sponsorBasis || ''}</p>` : '')
    + (c && c.decision ? `<p class="note"><strong>${c.decided ? 'Settled fee' : 'Fee checked'} `
      + `(${c.decision.confidence}):</strong> ${c.decision.evidence}</p>` : '')
    + (pack ? `<p class="note"><strong>${pack.label}:</strong> one fee of ${money(pack.fee)} covering ${fmt.int(pack.covers)} `
      + `event${pack.covers === 1 ? '' : 's'}; this one carries ${money(pack.fee / pack.covers)}. ${pack.basis}</p>` : '')
    + (e.report2025 ? `<p class="note"><strong>Partnerships report, Nov 2025:</strong> ${e.report2025}</p>` : '')
    + `</figure>`
    + `<figure class="card wide"><figcaption><h3>What came back</h3></figcaption>`
    + (rc ? '<div class="plot" id="event-page-curve"></div>' : '')
    + `<div class="table-scroll"><table class="data-table"><tbody>${resultRows}</tbody></table></div></figure>`
    + `<figure class="card wide"><figcaption><h3>Leads</h3></figcaption>`
    + `<div class="table-scroll"><table class="data-table"><tbody>${leadRows}</tbody></table></div></figure>`
    + (tagRows ? `<figure class="card wide"><figcaption><h3>How the tags were made</h3></figcaption>`
      + `<div class="table-scroll"><table class="data-table"><tbody>${tagRows}</tbody></table></div></figure>` : '')
    + `<figure class="card wide"><figcaption><h3>Customers credited</h3></figcaption>`
    + (custRows
      ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Customer</th><th>First paid</th><th>Now</th>`
        + `<th class="n">MRR now</th><th class="n">Collected</th><th class="n">Contribution</th>`
        + `<th>HubSpot record</th><th>Tag written</th></tr></thead><tbody>${custRows}</tbody></table></div>`
      : '<p class="empty">No tagged customer has started paying since this event.</p>')
    + `</figure>`;

  if (rc) {
    const ages = rc.curve.map((_, i) => `M${i + 1}`);
    lineChart($('event-page-curve'), {
      labels: ages, values: rc.curve, yMin: 0, yFormat: v => fmt.pct(v, 0),
      yTitle: 'Share of cost recovered', refs: [{ value: 1, label: 'Paid for itself', variant: 'ref-goal' }],
      describe: i => `<strong>Month ${i + 1}</strong><span>${rc.curve[i] === null ? 'Not reached yet'
        : `${pct(rc.curve[i])} of cost recovered`}</span>`,
    });
  }
}

function renderEvents() {
  if (!$('chart-events')) return;
  const promptOnly = Boolean($('events-prompt-only') && $('events-prompt-only').checked);
  const r = eventReports(data, { promptTagsOnly: promptOnly });
  if (!r) {
    $('chart-events').innerHTML = '<p class="empty">No event costs or lead sources in this push.</p>';
    return;
  }
  const e = r.roi;
  const money = v => (v === null || v === undefined ? '–' : fmt.money(v));
  const signed = v => (v === null || v === undefined ? '–'
    : (v < 0 ? '−' : '+') + fmt.money(Math.abs(v)));
  const pct = v => (v === null || v === undefined ? '–' : fmt.pct(v, 0));
  const multiple = v => (v === null || v === undefined ? '–' : v.toFixed(1) + 'x');
  const chip = plan => (!plan ? ''
    : `<span class="event-chip ${plan.startsWith('On') ? 'on' : plan.startsWith('Dropped') ? 'dropped' : ''}">`
      + `${plan.startsWith('On') ? '2027: on' : plan.startsWith('Dropped') ? '2027: dropped' : '2027: not listed'}</span>`);
  const qtyEarly = (k, one, many = one + 's') => `${fmt.int(k)} ${k === 1 ? one : many}`;
  const tagged = e.coverage.taggedEver > 0;
  const sw = $('events-prompt-only');
  if (sw && !sw.dataset.ready) {
    sw.addEventListener('change', () => renderEvents());
    sw.dataset.ready = '1';
  }
  if (sw) {
    const usable = e.tagDates && e.tagDates.withSetAt > 0;
    sw.disabled = !usable;
    $('events-prompt-note').textContent = !usable
      ? 'Needs lead_set_at: no tag in this push carries the date it was written.'
      : promptOnly
        ? `On: ${qtyEarly(e.droppedLate, 'tagged customer')} whose tag was written after the month following `
          + 'their event are counted as untagged in every figure below.'
        : `Off: every tag counts, however late it was written.`;
  }
  const kindsPresent = new Set(e.events.map(x => x.type).filter(Boolean));
  const typeLegend = Object.entries(EVENT_TYPE_INK).filter(([label]) => kindsPresent.has(label))
    .map(([label, colour]) => ({ label, colour }));
  const qty = (k, one, many = one + 's') => `${fmt.int(k)} ${k === 1 ? one : many}`;
  const untaggedShare = e.coverage.share === null ? null : 1 - e.coverage.share;
  // A month the ledger had not closed is read at the usual variable rate in
  // every figure on this tab (eventContributionRows).
  const openMonths = ((accountServeCost(data) || {}).outliers || []);
  const openWords = openMonths.length
    ? `${openMonths.map(fmt.monthLabel).join(' and ')} ${openMonths.length === 1 ? 'is' : 'are'} read with merchant `
      + `and revenue-share costs at the usual rate, because the ledger had not closed `
      + `${openMonths.length === 1 ? 'it' : 'them'} when the data was pulled. `
    : '';

  // The HubSpot notice shows only while the push lacks the date each tag was
  // written, and says which push it is about.
  const notice = $('events-hubspot-notice');
  if (notice) {
    const missing = tagged && e.tagDates.withSetAt === 0;
    notice.hidden = !missing;
    if (missing) {
      notice.innerHTML = `<strong>HubSpot: the date each contact's lead source was set is not in `
        + `the data.</strong> lead_set_at is blank on all ${fmt.int(e.tagDates.tagged)} tagged `
        + `customers in the push of ${data.pushedAt ? (([y, m, d]) => `${Number(d)} `
            + `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`)(
            data.pushedAt.slice(0, 10).split('-')) : 'this push'}`
        + `${data.pipelineVersion ? ` (${data.pipelineVersion})` : ''}, `
        + `so the tag-timing columns below are blank. Lead sources themselves are read.`;
    }
  }

  $('events-coverage').innerHTML = tagged
    ? `<strong>${fmt.int(e.coverage.taggedLive)} of ${fmt.int(e.coverage.live)} live customers `
      + `(${fmt.pct(e.coverage.share, 0)}) carry a HubSpot lead source in ${fmt.monthLabel(e.lastMonth)}.</strong> `
      + `Everything below is about those customers. A blank means nobody tagged the customer, `
      + `not that they arrived on their own, so every count here is a floor. ` + openWords
    : data.hasLeadSource
      ? '<strong>This push carries the lead source columns but every row is blank.</strong> '
        + 'The customer figures read zero for that reason, not because the events brought no one.'
      : '<strong>This push carries no lead sources yet.</strong> The costs below are complete.';

  // ---------------------------------------------------------------- ranking, at a chosen age
  // Every event is read the same number of months after it happened, so a
  // year-old event and a two-month-old one are never ranked on time one of
  // them has not had. The event month counts as month one. An event younger
  // than the chosen age is set aside, not ranked low.
  const costed = e.events.filter(eventHasReturn);
  const t = e.totals;
  const paybackBy = new Map(r.payback.map(p => [p.label, p]));
  const paybackWords = p => (!p ? 'no projection'
    : p.status === 'paid' ? `paid for itself in month ${p.paidAt}`
    : p.status === 'projected' ? `projected to pay for itself by month ${p.projectedAt}`
    : p.status === 'none' ? 'no customer to project from'
    : p.status === 'too new' ? 'too new to have customers yet'
    : `not expected to pay for itself within ${r.paybackHorizon} months`);
  const recBy = new Map(r.recovery.map(x => [x.label, x]));
  const ageInput = $('events-age');
  if (ageInput && !ageInput.dataset.ready) {
    ageInput.max = String(Math.min(12, Math.max(...r.recovery.map(x => x.age), 1)));
    ageInput.value = String(Math.min(6, Number(ageInput.max)));
  }
  const drawAt = k => {
    $('events-age-value').textContent = `${k} month${k === 1 ? '' : 's'}`;
    const atK = costed.map(x => {
      const rc = recBy.get(x.label);
      const age = rc ? rc.age : null;
      const reached = rc && rc.curve[k - 1] !== null && rc.curve[k - 1] !== undefined;
      const contribution = reached ? rc.curve[k - 1] * x.spend : null;
      return { ...x, age, reached, contributionAtK: contribution,
        netAtK: reached ? contribution - x.spend : null };
    });
    const judged = atK.filter(x => x.reached).sort((a, b) => b.netAtK - a.netAtK);
    const young = atK.filter(x => !x.reached).sort((a, b) => (b.age || 0) - (a.age || 0));
    // Sort: by result at this age (events too young at the bottom), by name,
    // or by when the event happened. Every order keeps young events faded.
    const sortBy = ($('events-sort') && $('events-sort').value) || 'result';
    const order = sortBy === 'result' ? [...judged, ...young]
      : [...judged, ...young].sort(sortBy === 'az' ? (a, b) => a.label.localeCompare(b.label)
        : sortBy === 'oldest' ? (a, b) => a.month.localeCompare(b.month) || a.label.localeCompare(b.label)
        : (a, b) => b.month.localeCompare(a.month) || a.label.localeCompare(b.label));
    const link = x => `<a href="${eventHref(x.label)}">${x.label}</a>`;
    barList($('chart-events'), {
      items: order.map(x => (x.reached ? {
          label: link(x),
          sub: `${fmt.monthLabel(x.month)} · ${qty(x.paid, 'customer')} · cost ${money(x.spend)}`,
          value: x.netAtK,
          colour: x.netAtK >= 0 ? INK.positive : INK.negative,
          title: `${x.label}: cost ${money(x.spend)}, contribution in its first ${k} months `
            + `${money(x.contributionAtK)}, contribution to date ${money(x.contribution)}`,
        } : {
          label: link(x),
          sub: `${fmt.monthLabel(x.month)} · ${qty(x.age, 'month')} old, not yet ${k}`
            + ` · ${paybackWords(paybackBy.get(x.label))}`,
          value: null,
          muted: true,
        })),
      format: signed,
      legendItems: [
        { label: `Contribution in the first ${k} months has covered the cost`, colour: INK.positive },
        { label: 'Not yet', colour: INK.negative },
        { label: `Faded: under ${k} months old, not ranked`, colour: 'var(--ink-soft)', faint: true },
      ],
    });
    const winners = judged.filter(x => x.netAtK >= 0);
    // With nobody paid back, the least-negative net is just the cheapest
    // event, often one with no customer; name the closest by share instead.
    const closest = [...judged].filter(x => x.paid > 0)
      .sort((a, b) => b.contributionAtK / b.spend - a.contributionAtK / a.spend)[0];
    const best = winners.length ? judged[0] : null;
    const worst = judged[judged.length - 1];
    const spendJ = judged.reduce((s, x) => s + x.spend, 0);
    const contribJ = judged.reduce((s, x) => s + x.contributionAtK, 0);
    $('events-finding').innerHTML = tagged
      ? `<strong>${k} month${k === 1 ? '' : 's'} after each event, ${fmt.int(winners.length)} of the ${fmt.int(judged.length)} `
        + `events old enough to compare had paid for themselves: ${money(spendJ)} of cost against `
        + `${money(contribJ)} of contribution from the customers they brought.</strong> `
        + (best ? `${best.label} leads at ${signed(best.netAtK)}. `
          : closest ? `None has yet; ${closest.label} is closest, with ${pct(closest.contributionAtK / closest.spend)} `
            + `of its cost back. ` : '')
        + (worst && worst !== best ? `${worst.label} is furthest behind at ${signed(worst.netAtK)}. ` : '')
        + (young.length ? `${qty(young.length, 'event is', 'events are')} younger than ${qty(k, 'month')} and `
          + `${young.length === 1 ? 'is' : 'are'} listed faded at the bottom rather than ranked. ` : '')
        + (t.alreadyPaying
            ? `${qty(t.alreadyPaying, 'more customer carries', 'more customers carry')} an event tag but `
              + `${t.alreadyPaying === 1 ? 'was' : 'were'} already paying before that event, and `
              + `${t.alreadyPaying === 1 ? 'is' : 'are'} kept out of every event figure; the channel and `
              + `coverage sections count them by their tag. `
            : '')
        + `Move the slider to read every event at the same age: short ages favour events whose `
        + `customers start on a large first invoice, long ages favour the ones that keep them.`
      : `<strong>${fmt.int(costed.length)} events cost ${money(t.spend)}.</strong> `
        + `Customer results appear once lead sources arrive.`;

    // The scatter follows the same age.
    const dots = judged;
    scatterBreakEven($('chart-event-scatter'), {
      points: dots.map(x => ({ x: x.spend, y: x.contributionAtK,
        colour: EVENT_TYPE_INK[x.type] || EVENT_TYPE_INK[EVENT_UNCLASSIFIED], label: x.label })),
      xLabel: 'What the event cost',
      yLabel: `Contribution in its first ${k} months`,
      describe: i => {
        const x = dots[i];
        return `<strong>${x.label}</strong><span>${x.type || ''} · ${fmt.monthLabel(x.month)}</span>`
          + `<span>Cost ${money(x.spend)}, first ${k} months ${money(x.contributionAtK)}</span>`
          + `<span>${qty(x.paid, 'customer')}, net ${signed(x.netAtK)}</span>`;
      },
      legendItems: typeLegend,
    });
    const above = dots.filter(x => x.contributionAtK >= x.spend);
    const floor = dots.filter(x => x.contributionAtK <= 0);
    const floorNobody = floor.filter(x => !x.paid).length;
    $('event-scatter-finding').innerHTML =
      `<strong>At ${k} months, ${fmt.int(above.length)} of ${fmt.int(dots.length)} events sit above the line.</strong> `
      + (floor.length
          ? `${qty(floor.length, 'sits', 'sit')} on the floor at zero or below: `
            + [floorNobody ? `${fmt.int(floorNobody)} because nobody tagged to ${floorNobody === 1 ? 'it' : 'them'} has started paying` : '',
               floor.length - floorNobody ? `${fmt.int(floor.length - floorNobody)} because ${floor.length - floorNobody === 1 ? 'its' : 'their'} `
                 + `customers had contributed nothing by then` : ''].filter(Boolean).join(', and ') + '. '
          : '')
      + `Distance above the line is money made back beyond the cost; a dot far to the right and low `
      + `is an expensive event that has not produced its customers. The slider above sets the age.`;
  };
  renderEvents.drawAt = drawAt;
  if (ageInput && !ageInput.dataset.ready) {
    ageInput.addEventListener('input', () => renderEvents.drawAt(Number(ageInput.value)));
    if ($('events-sort')) {
      $('events-sort').addEventListener('change', () => renderEvents.drawAt(Number(ageInput.value)));
    }
    ageInput.dataset.ready = '1';
  }
  drawAt(Number(ageInput ? ageInput.value : 6));

  const row = x => {
    const c = x.cost;
    const costCell = c
      ? `<span title="${(c.sponsorBasis || '').replace(/"/g, '&quot;')}">${money(x.spend)}</span>`
        + `<br><span class="muted">${money(c.sponsor)} fee${c.feeFrom ? ` (${c.feeFrom})` : ''}, `
        + `${money(c.travel)} travel</span>`
      : x.upcoming ? '<span class="muted">after the data</span>' : '<span class="muted">no cost row</span>';
    return `<tr><td><a href="${eventHref(x.label)}">${x.label}</a> ${chip(x.plan2027)}`
      + `${x.type ? `<br><span class="muted">${x.type}${x.organiser ? ' · ' + x.organiser : ''}</span>` : ''}`
      + `${x.source && x.cost && x.source !== x.label ? `<br><span class="muted">HubSpot: ${x.source}</span>` : ''}`
      + `${!x.source && x.cost ? '<br><span class="muted">no customer tagged</span>' : ''}</td>`
      + `<td>${x.month ? fmt.monthLabel(x.month) : x.cost ? `<span class="muted">undated</span>` : (x.year || '–')}</td>`
      + `<td class="n">${costCell}</td>`
      + `<td class="n">${fmt.int(x.paid)}${x.tags && x.paid
          ? `<br><span class="muted">${fmt.int(x.tags.atEvent)} with a record created around the event</span>` : ''}${x.winbacks
          ? `<br><span class="muted">incl. ${fmt.int(x.winbacks)} won back</span>` : ''}${x.alreadyPaying
          ? `<br><span class="muted">+${fmt.int(x.alreadyPaying)} already paying</span>` : ''}</td>`
      + `<td class="n">${fmt.int(x.liveNow)}</td>`
      + `<td class="n">${money(x.mrrNow)}</td>`
      + `<td class="n">${money(x.collected)}</td>`
      + `<td class="n">${money(x.contribution)}</td>`
      + `<td class="n">${x.net === null ? '–' : `<span class="${x.net < 0 ? 'notviable' : 'held'}">${signed(x.net)}</span>`}</td>`
      + `<td class="n">${multiple(x.cashMultiple)}</td></tr>`;
  };
  $('events-table').innerHTML =
    '<thead><tr><th>Event</th><th>When</th><th class="n">Cost</th><th class="n">Customers</th>'
    + '<th class="n">Live now</th><th class="n">MRR now</th><th class="n">Collected</th>'
    + '<th class="n">Contribution</th><th class="n">Net of cost</th><th class="n">Collected per $1</th>'
    + '</tr></thead><tbody>' + e.events.map(row).join('') + '</tbody>';

  const unassigned = EVENT_UNASSIGNED_QB.reduce((s, x) => s + x.amount, 0);
  $('events-note').textContent =
    'Cost is the Event Costs tab, corrected only where a decision further down settles a disputed '
    + 'fee or a shared fee is split; the label beside the fee says which, and hovering a cost shows '
    + 'what it is made of. ' + openWords + 'A customer counts for an '
    + 'event only if their first payment came in or after the event’s month; one already paying '
    + 'before it carries the tag but cannot have been brought by that event. The exception is a '
    + `win-back: a former customer who paid nothing in the ${WINBACK_GAP} months before the event and paid `
    + 'again from its month is credited, counting only what they paid from then'
    + (t.winbacks ? ` (${qty(t.winbacks, 'customer')} this time)` : '') + '. A fee that paid for '
    + 'several events is split equally across them, and the shared fees are added up whole further '
    + 'down. Collected is net cash since the window opened; contribution is what they paid less '
    + 'platform, people and variable cost, chart 49’s basis, and leaves out G&A and R&D. A company '
    + 'with an account in both Stripe environments counts twice until the two are paired. This is '
    + 'sourcing, not attribution: the partnerships event ROI credits only deals opened within sixty '
    + 'days of an event, less pre-event and renewal deals, so the two will disagree and both are '
    + 'right about different questions. '
    + (e.unmatchedSources.length
        ? `${qty(e.unmatchedSources.length, 'event lead source matches', 'event lead sources match')} no cost `
          + `row and ${e.unmatchedSources.length === 1 ? 'is' : 'are'} listed with no cost: `
          + `${e.unmatchedSources.join('; ')}. `
        : '')
    + (e.undatedCosts.length
        ? `${qty(e.undatedCosts.length, 'cost row has', 'cost rows have')} no month on the Event Costs tab `
          + `and ${e.undatedCosts.length === 1 ? 'is' : 'are'} counted in the cost but not in any figure by age: `
          + `${e.undatedCosts.join('; ')}. `
        : '')
    + (e.upcomingSources.length
        ? e.upcomingSources.map(u => `${qty(u.tagged, 'customer is', 'customers are')} tagged "${u.source}", `
            + `which happens in ${fmt.monthLabel(u.month)}`).join('; ')
          + `, after the last month of data, so none is credited to ${e.upcomingSources.length === 1 ? 'it' : 'them'} yet. `
        : '')
    + 'Lead sources named as a webinar or a podcast are counted under those channels even where the '
    + 'pipeline marks them as events, and podcasts are not costed here: they are bought separately. '
    + `QuickBooks sponsorship lines that belong to no event on the calendar are in no row, about `
    + `${fmt.money(unassigned)} over the year: `
    + EVENT_UNASSIGNED_QB.map(x => `${x.what}, ${x.approximate ? 'about ' : ''}${fmt.money(x.amount)} (${x.months})`).join('; ')
    + '.';

  // ---------------------------------------------------------------- leads per event (Lead Counts)
  const el = eventLeads(data, e);
  if ($('event-leads-table')) {
    if (!el) {
      $('event-leads-finding').textContent = 'This push carries no Lead Counts tab.';
      $('event-leads-table').innerHTML = '';
      $('chart-event-leads').innerHTML = '';
    } else {
      const withCost = el.events.filter(x => x.costPerLead !== null).sort((a, b) => a.costPerLead - b.costPerLead);
      barList($('chart-event-leads'), {
        items: withCost.map(x => ({
          label: x.label,
          sub: `${qty(x.leads, 'earned lead')} · cost ${money(x.spend)}`
            + (x.list ? ` · ${fmt.int(x.list)} more from a list, not counted` : ''),
          value: x.costPerLead,
          colour: EVENT_TYPE_INK[x.type] || EVENT_TYPE_INK[EVENT_UNCLASSIFIED],
        })),
        format: v => fmt.money(v),
        legendItems: typeLegend,
      });
      const big = el.importsTop.filter(x => x.list);
      const cheap = withCost[0];
      const dear = withCost[withCost.length - 1];
      $('event-leads-finding').innerHTML = cheap
        ? `<strong>Cost per earned lead runs from ${money(cheap.costPerLead)} at ${cheap.label} to `
          + `${money(dear.costPerLead)} at ${dear.label}.</strong> An earned lead is someone who did something: a `
          + `booth scan, a booked meeting, a form, a rep adding them, a chat. A list loaded into HubSpot is not `
          + `counted. `
          + (big.length ? `${big.map(x => `${x.label} has ${fmt.int(x.list)}`).join(', ')} contacts that arrived `
            + `in a list, so their totals describe a file rather than the event. ` : '')
          + `HubSpot tags a contact with the last event they touched, so contradicted counts contacts whose only `
          + `form or meeting names a different event.`
        : 'No event in the Lead Counts tab has both a cost and an earned lead.';
      $('event-leads-table').innerHTML =
        '<thead><tr><th>Event</th><th class="n">Earned leads</th><th class="n">From a list</th>'
        + '<th class="n">Before / after the event</th><th class="n">Confirmed</th><th class="n">Contradicted</th>'
        + '<th class="n">Cost per earned lead</th><th class="n">Customers credited</th></tr></thead><tbody>'
        + el.events.map(x => `<tr><td>${x.label}${x.eventDate ? `<br><span class="muted">${x.eventDate}</span>` : ''}</td>`
          + `<td class="n">${x.leads === null ? '–' : fmt.int(x.leads)}</td>`
          + `<td class="n">${x.list ? `${fmt.int(x.list)}<br><span class="muted">${pct(x.listShare)} of all</span>` : fmt.int(x.list || 0)}</td>`
          + `<td class="n">${x.dated ? `${fmt.int(x.before)} / ${fmt.int(x.after)}` : '<span class="muted">no date</span>'}</td>`
          + `<td class="n">${x.confirmed === null ? '–' : fmt.int(x.confirmed)}</td>`
          + `<td class="n">${x.contradicted === null ? '–' : fmt.int(x.contradicted)}</td>`
          + `<td class="n">${money(x.costPerLead)}${x.upcoming ? `<br><span class="muted">${x.afterData
            ? `after the data (${/^\d{4}-\d{2}$/.test(x.afterData) ? fmt.monthLabel(x.afterData) : x.afterData})` : 'no cost row'}</span>` : ''}</td>`
          + `<td class="n">${x.credited === null ? '–' : fmt.int(x.credited)}</td></tr>`).join('')
        + '</tbody>';
      $('event-leads-note').textContent =
        'From the Lead Counts tab: HubSpot contacts carrying each event as their lead source. Cost per earned '
        + 'lead divides the event’s cost on this tab by its earned leads; a total that includes a loaded list '
        + 'would make an event look cheap for leads it did not generate. Before and after the event exist only '
        + 'where the event has a date, and after-the-event counts include lists loaded later, so they are shown, '
        + 'not divided into cost. Confirmed means an at-event form or meeting names this event; contradicted means '
        + 'the contact’s only conversion names a different one.';
    }
  }

  // ---------------------------------------------------------------- payback, actual or projected
  const order = { paid: 0, projected: 1, 'not expected': 2, 'too new': 3, none: 4 };
  const pb = [...r.payback].sort((x, y) => (order[x.status] - order[y.status])
    || ((x.paidAt ?? x.projectedAt ?? 999) - (y.paidAt ?? y.projectedAt ?? 999))
    || x.label.localeCompare(y.label));
  const count = st => pb.filter(p => p.status === st).length;
  const within = n => pb.filter(p => p.status === 'projected' && p.projectedAt <= n).length;
  $('event-payback-finding').innerHTML =
    `<strong>${qty(count('paid'), 'event has', 'events have')} paid for ${count('paid') === 1 ? 'itself' : 'themselves'}, `
    + `${fmt.int(count('projected'))} more ${count('projected') === 1 ? 'is' : 'are'} projected to, and `
    + `${fmt.int(count('not expected'))} ${count('not expected') === 1 ? 'is' : 'are'} not expected to within `
    + `${r.paybackHorizon} months of the event.</strong> `
    + `${fmt.int(within(12))} of the projected ones get there inside their first year and `
    + `${fmt.int(within(24))} inside two. A further ${fmt.int(count('none'))} ${count('none') === 1 ? 'has' : 'have'} `
    + `no customer to project from`
    + (count('too new') ? `, and ${qty(count('too new'), 'is', 'are')} too new to have customers yet` : '')
    + `. A new event always starts below the line; this is how long each one is likely to stay there.`;
  $('event-payback-table').innerHTML =
    '<thead><tr><th>Event</th><th>When</th><th class="n">Cost</th><th class="n">Recovered so far</th>'
    + '<th class="n">Live customers</th><th class="n">Contribution a month now</th>'
    + '<th>Pays for itself</th></tr></thead><tbody>'
    + pb.map(p => `<tr><td>${p.label}</td><td>${fmt.monthLabel(p.month)}<br>`
      + `<span class="muted">${p.age} month${p.age === 1 ? '' : 's'} old</span></td>`
      + `<td class="n">${money(p.spend)}</td><td class="n">${pct(p.recovered)}</td>`
      + `<td class="n">${fmt.int(p.liveCustomers)}</td><td class="n">${money(p.monthlyNow)}</td>`
      + `<td><span class="${p.status === 'paid' ? 'held' : p.status === 'projected' || p.status === 'too new' ? '' : 'notviable'}">`
      + `${p.status === 'paid' ? `Paid, month ${p.paidAt}`
        : p.status === 'projected' ? `Projected, month ${p.projectedAt}`
        : p.status === 'none' ? 'No customer'
        : p.status === 'too new' ? 'Too new to tell'
        : 'Not expected'}</span></td></tr>`).join('')
    + '</tbody>';
  $('event-payback-note').textContent =
    'Paid is the first month, counting the event month as month 1, in which contribution from the '
    + 'customers the event brought covered its cost. Projected carries every one of those customers '
    + 'still live forward at their own contribution, the median of their last three months since they '
    + 'first paid, and keeps them on at the survival curve the '
    + 'projection in charts 34 to 36 uses for a customer of their age, so the line slows as customers '
    + 'leave. Not expected means the running total has not reached the cost '
    + `${r.paybackHorizon} months after the event. No new customers are assumed, and an event whose `
    + 'customers have all left cannot recover any more. Tagged customers only, so an event whose '
    + 'customers were not tagged reads later than it really is.';

  // ---------------------------------------------------------------- how the tags were made
  const hsfNow = e.events.find(x => x.label === 'HSF 2025');
  if ($('event-hsf-now') && hsfNow) $('event-hsf-now').textContent = fmt.int(hsfNow.paid);
  if ($('event-hsf-made') && hsfNow && hsfNow.tags) {
    const h = hsfNow.tags;
    $('event-hsf-made').textContent = `of the ${fmt.int(hsfNow.paid)} customers who keep the tag, `
      + `${fmt.int(h.atEvent)} have a HubSpot record created around the event and ${fmt.int(h.before)} a `
      + `record made before it`
      + (h.after ? `; ${qty(h.after, 'was', 'were')} created later, so the tag was applied afterwards` : '');
  }
  const withCust = e.events.filter(x => x.tags && x.paid > 0)
    .sort((p, q) => (q.paid - p.paid) || p.label.localeCompare(q.label));
  const td = e.tagDates;
  const sumT = k => withCust.reduce((t, x) => t + x.tags[k], 0);
  const credited = withCust.reduce((t, x) => t + x.paid, 0);
  barList($('chart-event-tags'), {
    items: withCust.map(x => ({
      label: x.label,
      sub: `${fmt.int(x.paid)} credited · ${fmt.int(x.tags.atEvent)} created around the event, `
        + `${fmt.int(x.tags.before)} before it, ${fmt.int(x.tags.after)} later`,
      value: x.paid ? x.tags.atEvent / x.paid : null,
      colour: x.paid && x.tags.atEvent / x.paid >= 0.5 ? INK.positive : INK.secondary,
    })),
    format: v => fmt.pct(v, 0),
    legendItems: [
      { label: 'Share of credited customers whose HubSpot record was created within a month of the event', colour: INK.positive },
      { label: 'Under half', colour: INK.secondary },
    ],
  });
  const bigTwo = withCust.filter(x => /^HSF 2025$|^Pantheon 2025$/.test(x.label));
  $('event-tags-finding').innerHTML =
    `<strong>Of the ${fmt.int(credited)} customers credited to an event, ${fmt.int(sumT('atEvent'))} have a `
    + `HubSpot record created within a month of that event; ${fmt.int(sumT('before'))} already had a record `
    + `when the event happened, and ${fmt.int(sumT('after'))} were created after it.</strong> `
    + (bigTwo.length
        ? bigTwo.map(x => `${x.label}: ${fmt.int(x.tags.atEvent)} of ${fmt.int(x.paid)} created around the event`).join('; ') + '. '
        : '')
    + (td.withSetAt
        ? `${qty(td.withSetAt, 'tag carries', 'tags carry')} the date ${td.withSetAt === 1 ? 'it was' : 'they were'} `
          + `written: of the credited customers, ${fmt.int(sumT('setPrompt'))} were tagged by the end of the month `
          + `after their event, ${fmt.int(sumT('setLater'))} later, and ${fmt.int(sumT('setUnknown'))} carry no date. `
        : `When each tag was written cannot be checked yet: lead_set_at is blank on all `
          + `${fmt.int(td.tagged)} tagged customers in this push, so a tag added in a batch months later `
          + `looks the same here as one entered on the day. `)
    + (() => {
      const flagged = withCust.filter(x => x.tags.bulk);
      const inBulk = flagged.reduce((t, x) => t + x.tags.inBulk, 0);
      return flagged.length
        ? `${qty(flagged.length, 'of these events has a source', 'of these events have a source')} that also `
          + `carries a list import, 50 or more contacts created on one day; ${fmt.int(inBulk)} of their credited `
          + `customers were created on such a day. `
        : '';
    })()
    + `A tag is somebody's record of where a customer came from, and the ones made long after the `
    + `fact are memory rather than record.`;
  $('event-tags-table').innerHTML =
    '<thead><tr><th>Event</th><th class="n">Credited</th><th class="n">Record created around the event</th>'
    + '<th class="n">Already in HubSpot</th><th class="n">Created later</th>'
    + '<th class="n">From a list import</th>'
    + '<th class="n">Tagged at the time</th><th class="n">Tagged later</th><th class="n">Tag not dated</th></tr></thead><tbody>'
    + withCust.map(x => `<tr><td>${x.label}${x.month ? `<br><span class="muted">${fmt.monthLabel(x.month)}</span>` : ''}</td>`
      + `<td class="n">${fmt.int(x.paid)}</td><td class="n">${fmt.int(x.tags.atEvent)}</td>`
      + `<td class="n">${fmt.int(x.tags.before)}</td><td class="n">${fmt.int(x.tags.after)}</td>`
      + `<td class="n">${x.tags.bulk ? `${fmt.int(x.tags.inBulk)}<br><span class="muted">`
          + x.tags.bulk.map(b => `${fmt.int(b.count)} on ${b.date}`).join('<br>') + '</span>' : '–'}</td>`
      + `<td class="n">${x.tags.setPrompt + x.tags.setLater ? fmt.int(x.tags.setPrompt) : '–'}</td>`
      + `<td class="n">${x.tags.setPrompt + x.tags.setLater ? fmt.int(x.tags.setLater) : '–'}</td>`
      + `<td class="n">${fmt.int(x.tags.setUnknown)}</td></tr>`).join('')
    + '</tbody>';
  $('event-tags-note').textContent =
    'Only customers the event is credited with, those whose first payment came in or after its month. '
    + 'Created around the event means the HubSpot record that carries the source (lead_date) was '
    + 'created between the month before the event and the month after it, which is when a lead met '
    + 'there would be entered. Already in HubSpot means the record existed before that, when the '
    + 'event happened: a genuine re-engagement at the event, or a tag applied from memory. Created later '
    + 'is a record made after the month after the event. Tagged at the time and tagged later read '
    + 'lead_set_at, the date the source field was first filled, against the event: by the end of the '
    + 'month after it is at the time. They are blank for an event none of whose tags is dated, and '
    + 'Tag not dated counts the rest. From a list import counts credited customers whose record was '
    + 'created on a day the pipeline flags (lead_bulk) for their source, when 50 or more of its '
    + 'contacts arrived at once; the flag is on the source, so the date decides. '
    + 'The pipeline found a burst of deal tagging in September 2025: 57% of that '
    + 'month’s deals carry a source, against 16% in August and 27% in October, and that month '
    + 'covered HSF 2025 and Pantheon 2025.';

  // ---------------------------------------------------------------- recovery by age
  const rec = r.recovery;
  const ages = Array.from({ length: 12 }, (_, i) => i + 1);
  const medianAt = k => {
    const vals = rec.map(x => x.curve[k - 1]).filter(v => v !== null).sort((a, b) => a - b);
    if (vals.length < 5) return null;
    const mid = vals.length >> 1;
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  };
  const medianCurve = ages.map(medianAt);
  multiLineChart($('chart-event-recovery'), {
    labels: ages.map(k => `M${k}`),
    yMin: 0,
    yTitle: 'Share of the event’s cost recovered',
    xTitle: 'Months from the event, the event month counted as M1',
    yFormat: v => fmt.pct(v, 0),
    series: [
      ...rec.filter(x => x.customers > 0).map(x => ({
        label: x.label, colour: EVENT_TYPE_INK[x.type] || EVENT_TYPE_INK[EVENT_UNCLASSIFIED], thin: true, values: x.curve,
      })),
      { label: 'Median event', colour: 'var(--ink)', values: medianCurve },
    ],
    refs: [{ value: 1, label: 'Paid for itself', variant: 'ref-goal' }],
    legendItems: [...typeLegend, { label: 'Median event, every event that reached that month', colour: 'var(--ink)' }],
    describe: i => {
      const at = rec.filter(x => x.curve[i] !== null).sort((a, b) => b.curve[i] - a.curve[i]);
      return `<strong>Month ${i + 1}</strong>`
        + `<span>Median ${pct(medianCurve[i])} of cost, across ${fmt.int(at.length)} events</span>`
        + at.slice(0, 4).map(x => `<span class="muted">${x.label}: ${pct(x.curve[i])}</span>`).join('');
    },
  });
  const six = rec.filter(x => x.at[6] !== null);
  const sixPaid = six.filter(x => x.at[6].recovered >= 1);
  const bestSix = [...six].sort((a, b) => b.at[6].recovered - a.at[6].recovered)[0];
  $('event-recovery-finding').innerHTML = six.length
    ? `<strong>Six months on, the median event, counting the ones nobody came from, has recovered `
      + `${pct(medianAt(6))} of its cost, and `
      + `${fmt.int(sixPaid.length)} of the ${fmt.int(six.length)} events old enough to judge have `
      + `recovered all of it.</strong> `
      + (bestSix ? `${bestSix.label} recovered ${pct(bestSix.at[6].recovered)} in its first six months. ` : '')
      + `Every event is drawn from its own month, so a January event and an October one are read `
      + `at the same age rather than on the same calendar.`
    : 'No event is six months old yet.';
  $('event-recovery-table').innerHTML =
    '<thead><tr><th>Event</th><th>When</th><th class="n">Cost</th><th class="n">Customers</th>'
    + '<th class="n">3 months</th><th class="n">6 months</th><th class="n">12 months</th></tr></thead><tbody>'
    + [...rec].sort((a, b) => a.month.localeCompare(b.month)).map(x => `<tr><td>${x.label}</td>`
      + `<td>${fmt.monthLabel(x.month)}</td><td class="n">${money(x.spend)}</td>`
      + `<td class="n">${fmt.int(x.customers)}</td>`
      + [3, 6, 12].map(k => `<td class="n">${x.at[k] === null ? '<span class="muted">not yet</span>'
          : `<span class="${x.at[k].recovered >= 1 ? 'held' : ''}">${pct(x.at[k].recovered)}</span>`}</td>`).join('')
      + '</tr>').join('')
    + '</tbody>';
  $('event-recovery-note').textContent =
    'Contribution from the customers an event brought, added up from the event’s month onward and '
    + 'divided by what the event cost. A month the data has not reached is blank rather than low, '
    + 'so a recent event is never ranked against an older one on months it has not had. The median '
    + 'line is drawn only where at least five events have reached that month. Events with no '
    + 'customer are left off the chart, since their line is flat at zero, and are in the table.';

  // ---------------------------------------------------------------- organisers
  const orgs = r.organisers;
  barList($('chart-event-organisers'), {
    items: [...orgs].sort((a, b) => b.net - a.net).map(o => ({
      label: o.organiser,
      sub: `${o.years.join(', ')} · ${qty(o.events.length, 'event')}`
        + ` · cost ${money(o.spend)} · ${o.plan2027.startsWith('On') ? '2027: on'
          : o.plan2027.startsWith('Dropped') ? '2027: dropped' : '2027: not listed'}`
        + (o.tooNew ? ' · too new to judge' : ''),
      value: o.net,
      muted: o.tooNew,
      colour: o.net >= 0 ? INK.positive : INK.negative,
    })),
    format: signed,
  });
  const onPlan = orgs.filter(o => o.plan2027.startsWith('On'));
  const onPlanBehind = onPlan.filter(o => o.net < 0 && !o.tooNew);
  const onPlanNew = onPlan.filter(o => o.tooNew);
  $('event-organisers-finding').innerHTML =
    `<strong>${fmt.int(onPlan.length)} organisers are on the 2027 calendar, and ${fmt.int(onPlanBehind.length)} `
    + `of them have not yet earned back what was spent with them.</strong> `
    + (onPlanNew.length ? `${onPlanNew.map(o => o.organiser).join(' and ')} ${onPlanNew.length === 1 ? 'is' : 'are'} `
        + `left out of that count: ${onPlanNew.length === 1 ? 'its' : 'their'} only event so far is under three months old. ` : '')
    + (onPlanBehind.length
        ? `The furthest behind: ${[...onPlanBehind].sort((a, b) => a.net - b.net).slice(0, 3)
            .map(o => `${o.organiser} ${signed(o.net)}`).join(', ')}. `
        : '')
    + `Several of them also bring customers through the standing partnership, tagged without a `
    + `year, which the table shows beside the events and never adds to them.`;
  $('event-organisers-table').innerHTML =
    '<thead><tr><th>Organiser</th><th>Events</th><th class="n">Cost</th><th class="n">Customers</th>'
    + '<th class="n">Net of cost</th><th class="n">Via the partnership</th><th>2027</th></tr></thead><tbody>'
    + orgs.map(o => `<tr><td>${o.organiser}<br><span class="muted">${o.types.join(', ')}</span></td>`
      + `<td>${o.events.map(x => `${x.label} <span class="muted">${x.month ? fmt.monthLabel(x.month) : ''}</span>`).join('<br>')}</td>`
      + `<td class="n">${money(o.spend)}</td><td class="n">${fmt.int(o.customers)}</td>`
      + `<td class="n"><span class="${o.net < 0 ? 'notviable' : 'held'}">${signed(o.net)}</span></td>`
      + `<td class="n">${o.partnerCustomers ? `${fmt.int(o.partnerCustomers)}<br><span class="muted">${fmt.int(o.partnerLive)} live</span>` : '–'}</td>`
      + `<td>${chip(o.plan2027)}</td></tr>`).join('')
    + '</tbody>';
  $('event-organisers-note').textContent =
    'An organiser is whoever runs the event: Lennox for its roadshow, both 2026 Lennox LIVE stops '
    + 'and the dealer day; CertainPath for its fall and spring expos; EGIA for Epic and Raising GOATS. '
    + '"Via the partnership" counts customers tagged with the standing relationship, such as '
    + '"Certain Path" or "Nexstar" with no year, which came through the partner channel rather than '
    + 'a dated event. 2027 status is from the 2027 Partnerships budget.'
    + (r.sums.agree ? ''
      : ` These do not add up: organisers total ${fmt.money(r.sums.organisers)} and kinds `
        + `${fmt.money(r.sums.types)} against ${fmt.money(r.sums.total)} for every costed event.`)
    + (r.organisers.some(o => o.organiser === EVENT_UNCLASSIFIED)
      ? ` ${EVENT_UNCLASSIFIED} gathers events on the Event Costs tab that EVENT_META does not yet describe.` : '');

  // ---------------------------------------------------------------- types
  barList($('chart-event-types'), {
    items: r.types.map(ty => ({
      label: ty.type,
      sub: `${qty(ty.events, 'event')} · cost ${money(ty.spend)} · ${qty(ty.customers, 'customer')}`,
      value: ty.net,
      colour: EVENT_TYPE_INK[ty.type] || EVENT_TYPE_INK[EVENT_UNCLASSIFIED],
    })),
    format: signed,
  });
  $('event-types-table').innerHTML =
    '<thead><tr><th>Kind of event</th><th class="n">Events</th><th class="n">Cost</th>'
    + '<th class="n">Customers</th><th class="n">Cost per customer</th><th class="n">Net of cost</th>'
    + '<th class="n">With no customer</th></tr></thead><tbody>'
    + r.types.map(ty => `<tr><td>${ty.type}</td><td class="n">${fmt.int(ty.events)}</td>`
      + `<td class="n">${money(ty.spend)}</td><td class="n">${fmt.int(ty.customers)}</td>`
      + `<td class="n">${ty.customers ? money(ty.spend / ty.customers) : '–'}</td>`
      + `<td class="n"><span class="${ty.net < 0 ? 'notviable' : 'held'}">${signed(ty.net)}</span></td>`
      + `<td class="n">${fmt.int(ty.nothing)}${ty.tooNew ? `<br><span class="muted">+${fmt.int(ty.tooNew)} too new</span>` : ''}</td></tr>`).join('')
    + '</tbody>';
  $('event-types-note').textContent =
    'A conference sponsorship is a booth or sponsorship at an open industry event. A partner network '
    + 'event is run by a manufacturer, distributor or membership network for its own members. A '
    + 'small room is a mastermind or offsite of a few dozen owners; training is a course or boot camp '
    + 'attended for the room. Which kind an event is was decided by hand and sits in EVENT_META; its '
    + 'cost and customers are not a judgement.';

  // ---------------------------------------------------------------- nothing to show
  const nothing = [...r.nothing].sort((a, b) => b.spend - a.spend);
  const nothingTotal = nothing.reduce((s, x) => s + x.spend, 0);
  const nothingOn = nothing.filter(x => (x.plan2027 || '').startsWith('On'));
  $('event-nothing-finding').innerHTML = nothing.length
    ? `<strong>${qty(nothing.length, 'event', 'events')} cost ${money(nothingTotal)} and no customer tagged to `
      + `${nothing.length === 1 ? 'it' : 'them'} has started paying since.</strong> `
      + (nothingOn.length
          ? `${fmt.int(nothingOn.length)} of them ${nothingOn.length === 1 ? 'is' : 'are'} on the 2027 calendar: `
            + `${nothingOn.map(x => x.label).join(', ')}. `
          : '')
      + (r.tooNew.length ? `${r.tooNew.map(x => x.label).join(' and ')} ${r.tooNew.length > 1 ? 'are' : 'is'} `
          + `left off: under three months old, too new to have customers yet. ` : '')
      + `For the ones the partnerships team reported on in November 2025, their own deal records agree: `
      + `demos and no contracts, or no demos at all, so the zero is a result rather than a tagging gap. `
      + `The rest may still hide customers nobody tagged.`
    : 'Every costed event has at least one tagged customer.';
  $('event-nothing-table').innerHTML =
    '<thead><tr><th>Event</th><th>When</th><th>Kind</th><th class="n">Cost</th>'
    + '<th class="n">Tagged, already paying</th><th>Partnerships report, Nov 2025</th><th>2027</th></tr></thead><tbody>'
    + nothing.map(x => `<tr><td>${x.label}</td><td>${fmt.monthLabel(x.month)}</td>`
      + `<td>${x.type || '–'}</td><td class="n">${money(x.spend)}</td>`
      + `<td class="n">${fmt.int(x.alreadyPaying || 0)}</td>`
      + `<td>${x.report2025 || '<span class="muted">not in the report</span>'}</td>`
      + `<td>${chip(x.plan2027)}</td></tr>`).join('')
    + '</tbody>';

  // ---------------------------------------------------------------- disputed fees, settled
  // Found by the decision the cost row carries, so a renamed row keeps its line.
  const byDecision = d => e.events.find(x => x.cost && x.cost.decision === d) || null;
  const applied = e.events.filter(x => x.cost && x.cost.decided).length;
  const changed = EVENT_FEE_DECISIONS.filter(d => d.now !== d.was);
  const kept = EVENT_FEE_DECISIONS.length - changed.length;
  const settledOnTab = changed.filter(d => { const x = byDecision(d); return x && !x.cost.decided; }).length;
  $('event-checks-table').innerHTML =
    '<thead><tr><th>Event</th><th class="n">Tab has</th><th class="n">Fee used</th>'
    + '<th>Evidence</th><th>Confidence</th><th class="n">Net of cost</th></tr></thead><tbody>'
    + EVENT_FEE_DECISIONS.map(d => {
      const x = byDecision(d);
      const used = x && x.cost ? x.cost.sponsor : null;
      const tab = x && x.cost ? x.cost.tabSponsor : null;
      return `<tr><td>${x ? x.label : d.event}${x ? ' ' + chip(x.plan2027)
          : '<br><span class="notviable">not on the Event Costs tab</span>'}</td>`
        + `<td class="n">${tab === null ? '–' : fmt.money(tab)}</td>`
        + `<td class="n">${used === null ? '–' : `<span class="${x.cost.decided ? 'held' : ''}">${fmt.money(used)}</span>`}</td>`
        + `<td>${d.evidence}</td><td>${d.confidence}</td>`
        + `<td class="n">${x && x.net !== null ? `<span class="${x.net < 0 ? 'notviable' : 'held'}">${signed(x.net)}</span>` : '–'}</td></tr>`;
    }).join('')
    + '</tbody>';
  $('event-checks-note').textContent =
    `${qty(applied, 'fee is', 'fees are')} changed from what the Event Costs tab carries`
    + (settledOnTab ? `, ${fmt.int(settledOnTab)} more ${settledOnTab === 1 ? 'is' : 'are'} already corrected on the tab,` : '')
    + ` and ${qty(kept, 'is', 'are')} kept, each on the evidence shown: the November 2025 Event ROI sheet `
    + 'and the QuickBooks export traced to each bill. A change applies only while the tab still carries '
    + 'the value it replaces, so once the tab is updated, or says anything else, the tab wins and the fee '
    + 'used is not highlighted. Strong means two sources agree; moderate means one.'
    + (e.decisionsMissing.length
      ? ` ${e.decisionsMissing.join('; ')} ${e.decisionsMissing.length === 1 ? 'is' : 'are'} no longer on the `
        + 'Event Costs tab under that name, so the decision applies to nothing.'
      : '');

  // ---------------------------------------------------------------- packages
  const packRow = p => `<tr><td>${p.label}</td>`
    + `<td>${p.members.length ? p.members.map(m => m.label).join(', ') : '<span class="muted">none in this window</span>'}`
    + `<br><span class="muted">${fmt.int(p.members.length)} of ${qty(p.covers || p.members.length, 'event')} so far</span></td>`
    + `<td class="n">${fmt.money(p.fee)}</td><td class="n">${money(p.spend)}</td>`
    + `<td class="n">${p.paid === null ? '–' : fmt.int(p.paid)}</td><td class="n">${money(p.collected)}</td>`
    + `<td class="n">${p.net === null ? '–' : signed(p.net)}</td></tr>`;
  $('event-packages-table').innerHTML =
    '<thead><tr><th>Package</th><th>Events it covered</th><th class="n">Fee</th>'
    + '<th class="n">Share so far and travel</th><th class="n">Customers</th><th class="n">Collected</th>'
    + '<th class="n">Net of cost</th></tr></thead><tbody>' + e.packages.map(packRow).join('') + '</tbody>';
  $('event-packages-note').textContent = e.packages.map(p => `${p.label}: ${p.basis}`).join(' ');

  // ---------------------------------------------------------------- channels
  const label = { event: 'Events', webinar: 'Webinars', podcast: 'Podcasts', digital: 'Digital',
    'partner or referral': 'Partner or referral', untagged: 'Untagged' };
  const ch = r.channels;
  $('event-channels-table').innerHTML =
    '<thead><tr><th>How they arrived</th><th class="n">New customers</th><th class="n">Live now</th>'
    + `<th class="n">Spend, ${fmt.monthLabel(CHANNEL_SPEND.from)} to ${fmt.monthLabel(CHANNEL_SPEND.to)}</th>`
    + '<th class="n">Per new customer then</th>'
    + '<th class="n">Median first MRR</th><th class="n">Paid a month</th>'
    + '<th class="n">Still here at 6 months</th><th class="n">At 12 months</th></tr></thead><tbody>'
    + ch.map(c => `<tr${c.key === 'untagged' ? ' class="muted"' : ''}><td>${label[c.key] || c.key}</td>`
      + `<td class="n">${fmt.int(c.customers)}</td><td class="n">${fmt.int(c.liveNow)}</td>`
      + `<td class="n">${c.spend === null ? (c.key === 'event' ? '<span class="muted">see above</span>' : '–')
          : `<span title="${(c.spendBasis || '').replace(/"/g, '&quot;')}">${fmt.money(c.spend)}</span>`}</td>`
      + `<td class="n">${c.costPerCustomer === null ? '–' : fmt.money(c.costPerCustomer)}`
      + `${c.startedInSpendWindow ? `<br><span class="muted">${fmt.int(c.startedInSpendWindow)} started</span>` : ''}</td>`
      + `<td class="n">${money(c.medianFirstMrr)}</td><td class="n">${money(c.revenuePerMonth)}</td>`
      + `<td class="n">${pct(c.kept6.rate)}<br><span class="muted">of ${fmt.int(c.kept6.n)}</span></td>`
      + `<td class="n">${pct(c.kept12.rate)}<br><span class="muted">of ${fmt.int(c.kept12.n)}</span></td></tr>`).join('')
    + '</tbody>';
  const evc = ch.find(c => c.key === 'event');
  const unt = ch.find(c => c.key === 'untagged');
  const web = ch.find(c => c.key === 'webinar');
  $('event-channels-finding').innerHTML = evc && unt && evc.kept12.rate !== null && unt.kept12.rate !== null
    ? `<strong>Customers from events are still here at twelve months ${pct(evc.kept12.rate)} of the time, `
      + `against ${pct(unt.kept12.rate)} for untagged customers.</strong> `
      + (web && web.kept12.rate !== null
          ? `Webinar customers start ${web.medianFirstMrr > evc.medianFirstMrr ? 'higher'
              : web.medianFirstMrr < evc.medianFirstMrr ? 'lower' : 'at the same price'}, at a median `
            + `${money(web.medianFirstMrr)} against ${money(evc.medianFirstMrr)} for events, and keep `
            + `${pct(web.kept12.rate)} at twelve months. `
          : '')
      + (() => {
          const dig = ch.find(c => c.key === 'digital');
          return dig && dig.costPerCustomer
            ? `Digital cost ${fmt.money(dig.spend)} in advertising over the twelve months, almost all of it `
              + `Facebook, against ${fmt.int(dig.startedInSpendWindow)} digital customers who started in those `
              + `months, ${fmt.money(dig.costPerCustomer)} each; webinars and the podcast carry no recorded cost.`
            : 'Webinars and the podcast carry no recorded cost.';
        })()
    : 'Not enough customers have reached twelve months to compare channels.';
  $('event-channels-note').textContent =
    'Customers who started paying inside the window, by the medium of their HubSpot lead source; '
    + 'untagged is everyone else, for comparison. Still here at six or twelve months is the share of '
    + 'those old enough to have had that long who were live that many months after their first '
    + 'payment, and is left blank below ten customers. Paid a month is everything they paid divided by '
    + 'their paying months. Spend is QuickBooks advertising (6100-05) by vendor for digital; webinars and '
    + 'the podcast have none; events are costed in the tables above; partners are paid in revenue share, '
    + 'which this page counts as a cost of keeping customers, so their row carries none. Per new customer '
    + 'divides the spend by the tagged customers who started in the same twelve months, so with '
    + (untaggedShare === null ? 'some' : `about ${pct(untaggedShare)} of live`) + ' customers untagged it '
    + 'is a ceiling, not a cost.';

  // ---------------------------------------------------------------- tagging coverage
  const cov = r.coverage;
  multiLineChart($('chart-event-coverage'), {
    labels: cov.map(c => fmt.monthLabel(c.month)),
    yMin: 0, yMax: 1,
    yTitle: 'Share of that month’s new customers',
    yFormat: v => fmt.pct(v, 0),
    series: [
      { label: 'Carry any lead source', colour: INK.primary, values: cov.map(c => c.share) },
      { label: 'Carry an event', colour: INK.secondary, values: cov.map(c => (c.starters ? c.event / c.starters : null)) },
    ],
    describe: i => `<strong>${fmt.monthLabel(cov[i].month)}</strong>`
      + `<span>${fmt.int(cov[i].tagged)} of ${fmt.int(cov[i].starters)} new customers tagged</span>`
      + `<span>${fmt.int(cov[i].event)} from an event</span>`,
  });
  const recent = cov.slice(-6);
  const recentShare = recent.reduce((s, c) => s + c.tagged, 0) / (recent.reduce((s, c) => s + c.starters, 0) || 1);
  const early = cov.slice(0, 12);
  const earlyShare = early.reduce((s, c) => s + c.tagged, 0) / (early.reduce((s, c) => s + c.starters, 0) || 1);
  $('event-coverage-finding').innerHTML =
    `<strong>${pct(recentShare)} of the last six months’ new customers carry a lead source, against `
    + `${pct(earlyShare)} in the first year of the window.</strong> `
    + `Every event figure above is a floor by the untagged share of its months, so tagging is what `
    + `makes this tab more right over time, and the older events are the most understated.`;
  $('event-coverage-note').textContent =
    'New customers by the month of their first payment, and the share whose HubSpot record carries '
    + 'a lead source of any medium, and of the event medium. Customers already paying when the window '
    + 'opens are left out, since they have no first month.';

  renderEvents.latest = { e, r };
  const button = $('events-download');
  if (button && !button.dataset.ready) {
    button.addEventListener('click', () => {
      const cell = v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
        const text = String(v);
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      };
      const { e, r } = renderEvents.latest;
      const recBy = new Map(r.recovery.map(x => [x.label, x]));
      const head = ['event', 'month', 'kind', 'organiser', 'plan_2027', 'hubspot_lead_source',
        'sponsor', 'sponsor_basis', 'travel', 'cost', 'customers', 'already_paying_before_event',
        'live_now', 'mrr_now', 'collected', 'contribution', 'net_of_cost',
        'recovered_3m', 'recovered_6m', 'recovered_12m'];
      const lines = [head.join(',')].concat(e.events.map(x => {
        const rc = recBy.get(x.label);
        const at = k => (rc && rc.at[k] ? rc.at[k].recovered : null);
        return [x.label, x.month, x.type, x.organiser, x.plan2027, x.source,
          x.cost ? x.cost.sponsor : null, x.cost ? x.cost.sponsorBasis : null,
          x.cost ? x.cost.travel : null, x.spend, x.paid, x.alreadyPaying, x.liveNow, x.mrrNow,
          x.collected, x.contribution, x.net, at(3), at(6), at(12)].map(cell).join(',');
      }));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `chiirp-event-roi-${e.lastMonth}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      $('events-status').textContent = `${fmt.int(e.events.length)} events exported.`;
    });
    button.dataset.ready = '1';
  }
}

// 41. The ledger behind every other cost figure on this page.
function renderLedger() {
  if (!$('ledger-table')) return;
  const l = costLedger(data, { months: 6 });
  if (!l) return;

  const money = v => (Math.abs(v) < 0.5 ? '–' : fmt.money(v));
  const cols = l.window.map(m => fmt.monthLabel(m));
  const latest = l.counts[l.counts.length - 1];

  // Per logo uses the denominator that layer is actually divided by, which is
  // the whole reason the acquisition rows are kept in a separate block.
  const perLogo = (group, value) => {
    const n = group.key === 'acquisition' ? latest.newLogos : latest.paying;
    return n ? value / n : null;
  };

  const head = '<thead><tr><th>Account</th><th>Bucket</th>'
    + cols.map(c => `<th class="n">${c}</th>`).join('')
    + `<th class="n">Per logo, ${cols[cols.length - 1]}</th></tr></thead>`;

  const body = l.groups.map(g => {
    const rows = g.accounts.map(a => {
      const last = a.values[a.values.length - 1];
      return '<tr>'
        + `<td class="mono">${a.account}</td>`
        + `<td class="muted">${a.bucket || '–'}</td>`
        + a.values.map(v => `<td class="n">${money(v)}</td>`).join('')
        + `<td class="n">${money(perLogo(g, last))}</td>`
        + '</tr>';
    }).join('');
    const sub = g.subtotal[g.subtotal.length - 1];
    return `<tr class="rule-above emphasis"><td colspan="${2 + cols.length + 1}">`
      + `<strong>${g.label}</strong> <span class="muted">${g.note} `
      + `Divided ${g.basis}.</span></td></tr>`
      + rows
      + `<tr class="rule-above"><td><strong>${g.label} subtotal</strong></td><td></td>`
      + g.subtotal.map(v => `<td class="n"><strong>${money(v)}</strong></td>`).join('')
      + `<td class="n"><strong>${money(perLogo(g, sub))}</strong></td></tr>`;
  }).join('');

  const ongoingLast = l.ongoingTotal[l.ongoingTotal.length - 1];
  const acqLast = l.acquisitionTotal[l.acquisitionTotal.length - 1];
  const totals =
    `<tr class="rule-above emphasis"><td><strong>Ongoing cost, everything except acquisition</strong></td><td></td>`
    + l.ongoingTotal.map(v => `<td class="n"><strong>${money(v)}</strong></td>`).join('')
    + `<td class="n"><strong>${money(latest.paying ? ongoingLast / latest.paying : null)}</strong></td></tr>`
    + `<tr><td><strong>Acquisition</strong></td><td></td>`
    + l.acquisitionTotal.map(v => `<td class="n"><strong>${money(v)}</strong></td>`).join('')
    + `<td class="n"><strong>${money(latest.newLogos ? acqLast / latest.newLogos : null)}</strong></td></tr>`;

  const basis = '<tr class="rule-above"><td>Paying logos</td><td></td>'
    + l.counts.map(c => `<td class="n">${fmt.int(c.paying)}</td>`).join('') + '<td></td></tr>'
    + '<tr><td>Active logos</td><td></td>'
    + l.counts.map(c => `<td class="n">${fmt.int(c.active)}</td>`).join('') + '<td></td></tr>'
    + '<tr><td>New logos</td><td></td>'
    + l.counts.map(c => `<td class="n">${fmt.int(c.newLogos)}</td>`).join('') + '<td></td></tr>'
    + '<tr><td>Subscription revenue</td><td></td>'
    + l.counts.map(c => `<td class="n">${fmt.money(c.mrr)}</td>`).join('') + '<td></td></tr>';

  $('ledger-table').innerHTML = head + '<tbody>' + body + totals + basis + '</tbody>';

  const perPaying = latest.paying ? ongoingLast / latest.paying : 0;
  const perNew = latest.newLogos ? acqLast / latest.newLogos : 0;
  $('ledger-finding').innerHTML =
    `<strong>${fmt.int(l.accountCount)} accounts, ${l.window.length} months, and every other cost `
    + `figure on this page is a sum of some subset of these rows.</strong> In `
    + `${cols[cols.length - 1]} the business spent ${fmt.money(ongoingLast)} keeping `
    + `${fmt.int(latest.paying)} paying customers, which is ${fmt.money(perPaying)} each, `
    + `and ${fmt.money(acqLast)} winning ${fmt.int(latest.newLogos)} new ones, which is `
    + `${fmt.money(perNew)} each. The two per-logo figures divide by different `
    + `denominators and must not be added. `
    + `<strong>One row needs reading with care:</strong> 6100-06 is the Service Titan `
    + `revenue share and partner rebates, and the latest month carries a $69,848 invoice `
    + `whose credit QuickBooks dates the 31st, inside the month, but which was posted after `
    + `this push pulled the month, so the table has the charge and not the reversal. `
    + `Underlying it is close to the month before.`;

  $('ledger-note').textContent =
    'Every QuickBooks account carrying a non-zero amount in the window, grouped into the '
    + 'layers the price floors use. The grouping is the only editorial act here: which '
    + 'layer an account belongs to is a judgement, the amounts are not, and the account '
    + 'code is given so any of them can be checked against the ledger. Revenue, other '
    + 'income and taxes are excluded, because they are not costs of anything. The bucket column '
    + 'is the pipeline’s own classification and is shown because it does not always '
    + 'agree with the layer: 6100-06 is bucketed COGS and grouped here as variable cost, '
    + 'which is correct in both cases for different reasons, while the other 6100 accounts '
    + 'are bucketed CAC and grouped as acquisition. Per-logo divides by PAYING logos for '
    + 'every ongoing layer and by NEW logos for acquisition, because those are the '
    + 'populations each cost is actually incurred against. Adding the two per-logo columns '
    + 'together would be meaningless.';
}


// 40. What the business spends to run, by layer, in money rather than per logo.
//
// The per-logo charts answer "what does a customer cost" and are the right
// frame for pricing. They are the wrong frame for "is this a sensible cost
// structure", because dividing by a shrinking base makes every line rise and
// a reader cannot tell a spending decision from a denominator. This is the
// same costs in absolute dollars, with the per-logo figure beside it rather
// than instead of it.
function renderSpend() {
  if (!$('chart-spend')) return;
  const l = costLedger(data, { months: 6 });
  if (!l) return;

  const defs = l.groups.map(g => ({
    key: g.key,
    label: g.label,
    // Acquisition is off by default: it is not a cost of running what you
    // have, and leaving it on makes the total answer a different question
    // from the one the chart is asking.
    defaultOn: g.key !== 'acquisition',
    hint: g.note,
  }));
  buildToggles('spend-layers', defs, renderSpend);
  const on = ticked('spend-layers');
  const shown = l.groups.filter(g => on.has(g.key));

  const labels = l.window.map(m => fmt.monthLabel(m));
  const palette = [INK.primary, INK.secondary, INK.tertiary, INK.negative, INK.accent,
                   'var(--ink-soft)'];
  const totals = l.window.map((m, i) => shown.reduce((s, g) => s + g.subtotal[i], 0));

  if (!shown.length) {
    $('chart-spend').innerHTML = '<p class="empty">No layers selected.</p>';
    $('spend-table').innerHTML = '';
    $('spend-finding').textContent = '';
    return;
  }

  multiLineChart($('chart-spend'), {
    yTitle: 'Monthly spend',
    labels,
    yFormat: fmt.money,
    series: [
      { label: 'Selected layers, total', colour: 'var(--ink)', values: totals },
      { label: 'All revenue', colour: INK.positive, dashed: true,
        values: l.counts.map(c => c.revenue) },
      { label: 'Subscription only', colour: INK.positive, thin: true,
        values: l.counts.map(c => c.mrr) },
      ...shown.map((g, i) => ({
        label: g.label, colour: palette[i % palette.length], thin: true,
        values: g.subtotal,
      })),
    ],
    describe: i => {
      const c = l.counts[i];
      return `<strong>${labels[i]}</strong>`
        + `<span>Selected total ${fmt.money(totals[i])}</span>`
        + `<span>All revenue ${fmt.money(c.revenue)}</span>`
        + `<span class="muted">subscription ${fmt.money(c.mrr)}, usage `
        + `${fmt.money(c.usage)}, setup ${fmt.money(c.oneTime)}, 10DLC `
        + `${fmt.money(c.passThrough)}</span>`
        + `<span class="muted">cash that arrived ${fmt.money(c.netCash)}</span>`
        + shown.map(g => `<span class="muted">${g.label} ${fmt.money(g.subtotal[i])}</span>`).join('')
        + `<span class="muted">${fmt.int(c.paying)} paying of ${fmt.int(c.active)} active</span>`;
    },
  });

  // ------------------------------------------------------------ the table
  const cols = labels;
  const head = '<thead><tr><th>Layer</th>'
    + cols.map(c => `<th class="n">${c}</th>`).join('')
    + '<th class="n">Annualised</th><th class="n">Per logo</th></tr></thead>';

  const last = l.window.length - 1;
  const latest = l.counts[last];
  const rowFor = g => {
    const n = g.key === 'acquisition' ? latest.newLogos : latest.paying;
    return '<tr>'
      + `<td>${g.label}${on.has(g.key) ? '' : ' <span class="muted">(off)</span>'}</td>`
      + g.subtotal.map(v => `<td class="n">${fmt.money(v)}</td>`).join('')
      + `<td class="n">${fmt.money(g.subtotal[last] * 12)}</td>`
      + `<td class="n">${n ? fmt.money(g.subtotal[last] / n) : '–'}</td>`
      + '</tr>';
  };

  const body = l.groups.map(rowFor).join('')
    + '<tr class="rule-above emphasis"><td><strong>Selected total</strong></td>'
    + totals.map(v => `<td class="n"><strong>${fmt.money(v)}</strong></td>`).join('')
    + `<td class="n"><strong>${fmt.money(totals[last] * 12)}</strong></td>`
    + `<td class="n"><strong>${latest.paying ? fmt.money(totals[last] / latest.paying) : '–'}</strong></td></tr>`
    + '<tr class="rule-above"><td>Subscription</td>'
    + l.counts.map(c => `<td class="n">${fmt.money(c.mrr)}</td>`).join('')
    + `<td class="n">${fmt.money(latest.mrr * 12)}</td>`
    + `<td class="n">${latest.paying ? fmt.money(latest.mrr / latest.paying) : '–'}</td></tr>`
    + '<tr><td>Usage and credits</td>'
    + l.counts.map(c => `<td class="n">${fmt.money(c.usage)}</td>`).join('')
    + `<td class="n">${fmt.money(latest.usage * 12)}</td>`
    + `<td class="n">${latest.paying ? fmt.money(latest.usage / latest.paying) : '–'}</td></tr>`
    + '<tr><td>Setup and one-time</td>'
    + l.counts.map(c => `<td class="n">${fmt.money(c.oneTime)}</td>`).join('')
    + `<td class="n">${fmt.money(latest.oneTime * 12)}</td>`
    + `<td class="n">${latest.paying ? fmt.money(latest.oneTime / latest.paying) : '–'}</td></tr>`
    + '<tr><td>10DLC and pass-through</td>'
    + l.counts.map(c => `<td class="n">${fmt.money(c.passThrough)}</td>`).join('')
    + `<td class="n">${fmt.money(latest.passThrough * 12)}</td>`
    + `<td class="n">${latest.paying ? fmt.money(latest.passThrough / latest.paying) : '–'}</td></tr>`
    + '<tr class="emphasis"><td><strong>All revenue</strong></td>'
    + l.counts.map(c => `<td class="n"><strong>${fmt.money(c.revenue)}</strong></td>`).join('')
    + `<td class="n"><strong>${fmt.money(latest.revenue * 12)}</strong></td>`
    + `<td class="n"><strong>${latest.paying ? fmt.money(latest.revenue / latest.paying) : '–'}</strong></td></tr>`
    + '<tr><td class="muted">Cash that actually arrived</td>'
    + l.counts.map(c => `<td class="n muted">${fmt.money(c.netCash)}</td>`).join('')
    + '<td></td><td></td></tr>'
    + '<tr class="rule-above"><td>Paying logos</td>'
    + l.counts.map(c => `<td class="n">${fmt.int(c.paying)}</td>`).join('') + '<td></td><td></td></tr>'
    + '<tr><td>Active logos</td>'
    + l.counts.map(c => `<td class="n">${fmt.int(c.active)}</td>`).join('') + '<td></td><td></td></tr>'
    + '<tr><td>New logos</td>'
    + l.counts.map(c => `<td class="n">${fmt.int(c.newLogos)}</td>`).join('') + '<td></td><td></td></tr>';

  $('spend-table').innerHTML = head + '<tbody>' + body + '</tbody>';

  // ------------------------------------------------------------ the finding
  const serve = l.groups.filter(g => ['platform', 'people', 'variable'].includes(g.key))
    .reduce((s, g) => s + g.subtotal[last], 0);
  const overhead = l.groups.filter(g => ['ga', 'rd'].includes(g.key))
    .reduce((s, g) => s + g.subtotal[last], 0);
  const ga = (l.groups.find(g => g.key === 'ga') || { subtotal: [] }).subtotal[last] || 0;
  const platform = (l.groups.find(g => g.key === 'platform') || { subtotal: [] }).subtotal[last] || 0;

  $('spend-finding').innerHTML =
    `<strong>Of ${fmt.money(serve + overhead)} a month to run what you already have, `
    + `${fmt.money(serve)} is serving customers and ${fmt.money(overhead)} is being a `
    + `company.</strong> Only the first scales with the customer count. G&A and R&D would `
    + `look much the same at half the base or twice it, which is why quoting the combined `
    + `figure per logo makes maintenance sound about twice as expensive as it is: serving `
    + `is ${fmt.money(latest.paying ? serve / latest.paying : 0)} a logo and the rest is `
    + `${fmt.money(latest.paying ? overhead / latest.paying : 0)} of overhead divided by a `
    + `number that happens to be the customer count. `
    + `<strong>G&A alone runs ${fmt.money(ga * 12)} a year`
    + (ga > platform ? `, more than the entire platform` : '')
    + `.</strong> `
    + (() => {
        const allCost = serve + overhead
          + ((l.groups.find(g => g.key === 'acquisition') || { subtotal: [] }).subtotal[last] || 0);
        const gap = latest.revenue - allCost;
        // The latest month's variable layer against its usual share of revenue,
        // the median of the months before it. This push pulled August before
        // its revenue-share credit was posted, and the finding used to quote
        // the month as kept on that figure without saying so.
        const variable = (l.groups.find(g => g.key === 'variable') || { subtotal: [] }).subtotal;
        const priorRates = l.counts.slice(0, -1)
          .map((c, i) => (c.revenue ? variable[i] / c.revenue : null)).filter(v => v !== null)
          .sort((a, b) => a - b);
        const usualRate = priorRates.length ? priorRates[priorRates.length >> 1] : null;
        const excess = usualRate !== null && variable[last] !== undefined
          ? variable[last] - usualRate * latest.revenue : 0;
        const flagged = excess > 0.25 * (usualRate * latest.revenue);
        const usualGap = gap + (flagged ? excess : 0);
        const usualSub = latest.mrr - allCost + (flagged ? excess : 0);
        return `Against every cost including acquisition, ${fmt.money(allCost)}, the `
          + `business took ${fmt.money(latest.revenue)} and kept `
          + `${fmt.money(gap)} in ${fmt.monthLabel(latest.month)}. `
          + (flagged
            ? `That month's merchant and revenue share layer is ${fmt.money(excess)} above its `
              + `usual share of revenue, because this push pulled the month before the `
              + `revenue-share credit was posted; at the usual share it keeps about `
              + `${fmt.money(usualGap)}. `
            : '')
          + `Subscription alone is ${fmt.money(latest.mrr)}, which would make the same month `
          + `${fmt.money(usualSub)}${flagged ? ' on that usual share' : ''}. Usage, setup and `
          + `10DLC are ${fmt.money(latest.revenue - latest.mrr)} a month and `
          + (usualSub < 0 ? 'they are the margin. ' : 'they are a large part of the margin. ')
          + `The cash that actually arrived was ${fmt.money(latest.netCash)}, within `
          + `${fmt.pct(Math.abs(latest.netCash - latest.revenue) / latest.revenue, 1)} of `
          + `the four components summed, which is the check that they are the right four.`;
      })();

  $('spend-note').textContent =
    'The same accounts as the table below, summed into layers and left in dollars. Six '
    + 'trailing months. Annualised is the latest month times twelve, which is a run rate '
    + 'rather than a forecast and will be wrong for anything seasonal or lumpy. Per logo '
    + 'divides by PAYING logos for every layer except acquisition, which divides by NEW '
    + 'logos: the two are not comparable and are never added. Acquisition is off by '
    + 'default because it is the cost of growing rather than of running what you have; '
    + 'switch it on for the whole cost of the business. Two revenue lines are drawn: the '
    + 'dashed one is everything a customer pays and the thin one is subscription alone, '
    + 'which leaves out usage, setup and pass-through, about a tenth more. '
    + 'The revenue rows are everything a customer pays: subscription, usage and message '
    + 'credits, setup and one-time charges, and 10DLC and carrier pass-through. An '
    + 'earlier version of this chart compared the full cost base against subscription '
    + 'alone, which understated revenue by about a tenth and turned a real surplus into '
    + 'an apparent break-even. Recognised-elsewhere revenue is excluded because it is '
    + 'already carried by a couponed subscription and counting it again would double it. '
    + 'The cash row is what arrived and is shown as a check rather than as a fifth '
    + 'component. '
    + 'One month to read with care: the merchant and revenue share layer carries an '
    + 'invoice in the latest month whose credit was posted after this push pulled the month, '
    + 'so it reads about $70,000 high and the layer beneath it is closer to the months before. '
    + 'The next push carries the closed month.';
}


// 42. The calculator. Both halves of the fraction, and the answer.
function renderCalculator() {
  if (!$('calc-costs')) return;

  const costDefs = COST_LAYERS.map(l => ({
    key: l.key,
    label: l.label,
    defaultOn: l.key !== 'acquisition',
    hint: l.note,
  }));
  buildToggles('calc-costs', costDefs, renderCalculator);
  buildToggles('calc-logos', LOGO_TYPES, renderCalculator);

  // The presets set the switches; the switches remain the source of truth, so
  // a reader can start from a named definition and then depart from it.
  const box = $('calc-presets');
  if (box && !box.dataset.ready) {
    for (const p of CALC_PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.preset = p.key;
      b.innerHTML = `<strong>${p.label}</strong><span>${p.blurb}</span>`;
      b.addEventListener('click', () => {
        for (const input of $('calc-costs').querySelectorAll('input')) {
          input.checked = p.costs.includes(input.value);
        }
        renderCalculator();
      });
      box.append(b);
    }
    box.dataset.ready = '1';
  }

  const costKeys = [...ticked('calc-costs')];
  const logoKeys = [...ticked('calc-logos')];
  const c = costCalculator(data, { costKeys, logoKeys });
  if (!c) return;

  if (!costKeys.length || !logoKeys.length) {
    $('calc-result').innerHTML = '<p class="empty">'
      + (!costKeys.length ? 'No costs selected.' : 'No logos selected.') + '</p>';
    $('calc-detail').innerHTML = '';
    return;
  }

  const pct = c.revenue ? (c.left || 0) / c.revenue : null;
  const verdict = pct === null ? '' : (pct > 0.2 ? 'good' : pct > 0 ? 'thin' : 'under');

  const same = (a, b) => a.length === b.length && a.every(k => b.includes(k));
  const active = CALC_PRESETS.find(p => same(p.costs, costKeys));
  if ($('calc-presets')) {
    for (const b of $('calc-presets').querySelectorAll('button')) {
      b.classList.toggle('is-on', !!active && b.dataset.preset === active.key);
    }
  }

  $('calc-result').innerHTML =
    `<div class="calc-label">${active ? active.label : 'Custom definition'}</div>`
    + `<div class="calc-headline ${verdict}">`
    + `<span class="calc-number">${fmt.money(c.blended)}</span>`
    + `<span class="calc-unit">per customer, per month</span>`
    + `</div>`
    + `<div class="calc-against">`
    + `<span>Against ${fmt.money(c.revenue)} of revenue on the same logos</span>`
    + `<strong class="${(c.left || 0) >= 0 ? 'pos' : 'neg'}">`
    + `${(c.left || 0) >= 0 ? 'leaves ' : 'short by '}${fmt.money(Math.abs(c.left || 0))}`
    + `${pct === null ? '' : ', ' + fmt.pct(Math.abs(pct), 1)}</strong>`
    + `</div>`;

  const row = (label, value, muted) =>
    `<tr${muted ? ' class="muted"' : ''}><td>${label}</td><td class="n">${value}</td>`
    + '<td class="n"></td></tr>';
  const row3 = (label, value, third, muted) =>
    `<tr${muted ? ' class="muted"' : ''}><td>${label}</td><td class="n">${value}</td>`
    + `<td class="n">${third}</td></tr>`;

  $('calc-detail').innerHTML =
    '<table class="data-table calc-table"><tbody>'
    + '<tr class="emphasis"><td colspan="3"><strong>How it is built</strong></td></tr>'
    + row('Six-month window', `${fmt.money(c.six.cost)} &divide; ${fmt.int(c.six.logos)} `
        + `= <strong>${fmt.money(c.six.perLogo)}</strong>`)
    + row('Three-month window', `${fmt.money(c.three.cost)} &divide; ${fmt.int(c.three.logos)} `
        + `= <strong>${fmt.money(c.three.perLogo)}</strong>`)
    + row('Blended 50-50', `<strong>${fmt.money(c.blended)}</strong>`)
    + '<tr class="emphasis rule-above"><td><strong>Costs counted, monthly</strong></td>'
    + '<td class="n"><strong>Spend</strong></td>'
    + '<td class="n"><strong>Revenue per $1</strong></td></tr>'
    + c.layers.map(l => row3(l.label, fmt.money(l.month),
        l.revenuePerDollar === null ? '–'
          : `$${l.revenuePerDollar.toFixed(2)} <span class="muted">`
            + `(${fmt.pct(l.shareOfRevenue, 1)})</span>`)).join('')
    + (() => {
        const spend = c.layers.reduce((s, l) => s + l.month, 0);
        return row3('<strong>Total</strong>', `<strong>${fmt.money(spend)}</strong>`,
          spend ? `<strong>$${(c.revenueMonth / spend).toFixed(2)}</strong> `
            + `<span class="muted">(${fmt.pct(spend / c.revenueMonth, 1)})</span>` : '–');
      })()
    + row3('<span class="muted">All revenue, monthly</span>',
        `<span class="muted">${fmt.money(c.revenueMonth)}</span>`, '')
    + '<tr class="emphasis rule-above"><td colspan="3"><strong>Logos counted</strong></td></tr>'
    + LOGO_TYPES.map(t => row(t.label,
        c.logoKeys.includes(t.key) ? 'counted' : 'excluded', !c.logoKeys.includes(t.key))).join('')
    + row('<strong>Average in the window</strong>', `<strong>${fmt.int(c.three.logos)}</strong>`)
    + '</tbody></table>';

  $('calc-note').textContent =
    'Both halves of the fraction are switches, because most arguments about cost per '
    + 'customer are really arguments about which costs belong on top and which logos '
    + 'belong underneath. Blended 50-50 between the last six months and the last three: '
    + 'six alone is slow to notice a change, three alone moves with any single odd month, '
    + 'and this ledger has one of those in it. Acquisition is off by default because it '
    + 'is the cost of winning a customer rather than keeping one, and because it is '
    + 'incurred per NEW logo while everything else here is per existing one; switching '
    + 'it on spreads it across the whole base, which answers whether the business washes '
    + 'its face rather than what a customer costs. Never-paid accounts are off by default '
    + 'as test and agency seats; lapsed accounts are on, because a customer at zero is '
    + 'still served and still costs. Revenue is everything a customer pays, on the same '
    + 'logo count, so the two sides are comparable. '
    + 'Revenue per $1 is how much revenue stands beside each dollar of that layer, with '
    + 'the layer as a share of revenue in brackets. It is an intensity measure and not a '
    + 'return: spending another dollar on rent does not produce seven more of revenue, '
    + 'and a layer with a high figure is not therefore a good investment. It is useful '
    + 'for the opposite reading: a layer whose figure is falling is taking a growing '
    + 'share of what comes in. Remember what the headline is: an average, '
    + 'not a marginal cost. Almost none of it changes when one customer leaves.';
}


// The campaign calculator, sitting above the list it describes.
let CAMP = { rule: 'floor', churn: 0.33 };

function renderCampaign() {
  if (!$('camp-result')) return;

  // Each option states its own figure. A preset called "expected" that does
  // not say 33% is asking the reader to trust a label instead of a number.
  const spread = ruleSpread(data);
  const figureFor = {
    // Every target is flat under either rule, so the total asked is what
    // separates them, and each button carries its own pool's total.
    floor: () => {
      const s = spread.floor;
      return s ? `${fmt.money(s.median)} each, ${fmt.money(s.total)} asked` : '';
    },
    tiered: () => {
      const s = spread.tiered;
      return s ? `$500 or $750, ${fmt.money(s.total)} asked` : '';
    },
    light: () => '20% leave',
    expected: () => '33% leave',
    hard: () => '50% leave',
    scaled: () => '10% to 80%, by size of ask',
  };

  const buttons = (id, defs, pick, active) => {
    const box = $(id);
    if (!box.dataset.ready) {
      for (const p of defs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.key = p.key;
        const fig = figureFor[p.key] ? figureFor[p.key]() : '';
        b.innerHTML = `<strong>${p.label}</strong>`
          + (fig ? `<em class="preset-figure">${fig}</em>` : '')
          + `<span>${p.blurb}</span>`;
        b.addEventListener('click', () => {
          pick(p);
          renderCampaign();
          renderUpgradeList();
        });
        box.append(b);
      }
      box.dataset.ready = '1';
    }
    for (const b of box.querySelectorAll('button')) {
      b.classList.toggle('is-on', b.dataset.key === active);
    }
  };

  buttons('camp-rule', PRICING_PRESETS, p => { CAMP.rule = p.key; }, CAMP.rule);
  buttons('camp-churn', CHURN_PRESETS,
    p => { CAMP.churn = p.rate; CAMP.churnKey = p.key; },
    CAMP.churnKey || 'expected');

  // Which bands to ask. Defaults to active users only, which is where the
  // band economics land once cost follows usage rather than headcount.
  const econ = bandEconomics(data);
  if (econ) {
    buildToggles('camp-bands', econ.bands.map(b => ({
      key: b.key, label: b.label, defaultOn: b.key === 'users',
      hint: `${b.definition} ${b.accounts} accounts, `
        + `pays ${fmt.money(b.pays)}, costs ${fmt.money(b.cost)}, `
        + `keeps ${fmt.money(b.keeps)}.`,
    })), renderCampaign);
  }
  const askBands = econ ? [...ticked('camp-bands')] : [];
  const bc = econ && askBands.length
    ? bandCampaign(data, { ask: askBands, rule: CAMP.rule === 'tiered' ? 'tiered' : 'flat',
        churn: CAMP.churn === 'scaled' ? null : CAMP.churn })
    : null;

  const c = campaign(data, { rule: CAMP.rule, churn: CAMP.churn });
  if (!c) return;

  const good = c.change > 0 && c.clears;
  const verdict = good ? 'good' : c.change > 0 ? 'thin' : 'under';

  $('camp-result').innerHTML =
    `<div class="calc-label">${c.change >= 0 ? 'Monthly revenue gained' : 'Monthly revenue lost'}</div>`
    + `<div class="calc-headline ${verdict}">`
    + `<span class="calc-number">${c.change >= 0 ? '+' : '−'}${fmt.money(Math.abs(c.change))}</span>`
    + `<span class="calc-unit">a month, ${fmt.money(Math.abs(c.annual))} a year</span>`
    + `</div>`
    + `<div class="calc-against">`
    + `<span>${fmt.int(c.asked)} accounts asked, about ${fmt.int(c.lost)} expected to leave</span>`
    + `<strong class="${c.clears ? 'pos' : 'neg'}">`
    + (c.clears
        ? `everyone asked lands at ${fmt.money(c.lowestTouched)} or above, clear of the `
          + `${fmt.money(c.floorAfter)} floor it creates`
        : `the cheapest account asked lands at ${fmt.money(c.lowestTouched)}, below the `
          + `${fmt.money(c.floorAfter)} floor it creates`)
    + `</strong>`
    + (c.untouchedBelowFloor
        ? `<span class="muted">${fmt.int(c.untouchedBelowFloor)} accounts not in this `
          + `campaign are still under that floor, worth `
          + `${fmt.money(c.untouchedBelowMrr)} a month</span>`
        : '')
    + `</div>`;

  const r = (a, b) => `<tr><td>${a}</td><td class="n">${b}</td></tr>`;
  $('camp-detail').innerHTML =
    '<table class="data-table calc-table"><tbody>'
    + r('Accounts eligible and worth asking', fmt.int(c.poolSize))
    + r('Asked for an increase', fmt.int(c.asked))
    + r('Expected to accept', `<strong>${fmt.int(c.kept)}</strong>`)
    + r('Expected to leave', `<strong>${fmt.int(c.lost)}</strong>`)
    + r('Paying logos, before and after',
        `${fmt.int(c.logosBefore)} → <strong>${fmt.int(c.logosAfter)}</strong>`)
    + r('Monthly revenue, before and after',
        `${fmt.money(c.before)} → <strong>${fmt.money(c.after)}</strong>`)
    + r('Cost floor, before and after',
        `${fmt.money(c.floorBefore)} → <strong>${fmt.money(c.floorAfter)}</strong>`)
    + '</tbody></table>';

  if (econ) {
    const row = b => {
      const r = bc ? bc.rows.find(x => x.key === b.key) : null;
      return '<tr>'
        + `<td>${b.label}${r && r.asked ? '' : ' <span class="muted">(left alone)</span>'}</td>`
        + `<td class="n">${fmt.int(b.accounts)}</td>`
        + `<td class="n">${fmt.money(b.pays)}</td>`
        + `<td class="n">${fmt.money(b.cost)}</td>`
        + `<td class="n"><strong>${fmt.money(b.keeps)}</strong></td>`
        + `<td class="n">${b.returnOnCost ? b.returnOnCost.toFixed(1) + 'x' : '–'}</td>`
        + `<td class="n">${fmt.money(b.keepsTotal)}</td>`
        + '</tr>';
    };
    $('camp-bandtable').innerHTML =
      '<table class="data-table calc-table"><thead><tr><th>Band</th>'
      + '<th class="n">Accounts</th><th class="n">Pays</th><th class="n">Costs</th>'
      + '<th class="n">Keeps</th><th class="n">Per $1 of cost</th>'
      + '<th class="n">Total a month</th></tr></thead><tbody>'
      + econ.bands.map(row).join('')
      + `<tr class="rule-above emphasis"><td><strong>All ${fmt.int(econ.totalAccounts)}</strong></td>`
      + '<td></td><td></td><td></td><td></td><td></td>'
      + `<td class="n"><strong>${fmt.money(econ.totalKeeps)}</strong></td></tr>`
      // The gain is measured from leaving every band alone, after its background
      // churn and after revenue share as well as the merchant fee. That row was
      // not shown, so the after-campaign figure sat under the bigger "All" total
      // and read as a fall labelled as a gain.
      + (bc
          ? `<tr class="rule-above"><td>Left alone, after background churn and revenue share</td>`
            + '<td></td><td></td><td></td><td></td><td></td>'
            + `<td class="n">${fmt.money(bc.doNothing)}</td></tr>`
            + `<tr><td><strong>After the campaign</strong>, same basis</td>`
            + `<td class="n">${fmt.int(bc.kept)} kept, ${fmt.int(bc.lost)} lost</td>`
            + '<td></td><td></td><td></td><td></td>'
            + `<td class="n"><strong>${fmt.money(bc.contribution)}</strong> `
            + `<span class="${bc.gain >= 0 ? 'held' : 'notviable'}">`
            + `${bc.gain >= 0 ? '+' : ''}${fmt.money(bc.gain)}</span></td></tr>`
          : '')
      + '</tbody></table>'
      + '<p class="note">A separate scenario on the ' + fmt.int(econ.totalAccounts)
      + ' accounts in the engagement export. The band switches drive only the last two rows; '
      + 'the headline and the table below run on the list\'s viable accounts and do not read '
      + 'the bands.</p>';
  }

  $('camp-note').textContent =
    'Both inputs are assumptions, not measurements, which is why they are switches: '
    + 'nobody has run this campaign, so the honest output is a range with the inputs '
    + 'visible. The pricing rule decides what each account is asked for; the churn '
    + 'setting decides how many refuse. "Scaled to the ask" is the most realistic and the '
    + 'least certain: it raises churn with the size of the increase and halves it '
    + 'where the customer has held that price before, on the reasoning that returning to '
    + 'a known number is an easier conversation than accepting a new one. That halving is '
    + 'the single assumption the whole case rests on and it has never been tested here. '
    + 'The floor line is the one to watch: losing accounts spreads the same fixed cost '
    + 'across fewer payers, so an aggressive campaign can raise the bar faster than it '
    + 'raises prices and leave the survivors underwater. Only accounts marked viable in '
    + 'the list below are asked; the rest, and the accounts the eligibility rules leave '
    + 'out, keep paying what they pay in the after figure, and asking them would flatter '
    + 'every figure here. '
    + 'The band table is the part that changes the conclusion. All three bands pay about '
    + 'the same, but hosting and messaging follow usage while the per-seat licence does '
    + 'not, so a dormant account costs '
    + (() => {
        const users = econ && econ.bands.find(b => b.key === 'users');
        const dormant = econ && econ.bands.find(b => b.key === 'dormant');
        return users && dormant && users.cost
          ? fmt.pct(dormant.cost / users.cost, 0) + ' of what a heavy user costs'
          : 'less than a heavy user';
      })()
    + ' and keeps more of what it pays. That inverts the obvious answer: the accounts that look most '
    + 'worth re-pricing are the most profitable business on the book, and sending them an '
    + 'invoice change is the fastest way to lose it. Active users are the only band whose '
    + 'price is genuinely out of line with what they consume. '
    + 'Band membership and counts are hand entered from an engagement export dated '
    + ENGAGEMENT.asOf + ' (' + engagementAge() + ') and joined on Stripe customer id; '
    + 'they are not in the pushed workbook, so they are exactly as stale as that date '
    + 'and nothing here will refresh them. The usage multiples behind '
    + 'the cost column are estimates rather than measurements, 2.2x average hosting '
    + 'for heavy senders, 0.6x for light and 0.05x for dormant, and they are the '
    + 'assumption most worth replacing with real per-account message volume.';
}


// How old the hand-entered engagement bands are, in the reader's own terms.
// The date alone does not register; "94 days old" does, and it keeps counting
// on its own rather than waiting for someone to notice.
function engagementAge() {
  const then = Date.parse(ENGAGEMENT.asOf + 'T00:00:00Z');
  if (!Number.isFinite(then)) return 'age unknown';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day old';
  if (days < 60) return `${days} days old`;
  return `${days} days old, long enough that they should be re-exported`;
}

// Say so when the push contains something this page cannot read.
//
// Presence is decided by a closed set of event types, so a type nobody here
// has heard of is dropped from every count without comment. That has happened:
// a push introduced `inactive` on 21,018 rows and the page rendered half the
// business, confidently, with no error anywhere. The only thing that caught it
// was diffing two pushes by hand.
//
// Deliberately loud and deliberately above the charts. A footnote would not
// have helped, because the failure looks exactly like a bad quarter.
function renderVocabularyWarning() {
  const box = $('data-warning');
  if (!box) return;
  const v = data.vocabulary;
  if (!v || v.ok) { box.hidden = true; box.innerHTML = ''; return; }

  const parts = [];

  if (v.unknown.length) {
    const list = v.unknown
      .map(u => `<strong>${u.type}</strong> on ${fmt.int(u.count)} rows`)
      .join(', ');
    parts.push(
      `<p><strong>This push uses ${v.unknown.length === 1 ? 'an event type' : 'event types'} `
      + `the page does not know: ${list}.</strong> Those rows are being read as absent, so `
      + `every logo count and revenue figure below excludes them. This page understands `
      + `${[...KNOWN_EVENTS].join(', ')}. Until that is resolved the numbers are an `
      + `undercount of unknown size rather than a finding.</p>`);
  }

  if (v.disagreements.length) {
    const list = v.disagreements
      .map(x => `${x.type} (push says ${fmt.int(x.said)}, file has ${fmt.int(x.got)})`)
      .join(', ');
    parts.push(
      `<p><strong>The file disagrees with its own header</strong> on ${list}. The push `
      + `states what it sent and this is not it, so part of it did not arrive or did not `
      + `parse.</p>`);
  }

  if (v.rowCountOff) {
    parts.push(
      `<p><strong>Row count mismatch:</strong> the header says `
      + `${fmt.int(v.rowCountOff.said)} rows and the file carries `
      + `${fmt.int(v.rowCountOff.got)}.</p>`);
  }

  box.innerHTML = `<div class="warning-card">${parts.join('')}</div>`;
  box.hidden = false;
}

function boot() {
  load().then(loaded => {
    data = loaded;
    MARGIN = platformMargins(data);
    cohorts = buildCohorts(data);
    $('loading').hidden = true;
    $('dashboard').hidden = false;
    renderStatic();
    renderForward();
    renderSeasonal();
    renderSignups();
    renderPriceBands();
    renderCostTable(data);
    renderSettledTotals(data);
    renderAnnotations();
    renderPricing(data);
    renderCostDrivers();
    renderContribution();
    renderServeTeams();
    renderTenureChurn();
    renderZeroMrr();
    renderPastDue();
    renderRevTenure();
    renderRevChurnTenure();
    renderWindowCurve();
    renderLevers();
    watchTables();
    renderArrivalAnimations();
    renderProjection();
    renderCalculator();
    renderSpend();
    renderLedger();
    renderOngoing();
    renderAccountServe();
    renderEvents();
    renderMarketing();
    renderFloors();
    renderUpgradeList();
    renderCampaign();
    renderFullCost();
    wireTabs();
    $('horizon').addEventListener('input', renderSeasonal);
    $('ltv-age').addEventListener('input', renderLtvAtAge);
    if ($('era-depth')) $('era-depth').addEventListener('input', renderEra);
    $('forward-horizon').addEventListener('input', () => {
      renderForward.lastSource = 'forward';
      renderForward();
    });
    if ($('forward-horizon-2')) {
      $('forward-horizon-2').max = $('forward-horizon').max;
      $('forward-horizon-2').addEventListener('input', () => {
        renderForward.lastSource = 'trend';
        renderForward();
      });
    }
    $('band-horizon').addEventListener('input', renderPriceBands);
    if ($('pricing-elasticity')) $('pricing-elasticity').addEventListener('input', () => renderPricing(data));
    $('arrival-horizon').addEventListener('input', renderArrivals);
    if ($('horizons-step')) $('horizons-step').addEventListener('input', renderHorizons);
    if ($('full-cost-age')) $('full-cost-age').addEventListener('input', renderFullCost);
    renderAssumptionDependent();
  }).catch(err => {
    // This used to write into #loading after #loading had been hidden, so any
    // failure after the first render vanished: the page looked half drawn and
    // the console stayed clean. Un-hide it and log, so a broken render says so.
    console.error('Render failed:', err);
    $('loading').hidden = false;
    $('loading').innerHTML =
      `<p class="empty">Could not draw the page: ${err && err.message}. ` +
      `The workbook may not have pushed yet, or a chart is broken.</p>`;
  });
}

// What revenue per surviving customer does between month 11 and month 12,
// cohort by cohort, and when those cohorts reached that age. The note used to
// say it fell a fifth "for cohorts of every vintage" and called that an age
// effect, while six 2024 cohorts were flat or up and the falls sat in the
// cohorts that reached month 12 during 2026, which is the calendar reading.
function yearStepSentence() {
  const steps = cohorts
    .filter(c => c.maxOffset >= 12 && c.survivors[11] > 0 && c.survivors[12] > 0)
    .map(c => {
      const before = c.survivorRevenue[11] / c.survivors[11];
      const after = c.survivorRevenue[12] / c.survivors[12];
      return { month: c.month, reached: monthAdd(c.month, 12),
               change: before > 0 ? after / before - 1 : null };
    })
    .filter(s => s.change !== null);
  if (steps.length < 4) return '';
  const falls = steps.filter(s => s.change <= -0.1);
  if (!falls.length) {
    return `Revenue per surviving customer does not step down a year in: none of the `
      + `${steps.length} cohorts that have reached month 12 loses a tenth of it there.`;
  }
  // By the calendar year each cohort reached month 12 in. An age effect hits
  // every year alike; a calendar one is concentrated in the year it happened.
  const years = [...new Set(steps.map(s => s.reached.slice(0, 4)))].sort();
  const byYear = years.map(y => {
    const inYear = steps.filter(s => s.reached.startsWith(y));
    return { y, n: inYear.length, falls: inYear.filter(s => s.change <= -0.1).length };
  }).filter(r => r.n >= 3);
  const rates = byYear.map(r => r.falls / r.n);
  const concentrated = rates.length > 1 && Math.max(...rates) - Math.min(...rates) >= 0.3;
  return `Revenue per surviving customer falls by a tenth or more between month 11 and month 12 `
    + `in ${falls.length} of the ${steps.length} cohorts that have reached that age: `
    + byYear.map(r => `${r.falls} of the ${r.n} that got there in ${r.y}`).join(' and ') + '. '
    + (concentrated
      ? 'That is concentrated in one calendar year rather than spread evenly across them, so it '
        + 'reads as something that happened then rather than as an effect of age. '
      : 'The share is similar whichever year a cohort got there in, so it reads as an effect of '
        + 'age rather than of the calendar. ')
    + 'What the rows show at that age is customers booked as a contraction to zero MRR and '
    + 'still counted as present.';
}

// Everything on the page, drawn once. Nothing here is adjustable any more.
function renderStatic() {
  const w = data.waterfall;
  const recent = w.slice(-36);
  const labels = recent.map(r => fmt.monthLabel(r.month));

  const censored = cohorts.censoredCount || 0;
  renderVocabularyWarning();

  // The one churn number for the board, as METRICS.md proposes it: customers
  // lost over the last three complete months as a share of the customers there
  // at the start of each (chart 5's count, pooled), with chart 45's revenue
  // kept at twelve months beside it. Labelled a proposal until it is agreed.
  if ($('board-number')) {
    const last3 = departures(data).filter(d => d.rate !== null).slice(-3);
    const left = last3.reduce((t, d) => t + d.left, 0);
    const base = last3.reduce((t, d) => t + d.base, 0);
    const kept12 = (revenueRetentionAtAges(cohorts).pooled || []).find(p => p.age === 12);
    $('board-number').innerHTML = last3.length && base
      ? `<strong>Board churn number (proposed):</strong> ${fmt.pct(left / base, 1)} of customers a month `
        + `left over ${fmt.monthLabel(last3[0].month)} to ${fmt.monthLabel(last3[last3.length - 1].month)}`
        + (kept12 ? `, and cohorts keep ${fmt.pct(kept12.value, 0)} of their starting revenue at twelve months` : '')
        + '. Definition in METRICS.md.'
      : '';
  }
  $('stamp').textContent =
    (data.pushedAt ? `Workbook pushed ${data.pushedAt.replace('T', ' ')}. ` : '')
    + `Months ${data.historyStarts} to ${data.lastMonth}, `
    + `${monthDiff(data.historyStarts, data.lastMonth) + 1} months, `
    + `reaching back as far as the finance tabs go.`
    + (censored
        ? ` ${fmt.int(censored)} customers existed before the data window opens at `
          + `${cohorts.windowStart} and have no knowable cohort, so they are excluded from `
          + `every cohort chart.`
        : '')
    + (data.missingTabs && data.missingTabs.length
        ? ` Optional tabs absent: ${data.missingTabs.join(', ')}.`
        : '')
    + (data.staleTabs && data.staleTabs.length
        ? ` The latest push left out ${data.staleTabs.map(x => x.tab).join(', ')}; `
          + `${data.staleTabs.length === 1 ? 'it is' : 'they are'} read from the last push that carried `
          + `${data.staleTabs.length === 1 ? 'it' : 'them'} (${data.staleTabs.map(x => `${x.tab}: `
            + `${String(x.pushedAt || 'date unknown').replace('T', ' ')}${x.pipelineVersion ? `, ${x.pipelineVersion}` : ''}`).join('; ')}).`
        : '')
    // Whether the revenue on this page agrees with the only other statement of
    // it in the push. Said here rather than buried, because a page that cannot
    // check itself should not imply that it has.
    + (() => {
        const rc = revenueCheck(data);
        if (!rc) return ' No Cash Detail in this push, so nothing on this page is '
          + 'reconciled against an independent statement of revenue.';
        // Both tabs are pipeline outputs built from the same Stripe charges, so
        // agreement shows they are copies of one figure, not that it is right.
        // The independent check, Stripe against QuickBooks, is RECONCILIATION.md.
        return ' Cash Detail and the Customer Waterfall carry the same collected cash'
          + (rc.ties ? ' in every month' : ` to within ${fmt.pct(rc.worstTie.gap, 1)}, the widest gap `
            + `in ${fmt.monthLabel(rc.worstTie.month)}`)
          + '. Both are built from the same Stripe charges, so that shows the two tabs agree '
          + 'with each other, not that either is right, and the MRR the charts use is not part of '
          + 'this check'
          + `. Over the last twelve months ${fmt.pct(rc.unclassifiedShare, 1)} of collected `
          + `cash carries no product name and the published residual is `
          + `${fmt.pct(Math.abs(rc.residualShare), 1)} of it.`;
      })();

  // 4. Blended retention curve, indexed to month 1, the second month a cohort
  // carries revenue (month 0 is the first, as on charts 3 and 8).
  const blended = blendedRetention(cohorts);
  multiLineChart($('chart-retention'), {
    yTitle: 'Share kept, indexed to month 1',
    labels: blended.map(p => `M${p.offset}`),
    series: [
      { label: 'Logos retained', colour: INK.primary, values: blended.map(p => p.logos) },
      { label: 'Revenue retained', colour: INK.secondary, values: blended.map(p => p.revenue) },
    ],
    yFormat: v => fmt.pct(v),
    xTitle: 'Months since first revenue',
    describe: i => {
      const p = blended[i];
      return `<strong>Month ${p.offset}</strong>
        <span>Logos ${fmt.pct(p.logos, 1)}</span>
        <span>Revenue ${fmt.pct(p.revenue, 1)}</span>
        <span class="muted">${p.cohorts} cohorts in sample</span>`;
    },
  });
  $('retention-note').textContent = blended.length
    ? `Both lines indexed to month 1, because month 0 carries setup and onboarding fees and a `
      + `part-billed first month, so indexing there turns a one-off charge ending into an `
      + `apparent cliff. Indexing both the same way is what makes the gap between them mean `
      + `something: it is expansion and contraction among the survivors and nothing else. The `
      + `logo line is survival, so a customer who leaves and returns is not counted twice. `
      + `At each age the count is every cohort that has had that long to run, `
      + `the same rule chart 8 uses, so the sample shrinks as the line goes right: it starts on `
      + `${blended[0].cohorts} cohorts and ${fmt.int(blended[0].atRisk)} customers and is `
      + `stopped at month ${blended[blended.length - 1].offset}, where `
      + `${blended[blended.length - 1].cohorts} cohorts and `
      + `${fmt.int(blended[blended.length - 1].atRisk)} customers remain. `
      + (blended.rises && blended.rises.length
        ? `Where the logo line reads better than the month before it is the sample changing, `
          + `not customers returning, which survival forbids: `
          + blended.rises.map(r => `month ${r.offset} rises as `
            + `${fmt.int(r.lostFromSample)} customers age out of the count`).join(', ')
          + `. `
        : '')
      + yearStepSentence()
    : 'Not enough cohort history yet.';

  // 5. Monthly logo churn, both ways of counting it.
  //
  // The summary books a churn when the pipeline sees the transition. A
  // customer whose subscription drops out of the Stripe export never produces
  // one: present one month, absent the next, nothing recorded. Until the
  // September 2026 push that gap was a third of departures; the two counts now
  // agree, and both lines stay so that a gap reopening is visible.
  const churnSeries = recent.map((r, i) => {
    const previous = i === 0 ? null : recent[i - 1];
    const base = previous ? previous.activeLogos : null;
    return base ? (r.churnedLogos || 0) / base : null;
  });
  const dep = new Map(departures(data).map(d => [d.month, d]));
  const departureSeries = recent.map(r => dep.get(r.month)?.rate ?? null);

  multiLineChart($('chart-churn'), {
    yTitle: 'Share of live logos lost that month',
    labels,
    series: [
      { label: 'Customers who stopped appearing', colour: INK.negative,
        values: departureSeries },
      { label: 'Of those, recorded as a churn', colour: INK.secondary,
        values: churnSeries, dashed: true, thin: true },
    ],
    yFormat: v => fmt.pct(v, 1),
    refs: [{ value: CHURN_THRESHOLD, label: '5% threshold', variant: 'ref-goal' }],
    legendItems: [
      { label: 'Customers who stopped appearing', colour: 'var(--series-neg)' },
      { label: 'Of those, recorded as a churn', colour: 'var(--series-2)' },
    ],
    describe: i => {
      const d = dep.get(recent[i].month);
      return `<strong>${fmt.monthLabel(recent[i].month)}</strong>
        <span>Left the file ${d && d.rate !== null ? fmt.pct(d.rate, 2) : '--'}`
        + (d && d.left !== null ? `, ${fmt.int(d.left)} customers` : '') + `</span>
        <span>Reported churn ${fmt.pct(churnSeries[i], 2)}, ${fmt.int(recent[i].churnedLogos)} logos</span>`;
    },
  });

  const depRecent = departures(data).filter(d => d.rate !== null).slice(-6);
  const sumLeft = depRecent.reduce((s, d) => s + d.left, 0);
  const sumRep = recent.slice(-depRecent.length).reduce((s, r) => s + (r.churnedLogos || 0), 0);
  // This note described a gap between the two lines for as long as the gap
  // existed. It closed on the 2026-09-21 17:05 push, and a note that goes on
  // explaining a difference of zero is worse than no note, so it reads the
  // numbers and says which of the two situations it is in.
  const bookingGap = sumLeft - sumRep;
  $('churn-note').innerHTML =
    'Not two versions of the data, one measure and the part of it that gets recorded. The solid '
    + 'line is every customer present one month and absent the next. The dashed line is how many '
    + 'of those the push booked as a churn. Over the last ' + depRecent.length + ' months it books '
    + fmt.int(sumRep) + ' departures and the file loses ' + fmt.int(sumLeft) + ', '
    + (Math.abs(bookingGap) <= Math.max(2, sumLeft * 0.01)
        ? 'which is the same number. '
          + 'That is recent: until the September 2026 push the booked figure missed 122 '
          + 'departures over six months, about a third of them, all of them customers who had '
          + 'been contracted to zero MRR and then dropped out of the file without a churn event. '
          + 'The two lines now agree because both are right rather than because both are wrong, '
          + 'and the pair is kept on the chart so that if they separate again it is visible.'
        : (sumRep ? ((sumLeft / sumRep - 1) * 100).toFixed(0) : '0') + '% more. The difference is '
          + 'customers whose subscription drops out of the Stripe export without generating a '
          + 'churn event, which is a booking gap rather than a measurement disagreement. Read '
          + 'the solid line as the rate and the dashed one as a floor.');

  // 6. Retention at months 3, 6 and 12, one line per age across the cohorts.
  const windowed = cohorts.slice(-COHORT_WINDOW);
  const m3 = retentionAtAge(windowed, 3);
  const m6 = retentionAtAge(windowed, 6);
  const m12 = retentionAtAge(windowed, 12);

  // Two clouds of dots with a flat mean through each made the comparison
  // between the ages easy and the trend within each age nearly invisible,
  // which is the wrong way round: everyone already knows month 6 is below
  // month 3. Lines against the cohort date put the movement first, and a
  // third age is worth carrying now that the curves are monotonic.
  multiLineChart($('chart-age-retention'), {
    yTitle: 'Share of the cohort still there',
    labels: windowed.map(c => fmt.monthLabel(c.month)),
    series: [
      { label: 'Still there at month 3', colour: INK.primary, values: m3.map(p => p.value) },
      { label: 'At month 6', colour: INK.secondary, values: m6.map(p => p.value) },
      { label: 'At month 12', colour: INK.tertiary, dashed: true, values: m12.map(p => p.value) },
    ],
    yFormat: v => fmt.pct(v),
    legendItems: [
      { label: 'Still there at month 3', colour: 'var(--series-1)' },
      { label: 'At month 6', colour: 'var(--series-2)' },
      { label: 'At month 12', colour: 'var(--series-3)' },
    ],
    describe: i => `<strong>${windowed[i].month} cohort</strong>
      <span>${fmt.int(windowed[i].size)} logos at month 0</span>
      <span>Month 3 ${m3[i].value === null ? 'not yet' : fmt.pct(m3[i].value, 1)}</span>
      <span>Month 6 ${m6[i].value === null ? 'not yet' : fmt.pct(m6[i].value, 1)}</span>
      <span>Month 12 ${m12[i].value === null ? 'not yet' : fmt.pct(m12[i].value, 1)}</span>`,
  });

  // 8. Retention by era, one line per starting year.
  renderEra();

  // 10. Monthly logo flows.
  flowChart($('chart-flows'), {
    yTitle: 'Logos gained and lost',
    labels,
    added: recent.map(r => r.newLogos),
    reactivated: recent.map(r => r.reactivatedLogos),
    churned: recent.map(r => r.churnedLogos),
    net: recent.map(r => r.netLogoChange),
    describe: i => `<strong>${fmt.monthLabel(recent[i].month)}</strong>
      <span>New ${fmt.int(recent[i].newLogos)}</span>
      <span>Reactivated ${fmt.int(recent[i].reactivatedLogos)}</span>
      <span>Churned ${fmt.int(recent[i].churnedLogos)}</span>
      <span>Net ${recent[i].netLogoChange > 0 ? '+' : ''}${fmt.int(recent[i].netLogoChange)}</span>`,
  });
  $('flows-note').textContent =
    'New and reactivated above the axis, churned below. Net change is a line rather than a '
    + 'third column, because it is the sum of the other two and would otherwise read as an '
    + 'independent quantity. '
    + 'Counts come from the monthly summary, which the customer file now reproduces exactly: '
    + 'the live event types total active_logos in every month of the window. Churned here is '
    + 'the summary figure, which chart 5 checks against the customers who actually left the '
    + 'file. New is first appearance in the summary, which is not the same number as the '
    + 'cohort count the cohort charts use: it counts customers who appear before they first '
    + 'carry revenue, and the window\'s first month, whose customers the cohorts treat as '
    + 'already there.';
}

// Cost and profit. Settled inputs, so this runs once like everything else.
function renderAssumptionDependent() {
  // Every cohort that can carry a cost per logo, not a fixed window. The page
  // window opens at the first month of the QuickBooks ledger, so every cohort
  // in it has a denominator. Windowing to 24 on top of that cut off the eight
  // oldest cohorts with cost data, which are the most mature and the best
  // performing, and made the picture look worse than it is.
  // Every cohort with a cost, through to the trailing month. The youngest are
  // drawn muted rather than withheld: the measure is realised profit, so a
  // young cohort sits low because it has had less time, not because it is
  // worse, and a reader who cannot see it at all has no way to judge that.
  const economics = cohortEconomics(data, cohorts, state).filter(c => c.costPerLogo !== null);
  const isYoung = c => (c.maxOffset + 1) < MIN_COHORT_AGE;
  const tooYoung = economics.filter(isYoung).length;
  const mute = (colour, c) => (isYoung(c) ? 'var(--series-3)' : colour);
  const labels = economics.map(c => fmt.monthLabel(c.month));

  // 1. LTV:CAC by cohort, every cohort cut at the same age.
  // Chart 1 draws itself, because it redraws on its own slider. Its note is
  // written there too rather than here, where it would go stale the moment
  // the age changed.
  renderLtvAtAge();

  // 2. Expected payback by cohort, against a 12 month goal.
  //
  // A cohort that has not covered its cost yet used to leave a gap, and ten
  // gaps in a row read as collapse when they are mostly just the calendar: a
  // cohort one month old cannot have paid back. The projection fills them in a
  // different colour, so the chart says "expected at month 19" rather than
  // saying nothing at all.
  const projections = new Map(
    projectedBreakEven(data, cohorts, state).map(p => [p.month, p]));

  const paybackCeiling = 20;
  const bars = economics.map(c => {
    if (c.payback !== null) return { value: c.payback, projected: false, never: 0 };
    const p = projections.get(c.month);
    return {
      value: p && p.central !== null ? p.central : null,
      projected: true,
      never: p ? p.neverRate : 0,
      low: p ? p.low : null,
      high: p ? p.high : null,
    };
  });
  const clipped = bars.filter(b => b.value !== null && b.value > paybackCeiling).length;
  const offTheEnd = bars.filter(b => b.projected && b.value === null).length;
  const paybackAtRisk = bars.filter(b => b.projected && b.never >= 0.25).length;

  columnChart($('chart-payback'), {
    yTitle: 'Months until the cohort covered its CAC',
    labels,
    values: bars.map(b => b.value),
    yFormat: v => Math.round(v) + 'm',
    yMax: paybackCeiling,
    colourFor: (v, i) => (bars[i].projected
      ? (bars[i].never >= 0.25 ? 'var(--series-2)' : 'var(--depends)')
      : mute(v <= 12 ? INK.positive : INK.negative, economics[i])),
    refs: [{ value: 12, label: '12 month goal', variant: 'ref-goal' }],
    legendItems: [
      { label: 'Recovered inside the goal', colour: 'var(--series-pos)' },
      ...(bars.some(b => !b.projected && b.value > 12)
        ? [{ label: 'Recovered past it', colour: 'var(--series-neg)' }] : []),
      { label: 'Projected', colour: 'var(--depends)' },
      ...(bars.some(b => b.projected && b.never >= 0.25 && b.value !== null)
        ? [{ label: 'Projected, one in four chance of never', colour: 'var(--series-2)' }] : []),
    ],
    describe: i => {
      const c = economics[i];
      const b = bars[i];
      if (!b.projected) {
        return `<strong>${c.month} cohort</strong>
          <span>Recovered at month ${c.payback}</span>
          <span>Cost per logo ${fmt.money(c.costPerLogo)}</span>
          <span class="muted">${c.maxOffset + 1} months observed</span>`;
      }
      const back = c.recovery[c.recovery.length - 1] || 0;
      return `<strong>${c.month} cohort</strong>`
        + `<span>Not recovered yet, ${fmt.pct(back)} of cost back</span>`
        + `<span>Projected month ${b.value === null ? 'beyond ten years' : b.value}`
        + (b.low !== null ? `, 90% ${b.low} to ${b.high}` : '') + `</span>`
        + (b.never > 0 ? `<span>Chance of never recovering ${fmt.pct(b.never)}</span>` : '')
        + `<span class="muted">${c.maxOffset + 1} months observed</span>`;
    },
  });
  const unrecovered = economics.filter(c => c.payback === null).length;
  const recovered = economics.filter(c => c.payback !== null);
  const withinGoal = recovered.filter(c => c.payback <= 12).length;
  $('payback-note').textContent =
    `${recovered.length} of ${economics.length} cohorts have covered their cost, `
    + (withinGoal === recovered.length ? 'every one of them ' : `${withinGoal} of them `)
    + `inside the 12 month goal. The other ${unrecovered} are projected rather than `
    + `left blank, because most have simply not had time: the run ends at the trailing month `
    + `and a cohort one month old cannot have paid back. `
    + (clipped
        ? `${clipped} projections run past the ${paybackCeiling} month ceiling and are drawn `
          + `to the top with a caret rather than rescaling the axis, which one sixty month bar `
          + `would otherwise flatten. `
        : '')
    + (offTheEnd
        ? `${offTheEnd} ${offTheEnd === 1 ? 'does' : 'do'} not recover inside ten years and `
          + `${offTheEnd === 1 ? 'stays' : 'stay'} blank. `
        : '')
    + (paybackAtRisk
        ? `${paybackAtRisk} ${paybackAtRisk === 1 ? 'carries' : 'carry'} better than a one in `
          + `four chance of never recovering. `
        : '')
    + JOINING_CHARGE_NOTE + ' '
    + `The run starts at ${economics[0].month}, the first month the QuickBooks ledger carries, `
    + `because acquisition cost is not recorded before then.`;

  // 3. Cumulative gross profit against cost, by cohort age.
  const mature = economics.filter(c => c.recovery.length >= 6).slice(-6);
  const span = Math.max(...mature.map(c => c.recovery.length), 0);
  multiLineChart($('chart-recovery'), {
    yTitle: 'Cumulative gross profit as a share of CAC',
    labels: Array.from({ length: span }, (_, i) => `M${i}`),
    series: mature.map((c, i) => ({
      label: c.month,
      colour: `var(--ramp-${i + 1})`,
      values: Array.from({ length: span }, (_, k) => (c.recovery[k] ?? null)),
    })),
    yFormat: v => fmt.pct(v),
    xTitle: 'Months since first revenue',
    refs: [{ value: 1, label: 'break-even', variant: 'ref-goal' }],
    describe: i => `<strong>Month ${i}</strong>` + mature.map(c =>
      `<span>${c.month} ${fmt.pct(c.recovery[i] ?? null, 0)}</span>`).join(''),
  });
  $('recovery-note').textContent =
    'The six most recent cohorts with at least six months of history, month 0 being the first '
    + 'month of revenue as in charts 4 and 8. Where a line crosses 100% is the month that cohort '
    + 'paid back. The shape of a curve survives the split or the margin being wrong, because it '
    + 'bends the same way whatever the cost baseline is; where it crosses 100% does not, since '
    + 'that depends on both levels. ' + JOINING_CHARGE_NOTE;


  // 17. Break-even by cohort, actual where it happened and projected where it
  // has not. Recomputed with the sliders because the cost per logo moves.
  const projection = projectedBreakEven(data, cohorts, state);
  const rows = projection.map(p => {
    const label = p.projected
      ? (p.central === null ? 'not within 10 years' : p.central + ' months')
      : p.actual + ' months';
    const range = !p.projected
      ? '<span class="range none">actual</span>'
      : (p.low === null ? '<span class="range none">too few outcomes</span>'
                        : '<span class="range">' + p.low + ' to ' + p.high + ' months</span>');
    const tag = p.projected
      ? (p.neverRate >= 0.25 ? '<span class="tag risk">at risk</span>'
                             : '<span class="tag projected">projected</span>')
      : '<span class="tag actual">actual</span>';
    return '<tr>'
      + '<td>' + p.month + '</td>'
      + '<td class="n">' + fmt.int(p.cohortLogos) + '</td>'
      + '<td class="n">' + fmt.money(p.cost) + '</td>'
      + '<td class="n">' + p.monthsObserved + '</td>'
      + '<td>' + tag + '</td>'
      + '<td class="n">' + label + '</td>'
      + '<td>' + range + '</td>'
      + '<td class="n">' + (p.projected ? fmt.pct(p.neverRate) : '--') + '</td>'
      + '</tr>';
  }).join('');

  $('breakeven-table').innerHTML =
    '<thead><tr><th>Cohort</th><th class="n">Logos</th><th class="n">Cost per logo</th>'
    + '<th class="n">Months observed</th><th>Basis</th><th class="n">Break-even</th>'
    + '<th>90% range</th><th class="n">Risk of never</th></tr></thead><tbody>'
    + rows + '</tbody>';

  const done = projection.filter(p => !p.projected).length;
  const atRisk = projection.filter(p => p.projected && p.neverRate >= 0.25).length;
  $('breakeven-divisor').innerHTML =
    '<strong>One count, used on both halves of the ratio.</strong> The logos column is what '
    + 'this build sees starting in that month, cost per logo is the month acquisition cost '
    + 'divided by it, and gross profit is divided by the same figure, so multiplying the two '
    + 'returns the spend rather than a number nobody spent. The count that used to sit beside '
    + 'this is no longer read: it was a second definition of the same thing, and carrying both '
    + 'produced three answers to what a logo costs.';

  $('breakeven-note').textContent =
    done + ' of ' + projection.length + ' cohorts have already covered their cost, and those '
    + 'rows report the month it happened rather than a forecast. The rest are projected from '
    + 'their last observed month along a revenue retention path. The range comes from '
    + 'resampling whole donor cohorts, ' + donorSpan() + ', so it answers how far this cohort '
    + 'could sit from the average rather than how well the average is known, which is the '
    + 'wider and more useful question. ' + atRisk + ' cohorts carry at least a one in four '
    + 'chance of never covering their cost. Projection stops at ten years. '
    + JOINING_CHARGE_NOTE + ' '
    + 'This table and chart 33 both report a break-even month and they will not agree. '
    + 'This one charges acquisition only, and counts subscription gross profit against it. '
    + 'Chart 33 charges every ongoing cost as well, which is harsher, but it also counts '
    + 'usage, setup and the old joining charge as revenue, which is more generous, and on '
    + 'the 2024 cohorts the revenue side wins. Neither is wrong: this is payback on '
    + 'acquisition, that is payback on everything.';

  // 7. Cost per logo against revenue per logo, indexed to the first year.
  //
  const { months, intake, boundary, suppressed, costPerLogo, revenuePerLogo,
    baseYear, baseCost, baseRevenue, index } = unitCostSeries();
  const last = months.length - 1;

  multiLineChart($('chart-unit'), {
    yTitle: `Index, ${baseYear} median month = 100`,
    labels: months.map(m => fmt.monthLabel(m)),
    series: [
      { label: 'Cost per logo', colour: INK.negative,
        values: costPerLogo.map(v => index(v, baseCost)) },
      { label: 'New-logo revenue per logo', colour: INK.primary,
        values: revenuePerLogo.map(v => index(v, baseRevenue)) },
    ],
    yFormat: v => Math.round(v),
    refs: [{ value: 100, label: `${baseYear} median = 100`, variant: 'ref-floor' }],
    describe: i => `<strong>${fmt.monthLabel(months[i])}</strong>
      <span>Cost per logo ${fmt.money(costPerLogo[i])}, index ${fmt.int(index(costPerLogo[i], baseCost))}</span>
      <span>Revenue per logo ${fmt.money(revenuePerLogo[i])}, index ${fmt.int(index(revenuePerLogo[i], baseRevenue))}</span>
      <span class="muted">${fmt.int(intake.get(months[i]).size)} logos started</span>`,
  });
  $('unit-note').textContent =
    `Both indexed to 100 at the median month of ${baseYear}, ${fmt.money(baseCost)} of `
    + `acquisition cost and ${fmt.money(baseRevenue)} of first-month MRR per logo, so the `
    + 'divergence reads without either absolute number needing to be right. Cost per logo '
    + 'divides the month acquisition cost by the customers whose first revenue fell in that '
    + 'month, the count charts 1, 2 and 17 use, and revenue per logo is what those same '
    + 'customers were booked at in that month, the old joining charge included. '
    + (costPerLogo[last] !== null
        ? `${fmt.monthLabel(months[last])} reads ${fmt.int(index(costPerLogo[last], baseCost))} `
          + `on cost and ${fmt.int(index(revenuePerLogo[last], baseRevenue))} on revenue. `
        : '')
    + (suppressed.length
        ? suppressed.map(m => fmt.monthLabel(m)).join(' and ')
          + ' ' + (suppressed.length === 1 ? 'is' : 'are') + ' left blank. '
          + (suppressed.includes(boundary)
              ? `${fmt.monthLabel(boundary)} opens the window, so its count holds only the `
                + 'customers with a Stripe start date in it and is not that month\'s intake. '
              : '')
          + (suppressed.some(m => m !== boundary)
              ? 'A month is otherwise drawn only once enough logos started for the ratio to be '
                + 'measuring cost rather than its own denominator, and enough MRR came with them '
                + 'for the revenue side to mean anything.'
              : '')
        : '');
}

// Chart 7's two series, computed once. The chart and its annotation both
// read this: the annotation used to rebuild the series on its own rules and
// quote a different base month and a different count from the line above it.
function unitCostSeries() {
  // The acquisition cost charts 1, 2 and 17 divide by, over the same count
  // they use: the cohort that started that month. The summary's new-logo
  // count was a second definition of a logo, and in the first month of the
  // window the two parted most (67 booked against 23 dated).
  const cac = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const intake = new Map(cohorts.map(c => [c.month, c]));
  const months = data.cacMonthly
    .filter(r => r.cacTotalActual !== null && intake.has(r.month))
    .map(r => r.month);
  // The boundary month holds only the customers with a Stripe start date in
  // it; everyone else present then is censored. Its count is not that month's
  // intake, so a cost per logo on it is about the denominator and is blanked.
  const boundary = cohorts.windowStart;
  // A month whose count or revenue has collapsed against a typical month is
  // also about the denominator rather than the cost. A third of typical, not
  // a half: a thin month is real, a count that fails is not.
  const sizes = months.map(m => intake.get(m).size).filter(Boolean).sort((a, b) => a - b);
  const typical = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const paysOf = m => intake.get(m).revenue[0] / intake.get(m).size;
  const pays = months.map(paysOf).filter(v => v > 0).sort((a, b) => a - b);
  const typicalPays = pays.length ? pays[Math.floor(pays.length / 2)] : 0;
  const reliable = m => m !== boundary
    && intake.get(m).size >= typical * 0.35
    && paysOf(m) >= typicalPays * 0.35;
  const suppressed = months.filter(m => !reliable(m));

  // Revenue per logo is what the cohort was booked at in its first month, the
  // same month and the same customers as the cost beside it.
  const costPerLogo = months.map(m => (reliable(m) ? cac.get(m) / intake.get(m).size : null));
  const revenuePerLogo = months.map(m => (reliable(m) ? paysOf(m) : null));

  // Indexed to the median month of the first calendar year rather than to the
  // first month, which on this push was the cheapest month in the series and
  // made every later cost reading about a quarter higher than a typical 2024
  // month would.
  const baseYear = months.find(m => reliable(m))?.slice(0, 4);
  const medianOf = values => {
    const v = values.filter(x => x !== null).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const inBase = (values) => values.filter((_, i) => months[i].startsWith(baseYear));
  const baseCost = medianOf(inBase(costPerLogo));
  const baseRevenue = medianOf(inBase(revenuePerLogo));
  const index = (v, base) => (v === null || !base ? null : (v / base) * 100);
  return { months, intake, boundary, suppressed, costPerLogo, revenuePerLogo,
    baseYear, baseCost, baseRevenue, index };
}

// Whether chart 19's gap between the two rules holds at every horizon the
// slider offers, computed rather than asserted. Worked out once per load,
// because the answer does not depend on where the slider sits.
let horizonGaps = null;
function horizonGapSentence() {
  if (!horizonGaps) {
    const max = Number($('forward-horizon').max) || 9;
    horizonGaps = [];
    for (let h = 1; h <= max; h += 1) {
      const f = forwardSurvival(data, { horizon: h, windows: null });
      if (f.earlier && f.recent) {
        horizonGaps.push({ h, gap: (f.earlier.rate - f.recent.rate) * 100, z: f.z });
      }
    }
  }
  if (!horizonGaps.length) return '';
  const below = horizonGaps.filter(g => g.gap > 0);
  const zs = horizonGaps.map(g => g.z);
  const range = `${Math.min(...horizonGaps.map(g => g.gap)).toFixed(1)} to `
    + `${Math.max(...horizonGaps.map(g => g.gap)).toFixed(1)} points`;
  return below.length === horizonGaps.length
    ? `It does at every horizon from 1 to ${horizonGaps[horizonGaps.length - 1].h} months, `
      + `${range} below the earlier average, with the naive z running from `
      + `${Math.min(...zs).toFixed(1)} to ${Math.max(...zs).toFixed(1)}, so it is weakest at the `
      + 'longest horizons, where there are fewest windows.'
    : `It holds at ${below.length} of the ${horizonGaps.length} horizons the slider offers, `
      + 'so it is not yet structural.';
}

// Forward survival. Independent of the split and the margin, so drawn once.
function renderForward() {
  // Chart 19 used to borrow this control silently from chart 18, several
  // screens away, so its horizon looked fixed. It has its own now and the two
  // are kept in step, because they are two views of one calculation and
  // letting them disagree would be worse than sharing.
  const source = renderForward.lastSource === 'trend' ? 'forward-horizon-2' : 'forward-horizon';
  const horizon = Number($(source).value) || 4;
  for (const id of ['forward-horizon', 'forward-horizon-2']) {
    const el = $(id);
    if (!el) continue;
    el.value = String(horizon);
    const out = $(id + '-value');
    if (out) out.textContent = horizon + (horizon === 1 ? ' month' : ' months');
  }
  // These two titles carry their own numbers because the horizon is in them,
  // so the number is read off the markup rather than written here. Hardcoding
  // it meant a renumbering fixed the page and left the JavaScript pointing at
  // the old positions, which put two charts on the same number.
  const numberOf = node => (node.textContent.match(/^(\d+)\./) || [])[1] || '';
  const forwardNum = numberOf($('forward-title'));
  const trendNum = numberOf($('forward-trend-title'));
  $('forward-title').textContent =
    `${forwardNum}. Forward ${horizon} month${horizon === 1 ? '' : 's'}, from every starting month with a full window`;
  $('forward-trend-title').textContent = horizon === 1
    ? `${trendNum}. One-month survival, by starting month`
    : `${trendNum}. Survival ${horizon} months on, by starting month`;

  const fw = forwardSurvival(data, { horizon, windows: null });
  const starts = fw.starts;
  const span = fw.horizon + 1;
  const labels = Array.from({ length: span }, (_, i) => (i ? '+' + i : 'start'));

  // Weighted by each starting month's base, so the line at the horizon is the
  // pooled rate the finding and chart 19 quote: a simple mean of the curves
  // let a small starting month count as much as a large one and drew a line
  // a few tenths away from the number printed under it.
  const average = group => {
    const total = group.reduce((sum, s) => sum + s.n, 0);
    return Array.from({ length: span }, (_, i) =>
      (total ? group.reduce((sum, s) => sum + s.curve[i] * s.n, 0) / total : null));
  };

  const recent = starts.slice(-fw.recentCount);
  const earlier = starts.slice(0, -fw.recentCount);

  // 18. The fan. Every window drawn faintly so the spread is visible, with the
  // two period averages over the top so the shift is readable.
  multiLineChart($('chart-forward'), {
    yTitle: 'Share of the starting month’s base still active',
    labels,
    series: [
      ...starts.map(s => ({ label: s.month, colour: INK.tertiary, thin: true, values: s.curve })),
      { label: `Average of the earlier ${earlier.length} windows`,
        colour: INK.primary, values: average(earlier) },
      { label: `Average of the latest ${recent.length}`,
        colour: INK.negative, values: average(recent) },
    ],
    yFormat: v => fmt.pct(v),
    // The floor has to follow the horizon. Fixed at 0.6 the fan ran off the
    // bottom of the chart as soon as the horizon passed six months.
    yMin: Math.min(0.6, Math.floor(Math.min(...starts.map(s => s.curve[fw.horizon])) * 20) / 20),
    yMax: 1,
    xTitle: 'Months after the starting month',
    legendItems: [
      { label: `One faint line per starting month, ${starts.length} of them`, colour: 'var(--series-3)' },
      { label: `Average of the earlier ${earlier.length}`, colour: 'var(--series-1)' },
      { label: `Average of the latest ${recent.length}`, colour: 'var(--series-neg)' },
    ],
    describe: i => {
      const values = starts.map(s => s.curve[i]).sort((a, b) => a - b);
      return '<strong>' + (i ? i + ' month' + (i > 1 ? 's' : '') + ' on' : 'Starting month') + '</strong>'
        + '<span>Best ' + fmt.pct(values[values.length - 1], 1) + '</span>'
        + '<span>Median ' + fmt.pct(values[Math.floor(values.length / 2)], 1) + '</span>'
        + '<span>Worst ' + fmt.pct(values[0], 1) + '</span>';
    },
  });

  const spread = Math.max(...starts.map(s => s.survival)) - Math.min(...starts.map(s => s.survival));
  // "Not by a little" only where the fall is both a couple of points and large
  // against its own noise: at twelve months the fall is about a point with a z
  // of -1.5, and the heading used to say the same thing there.
  const fall = (fw.earlier.rate - fw.recent.rate) * 100;
  $('forward-finding').innerHTML =
    (fw.recent.rate < fw.earlier.rate
      ? (fall >= 2 && fw.z <= -3
          ? '<strong>It is getting worse, and not by a little.</strong> '
          : '<strong>It is getting worse, by a small margin at this horizon.</strong> ')
      : '<strong>It has stopped getting worse.</strong> ')
    + horizon + '-month survival ran at '
    + fmt.pct(fw.earlier.rate, 1) + ' across ' + earlier.length + ' earlier windows and '
    + fmt.pct(fw.recent.rate, 1) + ' across the last ' + recent.length + ', a fall of '
    + Math.abs((fw.recent.rate - fw.earlier.rate) * 100).toFixed(1)
    + (fw.recent.rate < fw.earlier.rate ? ' points on ' : ' points the other way on ')
    + (fw.recent.total + fw.earlier.total).toLocaleString() + ' customer observations. '
    + 'The gap between the best and worst window is ' + (spread * 100).toFixed(1) + ' points.';

  $('forward-note').textContent =
    'Windows run ' + fw.range[0] + ' to ' + fw.range[1] + ', ' + starts.length + ' of them. '
    + 'A starting month appears only once its full ' + horizon + ' months have elapsed, '
    + 'otherwise the newest months would look '
    + 'flattering because their losses have not happened yet. Treating this as a formal test '
    + 'would overstate it: consecutive windows share most of their customers, so they are not '
    + 'independent samples. The naive two-proportion z is ' + fw.z.toFixed(1)
    + ', best read as large rather than as a p-value.';

  // 19. The same thing as one number per starting month.
  const monthsWord = horizon + ' month' + (horizon === 1 ? '' : 's');
  // The worse of the two averages is drawn red and the better in the neutral
  // rule, whichever period that is. The recent average used to be the green
  // "goal" rule while it was the lower one, so colour read backwards.
  const recentWorse = fw.recent.rate < fw.earlier.rate;
  lineChart($('chart-forward-trend'), {
    yTitle: 'Share of the starting month’s base still active',
    labels: starts.map(s => fmt.monthLabel(s.month)),
    values: starts.map(s => s.survival),
    colour: INK.primary,
    yFormat: v => fmt.pct(v),
    refs: [
      { value: fw.earlier.rate,
        label: 'average of the earlier ' + earlier.length, variant: recentWorse ? '' : 'ref-floor' },
      { value: fw.recent.rate,
        label: 'average of the latest ' + recent.length, variant: recentWorse ? 'ref-floor' : '' },
    ],
    // The chart drew one unlabelled line against one unlabelled dashed rule,
    // which left the reader to guess what either was.
    legendItems: [
      { label: 'Share of that month’s base still active ' + monthsWord + ' later',
        colour: 'var(--series-1)' },
      { label: 'Average of the earlier ' + earlier.length + ' starting months',
        colour: recentWorse ? 'var(--ink-soft)' : 'var(--series-neg)' },
      { label: 'Average of the latest ' + recent.length,
        colour: recentWorse ? 'var(--series-neg)' : 'var(--ink-soft)' },
    ],
    describe: i => '<strong>' + starts[i].month + ' start</strong>'
      + '<span>' + fmt.pct(starts[i].survival, 1) + ' still active ' + monthsWord + ' on</span>'
      + '<span class="muted">' + fmt.int(starts[i].n) + ' active at the start</span>',
  });

  const best = starts.reduce((a, b) => (b.survival > a.survival ? b : a));
  const worst = starts.reduce((a, b) => (b.survival < a.survival ? b : a));
  $('forward-trend-finding').innerHTML =
    '<strong>Each point is one starting month: take everyone active in it, wait '
    + monthsWord + ', and count who is left.</strong> '
    + 'The line runs from ' + fmt.pct(worst.survival, 1) + ' in '
    + fmt.monthLabel(worst.month) + ' to ' + fmt.pct(best.survival, 1) + ' in '
    + fmt.monthLabel(best.month) + ' across ' + starts.length + ' starting months. '
    + 'The two rules are the period averages the chart above compares, so a point below '
    + 'the lower rule is a month that did worse than the recent average rather than '
    + 'merely worse than history. '
    + (fw.recent.rate < fw.earlier.rate
        ? 'Move the slider and the whole line drops, because more time means more loss; '
          + 'what matters is whether the gap between the two rules survives that. '
          + horizonGapSentence()
        : 'The recent average now sits above the earlier one, so the decline this chart '
          + 'was built to show has stopped at this horizon.');
  $('forward-trend-note').textContent =
    'One point per starting month, at the horizon set above. Lengthening the horizon lowers '
    + 'every point, because more time means more loss, and the question is whether the slope '
    + 'changes with it. A decline that is steady at every horizon is structural; one that only '
    + 'appears at short horizons would be a recent shock instead.';

  // 20 and 21. Customer Success capacity, and whether either relationship is
  // moving. Neither has a control: the Customer Success split is settled at
  // zero acquisition, and it never changed how much was spent anyway.
  // Stale claim check, stated from the data rather than from memory.
  // The second Stripe environment, measured by what it is doing now rather than
  // by its share of all history. As a share of every customer month ever
  // recorded it is a rounding error, which is how it came to be described as
  // young and harmless. In the trailing month it is most of the new business,
  // and none of its revenue reaches the MRR column.
  const s2Rows = data.customers.filter(r => r.source === 'S2');
  S2_FIRST = s2Rows.length ? s2Rows.reduce((a, r) => (r.month < a ? r.month : a), s2Rows[0].month) : '';
  const s2 = s2Rows.length;
  const s2Share = s2 / data.customers.length;
  const s2Ids = new Set(s2Rows.map(r => r.id));
  const s2WithMrr = new Set(s2Rows.filter(r => r.eopMrr > 0).map(r => r.id));
  // "all of them paying" was asserted here and was not true: two of the 58 carry
  // no money of any kind. Counted rather than claimed.
  const s2WithMoney = new Set(s2Rows
    .filter(r => (r.netCash || 0) > 0 || (r.eopMrr || 0) > 0
      || (r.usage || 0) > 0 || (r.oneTime || 0) > 0)
    .map(r => r.id));
  const trailing = data.waterfall[data.waterfall.length - 1].month;
  const newest = data.customers.filter(r => r.month === trailing && r.eventType === 'new');
  const newestS2 = newest.filter(r => r.source === 'S2');
  const hasClasses = hasRevenueClasses(data);
  $('margin-statement').innerHTML = hasClasses
    ? '<strong>Margins are applied per revenue class.</strong> Platform '
      + (MARGIN && MARGIN.measured
          ? fmt.pct(MARGIN.mean, 1) + ' on average, solved month by month from the cost '
            + 'ledger rather than assumed and running ' + fmt.pct(MARGIN.low, 1) + ' to '
            + fmt.pct(MARGIN.high, 1) + ' across ' + MARGIN.months + ' months'
          : fmt.pct(LEGACY_PLATFORM_MARGIN, 1) + ', the flat assumption, because no cost '
            + 'ledger reached this build')
      + ', usage ' + fmt.pct(CLASS_MARGINS.usage)
      + ', one-time ' + fmt.pct(CLASS_MARGINS.oneTime) + ', and pass-through and '
      + 'recognised-elsewhere at zero. Pass-through is carrier fees, which sit in revenue and '
      + 'in cost of sales at once, so any margin on them would credit profit that does not '
      + 'exist. Recognised-elsewhere is a buyout or prepayment already carried by a couponed '
      + 'subscription, so counting it again would double count. The classes sit alongside '
      + 'recognised MRR rather than dividing it: eop_mrr tracks platform recurring revenue in '
      + 'the ledger, and usage, one-time and pass-through are billed on top of it. Each is '
      + 'therefore margined in its own right and none is subtracted from the platform base. '
      // The footer used to present these as settled with nothing to argue
      // against. Chart 28 measures the same quantity from the cost ledger and
      // gets a different answer, and a reader who reaches the footer first
      // should not have to find that out on their own.
      + (() => {
        if (!MARGIN || !MARGIN.measured) return '';
        return 'This used to be a flat ' + fmt.pct(SETTLED.margin, 1)
          + ' assumption carried from the beginning, and the cost ledger disagreed with '
          + 'it by about twenty points. The platform figure is now whatever makes the '
          + 'book add up to what the ledger says, month by month, so every profit and '
          + 'payback figure on this page moves when the cost of serving customers moves. '
          + 'It is the single largest change made to these numbers and it made all of '
          + 'them worse. '
          // The pipeline states a margin of its own now. It is not the same
          // quantity, so agreement is a check rather than a requirement, but a
          // reader is entitled to know the two are being compared at all.
          + (MARGIN.drift === null ? ''
              : 'The pipeline publishes its own gross margin, measured as cost of sales '
                + 'against recurring revenue alone. It is a narrower definition than this '
                + 'one, which also margins usage and one-time revenue, so the two are not '
                + 'expected to match exactly. They currently differ by at most '
                + fmt.pct(MARGIN.drift, 2) + ', in ' + MARGIN.driftMonth + '. '
                // This started under a point. Say what a wide gap means rather
                // than leaving the reader to infer it.
                + (MARGIN.drift > 0.02
                    ? 'That gap was under a point when this check was written and has since '
                      + 'widened, because usage and one-time revenue are now being captured '
                      + 'where before they were not. The definitions have not moved; the '
                      + 'classes they treat differently have grown into something worth '
                      + 'measuring. The wider figure is the more honest of the two, because '
                      + 'it is the one that counts them. '
                    : 'A gap this small means the classes are still too minor to change the '
                      + 'answer. If it widens, either they are not, or one of the two '
                      + 'definitions has moved. '));
      })()
      + (() => {
        // Whether this environment reaches the revenue columns is a fact to be
        // read, not a claim to be carried. It did not for months, the numbers
        // here updated when it started to and the sentence around them did
        // not, which is the same fault this page has caught twice elsewhere.
        const recognised = s2Ids.size ? s2WithMrr.size / s2Ids.size : 0;
        const head = recognised >= 0.9
          ? '<strong>The second Stripe environment is now reaching the revenue columns.</strong> '
          : '<strong>The second Stripe environment is not reaching the revenue columns.</strong> ';
        const body = 'It carries ' + fmt.int(s2) + ' of ' + fmt.int(data.customers.length)
          + ' customer months, ' + fmt.pct(s2Share, 2) + '. ' + fmt.int(s2Ids.size)
          + ' customers have arrived in it since ' + S2_FIRST + ', '
          + fmt.int(s2WithMoney.size) + ' of them carrying money of some kind and '
          + fmt.int(s2WithMrr.size) + ' registering MRR. In ' + fmt.monthLabel(trailing)
          + ' it was ' + fmt.int(newestS2.length) + ' of ' + fmt.int(newest.length)
          + ' new logos, so it is most of the new business rather than a rounding error. ';
        return head + body + (recognised >= 0.9
          ? 'It was invisible to every revenue figure until this push, which is why the '
            + 'earlier collapse in new MRR read as a collapse in demand and was not one.'
          : 'Every figure here that counts revenue therefore understates the newest business, '
            + 'and the fall in new MRR is mostly that rather than demand: first-month cash '
            + 'from new logos has held roughly flat throughout.');
      })()
    : '<strong>Still estimated:</strong> a single 75.7% platform margin is applied to all '
      + 'revenue, because the pushed customer waterfall carries no revenue class columns. '
      + 'The query emits them; the push does not carry them, so the fix is upstream rather '
      + 'than inherent. Pass-through carrier fees matter most, since they sit in revenue and '
      + 'in cost of sales and any margin applied to them credits profit that does not exist. '
      + 'The second Stripe environment carries ' + fmt.int(s2) + ' of '
      + fmt.int(data.customers.length) + ' customer months, ' + fmt.pct(s2Share, 2)
      + '. That is a young environment rather than a broken feed.';

  const CAP_HORIZON = 4;
  const cap = capacityAnalysis(data, { horizon: CAP_HORIZON });
  const cp = cap.points;
  const capLabels = cp.map(p => fmt.monthLabel(p.month));
  const rc = cap.correlations;
  const sign = v => (v >= 0 ? '+' : '') + v.toFixed(2);
  // A 95% interval on a correlation, by Fisher's transform. On 27 overlapping
  // months a correlation of +0.18 admits anything from about -0.2 to +0.5, and
  // the finding has to be read with that in view.
  const nMeasured = cap.measured.length;
  const interval = r => {
    if (r === null || nMeasured < 4) return '';
    const z = Math.atanh(r);
    const se = 1 / Math.sqrt(nMeasured - 3);
    return ` (95% ${sign(Math.tanh(z - 1.96 * se))} to ${sign(Math.tanh(z + 1.96 * se))})`;
  };

  // Two scales, because the two quantities are dollars and a percentage and
  // indexing both to 100 threw away the levels. A reader could see that spend
  // had risen 39% without ever learning that it is about two hundred dollars
  // a logo a month, which is the number a decision actually turns on.
  dualAxisChart($('chart-capacity'), {
    labels: capLabels,
    left: {
      label: 'Retention spend per logo',
      colour: INK.primary,
      values: cp.map(p => p.retentionPerLogo),
      format: v => '$' + Math.round(v).toLocaleString(),
    },
    right: {
      label: `Share of the month's base gone ${CAP_HORIZON} months later`,
      colour: INK.negative,
      values: cp.map(p => p.churn),
      format: v => (v * 100).toFixed(0) + '%',
    },
    describe: i => '<strong>' + fmt.monthLabel(cp[i].month) + '</strong>'
      + '<span>Retention function ' + fmt.money(cp[i].retentionSpend) + '</span>'
      + '<span class="muted">CS ' + fmt.money(cp[i].teams['Customer Success'])
      + ', TAM ' + fmt.money(cp[i].teams['Technical Account Manager'])
      + ', Support ' + fmt.money(cp[i].teams['Support']) + '</span>'
      + '<span>Per logo ' + fmt.money(cp[i].retentionPerLogo) + ' across ' + fmt.int(cp[i].logos) + '</span>'
      + '<span>Customer Success alone ' + fmt.money(cp[i].csPerLogo) + ' per logo</span>'
      + '<span>Share gone ' + CAP_HORIZON + ' months later ' + fmt.pct(cp[i].churn, 1) + '</span>',
  });

  const avg = (rows, key) => rows.reduce((s, x) => s + x[key], 0) / rows.length;
  const csShare = avg(cp, 'csPerLogo') / avg(cp, 'retentionPerLogo');
  $('capacity-finding').innerHTML =
    '<strong>On this sample, spending more on Customer Success is not associated with '
    + 'keeping more customers.</strong> Customer Success alone correlates with churn '
    + CAP_HORIZON + ' months on at ' + sign(rc.capacity) + interval(rc.capacity)
    + '; adding Technical Account Manager and Support, which together are the other '
    + fmt.pct(1 - csShare) + ' of the spend, takes it to ' + sign(rc.wholeFunction)
    + interval(rc.wholeFunction) + ', and ' + sign(rc.wholeFunctionGivenTime) + ' once the '
    + 'shared time trend is removed. Every one of those intervals spans zero, so none is a '
    + 'relationship, and none is wide enough to rule one out either: the data cannot say '
    + 'whether more headcount there would move churn. What it does say is that the churn this '
    + 'page is about has not tracked how much was spent on the team that does retention, so '
    + 'the cost of serving customers can be argued about on its own terms rather than treated '
    + 'as untouchable insurance against churn.';

  $('capacity-note').textContent =
    'Two scales in real units: on the left, Customer Success, Technical Account Manager and '
    + 'Support spend together per live logo; on the right, the share of each month\'s base '
    + 'gone ' + CAP_HORIZON + ' months later. The heading names Customer Success because that '
    + 'is the question; the line is the whole function, and Customer Success alone is in the '
    + 'tooltip. ' + cp.length + ' months are drawn and the last ' + (cp.length - nMeasured)
    + ' have no churn yet, because their ' + CAP_HORIZON + ' months have not elapsed, so every '
    + 'correlation is on ' + nMeasured + ' months. Read the direction, not the strength: two '
    + 'series that both drift over the period, on that few points, cannot carry a correlation, '
    + 'and no trend line is drawn through them. The stronger form of this question is not a '
    + 'correlation at all. It is whether accounts that lost their CSM churned differently from '
    + 'accounts that kept one, and that needs CSM assignment per account, which the pushed data '
    + 'does not carry. Spend is the only measure of the team in the pushed data; headcount is '
    + 'not there. On the same ' + nMeasured + ' months, with CS capacity held constant, the '
    + 'association between new arrivals and churn is ' + sign(rc.arrivalsGivenCapacity)
    + ' rather than ' + sign(rc.arrivals) + '. Chart 22 asks the arrivals question on its own, '
    + 'on the starting months every horizon can reach, so its figure differs from this one.';

  // 21. Rolling correlation, the momentum question.
  const measuredLabels = cap.measured.map(p => fmt.monthLabel(p.month));
  multiLineChart($('chart-momentum'), {
    yTitle: 'Rolling correlation with churn',
    labels: measuredLabels,
    series: [
      { label: 'New arrivals against churn', colour: INK.primary, values: cap.rollingArrivals },
      { label: 'CS capacity against churn', colour: INK.secondary, values: cap.rollingCapacity },
      ...(cap.rollingWholeFunction
        ? [{ label: 'Whole retention function against churn', colour: INK.tertiary,
             values: cap.rollingWholeFunction }] : []),
      ...(cap.rollingPrice
        ? [{ label: 'Price at signup against churn', colour: INK.positive, dashed: true,
             values: cap.rollingPrice }] : []),
    ],
    yFormat: v => v.toFixed(1),
    yMin: -1,
    yMax: 1,
    refs: [{ value: 0, label: 'no relationship', variant: 'ref-floor' }],
    describe: i => '<strong>' + measuredLabels[i] + '</strong>'
      + (cap.rollingArrivals[i] === null
          ? '<span class="muted">inside the first ' + cap.rollingWidth + ' months, no window yet</span>'
          : '<span>Arrivals ' + sign(cap.rollingArrivals[i]) + '</span>'
            + '<span>CS capacity ' + sign(cap.rollingCapacity[i]) + '</span>'
            + (cap.rollingWholeFunction && cap.rollingWholeFunction[i] !== null
                ? '<span>Whole retention function ' + sign(cap.rollingWholeFunction[i]) + '</span>' : '')
            + (cap.rollingPrice && cap.rollingPrice[i] !== null
                ? '<span>Price at signup ' + sign(cap.rollingPrice[i]) + '</span>' : '')),
  });

  const live = cap.rollingArrivals.filter(v => v !== null);
  const liveCap = cap.rollingCapacity.filter(v => v !== null);
  const liveWhole = (cap.rollingWholeFunction || []).filter(v => v !== null);
  const livePrice = (cap.rollingPrice || []).filter(v => v !== null);
  // Written off the numbers rather than around them. An earlier version of this
  // asserted that one relationship "was never there" and the other "has barely
  // moved", which was true of the sample it was written for and became false
  // the moment the window widened — it went on quoting a swing of more than
  // a full point while calling it barely moved. Everything below is computed.
  const rangeOf = xs => Math.max(...xs) - Math.min(...xs);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const signFlips = xs => xs.slice(1).filter((v, i) => (v < 0) !== (xs[i] < 0)).length;
  // Every line drawn, not the two the text used to read: the widest swing was
  // on a line the finding never mentioned.
  const lines = [
    { label: 'New arrivals', xs: live },
    { label: 'Customer Success', xs: liveCap },
    { label: 'The whole retention function', xs: liveWhole },
    { label: 'Price at signup', xs: livePrice },
  ].filter(l => l.xs.length);
  const widest = lines.reduce((a, b) => (rangeOf(b.xs) > rangeOf(a.xs) ? b : a));

  // One plain sentence per line, then the conclusion. The previous version
  // reported ranges and sign counts for both series at once, which is accurate
  // and close to unreadable.
  const read = xs => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    const crossesZero = lo < 0 && hi > 0;
    const last = xs[xs.length - 1];
    if (crossesZero) return 'wanders either side of zero and ends at ' + sign(last);
    if (Math.abs(hi) < 0.3 && Math.abs(lo) < 0.3) return 'stays near zero throughout';
    return 'holds ' + (lo > 0 ? 'positive' : 'negative') + ' and ends at ' + sign(last);
  };

  $('momentum-finding').innerHTML =
    '<strong>None of these lines means anything, and the chart is here to show that rather '
    + 'than to hide it in a single number.</strong> '
    + lines.map(l => '<span class="muted">' + l.label + ' against churn</span> ' + read(l.xs) + '. ').join('')
    + 'A relationship that was real and faded would walk toward zero and stay there; a '
    + 'relationship that was real and held would sit on one side of zero. Over '
    + live.length + ' overlapping twelve-month windows '
    + (lines.every(l => Math.min(...l.xs) < 0 && Math.max(...l.xs) > 0)
        ? 'all ' + lines.length + ' cross zero, and ' : 'these do neither, and ')
    + widest.label.toLowerCase() + ' covers the widest range, ' + rangeOf(widest.xs).toFixed(2)
    + ' points end to end, which is most of the range a correlation can occupy. '
    + 'Read it as the reason not to quote any single pooled figure from these '
    + 'series, including the ones on the chart above.';

  $('momentum-note').textContent =
    'Correlation against forward churn computed over a moving ' + cap.rollingWidth
    + ' month window, so a relationship that has faded shows as a line heading for zero rather '
    + 'than hiding inside one pooled figure. The first ' + (cap.rollingWidth - 1) + ' months '
    + 'carry no window and are blank rather than zero. With only twelve months behind each '
    + 'point these move around, so read the direction rather than the level.';

  renderArrivals();
  renderHorizons();
}

// 11. The same window, this year against one and two years ago. Driven by its
// own slider rather than by the assumptions, because the horizon is a way of
// looking rather than a modelling choice.
function renderSeasonal() {
  // This chart is a comparison, so a horizon with nothing to compare against
  // is not a longer view but an empty one. The year-ago line needs its own
  // full window inside the same two years, which caps the horizon at the
  // months left over once twelve are spent going back. At 12 the slider used
  // to draw a single line and say nothing.
  const span = monthDiff(data.historyStarts, data.lastMonth);
  const cap = Math.max(1, Math.min(12, span - 12));
  const slider = $('horizon');
  if (Number(slider.max) !== cap) {
    slider.max = String(cap);
    if (Number(slider.value) > cap) slider.value = String(cap);
  }
  const horizon = Number(slider.value);
  $('horizon-value').textContent = horizon + (horizon === 1 ? ' month' : ' months');

  const s = seasonalSurvival(data, { horizon, cohorts });
  if (!s.series.length) {
    $('chart-seasonal').innerHTML = '<p class="empty">Not enough history for that window.</p>';
    return;
  }

  const labels = Array.from({ length: horizon + 1 }, (_, i) => (i ? '+' + i : 'start'));
  const colours = [INK.tertiary, INK.secondary, INK.negative];

  multiLineChart($('chart-seasonal'), {
    yTitle: 'Share of logos kept',
    labels,
    series: s.series.map((row, i) => ({
      label: fmt.monthLabel(row.month) + (row.monthsBack ? ` (${row.monthsBack}mo ago)` : ' (latest)'),
      colour: colours[i],
      values: row.curve,
    })),
    yFormat: v => fmt.pct(v),
    yMin: Math.max(0, Math.min(...s.series.map(r => r.survival ?? 1)) - 0.1),
    yMax: 1,
    xTitle: 'Months after the starting month',
    describe: i => '<strong>' + (i ? i + ' month' + (i > 1 ? 's' : '') + ' on' : 'Starting month') + '</strong>'
      + s.series.map(row =>
          '<span>' + row.month + ' ' + fmt.pct(row.curve[i], 1) + '</span>').join(''),
  });

  const latest = s.series[s.series.length - 1];
  const yearAgo = s.series.find(r => r.monthsBack === 12);
  const twoYears = s.series.find(r => r.monthsBack === 24);

  const gap = yearAgo ? (latest.survival - yearAgo.survival) * 100 : null;
  $('seasonal-finding').innerHTML = gap === null
    ? '<strong>' + fmt.pct(latest.survival, 1) + ' still active after ' + horizon + ' months.</strong>'
    : '<strong>' + Math.abs(gap).toFixed(1) + ' points '
      + (gap < 0 ? 'worse' : 'better') + ' than the same window a year ago.</strong> '
      + 'Of everyone active in ' + fmt.monthLabel(latest.month) + ', '
      + fmt.pct(latest.survival, 1) + ' were still there ' + horizon + ' months later, against '
      + fmt.pct(yearAgo.survival, 1) + ' for ' + fmt.monthLabel(yearAgo.month)
      + (twoYears ? ' and ' + fmt.pct(twoYears.survival, 1) + ' for ' + fmt.monthLabel(twoYears.month) : '')
      + '.';

  $('seasonal-note').textContent =
    'Everyone active in the starting month, followed forward as one fixed set. The latest '
    + 'line is the most recent month whose full ' + horizon + ' month window has elapsed, '
    + 'which is why it ends at ' + fmt.monthLabel(s.anchor) + ' rather than at the last month '
    + 'of data. Same calendar position each year, so seasonality is held roughly constant '
    + 'rather than averaged away. '
    + 'This is the standing book at a calendar position, which is a different '
    + 'population from the cohort charts: chart 8 follows one year’s new intakes '
    + 'from their own signup month, where this follows everyone present in a given '
    + 'month whenever they joined. The two can disagree about which year looks worst '
    + 'and both still be right. The book is mostly tenured customers so this chart is '
    + 'largely about them, while chart 8 at ' + horizon + ' month' + (horizon === 1 ? '' : 's')
    + ' is built only from the cohorts of the current year old enough to have run that '
    + 'long, which are its earliest. Neither is the whole answer. Base sizes: '
    + s.series.map(r => fmt.monthLabel(r.month) + ' ' + fmt.int(r.n)).join(', ') + '.';

  // 12. The same fixed sets, followed by revenue rather than by headcount.
  // Where this sits above the logo line, the survivors are paying more than
  // they were, and expansion is covering some of the loss.
  multiLineChart($('chart-seasonal-revenue'), {
    yTitle: 'Share of revenue kept',
    labels,
    series: s.series.map((row, i) => ({
      label: fmt.monthLabel(row.month) + (row.monthsBack ? ` (${row.monthsBack}mo ago)` : ' (latest)'),
      colour: colours[i],
      values: row.revenueCurve,
    })),
    yFormat: v => fmt.pct(v),
    yMin: Math.max(0, Math.min(...s.series.map(r => r.revenueRetention ?? 1)) - 0.1),
    yMax: 1,
    xTitle: 'Months after the starting month',
    describe: i => '<strong>' + (i ? i + ' month' + (i > 1 ? 's' : '') + ' on' : 'Starting month') + '</strong>'
      + s.series.map(row =>
          '<span>' + row.month + ' ' + fmt.pct(row.revenueCurve[i], 1)
          + ' <span class="muted">(logos ' + fmt.pct(row.curve[i], 1) + ')</span></span>').join(''),
  });

  // The gap between the two lines is the expansion cushion: how much the
  // survivors grew, offsetting the ones who left.
  const cushion = row => (row.revenueRetention - row.survival) * 100;
  const latestCushion = cushion(latest);
  const yearAgoCushion = yearAgo ? cushion(yearAgo) : null;
  const revGap = yearAgo ? (latest.revenueRetention - yearAgo.revenueRetention) * 100 : null;

  $('seasonal-revenue-finding').innerHTML = revGap === null
    ? '<strong>' + fmt.pct(latest.revenueRetention, 1) + ' of the revenue kept after '
      + horizon + ' months.</strong>'
    : (() => {
      // Both halves of this were asserted rather than measured: that the trade
      // is worse, and that revenue is what moved. Either can flip.
      const logoGap = (latest.survival - yearAgo.survival) * 100;
      const revenueLedTheFall = Math.abs(revGap) > Math.abs(logoGap);
      const head = revGap < 0
        ? (revenueLedTheFall
            ? '<strong>No, the trade is not better. Revenue fell further than headcount.</strong> '
            : '<strong>No, the trade is not better, but headcount led the fall rather than revenue.</strong> ')
        : '<strong>Revenue held up better than it did a year ago.</strong> ';
      // With the window reaching back to 2024 there is a third point, and it
      // changes the reading: the year-on-year comparison alone made a single
      // exceptional year look like the baseline.
      // Only called an outlier when it is one: on the booked first month the
      // year-ago line read as one because the two older bases carried a joining
      // charge the latest does not.
      const twoBack = twoYears || null;
      const yearAgoOutlier = twoBack && yearAgo.revenueRetention
        - Math.max(twoBack.revenueRetention, latest.revenueRetention) > 0.05;
      const context = !twoBack ? ''
        : yearAgoOutlier
          ? ' Against two years earlier the picture is not a straight decline: '
            + fmt.monthLabel(twoBack.month) + ' kept '
            + fmt.pct(twoBack.revenueRetention, 1) + ' of its revenue, so '
            + fmt.monthLabel(yearAgo.month) + ' at '
            + fmt.pct(yearAgo.revenueRetention, 1) + ' is the outlier in the series rather '
            + 'than the standard the latest window is failing to meet.'
          : ' Two years earlier ' + fmt.monthLabel(twoBack.month) + ' kept '
            + fmt.pct(twoBack.revenueRetention, 1) + ', so the latest window is '
            + Math.abs((latest.revenueRetention - twoBack.revenueRetention) * 100).toFixed(1)
            + ' points ' + (latest.revenueRetention < twoBack.revenueRetention ? 'below' : 'above')
            + ' that as well.';
      return head
        + fmt.pct(latest.revenueRetention, 1) + ' of ' + fmt.monthLabel(latest.month)
        + ' revenue survived ' + horizon + ' months, against '
        + fmt.pct(yearAgo.revenueRetention, 1) + ' a year earlier, a move of '
        + Math.abs(revGap).toFixed(1) + ' points where logos moved '
        + Math.abs(logoGap).toFixed(1) + '. '
        + 'Expansion by the survivors covered ' + yearAgoCushion.toFixed(1)
        + ' points of the loss a year ago and ' + latestCushion.toFixed(1) + ' now.'
        + context;
    })();

  $('seasonal-revenue-note').textContent =
    'The same customers as chart 11, followed by their recurring MRR rather than by whether '
    + 'they are still there. Usage, setup and pass-through are not in it, so a survivor who '
    + 'moved spend from subscription to usage reads here as revenue lost. No new customers '
    + 'enter it, so this is not net revenue retention for the business; it is what one fixed '
    + 'set did. Above the logo line means survivors grew and expansion is offsetting churn. '
    + 'Below it means the ones who stayed are also paying less. The customers who started in '
    + 'the starting month are valued at their second month, as every cohort chart values them, '
    + 'because until mid-2025 their first month carried a joining charge as MRR that came off '
    + 'the month after; on the booked figure that charge was '
    + s.series.map(r => `${fmt.pct(r.intakeShare, 0)} of ${fmt.monthLabel(r.month)}`).join(', ')
    + ' revenue, and it made the older lines fall for a reason the latest does not share. '
    + 'Customers at zero MRR in the starting month count on the logo line and weigh nothing '
    + 'here: ' + s.series.map(r => `${fmt.int(r.zeroAtStart)} of ${fmt.int(r.n)}`).join(', ')
    + '. Starting revenue: '
    + s.series.map(r => fmt.monthLabel(r.month) + ' ' + fmt.money(r.startMrr)).join(', ') + '.';
}

// Per chart annotation.
//
// Takeaways are computed from the data rather than written down, so they
// cannot drift away from what the chart shows. Assumptions and the business
// reading are prose, because they are properties of the method and of the
// decision rather than numbers, and should not change when a push moves a
// decimal.
// The first cohort in the window is not a whole cohort.
//
// A customer who joined before the window opens has no knowable cohort and is
// dropped, but the monthly summary still counts them as arriving in the first
// tracked month. So the opening month divides a full month of spend by a part
// of a month of customers and its cost per logo reads high, which flatters the
// earlier half of any comparison that includes it. Stated rather than silently
// corrected, because it moves the headline in the conservative direction and a
// reader is entitled to know by how much.
function censorNote(data, shown) {
  if (!shown.length) return null;
  const first = shown[0];
  const reported = data.waterfall.find(w => w.month === first.month)?.newLogos;
  if (!reported || !first.size || reported <= first.size * 1.2) return null;
  const rest = shown.slice(1, Math.floor(shown.length / 2));
  const later = shown.slice(Math.floor(shown.length / 2));
  const mean = (rows, key) => (rows.length
    ? rows.reduce((s, r) => s + (r[key] || 0), 0) / rows.length : 0);
  const withFirst = mean(shown.slice(0, Math.floor(shown.length / 2)), 'costPerLogo');
  const without = mean(rest, 'costPerLogo');
  const riseWith = withFirst ? (mean(later, 'costPerLogo') / withFirst - 1) * 100 : null;
  const riseWithout = without ? (mean(later, 'costPerLogo') / without - 1) * 100 : null;
  return `${first.month} is the window's opening month and only ${fmt.int(first.size)} of the `
    + `${fmt.int(reported)} logos the summary books that month have a knowable cohort, the rest `
    + `having joined before the window opens. Its cost per logo therefore reads high, at `
    + `${fmt.money(first.costPerLogo)}, and it sits in the earlier half. Dropping it, the rise `
    + `in cost per logo across the halves is `
    + `${riseWithout === null ? 'unchanged' : riseWithout.toFixed(0) + '%'} rather than `
    + `${riseWith === null ? 'unchanged' : riseWith.toFixed(0) + '%'}, so leaving it in `
    + `understates the increase rather than manufacturing it.`;
}

function annotate(plotId, takeaways, assumptions) {
  const plot = $(plotId);
  if (!plot) return;
  const figure = plot.closest('figure');
  if (!figure) return;

  figure.querySelector('.annotate')?.remove();

  // A value may be a function where the sentence needs a figure from the data,
  // because MEANS is built at module load and the data is not there yet.
  const raw = MEANS[plotId];
  const meaning = typeof raw === 'function' ? raw() : raw;
  const block = document.createElement('details');
  block.className = 'annotate';
  block.innerHTML =
    '<summary>What it says, what it assumes, what it means</summary>'
    + '<h4>What it says</h4><ul>'
    + takeaways.filter(Boolean).map(x => '<li>' + x + '</li>').join('')
    + '</ul><h4>What it assumes</h4><ul>'
    + assumptions.filter(Boolean).map(x => '<li>' + x + '</li>').join('')
    + '</ul>'
    + (meaning ? '<h4>What it means for the business</h4><p class="means">' + meaning + '</p>' : '');
  figure.appendChild(block);
}

const MEANS = {
  'chart-price-volume': () =>
    // The price half of this chart is a 2026 measure on a 32-month axis, and
    // that is not visible from the drawing.
    'Signup price is only recorded from 2026. The workbook it comes from is maintained '
    + 'by hand and was never backfilled, so most new logos in this window carry no '
    + 'starting price at all: ' + (() => {
        const news = data.customers.filter(r => r.eventType === 'new');
        const priced = news.filter(r => r.startingMrr !== null && r.startingMrr > 0);
        return fmt.int(priced.length) + ' of ' + fmt.int(news.length);
      })()
    + ' new logos in the window carry one. Read the price series as a twelve month '
    + 'measure and the volume series as the full window. '
    + 'Over seven months this chart said price had risen 44%. Over the full window it says price '
    + 'fell by nearly half and has since climbed back to roughly where it started, which is a '
    + 'different fact and a different decision. The recovery is real and worth protecting; it '
    + 'is not evidence of pricing power the business did not already have in 2024. What the '
    + 'chart cannot tell you is where to price, because two lines on two scales cross wherever '
    + 'the axes are set. The chart below answers that one.',

  'chart-onboarding':
    'Charging more customers and charging them more are separate decisions with separate '
    + 'effects on conversion, and reading them as one movement hides which lever was actually '
    + 'pulled. Setup fees are also the part of first-month cash that is least visible in MRR, '
    + 'so a change here moves payback without moving any recurring number.',

  'chart-start-type':
    'The share of a month that is not a standard start is the share of the cohort dating that '
    + 'is approximate. Shifted forward customers have had their start date moved upstream, and '
    + 'the cohort charts leave them out rather than guess at when they began. '
    + 'The annual customers are worth watching separately: two of them carry enough to make '
    + 'the months holding them read high.',

  'chart-ltv-cac': () =>
    'Read the two averages under the chart together and the diagnosis is in them. Cut at '
    + `month ${ltvPace ? ltvPace.age : 6}, what a customer returns has `
    + `${ltvPace ? risenBy(ltvPace.worth) : 'moved a little'} between the earlier cohorts and the `
    + `later ones and what one costs has ${ltvPace ? risenBy(ltvPace.cost) : 'moved more'}. `
    + 'That is the whole of the deterioration '
    + 'here, and it points at acquisition rather than at retention or pricing: the same '
    + 'retention curve clears the bar at the older cohorts’ cost per logo and does not at '
    + 'the newer ones’. Move the slider and the gap holds at every age both halves reach, '
    + 'which is what rules out the calendar as the explanation.',

  'chart-payback':
    'Payback is what decides whether growth pays for itself. A cohort that clears its cost in '
    + 'six months funds the next one inside the year; one that takes eighteen does not fund '
    + 'anything inside a planning cycle, however healthy it looks eventually. Read the '
    + 'projected bars as the question rather than the answer: they say when today’s '
    + 'churn rate would get a cohort there, and the cohorts still running are the ones carrying '
    + 'the higher cost per logo, so they have further to go than any that came before them.',

  'chart-recovery':
    'This is the chart to judge a cohort on before it is old enough for the others to be '
    + 'fair. A curve that is already flattening below the line will not cross it later, which '
    + 'means a cohort can be called early rather than waited out for another year.',

  'chart-retention':
    'The distance between the two lines is the question of whether the customers who stay are '
    + 'worth more or less than they were. Expansion covering churn is a very different '
    + 'business from expansion failing to, and it decides whether retention work or upsell '
    + 'work is the better use of the same headcount.',

  'chart-churn': () =>
    'Sustained churn above the threshold sets a floor on how much acquisition is needed just '
    + 'to stand still, and the gap between that floor and what arrives is stated above. '
    + (churnPicture && churnPicture.arrivalsFalling
      ? 'Arrivals have been falling over the last six months, '
      : 'Arrivals have not been rising, ')
    + 'so no plausible improvement in conversion closes the gap on its own; it has to come from '
    + 'the churn side too. '
    + (churnPicture && churnPicture.booksSame
      ? 'The two lines agree on this push, so either can be planned against; the pair is kept '
        + 'so that a gap reopening is visible.'
      : 'Note also which line to plan against. The booked figure is the one most reports quote '
        + 'and it is the one that understates the problem.'),

  'chart-age-retention': () => {
    const a = ageLosses;
    if (!a) return '';
    const parts = [['months 0 to 3', a.early], ['months 3 to 6', a.middle], ['months 6 to 12', a.late]];
    const top = parts.reduce((x, y) => (y[1] > x[1] ? y : x));
    const perMonth = [a.early / 3, a.middle / 3, a.late / 6];
    return `Of what a cohort loses in its first year, the largest share goes in ${top[0]}, `
      + `${top[1].toFixed(1)} points of ${(a.early + a.middle + a.late).toFixed(1)}. `
      + (perMonth[0] >= perMonth[1] && perMonth[0] >= perMonth[2]
        ? 'Per month, the first three are the steepest, which makes onboarding and the first '
          + 'ninety days where retention effort has most to save.'
        : 'Per month the loss is spread across the year rather than concentrated early, so '
          + 'effort confined to the first ninety days would miss most of it.');
  },

  'chart-unit':
    'Winning a customer costs far more than it did, and what that customer pays on arrival has '
    + 'not risen to match, so the gap is an acquisition problem rather than a pricing one. The '
    + 'count now includes customers who start in the second Stripe environment, which is most '
    + 'of the newest months, so the rise is not customers being won and missed. What would make '
    + 'it wrong is timing: a month of spend is set against the customers who started that '
    + 'month, and a sales cycle that lengthened would push cost into the wrong month and '
    + 'overstate the recent readings.',

  'chart-era':
    'On a head count the years run close for the first months, and most of what separates '
    + 'them later rests on the newest year\'s oldest intakes, which is too thin a sample to '
    + 'rebuild onboarding on. Read the first month as medians rather than means: one bad intake '
    + 'moves a mean by several points. That does not close the question, because a head count '
    + 'treats a $200 account and a $2,000 account as the same event. Chart 9 weights them, and '
    + 'the answer changes.',

  'chart-era-revenue':
    'This is the version to act on, and it says the retention problem is larger than the logo '
    + 'count has been reporting. The gap between the two lines is money lost without a customer '
    + 'being lost: downgrades, and accounts booked down to zero MRR while still sitting in the '
    + 'base as live. It widens year on year, so the reported churn rate has been getting less '
    + 'informative rather than more. Two things follow. Revenue retention, not logo retention, '
    + 'is the number to run the business on. And an account at zero MRR needs to be either '
    + 'recovered or closed, because at present it costs support and counts as a win.',

  'chart-flows':
    'Churn is the side to act on. The new logo side cannot currently be read as demand, '
    + 'because the count is drawn almost entirely from the first Stripe environment while new '
    + 'business has been moving to the second, so part of what looks like a collapse in '
    + 'signups is a measurement boundary. Churn carries no such caveat: those customers are '
    + 'in the file and they left. Treating the two halves as equally evidenced would put '
    + 'effort into an acquisition problem that may be much smaller than it looks.',

  'chart-seasonal':
    'This is the chart that rules out the comfortable explanation. Trade businesses are '
    + 'seasonal and a bad quarter is often just a season, but the same window a year earlier '
    + 'was materially better. Whatever is happening is not the calendar.',

  'chart-seasonal-revenue':
    'Revenue falling faster than headcount means the customers being lost are not the small '
    + 'ones, and the ones who stay are not making up the difference. That rules out treating '
    + 'this as attrition at the bottom of the book, which is the version of the story that '
    + 'would be survivable.',

  'breakeven-table':
    'The cohorts with a high chance of never recovering are a write-off decision rather than a '
    + 'patience decision. Knowing which ones they are changes what to do about them now: they '
    + 'are candidates for a retention intervention while they still exist, not candidates for '
    + 'waiting to see.',

  'chart-forward':
    'Cohort charts describe intakes; this describes the whole book. Deterioration visible from '
    + 'a standing start means the problem is not confined to newly won customers, so a fix '
    + 'aimed only at onboarding would leave most of it untouched.',

  'chart-forward-trend':
    'A steady slide rather than a step means this is not a migration, a billing change or a '
    + 'bad month. Structural problems do not resolve themselves, and this one has been running '
    + 'long enough that it would already have stopped if it were going to.',

  'chart-capacity':
    'The apparent link between Customer Success spend and churn largely disappears once the '
    + 'whole retention function is measured and time is held constant. That matters because '
    + 'the narrow version of this chart would support cutting or defending a team on evidence '
    + 'that does not hold. Judging the investment needs CSM assignment per account, so that '
    + 'accounts which lost a CSM can be compared with accounts that kept one. Until that '
    + 'exists the question cannot be answered, and this chart should not be used to argue '
    + 'either way in either direction.',

  'chart-momentum':
    'One relationship has gone and one has not, which is a reason to stop managing to the first. '
    + 'It also shows why a single pooled correlation is a poor way to run anything: the number '
    + 'that looked like nothing was a real effect and its disappearance, averaged together.',

  'chart-new-vs-churn':
    'Thin acquisition months are not causing churn, so the two problems need separate owners '
    + 'and separate fixes. The intuitive story, that a quiet pipeline distracts the team into '
    + 'losing customers, is not supported and following it would waste the effort.',
};

// Every chart gets two or three takeaways read off its own numbers, and the
// two assumptions most likely to change the conclusion if they are wrong.
function renderAnnotations() {
  const w = data.waterfall;
  const latest = w[w.length - 1];
  // The trailing month's new logo count is drawn almost entirely from the
  // first Stripe environment and collapses when new business does not reach
  // it. Quoting it as the end of a trend states a measurement gap as a fact.
  const flowCounts = w.map(r => r.newLogos).filter(Boolean).sort((a, b) => a - b);
  const flowTypical = flowCounts.length ? flowCounts[Math.floor(flowCounts.length / 2)] : 0;
  const flowPerLogo = w.map(r => (r.newLogos ? r.newMrr / r.newLogos : 0)).filter(Boolean).sort((a, b) => a - b);
  const flowTypicalPerLogo = flowPerLogo.length ? flowPerLogo[Math.floor(flowPerLogo.length / 2)] : 0;
  const reliableFlow = w.filter(r => r.newLogos >= flowTypical * 0.35
    && r.newMrr / r.newLogos >= flowTypicalPerLogo * 0.35);
  const lastReliable = reliableFlow[reliableFlow.length - 1] || latest;
  const peak = w.reduce((b, r) => (r.activeLogos > b.activeLogos ? r : b), w[0]);
  const year = latest.month.slice(0, 4);
  const ytd = w.filter(r => r.month.startsWith(year));
  const acquired = ytd.reduce((s, r) => s + (r.newLogos || 0), 0);
  const churned = ytd.reduce((s, r) => s + (r.churnedLogos || 0), 0);

  const ec = cohortEconomics(data, cohorts, state).filter(c => c.costPerLogo !== null);
  const shown = ec.filter(c => c.maxOffset + 1 >= MIN_COHORT_AGE);
  const withLtv = shown.filter(c => c.ltvCac !== null);
  const above3 = withLtv.filter(c => c.ltvCac >= 3).length;
  const belowOne = withLtv.filter(c => c.ltvCac < 1).length;
  const best = withLtv.reduce((a, b) => (b.ltvCac > a.ltvCac ? b : a));
  // Chart 2 draws every cohort with a cost, young ones muted, so its card
  // counts the same population its note does.
  const recovered = ec.filter(c => c.payback !== null);
  const withinGoal = recovered.filter(c => c.payback <= 12).length;

  // Chart 1's annotation is written where the chart is drawn, because both
  // depend on the age its slider sets. Left here it described the lifetime
  // measure the chart no longer uses.

  annotate('chart-payback', [
    `<strong>${recovered.length} of ${ec.length} cohorts have covered their cost</strong>, `
      + (withinGoal === recovered.length
        ? 'and every one of them did it inside the twelve month goal. Nothing has recovered late; cohorts either clear the bar or are still running.'
        : `and ${withinGoal} of those did it inside the twelve month goal.`),
    `${ec.length - recovered.length} of those shown have not recovered and are drawn as projections in a separate colour, not as zeroes or gaps. A zero would read as instant payback, the opposite of what it means.`,
    paybackByEra(recovered),
  ], [
    `A bar is either what happened or a projection of what will, never a blank: ${recovered.length} of these are the month a cohort actually crossed its cost and ${ec.length - recovered.length} are projected. A gap would read as "never", and what it means is "not yet".`,
    `The projection is the same one chart 1 draws hatched, so the two cannot disagree: the pooled month-on-month recurring revenue path of ${donorSpan()}, every cohort with at least seven months observed, which is mostly churn because revenue per surviving customer is roughly flat after the first month. Measured at the month this chart predicts, chart 1 reads 1.0x for the same cohort. The difference between them is the question, not the model: this one asks when a cohort crosses its cost, that one asks where it stands at a fixed age.`,
    `The range around each projection comes from resampling whole donor cohorts rather than resampling the average, so it answers how far one cohort could sit from the typical path rather than how well the typical path is known.`,
    `The run starts at ${data.historyStarts} because that is the first month the QuickBooks ledger carries, so an older cohort would have revenue and no acquisition cost to set against it. That is an absence of data rather than a verdict on earlier cohorts. The first bar holds only the customers with a Stripe start date in that month: everyone else present then may have started earlier and is left out rather than dated to the boundary.`,
  ]);

  const mature = ec.filter(c => c.recovery.length >= 6).slice(-6);
  const crossed = mature.filter(c => c.payback !== null).length;
  annotate('chart-recovery', [
    `${crossed} of the ${mature.length} cohorts drawn have crossed the break-even line inside the window shown.`,
    'The shape of each curve bends the same way whatever the cost baseline is, so the shape survives the split or the margin being wrong. The month a line crosses 100% does not: it moves with both.',
    'Curves that flatten before 100% are cohorts whose revenue is decaying faster than it is accumulating profit.',
  ], [
    recoveryMarginSentence(mature),
    'Only the six most recent cohorts with at least six months are drawn, so this is not the whole book.',
  ]);

  const blended = blendedRetention(cohorts);
  const lastPoint = blended[blended.length - 1];
  const gap = lastPoint ? (lastPoint.logos - lastPoint.revenue) * 100 : null;
  annotate('chart-retention', [
    lastPoint && `By month ${lastPoint.offset}, <strong>${fmt.pct(lastPoint.logos, 1)} of logos and ${fmt.pct(lastPoint.revenue, 1)} of revenue</strong> remain.`,
    gap !== null && `The two lines sit ${Math.abs(gap).toFixed(1)} points apart. Logos above revenue means the survivors pay less than they used to; revenue above logos means expansion is offsetting churn.`,
    'This pools every era, so it is an average: chart 8 splits it by starting year, and chart 9 does the same in money.',
  ], [
    'Indexed to <strong>month 1</strong>, the second month a cohort carries revenue, not month 0. Month 0 carries setup and onboarding fees, and indexing there turns a one-off charge ending into an apparent churn cliff.',
    `Drawn while at least four cohorts and 150 customers remain in the sample, and held to a two year horizon; the last point, month ${lastPoint ? lastPoint.offset : '--'}, rests on ${lastPoint ? lastPoint.cohorts : '--'} cohorts. The logo line is survival rather than presence, so a customer who leaves and returns is counted once.`,
  ]);

  const recent = w.slice(-36);
  // Read off the solid line, which is every customer who stopped appearing.
  //
  // This panel used to quote the dashed line instead, the subset the push
  // books as a churn event. That is the line the note directly above it calls
  // a floor, and reading it gave the chart a headline of no months above the
  // threshold and a latest rate of 3.51% while the measure the chart exists to
  // show was above the threshold in four of the last twelve and reading 6.38%.
  // A churn chart understating churn by nearly half is the worst version of
  // this mistake, so both lines are now quoted and the rate comes first.
  const departureRate = new Map(departures(data).map(d => [d.month, d.rate]));
  const bookedSeries = recent.map((r, i) => (i && recent[i - 1].activeLogos
    ? (r.churnedLogos || 0) / recent[i - 1].activeLogos : null)).filter(v => v !== null);
  const churnSeries = recent.map(r => departureRate.get(r.month) ?? null).filter(v => v !== null);
  const overThreshold = churnSeries.filter(v => v > CHURN_THRESHOLD).length;
  const lastChurn = churnSeries[churnSeries.length - 1];
  const lastBooked = bookedSeries[bookedSeries.length - 1];
  const holdFlat = lastChurn * (recent[recent.length - 1].activeLogos || 0);
  // Arrivals on the cohort count, the page's one count of a logo, and the
  // churn rate averaged over the same six months rather than one month's.
  const startedNow = logosStarted(data, cohorts);
  const arrivals = recent.slice(-6).map(r => startedNow.get(r.month)).filter(v => v != null);
  const arrivalMean = arrivals.length
    ? arrivals.reduce((s, v) => s + v, 0) / arrivals.length : null;
  const sixRate = churnSeries.slice(-6).reduce((s, v) => s + v, 0) / Math.min(6, churnSeries.length);
  const holdSix = sixRate * (recent[recent.length - 1].activeLogos || 0);
  const half = Math.floor(churnSeries.length / 2);
  const churnEarly = churnSeries.slice(0, half);
  const churnLate = churnSeries.slice(half);
  const meanOf = xs => xs.reduce((s, v) => s + v, 0) / xs.length;
  const booksSame = lastBooked !== undefined && Math.abs(lastChurn - lastBooked) < 0.0005;
  churnPicture = { booksSame, firstHalf: meanOf(churnEarly), secondHalf: meanOf(churnLate),
    arrivalsFalling: arrivals.length > 2 && arrivals[arrivals.length - 1] < arrivals[0] };
  annotate('chart-churn', [
    `<strong>${overThreshold} of the last ${churnSeries.length} months sit above the 5% threshold.</strong> The latest reads ${fmt.pct(lastChurn, 2)}.`,
    `That is the solid line, every customer present one month and absent the next. The dashed `
      + `line, the part booked as a churn event, reads ${fmt.pct(lastBooked, 2)} for the same `
      + (booksSame
        ? 'month, the same figure: on this push every departure is booked.'
        : `month, so reading the booked figure alone understates the rate by about `
          + `${lastBooked ? (lastChurn / lastBooked).toFixed(1) : '--'} times.`),
    `Across the window the rate averaged ${fmt.pct(meanOf(churnEarly), 2)} a month in the first `
      + `${churnEarly.length} months and ${fmt.pct(meanOf(churnLate), 2)} in the last `
      + `${churnLate.length}, running from ${fmt.pct(Math.min(...churnSeries), 1)} at its lowest `
      + `to ${fmt.pct(Math.max(...churnSeries), 1)} at its worst.`,
    arrivalMean ? `At the last six months' average rate, ${fmt.pct(sixRate, 2)}, the base needs `
      + `about ${fmt.int(holdSix)} new logos a month to hold flat. Arrivals have averaged `
      + `${fmt.int(arrivalMean)} over the same months, so the base is short by roughly `
      + `${fmt.int(holdSix - arrivalMean)} a month.` : null,
  ], [
    'The denominator is the prior month closing base, so a month of rapid growth flatters the rate slightly.',
    'This counts logos, not revenue, and <strong>cannot tell a lapse from a cancellation</strong>. Some of what reads as churn is a billing gap.',
  ]);

  const windowed = cohorts.slice(-COHORT_WINDOW);
  // On one set of cohorts, the ones that have reached month 6, so the gap is a
  // loss within cohorts rather than two averages over different samples.
  const both = windowed.filter(c => c.maxOffset >= 6 && c.survivors[0] > 0);
  const m3 = mean(both.map(c => c.survivors[3] / c.survivors[0]));
  const m6 = mean(both.map(c => c.survivors[6] / c.survivors[0]));
  ageLosses = ageLossIntervals(windowed);
  annotate('chart-age-retention', [
    `<strong>Across the ${both.length} cohorts that have reached month 6, month 3 averages ${fmt.pct(m3, 1)} and month 6 ${fmt.pct(m6, 1)}</strong>, so about ${((m3 - m6) * 100).toFixed(0)} points of a cohort is lost between those two ages.`,
    ageLosses && `Pooled over the ${ageLosses.cohorts} cohorts that have had a year, months 0 to 3 lose ${ageLosses.early.toFixed(1)} points, 3 to 6 lose ${ageLosses.middle.toFixed(1)} and 6 to 12 lose ${ageLosses.late.toFixed(1)}.`,
    'The spread between cohorts at the same age is wide, which means cohort quality varies more than the blended curve suggests.',
  ], [
    'Indexed to the signup month, month 0, which is 100% by construction. Survival only falls, so there is no first-month charge to distort a head count.',
    'A cohort appears only once that age is behind it. Recent cohorts are genuinely absent rather than sitting at 100%.',
  ]);

  // Read off the series chart 7 draws, so the card and the line cannot part.
  const unit = unitCostSeries();
  const unitDrawn = unit.months.map((m, i) => i).filter(i => unit.costPerLogo[i] !== null);
  const uLast = unitDrawn[unitDrawn.length - 1];
  const uSpend = month => data.cacMonthly.find(r => r.month === month)?.cacTotalActual ?? null;
  const baseMonths = unitDrawn.filter(i => unit.months[i].startsWith(unit.baseYear));
  const baseSpend = baseMonths.length
    ? baseMonths.map(i => uSpend(unit.months[i])).sort((a, b) => a - b)[baseMonths.length >> 1] : null;
  const baseLogos = baseMonths.length
    ? baseMonths.map(i => unit.intake.get(unit.months[i]).size).sort((a, b) => a - b)[baseMonths.length >> 1] : null;
  if (uLast !== undefined) {
    const lastMonthU = unit.months[uLast];
    const spendChange = baseSpend ? (uSpend(lastMonthU) / baseSpend - 1) * 100 : null;
    const logoChange = baseLogos ? (unit.intake.get(lastMonthU).size / baseLogos - 1) * 100 : null;
    annotate('chart-unit', [
      `<strong>Cost per logo in ${fmt.monthLabel(lastMonthU)} is ${(unit.costPerLogo[uLast] / unit.baseCost).toFixed(1)}x the ${unit.baseYear} median month</strong>, ${fmt.money(unit.costPerLogo[uLast])} against ${fmt.money(unit.baseCost)}.`,
      `New-logo revenue per logo has moved from ${fmt.money(unit.baseRevenue)} to ${fmt.money(unit.revenuePerLogo[uLast])} over the same span, so the gap between the lines is cost opening up rather than revenue falling away.`,
      spendChange !== null && logoChange !== null
        && `Against a typical ${unit.baseYear} month, spend is ${spendChange >= 0 ? 'up' : 'down'} ${Math.abs(spendChange).toFixed(0)}% and logos started are ${logoChange >= 0 ? 'up' : 'down'} ${Math.abs(logoChange).toFixed(0)}%.`,
    ], [
      `Both series are indexed to 100 at the median month of ${unit.baseYear}, so the absolute levels do not need to be right for the divergence to read, and one cheap or dear base month cannot set the scale.`,
      'Cost is the acquisition total built from the expense lines, the same figure charts 1, 2 and 17 divide. The denominator is the cohort count those charts use, customers dated by their first revenue, so a logo costs the same here as in the chart 17 table.',
      `${fmt.monthLabel(unit.boundary)} opens the window and is left blank: only customers with a Stripe start date in it can be dated there, so its count is not that month's intake.`,
    ]);
  }

  const eras = retentionByYear(cohorts, { maxMonths: 12 });
  const newestEra = eras[eras.length - 1];
  // Read off the data rather than asserted. This panel used to say the newest
  // cohorts were worse from month 2 onward while quoting a month 3 figure that
  // was the highest of the three, which is what happens when the prose outlives
  // the fix underneath it. The survival change moved these numbers.
  // A cohort curve is a record of vintages that have already aged, not a
  // forecast for one signed today. These cohorts lived their first year under
  // 2025 conditions, when monthly losses ran two to four percent; the current
  // rate is roughly double that, and no cohort has yet aged nine months under
  // it. Projecting the current rate forward is the comparison a reader makes
  // in their head anyway, so it is better made explicitly than left to guess.
  const recentRates = departures(data).filter(d => d.rate !== null).slice(-6);
  const currentRate = recentRates.length
    ? recentRates.reduce((s, d) => s + d.rate, 0) / recentRates.length : null;
  // Month 0 is the signup month on this chart, so reaching month 9 is nine
  // monthly steps and the end of the first year is twelve.
  const survivalAt = k => Math.pow(1 - currentRate, k);
  const depthNote = currentRate
    ? `These are ${eras.map(e => e.year).slice(0, -1).join(' and ')} vintages, and they aged `
      + `through a calmer period than the one running now. At the loss rate of the last six `
      + `months, ${fmt.pct(currentRate, 2)} a month, a customer signed today would have about a `
      + `${fmt.pct(survivalAt(9), 0)} chance of reaching month 9 and `
      + `${fmt.pct(survivalAt(12), 0)} of reaching the end of their first year. That is the `
      + `number to plan on. `
      + `This chart is the record of what already happened, not a forecast.`
    : null;

  // Years that have actually reached the age being quoted. Filtering here
  // rather than coercing a missing value to zero, which is what made the
  // spread read as the whole of the leading year.
  const ready6 = eras.filter(e => e.month6 !== null && e.month6 !== undefined);
  const rank6 = [...ready6].sort((a, b) => b.month6 - a.month6);
  const best6 = rank6[0] || eras[0];
  const worst6 = rank6[rank6.length - 1] || eras[0];
  const ready3 = eras.filter(e => e.month3 !== null && e.month3 !== undefined);
  const best3 = [...ready3].sort((a, b) => b.month3 - a.month3)[0] || eras[0];
  const gapAt6 = e => ((e.grossMonth6 || 0) - (e.logosMonth6FromMonth2 || 0)) * 100;
  const byGap = [...eras].sort((a, b) => gapAt6(a) - gapAt6(b));
  annotate('chart-era-revenue', [
    `<strong>${eras.every(e => gapAt6(e) < 0)
      ? 'Revenue falls faster than the count in every year'
      : eras.some(e => gapAt6(e) < 0)
        ? `Revenue falls faster than the count in ${eras.filter(e => gapAt6(e) < 0).map(e => e.year).join(' and ')}`
        : 'Revenue holds better than the count in every year'}</strong>: at month 6, measured `
      + `from month 1, the second month, the money line sits `
      + `${eras.map(e => `${Math.abs(gapAt6(e)).toFixed(1)} points ${gapAt6(e) < 0 ? 'below' : 'above'} in ${e.year}`).join(', ')}.`,
    `${byGap[0].year} keeps ${fmt.pct(byGap[0].logosMonth6FromMonth2, 1)} of its customers and `
      + `${fmt.pct(byGap[0].grossMonth6, 1)} of its revenue. Counting heads there overstates what `
      + `the cohort is still worth by roughly a fifth of itself.`,
    `Because expansion is capped out, none of this is a cohort failing to grow. It is money that `
      + `was being paid and is not any more, by customers who in many cases are still on the books.`,
  ], [
    'Gross revenue retention: each customer capped at what they were paying in their second '
      + 'month, so departures and downgrades both pull it down and expansion cannot lift it.',
    'Indexed and drawn from month 1, the second month, where the cap is set, because a part-billed first month '
      + 'leaves a customer under the rate they arrive on. The logo figures quoted here are '
      + 'reindexed to month 1 to match.',
    'Not strictly monotonic, and not forced to be: a customer who downgrades and later returns '
      + 'to their original rate adds that money back.',
  ]);

  annotate('chart-era', [
    `<strong>The three years sit within ${(((best6.month6 || 0) - (worst6.month6 || 0)) * 100).toFixed(1)} points of each other at month 6</strong>: `
      + `${eras.map(e => `${e.year} ${fmt.pct(e.month6, 1)}`).join(', ')}. `
      + `${best6.year} holds best and ${worst6.year} worst, on samples of ${best6.reachedMonth6} and ${worst6.reachedMonth6} cohorts.`,
    (best3.year === newestEra.year
      ? 'Early on the newest intakes are not the weak ones: at month 3 the order is '
      : 'At month 3 the years read ')
      + `${eras.map(e => `${e.year} ${fmt.pct(e.month3, 1)}`).join(', ')}, with ${best3.year} highest.`,
    `The ${newestEra.year} line rests on ${newestEra.reachedMonth6} cohorts at month 6, so its right hand end is thin and will move. `
      + `Chart 9 asks it again with each customer capped at what they arrived on, and there the years do separate.`,
    // Why this chart reads higher than the churn rate suggests it should.
    // Asked in the room as "I thought we lost half in nine months, this says
    // a quarter". Both are right and they are different questions, so the
    // chart should answer the one it is not otherwise asked.
    depthNote,
  ], [
    'Indexed to the signup month, <strong>month 0</strong>, as chart 6 is, because this counts logos rather than revenue and there is no setup fee to distort the first month. Chart 4 indexes to month 1.',
    'A point is dropped once fewer than twenty customers in that year have reached that age. That is the only rule, so the far end of the newest line can rest on one or two cohorts, and the finding above says how many.',
  ]);

  // The booked flows do not add up to what the base did, and saying so is the
  // point of this panel.
  //
  // It used to read the churn column alone and report the year as a net gain
  // of 42 logos, while the base fell by 112 over the same months. Both cannot
  // be true. The booked churn column misses every customer who drops out of
  // the export without generating a churn event, so the flows it shows are the
  // floor rather than the movement, exactly as on chart 5.
  const liveByMonth = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
    if (!liveByMonth.has(row.month)) liveByMonth.set(row.month, new Set());
    liveByMonth.get(row.month).add(row.id);
  }
  const flowMonths = [...liveByMonth.keys()].sort();
  let trueIn = 0;
  let trueOut = 0;
  for (let i = 1; i < flowMonths.length; i += 1) {
    if (!flowMonths[i].startsWith(String(year))) continue;
    const now = liveByMonth.get(flowMonths[i]);
    const before = liveByMonth.get(flowMonths[i - 1]);
    for (const id of now) if (!before.has(id)) trueIn += 1;
    for (const id of before) if (!now.has(id)) trueOut += 1;
  }
  // The closing base of the month before the year starts, because the first
  // transition counted is December into January. Taking January's own base
  // instead dropped a month of losses and missed the reconciliation by nine.
  const firstOfYear = flowMonths.findIndex(m => m.startsWith(String(year)));
  const opening = firstOfYear > 0 ? liveByMonth.get(flowMonths[firstOfYear - 1]) : null;
  const closing = liveByMonth.get(flowMonths[flowMonths.length - 1]);

  annotate('chart-flows', [
    `<strong>Counting every customer who stopped appearing, ${fmt.int(trueOut)} went out `
      + `against ${fmt.int(trueIn)} in, ${year} to date, a net loss of `
      + `${fmt.int(trueOut - trueIn)}.</strong>`
      + (opening && closing ? ` The base moved from ${fmt.int(opening.size)} to `
        + `${fmt.int(closing.size)} over those months, which is the same number.` : ''),
    `The columns drawn here are the booked flows, ${fmt.int(churned)} out against `
      + `${fmt.int(acquired)} in, which would make the year a net gain of `
      + `${fmt.int(acquired - churned)}. That is the floor rather than the movement: a customer `
      + `whose subscription drops out of the export never produces a churn event. Read the `
      + `columns for shape and the figure above for the level.`,
    `New logos have fallen from ${fmt.int(ytd[0].newLogos)} in ${fmt.monthLabel(ytd[0].month)} to ${fmt.int(lastReliable.newLogos)} in ${fmt.monthLabel(lastReliable.month)}.`
      + (lastReliable.month === latest.month ? '' : ` ${fmt.monthLabel(latest.month)} reads ${fmt.int(latest.newLogos)}, but its revenue has not settled, so it is not read as demand.`),
    'Churn is the larger of the two movements once it is counted in full, so the base is falling on the losing side rather than the winning one.',
  ], [
    'Net change is drawn as a line because it is the sum of the other two. As a third column it would read as an independent quantity.',
    'Reactivations are counted separately from new logos, so a returning customer is not double counted as an acquisition.',
  ]);

  // 11 and 12, the year on year pair.
  const seas = seasonalSurvival(data, { horizon: Number($('horizon').value) || 4, cohorts });
  if (seas.series.length) {
    const now = seas.series[seas.series.length - 1];
    const yr = seas.series.find(s => s.monthsBack === 12);
    const two = seas.series.find(s => s.monthsBack === 24);
    annotate('chart-seasonal', [
      yr && `<strong>${Math.abs((now.survival - yr.survival) * 100).toFixed(1)} points worse than the same window a year ago</strong>: ${fmt.pct(now.survival, 1)} against ${fmt.pct(yr.survival, 1)}.`,
      two && `This is not a steady slide. ${two.month} sits between the other two at ${fmt.pct(two.survival, 1)}, so retention improved into ${yr.month} and then fell past where it started.`,
      `The lines separate early and keep separating, which points at a level shift rather than a delay.`,
    ], [
      'Only a fully elapsed window is drawn, so the latest line ends at ' + seas.anchor + ' rather than the last month of data. A partial window would flatter it.',
      'Same calendar position each year holds seasonality roughly constant, but gives you <strong>three observations</strong>. It is a check, not a trend.',
    ]);

    const cushionNow = (now.revenueRetention - now.survival) * 100;
    const cushionThen = yr ? (yr.revenueRetention - yr.survival) * 100 : null;
    annotate('chart-seasonal-revenue', [
      yr && `<strong>Revenue fell further than headcount</strong>: ${Math.abs((now.revenueRetention - yr.revenueRetention) * 100).toFixed(1)} points against ${Math.abs((now.survival - yr.survival) * 100).toFixed(1)} for logos.`,
      cushionThen !== null && `The expansion cushion has collapsed from ${pp(cushionThen)} to ${pp(cushionNow)}. Survivors used to grow enough to absorb much of the churn and no longer do.`,
      `Starting revenue for the latest window is ${fmt.money(now.startMrr)} across ${fmt.int(now.n)} customers.`,
    ], [
      'This follows one fixed set of customers, so no new business enters it. It is not net revenue retention for the company.',
      'Above the logo line means survivors expanded; below means the ones who stayed are also paying less.',
    ]);
  }

  // 17, projected break-even.
  const proj = projectedBreakEven(data, cohorts, state);
  if (proj.length) {
    const done = proj.filter(x => !x.projected);
    const atRisk = proj.filter(x => x.projected && x.neverRate >= 0.25);
    const widest = proj.filter(x => x.projected && x.low !== null)
      .reduce((a, b) => ((b.high - b.low) > (a.high - a.low) ? b : a), { high: 0, low: 0, month: null });
    annotate('breakeven-table', [
      `<strong>${done.length} of ${proj.length} cohorts have already covered their cost</strong>, and those rows are fact rather than forecast.`,
      atRisk.length && `${atRisk.length} carry at least a one in four chance of never covering it. ${atRisk[0].month} is the worst at ${fmt.pct(atRisk[0].neverRate)}.`,
      widest.month && `The widest range is ${widest.month}, ${widest.low} to ${widest.high} months.`,
    ], [
      `The range comes from resampling <strong>whole donor cohorts</strong>, ${donorSpan()}, not from resampling the average. It answers how far one cohort can sit from the average, which is the wider and more useful question.`,
      'No price rises are modelled beyond what the donors themselves saw: the path is their netted MRR, so expansion among their survivors is carried in it and nothing else is. Projection stops at ten years. "Not within 10 years" means the model gave up, not that the cohort is dead.',
    ]);
  }

  // 15 and 16, forward survival.
  const fw = forwardSurvival(data, { horizon: 4, windows: 24 });
  if (fw.starts.length) {
    const spread = Math.max(...fw.starts.map(s => s.survival)) - Math.min(...fw.starts.map(s => s.survival));
    annotate('chart-forward', [
      `<strong>Four month survival fell from ${fmt.pct(fw.earlier.rate, 1)} to ${fmt.pct(fw.recent.rate, 1)}</strong> between the earlier windows and the most recent six, on ${fmt.int(fw.recent.total + fw.earlier.total)} customer observations.`,
      `The best and worst windows are ${(spread * 100).toFixed(1)} points apart, so the fan is wide enough that any single month would have misled.`,
      'This asks what the whole base did from a standing start, which is the number that moves revenue, rather than how one intake decayed.',
    ], [
      'Only fully elapsed windows appear. Including partial ones would make recent months look <strong>better</strong> and reverse the finding.',
      'Consecutive windows share most of their customers, so they are not independent samples and the z of ' + fw.z.toFixed(1) + ' overstates confidence.',
    ]);

    annotate('chart-forward-trend', [
      `The decline is steady across ${fw.starts.length} starting months rather than one bad month, which rules out a single billing or migration event as the whole explanation.`,
      `The base each window starts from grew from ${fmt.int(fw.starts[0].n)} to ${fmt.int(fw.starts[fw.starts.length - 1].n)}, so this is not a fixed panel.`,
    ], [
      'Each point is a different population, so a change reflects both who is in the base and how they behaved.',
      'Same elapsed-window rule, so the line stops before the last month of data.',
    ]);
  }

  // 20 and 21.
  const cap = capacityAnalysis(data);
  const rc2 = cap.correlations;
  const sign2 = v => (v >= 0 ? '+' : '') + v.toFixed(2);
  const firstHalf = cap.points.slice(0, 12), secondHalf = cap.points.slice(12);
  const avg = (rows, key) => rows.reduce((s, x) => s + x[key], 0) / rows.length;
  annotate('chart-capacity', [
    `<strong>CS spend per active logo rose ${((avg(secondHalf, 'csPerLogo') / avg(firstHalf, 'csPerLogo') - 1) * 100).toFixed(0)}%</strong> across the window while churn also rose, correlating at ${sign2(rc2.capacity)}.`,
    `Customer Success alone holds up with time controlled, ${sign2(rc2.capacityGivenTime)}. The whole retention function does not: ${sign2(rc2.wholeFunctionGivenTime)}. The narrow measure was reading one team's trend as the department's.`,
    'Almost certainly the team was staffed up in response to churn rather than causing it, but the investment is not yet visible as a retention improvement.',
  ], [
    '<strong>Spend is a proxy for headcount</strong>, which the push does not carry. Salaries track it more closely than the total, since bonuses move with outcomes.',
    'Direction of causation is unresolved and unresolvable here. The stronger question is whether accounts that lost a CSM churned differently, which needs per-account assignment.',
  ]);

  const live = cap.rollingArrivals.filter(v => v !== null);
  const liveCap = cap.rollingCapacity.filter(v => v !== null);
  annotate('chart-momentum', [
    `<strong>The arrivals relationship has gone</strong>: ${sign2(live[0])} over the earliest window and ${sign2(live[live.length - 1])} over the latest.`,
    `The CS capacity one has barely moved, ${sign2(liveCap[0])} to ${sign2(liveCap[liveCap.length - 1])}.`,
    'This is the honest version of the two correlation charts, because it shows a relationship fading rather than averaging it into a single number.',
  ], [
    'Each point rests on only twelve months, so the levels wobble. Read the direction, not the value.',
    'The first eleven months carry no window and are blank rather than zero.',
  ]);

  annotate('chart-new-vs-churn', [
    `<strong>Pooled, there is almost nothing here.</strong> Over the ${cap.points.length} months the capacity series covers the correlation is ${sign2(rc2.arrivals)}, under 1% of the variation. The chart above, drawn on the months where a full forward window has elapsed, gives its own figure in the finding.`,
    `But that conceals the shape. With CS capacity held constant the association is ${sign2(rc2.arrivalsGivenCapacity)}, and the previous chart shows it was real early and has since gone.`,
    `Either way it rests on around two dozen monthly observations, which is far too few for a correlation to carry weight on its own.`,
  ], [
    'Both series drift over the period, and two drifting series correlate whether or not they are related. No trend line is drawn for that reason.',
    'Correlation is not causation here in either direction, and the confound is time rather than anything either axis measures.',
  ]);

  // The four charts built from the signup source and the lifetimes file.
  const sx2 = signupEconomics(data);
  if (sx2.months.length) {
    const a = sx2.months[0];
    const z = sx2.months[sx2.months.length - 1];
    const attach = sx2.months.filter(r => r.attachRate !== null);
    const fees = sx2.months.filter(r => r.averageFee !== null);

    annotate('chart-price-volume', [
      `<strong>Volume fell ${Math.abs((z.count / a.count - 1) * 100).toFixed(0)}% while the price at signup rose ${((z.averagePrice / a.averagePrice - 1) * 100).toFixed(0)}%</strong>, ${fmt.money(a.averagePrice)} to ${fmt.money(z.averagePrice)}.`,
      `New MRR added fell ${Math.abs((z.startingMrr / a.startingMrr - 1) * 100).toFixed(0)}%, ${fmt.money(a.startingMrr)} to ${fmt.money(z.startingMrr)}, which is less than the fall in count because each signup is worth more.`,
      `The revenue effect is smaller than the volume line alone suggests, because each remaining signup is worth more. Read that from the two rates of change, not from where the lines cross: on a dual axis the crossing point can be slid anywhere.`,
    ], [
      'Starting MRR is what a customer was sold, not what they have paid since, so this is a price measure rather than a revenue one.',
      'The same S1 weighting applies. The last month of this source carries a handful of customers and is dropped rather than drawn.',
    ]);

    if ($('chart-onboarding')) annotate('chart-onboarding', [
      `<strong>The share charged a setup fee moved from ${fmt.pct(attach[0].attachRate, 1)} to ${fmt.pct(attach[attach.length - 1].attachRate, 1)}</strong> across the window.`,
      `The fee itself went from ${fmt.money(fees[0].averageFee)} to ${fmt.money(fees[fees.length - 1].averageFee)} where it was charged.`,
      `Those two move independently, so the total onboarding take can rise while the attach rate falls.`,
    ], [
      'The average is taken across customers who were charged, not across everyone, so it is not diluted by those who were not.',
      'A setup fee is one-time and sits outside MRR, so none of this appears in any recurring figure on the page.',
    ]);

    const st = sx2.typeTotals;
    const nonStandard = st.filter(x => ['shifted forward', 'waived', 'annual'].includes(x.type));
    annotate('chart-start-type', [
      `<strong>${nonStandard.reduce((s, x) => s + x.customers, 0)} of ${fmt.int(sx2.total)} customers did not start in the standard way</strong>, carrying ${fmt.money(nonStandard.reduce((s, x) => s + x.startingMrr, 0))} of starting MRR between them.`,
      st.map(x => `${x.type} ${x.customers}`).join(', ') + '.',
      `${sx2.paidBelow.customers} paid less in month one than their starting MRR, ${fmt.money(sx2.paidBelow.startingMrr)} of price, which is the gap between what is billed and what arrives.`,
    ], [
      'Start type is classified upstream by hand, one customer at a time, rather than inferred from the shape of the payments.',
      'Annual customers are counted at twelve months in the month they sign, so a month carrying one reads high and is not comparable to its neighbours.',
    ]);
  }

}

const pp = v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' points';

function renderSignups() {
  const sx = signupEconomics(data);
  if (!sx.months.length) {
    for (const id of ['chart-price-volume', 'chart-start-type']) {
      const node = $(id);
      if (node) node.innerHTML = '<p class="empty">No signup pricing in this push.</p>';
    }
    return;
  }

  const ms = sx.months;
  const labels = ms.map(r => fmt.monthLabel(r.month));
  const first = ms[0];
  const last = ms[ms.length - 1];

  // 13. Volume against price.
  // Two real scales rather than both indexed to 100. Indexing answered "how
  // far has each moved", which hid the thing being asked: what a customer
  // costs now against how many are arriving, in the units those are actually
  // discussed in.
  // Drawn over the whole window rather than over the signup tab's seven
  // months. On seven months this reads as a steady 44% price rise. On
  // twenty-four it is a V: the average new subscription was about $1,325 in
  // 2024-09, fell to $741 by 2025-11 and has climbed back to roughly where it
  // started. The recent rise is a recovery, not a new high, and the short
  // window could not show that.
  const ph = signupPriceHistory(data);
  const phLabels = ph.map(r => fmt.monthLabel(r.month));
  // Volume is the page's one count of a logo, customers dated by their first
  // revenue. The count of new events with a price was a third definition, up
  // to nine short of it in a month. The boundary month is blank: its count is
  // only the customers with a Stripe start date in it.
  const started = logosStarted(data, cohorts);
  const volume = ph.map(r => started.get(r.month) ?? null);
  dualAxisChart($('chart-price-volume'), {
    labels: phLabels,
    left: {
      label: 'New logos',
      colour: INK.negative,
      values: volume,
      format: v => Math.round(v),
    },
    right: {
      label: 'What a new customer pays, monthly',
      colour: INK.primary,
      values: ph.map(r => r.recurringMean),
      format: v => '$' + Math.round(v).toLocaleString(),
      // The booked figure, drawn behind, so the gap between what was booked
      // and what recurred is visible rather than described.
      shadow: { values: ph.map(r => r.mean), label: 'As booked in new_mrr' },
    },
    describe: i => '<strong>' + fmt.monthLabel(ph[i].month) + '</strong>'
      + '<span>' + (volume[i] === null ? 'No count at the window boundary' : fmt.int(volume[i]) + ' new logos') + '</span>'
      + '<span>Paying ' + fmt.money(ph[i].recurringMean) + ' a month from their second month, on '
      + fmt.int(ph[i].recurringN) + ' still paying</span>'
      + '<span class="muted">Booked at an average ' + fmt.money(ph[i].mean) + ', median '
      + fmt.money(ph[i].median) + '</span>',
  });

  const withRec = ph.filter(r => r.recurringMean !== null);
  const recFirst = withRec[0], recLast = withRec[withRec.length - 1];
  const premiumEarly = withRec.filter(r => r.month < '2025-07').map(r => r.firstMonthPremium);
  const premiumLate = withRec.filter(r => r.month >= '2025-10').map(r => r.firstMonthPremium);
  const avg = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

  $('price-volume-finding').innerHTML = ''
    // Direction read from the data, not asserted. Math.abs here would report a
    // fall as a rise, which is the same fault the era-revenue finding had.
    + (() => {
        const change = recLast.recurringMean / recFirst.recurringMean - 1;
        const pct = Math.abs(change * 100).toFixed(0);
        if (Math.abs(change) < 0.03) {
          return '<strong>What a new customer pays has barely moved, ' + pct + '%.</strong> ';
        }
        // "steadily" is a claim about the path, not the endpoints. Only make it
        // where the series does not cross back over where it started.
        const vals = withRec.map(r => r.recurringMean);
        const monotoneish = change > 0
          ? vals.filter(v => v < recFirst.recurringMean).length <= vals.length * 0.2
          : vals.filter(v => v > recFirst.recurringMean).length <= vals.length * 0.2;
        return '<strong>What a new customer pays has '
          + (change > 0 ? 'risen' : 'fallen')
          + (monotoneish ? ' steadily' : ', though not steadily,')
          + ' by ' + pct + '%.</strong> ';
      })()
    + fmt.money(recFirst.recurringMean) + ' a month in ' + fmt.monthLabel(recFirst.month)
    + ' against ' + fmt.money(recLast.recurringMean) + ' in ' + fmt.monthLabel(recLast.month) + '. '
    + 'The booked line behind it falls and then recovers, and that shape is an artefact: until '
    + 'mid-2025 the first month’s charge was booked as MRR and taken off again the next '
    + 'month as a contraction, worth ' + fmt.money(avg(premiumEarly)) + ' a customer on average, '
    + 'against ' + (Math.abs(avg(premiumLate)) < 25 ? 'nothing'
        : fmt.money(Math.abs(avg(premiumLate)))) + ' once the practice stopped. '
    + (() => {
        const counted = ph.map((r, i) => ({ month: r.month, n: volume[i] })).filter(x => x.n !== null);
        return counted.length > 1
          ? 'Volume went from ' + fmt.int(counted[0].n) + ' in ' + fmt.monthLabel(counted[0].month)
            + ' to ' + fmt.int(counted[counted.length - 1].n) + ' in '
            + fmt.monthLabel(counted[counted.length - 1].month) + ' over the same window.'
          : '';
      })();

  $('price-volume-note').innerHTML =
    '<strong>The point where these lines cross means nothing.</strong> Two scales can be slid '
    + 'until they meet anywhere on the chart, so a crossing is a choice of axis rather than a '
    + 'fact about the business, and it is not a price to aim at. The chart below asks that '
    + 'question properly, by grouping customers by what they paid and following each group '
    + 'forward. Read the shapes here, not the intersection. '
    + 'The price line is what each new customer paid in their second month, averaged over the '
    + 'ones still paying then, because the booked new_mrr carried the joining charge until '
    + 'mid-2025. A customer present in their second month at $0, a free month, is left out of the '
    + 'average rather than counted at zero, which lifts the 2026 months where free starts are '
    + 'commonest. The booked new_mrr is drawn faintly behind it and is in the tooltip. The '
    + 'richer starting_mrr, what a customer was actually sold, is only populated from 2026-01 '
    + 'and is what chart 16 uses. New logos are the customers whose first revenue fell in the '
    + 'month, the count the cohort charts use; the first month of the window has no count, '
    + 'because only customers with a Stripe start date can be dated to it.';

  // Attach rate and fee are two different movements. No chart on the page
  // draws this any more; the guards below keep it inert until one does.
  if ($('chart-onboarding')) multiLineChart($('chart-onboarding'), {
    yTitle: 'Share of new customers charged a setup fee',
    labels,
    series: [
      { label: 'Share charged a setup fee', colour: INK.primary,
        values: ms.map(r => (r.attachRate === null ? null : r.attachRate * 100)) },
    ],
    yFormat: v => Math.round(v) + '%',
    yMin: 0,
    describe: i => '<strong>' + fmt.monthLabel(ms[i].month) + '</strong>'
      + '<span>' + fmt.pct(ms[i].attachRate, 1) + ' charged a setup fee</span>'
      + '<span>Average ' + fmt.money(ms[i].averageFee) + ' where charged</span>'
      + '<span class="muted">' + fmt.money(ms[i].feeTotal) + ' in total</span>',
  });

  const attachEnds = ms.filter(r => r.attachRate !== null);
  const feeEnds = ms.filter(r => r.averageFee !== null);
  if ($('onboarding-finding')) $('onboarding-finding').innerHTML =
    '<strong>Two separate movements, worth not confusing.</strong> The share of customers '
    + 'charged a setup fee went from ' + fmt.pct(attachEnds[0].attachRate, 1) + ' to '
    + fmt.pct(attachEnds[attachEnds.length - 1].attachRate, 1)
    + ', and the fee itself from ' + fmt.money(feeEnds[0].averageFee) + ' to '
    + fmt.money(feeEnds[feeEnds.length - 1].averageFee)
    + '. The attach rate has fallen while the fee has risen, so the two are moving in '
    + 'opposite directions: fewer customers are charged, and those who are pay more. They are '
    + 'different decisions with different effects on conversion, and reading them as one '
    + 'movement hides which lever was pulled.';
  // The tab is filled in by hand and runs behind, so the recent months of both
  // signup charts sit on part of their intake. Said out loud, because a reader
  // comparing months cannot see it, and because falling coverage reads exactly
  // like falling sales.
  const thin = sx.months.filter(m => m.coverage !== null && m.coverage < 0.85);
  const coverageNote = thin.length
    ? ' This tab is maintained by hand and runs behind the billing file, so the most recent '
      + 'months hold only part of their intake: '
      + thin.map(m => `${fmt.monthLabel(m.month)} ${fmt.int(m.count)} of `
        + `${fmt.int(m.billedNew)} (${fmt.pct(m.coverage, 0)})`).join(', ')
      + '. Those months are drawn from that share rather than from everyone who started, so '
      + 'read them as provisional. It also means the count here is not a demand measure: the '
      + 'tab has thinned faster than the billed count of new customers, which itself ran '
      + fmt.int(thin.reduce((s, m) => s + m.billedNew, 0) / thin.length) + ' a month over those '
      + 'months against ' + fmt.int(sx.billedWindowMean) + ' across the window. Coverage can read '
      + 'above 100%, because some signups carry no new event in the billing file and some carry '
      + 'it in a different month.'
    : '';

  if ($('onboarding-note')) $('onboarding-note').textContent =
    'Attach rate is the share of the month with a setup fee above zero. The average is taken '
    + 'across those charged, not across everyone, because including the customers who were not '
    + 'charged would '
    + 'blend the two movements back together.' + coverageNote;

  // 16. How much of a month is not a standard start.
  const types = sx.typeTotals.map(x => x.type);
  const palette = [INK.tertiary, INK.primary, INK.secondary, INK.negative, INK.positive];
  multiLineChart($('chart-start-type'), {
    yTitle: 'Share of the month’s starts',
    labels,
    series: types.map((type, i) => ({
      label: type,
      colour: palette[i % palette.length],
      values: ms.map(r => ((r.byType[type] || 0) / r.count) * 100),
    })),
    yFormat: v => Math.round(v) + '%',
    yMin: 0,
    describe: i => '<strong>' + fmt.monthLabel(ms[i].month) + '</strong>'
      + types.map(type => '<span>' + type + ' ' + fmt.int(ms[i].byType[type] || 0) + '</span>').join(''),
  });

  const shifted = sx.typeTotals.find(x => x.type === 'shifted forward');
  const waived = sx.typeTotals.find(x => x.type === 'waived');
  const annual = sx.typeTotals.find(x => x.type === 'annual');
  $('start-type-finding').innerHTML =
    '<strong>Not every month starts the same way, and three of these break a different '
    + 'number.</strong> '
    + (shifted ? shifted.customers + ' customers are shifted forward, '
        + fmt.money(shifted.startingMrr) + ': the workbook has moved their start date, so the '
        + 'month they are filed under is not the month they began, and the cohort charts leave '
        + 'them out rather than date them to it. ' : '')
    + (waived ? waived.customers + ' were waived, ' + fmt.money(waived.startingMrr)
        + ', counting as MRR while contributing no cash. ' : '')
    + (annual ? annual.customers + ' are annual, ' + fmt.money(annual.startingMrr)
        + ' counted at twelve months, which makes the months carrying them read high.' : '');
  $('start-type-note').textContent =
    'Share of each month by how the subscription started. '
    + sx.paidBelow.customers + ' customers across the whole source paid less in month one than '
    + 'their starting MRR, ' + fmt.money(sx.paidBelow.startingMrr) + ' of price, which is the '
    + 'gap between what is billed and what arrives.' + coverageNote;
}

// 23. The same scatter at every horizon, stepped rather than animated.
//
// This replaced a GIF. The point of the sequence is that the cloud lifts as
// churn is given longer to happen and does not tilt, and that only reads if
// the axes hold still: rescaled per step, every panel looks alike and the
// lifting disappears. So both bounds are computed once across all six
// horizons and pinned, which also means the six settings are directly
// comparable to each other rather than each being its own picture.
function renderHorizons() {
  const slider = $('horizons-step');
  if (!slider || !$('chart-horizons')) return;
  const horizon = Number(slider.value) || 1;
  $('horizons-step-value').textContent = horizon + (horizon === 1 ? ' month' : ' months');

  const all = [1, 2, 3, 4, 5, 6].map(hz => ({ hz, ...arrivalsAgainstChurn(data, { horizon: hz }) }));
  const withPoints = all.filter(a => a.points.length);
  if (!withPoints.length) {
    $('chart-horizons').innerHTML = '<p class="empty">Not enough complete windows.</p>';
    return;
  }
  const everyPoint = withPoints.flatMap(a => a.points);
  const xMax = niceCeilLocal(Math.max(...everyPoint.map(p => p.x)));
  const yMax = niceCeilLocal(Math.max(...everyPoint.map(p => p.y)));

  const here = all.find(a => a.hz === horizon);
  if (!here || !here.points.length) {
    $('chart-horizons').innerHTML = '<p class="empty">Not enough complete windows at this horizon.</p>';
    return;
  }

  scatterXY($('chart-horizons'), {
    points: here.points,
    xLabel: 'New logos in the starting month',
    yLabel: 'Forward churn',
    xFormat: v => Math.round(v),
    yFormat: v => fmt.pct(v),
    colour: INK.primary,
    xMax,
    yMax,
    describe: i => '<strong>' + here.points[i].month + '</strong>'
      + '<span>' + fmt.int(here.points[i].x) + ' new logos</span>'
      + '<span>' + fmt.pct(here.points[i].y, 1) + ' churned within ' + horizon + ' month'
      + (horizon === 1 ? '' : 's') + '</span>',
  });

  const sign = v => (v >= 0 ? '+' : '') + v.toFixed(2);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const lift = withPoints.map(a => ({ hz: a.hz, level: mean(a.points.map(p => p.y)) }));
  const clears = withPoints.filter(a => a.significant);
  const first = lift[0];
  const last = lift[lift.length - 1];

  $('horizons-finding').innerHTML =
    `<strong>At ${horizon} month${horizon === 1 ? '' : 's'} the correlation is `
    + `${here.r === null ? 'not measurable' : sign(here.r)} on ${here.points.length} starting `
    + `months${here.significant ? '' : ', which does not clear significance'}.</strong> `
    + `Step through the settings and the cloud lifts without tilting: average churn goes from `
    + `${fmt.pct(first.level, 1)} at ${first.hz} month to ${fmt.pct(last.level, 1)} at `
    + `${last.hz} months, while the correlation runs `
    + `${withPoints.map(a => `${a.hz}mo ${a.r === null ? '--' : sign(a.r)}`).join(', ')}. `
    + (clears.length === 0
      ? `None of them clears zero, so however long churn is given to happen, months with fewer `
        + `arrivals do not churn more.`
      : `${clears.length} of ${withPoints.length} clear${clears.length === 1 ? 's' : ''} zero, at `
        + `${clears.map(a => `${a.hz} month${a.hz === 1 ? '' : 's'}`).join(' and ')}, and `
        // Read off the sign that actually cleared, not assumed: a negative r
        // here would be the theory holding, and the text has to say so.
        + (clears.every(a => a.r > 0)
          ? `it points the wrong way for the theory: the sign there says months with more `
            + `arrivals churn more, not fewer. `
          : clears.every(a => a.r < 0)
            ? `it points the way the theory says: months with fewer arrivals churn more there. `
            : `the horizons that clear disagree on the sign. `)
        + `Six horizons are tested, so one marginal result is about what chance produces`
        + (withPoints.some(a => a.r < 0) && withPoints.some(a => a.r > 0)
          ? `, and the correlation changes sign across the range rather than holding a direction`
          : '')
        + `. The reading stays that no relationship has been measured, but it is one marginal `
        + `result short of clean.`);

  $('horizons-note').textContent =
    `Both axes are fixed across all six settings, computed once from every point at every `
    + `horizon, so the steps are comparable to one another. Rescaling each step would put the `
    + `cloud in the same place every time and hide the one thing the sequence shows, which is `
    + `that churn accumulates roughly equally across the whole range of intake volumes. `
    + `Each point is one starting month: how many customers arrived, against the share of the `
    + `base that had gone by the end of the window. The same ${here.points.length} starting `
    + `months are drawn at every horizon: they are the months a six-month window has fully `
    + `elapsed for, so the longest setting decides the set and a shorter one does not reach `
    + `further forward.`;
}

// niceCeil lives in charts.js and is not exported, so the pinned bounds need
// their own copy. Kept identical on purpose: an axis that rounded differently
// from the one the chart draws would defeat the point of pinning it.
function niceCeilLocal(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

// 22. Arrivals against forward churn, at whatever horizon is chosen.
function renderArrivals() {
  const horizon = Number($('arrival-horizon').value);
  $('arrival-horizon-value').textContent = horizon + (horizon === 1 ? ' month' : ' months');

  const a = arrivalsAgainstChurn(data, { horizon });
  if (!a.points.length) {
    $('chart-new-vs-churn').innerHTML = '<p class="empty">Not enough complete windows.</p>';
    return;
  }

  scatterXY($('chart-new-vs-churn'), {
    points: a.points,
    xLabel: 'New logos in the starting month',
    yLabel: 'Forward churn',
    xFormat: v => Math.round(v),
    yFormat: v => fmt.pct(v),
    colour: INK.primary,
    describe: i => '<strong>' + a.points[i].month + '</strong>'
      + '<span>' + fmt.int(a.points[i].x) + ' new logos</span>'
      + '<span>' + fmt.pct(a.points[i].y, 1) + ' churned within ' + horizon + ' month'
      + (horizon === 1 ? '' : 's') + '</span>'
      + '<span class="muted">' + fmt.int(a.points[i].base) + ' active at the start</span>',
  });

  // Every horizon at once, so the slider shows a shape rather than a number.
  const across = [1, 2, 3, 4, 5, 6]
    .map(hz => ({ hz, ...arrivalsAgainstChurn(data, { horizon: hz }) }))
    .filter(x => x.r !== null);

  const sign = v => (v >= 0 ? '+' : '') + v.toFixed(2);
  const detectable = across.filter(x => x.significant).map(x => x.hz);

  $('arrival-estimate').innerHTML =
    '<strong>' + (a.significant
        ? 'At ' + horizon + ' month' + (horizon === 1 ? '' : 's') + ' there is a measurable effect: '
          + 'ten fewer arrivals goes with ' + Math.abs(a.slope).toFixed(2) + ' points '
          + (a.slope >= 0 ? 'more' : 'less') + ' churn.'
        : 'At ' + horizon + ' month' + (horizon === 1 ? '' : 's') + ' this is indistinguishable from nothing.')
    + '</strong> '
    + 'Estimate ' + (a.slope >= 0 ? '+' : '') + a.slope.toFixed(2) + ' points per ten fewer '
    + 'arrivals, 95% interval ' + a.low.toFixed(2) + ' to ' + a.high.toFixed(2)
    + ', correlation ' + sign(a.r) + ' on ' + a.n + ' months. '
    + (a.significant
        ? 'The interval excludes zero, so something is there at this window.'
        : 'The interval spans zero, so the honest reading is that no effect has been measured.')
    + ' Across every horizon the correlation runs '
    + across.map(x => x.hz + 'mo ' + sign(x.r)).join(', ')
    + (detectable.length
        ? '. Only the ' + detectable.map(h2 => h2 + ' month').join(' and ') + ' window'
          + (detectable.length === 1 ? ' clears' : 's clear') + ' zero'
          + (Math.max(...detectable) <= 2
            ? ', which is the shape of something immediate rather than something lasting: a thin '
              + 'month and a bad month tend to be the same month, and the association does not '
              + 'survive being asked over a longer window.'
            : ', so whatever is there takes months to show rather than arriving at once.')
        : '. None of them clears zero.');

  $('newchurn-note').textContent =
    'Every point is one starting month: how many arrived, against how many of the base then '
    + 'standing were gone ' + horizon + ' month' + (horizon === 1 ? '' : 's') + ' later. '
    + 'The same ' + a.n + ' starting months, ' + a.points[0].month + ' to '
    + a.points[a.points.length - 1].month + ', are used at every setting, so the slider '
    + 'changes the horizon and nothing else. Taking the most recent complete windows at each '
    + 'setting instead would slide the period backwards as the horizon lengthens, and an '
    + 'effect that appeared at one month turned out to be carried by the recent thin months '
    + 'that only the short horizons could reach. No trend line is drawn at any setting, '
    + 'because both series drift and two drifting series correlate whether or not they are '
    + 'related.';
}

boot();
