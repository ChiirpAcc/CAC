// Loading, parsing and derivation. Nothing here draws.
//
// The workbook computes; this file only reshapes what it pushed. Two rules
// run through all of it. Months are YYYY-MM strings and are compared as
// strings, which works because the format sorts correctly. And a missing
// value stays null the whole way to the chart, because zero would plot as a
// real observation and mean the opposite of what it is.

export const DATA_DIR = 'data';

// Anything at or after the current month is still accruing. The clearest
// case in the data is a month carrying negative acquisition cost, which is
// a credit posted before the month's spend has landed.
const CURRENT_MONTH = new Date().toISOString().slice(0, 7);

export function num(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let text = String(value).trim();
  if (text === '' || text === '-' || text === '--' || /^n\/?a$/i.test(text)) return null;

  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }

  const percent = text.endsWith('%');
  if (percent) text = text.slice(0, -1);

  text = text.replace(/[$,\s ]/g, '');
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  }
  if (text === '' || text === '.') return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;

  const signed = negative ? -parsed : parsed;
  return percent ? signed / 100 : signed;
}

export function monthAdd(month, offset) {
  const [year, m] = month.split('-').map(Number);
  const total = year * 12 + (m - 1) + offset;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function monthDiff(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm);
}

async function readFile(name) {
  const response = await fetch(`${DATA_DIR}/${name}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);

  // The push may or may not compress the large tab, so handle both.
  if (name.endsWith('.gz')) {
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return response.json();
}

export async function load() {
  const index = await fetch(`${DATA_DIR}/index.json`, { cache: 'no-store' }).then(r => r.json());
  const byTab = {};
  await Promise.all(index.files.map(async entry => {
    byTab[entry.tab] = await readFile(entry.file);
  }));

  const complete = rows => rows.filter(r => r.month && r.month < CURRENT_MONTH);

  const waterfall = complete(byTab['Waterfall Summary'].rows).map(r => ({
    month: r.month,
    bopMrr: num(r.bop_mrr),
    eopMrr: num(r.eop_mrr),
    newMrr: num(r.new_mrr),
    churnMrr: num(r.churn_mrr),
    activeLogos: num(r.active_logos),
    newLogos: num(r.new_logos),
    reactivatedLogos: num(r.reactivated_logos),
    churnedLogos: num(r.churned_logos),
    netLogoChange: num(r.net_logo_change),
  }));

  const cacMonthly = complete(byTab['CAC Monthly'].rows).map(r => ({
    month: r.month,
    cacTotalActual: num(r.cac_total_actual),
    logosBasis: r.logos_basis || null,
  }));

  const expenses = byTab['QB Expenses'].rows
    .filter(r => r.month && r.month < CURRENT_MONTH)
    .map(r => ({
      account: r.account,
      section: r.section,
      month: r.month,
      amount: num(r.amount),
      bucket: r.bucket,
    }));

  const customers = byTab['Customer Waterfall'].rows
    .filter(r => r.month && r.month < CURRENT_MONTH)
    .map(r => ({
      id: r.customer_id,
      name: r.company_name || null,
      source: r.source || null,
      month: r.month,
      eopMrr: num(r.eop_mrr),
    }));

  return {
    pushedAt: index.pushed_at || null,
    waterfall,
    cacMonthly,
    expenses,
    customers,
    lastMonth: waterfall.length ? waterfall[waterfall.length - 1].month : null,
  };
}

// Acquisition cost by month, rebuilt from the P&L rather than read from the
// CAC Monthly tab. The tab carries only a total at one fixed split, and the
// whole point of the slider is that the split is not settled. Customer
// Success and Partnerships sit in the SPLIT bucket precisely so their share
// can be chosen here.
export function cacByMonth(data, { csShare, partnershipsShare }) {
  const totals = new Map();
  const add = (month, amount) => totals.set(month, (totals.get(month) || 0) + amount);

  for (const row of data.expenses) {
    if (row.amount === null) continue;
    if (row.bucket === 'CAC') {
      add(row.month, row.amount);
    } else if (row.bucket === 'SPLIT') {
      if (row.account.includes('Customer Success')) add(row.month, row.amount * csShare);
      else if (row.account.includes('Partnerships')) add(row.month, row.amount * partnershipsShare);
    }
  }
  return totals;
}

export function splitTotals(data) {
  let cac = 0, cs = 0, partnerships = 0;
  for (const row of data.expenses) {
    if (row.amount === null) continue;
    if (row.bucket === 'CAC') cac += row.amount;
    else if (row.bucket === 'SPLIT') {
      if (row.account.includes('Customer Success')) cs += row.amount;
      else if (row.account.includes('Partnerships')) partnerships += row.amount;
    }
  }
  return { cac, cs, partnerships };
}

// Cohorts, derived from the per-customer waterfall.
//
// A customer's cohort is the first month they carried revenue, not the first
// month they appear. A signed customer can sit at zero for months, and
// counting them from signature would credit the wrong month with the
// acquisition and stretch every retention curve.
export function buildCohorts(data) {
  const firstRevenueMonth = new Map();
  const activeByCustomer = new Map();
  const revenueByCustomer = new Map();

  for (const row of data.customers) {
    if (row.eopMrr === null || row.eopMrr <= 0) continue;

    const seen = firstRevenueMonth.get(row.id);
    if (seen === undefined || row.month < seen) firstRevenueMonth.set(row.id, row.month);

    if (!activeByCustomer.has(row.id)) {
      activeByCustomer.set(row.id, new Set());
      revenueByCustomer.set(row.id, new Map());
    }
    activeByCustomer.get(row.id).add(row.month);
    revenueByCustomer.get(row.id).set(row.month, row.eopMrr);
  }

  const members = new Map();
  for (const [id, month] of firstRevenueMonth) {
    if (!members.has(month)) members.set(month, []);
    members.get(month).push(id);
  }

  const lastMonth = data.lastMonth;
  const cohorts = [...members.keys()].sort().map(month => {
    const ids = members.get(month);
    const maxOffset = monthDiff(month, lastMonth);

    const logos = [];
    const revenue = [];
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const at = monthAdd(month, offset);
      let live = 0;
      let mrr = 0;
      for (const id of ids) {
        if (activeByCustomer.get(id).has(at)) {
          live += 1;
          mrr += revenueByCustomer.get(id).get(at) || 0;
        }
      }
      logos.push(live);
      revenue.push(mrr);
    }

    return { month, size: logos[0] || ids.length, ids, logos, revenue, maxOffset };
  });

  return cohorts.filter(c => c.size > 0);
}

// Unit economics per cohort, at the chosen split and margin.
//
// LTV here is gross profit actually realised to date, not a projection. That
// understates young cohorts, which is why the age of a cohort has to stay
// visible wherever this is drawn.
export function cohortEconomics(data, cohorts, { csShare, partnershipsShare, margin }) {
  const cac = cacByMonth(data, { csShare, partnershipsShare });
  const newLogosByMonth = new Map(data.waterfall.map(r => [r.month, r.newLogos]));

  return cohorts.map(cohort => {
    const spend = cac.get(cohort.month);
    const acquired = newLogosByMonth.get(cohort.month);

    // Cost per logo needs a real denominator. A cohort month with no recorded
    // new logos has no cost per logo, and forcing one would invent a number.
    const costPerLogo = (spend === undefined || !acquired) ? null : spend / acquired;

    let running = 0;
    const cumulativeGpPerLogo = cohort.revenue.map(mrr => {
      running += (mrr * margin) / cohort.size;
      return running;
    });

    const recovery = costPerLogo === null
      ? []
      : cumulativeGpPerLogo.map(gp => gp / costPerLogo);

    let payback = null;
    for (let offset = 0; offset < recovery.length; offset += 1) {
      if (recovery[offset] >= 1) { payback = offset + 1; break; }
    }

    return {
      month: cohort.month,
      size: cohort.size,
      maxOffset: cohort.maxOffset,
      costPerLogo,
      cumulativeGpPerLogo,
      recovery,
      payback,
      ltvCac: costPerLogo === null
        ? null
        : cumulativeGpPerLogo[cumulativeGpPerLogo.length - 1] / costPerLogo,
    };
  });
}

// Blended retention, indexed to month 2.
//
// Month 1 carries setup and onboarding fees, so indexing there turns a
// one-off charge ending into what reads as a cliff. The sample rule keeps the
// tail from being drawn by a handful of old cohorts.
export function blendedRetention(cohorts, { minCohorts = 20, maxMonths = 24 } = {}) {
  const points = [];
  for (let offset = 1; ; offset += 1) {
    // Two limits, whichever bites first. The sample rule stops the tail being
    // drawn by a handful of old cohorts, and the horizon keeps the curve to a
    // span somebody can actually reason about.
    if (offset + 1 > maxMonths) break;
    const inSample = cohorts.filter(c => c.maxOffset >= offset && c.logos[1] > 0);
    if (inSample.length < minCohorts) break;

    const logoBase = inSample.reduce((sum, c) => sum + c.logos[1], 0);
    const revenueBase = inSample.reduce((sum, c) => sum + c.revenue[1], 0);
    points.push({
      offset: offset + 1,
      logos: logoBase ? inSample.reduce((s, c) => s + c.logos[offset], 0) / logoBase : null,
      revenue: revenueBase ? inSample.reduce((s, c) => s + c.revenue[offset], 0) / revenueBase : null,
      cohorts: inSample.length,
    });
  }
  return points;
}

export function retentionByEra(cohorts, { minCohortsPerPoint = 3 } = {}) {
  const usable = cohorts.filter(c => c.logos[1] > 0);
  const third = Math.ceil(usable.length / 3);
  const eras = [
    { label: 'Earliest third', members: usable.slice(0, third) },
    { label: 'Middle third', members: usable.slice(third, third * 2) },
    { label: 'Most recent third', members: usable.slice(third * 2) },
  ];

  return eras.map(era => {
    const points = [];
    for (let offset = 1; ; offset += 1) {
      const inSample = era.members.filter(c => c.maxOffset >= offset);
      // Below three cohorts an era is represented by its oldest members alone,
      // and a flat curve then reads as improvement.
      if (inSample.length < minCohortsPerPoint) break;
      const base = inSample.reduce((sum, c) => sum + c.logos[1], 0);
      points.push({
        offset: offset + 1,
        value: base ? inSample.reduce((s, c) => s + c.logos[offset], 0) / base : null,
      });
    }
    return { ...era, points, span: era.members.length
      ? `${era.members[0].month} to ${era.members[era.members.length - 1].month}`
      : '' };
  }).filter(era => era.points.length);
}

// Retention at a fixed age, one point per cohort. A cohort is only plotted
// once that age is behind it, otherwise its last observed month doubles as
// its retention and every recent cohort reads as perfect.
export function retentionAtAge(cohorts, offset) {
  return cohorts.map(cohort => {
    if (cohort.maxOffset < offset || !cohort.logos[1]) {
      return { month: cohort.month, value: null };
    }
    return { month: cohort.month, value: cohort.logos[offset] / cohort.logos[1] };
  });
}

export function mean(values) {
  const real = values.filter(v => v !== null && Number.isFinite(v));
  return real.length ? real.reduce((a, b) => a + b, 0) / real.length : null;
}
