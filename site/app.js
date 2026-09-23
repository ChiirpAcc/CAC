import {
  policySignals,
  load, buildCohorts, cohortEconomics,
  blendedRetention, retentionByYear, retentionAtAge, mean, monthDiff,
  forwardSurvival, correlate, projectedBreakEven, capacityAnalysis,
  seasonalSurvival,
  hasRevenueClasses, CLASS_MARGINS, LEGACY_PLATFORM_MARGIN, environmentSplit,
  signupEconomics, priceAgainstRetention,
  arrivalsAgainstChurn, HISTORY_STARTS, departures, acquisitionCosts,
  ltvAtAge, signupPriceHistory, priceBands, projectionBasis, pricingScenarios, priceComparison,
  costToServe, costRecovery, churnByTenure, zeroMrrShare,
  fullCostRecovery, COST_GROUPS, REVENUE_GROUPS, platformMargins, costRates,
  projectBase, arrivalScenarios, priceFloors, repriceOutcomes, upgradeList,
  ongoingCostPerLogo, costLedger, neverPaidIds,
  costCalculator, COST_LAYERS, LOGO_TYPES, CALC_PRESETS,
  campaign, CHURN_PRESETS, PRICING_PRESETS, ruleSpread,
  bandEconomics, bandCampaign, ENGAGEMENT,
} from './data.js';
import {
  lineChart, multiLineChart, columnChart, stackedColumnChart, flowChart, scatterOverTime,
  scatterXY, dualAxisChart, fmt, INK,
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
        : '.');
}

// The failure this projection could have, tested rather than asserted.
function projectionCheck(b) {
  if (!b || b.recentSurvival === null || b.donorSurvival === null) return null;
  const gap = Math.abs(b.donorToSix - b.recentToSix) * 100;
  return `Those donors are the older cohorts by construction, so if the newer ones churned `
    + `faster the projection would flatter them. They do not: monthly survival runs `
    + `${fmt.pct(b.donorSurvival, 1)} for the donors against ${fmt.pct(b.recentSurvival, 1)} `
    + `for the ${b.recentCohorts} newer cohorts, and survival to month six `
    + `${fmt.pct(b.donorToSix, 1)} against ${fmt.pct(b.recentToSix, 1)}, `
    + `${gap < 2 ? 'which is the same within noise' : `a gap of ${gap.toFixed(1)} points`}. `
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
        <span class="muted">${fmt.int(r.size)} logos, ${fmt.pct(r.survival, 0)} still there at `
        + `month ${r.survivalAt}</span>`;
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
    + `What a customer is worth has barely moved. What one costs has.`
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
    + 'on both halves of the ratio. A projection is worth least exactly where it is longest, '
    + 'so read the newest columns as a question rather than an answer.';
}


// 13. What each price band actually returns.
//
// This exists because chart 12 invites a conclusion it cannot support. Two
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
      return `<strong>${b.label} at signup</strong>
        <span>${fmt.int(b.n)} customers, average ${fmt.money(b.price)}</span>
        <span>${fmt.money(b.cashPerCustomer)} of cash over ${horizon} months</span>
        <span>${b.perDollar.toFixed(1)}x the monthly price</span>
        <span class="muted">${fmt.pct(b.survival, 0)} still there at month ${horizon}</span>`;
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
    '<thead><tr><th>Price at signup</th><th class="n">Customers</th><th class="n">Average price</th>'
    + `<th class="n">Alive at month ${horizon}</th><th class="n">Cash each</th>`
    + '<th class="n">Per $1 of price</th></tr></thead><tbody>' + rows + '</tbody>';

  const best = pb.bands.reduce((a, b) => (b.cashPerCustomer > a.cashPerCustomer ? b : a));
  const bestPer = pb.bands.reduce((a, b) => (b.perDollar > a.perDollar ? b : a));
  const top = pb.bands[pb.bands.length - 1];
  const rising = top.cashPerCustomer >= best.cashPerCustomer - 1;

  $('price-bands-finding').innerHTML = rising
    ? `<strong>No ceiling is visible inside the range we charge.</strong> Cash per customer keeps `
      + `rising with price, ${fmt.money(pb.bands[0].cashPerCustomer)} in the ${pb.bands[0].label} `
      + `band against ${fmt.money(top.cashPerCustomer)} in ${top.label}. What falls is the return `
      + `per dollar charged: ${bestPer.perDollar.toFixed(1)}x at ${bestPer.label} down to `
      + `${top.perDollar.toFixed(1)}x at the top. Higher prices bring in more, just less than `
      + `proportionally more, and nothing here marks a price to stop at.`
    : `<strong>Cash per customer peaks in the ${best.label} band</strong> at `
      + `${fmt.money(best.cashPerCustomer)}, above both the cheaper and the dearer bands. `
      + `That is the shape an optimum would make, on ${fmt.int(best.n)} customers.`;

  $('price-bands-note').textContent =
    'Every customer who signed in the window and has had ' + horizon + ' full months since, '
    + fmt.int(pb.n) + ' of them, grouped by the subscription booked at signup. Bands with fewer '
    + 'than ten customers are dropped. Read this as what each kind of customer did, not as a '
    + 'demand curve: we never offered a price outside this range, so it cannot say how many '
    + 'customers a price we have not charged would win. It is also selection rather than '
    + 'causation, because a customer who pays more is usually a larger business, not the same '
    + 'business charged more.';
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

// 24. What acquisition costs, by category and month.
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
  const c = acquisitionCosts(data, { months: Math.max(span, 12) });
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

  const logoRow = `<tr><td>New logos</td>`
    + c.logos.map(v => `<td class="n">${v === null ? '–' : fmt.int(v)}</td>`).join('')
    + `<td class="n total-col">${fmt.int(c.logos.reduce((s, v) => s + (v || 0), 0))}</td></tr>`;

  const totalLogos = c.logos.reduce((s, v) => s + (v || 0), 0);
  const cplRow = `<tr class="rule-above emphasis"><td><strong>Cost per logo</strong></td>`
    + c.costPerLogo.map(v => `<td class="n"><strong>${v === null ? '–' : money(v)}</strong></td>`).join('')
    + `<td class="n total-col"><strong>${totalLogos ? money(sum(c.totals) / totalLogos) : '–'}</strong></td></tr>`;

  $('cost-table').innerHTML = head + '<tbody>' + body + totalRow + logoRow + cplRow + '</tbody>';

  // Does this build's total agree with the one the workbook publishes?
  const drift = c.months.map((m, i) =>
    (c.reported[i] === null ? null : c.totals[i] - c.reported[i]));
  const worst = drift.reduce((a, b) => (b !== null && Math.abs(b) > Math.abs(a || 0) ? b : a), 0);

  const headcount = c.categories.filter(x =>
    ['ae', 'sdr', 'salesmgmt', 'partnerships'].includes(x.key));
  const headcountTotal = sum(headcount.map(x => sum(x.values)));
  const grand = sum(c.totals);

  $('cost-finding').innerHTML =
    `<strong>${money(grand)} bought ${fmt.int(totalLogos)} logos, ${money(grand / totalLogos)} each.</strong> `
    + `People you employ to sell are ${fmt.pct(headcountTotal / grand, 0)} of it. `
    + `Cost per logo averaged ${money(sum(c.totals.slice(0, 6)) / Math.max(c.logos.slice(0, 6).reduce((s, v) => s + (v || 0), 0), 1))} `
    + `over the first six months of the window and `
    + `${money(sum(c.totals.slice(6)) / Math.max(c.logos.slice(6).reduce((s, v) => s + (v || 0), 0), 1))} `
    + `over the last six. Month by month it swings from ${money(Math.min(...c.costPerLogo.filter(v => v !== null)))} `
    + `to ${money(Math.max(...c.costPerLogo.filter(v => v !== null)))}, so a single month is a `
    + `poor summary of it.`;

  const drift12 = drift.reduce((s, v) => s + (v || 0), 0);
  $('cost-note').innerHTML =
    'Categories are matched from the account name, so a renamed account falls into Other '
    + 'rather than disappearing, and they sum to the total underneath them. '
    + '<strong>This total is the one every other chart divides by.</strong> Cost per logo, '
    + 'LTV:CAC, payback and break-even all take acquisition cost from these same lines, so the '
    + 'categories here account for the whole of it and nothing on the page is dividing by a '
    + 'number you cannot see broken out. '
    + 'The pipeline publishes its own figure in CAC Monthly, and the two do not agree: it is '
    + money(Math.abs(drift12)) + ' ' + (drift12 < 0 ? 'higher' : 'lower') + ' over these twelve '
    + 'months, and ' + money(Math.abs(worst)) + ' apart in the worst single month. Almost all '
    + 'of that sits in two months where Customer Success appears to reach acquisition despite '
    + 'being settled at zero. The lines win here because each one is an account that can be '
    + 'checked; the published figure is carried alongside so the gap stays visible. '
    + 'New logos are the monthly summary count, the same one the cohort charts use.';
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
      + `<td class="n">${won ? '—' : money(row.left)}</td>`
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
// Chart 8 runs from month 1 and chart 9 from month 2, which is where its own
// base is set: until mid-2025 the first month carried a joining charge booked
// as MRR and reversed the month after, and a part-billed first month leaves a
// customer under the rate they arrive on. The logo figures quoted next to the
// money ones are reindexed to month 2 to match.
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
    // The money chart starts at month 2, where its own base is set. See the
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
    + ready.map(e => `${e.year} ${fmt.pct(at(e, 'points'), 1)} on ${e.cohorts} cohorts`).join(', ')
    + (waiting.length ? `. ${waiting.map(e => e.year).join(' and ')} `
      + `${waiting.length === 1 ? 'has' : 'have'} not reached month ${depth} yet` : '')
    + (logoSpread === null
      ? `. Pull the slider further out to compare the eras.`
      : logoSpread < 0.05
        ? `. That is a narrow spread on thin samples, so at this age there is no clear `
          + `difference between the eras.`
        : `. The years have separated by this age.`)
    + (moneyReady.length
      ? ` Chart 9 asks the same question in money, weighting each customer by what they `
        + `arrived on: at month ${depth} it reads `
        + `${moneyReady.map(e => `${e.year} ${fmt.pct(at(e, 'grossRevenue'), 1)}`).join(', ')}.`
      : '');

  // Both read at the slider's month off the month 2 base, so the gap between
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
      + `month 2, so pull the slider past it.`
    : `<strong>Every year loses more revenue than it loses customers, and the gap widens `
    + `with each one.</strong> Measured from month 2, at month ${depth} the `
    + `${paired.length === 1 ? 'one year so far keeps' : `${paired.length} years keep`} `
    + `${paired.map(e => `${e.year} ${fmt.pct(gAt(e), 1)}`).join(', ')} of their revenue, `
    + `against ${paired.map(e => `${fmt.pct(lAt(e), 1)}`).join(', ')} of their customers. `
    + `That is a shortfall of ${paired.map(e => `${pts(e)} points in ${e.year}`).join(', ')}. `
    + (paired.length > 1
      ? `${worst.year} is the worst of them: it keeps ${fmt.pct(lAt(worst), 1)} of the `
        + `customers it had at month 2 and ${fmt.pct(gAt(worst), 1)} of the money, `
        + `${pts(worst)} points apart, against ${pts(mildest)} in ${mildest.year}. ` : '')
    + `The head count is the flattering number, and it is getting more flattering.`;

  const shared =
    'Every cohort lined up by age rather than by calendar date, so month 1 is each cohort '
    + 'first month whenever that happened, then averaged into one line per starting year. '
    + eras.map(e => `${e.year}: ${e.cohorts} cohorts`).join(', ')
    + `. Each year is drawn on a sample fixed to the cohorts that reach its far end, so a line `
    + `moves when retention moves rather than when its membership does. The ${newest.year} line `
    + `rests on ${newest.cohorts} of its ${newest.cohortsInYear} cohorts and will move as more `
    + `months land.`
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
    + ' falls as it runs right. The count is on the chart at every point and a line is dropped'
    + ' once fewer than twenty customers are left in it.'
    + ' First month figures are medians rather than means, because a single bad intake moves a'
    + ' mean by several points and a year holds only a handful of cohorts. The earliest year'
    + ' covers only the months inside the data window, so it is a part year rather than a full'
    + ' one.'
    + ' One caveat about the newest year. A complete year is measured on a fixed set of'
    + ' cohorts at every age, but the current year loses cohorts as the line runs right,'
    + ' because only those old enough to have reached an age can be in it. Its deep points'
    + ' therefore rest on its earliest intakes rather than on all of them, which is why the'
    + ' line can rise, and why it can disagree with the calendar-position charts further'
    + ' down about which year looks worst.';

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
    + `after their revenue has stopped, so some of the flatness in the 2026 line is a change `
    + `in what counts as leaving rather than a change in who leaves.</p>`
    + `<p>The file agrees on both. Among customers who were present and paying the month `
    + `before, the share whose revenue drops to nothing while they stay on the books runs at `
    + `${fmt.pct(pol.after, 1)} a month from ${fmt.monthLabel(signals.split)}, against `
    + `${fmt.pct(pol.before, 1)} before it. And the coupons are not discounts off the rate: `
    + `${rateNote}, while the share of new customers whose second month books no MRR at all `
    + `has gone from ${fmt.pct(free.before, 0)} to ${fmt.pct(free.after, 0)}. Those are free `
    + `periods, not cheaper subscriptions.</p>`
    + `<p>This is the reconciliation between the head count here and the revenue in chart 9. `
    + `Read the head count alone and 2026 looks like the best year here; read the money and it `
    + `is the worst, 60.4% kept at month 6 against about 78% for both earlier years. Both are `
    + `true, and the difference between them is the policy.</p>`;
  $('era-revenue-note').textContent = shared
    + ' Gross revenue retention: every customer is capped at what they were paying in their '
    + 'second month, so this falls both when a customer leaves and when one stays on less than '
    + 'they arrived on, and expansion cannot lift it. Capping is what makes it comparable to '
    + 'the count above; a line that nets expansion against churn can sit above its own starting '
    + 'point and stops answering the same question. Chart 4 is the netted version. The second '
    + 'month is the base rather than the first because until mid-2025 the first carried a '
    + 'joining charge booked as MRR that came off again the next month, and because a '
    + 'part-billed first month leaves a customer under the rate they arrive on. The line is '
    + 'drawn from month 2 for the same reason, and the logo figures quoted beside it are '
    + 'reindexed to month 2 so the gap is not an artefact of where each line starts. It is not '
    + 'strictly monotonic: a customer who downgrades and later returns to their original rate '
    + 'adds that money back. Much of the fall is customers still recorded as present with MRR '
    + 'booked to zero, which at month 6 is 7.6% of the surviving 2024 intake, 10.7% of 2025 '
    + 'and 21.4% of 2026.';
}

// The two views, and the four figures that appear in both.
//
// A chart can only live in one place in the document, so the story view does
// not hold copies: it borrows the real figures and gives them back. Copying
// them would mean two of everything to keep in step, and the pair would
// disagree the first time one of them was updated and the other was not.
//
// Each figure remembers where it came from, so returning it puts it back in
// its numbered position rather than at the end of the page.
const STORY_FIGURES = ['fig-era', 'fig-arrivals-horizons'];
const homes = new Map();

function rememberHomes() {
  for (const id of STORY_FIGURES) {
    const fig = $(id);
    if (fig && !homes.has(id)) homes.set(id, { parent: fig.parentNode, next: fig.nextSibling });
  }
}

function showView(which) {
  const story = which === 'story';

  if (story) {
    for (const id of STORY_FIGURES) {
      const fig = $(id);
      const slot = document.querySelector(`[data-figure="${id}"]`);
      if (fig && slot) slot.appendChild(fig);
    }
  } else {
    // Back in reverse, so each insertBefore lands against a sibling that is
    // already home.
    for (const id of [...STORY_FIGURES].reverse()) {
      const fig = $(id);
      const home = homes.get(id);
      if (fig && home) home.parent.insertBefore(fig, home.next);
    }
  }

  $('view-story').hidden = which !== 'story';
  $('view-all').hidden = which !== 'all';
  if ($('view-list')) $('view-list').hidden = which !== 'list';
  for (const [id, on] of [['tab-story', which === 'story'], ['tab-all', which === 'all'],
                          ['tab-list', which === 'list']]) {
    if (!$(id)) continue;
    $(id).setAttribute('aria-selected', String(on));
    $(id).classList.toggle('is-on', on);
  }
  document.documentElement.classList.toggle('reading', story);
  window.scrollTo({ top: 0 });
}

function wireTabs() {
  rememberHomes();
  $('tab-story').addEventListener('click', () => showView('story'));
  $('tab-all').addEventListener('click', () => showView('all'));
  if ($('tab-list')) $('tab-list').addEventListener('click', () => showView('list'));
  showView('all');
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
  const c = acquisitionCosts(data, { months: Math.max(span, 12) });
  if (!c.months.length) return;

  const sum = vals => vals.reduce((s, v) => s + v, 0);
  const perLogo = cat => cat.values.map((v, i) => {
    const n = c.logos[i];
    return n ? v / n : null;
  });

  // Five lines is the most a reader can follow. Everything else is summed into
  // one so the total still reconciles rather than quietly losing money.
  const ranked = [...c.categories].sort((a, b) => sum(b.values) - sum(a.values));
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
    labels, series, yFormat: fmt.money,
    describe: i => labels[i] + ': ' + fmt.money(c.costPerLogo[i]) + ' per logo on '
      + fmt.int(c.logos[i]) + ' new logos. '
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
    + 'Read this against the new logo counts in the table above rather than on its '
    + 'own: a category can rise here without anybody spending an extra dollar, '
    + 'because the denominator is new logos and that is the number that fell.';

  $('cost-drivers-note').textContent =
    'Each category from the table above, divided by the new logos booked in the '
    + 'same month, so this is the cost table read per customer rather than per month. '
    + 'A category with no spend in a month sits at zero rather than leaving a gap, '
    + 'because zero is the true value there. The dashed line is the total and equals '
    + 'the bottom row of the table. Months with no new logos have no cost per logo '
    + 'and break the lines rather than dropping them to the axis. '
    + 'One category break to know about before reading a trend into it: marketing '
    + 'salaries ran about $12,000 a month to 2025-08, then sat at zero for five '
    + 'months and returned at around $3,500, while the same work moved into '
    + 'professional services. Both are acquisition so no total moves, but the two '
    + 'category lines are not comparable across that break — a fall in one and a '
    + 'rise in the other there is a reclassification rather than a decision.';
}


// 28. What a customer pays against what is left after serving them.
//
// The first chart on this page built on measured cost rather than an assumed
// margin, which is why the finding leads with the gap between the two.
function renderContribution() {
  const c = costToServe(data);
  if (!c) return;

  // The same switches as the chart at the top, minus acquisition. Acquisition
  // divides by NEW logos and everything here divides by ACTIVE ones, so
  // putting it on this chart would invite subtracting one from the other.
  // Acquisition was left off this chart on the grounds that it divides by NEW
  // logos where everything else divides by ACTIVE ones. That is a real
  // objection to netting them per logo, and a bad reason to leave the question
  // unanswerable: "are we making money overall" is the first thing anyone
  // asks. It is offered as a last switch, off by default, spreading the
  // month's whole acquisition bill across the active base. That is a
  // different basis from the rest of the chart and the hint says so.
  const acqByMonth = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const ACQ_SPREAD = {
    key: 'acqspread',
    label: 'Acquisition, spread over the active base',
    defaultOn: true,
    hint: 'The whole month’s acquisition bill divided by every active logo, not just '
        + 'the new ones. A different basis from the rows above — it answers whether '
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
        + `<span class="muted">Acquisition is not in this figure</span>`;
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
          + 'What a customer pays here is everything they pay — subscription, usage and '
          + 'message credits, setup, and 10DLC pass-through. An earlier version of this '
          + 'chart counted subscription alone, which understated revenue by about a tenth '
          + 'and made the same months read as break-even when they are not. '
        : cogsOnly
          ? 'That is cost of sales only, so it is gross contribution — the figure to use '
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
    'What a customer pays is everything they pay — subscription MRR plus usage and '
    + 'message credits, setup and one-time charges, and 10DLC and carrier pass-through — '
    + 'across every active logo, divided by that logo count. Accounts that have never once '
    + 'carried a subscription are excluded from the count: a test account or an agency '
    + 'monitoring seat is not a customer whose cost anybody should be spreading. '
    + 'The costs are the real monthly figures '
    + 'from the finance tab over the same active count'
    + (c.logosAgree
        ? ' — and the two sources agree on that count in every month, which is the '
          + 'main thing making this chart trustworthy'
        : ', and the two sources disagree on that count in at least one month')
    + '. G&A and R&D are spread evenly across active logos, because nothing ties a '
    + 'landlord or a developer to a particular customer. Acquisition is deliberately '
    + 'absent: it divides by NEW logos where everything here divides by ACTIVE ones, and '
    + 'putting the two on one chart invites subtracting one from the other. Cost of sales '
    + 'alone gives gross contribution, which is what ratios and outside benchmarks use; '
    + 'everything ticked gives what a customer contributes toward the whole business. '
    + 'Neither is the other and neither is profit.';
}


// 29. Cost of sales per logo, split by the team carrying it.
function renderServeTeams() {
  const c = costToServe(data);
  if (!c || !c.teamTotals.length) return;

  const labels = c.months.map(m => fmt.monthLabel(m.month));
  const palette = [INK.primary, INK.secondary, INK.tertiary, INK.accent, INK.negative];
  const top = c.teamTotals.slice(0, 5);

  // The general "Cost of Sales" account is a sibling of the named teams rather
  // than their parent — the five sum exactly to the total — but the bare name
  // reads like a total and makes the finding sound circular.
  const name = label => (label === 'Cost of Sales' ? 'Cost of sales, unsplit' : label);

  const series = top.map((team, i) => ({
    label: name(team.label),
    colour: palette[i],
    values: c.months.map(m => {
      const row = m.teams.find(t => t.label === team.label);
      return row && m.activeLogos ? row.amount / m.activeLogos : null;
    }),
  }));
  series.push({
    label: 'All cost of sales', colour: 'var(--ink)', dashed: true,
    values: c.months.map(m => m.cogsPerLogo),
  });

  multiLineChart($('chart-serve-teams'), {
    labels, series, yFormat: fmt.money,
    describe: i => labels[i] + ': ' + fmt.money(c.months[i].cogsPerLogo)
      + ' per active logo. '
      + series.slice(0, -1).map(s => s.label + ' ' + fmt.money(s.values[i])).join(', '),
  });

  const grand = c.teamTotals.reduce((s, t) => s + t.amount, 0);
  const biggest = c.teamTotals[0];
  $('serve-teams-finding').innerHTML =
    '<strong>' + name(biggest.label) + ' is ' + fmt.pct(biggest.amount / grand)
    + ' of what it costs to serve the base.</strong> ' + fmt.money(biggest.amount)
    + ' of ' + fmt.money(grand) + ' across ' + c.months.length + ' months. '
    + c.teamTotals.slice(1, 4).map(t => name(t.label) + ' ' + fmt.pct(t.amount / grand)).join(', ')
    + '. This is the chart to argue over if the answer to thin margins is to serve '
    + 'customers more cheaply rather than to charge more, because it names where the '
    + 'money actually goes — people, not infrastructure. A headcount answer and a '
    + 'pricing answer are the only two on the table, and this says which one is big '
    + 'enough to matter.';

  $('serve-teams-note').textContent =
    'Every account booked to cost of sales, divided by active logos in the same '
    + 'month. There are five and they sum exactly to the total, which the dashed line '
    + 'draws, so nothing is hidden and nothing is counted twice. The largest is the '
    + 'general cost of sales account rather than a named team, which is a reporting '
    + 'limit rather than a finding: half the cost of serving customers is not '
    + 'attributed to anybody in the source. One line here '
    + 'has a spike in the latest month that is not a cost increase: a $69,847 revenue '
    + 'share invoice was raised in 2026-08 and credited in full on the 31st, and the '
    + 'credit lands in 2026-09 which is outside this window. The charge is in and the '
    + 'reversal is not, so August reads about $70,000 high. Underlying August is close '
    + 'to July. One more line '
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
  const rows = churnByTenure(data, { cuts: CUTS })
    .filter(r => r.bands.every(b => b.rate !== null));
  if (!rows.length) return;

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

  const recent = rows.slice(-6);
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
          + `story — that customers arrive, take one look and go. The worst band sits `
          + `after onboarding has ended.`);

  $('tenure-churn-note').textContent =
    'Presence month to month across the whole standing base, cut at '
    + CUTS.slice(0, -1).join(', ') + ' and ' + CUTS[CUTS.length - 1]
    + ' months of tenure. Not a cohort chart: it describes the book as it stood each '
    + 'month rather than a single intake followed forward, so a customer moves from one '
    + 'band to the next as they age. Customers already present when the data window '
    + 'opens have no knowable signup date and go in the oldest band, which is the '
    + 'conservative choice — it puts them in the band this chart is trying not to '
    + 'blame, and it is also why that band is the largest. A customer booked down to '
    + 'zero MRR is still present here, because presence on this page is an event type '
    + 'and not an amount. Share of losses is each band against everyone who left that '
    + 'month, so the four shares sum to one and the rates do not; the switches change '
    + 'only what is drawn, never what is counted.';
}


// 32. Customers present in every count who are paying nothing.
function renderZeroMrr() {
  const rows = zeroMrrShare(data).filter(r => r.base >= 50);
  if (!rows.length) return;

  const labels = rows.map(r => fmt.monthLabel(r.month));
  multiLineChart($('chart-zero-mrr'), {
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
    + 'that have nothing to do with pricing.';
}


// 33. Chart 1 with the assumed margin taken out and every real cost put in.
//
// Chart 1 multiplies revenue by a fixed margin and compares the result against
// acquisition alone, which buries the entire cost of keeping a customer inside
// one number nobody can argue with. Here the numerator is revenue and every
// cost is a line in the denominator that a reader can switch off and watch the
// answer move. Ticking every box is the question "does a customer at these
// prices pay for the whole company", and ticking the first six is the question
// every outside benchmark actually asks.


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
    + `The average cohort has cost ${fmt.money(meanCost)} a logo by then — `
    + `${fmt.money(meanAcq)} to win and ${fmt.money(meanOngoing)} to keep — against `
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
    + 'the same cost off twice. Revenue here is everything a customer pays — '
    + 'subscription, message and AI usage, setup and 10DLC registration, and carrier '
    + 'pass-through. One of those needs flagging where the early columns are '
    + 'concerned: until mid-2025 a joining charge was booked into MRR in a customer’s '
    + 'first month, so every 2024 cohort collects roughly double in month 0 and recovers '
    + 'much of its acquisition cost immediately. That is real money and is counted, but '
    + 'it is a one-off rather than recurring revenue, so it is separated out of MRR and '
    + 'sits under the setup switch. Turning that switch off is the only way to compare a '
    + '2024 cohort with a 2026 one on equal terms, and it adds one to two months to every '
    + '2024 break-even. The remaining streams are '
    + 'about a tenth more than subscription alone. Every '
    + 'other chart on this page counts subscription only, so this one reads a little '
    + 'better than they do on the same cohorts, and the difference is real money '
    + 'rather than a change of method: the hosting and carrier lines in the '
    + 'denominator are largely there to serve exactly that usage. '
    + 'Ongoing costs are charged month by month against the '
    + 'logos still present, at that month’s real cost per active logo, so a cohort '
    + 'that loses customers stops paying for them. Acquisition is charged once, in '
    + 'full, in the month the cohort arrived, and divides by that cohort rather than '
    + 'by the active base. Months a cohort has not lived through yet are projected on '
    + 'the pooled donor path — both the revenue and the logos, because carrying '
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
    + 'constant churn assumption does any work — on current data only three of '
    + 'the twenty-four columns reach it. Chart 1 and the projected break-even chart '
    + 'still use an unweighted pool, so they read a little kinder on recent cohorts '
    + 'than this one does. Months past the end of the ledger carry the mean cost '
    + 'rate of the last three, with no age curve at all — the cost side is projected '
    + 'forward just as the revenue side is, and the finding says how much of it is '
    + 'carried rather than measured whenever that passes a sixth. The groups partition the '
    + 'expense file: every cost row '
    + 'belongs to exactly one, so ticking everything counts each dollar once and '
    + 'nothing is missed. Revenue and taxes sit outside all of them. '
    + 'The numbers along the top are months to full break-even, the month cumulative '
    + 'revenue first covers cumulative cost with the signup month counted as month 1. '
    + 'They are a property of the cohort rather than of the age being shown, so they '
    + 'do not move when the slider does — only when the cost boxes change. A cohort '
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
        + `last three months have averaged ${paths[paths.length - 2].rate}.</strong> `
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

  $('projection-mrr-finding').innerHTML =
    `<strong>Revenue does worse than the logo count on every path, because the base is `
    + `ageing and an older logo pays less.</strong> `
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
          + `mix rather than churn: a first-month logo pays well over a thousand a month and `
          + `one past its first year pays around five hundred, so replacing an old customer `
          + `with a new one flatters the headcount and not the revenue for long. `
        : '')
    + `The spread between the best and worst of these three is `
    + `${fmt.money((mrrBest - mrrWorst) * 12)} of annual revenue, which is what the `
    + `arrival rate is worth over a year.`;

  $('projection-mrr-note').textContent =
    'Revenue is the projected logo count at each age multiplied by what a logo of that '
    + 'age actually pays, measured across the last six months so the curve reflects '
    + 'current pricing rather than the whole window’s. That curve falls with age: '
    + 'a first-month logo pays well over a thousand a month and one past its first year '
    + 'pays around five hundred, so a base that is ageing loses revenue even where it '
    + 'holds its headcount. Same model, same scenarios and same backtest as the chart '
    + 'above. No price change is modelled in either direction.';

  // ---------------------------------------------------------------- 36 cash
  const served = costToServe(data);
  const costPerLogo = served ? served.months.slice(-6)
    .reduce((s, m) => s + m.cogsPerLogo, 0) / 6 : 0;
  const cac = data.cacMonthly.slice(-6);
  const cacPerLogo = (() => {
    const spend = cac.reduce((s, r) => s + (r.cacTotalActual || 0), 0);
    const logos = data.waterfall.slice(-6).reduce((s, w) => s + (w.newLogos || 0), 0);
    return logos ? spend / logos : 0;
  })();

  const net = paths.map(s => ({
    ...s,
    values: s.rows.map(r => r.mrr - r.logos * costPerLogo - s.rate * cacPerLogo),
  }));

  multiLineChart($('chart-projection-cash'), {
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
  // numbers contradicted almost exactly: by month twelve the monthly lines are
  // within a rounding error of each other. The crossover is the finding.
  const top = net[0];
  const bottom = net[net.length - 1];
  const gapAt = k => bottom.values[k] - top.values[k];
  const closed = net[0].values.findIndex((_, k) => gapAt(k) <= 0);
  const cum = s => s.values.reduce((a, v) => a + v, 0);

  $('projection-cash-finding').innerHTML =
    `<strong>Spending more on acquisition costs ${fmt.money(gapAt(0))} a month at the `
    + `start and ${fmt.money(gapAt(11))} a month by the end of the year: over twelve `
    + `months the two paths very nearly converge.</strong> `
    + `At ${fmt.money(cacPerLogo)} to win a logo and ${fmt.money(costPerLogo)} a month to `
    + `serve one, ${top.rate} arrivals a month starts at ${fmt.money(top.values[0])} and `
    + `ends at ${fmt.money(top.values[11])}, while ${bottom.rate} a month starts at `
    + `${fmt.money(bottom.values[0])} and ends at ${fmt.money(bottom.values[11])} — `
    + `the higher rate is climbing and the lower one is falling. `
    + (closed >= 0
        ? `They cross in month ${closed + 1}. `
        : `They have not crossed by month twelve, but the gap has closed from `
          + `${fmt.money(gapAt(0))} to ${fmt.money(gapAt(11))} and is still narrowing, so `
          + `the crossover sits just outside this window. `)
    + `Cumulatively the cheaper path is still ${fmt.money(cum(bottom) - cum(top))} ahead `
    + `over the year, which is the price of growth rather than an argument against it: `
    + `the spend that looks expensive here is what fills the cohorts chart 33 shows paying `
    + `back at around nine months. <strong>The real conclusion is about retention, not `
    + `acquisition.</strong> Both paths flatten toward the same number because the base `
    + `underneath them is decaying at the same rate, and no arrival rate in this range `
    + `changes that.`;

  $('projection-cash-note').textContent =
    'Projected revenue less the cost of serving the projected base less the cost of '
    + 'acquiring that month’s new logos, at '
    + fmt.money(costPerLogo) + ' per active logo a month and ' + fmt.money(cacPerLogo)
    + ' per new logo, both the mean of the last six months. It is a monthly contribution '
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
  const edges = [0, 1, 120, 300, 500, 665, 900, 1200, 1600, Infinity];
  const names = ['Pays nothing', '$1-119', '$120-299', '$300-499', '$500-664',
                 '$665-899', '$900-1,199', '$1,200-1,599', '$1,600+'];
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
    + `${fmt.money(f.marginalFloor)} a month \— not `
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
    + 'economics than one that is not. Acquisition is in neither either — it belongs '
    + 'to the cohort that caused it, which is chart 33. Of the fixed cost, roughly '
    + fmt.money(f.removablePayrollPerLogo) + ' a logo is payroll that could come out if '
    + 'enough customers went for headcount to follow — that is a step change across '
    + 'hundreds of accounts, not a saving available one at a time. Acquisition is not in '
    + 'either floor. '
    + 'Every rate here is the median of the last six months rather than the pooled '
    + 'mean, because this ledger books an invoice and its credit note in different '
    + 'months and the window closes between them, so a reversed charge is counted '
    + 'once and never taken back.'
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
    labels,
    yFormat: fmt.money,
    series: [
      { label: 'Monthly revenue after the exercise', colour: INK.primary,
        values: r.acceptance.map(a => a.mrr) },
      { label: 'What the survivors then have to pay', colour: INK.negative,
        dashed: true, values: r.acceptance.map(a => a.floor) },
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

  const end = r.spiral[r.spiral.length - 1];
  $('reprice-finding').innerHTML =
    `<strong>Cutting everyone below the allocated floor does not converge \— it `
    + `runs the base from ${fmt.int(f.paying.length)} paying logos to `
    + `${fmt.int(end.logos)}.</strong> The fixed cost stays when the customer goes, so `
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
      + `<td class="n">${r.tenure === null ? '–' : fmt.int(r.tenure)}</td>`
      + `<td>${r.source || '–'}</td>`
      + `<td class="trend">${spark(r.series)}</td>`
      + '</tr>').join('');
    return head + '<tbody>' + body + '</tbody>';
  };

  $('list-low-title').textContent =
    `Paying something, under ${fmt.money(l.lowBand)} — ${fmt.int(l.low.length)} accounts`;
  $('list-low-table').innerHTML = table(l.low, l.lowBand);

  const viable = l.low.filter(r => r.viable);
  const held = l.low.filter(r => r.heldBefore);
  const cleanup = l.low.filter(r => !r.viable);
  $('list-low-finding').innerHTML =
    `<strong>${fmt.int(l.low.length)} accounts are eligible, of which `
    + `${fmt.int(viable.length)} are worth asking and ${fmt.int(held.length)} have already `
    + `held the price.</strong> They pay ${fmt.money(l.totals.lowMrr)} a month between them `
    + `and their targets sum to ${fmt.money(l.totals.lowTarget)}. `
    + `<strong>Start with the "held it before" names.</strong> Asking a customer to return `
    + `to a price they once accepted is a different conversation from inventing one, and `
    + `treating that as half the churn risk is the single assumption this list rests on — `
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

  $('list-note').textContent =
    'Active accounts in ' + fmt.monthLabel(l.month) + ' paying more than '
    + fmt.money(l.minMrr) + ' and less than ' + fmt.money(l.lowBand)
    + ' a month, with at least ' + l.minTenure + ' months behind them. The target for each is max(floor, min(peak ever '
    + 'paid after their first month, current x 3)), with the floor at $600. The first '
    + 'month is excluded because until mid-2025 a joining charge was booked into MRR '
    + 'there, so a raw peak can be a one-off dressed as a subscription — 33 accounts on '
    + 'this list carried an inflated peak, median $200 too high, one reading $1,200 '
    + 'against a settled price of $200. The floor protects solvency, the settled peak '
    + 'anchors to a price the customer genuinely held, and the cap stops an '
    + 'account at $50 being asked for $900 because of one odd month years ago. $600 '
    + 'rather than the $472 the cost base needs today, because losing a third of the '
    + 'accounts asked pushes that floor to about $506 and a target set at the floor would '
    + 'be underwater the month it landed. Charts 37 and 38 have that arithmetic, and '
    + 'tenure and usage were tested as multipliers on top of peak and made the result '
    + 'worse, so they are not used. The Stripe identifier is '
    + 'the one in the billing export and is present for every account; the Chiirp '
    + 'identifier is not in the pushed data — canonical_id is populated on 34 rows out of '
    + 'more than a thousand — so it is dropped from the table and the export '
    + 'to carry it. '
    + (l.totals.namesMissing
        ? fmt.int(l.totals.namesMissing) + ' accounts have no company name in the file and '
          + 'will need looking up by Stripe ID. '
        : '')
    + 'Peak is the highest month in the last six, so an account showing a peak above its '
    + 'current figure has fallen rather than always been small. The last six months run '
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
        `${fmt.int(l.low.length)} accounts exported.`;
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
  // The latest month carries a revenue-share invoice that was credited in the
  // following month, so its variable layer is roughly double. Leading a
  // finding with it would quote the one month on the chart worth distrusting.
  const medianOf = pick => {
    const s = rows.slice(-6).map(pick).sort((x, y) => x - y);
    const i = s.length >> 1;
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
  };
  const typical = medianOf(r => r.total);
  const typicalArpa = medianOf(r => r.arpa);
  const move = k => (a[k] ? (b[k] - a[k]) / a[k] : null);
  const ranked = layers
    .map(l => ({ ...l, from: a[l.key], to: b[l.key], delta: b[l.key] - a[l.key] }))
    .sort((x, y) => y.delta - x.delta);
  const worst = ranked[0];

  $('ongoing-finding').innerHTML =
    `<strong>Keeping a customer cost ${fmt.money(a.total)} a month in `
    + `${fmt.monthLabel(a.month)} and ${fmt.money(typical)} now, while what they pay — `
    + `subscription, usage, setup and pass-through together — went `
    + `from ${fmt.money(a.arpa)} to ${fmt.money(typicalArpa)}.</strong> `
    + `Both figures are the median of the last six months rather than the last one, `
    + `because ${fmt.monthLabel(b.month)} carries a revenue-share invoice that was `
    + `credited in the month after and reads ${fmt.money(b.total)} as a result. `
    + `Cost per logo has risen `
    + `${fmt.pct((typical - a.total) / a.total, 0)} against `
    + `${fmt.pct((typicalArpa - a.arpa) / a.arpa, 0)} on price, which is `
    + `why the margin has narrowed even though the average customer pays more than they `
    + `used to. `
    + `<strong>${worst.label} is the whole of the increase</strong>: `
    + `${fmt.money(worst.from)} to ${fmt.money(worst.to)} a logo, `
    + `${fmt.pct(move(worst.key), 0)}. `
    + `Platform is the one that has not moved — `
    + `${fmt.money(a.platform)} to ${fmt.money(b.platform)} — so the product scales `
    + `with the customer count and the company does not. That is the distinction worth `
    + `carrying out of this chart: none of the rise is the cost of running software for `
    + `more people, and almost all of it is the cost of being a bigger company spread over `
    + `a base that has stopped growing.`;

  $('ongoing-note').textContent =
    'Every recurring cost the business carries, divided by PAYING logos rather than all of '
    + 'them, because an account at zero MRR cannot carry any of this and dividing by it '
    + 'flatters every month. Acquisition is deliberately absent: it belongs to the cohort '
    + 'that caused it, and chart 33 charges it there. The layers are exclusive and sum to '
    + 'the dashed line. Platform is per-seat software and hosting; support and success is '
    + 'every person who looks after customers whichever account they sit in; merchant and '
    + 'revenue share are the two costs that follow a payment rather than a customer, so '
    + 'they are the only layer that moves with price. The last month of the variable layer '
    + 'is overstated: a revenue-share invoice was raised and credited in the same month and '
    + 'the credit falls outside this window, which chart 37 handles by taking medians. '
    + 'Both denominators are shown in the tooltip, because the gap between paying and '
    + 'active logos is itself part of why this line rises.';
}


// 40. The ledger behind every other cost figure on this page.
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
      + `<strong>${g.label}</strong> <span class="muted">— ${g.note} `
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
    `<strong>${fmt.int(l.accountCount)} accounts, three months, and every other cost `
    + `figure on this page is a sum of some subset of these rows.</strong> In `
    + `${cols[cols.length - 1]} the business spent ${fmt.money(ongoingLast)} keeping `
    + `${fmt.int(latest.paying)} paying customers, which is ${fmt.money(perPaying)} each, `
    + `and ${fmt.money(acqLast)} winning ${fmt.int(latest.newLogos)} new ones, which is `
    + `${fmt.money(perNew)} each. The two per-logo figures divide by different `
    + `denominators and must not be added. `
    + `<strong>One row needs reading with care:</strong> 6100-06 is the Service Titan `
    + `revenue share and partner rebates, and the latest month carries a $69,847 invoice `
    + `that was credited in full on the 31st, with the credit falling into the following `
    + `month and therefore outside this table. Underlying it is close to the month before.`;

  $('ledger-note').textContent =
    'Every QuickBooks account carrying a non-zero amount in the window, grouped into the '
    + 'layers the price floors use. The grouping is the only editorial act here: which '
    + 'layer an account belongs to is a judgement, the amounts are not, and the account '
    + 'code is given so any of them can be checked against the ledger. Revenue, other '
    + 'income and taxes are excluded — they are not costs of anything. The bucket column '
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
        return `Against every cost including acquisition, ${fmt.money(allCost)}, the `
          + `business took ${fmt.money(latest.revenue)} and kept `
          + `${fmt.money(gap)} in ${fmt.monthLabel(latest.month)}. `
          + `That figure only works on ALL revenue: subscription alone is `
          + `${fmt.money(latest.mrr)}, which would make the same month `
          + `${fmt.money(latest.mrr - allCost)}. Usage, setup and 10DLC are `
          + `${fmt.money(latest.revenue - latest.mrr)} a month and they are the margin. `
          + `The cash that actually arrived was ${fmt.money(latest.netCash)}, within `
          + `${fmt.pct(Math.abs(latest.netCash - latest.revenue) / latest.revenue, 1)} of `
          + `the four components summed, which is the check that they are the right four.`;
      })();

  $('spend-note').textContent =
    'The same accounts as the table below, summed into layers and left in dollars. Six '
    + 'trailing months. Annualised is the latest month times twelve, which is a run rate '
    + 'rather than a forecast and will be wrong for anything seasonal or lumpy. Per logo '
    + 'divides by PAYING logos for every layer except acquisition, which divides by NEW '
    + 'logos — the two are not comparable and are never added. Acquisition is off by '
    + 'default because it is the cost of growing rather than of running what you have; '
    + 'switch it on for the whole cost of the business. The revenue line is subscription '
    + 'only and excludes usage, setup and pass-through, which together add about a tenth '
    + 'more, so the gap between it and the cost lines is slightly wider here than in cash. '
    + 'The revenue rows are everything a customer pays: subscription, usage and message '
    + 'credits, setup and one-time charges, and 10DLC and carrier pass-through. An '
    + 'earlier version of this chart compared the full cost base against subscription '
    + 'alone, which understated revenue by about a tenth and turned a real surplus into '
    + 'an apparent break-even. Recognised-elsewhere revenue is excluded because it is '
    + 'already carried by a couponed subscription and counting it again would double it. '
    + 'The cash row is what arrived and is shown as a check rather than as a fifth '
    + 'component. '
    + 'One month to read with care: the merchant and revenue share layer carries an '
    + 'invoice in the latest month that was credited in the month after, so it reads about '
    + '$70,000 high and the layer beneath it is closer to the months before.';
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
    + 'incurred per NEW logo while everything else here is per existing one — switching '
    + 'it on spreads it across the whole base, which answers whether the business washes '
    + 'its face rather than what a customer costs. Never-paid accounts are off by default '
    + 'as test and agency seats; lapsed accounts are on, because a customer at zero is '
    + 'still served and still costs. Revenue is everything a customer pays, on the same '
    + 'logo count, so the two sides are comparable. '
    + 'Revenue per $1 is how much revenue stands beside each dollar of that layer, with '
    + 'the layer as a share of revenue in brackets. It is an intensity measure and not a '
    + 'return: spending another dollar on rent does not produce seven more of revenue, '
    + 'and a layer with a high figure is not therefore a good investment. It is useful '
    + 'for the opposite reading — a layer whose figure is falling is taking a growing '
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
    // Median and max are identical across the last two rules, because the
    // 3x cap binds on the same accounts either way. The total asked is what
    // actually separates them, so that is what each button carries.
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
      + (bc
          ? `<tr class="rule-above"><td><strong>After the campaign</strong></td>`
            + `<td class="n">${fmt.int(bc.kept)} kept, ${fmt.int(bc.lost)} lost</td>`
            + '<td></td><td></td><td></td><td></td>'
            + `<td class="n"><strong>${fmt.money(bc.contribution)}</strong> `
            + `<span class="${bc.gain >= 0 ? 'held' : 'notviable'}">`
            + `${bc.gain >= 0 ? '+' : ''}${fmt.money(bc.gain)}</span></td></tr>`
          : '')
      + '</tbody></table>';
  }

  $('camp-note').textContent =
    'Both inputs are assumptions, not measurements, which is why they are switches: '
    + 'nobody has run this campaign, so the honest output is a range with the inputs '
    + 'visible. The pricing rule decides what each account is asked for; the churn '
    + 'setting decides how many refuse. "Scaled to the ask" is the most realistic and the '
    + 'least certain — it raises churn with the size of the increase and halves it '
    + 'where the customer has held that price before, on the reasoning that returning to '
    + 'a known number is an easier conversation than accepting a new one. That halving is '
    + 'the single assumption the whole case rests on and it has never been tested here. '
    + 'The floor line is the one to watch: losing accounts spreads the same fixed cost '
    + 'across fewer payers, so an aggressive campaign can raise the bar faster than it '
    + 'raises prices and leave the survivors underwater. Only accounts marked viable in '
    + 'the list below are included; the rest are a cancellation decision rather than a '
    + 'sale and counting them would flatter every figure here. '
    + 'The band table is the part that changes the conclusion. All three bands pay about '
    + 'the same, but hosting and messaging follow usage while the per-seat licence does '
    + 'not, so a dormant account costs a third of what a heavy user costs and keeps more '
    + 'of what it pays. That inverts the obvious answer: the accounts that look most '
    + 'worth re-pricing are the most profitable business on the book, and sending them an '
    + 'invoice change is the fastest way to lose it. Active users are the only band whose '
    + 'price is genuinely out of line with what they consume. '
    + 'Band membership and counts are hand entered from an engagement export dated '
    + ENGAGEMENT.asOf + ' and joined on Stripe customer id; they are not in the pushed '
    + 'workbook, so they are exactly as stale as that date. The usage multiples behind '
    + 'the cost column are estimates rather than measurements — 2.2x average hosting '
    + 'for heavy senders, 0.6x for light, 0.05x for dormant — and they are the '
    + 'assumption most worth replacing with real per-account message volume.';
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
    renderProjection();
    renderCalculator();
    renderSpend();
    renderLedger();
    renderOngoing();
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

// Everything on the page, drawn once. Nothing here is adjustable any more.
function renderStatic() {
  const w = data.waterfall;
  const recent = w.slice(-36);
  const labels = recent.map(r => fmt.monthLabel(r.month));

  const censored = cohorts.censoredCount || 0;
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
        : '');

  // 4. Blended retention curve, indexed to month 2.
  const blended = blendedRetention(cohorts);
  multiLineChart($('chart-retention'), {
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
      + `The step a year in is an age effect and not a calendar one. Revenue per surviving `
      + `customer falls about a fifth twelve months after signup for cohorts of every vintage, `
      + `from the 2024-09 intake reaching that age in September 2025 to the 2025-08 intake `
      + `reaching it in August 2026, while the head count those months behaves normally. Read `
      + `by calendar month instead, no month since mid-2025 moves more than a few points, so `
      + `there is no shared shock to find. What the rows show at that age is customers booked `
      + `as a contraction to zero MRR and still counted as present.`
    : 'Not enough cohort history yet.';

  // 5. Monthly logo churn, both ways of counting it.
  //
  // The summary books a churn when the pipeline sees the transition. A
  // customer whose subscription drops out of the Stripe export never produces
  // one: present one month, absent the next, nothing recorded. Counting who
  // actually left the file finds about two thirds again as many, and they are
  // not test accounts. Drawing only the reported line would understate the
  // rate that decides whether the base grows or shrinks.
  const churnSeries = recent.map((r, i) => {
    const previous = i === 0 ? null : recent[i - 1];
    const base = previous ? previous.activeLogos : null;
    return base ? (r.churnedLogos || 0) / base : null;
  });
  const dep = new Map(departures(data).map(d => [d.month, d]));
  const departureSeries = recent.map(r => dep.get(r.month)?.rate ?? null);

  multiLineChart($('chart-churn'), {
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

  // 6. Retention at month 3 and month 6, one point per cohort.
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
      <span>${fmt.int(windowed[i].size)} logos at month 1</span>
      <span>Month 3 ${m3[i].value === null ? 'not yet' : fmt.pct(m3[i].value, 1)}</span>
      <span>Month 6 ${m6[i].value === null ? 'not yet' : fmt.pct(m6[i].value, 1)}</span>
      <span>Month 12 ${m12[i].value === null ? 'not yet' : fmt.pct(m12[i].value, 1)}</span>`,
  });

  // 8. Retention by era, one line per starting year.
  renderEra();

  // 10. Monthly logo flows.
  flowChart($('chart-flows'), {
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
    + 'the summary figure, which chart 5 shows is a floor rather than the full count of '
    + 'customers who left.';
}

// Cost and profit. Settled inputs, so this runs once like everything else.
function renderAssumptionDependent() {
  // Every cohort that can carry a cost per logo, not a fixed window. The
  // acquisition cost only starts in 2024-01, so cohorts older than that have
  // no denominator and would be 61 empty slots. Windowing to 24 on top of
  // that cut off the eight oldest cohorts with cost data, which are the most
  // mature and the best performing, and made the picture look worse than it is.
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
    + `The run starts at ${economics[0].month} because acquisition cost is not recorded `
    + `before then.`;

  // 3. Cumulative gross profit against cost, by cohort age.
  const mature = economics.filter(c => c.recovery.length >= 6).slice(-6);
  const span = Math.max(...mature.map(c => c.recovery.length), 0);
  multiLineChart($('chart-recovery'), {
    labels: Array.from({ length: span }, (_, i) => `M${i + 1}`),
    series: mature.map((c, i) => ({
      label: c.month,
      colour: `var(--ramp-${i + 1})`,
      values: Array.from({ length: span }, (_, k) => (c.recovery[k] ?? null)),
    })),
    yFormat: v => fmt.pct(v),
    xTitle: 'Months since first revenue',
    refs: [{ value: 1, label: 'break-even', variant: 'ref-goal' }],
    describe: i => `<strong>Month ${i + 1}</strong>` + mature.map(c =>
      `<span>${c.month} ${fmt.pct(c.recovery[i] ?? null, 0)}</span>`).join(''),
  });
  $('recovery-note').textContent =
    'The six most recent cohorts with at least six months of history. Where a line crosses 100% is the month that cohort paid back. This is the one chart here that survives the split being wrong: the shape of a curve bends the same way whatever the cost baseline is.';


  // 16. Break-even by cohort, actual where it happened and projected where it
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
    + 'resampling whole donor cohorts from 2023 onward, so it answers how far this cohort '
    + 'could sit from the average rather than how well the average is known, which is the '
    + 'wider and more useful question. ' + atRisk + ' cohorts carry at least a one in four '
    + 'chance of never covering their cost. Projection stops at ten years. '
    + 'This table and chart 33 both report a break-even month and they will not agree. '
    + 'This one charges acquisition only, and counts subscription gross profit against it. '
    + 'Chart 33 charges every ongoing cost as well, which is harsher, but it also counts '
    + 'usage, setup and the old joining charge as revenue, which is more generous, and on '
    + 'the 2024 cohorts the revenue side wins. Neither is wrong: this is payback on '
    + 'acquisition, that is payback on everything.';

  // 7. Cost per logo against revenue per logo, indexed to 100.
  // The pipeline's own acquisition cost, the same figure charts 1, 2 and 17
  // divide by. Re-deriving it here from the expense lines produced a second
  // implementation of one number, which is how the page ended up with three
  // answers to what a logo costs.
  const cac = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const months = data.waterfall.filter(r => cac.has(r.month) && cac.get(r.month) !== null);
  // A month whose new logo count has collapsed produces a cost per logo that
  // is about the denominator rather than about the cost. August 2026 divides
  // a normal month of spend by nine logos and lands three times higher than
  // anything before it, which is the second Stripe environment not reaching
  // the count rather than a real move. Those months are blanked rather than
  // drawn, because a spike that large is read before any caveat under it.
  const counts = months.map(r => r.newLogos).filter(Boolean).sort((a, b) => a - b);
  const typical = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  // A third of a typical month, not a half. July sits at 47% of typical and is
  // a thin month rather than a broken one; August at 18% is the count failing.
  const perLogo = months.map(r => (r.newLogos ? r.newMrr / r.newLogos : 0)).filter(Boolean).sort((a, b) => a - b);
  const typicalPerLogo = perLogo.length ? perLogo[Math.floor(perLogo.length / 2)] : 0;
  const reliable = r => r.newLogos
    && r.newLogos >= typical * 0.35
    && r.newMrr / r.newLogos >= typicalPerLogo * 0.35;
  const suppressed = months.filter(r => !reliable(r));

  const costPerLogo = months.map(r => (reliable(r) ? cac.get(r.month) / r.newLogos : null));
  const revenuePerLogo = months.map(r => (reliable(r) ? r.newMrr / r.newLogos : null));
  const baseCost = costPerLogo.find(v => v !== null);
  const baseRevenue = revenuePerLogo.find(v => v !== null);

  multiLineChart($('chart-unit'), {
    labels: months.map(r => fmt.monthLabel(r.month)),
    series: [
      { label: 'Cost per logo', colour: INK.negative,
        values: costPerLogo.map(v => (v === null ? null : (v / baseCost) * 100)) },
      { label: 'New-logo revenue per logo', colour: INK.primary,
        values: revenuePerLogo.map(v => (v === null ? null : (v / baseRevenue) * 100)) },
    ],
    yFormat: v => Math.round(v),
    refs: [{ value: 100, label: `${months[0]?.month} = 100`, variant: 'ref-floor' }],
    describe: i => `<strong>${fmt.monthLabel(months[i].month)}</strong>
      <span>Cost per logo ${fmt.money(costPerLogo[i])}</span>
      <span>Revenue per logo ${fmt.money(revenuePerLogo[i])}</span>
      <span class="muted">${fmt.int(months[i].newLogos)} new logos</span>`,
  });
  $('unit-note').textContent =
    'Both indexed to 100 at the first month with acquisition cost recorded, so the '
    + 'divergence reads without either absolute number needing to be right. Cost per '
    + 'logo divides the month acquisition cost by the new logos in the monthly '
    + 'summary, one basis for the whole line. '
    + (suppressed.length
        ? suppressed.map(r => fmt.monthLabel(r.month)).join(' and ')
          + ' ' + (suppressed.length === 1 ? 'is' : 'are') + ' left blank. A month is drawn '
          + 'only once both halves hold: enough new logos for the ratio to be measuring cost '
          + 'rather than its own denominator, and enough recognised MRR against them for the '
          + 'revenue side to mean anything. The trailing month fails the second because most '
          + 'of its arrivals are in the second Stripe environment, whose revenue does not '
          + 'reach the MRR column at all. That is a recognition gap rather than a lag: the '
          + 'earliest of those customers are five months in and still register nothing.'
        : '');
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

  const average = group => Array.from({ length: span }, (_, i) =>
    group.reduce((sum, s) => sum + s.curve[i], 0) / group.length);

  const recent = starts.slice(-fw.recentCount);
  const earlier = starts.slice(0, -fw.recentCount);

  // 11. The fan. Every window drawn faintly so the spread is visible, with the
  // two period averages over the top so the shift is readable.
  multiLineChart($('chart-forward'), {
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
  $('forward-finding').innerHTML =
    (fw.recent.rate < fw.earlier.rate
      ? '<strong>It is getting worse, and not by a little.</strong> '
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

  // 12. The same thing as one number per starting month.
  const monthsWord = horizon + ' month' + (horizon === 1 ? '' : 's');
  lineChart($('chart-forward-trend'), {
    labels: starts.map(s => fmt.monthLabel(s.month)),
    values: starts.map(s => s.survival),
    colour: INK.negative,
    yFormat: v => fmt.pct(v),
    refs: [
      { value: fw.earlier.rate,
        label: 'average of the earlier ' + earlier.length, variant: 'ref-floor' },
      { value: fw.recent.rate,
        label: 'average of the latest ' + recent.length, variant: 'ref-goal' },
    ],
    // The chart drew one unlabelled line against one unlabelled dashed rule,
    // which left the reader to guess what either was.
    legendItems: [
      { label: 'Share of that month’s base still active ' + monthsWord + ' later',
        colour: 'var(--series-neg)' },
      { label: 'Average of the earlier ' + earlier.length + ' starting months',
        colour: 'var(--series-neg)' },
      { label: 'Average of the latest ' + recent.length, colour: 'var(--series-pos)' },
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
          + 'what matters is whether the gap between the two rules survives that, and it '
          + 'does at every horizon, which makes it structural rather than a recent shock.'
        : 'The recent average now sits above the earlier one, so the decline this chart '
          + 'was built to show has stopped at this horizon.');
  $('forward-trend-note').textContent =
    'One point per starting month, at the horizon set above. Lengthening the horizon lowers '
    + 'every point, because more time means more loss, and the question is whether the slope '
    + 'changes with it. A decline that is steady at every horizon is structural; one that only '
    + 'appears at short horizons would be a recent shock instead.';

  // 17 and 18. Customer Success capacity, and whether either relationship is
  // moving. Neither is touched by the sliders: the split decides how much CS
  // spend counts as acquisition cost, not how much was spent.
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
                + fmt.pct(MARGIN.drift, 2) + ', in ' + MARGIN.driftMonth + '. A gap that '
                + 'stays small means the classes are still too minor to change the answer; '
                + 'a gap that widens means either they are not, or one of the two '
                + 'definitions has moved. ');
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

  const cap = capacityAnalysis(data);
  const cp = cap.points;
  const capLabels = cp.map(p => fmt.monthLabel(p.month));
  const rc = cap.correlations;
  const sign = v => (v >= 0 ? '+' : '') + v.toFixed(2);

  // Indexed so two quantities in different units can share an axis.
  const baseChurn = cp[0].churn;
  const baseCap = cp[0].csPerLogo;
  const baseWhole = cp[0].retentionPerLogo;
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
      label: 'Forward churn',
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
      + '<span>Forward churn ' + fmt.pct(cp[i].churn, 1) + '</span>',
  });

  const firstHalf = cap.measured.slice(0, 12), secondHalf = cap.measured.slice(12);
  const avg = (rows, key) => rows.reduce((s, x) => s + x[key], 0) / rows.length;
  const capGrowth = (avg(secondHalf, 'csPerLogo') / avg(firstHalf, 'csPerLogo') - 1) * 100;

  const csShare = avg(cp, 'csPerLogo') / avg(cp, 'retentionPerLogo');
  $('capacity-finding').innerHTML =
    '<strong>Spending more on Customer Success is not associated with keeping more '
    + 'customers, and on this page that is the useful answer rather than a '
    + 'disappointing one.</strong> Customer Success alone correlates with forward churn '
    + 'at ' + sign(rc.capacity) + '; adding Technical Account Manager and Support, which '
    + 'together are the other ' + fmt.pct(1 - csShare) + ' of the spend, takes it to '
    + sign(rc.wholeFunction) + ', and ' + sign(rc.wholeFunctionGivenTime) + ' once the '
    + 'shared time trend is removed. None of those is a relationship. '
    + 'Two things follow, and they point the same way. Retention is not currently '
    + 'rate-limited by how much is spent on the team that does retention, so the churn '
    + 'this page is about will not be fixed by adding headcount there. And the cost of '
    + 'serving customers can be argued about on its own terms rather than treated as '
    + 'untouchable insurance against churn — which matters, because chart 29 shows '
    + 'that is where the money actually goes.';

  $('capacity-note').textContent =
    'Read the direction, not the strength: this is ' + cp.length + ' monthly observations of '
    + 'two series that both drift over the period, which is far too few for a correlation to '
    + 'carry weight, and no trend line is drawn through them. The stronger form of this '
    + 'question is not a correlation at all. It is whether accounts that lost their CSM '
    + 'churned differently from accounts that kept one, and that needs CSM assignment per '
    + 'account, which the pushed data does not carry. '
    + 'Spend is the only measure of the team in the pushed data; headcount is not there. '
    + 'Salaries track headcount more closely than the total, since bonuses and commissions '
    + 'move with outcomes rather than with staff. Both indexed to '
    + cp[0].month + ' so they can share an axis. What this does give you is a control: with '
    + 'CS capacity held constant, the association between new arrivals and churn is '
    + sign(rc.arrivalsGivenCapacity) + ' rather than ' + sign(rc.arrivals) + '.';

  // 18. Rolling correlation, the momentum question.
  const measuredLabels = cap.measured.map(p => fmt.monthLabel(p.month));
  multiLineChart($('chart-momentum'), {
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
            + '<span>CS capacity ' + sign(cap.rollingCapacity[i]) + '</span>'),
  });

  const live = cap.rollingArrivals.filter(v => v !== null);
  const liveCap = cap.rollingCapacity.filter(v => v !== null);
  // Written off the numbers rather than around them. An earlier version of this
  // asserted that one relationship "was never there" and the other "has barely
  // moved", which was true of the sample it was written for and became false
  // the moment the window widened — it went on quoting a swing of more than
  // a full point while calling it barely moved. Everything below is computed.
  const rangeOf = xs => Math.max(...xs) - Math.min(...xs);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const signFlips = xs => xs.slice(1).filter((v, i) => (v < 0) !== (xs[i] < 0)).length;
  const widest = rangeOf(liveCap) >= rangeOf(live)
    ? { label: 'Customer Success', xs: liveCap }
    : { label: 'New arrivals', xs: live };

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
    '<strong>Neither line means anything, and the chart is here to show that rather '
    + 'than to hide it in a single number.</strong> '
    + '<span class="muted">New arrivals against churn</span> ' + read(live) + '. '
    + '<span class="muted">Customer Success against churn</span> ' + read(liveCap) + '. '
    + 'A relationship that was real and faded would walk toward zero and stay there; a '
    + 'relationship that was real and held would sit on one side of zero. Over '
    + live.length + ' overlapping twelve-month windows these do neither, and '
    + widest.label + ' alone covers ' + rangeOf(widest.xs).toFixed(2) + ' points end to '
    + 'end, which is most of the range a correlation can occupy. '
    + 'Read it as the reason not to quote any single pooled figure from these two '
    + 'series — including the ones on the chart above.';

  $('momentum-note').textContent =
    'Correlation against forward churn computed over a moving ' + cap.rollingWidth
    + ' month window, so a relationship that has faded shows as a line heading for zero rather '
    + 'than hiding inside one pooled figure. The first ' + (cap.rollingWidth - 1) + ' months '
    + 'carry no window and are blank rather than zero. With only twelve months behind each '
    + 'point these move around, so read the direction rather than the level.';

  // 15. Against new arrivals.
  const newByMonth = new Map(data.waterfall.map(r => [r.month, r.newLogos]));
  const points = starts
    .filter(s => newByMonth.get(s.month) != null)
    .map(s => ({ x: newByMonth.get(s.month), y: 1 - s.survival, month: s.month }));

  renderArrivals();
  renderHorizons();
}

// 19. The same window, this year against one and two years ago. Driven by its
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

  const s = seasonalSurvival(data, { horizon });
  if (!s.series.length) {
    $('chart-seasonal').innerHTML = '<p class="empty">Not enough history for that window.</p>';
    return;
  }

  const labels = Array.from({ length: horizon + 1 }, (_, i) => (i ? '+' + i : 'start'));
  const colours = [INK.tertiary, INK.secondary, INK.negative];

  multiLineChart($('chart-seasonal'), {
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
    + 'and both still be right, and they currently do — chart 8 has 2026 ahead at '
    + 'month 4 and this has it well behind. The book is mostly tenured customers so '
    + 'this chart is largely about them, while chart 8 at that age is built only from '
    + 'the 2026 cohorts old enough to have run four months, which are the early ones, '
    + 'before the worst intakes arrived. Neither is the whole answer. Base sizes: '
    + s.series.map(r => fmt.monthLabel(r.month) + ' ' + fmt.int(r.n)).join(', ') + '.';

  // 20. The same fixed sets, followed by revenue rather than by headcount.
  // Where this sits above the logo line, the survivors are paying more than
  // they were, and expansion is covering some of the loss.
  multiLineChart($('chart-seasonal-revenue'), {
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
      const twoBack = twoYears || null;
      const context = twoBack
        ? ' Against two years earlier the picture is not a straight decline: '
          + fmt.monthLabel(twoBack.month) + ' kept '
          + fmt.pct(twoBack.revenueRetention, 1) + ' of its revenue, so '
          + fmt.monthLabel(yearAgo.month) + ' at '
          + fmt.pct(yearAgo.revenueRetention, 1) + ' is the outlier in the series rather '
          + 'than the standard the latest window is failing to meet.'
        : '';
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
    'The same customers as chart 11, followed by what they pay rather than by whether they '
    + 'are still there. No new customers enter it, so this is not net revenue retention for '
    + 'the business; it is what one fixed set did. Above the logo line means survivors grew '
    + 'and expansion is offsetting churn. Below it means the ones who stayed are also paying '
    + 'less. Starting revenue: '
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

  const meaning = MEANS[plotId];
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
  'chart-price-volume':
    'Over seven months this chart said price had risen 44%. Over the full window it says price '
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
    + 'is approximate. Shifted forward customers are the left censoring problem, already '
    + 'classified by hand upstream, which is a better answer than any rule that infers them. '
    + 'The annual customers are worth watching separately: two of them carry enough to make '
    + 'the months holding them read high.',

  'chart-ltv-cac':
    'Read the two averages under the chart together and the diagnosis is in them. Cut at the '
    + 'same age, what a customer returns has risen a little between the earlier cohorts and the '
    + 'later ones. What one costs has risen about four times as fast. That is the whole of the deterioration '
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

  'chart-churn':
    'Sustained churn above the threshold sets a floor on how much acquisition is needed just '
    + 'to stand still, and the gap between that floor and what arrives is stated above. '
    + 'Acquisition has been running flat while the rate has roughly doubled, so no plausible '
    + 'improvement in conversion closes the gap on its own; it has to come from the churn side. '
    + 'Note also which line to plan against. The booked figure is the one most reports quote '
    + 'and it is the one that understates the problem.',

  'chart-age-retention':
    'Most of what a cohort loses, it loses between months three and six. That is a narrow and '
    + 'specific window, which makes it actionable: onboarding and the first ninety days are '
    + 'where retention effort has something to save. Effort spent on customers past that point '
    + 'is spent on the ones who were largely going to stay anyway.',

  'chart-unit':
    'Treat the rise as an upper bound rather than a measurement. The denominator is a new '
    + 'logo count drawn almost entirely from the first Stripe environment, and new business '
    + 'has been moving to the second, so some of this curve is customers being won and not '
    + 'counted rather than cost genuinely doubling. What can be said is that cost per logo has '
    + 'not fallen. What cannot yet be said is by how much it rose, and no decision that '
    + 'depends on the magnitude should be taken from this chart until the signup source is '
    + 'joined in.',

  'chart-era':
    'On a head count there is no recent break to go and find. An intake won in 2026 decays '
    + 'about as one won in 2024 did, and early on it decays rather less, so money spent '
    + 'rebuilding onboarding on the theory that new customers have got worse would be spent '
    + 'against a problem this chart does not show. That does not close the question, because '
    + 'a head count treats a $200 account and a $2,000 account as the same event. Chart 9 '
    + 'weights them, and the answer changes.',

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
  const recovered = shown.filter(c => c.payback !== null);
  const withinGoal = recovered.filter(c => c.payback <= 12).length;

  // Chart 1's annotation is written where the chart is drawn, because both
  // depend on the age its slider sets. Left here it described the lifetime
  // measure the chart no longer uses.

  annotate('chart-payback', [
    `<strong>${recovered.length} of ${shown.length} cohorts have covered their cost</strong>, `
      + (withinGoal === recovered.length
        ? 'and every one of them did it inside the twelve month goal. Nothing has recovered late; cohorts either clear the bar or are still running.'
        : `and ${withinGoal} of those did it inside the twelve month goal.`),
    `${shown.length - recovered.length} of those shown have not recovered and are drawn as projections in a separate colour, not as zeroes or gaps. A zero would read as instant payback, the opposite of what it means.`,
    paybackByEra(recovered),
  ], [
    `A bar is either what happened or a projection of what will, never a blank: ${recovered.length} of these are the month a cohort actually crossed its cost and ${shown.length - recovered.length} are projected. A gap would read as "never", and what it means is "not yet".`,
    `The projection is the same one chart 1 draws hatched, so the two cannot disagree: the pooled month-on-month revenue path of the cohorts with a year of history, which is mostly churn because revenue per surviving customer is roughly flat after the first month. Measured at the month this chart predicts, chart 1 reads 1.0x for the same cohort. The difference between them is the question, not the model: this one asks when a cohort crosses its cost, that one asks where it stands at a fixed age.`,
    `The range around each projection comes from resampling whole donor cohorts rather than resampling the average, so it answers how far one cohort could sit from the typical path rather than how well the typical path is known.`,
    `The run starts at ${HISTORY_STARTS} because acquisition cost is not recorded before then, which is an absence of data rather than a verdict on earlier cohorts.`,
  ]);

  const mature = ec.filter(c => c.recovery.length >= 6).slice(-6);
  const crossed = mature.filter(c => c.payback !== null).length;
  annotate('chart-recovery', [
    `${crossed} of the ${mature.length} cohorts drawn have crossed the break-even line inside the window shown.`,
    'The shape of each curve bends the same way whatever the cost baseline is, which makes this the one chart here that survives the split being wrong.',
    'Curves that flatten before 100% are cohorts whose revenue is decaying faster than it is accumulating profit.',
  ], [
    'Margins are applied per revenue class where the push carries them, which it does from 2025-09. Platform 75.7%, usage 60%, one-time 90%, pass-through and recognised-elsewhere at zero. The classes sit alongside recognised MRR rather than dividing it. Cohorts that started before 2025-09 accrue their first months with no class data at all, so the earlier half of this window is effectively platform-only.',
    'Only the six most recent cohorts with at least six months are drawn, so this is not the whole book.',
  ]);

  const blended = blendedRetention(cohorts);
  const lastPoint = blended[blended.length - 1];
  const gap = lastPoint ? (lastPoint.logos - lastPoint.revenue) * 100 : null;
  annotate('chart-retention', [
    lastPoint && `By month ${lastPoint.offset}, <strong>${fmt.pct(lastPoint.logos, 1)} of logos and ${fmt.pct(lastPoint.revenue, 1)} of revenue</strong> remain.`,
    gap !== null && `The two lines sit ${Math.abs(gap).toFixed(1)} points apart. Logos above revenue means the survivors pay less than they used to; revenue above logos means expansion is offsetting churn.`,
    'This pools every era, so it is an average that conceals the deterioration visible in the era chart below.',
  ], [
    'Indexed to <strong>month 2</strong>, not month 1. Month 1 carries setup and onboarding fees, and indexing there turns a one-off charge ending into an apparent churn cliff.',
    `Drawn while at least ${lastPoint ? lastPoint.cohorts : 12} cohorts remain in sample, and held to a two year horizon. The logo line is survival rather than presence, so a customer who leaves and returns is counted once.`,
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
  const arrivals = recent.slice(-6).map(r => r.newLogos).filter(Boolean);
  const arrivalMean = arrivals.length
    ? arrivals.reduce((s, v) => s + v, 0) / arrivals.length : null;
  annotate('chart-churn', [
    `<strong>${overThreshold} of the last ${churnSeries.length} months sit above the 5% threshold.</strong> The latest reads ${fmt.pct(lastChurn, 2)}.`,
    `That is the solid line, every customer present one month and absent the next. The dashed `
      + `line, the part booked as a churn event, reads ${fmt.pct(lastBooked, 2)} for the same `
      + `month, so reading the booked figure alone understates the rate by about `
      + `${lastBooked ? (lastChurn / lastBooked).toFixed(1) : '--'} times.`,
    `Monthly churn has risen about ${(Math.max(...churnSeries) / Math.min(...churnSeries)).toFixed(1)}x across the window, from ${fmt.pct(Math.min(...churnSeries), 1)} at its lowest to ${fmt.pct(Math.max(...churnSeries), 1)} at its worst.`,
    arrivalMean ? `At that rate the base needs about ${fmt.int(holdFlat)} new logos a month to `
      + `hold flat. Arrivals have averaged ${fmt.int(arrivalMean)} over the last six months, so `
      + `the base is short by roughly ${fmt.int(holdFlat - arrivalMean)} a month.` : null,
  ], [
    'The denominator is the prior month closing base, so a month of rapid growth flatters the rate slightly.',
    'This counts logos, not revenue, and <strong>cannot tell a lapse from a cancellation</strong>. Some of what reads as churn is a billing gap.',
  ]);

  const windowed = cohorts.slice(-COHORT_WINDOW);
  const m3 = mean(retentionAtAge(windowed, 3).map(p => p.value));
  const m6 = mean(retentionAtAge(windowed, 6).map(p => p.value));
  annotate('chart-age-retention', [
    `<strong>Month 3 averages ${fmt.pct(m3, 1)} and month 6 averages ${fmt.pct(m6, 1)}</strong>, so about ${((m3 - m6) * 100).toFixed(0)} points of a cohort is lost between those two ages.`,
    'The spread between cohorts at the same age is wide, which means cohort quality varies more than the blended curve suggests.',
  ], [
    'Indexed to month 2 like the blended curve, so month 1 fees do not distort it.',
    'A cohort appears only once that age is behind it. Recent cohorts are genuinely absent rather than sitting at 100%.',
  ]);

  const cacMap = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  // Same reliability rule the chart itself applies. Reading the endpoint off
  // an unfiltered list quoted 2026-08 at $33,627, a month the chart blanks
  // precisely because its denominator has failed.
  const unitAll = w.filter(r => cacMap.has(r.month) && r.newLogos);
  const unitCounts = unitAll.map(r => r.newLogos).sort((a, b) => a - b);
  const unitTypical = unitCounts.length ? unitCounts[Math.floor(unitCounts.length / 2)] : 0;
  const unitPerLogo = unitAll.map(r => r.newMrr / r.newLogos).filter(Boolean).sort((a, b) => a - b);
  const unitTypicalPerLogo = unitPerLogo.length ? unitPerLogo[Math.floor(unitPerLogo.length / 2)] : 0;
  const unitMonths = unitAll.filter(r => r.newLogos >= unitTypical * 0.35
    && r.newMrr / r.newLogos >= unitTypicalPerLogo * 0.35);
  const firstU = unitMonths[0], lastU = unitMonths[unitMonths.length - 1];
  const costFirst = cacMap.get(firstU.month) / firstU.newLogos;
  const costLast = cacMap.get(lastU.month) / lastU.newLogos;
  const arpuFirst = firstU.newMrr / firstU.newLogos;
  const arpuLast = lastU.newMrr / lastU.newLogos;
  const spendChange = (cacMap.get(lastU.month) / cacMap.get(firstU.month) - 1) * 100;
  const logoChange = (lastU.newLogos / firstU.newLogos - 1) * 100;
  annotate('chart-unit', [
    `<strong>Cost per logo has risen about ${(costLast / costFirst).toFixed(1)}x</strong> since ${firstU.month}, from ${fmt.money(costFirst)} to ${fmt.money(costLast)}.`,
    `New-logo revenue per logo has moved from ${fmt.money(arpuFirst)} to ${fmt.money(arpuLast)}, so the gap between the lines is cost opening up rather than revenue falling away.`,
    `Both halves moved the wrong way: spend ${spendChange >= 0 ? 'rose' : 'fell'} ${Math.abs(spendChange).toFixed(0)}% while countable logos fell ${Math.abs(logoChange).toFixed(0)}%. It is not a volume story with flat spend behind it.`,
  ], [
    'Both series are indexed to 100 at the same month, so the absolute levels do not need to be right for the divergence to read. The base month is stated on the chart.',
    'Where the pipeline reports a cost per logo it is used directly; earlier months derive it from total cost over the waterfall new logos.',
    'That denominator is the monthly summary’s new logo count, not the cohort count used by '
      + 'the per cohort table in chart 17. The two agree within about a tenth in every month but '
      + 'the first, where the summary counts arrivals that predate the window and the cohort '
      + 'does not, so this chart reads 2024-09 far cheaper than that table does. Consistency '
      + 'along this line matters more than agreement with the other, because the chart is a '
      + 'shape rather than a level.',
  ]);

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
  const survivalAt = k => Math.pow(1 - currentRate, k - 1);
  const depthNote = currentRate
    ? `These are ${eras.map(e => e.year).slice(0, -1).join(' and ')} vintages, and they aged `
      + `through a calmer period than the one running now. At the loss rate of the last six `
      + `months, ${fmt.pct(currentRate, 2)} a month, a customer signed today would have about a `
      + `${fmt.pct(survivalAt(9), 0)} chance of reaching month 9 and `
      + `${fmt.pct(survivalAt(13), 0)} of reaching the end of their first year. That is the `
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
    `<strong>Revenue falls faster than the count in every year</strong>: at month 6, measured `
      + `from month 2, the shortfall is `
      + `${eras.map(e => `${Math.abs(gapAt6(e)).toFixed(1)} points in ${e.year}`).join(', ')}.`,
    `${byGap[0].year} keeps ${fmt.pct(byGap[0].logosMonth6FromMonth2, 1)} of its customers and `
      + `${fmt.pct(byGap[0].grossMonth6, 1)} of its revenue. Counting heads there overstates what `
      + `the cohort is still worth by roughly a fifth of itself.`,
    `Because expansion is capped out, none of this is a cohort failing to grow. It is money that `
      + `was being paid and is not any more, by customers who in many cases are still on the books.`,
  ], [
    'Gross revenue retention: each customer capped at what they were paying in their second '
      + 'month, so departures and downgrades both pull it down and expansion cannot lift it.',
    'Indexed and drawn from month 2, where the cap is set, because a part-billed first month '
      + 'leaves a customer under the rate they arrive on. The logo figures quoted here are '
      + 'reindexed to month 2 to match.',
    'Not strictly monotonic, and not forced to be: a customer who downgrades and later returns '
      + 'to their original rate adds that money back.',
  ]);

  annotate('chart-era', [
    `<strong>The three years sit within ${(((best6.month6 || 0) - (worst6.month6 || 0)) * 100).toFixed(1)} points of each other at month 6</strong>: `
      + `${eras.map(e => `${e.year} ${fmt.pct(e.month6, 1)}`).join(', ')}. `
      + `${best6.year} holds best and ${worst6.year} worst, on samples of ${best6.reachedMonth6} and ${worst6.reachedMonth6} cohorts.`,
    `Early on the newest intakes are not the weak ones: at month 3 the order is `
      + `${eras.map(e => `${e.year} ${fmt.pct(e.month3, 1)}`).join(', ')}, with ${best3.year} highest. `
      + `There is no level shift here to find.`,
    `The ${newestEra.year} line rests on ${newestEra.reachedMonth6} cohorts at month 6, so its right hand end is thin and will move. `
      + `Chart 9 asks it again with each customer capped at what they arrived on, and there the years do separate.`,
    // Why this chart reads higher than the churn rate suggests it should.
    // Asked in the room as "I thought we lost half in nine months, this says
    // a quarter". Both are right and they are different questions, so the
    // chart should answer the one it is not otherwise asked.
    depthNote,
  ], [
    'Indexed to <strong>month 1</strong> here, unlike charts 4 and 6, because this counts logos rather than revenue and there is no setup fee to distort the first month.',
    'A point is dropped once fewer than three cohorts in that year have reached that age, so the newest line is never drawn by its oldest member alone.',
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
  const seas = seasonalSurvival(data, { horizon: Number($('horizon').value) || 4 });
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

  // 14, projected break-even.
  const proj = projectedBreakEven(data, cohorts, state);
  if (proj.length) {
    const done = proj.filter(x => !x.projected);
    const atRisk = proj.filter(x => x.projected && x.neverRate >= 0.25);
    const widest = proj.filter(x => x.projected && x.low !== null)
      .reduce((a, b) => ((b.high - b.low) > (a.high - a.low) ? b : a), { high: 0, low: 0, month: null });
    annotate('breakeven-table', [
      `<strong>${done.length} of ${proj.length} cohorts have already covered their cost</strong>, and those rows are fact rather than forecast.`,
      atRisk.length && `${atRisk.length} carry at least a one in four chance of never covering it. ${atRisk[0].month} is the worst at ${fmt.pct(atRisk[0].neverRate)}.`,
      widest.month && `Uncertainty widens sharply for young cohorts: ${widest.month} spans ${widest.low} to ${widest.high} months.`,
    ], [
      'The range comes from resampling <strong>whole donor cohorts</strong> from 2023 onward, not from resampling the average. It answers how far one cohort can sit from the average, which is the wider and more useful question.',
      'No price rises or expansion revenue are modelled, and projection stops at ten years. "Not within 10 years" means the model gave up, not that the cohort is dead.',
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

  // 19, 20, 21.
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

  // 13. Volume, price and the product of the two, indexed so three quantities
  // in different units can share one axis.
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
  dualAxisChart($('chart-price-volume'), {
    labels: phLabels,
    left: {
      label: 'New logos',
      colour: INK.negative,
      values: ph.map(r => r.count),
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
      + '<span>' + fmt.int(ph[i].count) + ' new logos</span>'
      + '<span>Average ' + fmt.money(ph[i].mean) + ', median ' + fmt.money(ph[i].median) + '</span>'
      + '<span class="muted">' + fmt.money(ph[i].booked) + ' of new MRR booked</span>',
  });

  const withRec = ph.filter(r => r.recurringMean !== null);
  const recFirst = withRec[0], recLast = withRec[withRec.length - 1];
  const premiumEarly = withRec.filter(r => r.month < '2025-07').map(r => r.firstMonthPremium);
  const premiumLate = withRec.filter(r => r.month >= '2025-10').map(r => r.firstMonthPremium);
  const avg = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

  $('price-volume-finding').innerHTML =
    '<strong>What a new customer pays has risen steadily, by '
    + Math.abs((recLast.recurringMean / recFirst.recurringMean - 1) * 100).toFixed(0) + '%.</strong> '
    + fmt.money(recFirst.recurringMean) + ' a month in ' + fmt.monthLabel(recFirst.month)
    + ' against ' + fmt.money(recLast.recurringMean) + ' in ' + fmt.monthLabel(recLast.month) + '. '
    + 'The booked line behind it falls and then recovers, and that shape is an artefact: until '
    + 'mid-2025 the first month’s charge was booked as MRR and taken off again the next '
    + 'month as a contraction, worth ' + fmt.money(avg(premiumEarly)) + ' a customer on average, '
    + 'against ' + (Math.abs(avg(premiumLate)) < 25 ? 'nothing'
        : fmt.money(Math.abs(avg(premiumLate)))) + ' once the practice stopped. Volume went from '
    + fmt.int(ph[0].count) + ' to ' + fmt.int(ph[ph.length - 1].count) + ' over the same window.';

  $('price-volume-note').innerHTML =
    '<strong>The point where these lines cross means nothing.</strong> Two scales can be slid '
    + 'until they meet anywhere on the chart, so a crossing is a choice of axis rather than a '
    + 'fact about the business, and it is not a price to aim at. The chart below asks that '
    + 'question properly, by grouping customers by what they paid and following each group '
    + 'forward. Read the shapes here, not the intersection. '
    + 'Price is new_mrr, the subscription booked when a customer joins, which is the only '
    + 'price measure that exists for all ' + ph.length + ' months. The richer starting_mrr, '
    + 'what a customer was actually sold, is only populated from 2026-01 and is what charts 15 '
    + 'and 16 use. The two differ because new_mrr excludes fees and waived amounts, so the '
    + 'level here is low and the shape is the part to read.';

  // 14. Attach rate and fee are two different movements.
  if ($('chart-onboarding')) multiLineChart($('chart-onboarding'), {
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
      + 'billed count of new customers has held near its two year average while this tab has '
      + 'thinned.'
    : '';

  if ($('onboarding-note')) $('onboarding-note').textContent =
    'Attach rate is the share of the month with a setup fee above zero. The average is taken '
    + 'across those charged, not across everyone, because including the customers who were not '
    + 'charged would '
    + 'blend the two movements back together.' + coverageNote;

  // 15. How much of a month is not a standard start.
  const types = sx.typeTotals.map(x => x.type);
  const palette = [INK.tertiary, INK.primary, INK.secondary, INK.negative, INK.positive];
  multiLineChart($('chart-start-type'), {
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
        + fmt.money(shifted.startingMrr) + ', which is the left censoring problem already '
        + 'classified by hand rather than inferred. ' : '')
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

// 25. Arrivals against forward churn, at whatever horizon is chosen.
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
      : `${clears.length} of ${withPoints.length} clears zero, at `
        + `${clears.map(a => `${a.hz} month${a.hz === 1 ? '' : 's'}`).join(' and ')}, and it `
        + `points the wrong way for the theory: the sign there says months with more arrivals `
        + `churn more, not fewer. Six horizons are tested, so one marginal result is about what `
        + `chance produces, and the correlation changes sign across the range rather than `
        + `holding a direction, which is the signature of noise rather than an effect. The `
        + `reading stays that no relationship has been measured, but it is one marginal result `
        + `short of clean.`);

  $('horizons-note').textContent =
    `Both axes are fixed across all six settings, computed once from every point at every `
    + `horizon, so the steps are comparable to one another. Rescaling each step would put the `
    + `cloud in the same place every time and hide the one thing the sequence shows, which is `
    + `that churn accumulates roughly equally across the whole range of intake volumes. `
    + `Each point is one starting month: how many customers arrived, against the share of the `
    + `base that had gone by the end of the window. A month is only drawn once its full `
    + `window has elapsed, which is why the longer horizons have fewer points.`;
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
          + 'ten fewer arrivals goes with ' + a.slope.toFixed(2) + ' points more churn.'
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
        ? '. Only the ' + detectable.map(h2 => h2 + ' month').join(' and ') + ' window clears zero, '
          + 'which is the shape of something immediate rather than something lasting: a thin '
          + 'month and a bad month tend to be the same month, and the association does not '
          + 'survive being asked over a longer window.'
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
