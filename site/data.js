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

// Tabs the charts actually read. Anything else in the index is left alone:
// new tabs have arrived unannounced more than once, and fetching every file
// meant one bad or renamed file took the whole page down rather than one chart.
const REQUIRED_TABS = ['Waterfall Summary', 'CAC Monthly', 'QB Expenses', 'Customer Waterfall'];
const OPTIONAL_TABS = ['QB Accounts', 'Subscription Lifetimes'];

export async function load() {
  const index = await fetch(`${DATA_DIR}/index.json`, { cache: 'no-store' }).then(r => r.json());
  const byTab = {};
  const missing = [];

  const wanted = index.files.filter(
    e => REQUIRED_TABS.includes(e.tab) || OPTIONAL_TABS.includes(e.tab));

  await Promise.all(wanted.map(async entry => {
    try {
      byTab[entry.tab] = await readFile(entry.file);
    } catch (err) {
      if (REQUIRED_TABS.includes(entry.tab)) throw err;
      missing.push(entry.tab);
    }
  }));

  for (const tab of REQUIRED_TABS) {
    if (!byTab[tab]) throw new Error(`${tab} is missing from the push`);
  }

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

  // The pipeline now applies the settled splits itself: Customer Success at
  // 0% of acquisition cost, Partnerships at 100%, Technical Account Manager
  // to cost of sales. cac_total_actual already reflects that, so the site
  // reads it rather than re-deriving a total from the expense lines and
  // risking two answers to the same question.
  const cacMonthly = complete(byTab['CAC Monthly'].rows).map(r => ({
    month: r.month,
    cacTotalActual: num(r.cac_total_actual),
    cacPerLogo: num(r.cac_per_logo),
    reportedNewLogos: num(r.new_logos),
    logosBasis: r.logos_basis || null,
  }));

  // Real Stripe subscription start dates. A customer with a record here has a
  // knowable cohort even when the revenue pivots start after they did.
  const lifetimes = new Map();
  const lifetimeTab = byTab['Subscription Lifetimes'];
  if (lifetimeTab) {
    const idKey = lifetimeTab.columns.find(c => /stripe customer id/i.test(c || ''));
    const startKey = lifetimeTab.columns.find(c => /start date/i.test(c || ''));
    if (idKey && startKey) {
      for (const row of lifetimeTab.rows) {
        const id = row[idKey];
        const start = String(row[startKey] || '').slice(0, 7);
        if (id && /^\d{4}-\d{2}$/.test(start)) lifetimes.set(id, start);
      }
    }
  }

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
    lifetimes,
    missingTabs: missing,
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

  // Left censoring.
  //
  // A customer whose first observed month is the first month of the data
  // window did not necessarily start then. They existed before it and the
  // window simply cannot see when, so dating them to the boundary invents a
  // cohort and inflates it. They are excluded rather than guessed at.
  //
  // The exception is a real Stripe start date. Where subscription_lifetimes
  // carries one, the cohort is known whatever the revenue window does.
  //
  // The boundary is read from the data rather than hardcoded, so this keeps
  // working when the pivots are extended backwards.
  // The boundary is the first month that carries any revenue at all, not the
  // first row in the file. A month of zero-revenue rows in front of the window
  // would otherwise move the boundary off the month that actually censors.
  const windowStart = data.customers
    .filter(r => r.eopMrr !== null && r.eopMrr > 0)
    .reduce((earliest, r) => (earliest === null || r.month < earliest ? r.month : earliest), null);
  const censored = [];
  for (const [id, month] of [...firstRevenueMonth]) {
    if (month === windowStart && !data.lifetimes?.has(id)) {
      firstRevenueMonth.delete(id);
      censored.push(id);
    }
  }

  const members = new Map();
  for (const [id, month] of firstRevenueMonth) {
    const known = data.lifetimes?.get(id);
    // A lifetime record only overrides when it is inside the window; a start
    // date before the window has no revenue to attach to it here.
    const cohortMonth = (known && known >= windowStart && known <= month) ? known : month;
    if (!members.has(cohortMonth)) members.set(cohortMonth, []);
    members.get(cohortMonth).push(id);
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

  const built = cohorts.filter(c => c.size > 0);
  built.censoredCount = censored.length;
  built.windowStart = windowStart;
  return built;
}

// Unit economics per cohort, at the chosen split and margin.
//
// LTV here is gross profit actually realised to date, not a projection. That
// understates young cohorts, which is why the age of a cohort has to stay
// visible wherever this is drawn.
export function cohortEconomics(data, cohorts, { margin }) {
  // The pipeline's own total, already carrying the settled splits.
  const cac = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
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

// Forward survival: take everyone active in a month and follow that exact set
// for the next few months.
//
// This is a different question from cohort retention. A cohort curve asks how
// a single intake decays; this asks what the whole base did from a standing
// start, which is the thing that moves the revenue line. A start month only
// counts once its full forward window exists, otherwise the most recent
// months look flattering purely because their losses have not happened yet.
export function forwardSurvival(data, { horizon = 4, windows = 24 } = {}) {
  const activeByMonth = new Map();
  const firstMonth = new Map();

  for (const row of data.customers) {
    if (row.eopMrr === null || row.eopMrr <= 0) continue;
    if (!activeByMonth.has(row.month)) activeByMonth.set(row.month, new Map());
    activeByMonth.get(row.month).set(row.id, row.eopMrr);

    const seen = firstMonth.get(row.id);
    if (seen === undefined || row.month < seen) firstMonth.set(row.id, row.month);
  }

  const months = [...activeByMonth.keys()].sort();
  const last = months[months.length - 1];
  const complete = months.filter(m => monthAdd(m, horizon) <= last);
  const starts = complete.slice(-windows);

  const series = starts.map(month => {
    const base = activeByMonth.get(month);
    const curve = [1];
    for (let k = 1; k <= horizon; k += 1) {
      const later = activeByMonth.get(monthAdd(month, k)) || new Map();
      let kept = 0;
      for (const id of base.keys()) if (later.has(id)) kept += 1;
      curve.push(kept / base.size);
    }
    return { month, n: base.size, curve, survival: curve[horizon] };
  });

  // Pooled survival over a group of start months, weighted by customers
  // rather than by month, so a small month does not count as much as a big one.
  const pool = group => {
    let kept = 0, total = 0;
    for (const month of group) {
      const base = activeByMonth.get(month);
      const later = activeByMonth.get(monthAdd(month, horizon)) || new Map();
      for (const id of base.keys()) { total += 1; if (later.has(id)) kept += 1; }
    }
    return { kept, total, rate: total ? kept / total : null };
  };

  const recentCount = 6;
  const recent = pool(starts.slice(-recentCount));
  const earlier = pool(starts.slice(0, -recentCount));

  // A two proportion z, reported for scale rather than as a verdict. The
  // windows overlap, so these are not independent observations and the true
  // confidence is lower than the number suggests.
  let z = null;
  if (recent.rate !== null && earlier.rate !== null) {
    const se = Math.sqrt(
      (recent.rate * (1 - recent.rate)) / recent.total +
      (earlier.rate * (1 - earlier.rate)) / earlier.total
    );
    z = se ? (recent.rate - earlier.rate) / se : null;
  }

  const byBand = (bands, valueFor) => bands.map(band => {
    let kept = 0, total = 0;
    for (const month of starts) {
      const base = activeByMonth.get(month);
      const later = activeByMonth.get(monthAdd(month, horizon)) || new Map();
      for (const [id, mrr] of base) {
        const value = valueFor(id, mrr, month);
        if (value >= band.lo && value < band.hi) {
          total += 1;
          if (later.has(id)) kept += 1;
        }
      }
    }
    return { ...band, n: total, survival: total ? kept / total : null };
  });

  const mrrBands = byBand([
    { label: 'under $250', lo: 0, hi: 250 },
    { label: '$250 to $500', lo: 250, hi: 500 },
    { label: '$500 to $750', lo: 500, hi: 750 },
    { label: '$750 to $1k', lo: 750, hi: 1000 },
    { label: '$1k to $1.5k', lo: 1000, hi: 1500 },
    { label: 'over $1.5k', lo: 1500, hi: Infinity },
  ], (id, mrr) => mrr);

  const tenureBands = byBand([
    { label: '0 to 6', lo: 0, hi: 6 },
    { label: '6 to 12', lo: 6, hi: 12 },
    { label: '12 to 24', lo: 12, hi: 24 },
    { label: '24 to 48', lo: 24, hi: 48 },
    { label: 'over 48', lo: 48, hi: Infinity },
  ], (id, mrr, month) => monthDiff(firstMonth.get(id), month));

  // Median tenure per revenue band, because the cheapest band turns out to be
  // the oldest and that is what makes it look loyal.
  const medianTenure = mrrBands.map(band => {
    const ages = [];
    for (const month of starts) {
      for (const [id, mrr] of activeByMonth.get(month)) {
        if (mrr >= band.lo && mrr < band.hi) ages.push(monthDiff(firstMonth.get(id), month));
      }
    }
    ages.sort((a, b) => a - b);
    return ages.length ? ages[Math.floor(ages.length / 2)] : null;
  });

  return {
    horizon, starts: series, recent, earlier, z, recentCount,
    mrrBands: mrrBands.map((b, i) => ({ ...b, medianTenure: medianTenure[i] })),
    tenureBands,
    range: starts.length ? [starts[0], starts[starts.length - 1]] : [null, null],
  };
}

export function correlate(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  const sx = Math.sqrt(pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0));
  const sy = Math.sqrt(pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0));
  if (!sx || !sy) return null;
  return pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / (sx * sy);
}

// Retention by era, grouped by the calendar year a cohort started.
//
// Indexed to month 1 rather than month 2. The month 2 rule exists because
// month 1 carries setup and onboarding fees, which distorts revenue
// retention. This curve counts logos, not revenue, so month 1 is simply
// everybody and 100% is the honest starting point.
//
// A point is dropped once fewer than three cohorts in that year have reached
// that age, otherwise the newest line is drawn by its oldest cohort alone.
export function retentionByYear(cohorts, { maxMonths = 12, minCohorts = 3 } = {}) {
  const byYear = new Map();
  for (const cohort of cohorts) {
    const year = cohort.month.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(cohort);
  }

  const years = [...byYear.keys()].sort().slice(-3);

  return years.map(year => {
    const group = byYear.get(year);
    const points = [];
    for (let offset = 0; offset < maxMonths; offset += 1) {
      const inSample = group.filter(c => c.maxOffset >= offset && c.logos[0] > 0);
      if (inSample.length < minCohorts) { points.push(null); continue; }
      const base = inSample.reduce((s, c) => s + c.logos[0], 0);
      points.push(base ? inSample.reduce((s, c) => s + c.logos[offset], 0) / base : null);
    }
    const reached = offset => group.filter(c => c.maxOffset >= offset).length;
    return {
      year,
      cohorts: group.length,
      points,
      month3: points[2],
      month6: points[5],
      reachedMonth6: reached(5),
    };
  });
}

// Projected break-even month per cohort, with a 90% interval.
//
// Cohorts that have already covered their cost report the month they did it.
// That is a fact and carries no interval. The rest are projected forward from
// their last observed month using a revenue retention path, and the interval
// comes from resampling whole donor cohorts rather than from resampling the
// pooled average. The dominant uncertainty is not "what is the average
// retention curve", which 30-odd cohorts pin down tightly, but "how far can
// this particular cohort sit from that average", which is much wider.
//
// The generator is seeded, so moving a slider and moving it back gives the
// same interval rather than a slightly different one each time.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function ratioPath(cohort) {
  const path = new Map();
  for (let k = 1; k < cohort.revenue.length; k += 1) {
    if (cohort.revenue[k - 1] > 0) path.set(k, cohort.revenue[k] / cohort.revenue[k - 1]);
  }
  return path;
}

// Beyond the ages a donor observed, hold its recent average rather than
// letting the path run off the end of the data.
function terminalRate(path, depth = 6) {
  const ages = [...path.keys()].sort((a, b) => a - b).slice(-depth);
  if (!ages.length) return 0.97;
  return ages.reduce((s, k) => s + path.get(k), 0) / ages.length;
}

export function projectedBreakEven(data, cohorts, options) {
  const { csShare, partnershipsShare, margin, replicates = 300, horizon = 120 } = options;
  const cac = cacByMonth(data, { csShare, partnershipsShare });
  const newLogos = new Map(data.waterfall.map(r => [r.month, r.newLogos]));

  // Donors need enough history to lend a trajectory, and recent enough to be
  // lending one from the same regime.
  const donors = cohorts.filter(c => c.month >= '2023-01' && c.maxOffset >= 12);
  const donorPaths = donors.map(ratioPath);
  const donorTerminals = donorPaths.map(p => terminalRate(p));

  const pooled = new Map();
  const numerator = new Map();
  const denominator = new Map();
  for (const cohort of donors) {
    for (let k = 1; k < cohort.revenue.length; k += 1) {
      if (cohort.revenue[k - 1] <= 0) continue;
      numerator.set(k, (numerator.get(k) || 0) + cohort.revenue[k]);
      denominator.set(k, (denominator.get(k) || 0) + cohort.revenue[k - 1]);
    }
  }
  for (const [k, den] of denominator) if (den > 0) pooled.set(k, numerator.get(k) / den);
  const pooledTerminal = terminalRate(pooled);

  const monthsToCover = (cohort, cost, path, terminal) => {
    let cumulative = 0;
    let projected = null;
    for (let k = 0; k < horizon; k += 1) {
      let monthly;
      if (k <= cohort.maxOffset) {
        monthly = cohort.revenue[k];
      } else {
        const step = path.has(k) ? path.get(k) : terminal;
        projected = (projected === null ? cohort.revenue[cohort.maxOffset] : projected) * step;
        monthly = projected;
      }
      cumulative += (monthly * margin) / cohort.size;
      if (cumulative >= cost) return k + 1;
    }
    return null;
  };

  return cohorts.map(cohort => {
    const spend = cac.get(cohort.month);
    const acquired = newLogos.get(cohort.month);
    const cost = (spend === undefined || !acquired) ? null : spend / acquired;
    if (cost === null) return null;

    // What actually happened, using only observed months.
    let cumulative = 0;
    let actual = null;
    for (let k = 0; k <= cohort.maxOffset; k += 1) {
      cumulative += (cohort.revenue[k] * margin) / cohort.size;
      if (cumulative >= cost) { actual = k + 1; break; }
    }

    const base = {
      month: cohort.month, size: cohort.size, cost,
      monthsObserved: cohort.maxOffset + 1, actual,
    };
    if (actual !== null) {
      return { ...base, central: actual, low: null, high: null, neverRate: 0, projected: false };
    }

    const central = monthsToCover(cohort, cost, pooled, pooledTerminal);

    // One seed per cohort, so each row is stable in its own right.
    const rand = seededRandom(Number(cohort.month.replace('-', '')) || 1);
    const hits = [];
    let never = 0;
    for (let i = 0; i < replicates; i += 1) {
      const pick = Math.floor(rand() * donorPaths.length);
      const result = monthsToCover(cohort, cost, donorPaths[pick], donorTerminals[pick]);
      if (result === null) never += 1; else hits.push(result);
    }
    hits.sort((a, b) => a - b);

    const enough = hits.length >= 30;
    return {
      ...base,
      central,
      low: enough ? hits[Math.floor(0.05 * hits.length)] : null,
      high: enough ? hits[Math.min(Math.floor(0.95 * hits.length), hits.length - 1)] : null,
      neverRate: never / replicates,
      projected: true,
    };
  }).filter(Boolean);
}

// Customer Success capacity per customer, against forward churn.
//
// Spend is the only measure of the team available here; headcount is not in
// the pushed data. Salaries track headcount more closely than the total does,
// because bonuses and commissions move with outcomes rather than with staff,
// so both are carried.
//
// Nothing in this function is touched by the Customer Success slider. That
// slider decides how much of the spend counts as acquisition cost, which
// changes CAC. The spend itself is what it is.
export function capacityAnalysis(data, { horizon = 4, windows = 24 } = {}) {
  const activeByMonth = new Map();
  for (const row of data.customers) {
    if (row.eopMrr === null || row.eopMrr <= 0) continue;
    if (!activeByMonth.has(row.month)) activeByMonth.set(row.month, new Set());
    activeByMonth.get(row.month).add(row.id);
  }

  const csTotal = new Map();
  const csSalaries = new Map();
  for (const row of data.expenses) {
    if (row.amount === null || !row.account.includes('Customer Success')) continue;
    csTotal.set(row.month, (csTotal.get(row.month) || 0) + row.amount);
    if (row.account.includes('Salaries')) {
      csSalaries.set(row.month, (csSalaries.get(row.month) || 0) + row.amount);
    }
  }

  const newLogos = new Map(data.waterfall.map(r => [r.month, r.newLogos]));
  const months = [...activeByMonth.keys()].sort();
  const last = months[months.length - 1];

  const points = months
    .filter(m => monthAdd(m, horizon) <= last && csTotal.has(m) && newLogos.get(m) != null)
    .slice(-windows)
    .map(month => {
      const base = activeByMonth.get(month);
      const later = activeByMonth.get(monthAdd(month, horizon)) || new Set();
      let kept = 0;
      for (const id of base) if (later.has(id)) kept += 1;
      return {
        month,
        churn: 1 - kept / base.size,
        newLogos: newLogos.get(month),
        logos: base.size,
        csSpend: csTotal.get(month),
        csPerLogo: csTotal.get(month) / base.size,
        salariesPerLogo: (csSalaries.get(month) || 0) / base.size,
      };
    });

  const churn = points.map(p => p.churn);
  const arrivals = points.map(p => p.newLogos);
  const capacity = points.map(p => p.csPerLogo);
  const clock = points.map((_, i) => i);

  const pair = (xs, ys) => correlate(xs.map((x, i) => [x, ys[i]]));

  // Partial correlation: the association between x and y once z is held
  // constant. Both candidate drivers drift with time, so a raw pairwise
  // number here would be mostly the shared trend.
  const partial = (xs, ys, zs) => {
    const rxy = pair(xs, ys), rxz = pair(xs, zs), ryz = pair(ys, zs);
    if (rxy === null || rxz === null || ryz === null) return null;
    const den = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
    return den ? (rxy - rxz * ryz) / den : null;
  };

  // Momentum: the same correlation computed over a moving window, so a
  // relationship that has faded shows as a line heading for zero rather than
  // hiding inside one pooled number.
  const rolling = (xs, width = 12) => points.map((_, i) => {
    if (i < width - 1) return null;
    const a = xs.slice(i - width + 1, i + 1);
    const b = churn.slice(i - width + 1, i + 1);
    return pair(a, b);
  });

  return {
    points,
    correlations: {
      arrivals: pair(arrivals, churn),
      capacity: pair(capacity, churn),
      salaries: pair(points.map(p => p.salariesPerLogo), churn),
      time: pair(clock, churn),
      arrivalsGivenCapacity: partial(arrivals, churn, capacity),
      capacityGivenArrivals: partial(capacity, churn, arrivals),
      arrivalsGivenTime: partial(arrivals, churn, clock),
      capacityGivenTime: partial(capacity, churn, clock),
    },
    rollingArrivals: rolling(arrivals),
    rollingCapacity: rolling(capacity),
    rollingWidth: 12,
  };
}

// The same window, this year against one and two years ago.
//
// Take everybody active in a month and follow that exact set forward. Do it
// for the most recent month whose window has fully elapsed, then for the same
// month twelve and twenty four months earlier. Comparing like calendar
// positions keeps seasonality out of the answer: a trade business does not
// churn evenly through the year, so March against March says more than March
// against the average of everything.
export function seasonalSurvival(data, { horizon = 4 } = {}) {
  const mrrByMonth = new Map();
  for (const row of data.customers) {
    if (row.eopMrr === null || row.eopMrr <= 0) continue;
    if (!mrrByMonth.has(row.month)) mrrByMonth.set(row.month, new Map());
    mrrByMonth.get(row.month).set(row.id, row.eopMrr);
  }

  const months = [...mrrByMonth.keys()].sort();
  const last = months[months.length - 1];

  // Only a window that has fully elapsed can be drawn. Anything shorter would
  // flatter the most recent line, because its losses have not happened yet.
  const complete = months.filter(m => monthAdd(m, horizon) <= last);
  if (!complete.length) return { horizon, anchor: null, series: [] };

  const anchor = complete[complete.length - 1];

  const series = [24, 12, 0].map(back => {
    const start = monthAdd(anchor, -back);
    const base = mrrByMonth.get(start);
    if (!base || !base.size) return null;

    const startMrr = [...base.values()].reduce((s, v) => s + v, 0);
    const curve = [1];
    const revenueCurve = [1];

    for (let k = 1; k <= horizon; k += 1) {
      const later = mrrByMonth.get(monthAdd(start, k));
      if (!later) { curve.push(null); revenueCurve.push(null); continue; }

      let kept = 0;
      let keptMrr = 0;
      for (const id of base.keys()) {
        const now = later.get(id);
        if (now !== undefined) { kept += 1; keptMrr += now; }
      }
      curve.push(kept / base.size);
      // Revenue of the same fixed set, so a survivor who expanded lifts this
      // above the logo line. No new customers enter it.
      revenueCurve.push(startMrr ? keptMrr / startMrr : null);
    }

    return {
      month: start,
      monthsBack: back,
      n: base.size,
      startMrr,
      curve,
      revenueCurve,
      survival: curve[horizon],
      revenueRetention: revenueCurve[horizon],
    };
  }).filter(Boolean);

  return { horizon, anchor, series };
}

// Survival by revenue band, stratified by tenure.
//
// Unstratified, the cheapest band looks the most loyal, and it is not: it is
// simply the oldest. Noting that in a caption leaves a chart arguing with its
// own note, so the comparison is made inside tenure bands where the confound
// is held constant.
export function survivalByRevenueWithinTenure(data, { horizon = 4, windows = 24 } = {}) {
  const activeByMonth = new Map();
  const firstMonth = new Map();
  for (const row of data.customers) {
    if (row.eopMrr === null || row.eopMrr <= 0) continue;
    if (!activeByMonth.has(row.month)) activeByMonth.set(row.month, new Map());
    activeByMonth.get(row.month).set(row.id, row.eopMrr);
    const seen = firstMonth.get(row.id);
    if (seen === undefined || row.month < seen) firstMonth.set(row.id, row.month);
  }

  const months = [...activeByMonth.keys()].sort();
  const last = months[months.length - 1];
  const starts = months.filter(m => monthAdd(m, horizon) <= last).slice(-windows);

  const revenueBands = [
    { label: 'under $500', lo: 0, hi: 500 },
    { label: '$500 to $1k', lo: 500, hi: 1000 },
    { label: 'over $1k', lo: 1000, hi: Infinity },
  ];
  const tenureBands = [
    { label: 'first year', lo: 0, hi: 12 },
    { label: 'one to two years', lo: 12, hi: 24 },
    { label: 'over two years', lo: 24, hi: Infinity },
  ];

  const cells = tenureBands.map(tenure => ({
    tenure: tenure.label,
    bands: revenueBands.map(band => {
      let kept = 0, total = 0;
      for (const month of starts) {
        const later = activeByMonth.get(monthAdd(month, horizon)) || new Map();
        for (const [id, mrr] of activeByMonth.get(month)) {
          const age = monthDiff(firstMonth.get(id), month);
          if (mrr >= band.lo && mrr < band.hi && age >= tenure.lo && age < tenure.hi) {
            total += 1;
            if (later.has(id)) kept += 1;
          }
        }
      }
      return { label: band.label, n: total, survival: total ? kept / total : null };
    }),
  }));

  return { revenueBands, tenureBands, cells, starts: starts.length };
}
