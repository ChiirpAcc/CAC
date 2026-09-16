import {
  load, cacByMonth, splitTotals, buildCohorts, cohortEconomics,
  blendedRetention, retentionByEra, retentionAtAge, mean, monthDiff,
} from './data.js';
import {
  lineChart, multiLineChart, columnChart, flowChart, scatterOverTime, fmt, INK,
} from './charts.js';

// Where the workbook currently sits. Customer Success at 100% means every
// dollar of it is treated as acquisition cost, which is the single largest
// unexamined decision in this analysis.
const DEFAULTS = { csShare: 1, partnershipsShare: 1, margin: 0.757 };

const state = { ...DEFAULTS };
let data = null;
let cohorts = null;

const $ = id => document.getElementById(id);

const COHORT_WINDOW = 24;
const CHURN_THRESHOLD = 0.05;

function atDefaults() {
  return state.csShare === DEFAULTS.csShare
    && state.partnershipsShare === DEFAULTS.partnershipsShare
    && state.margin === DEFAULTS.margin;
}

function boot() {
  load().then(loaded => {
    data = loaded;
    cohorts = buildCohorts(data);
    $('loading').hidden = true;
    $('dashboard').hidden = false;
    wireControls();
    renderStatic();
    renderAssumptionDependent();
  }).catch(err => {
    $('loading').innerHTML =
      `<p class="empty">Could not load the data: ${err.message}. ` +
      `The workbook may not have pushed yet.</p>`;
  });
}

function wireControls() {
  const bind = (id, key, transform, format) => {
    const input = $(id);
    const output = $(`${id}-value`);
    input.value = String(transform.toInput(state[key]));
    output.textContent = format(state[key]);
    input.addEventListener('input', () => {
      state[key] = transform.fromInput(Number(input.value));
      output.textContent = format(state[key]);
      renderAssumptionDependent();
    });
  };

  const pctTransform = { toInput: v => Math.round(v * 100), fromInput: v => v / 100 };
  bind('cs-split', 'csShare', pctTransform, v => fmt.pct(v));
  bind('pt-split', 'partnershipsShare', pctTransform, v => fmt.pct(v));
  bind('margin', 'margin', pctTransform, v => fmt.pct(v, 1));

  $('reset').addEventListener('click', () => {
    Object.assign(state, DEFAULTS);
    $('cs-split').value = DEFAULTS.csShare * 100;
    $('pt-split').value = DEFAULTS.partnershipsShare * 100;
    $('margin').value = DEFAULTS.margin * 100;
    $('cs-split-value').textContent = fmt.pct(DEFAULTS.csShare);
    $('pt-split-value').textContent = fmt.pct(DEFAULTS.partnershipsShare);
    $('margin-value').textContent = fmt.pct(DEFAULTS.margin, 1);
    renderAssumptionDependent();
  });
}

// Charts that do not move when an assumption moves. Drawn once.
function renderStatic() {
  const w = data.waterfall;
  const recent = w.slice(-36);
  const labels = recent.map(r => fmt.monthLabel(r.month));

  $('stamp').textContent = data.pushedAt
    ? `Workbook pushed ${data.pushedAt.replace('T', ' ')}. Months run to ${data.lastMonth}.`
    : `Months run to ${data.lastMonth}.`;

  // Headline counts, none of which depend on a split.
  const latest = w[w.length - 1];
  const peak = w.reduce((best, r) => (r.activeLogos > best.activeLogos ? r : best), w[0]);
  const year = latest.month.slice(0, 4);
  const ytd = w.filter(r => r.month.startsWith(year));
  const acquired = ytd.reduce((s, r) => s + (r.newLogos || 0), 0);
  const churned = ytd.reduce((s, r) => s + (r.churnedLogos || 0), 0);

  $('kpi-base').textContent = fmt.int(latest.activeLogos);
  $('kpi-base-note').textContent =
    `down from ${fmt.int(peak.activeLogos)} at ${fmt.monthLabel(peak.month)}`;

  $('kpi-flow').textContent = `${fmt.int(churned)} out, ${fmt.int(acquired)} in`;
  $('kpi-flow-note').textContent = `${year} to date, a net loss of ${fmt.int(churned - acquired)}`;

  const firstNew = ytd[0];
  $('kpi-new').textContent = fmt.int(latest.newLogos);
  $('kpi-new-note').textContent =
    `new logos in ${fmt.monthLabel(latest.month)}, against ${fmt.int(firstNew.newLogos)} in ${fmt.monthLabel(firstNew.month)}`;

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
    ? `Indexed to month 2, because month 1 carries setup and onboarding fees and indexing there turns a one-off charge ending into an apparent cliff. Drawn while at least 20 cohorts remain in sample, which runs to month ${blended[blended.length - 1].offset}.`
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

  // 8. Retention curve by era.
  const eras = retentionByEra(cohorts);
  const eraLength = Math.max(...eras.map(e => e.points.length), 0);
  multiLineChart($('chart-era'), {
    labels: Array.from({ length: eraLength }, (_, i) => `M${i + 2}`),
    series: eras.map((era, i) => ({
      label: era.label,
      colour: [INK.tertiary, INK.secondary, INK.primary][i],
      values: Array.from({ length: eraLength }, (_, k) => era.points[k]?.value ?? null),
    })),
    yFormat: v => fmt.pct(v),
    xTitle: 'Months since first revenue',
    describe: i => `<strong>Month ${i + 2}</strong>` + eras.map((era, k) =>
      `<span>${era.label} ${fmt.pct(era.points[i]?.value ?? null, 1)}</span>`).join(''),
  });
  $('era-note').textContent = eras.map(e => `${e.label}: ${e.span}`).join('. ')
    + '. A point is dropped once fewer than three cohorts in that era have reached that age, '
    + 'otherwise the newest era is drawn by its oldest cohort alone and a flat curve reads as improvement.';

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

// Everything that moves with the Customer Success split, the Partnerships
// split, or the gross margin.
function renderAssumptionDependent() {
  const economics = cohortEconomics(data, cohorts, state).slice(-COHORT_WINDOW);
  const labels = economics.map(c => fmt.monthLabel(c.month));

  const totals = splitTotals(data);
  const cacTotal = totals.cac + totals.cs * state.csShare + totals.partnerships * state.partnershipsShare;
  $('cac-total').textContent = fmt.money(cacTotal);
  $('cac-total-note').textContent =
    `${fmt.money(totals.cac)} classified acquisition, plus ${fmt.pct(state.csShare)} of ${fmt.money(totals.cs)} Customer Success and ${fmt.pct(state.partnershipsShare)} of ${fmt.money(totals.partnerships)} Partnerships.`;

  const adjusted = !atDefaults();
  document.querySelectorAll('.adjusted-notice').forEach(node => { node.hidden = !adjusted; });
  document.body.classList.toggle('is-adjusted', adjusted);

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
    `Gross profit realised to date over acquisition cost, per logo. This is not a projection, so young cohorts are understated by construction and the rightmost columns will keep rising. ${below} of ${ltv.filter(v => v !== null).length} cohorts shown are below break-even.`;

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
  const unrecovered = economics.filter(c => c.payback === null && c.costPerLogo !== null).length;
  $('payback-note').textContent =
    `${unrecovered} cohorts have not recovered and may not. Those are drawn as gaps rather than zeroes, because a zero would read as instant payback, the opposite of what it means.`;

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

boot();
