import {
  policySignals,
  load, buildCohorts, cohortEconomics,
  blendedRetention, retentionByYear, retentionAtAge, mean, monthDiff,
  forwardSurvival, correlate, projectedBreakEven, capacityAnalysis,
  seasonalSurvival,
  hasRevenueClasses, CLASS_MARGINS, environmentSplit,
  signupEconomics, priceAgainstRetention,
  arrivalsAgainstChurn, HISTORY_STARTS, departures, acquisitionCosts,
  ltvAtAge, signupPriceHistory, priceBands, projectionBasis, pricingScenarios, priceComparison,
} from './data.js';
import {
  lineChart, multiLineChart, columnChart, stackedColumnChart, flowChart, scatterOverTime,
  scatterXY, dualAxisChart, fmt, INK,
} from './charts.js';

// Settled, and applied in the pipeline rather than here. Kept as named
// constants so a different decision stays a one line change: the controls are
// gone, the flexibility is not.
const SETTLED = { csShare: 0, partnershipsShare: 1, margin: 0.757 };

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

  const rows = ltvAtAge(data, cohorts, { age, margin: state.margin });
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
  const c = acquisitionCosts(data, { months: 12 });
  if (!c.months.length) {
    $('cost-table').innerHTML = '<tbody><tr><td>No acquisition spend in the window.</td></tr></tbody>';
    return;
  }

  const money = v => (v ? '$' + Math.round(v).toLocaleString() : '–');
  const head = '<thead><tr><th>Category</th>'
    + c.months.map(m => `<th class="n">${fmt.monthLabel(m)}</th>`).join('')
    + '<th class="n total-col">12 months</th></tr></thead>';

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
  const labels = Array.from({ length: MAX_AGE }, (_, i) => `M${i + 1}`);

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
  const depth = here ? here.mi + 1 : MAX_AGE;
  if ($('era-depth-value')) {
    $('era-depth-value').textContent = here
      ? `${here.year}, month ${here.mi + 1} (${position} of ${steps.length})` : '--';
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
      describe: i => `<strong>Month ${i + 1 + from}</strong>` + eras.map(era => {
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
    const v = era[key] ? era[key][depth - 1] : null;
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
  const biased = eras.filter(e => e.cohortsUndrawn > 0
    && e.month1LossUndrawn !== null && e.month1LossDrawn !== null
    && e.month1LossUndrawn - e.month1LossDrawn > 0.03);
  const firstMonthLine = eras
    .filter(e => e.month1LossAll !== null)
    .map(e => `${e.year} ${fmt.pct(e.month1LossAll, 1)}`).join(', ');

  $('era-finding').innerHTML += biased.length
    ? ` <strong>Read the left hand end of the ${biased.map(e => e.year).join(' and ')} `
      + `${biased.length === 1 ? 'line' : 'lines'} with care.</strong> A year is drawn on the `
      + `cohorts old enough to reach the far end, which for an unfinished year means its oldest `
      + `ones, and in ${biased[0].year} those are the only `
      + `${biased[0].cohortsWithFirstMonth - biased[0].cohortsUndrawn} with no first month `
      + `departures at all. The ${biased[0].cohortsUndrawn} left out lose `
      + `${fmt.pct(biased[0].month1LossUndrawn, 1)} in month 1. Counting every cohort of each `
      + `year, first month loss runs ${firstMonthLine}, so on that measure the newest intakes `
      + `are the worst rather than the best, and chart 23 is the one to believe about whether `
      + `customers leave in their first month.`
    : ` Counting every cohort of each year, first month loss runs ${firstMonthLine}.`;

  $('era-note').textContent = shared
    + ' Indexed to month 1, where nothing distorts the count.'
    + ' The fixed sample keeps a line from moving when its membership moves, which is what it'
    + ' is for, but in a part-finished year it also selects that year’s oldest cohorts.'
    + ' The first month figures quoted in the finding are taken across every cohort of each'
    + ' year instead, drawn or not, and are the ones to compare between years.';

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
const STORY_FIGURES = ['fig-era', 'fig-arrivals-months',
  'fig-arrivals-horizons'];
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

  $('view-story').hidden = !story;
  $('view-all').hidden = story;
  for (const [id, on] of [['tab-story', story], ['tab-all', !story]]) {
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
  showView('all');
}

function boot() {
  load().then(loaded => {
    data = loaded;
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
    wireTabs();
    $('horizon').addEventListener('input', renderSeasonal);
    $('ltv-age').addEventListener('input', renderLtvAtAge);
    if ($('era-depth')) $('era-depth').addEventListener('input', renderEra);
    $('forward-horizon').addEventListener('input', renderForward);
    $('band-horizon').addEventListener('input', renderPriceBands);
    if ($('pricing-elasticity')) $('pricing-elasticity').addEventListener('input', () => renderPricing(data));
    $('arrival-horizon').addEventListener('input', renderArrivals);
    if ($('horizons-step')) $('horizons-step').addEventListener('input', renderHorizons);
    renderAssumptionDependent();
  }).catch(err => {
    $('loading').innerHTML =
      `<p class="empty">Could not load the data: ${err.message}. ` +
      `The workbook may not have pushed yet.</p>`;
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
    + `Months ${data.historyStarts} to ${data.lastMonth}, a rolling two year window.`
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
    ? `Indexed to month 2, because month 1 carries setup and onboarding fees and indexing there `
      + `turns a one-off charge ending into an apparent cliff. The logo line is survival, so a `
      + `customer who leaves and returns is not counted twice and the line can only fall. Held to `
      + `a 24 month horizon and drawn while at least ${blended[blended.length - 1].cohorts} `
      + `cohorts remain in sample, which carries it to month ${blended[blended.length - 1].offset}, `
      + `on one sample throughout rather than a different one at every age. `
      + `The step at the right hand end is an age effect and not a calendar one. Revenue per `
      + `surviving customer falls about a fifth in the thirteenth month for cohorts of every `
      + `vintage, from the 2024-09 intake reaching that age in September 2025 to the 2025-08 `
      + `intake reaching it in August 2026, while the head count those months behaves `
      + `normally. Read by calendar month instead, no month since mid-2025 moves more than a `
      + `few points, so there is no shared shock to find. What the rows show at that age is `
      + `customers booked as a contraction to zero MRR and still counted as present.`
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
  $('churn-note').innerHTML =
    'Not two versions of the data, one measure and the part of it that gets recorded. The solid '
    + 'line is every customer present one month and absent the next. The dashed line is how many '
    + 'of those the push booked as a churn. Over the last ' + depRecent.length + ' months it books '
    + fmt.int(sumRep) + ' departures and the file loses ' + fmt.int(sumLeft) + ', '
    + (sumRep ? ((sumLeft / sumRep - 1) * 100).toFixed(0) : '0') + '% more. The difference is '
    + 'customers whose subscription drops out of the Stripe export without generating a churn '
    + 'event. They are not test accounts: in 2026 there are 182 of them, 179 carried cash in '
    + 'their last six months, and the subscription export itself marks 156 as churned with an '
    + 'end date. Read the solid line as the rate and the dashed one as a floor.';

  // 6. Retention at month 3 and month 6, one point per cohort.
  const windowed = cohorts.slice(-COHORT_WINDOW);
  const m3 = retentionAtAge(windowed, 2);
  const m6 = retentionAtAge(windowed, 5);
  const m12 = retentionAtAge(windowed, 11);

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
    + 'chance of never covering their cost. Projection stops at ten years.';

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
  const horizon = Number($('forward-horizon').value) || 4;
  $('forward-horizon-value').textContent = horizon + (horizon === 1 ? ' month' : ' months');
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

  const fw = forwardSurvival(data, { horizon, windows: 24 });
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
    '<strong>It is getting worse, and not by a little.</strong> ' + horizon + '-month survival ran at '
    + fmt.pct(fw.earlier.rate, 1) + ' across ' + earlier.length + ' earlier windows and '
    + fmt.pct(fw.recent.rate, 1) + ' across the last ' + recent.length + ', a fall of '
    + Math.abs((fw.recent.rate - fw.earlier.rate) * 100).toFixed(1) + ' points on '
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
  lineChart($('chart-forward-trend'), {
    labels: starts.map(s => fmt.monthLabel(s.month)),
    values: starts.map(s => s.survival),
    colour: INK.negative,
    yFormat: v => fmt.pct(v),
    refs: [{ value: fw.earlier.rate, label: 'earlier average', variant: 'ref-floor' }],
    describe: i => '<strong>' + starts[i].month + ' start</strong>'
      + '<span>' + fmt.pct(starts[i].survival, 1) + ' still active four months on</span>'
      + '<span class="muted">' + fmt.int(starts[i].n) + ' active at the start</span>',
  });
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
  const trailing = data.waterfall[data.waterfall.length - 1].month;
  const newest = data.customers.filter(r => r.month === trailing && r.eventType === 'new');
  const newestS2 = newest.filter(r => r.source === 'S2');
  const hasClasses = hasRevenueClasses(data);
  $('margin-statement').innerHTML = hasClasses
    ? '<strong>Margins are applied per revenue class.</strong> Platform '
      + fmt.pct(CLASS_MARGINS.platform, 1) + ', usage ' + fmt.pct(CLASS_MARGINS.usage)
      + ', one-time ' + fmt.pct(CLASS_MARGINS.oneTime) + ', and pass-through and '
      + 'recognised-elsewhere at zero. Pass-through is carrier fees, which sit in revenue and '
      + 'in cost of sales at once, so any margin on them would credit profit that does not '
      + 'exist. Recognised-elsewhere is a buyout or prepayment already carried by a couponed '
      + 'subscription, so counting it again would double count. The classes sit alongside '
      + 'recognised MRR rather than dividing it: eop_mrr tracks platform recurring revenue in '
      + 'the ledger, and usage, one-time and pass-through are billed on top of it. Each is '
      + 'therefore margined in its own right and none is subtracted from the platform base. '
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
          + ' customers have arrived in it since ' + S2_FIRST + ', all of them paying, and '
          + fmt.int(s2WithMrr.size) + ' register MRR. In ' + fmt.monthLabel(trailing)
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
    '<strong>Measured across the whole retention function the relationship is much weaker '
    + 'than Customer Success alone suggests.</strong> Customer Success correlates with '
    + 'forward churn at ' + sign(rc.capacity) + '; adding Technical Account Manager and '
    + 'Support, which together are the other ' + fmt.pct(1 - csShare) + ' of the spend, takes '
    + 'it to ' + sign(rc.wholeFunction) + ', and ' + sign(rc.wholeFunctionGivenTime)
    + ' with time held constant. The three teams have not moved together, so a measure of one '
    + 'of them was reading its own trend as the department\'s. Nothing here separates capacity '
    + 'driving churn, which would be perverse, from churn driving hiring, which is what '
    + 'usually happens.';

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
  $('momentum-finding').innerHTML =
    '<strong>One was never there; the other has not moved.</strong> The link between new '
    + 'arrivals and churn ran at ' + sign(live[0]) + ' over the earliest twelve month window and '
    + sign(live[live.length - 1]) + ' over the latest, weak at both ends rather than a '
    + 'relationship that faded. Customer Success has barely moved, ' + sign(liveCap[0]) + ' to '
    + sign(liveCap[liveCap.length - 1]) + ', and is the stronger of the two throughout. On '
    + live.length + ' overlapping windows neither movement is worth reading as a trend, which '
    + 'is also why chart 22 finds nothing pooled.';

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
    + 'rather than averaged away. Base sizes: '
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
    : '<strong>No, the trade is not better. Revenue fell further than headcount.</strong> '
      + fmt.pct(latest.revenueRetention, 1) + ' of ' + fmt.monthLabel(latest.month)
      + ' revenue survived ' + horizon + ' months, against '
      + fmt.pct(yearAgo.revenueRetention, 1) + ' a year earlier, a drop of '
      + Math.abs(revGap).toFixed(1) + ' points where logos fell '
      + Math.abs((latest.survival - yearAgo.survival) * 100).toFixed(1) + '. '
      + 'Expansion by the survivors covered ' + yearAgoCushion.toFixed(1)
      + ' points of the loss a year ago and only ' + latestCushion.toFixed(1) + ' now.';

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
    `Drawn while at least ${lastPoint ? lastPoint.cohorts : 12} cohorts remain in sample, and held to a 24 month horizon. The logo line is survival rather than presence, so a customer who leaves and returns is counted once.`,
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
  const m3 = mean(retentionAtAge(windowed, 2).map(p => p.value));
  const m6 = mean(retentionAtAge(windowed, 5).map(p => p.value));
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

    annotate('chart-onboarding', [
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
    for (const id of ['chart-price-volume', 'chart-onboarding', 'chart-start-type']) {
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
  multiLineChart($('chart-onboarding'), {
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
  $('onboarding-finding').innerHTML =
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

  $('onboarding-note').textContent =
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
    + `None of them clears zero, so however long churn is given to happen, months with fewer `
    + `arrivals do not churn more.`;

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
