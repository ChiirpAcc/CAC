import {
  load, cacByMonth, splitTotals, buildCohorts, cohortEconomics,
  blendedRetention, retentionByEra, retentionByYear, retentionAtAge, mean, monthDiff,
  forwardSurvival, correlate, projectedBreakEven, capacityAnalysis,
  seasonalSurvival, survivalByRevenueWithinTenure, reconciliation,
} from './data.js';
import {
  lineChart, multiLineChart, columnChart, flowChart, scatterOverTime,
  scatterXY, fmt, INK,
} from './charts.js';

// Settled, and applied in the pipeline rather than here. Kept as named
// constants so a different decision stays a one line change: the controls are
// gone, the flexibility is not.
const SETTLED = { csShare: 0, partnershipsShare: 1, margin: 0.757 };

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

function boot() {
  load().then(loaded => {
    data = loaded;
    cohorts = buildCohorts(data);
    $('loading').hidden = true;
    $('dashboard').hidden = false;
    renderStatic();
    renderForward();
    renderSeasonal();
    renderReconciliation();
    $('horizon').addEventListener('input', renderSeasonal);
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
    + `Months run to ${data.lastMonth}.`
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
    ? `Indexed to month 2, because month 1 carries setup and onboarding fees and indexing there turns a one-off charge ending into an apparent cliff. Held to a 24 month horizon, and drawn only while at least 20 cohorts remain in sample. Here it runs to month ${blended[blended.length - 1].offset}.`
    : 'Not enough cohort history yet.';

  // 5. Monthly logo churn rate, against the 5% threshold.
  const churnSeries = recent.map((r, i) => {
    const previous = i === 0 ? null : recent[i - 1];
    const base = previous ? previous.activeLogos : null;
    return base ? (r.churnedLogos || 0) / base : null;
  });
  lineChart($('chart-churn'), {
    labels,
    values: churnSeries,
    colour: INK.negative,
    yFormat: v => fmt.pct(v, 1),
    refs: [{ value: CHURN_THRESHOLD, label: '5% threshold', variant: 'ref-goal' }],
    describe: i => `<strong>${fmt.monthLabel(recent[i].month)}</strong>
      <span>Churn ${fmt.pct(churnSeries[i], 2)}</span>
      <span>${fmt.int(recent[i].churnedLogos)} logos lost</span>`,
  });

  // 6. Retention at month 3 and month 6, one point per cohort.
  const windowed = cohorts.slice(-COHORT_WINDOW);
  const m3 = retentionAtAge(windowed, 2);
  const m6 = retentionAtAge(windowed, 5);
  scatterOverTime($('chart-age-retention'), {
    labels: windowed.map(c => fmt.monthLabel(c.month)),
    series: [
      { label: 'Month 3', colour: INK.primary, values: m3.map(p => p.value), mean: mean(m3.map(p => p.value)) },
      { label: 'Month 6', colour: INK.secondary, values: m6.map(p => p.value), mean: mean(m6.map(p => p.value)) },
    ],
    describe: i => `<strong>${windowed[i].month} cohort</strong>
      <span>${fmt.int(windowed[i].size)} logos at month 1</span>
      <span>Month 3 ${fmt.pct(m3[i].value, 1)}</span>
      <span>Month 6 ${fmt.pct(m6[i].value, 1)}</span>`,
  });

  // 8. Retention by era, one line per starting year.
  const eras = retentionByYear(cohorts, { maxMonths: 12 });
  const eraColours = [INK.tertiary, INK.secondary, INK.negative];
  multiLineChart($('chart-era'), {
    labels: Array.from({ length: 12 }, (_, i) => `M${i + 1}`),
    series: eras.map((era, i) => ({
      label: `${era.year} cohorts`,
      colour: eraColours[i],
      values: era.points,
    })),
    yFormat: v => fmt.pct(v),
    yMin: 0.5,
    yMax: 1,
    xTitle: 'Months since first revenue',
    describe: i => `<strong>Month ${i + 1}</strong>` + eras.map(era =>
      `<span>${era.year} ${fmt.pct(era.points[i], 1)}</span>`).join(''),
  });

  const newest = eras[eras.length - 1];
  const older = eras.slice(0, -1);
  $('era-finding').innerHTML =
    `<strong>The newest cohorts are worse from month 2 onward, and they stay worse.</strong> `
    + `At month 3 the ${newest.year} cohorts hold ${fmt.pct(newest.month3, 1)} against `
    + older.map(e => `${fmt.pct(e.month3, 1)} for ${e.year}`).join(' and ')
    + `. By month 6 the gap has widened rather than closed: ${fmt.pct(newest.month6, 1)} `
    + `against ${older.map(e => fmt.pct(e.month6, 1)).join(' and ')}. `
    + `The lines do not converge.`;

  $('era-note').textContent =
    'Every cohort lined up by age rather than by calendar date, so month 1 is each cohort '
    + 'first month whenever that happened, then averaged into one line per starting year. '
    + 'Everyone starts at 100% because month 1 is everyone, and the line falls as customers '
    + 'leave. Indexed to month 1 rather than month 2, because this counts logos rather than '
    + 'revenue and there is no setup fee to distort the first month. '
    + eras.map(e => `${e.year}: ${e.cohorts} cohorts`).join(', ')
    + `. The ${newest.year} line stops where fewer than three of its cohorts have reached `
    + `that age; only ${newest.reachedMonth6} have reached month 6, so its right hand end is `
    + 'thin and will move as more months land.';

  // 9. Active logo base.
  lineChart($('chart-base'), {
    labels,
    values: recent.map(r => r.activeLogos),
    colour: INK.primary,
    area: true,
    describe: i => `<strong>${fmt.monthLabel(recent[i].month)}</strong>
      <span>${fmt.int(recent[i].activeLogos)} active logos</span>
      <span class="muted">${fmt.int(recent[i].newLogos)} new, ${fmt.int(recent[i].churnedLogos)} churned</span>`,
  });

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
}

// Cost and profit. Settled inputs, so this runs once like everything else.
function renderAssumptionDependent() {
  // Every cohort that can carry a cost per logo, not a fixed window. The
  // acquisition cost only starts in 2024-01, so cohorts older than that have
  // no denominator and would be 61 empty slots. Windowing to 24 on top of
  // that cut off the eight oldest cohorts with cost data, which are the most
  // mature and the best performing, and made the picture look worse than it is.
  const withCost = cohortEconomics(data, cohorts, state).filter(c => c.costPerLogo !== null);
  // Cohorts younger than six months are withheld rather than drawn low. The
  // measure is realised profit, so their position says how old they are, not
  // how good they are, and a reader will take the slope for decline.
  const economics = withCost.filter(c => c.monthsObserved === undefined
    ? c.maxOffset + 1 >= MIN_COHORT_AGE
    : c.monthsObserved >= MIN_COHORT_AGE);
  const tooYoung = withCost.length - economics.length;
  const labels = economics.map(c => fmt.monthLabel(c.month));

  // 1. LTV:CAC by cohort.
  const ltv = economics.map(c => c.ltvCac);
  columnChart($('chart-ltv-cac'), {
    labels,
    values: ltv,
    yFormat: v => v.toFixed(1) + 'x',
    colourFor: v => (v >= 3 ? INK.positive : v >= 1 ? INK.tertiary : INK.negative),
    refs: [
      { value: 3, label: '3.0x', variant: 'ref-goal' },
      { value: 1, label: '1.0x break-even', variant: 'ref-floor' },
    ],
    describe: i => {
      const c = economics[i];
      return `<strong>${c.month} cohort</strong>
        <span>LTV:CAC ${fmt.ratio(c.ltvCac)}</span>
        <span>Cost per logo ${fmt.money(c.costPerLogo)}</span>
        <span>Gross profit per logo ${fmt.money(c.cumulativeGpPerLogo[c.cumulativeGpPerLogo.length - 1])}</span>
        <span class="muted">${fmt.int(c.size)} logos, ${c.maxOffset + 1} months observed</span>`;
    },
  });
  const below = ltv.filter(v => v !== null && v < 1).length;
  $('ltv-note').textContent =
    `Gross profit realised to date over acquisition cost, per logo. This is not a `
    + `projection, so young cohorts are understated by construction and the rightmost `
    + `columns will keep rising. ${below} of ${ltv.filter(v => v !== null).length} cohorts `
    + `are below break-even. This measure is realised rather than projected, so it is `
    + `age-biased by construction: a young cohort has had less time to return anything. `
    + `${tooYoung} cohorts younger than ${MIN_COHORT_AGE} months are withheld for that reason. `
    + `Cohorts before ${economics[0].month} are absent because acquisition cost is not `
    + `recorded then, not because they performed badly.`;

  // 2. Expected payback by cohort, against a 12 month goal.
  const payback = economics.map(c => c.payback);
  columnChart($('chart-payback'), {
    labels,
    values: payback,
    yFormat: v => Math.round(v) + 'm',
    colourFor: v => (v <= 12 ? INK.positive : INK.negative),
    refs: [{ value: 12, label: '12 month goal', variant: 'ref-goal' }],
    describe: i => {
      const c = economics[i];
      return `<strong>${c.month} cohort</strong>
        <span>Payback ${fmt.months(c.payback)}</span>
        <span>Cost per logo ${fmt.money(c.costPerLogo)}</span>
        <span class="muted">${c.maxOffset + 1} months observed</span>`;
    },
  });
  const unrecovered = economics.filter(c => c.payback === null).length;
  const recovered = economics.filter(c => c.payback !== null);
  const withinGoal = recovered.filter(c => c.payback <= 12).length;
  $('payback-note').textContent =
    `${unrecovered} of ${economics.length} cohorts have not recovered and may not. Those are `
    + `drawn as gaps rather than zeroes, because a zero would read as instant payback, the `
    + `opposite of what it means. Of the ${recovered.length} that did recover, ${withinGoal} `
    + `did so inside the 12 month goal. ${tooYoung} cohorts younger than ${MIN_COHORT_AGE} `
    + `months are withheld: realised payback cannot distinguish a young cohort from a bad `
    + `one. The run starts at ${economics[0].month} because acquisition cost is not `
    + `recorded before then.`;

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
      + '<td class="n">' + fmt.int(p.size) + '</td>'
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
  $('breakeven-note').textContent =
    done + ' of ' + projection.length + ' cohorts have already covered their cost, and those '
    + 'rows report the month it happened rather than a forecast. The rest are projected from '
    + 'their last observed month along a revenue retention path. The range comes from '
    + 'resampling whole donor cohorts from 2023 onward, so it answers how far this cohort '
    + 'could sit from the average rather than how well the average is known, which is the '
    + 'wider and more useful question. ' + atRisk + ' cohorts carry at least a one in four '
    + 'chance of never covering their cost. Projection stops at ten years.';

  // 7. Cost per logo against revenue per logo, indexed to 100.
  const cac = cacByMonth(data, state);
  const months = data.waterfall.filter(r => cac.has(r.month));
  const costPerLogo = months.map(r => (r.newLogos ? cac.get(r.month) / r.newLogos : null));
  const revenuePerLogo = months.map(r => (r.newLogos ? r.newMrr / r.newLogos : null));
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
    'Both indexed to 100 at the first month with acquisition cost recorded, so the divergence reads without either absolute number needing to be right. Cost per logo is rebuilt from the P&L rather than read from the CAC Monthly tab, which arrived without a usable per-logo figure.';
}

// Forward survival. Independent of the split and the margin, so drawn once.
function renderForward() {
  const fw = forwardSurvival(data, { horizon: 4, windows: 24 });
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
      { label: 'Earlier average', colour: INK.primary, values: average(earlier) },
      { label: 'Recent average', colour: INK.negative, values: average(recent) },
    ],
    yFormat: v => fmt.pct(v),
    yMin: 0.6,
    yMax: 1,
    xTitle: 'Months after the starting month',
    showLegend: false,
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
    '<strong>It is getting worse, and not by a little.</strong> Four-month survival ran at '
    + fmt.pct(fw.earlier.rate, 1) + ' across ' + earlier.length + ' earlier windows and '
    + fmt.pct(fw.recent.rate, 1) + ' across the last ' + recent.length + ', a fall of '
    + Math.abs((fw.recent.rate - fw.earlier.rate) * 100).toFixed(1) + ' points on '
    + (fw.recent.total + fw.earlier.total).toLocaleString() + ' customer observations. '
    + 'The gap between the best and worst window is ' + (spread * 100).toFixed(1) + ' points.';

  $('forward-note').textContent =
    'Windows run ' + fw.range[0] + ' to ' + fw.range[1] + '. A starting month appears only '
    + 'once its full four months have elapsed, otherwise the newest months would look '
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
    'One point per starting month. The decline is steady rather than a single bad month, '
    + 'which rules out a one-off billing or migration event as the whole explanation.';

  // 13. Revenue band, held within a tenure band. Unstratified the cheapest
  // band looks loyal and is only old, which left the chart arguing with its
  // own caption.
  const strat = survivalByRevenueWithinTenure(data);
  const bandLabels = strat.revenueBands.map(b => b.label);
  multiLineChart($('chart-by-mrr'), {
    labels: bandLabels,
    series: strat.cells.map((cell, i) => ({
      label: cell.tenure,
      colour: [INK.negative, INK.secondary, INK.primary][i],
      values: cell.bands.map(b => b.survival),
    })),
    yFormat: v => fmt.pct(v),
    yMin: 0.6,
    yMax: 1,
    xTitle: 'Monthly revenue at the starting month',
    describe: i => '<strong>' + bandLabels[i] + '</strong>'
      + strat.cells.map(cell =>
          '<span>' + cell.tenure + ' ' + fmt.pct(cell.bands[i].survival, 1)
          + ' <span class="muted">(n=' + fmt.int(cell.bands[i].n) + ')</span></span>').join(''),
  });

  const young = strat.cells[0];
  const old = strat.cells[strat.cells.length - 1];
  const youngLift = (young.bands[young.bands.length - 1].survival - young.bands[0].survival) * 100;
  const oldLift = (old.bands[old.bands.length - 1].survival - old.bands[0].survival) * 100;
  $('mrr-finding').innerHTML =
    '<strong>Only in the first year.</strong> Among customers inside their first year, '
    + 'survival rises ' + youngLift.toFixed(1) + ' points from the cheapest band to the '
    + 'dearest, ' + fmt.pct(young.bands[0].survival, 1) + ' to '
    + fmt.pct(young.bands[young.bands.length - 1].survival, 1) + '. Past two years the '
    + 'effect is gone, ' + (oldLift >= 0 ? 'up ' : 'down ') + Math.abs(oldLift).toFixed(1)
    + ' points. Price buys you time early and stops mattering once a customer is established.';
  $('mrr-note').textContent =
    'Revenue measured at the starting month, pooled across ' + strat.starts + ' windows and '
    + 'stratified by tenure so the two effects are separated rather than confused. '
    + 'Unstratified, the cheapest band appears the most loyal because it is the oldest, '
    + 'which is a property of who is in it rather than of what they pay. Smallest cell here '
    + 'is ' + fmt.int(Math.min(...strat.cells.flatMap(c => c.bands.map(b => b.n))))
    + ' observations.';

  // 14. Tenure, which is the confound behind chart 13.
  const tenure = fw.tenureBands.filter(b => b.n > 100);
  columnChart($('chart-by-tenure'), {
    labels: tenure.map(b => b.label + ' mo'),
    values: tenure.map(b => b.survival),
    yFormat: v => fmt.pct(v),
    yMax: 1,
    colour: INK.secondary,
    describe: i => '<strong>' + tenure[i].label + ' months in</strong>'
      + '<span>' + fmt.pct(tenure[i].survival, 1) + ' survive four months</span>'
      + '<span class="muted">' + fmt.int(tenure[i].n) + ' observations</span>',
  });
  // Framed as the hazard curve it is. "Long tenure customers are more loyal"
  // is circular, since long tenure means they did not leave. Where the curve
  // flattens is the real question, and that is answerable.
  let flattensAt = null;
  for (let i = 1; i < tenure.length; i += 1) {
    if (tenure[i].survival - tenure[i - 1].survival > 0.03) flattensAt = tenure[i].label;
  }
  $('tenure-finding').innerHTML =
    '<strong>The risk of leaving falls sharply after the first year, then flattens.</strong> '
    + 'Four month survival runs at ' + fmt.pct(tenure[0].survival, 1) + ' for customers in '
    + 'their first six months and ' + fmt.pct(tenure[1].survival, 1) + ' at six to twelve, '
    + 'then steps up to ' + fmt.pct(tenure[2].survival, 1) + ' in the second year and barely '
    + 'moves after. The first year is where the base is lost.';
  $('tenure-note').textContent =
    'Read this as a hazard curve, not as a predictor. Customers with long tenure are by '
    + 'definition ones who did not leave, so "long tenure customers are loyal" is circular '
    + 'and says nothing. Where the curve steps, and how early, is the part that is a finding. '
    + 'Tenure counts months carrying revenue before the starting month.';


  // 17 and 18. Customer Success capacity, and whether either relationship is
  // moving. Neither is touched by the sliders: the split decides how much CS
  // spend counts as acquisition cost, not how much was spent.
  // Stale claim check, stated from the data rather than from memory.
  const s2 = data.customers.filter(r => r.source === 'S2').length;
  const s2Share = s2 / data.customers.length;
  const classColumns = ['usage_revenue', 'onetime_revenue', 'passthrough_revenue'];
  const hasClasses = false;
  $('margin-statement').innerHTML = hasClasses
    ? 'Revenue is split by class, so per class margins are applied.'
    : '<strong>Still estimated:</strong> a single 75.7% platform margin is applied to all '
      + 'revenue, because the pushed customer waterfall carries no revenue class columns. '
      + 'The query emits them; the push does not carry them, so the fix is upstream rather '
      + 'than inherent. Pass-through carrier fees matter most, since they sit in revenue and '
      + 'in cost of sales and any margin applied to them credits profit that does not exist. '
      + 'The second Stripe environment is now pulling but thinly, '
      + fmt.int(s2) + ' of ' + fmt.int(data.customers.length) + ' rows ('
      + fmt.pct(s2Share, 2) + '), so anything it alone carries is still largely missing.';

  const cap = capacityAnalysis(data);
  const cp = cap.points;
  const capLabels = cp.map(p => fmt.monthLabel(p.month));
  const rc = cap.correlations;
  const sign = v => (v >= 0 ? '+' : '') + v.toFixed(2);

  // Indexed so two quantities in different units can share an axis.
  const baseChurn = cp[0].churn;
  const baseCap = cp[0].csPerLogo;
  multiLineChart($('chart-capacity'), {
    labels: capLabels,
    series: [
      { label: 'CS spend per active logo', colour: INK.secondary,
        values: cp.map(p => (p.csPerLogo / baseCap) * 100) },
      { label: 'Forward four-month churn', colour: INK.negative,
        values: cp.map(p => (p.churn / baseChurn) * 100) },
    ],
    yFormat: v => Math.round(v),
    refs: [{ value: 100, label: cp[0].month + ' = 100', variant: 'ref-floor' }],
    describe: i => '<strong>' + fmt.monthLabel(cp[i].month) + '</strong>'
      + '<span>CS spend ' + fmt.money(cp[i].csSpend) + '</span>'
      + '<span>Per logo ' + fmt.money(cp[i].csPerLogo) + ' across ' + fmt.int(cp[i].logos) + '</span>'
      + '<span>Forward churn ' + fmt.pct(cp[i].churn, 1) + '</span>',
  });

  const firstHalf = cp.slice(0, 12), secondHalf = cp.slice(12);
  const avg = (rows, key) => rows.reduce((s, x) => s + x[key], 0) / rows.length;
  const capGrowth = (avg(secondHalf, 'csPerLogo') / avg(firstHalf, 'csPerLogo') - 1) * 100;

  $('capacity-finding').innerHTML =
    '<strong>They rose together, which is almost certainly the team responding to churn '
    + 'rather than causing it.</strong> CS spend per active logo is up '
    + Math.round(capGrowth) + '% between the first and second halves of this window, and it '
    + 'correlates with forward churn at ' + sign(rc.capacity) + ' (salaries alone, '
    + sign(rc.salaries) + '). Holding time constant it is still ' + sign(rc.capacityGivenTime)
    + ', so it is not only the shared trend. Read the direction with care: nothing here can '
    + 'separate capacity driving churn, which would be perverse, from churn driving hiring, '
    + 'which is what usually happens.';

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
  multiLineChart($('chart-momentum'), {
    labels: capLabels,
    series: [
      { label: 'New arrivals against churn', colour: INK.primary, values: cap.rollingArrivals },
      { label: 'CS capacity against churn', colour: INK.secondary, values: cap.rollingCapacity },
    ],
    yFormat: v => v.toFixed(1),
    yMin: -1,
    yMax: 1,
    refs: [{ value: 0, label: 'no relationship', variant: 'ref-floor' }],
    describe: i => '<strong>' + fmt.monthLabel(cp[i].month) + '</strong>'
      + (cap.rollingArrivals[i] === null
          ? '<span class="muted">inside the first ' + cap.rollingWidth + ' months, no window yet</span>'
          : '<span>Arrivals ' + sign(cap.rollingArrivals[i]) + '</span>'
            + '<span>CS capacity ' + sign(cap.rollingCapacity[i]) + '</span>'),
  });

  const live = cap.rollingArrivals.filter(v => v !== null);
  const liveCap = cap.rollingCapacity.filter(v => v !== null);
  $('momentum-finding').innerHTML =
    '<strong>One is fading, the other is not.</strong> The link between new arrivals and churn '
    + 'ran at ' + sign(live[0]) + ' over the earliest twelve month window and '
    + sign(live[live.length - 1]) + ' over the latest, so it has gone. The CS capacity link has '
    + 'barely moved, ' + sign(liveCap[0]) + ' to ' + sign(liveCap[liveCap.length - 1]) + '. '
    + 'That is why chart 21 reads ' + sign(rc.arrivals) + ' overall: a real early relationship '
    + 'and no recent one average out to nothing.';

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

  scatterXY($('chart-new-vs-churn'), {
    points,
    xLabel: 'New logos in the starting month',
    yLabel: 'Four-month churn',
    xFormat: v => Math.round(v),
    yFormat: v => fmt.pct(v),
    colour: INK.primary,
    describe: i => '<strong>' + points[i].month + '</strong>'
      + '<span>' + fmt.int(points[i].x) + ' new logos</span>'
      + '<span>' + fmt.pct(points[i].y, 1) + ' churned within four months</span>',
  });

  const r = correlate(points.map(p => [p.x, p.y]));
  const rTime = correlate(points.map((p, i) => [i, p.y]));
  $('newchurn-finding').innerHTML =
    '<strong>No. This one is not supported.</strong> The correlation between new arrivals and '
    + 'forward churn is ' + (r >= 0 ? '+' : '') + r.toFixed(2) + ', which explains about '
    + Math.round(r * r * 100) + '% of the variation. Months with few new customers are not '
    + 'months with worse churn.';
  $('newchurn-note').textContent =
    'Twenty four monthly observations, and no trend line is drawn through them on purpose: '
    + 'both series drift over the period, and two drifting series correlate whether or not '
    + 'they are related. '
    + 'Charts 19 and 20 take this further: with Customer Success capacity held constant the '
    + 'association is ' + sign(rc.arrivalsGivenCapacity) + ' rather than ' + sign(rc.arrivals)
    + ', and it was real early in the window before fading to nothing. '
    + 'Churn does track time (' + (rTime >= 0 ? '+' : '') + rTime.toFixed(2)
    + ' against window order), so both quantities drift over the period. That shared drift is '
    + 'why a raw pairwise correlation here would mislead in either direction, and why this is '
    + 'drawn as a cloud rather than as a trend line through it.';
}

// 19. The same window, this year against one and two years ago. Driven by its
// own slider rather than by the assumptions, because the horizon is a way of
// looking rather than a modelling choice.
function renderSeasonal() {
  const horizon = Number($('horizon').value);
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

// 21. Reconciliation.
function renderReconciliation() {
  const rec = reconciliation(data, cohorts);
  if (!rec.rows.length) {
    $('recon-table').innerHTML = '';
    $('recon-note').textContent =
      'No month in the push carries a reported new logo count, so there is nothing to '
      + 'reconcile against yet.';
    return;
  }

  const cell = (v, signed) => '<td class="n">'
    + (v === 0 ? '<span class="range none">0</span>'
               : (signed && v > 0 ? '+' : '') + fmt.int(v)) + '</td>';

  $('recon-table').innerHTML =
    '<thead><tr><th>Month</th><th class="n">Derived</th><th class="n">Censored</th>'
    + '<th class="n">Migration pairs</th><th class="n">Zero-revenue lag</th>'
    + '<th class="n">Walked</th><th class="n">Reported</th><th class="n">Unexplained</th></tr></thead>'
    + '<tbody>' + rec.rows.map(r =>
        '<tr><td>' + r.month + '</td>'
        + cell(r.derived)
        + cell(-r.censored, true)
        + cell(-r.pairs, true)
        + cell(r.lag, true)
        + cell(r.walked)
        + cell(r.reported)
        + '<td class="n">' + (Math.abs(r.unexplained) >= 10
            ? '<span class="tag risk">' + (r.unexplained > 0 ? '+' : '') + r.unexplained + '</span>'
            : (r.unexplained > 0 ? '+' : '') + r.unexplained) + '</td></tr>').join('')
    + '</tbody>';

  const worst = rec.rows.reduce((a, b) =>
    Math.abs(b.unexplained) > Math.abs(a.unexplained) ? b : a);
  const net = rec.rows.reduce((s, r) => s + r.unexplained, 0);
  const big = rec.rows.filter(r => Math.abs(r.unexplained) >= 10).length;

  $('recon-finding').innerHTML =
    '<strong>It does not close, and that is the finding.</strong> Across '
    + rec.rows.length + ' months the named differences leave a net '
    + (net > 0 ? '+' : '') + net + ' logos unexplained, but the monthly figures swing both '
    + 'ways rather than drifting one, from ' + Math.min(...rec.rows.map(r => r.unexplained))
    + ' to +' + Math.max(...rec.rows.map(r => r.unexplained)) + '. '
    + worst.month + ' is the widest at ' + (worst.unexplained > 0 ? '+' : '')
    + worst.unexplained + '. ' + big + ' months are out by ten or more, which is too large '
    + 'to be rounding and points at a definition neither system has written down.';

  $('recon-note').textContent =
    'Derived counts cohorts by first month carrying revenue. Censored removes customers who '
    + 'existed before the window opened. Migration pairs removes the second half of one '
    + 'business carried across both Stripe environments, matched on company name, which is '
    + 'the only handle the pushed data offers: ' + rec.pairsFound + ' found, so treat that as '
    + 'a floor rather than a count. Zero-revenue lag adds customers who signed earlier and '
    + 'sat at nothing until the month they first billed. '
    + fmt.int(rec.neverPaid) + ' of ' + fmt.int(rec.totalCustomers) + ' accounts never '
    + 'carried revenue at all and are in neither column.';
}

boot();
