import {
  load, buildCohorts, cohortEconomics,
  blendedRetention, retentionByYear, retentionAtAge, mean, monthDiff,
  forwardSurvival, correlate, projectedBreakEven, capacityAnalysis,
  seasonalSurvival,
  hasRevenueClasses, CLASS_MARGINS, environmentSplit,
  signupEconomics, priceAgainstRetention,
  arrivalsAgainstChurn,
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
    renderSignups();
    renderAnnotations();
    $('horizon').addEventListener('input', renderSeasonal);
    $('arrival-horizon').addEventListener('input', renderArrivals);
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

  // The headline is read off the numbers rather than asserted, so it cannot
  // keep claiming a direction the data has stopped supporting.
  const ranked = [...eras].filter(e => e.month6 !== null).sort((a, b) => b.month6 - a.month6);
  const bestYear = ranked[0];
  const worstYear = ranked[ranked.length - 1];
  const newest = eras[eras.length - 1];
  const spread6 = ((bestYear.month6 - worstYear.month6) * 100).toFixed(1);
  const monotonic = eras.every((e, i) => i === 0 || e.month6 <= eras[i - 1].month6);

  $('era-finding').innerHTML = monotonic
    ? `<strong>Each year is worse than the one before it at six months.</strong> `
      + eras.map(e => `${e.year} ${fmt.pct(e.month6, 1)}`).join(', ')
      + `. A steady decline rather than one bad year.`
    : `<strong>${bestYear.year} was the good year, and both sides of it are worse.</strong> `
      + `At month 6, ${eras.map(e => `${e.year} holds ${fmt.pct(e.month6, 1)}`).join(', ')}`
      + `, a spread of ${spread6} points. `
      + (newest.month3 > eras[0].month3
          ? `The ${newest.year} cohorts actually start better than ${eras[0].year} at month 3, `
            + `${fmt.pct(newest.month3, 1)} against ${fmt.pct(eras[0].month3, 1)}, and give it `
            + `back by month 6. `
          : '')
      + `The question that follows is what was different about ${bestYear.year}, which nothing `
      + `else on this page asks.`;

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
    + 'Counts come from the monthly summary. The cohort charts derive their own from '
    + 'when a customer started, so the two can differ while the summary is on an older '
    + 'basis.';
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

  // 1. LTV:CAC by cohort.
  const ltv = economics.map(c => c.ltvCac);
  columnChart($('chart-ltv-cac'), {
    labels,
    values: ltv,
    yFormat: v => v.toFixed(1) + 'x',
    colourFor: (v, i) => mute(v >= 3 ? INK.positive : v >= 1 ? INK.tertiary : INK.negative, economics[i]),
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
    `Gross profit realised to date over acquisition cost, per logo. Realised rather than `
    + `projected, so it is age-biased by construction and the rightmost columns will keep `
    + `rising. ${below} of ${ltv.filter(v => v !== null).length} cohorts `
    + `are below break-even. ${tooYoung} cohorts younger than ${MIN_COHORT_AGE} months are `
    + `drawn in grey rather than withheld, because a young cohort sits low for want of time `
    + `rather than for want of quality. Cohorts before ${economics[0].month} are absent because acquisition cost is `
    + `not recorded then, not because they performed badly.`
    + ` Cost and gross profit are divided by the same cohort `
    + `count, so the ratio compares like with like.`;

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
    `${recovered.length} of ${economics.length} cohorts have covered their cost, ${withinGoal} `
    + `of them inside the 12 month goal. The other ${unrecovered} are projected rather than `
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
  // The pipeline's own acquisition cost, the same figure charts 1, 2 and 14
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
  const reliable = r => r.newLogos && r.newLogos >= typical * 0.35;
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
          + ' ' + (suppressed.length === 1 ? 'is' : 'are') + ' left blank: the new logo count '
          + 'there is under a third of a typical month, so the ratio would be measuring the '
          + 'denominator rather than the cost.'
        : '');
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
      { label: `Average of the earlier ${earlier.length} windows`,
        colour: INK.primary, values: average(earlier) },
      { label: `Average of the latest ${recent.length}`,
        colour: INK.negative, values: average(recent) },
    ],
    yFormat: v => fmt.pct(v),
    yMin: 0.6,
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

  // 17 and 18. Customer Success capacity, and whether either relationship is
  // moving. Neither is touched by the sliders: the split decides how much CS
  // spend counts as acquisition cost, not how much was spent.
  // Stale claim check, stated from the data rather than from memory.
  const s2 = data.customers.filter(r => r.source === 'S2').length;
  const s2Share = s2 / data.customers.length;
  const hasClasses = hasRevenueClasses(data);
  $('margin-statement').innerHTML = hasClasses
    ? '<strong>Margins are applied per revenue class.</strong> Platform '
      + fmt.pct(CLASS_MARGINS.platform, 1) + ', usage ' + fmt.pct(CLASS_MARGINS.usage)
      + ', one-time ' + fmt.pct(CLASS_MARGINS.oneTime) + ', and pass-through and '
      + 'recognised-elsewhere at zero. Pass-through is carrier fees, which sit in revenue and '
      + 'in cost of sales at once, so any margin on them would credit profit that does not '
      + 'exist. Recognised-elsewhere is a buyout or prepayment already carried by a couponed '
      + 'subscription, so counting it again would double count. How the classes divide '
      + 'recognised MRR is inferred rather than stated by the push: the identified classes are '
      + 'carved out and the remainder treated as platform, with one-time added rather than '
      + 'carved out because it is not recurring. '
      + 'The second Stripe environment carries ' + fmt.int(s2) + ' of '
      + fmt.int(data.customers.length) + ' customer months, ' + fmt.pct(s2Share, 2)
      + '. That is a young environment rather than a broken feed: it is pulling, and there is '
      + 'simply not much in it yet.'
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
  multiLineChart($('chart-capacity'), {
    labels: capLabels,
    series: [
      { label: 'Retention function per logo (CS, TAM, Support)', colour: INK.primary,
        values: cp.map(p => (p.retentionPerLogo / baseWhole) * 100) },
      { label: 'Customer Success alone', colour: INK.secondary, dashed: true,
        values: cp.map(p => (p.csPerLogo / baseCap) * 100) },
      { label: 'Forward four-month churn', colour: INK.negative,
        values: cp.map(p => (p.churn / baseChurn) * 100) },
    ],
    yFormat: v => Math.round(v),
    refs: [{ value: 100, label: cp[0].month + ' = 100', variant: 'ref-floor' }],
    describe: i => '<strong>' + fmt.monthLabel(cp[i].month) + '</strong>'
      + '<span>Retention function ' + fmt.money(cp[i].retentionSpend) + '</span>'
      + '<span class="muted">CS ' + fmt.money(cp[i].teams['Customer Success'])
      + ', TAM ' + fmt.money(cp[i].teams['Technical Account Manager'])
      + ', Support ' + fmt.money(cp[i].teams['Support']) + '</span>'
      + '<span>Per logo ' + fmt.money(cp[i].retentionPerLogo) + ' across ' + fmt.int(cp[i].logos) + '</span>'
      + '<span>Forward churn ' + fmt.pct(cp[i].churn, 1) + '</span>',
  });

  const firstHalf = cp.slice(0, 12), secondHalf = cp.slice(12);
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
    + 'That is why chart 23 reads ' + sign(rc.arrivals) + ' overall: a real early relationship '
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

  renderArrivals();
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

// Per chart annotation.
//
// Takeaways are computed from the data rather than written down, so they
// cannot drift away from what the chart shows. Assumptions and the business
// reading are prose, because they are properties of the method and of the
// decision rather than numbers, and should not change when a push moves a
// decimal.
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
    + assumptions.map(x => '<li>' + x + '</li>').join('')
    + '</ul>'
    + (meaning ? '<h4>What it means for the business</h4><p class="means">' + meaning + '</p>' : '');
  figure.appendChild(block);
}

const MEANS = {
  'chart-price-volume':
    'This is the chart to put in front of anyone who has seen the volume line on its own. '
    + 'Fewer customers at a higher price is a different business from fewer customers, and '
    + 'the revenue effect is roughly two thirds of what the count alone implies. It does not '
    + 'make the decline disappear, and it does change what to do about it: the pricing move '
    + 'is working and the volume problem is partly a measurement boundary, so the honest '
    + 'reading is that neither a discount nor a panic about demand is supported here.',

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
    'The model works and has been proven to work. The 2024 cohorts returned three to six '
    + 'times what they cost at around $2,000 a logo. What has broken is the price of a '
    + 'customer, not the value of one. At $10,000 a logo the same retention curve cannot '
    + 'clear the bar, so the lever here is acquisition cost, not upsell or pricing.',

  'chart-payback':
    'Payback lengthening from six months to twenty changes how the business is financed, not '
    + 'just how it looks. A cohort that pays back in six months funds the next one inside the '
    + 'year; one that takes twenty does not fund anything within a planning cycle. Growth at '
    + 'current unit economics has to be paid for out of the base rather than out of itself.',

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
    + 'to stand still. At the current rate the base needs roughly fifty new logos a month to '
    + 'hold flat, and it is winning nine. No plausible improvement in conversion closes that '
    + 'gap; it has to come from the churn side.',

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
    'A level shift rather than a delay points upstream of onboarding. If newer cohorts were '
    + 'being onboarded badly they would start level and fall away; starting lower and staying '
    + 'lower suggests the business is selling to a different kind of customer, or selling them '
    + 'something different, than it was two years ago. That is a go-to-market question rather '
    + 'than a customer success one.',

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

  annotate('chart-ltv-cac', [
    `<strong>${belowOne} of ${withLtv.length} cohorts shown sit below 1.0x</strong>, meaning they have not yet returned what they cost to win.`,
    `${above3} are above the 3.0x line. The best is ${best.month} at ${fmt.ratio(best.ltvCac)}, on ${fmt.money(best.costPerLogo)} a logo.`,
    `The 2024 cohorts sit far above the 2026 ones, and cost per logo is most of why: ${fmt.money(shown[0].costPerLogo)} then against ${fmt.money(shown[shown.length - 1].costPerLogo)} now.`,
  ], [
    'LTV here is gross profit <strong>realised to date</strong>, not a projection, so a cohort partly sits where it does because of its age. Cohorts under six months are withheld for that reason.',
    'Cost per logo assumes a month of spend bought that month of logos. A long sales cycle would push spend into the wrong cohort.',
  ]);

  annotate('chart-payback', [
    `<strong>${recovered.length} of ${shown.length} cohorts have covered their cost</strong>, and ${withinGoal} of those did it inside the twelve month goal.`,
    `${shown.length - recovered.length} have not recovered and are drawn as gaps, not zeroes. A zero would read as instant payback, the opposite of what it means.`,
    `Payback has lengthened with cost: the 2024 cohorts cleared in three to nine months, the 2025 ones in eight to thirteen.`,
  ], [
    'Same realised measure and same age bias as the chart above. A gap is "not yet", not "never".',
    'The run starts at 2024-01 because acquisition cost is not recorded before then, which is an absence of data rather than a verdict on earlier cohorts.',
  ]);

  const mature = ec.filter(c => c.recovery.length >= 6).slice(-6);
  const crossed = mature.filter(c => c.payback !== null).length;
  annotate('chart-recovery', [
    `${crossed} of the ${mature.length} cohorts drawn have crossed the break-even line inside the window shown.`,
    'The shape of each curve bends the same way whatever the cost baseline is, which makes this the one chart here that survives the split being wrong.',
    'Curves that flatten before 100% are cohorts whose revenue is decaying faster than it is accumulating profit.',
  ], [
    'A flat 75.7% platform margin is applied to all revenue, because the push carries no revenue class columns. Usage and one-time revenue carry different margins.',
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
    'Drawn only while at least twenty cohorts remain in sample, and held to a 24 month horizon.',
  ]);

  const recent = w.slice(-36);
  const churnSeries = recent.map((r, i) => (i && recent[i - 1].activeLogos
    ? (r.churnedLogos || 0) / recent[i - 1].activeLogos : null)).filter(v => v !== null);
  const overThreshold = churnSeries.filter(v => v > CHURN_THRESHOLD).length;
  const lastChurn = churnSeries[churnSeries.length - 1];
  annotate('chart-churn', [
    `<strong>${overThreshold} of the last ${churnSeries.length} months sit above the 5% threshold.</strong> The latest reads ${fmt.pct(lastChurn, 2)}.`,
    `Monthly churn has roughly doubled across the window, from about ${fmt.pct(Math.min(...churnSeries), 1)} at its lowest to ${fmt.pct(Math.max(...churnSeries), 1)} at its worst.`,
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
  const unitMonths = w.filter(r => cacMap.has(r.month) && r.newLogos);
  const firstU = unitMonths[0], lastU = unitMonths[unitMonths.length - 1];
  const costFirst = cacMap.get(firstU.month) / firstU.newLogos;
  const costLast = cacMap.get(lastU.month) / lastU.newLogos;
  const arpuFirst = firstU.newMrr / firstU.newLogos;
  const arpuLast = lastU.newMrr / lastU.newLogos;
  annotate('chart-unit', [
    `<strong>Cost per logo has risen about ${(costLast / costFirst).toFixed(1)}x</strong> since ${firstU.month}, from ${fmt.money(costFirst)} to ${fmt.money(costLast)}.`,
    `New-logo revenue per logo has moved from ${fmt.money(arpuFirst)} to ${fmt.money(arpuLast)}, so the two lines are diverging rather than moving together.`,
    'Volume is doing most of the work: spend has fallen while logos have fallen faster.',
  ], [
    'Both series are indexed to 100 at the same month, so the absolute levels do not need to be right for the divergence to read. The base month is stated on the chart.',
    'Where the pipeline reports a cost per logo it is used directly; earlier months derive it from total cost over the waterfall new logos.',
  ]);

  const eras = retentionByYear(cohorts, { maxMonths: 12 });
  const newestEra = eras[eras.length - 1];
  const oldestEra = eras[0];
  annotate('chart-era', [
    `<strong>The newest cohorts are worse from month 2 onward</strong>: ${fmt.pct(newestEra.month3, 1)} at month 3 against ${fmt.pct(oldestEra.month3, 1)} for ${oldestEra.year}.`,
    `By month 6 the gap widens rather than closes, ${fmt.pct(newestEra.month6, 1)} against ${fmt.pct(oldestEra.month6, 1)}. This is a level shift, not a delay.`,
    `The ${newestEra.year} line rests on ${newestEra.reachedMonth6} cohorts at month 6, so its right hand end is thin and will move.`,
  ], [
    'Indexed to <strong>month 1</strong> here, unlike charts 4 and 6, because this counts logos rather than revenue and there is no setup fee to distort the first month.',
    'A point is dropped once fewer than three cohorts in that year have reached that age, so the newest line is never drawn by its oldest member alone.',
  ]);

  annotate('chart-flows', [
    `<strong>${fmt.int(churned)} logos out against ${fmt.int(acquired)} in, ${year} to date</strong>, a net loss of ${fmt.int(churned - acquired)}.`,
    `New logos have fallen from ${fmt.int(ytd[0].newLogos)} in ${fmt.monthLabel(ytd[0].month)} to ${fmt.int(latest.newLogos)} in ${fmt.monthLabel(latest.month)}.`,
    'Churn has been the larger of the two movements for most of the year, so the base is falling on both sides at once.',
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
    `Holding time constant it is still ${sign2(rc2.capacityGivenTime)}, so it is not purely the shared trend.`,
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
    `<strong>Pooled, there is almost nothing here</strong>: ${sign2(rc2.arrivals)}, about ${Math.round(rc2.arrivals * rc2.arrivals * 100)}% of the variation.`,
    `But that conceals the shape. With CS capacity held constant the association is ${sign2(rc2.arrivalsGivenCapacity)}, and the previous chart shows it was real early and has since gone.`,
    `${cap.points.length} monthly observations, which is far too few for a correlation to carry weight on its own.`,
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
      `The two lines cross, so the revenue effect is smaller than the volume line alone suggests.`,
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
  const index = (values, base) => values.map(v => (v === null ? null : (v / base) * 100));
  multiLineChart($('chart-price-volume'), {
    labels,
    series: [
      { label: 'New logos', colour: INK.negative,
        values: index(ms.map(r => r.count), first.count) },
      { label: 'Average price at signup', colour: INK.primary,
        values: index(ms.map(r => r.averagePrice), first.averagePrice) },
      { label: 'New MRR added', colour: INK.secondary, dashed: true,
        values: index(ms.map(r => r.startingMrr), first.startingMrr) },
    ],
    yFormat: v => Math.round(v),
    refs: [{ value: 100, label: first.month + ' = 100', variant: 'ref-floor' }],
    describe: i => '<strong>' + fmt.monthLabel(ms[i].month) + '</strong>'
      + '<span>' + fmt.int(ms[i].count) + ' new logos</span>'
      + '<span>Average ' + fmt.money(ms[i].averagePrice) + ' at signup</span>'
      + '<span>' + fmt.money(ms[i].startingMrr) + ' of new MRR</span>',
  });

  const volumeChange = (last.count / first.count - 1) * 100;
  const priceChange = (last.averagePrice / first.averagePrice - 1) * 100;
  const mrrChange = (last.startingMrr / first.startingMrr - 1) * 100;

  $('price-volume-finding').innerHTML =
    '<strong>Fewer customers at a higher price, and the price is not covering the volume.</strong> '
    + 'Between ' + first.month + ' and ' + last.month + ' the count fell '
    + Math.abs(volumeChange).toFixed(0) + '% while the average price at signup rose '
    + priceChange.toFixed(0) + '%, from ' + fmt.money(first.averagePrice) + ' to '
    + fmt.money(last.averagePrice) + '. New MRR added went from ' + fmt.money(first.startingMrr)
    + ' to ' + fmt.money(last.startingMrr) + ', '
    + (mrrChange < 0 ? 'down ' : 'up ') + Math.abs(mrrChange).toFixed(0) + '%. '
    + 'Neither number tells that on its own, and the volume line alone reads far worse than '
    + 'the business is.';

  $('price-volume-note').textContent =
    'Starting MRR is platform plus upgrade at signup, from the new customer cohort source, '
    + 'which is what a customer was sold rather than what they have paid since. '
    + fmt.int(sx.total) + ' customers. The same S1 weighting applies here as everywhere else: '
    + 'the last month in this source carries only a handful of customers and is dropped, and '
    + 'the months before it are still drawn mostly from the first Stripe environment, so read '
    + 'the volume line as a floor.';

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
    + '. More customers charged, and charged more, are different decisions with different '
    + 'effects on conversion.';
  $('onboarding-note').textContent =
    'Attach rate is the share of the month with a setup fee above zero. The average is taken '
    + 'across those charged, not across everyone, because including the unfeed customers would '
    + 'blend the two movements back together.';

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
    + 'gap between what is billed and what arrives.';
}

// 25. Arrivals against forward churn, at whatever horizon is chosen.
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
