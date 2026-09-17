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
const OPTIONAL_TABS = ['QB Accounts', 'Subscription Lifetimes', 'Migration Key',
  'New Customer Cohorts'];

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
  const lifetimeRecords = [];
  const lifetimeTab = byTab['Subscription Lifetimes'];
  if (lifetimeTab) {
    const find = pattern => lifetimeTab.columns.find(c => pattern.test(c || ''));
    const idKey = find(/stripe customer id/i);
    const startKey = find(/start date/i);
    const endKey = find(/end date/i);
    const statusKey = find(/status/i);
    const nameKey = find(/^account$/i);

    if (idKey && startKey) {
      for (const row of lifetimeTab.rows) {
        const id = row[idKey];
        if (!id) continue;
        const startFull = String(row[startKey] || '').slice(0, 10);
        const endFull = endKey ? String(row[endKey] || '').slice(0, 10) : '';
        const start = startFull.slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(start)) lifetimes.set(id, start);
        lifetimeRecords.push({
          id,
          start: startFull,
          end: endFull,
          status: statusKey ? row[statusKey] : null,
          account: nameKey ? row[nameKey] : null,
        });
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
      canonicalId: r.canonical_id || null,
      month: r.month,
      eopMrr: num(r.eop_mrr),
      usage: num(r.usage_revenue) || 0,
      oneTime: num(r.onetime_revenue) || 0,
      passThrough: num(r.passthrough_revenue) || 0,
      recognisedElsewhere: num(r.recognised_elsewhere_revenue) || 0,
    }));

  // What a customer was sold, as opposed to what they have paid since. The
  // three columns this was meant to denormalise into the waterfall arrive
  // empty, so it is joined on customer_id instead.
  const signups = [];
  const signupTab = byTab['New Customer Cohorts'];
  if (signupTab) {
    const monthOf = value => {
      const text = String(value || '').trim();
      const slashed = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (slashed) return `${slashed[3]}-${String(slashed[1]).padStart(2, '0')}`;
      return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : null;
    };
    for (const row of signupTab.rows) {
      const month = monthOf(row.cohort_month);
      if (!month || !row.customer_id) continue;
      signups.push({
        id: row.customer_id,
        name: row.customer_name || null,
        month,
        startingMrr: num(row.starting_mrr) || 0,
        platformMrr: num(row.platform_mrr) || 0,
        upgradeMrr: num(row.upgrade_mrr) || 0,
        firstPayment: num(row.first_payment) || 0,
        nonMrr: num(row.non_mrr_amount) || 0,
        setupFee: num(row.setup_fee) || 0,
        startType: String(row.start_type || '').trim().toLowerCase() || null,
        status: row.subscription_status || null,
        state: row.current_state || null,
        canceledAt: row.canceled_at || null,
      });
    }
  }

  const migrationKey = new Map();
  const keyTab = byTab['Migration Key'];
  if (keyTab) {
    const idKey = keyTab.columns.find(c => /customer_id/i.test(c || ''));
    const acctKey = keyTab.columns.find(c => /^account$/i.test(c || ''));
    if (idKey && acctKey) {
      for (const row of keyTab.rows) {
        if (row[idKey] && row[acctKey]) migrationKey.set(row[idKey], String(row[acctKey]));
      }
    }
  }

  return {
    pushedAt: index.pushed_at || null,
    waterfall,
    cacMonthly,
    expenses,
    customers,
    lifetimes,
    lifetimeRecords,
    signups,
    migrationKey,
    missingTabs: missing,
    lastMonth: waterfall.length ? waterfall[waterfall.length - 1].month : null,
  };
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
  const rowByCustomerMonth = new Map();

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
    rowByCustomerMonth.set(row.id + '|' + row.month, row);
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
    const profit = [];
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const at = monthAdd(month, offset);
      let live = 0;
      let mrr = 0;
      let gp = 0;
      for (const id of ids) {
        if (activeByCustomer.get(id).has(at)) {
          live += 1;
          const row = rowByCustomerMonth.get(id + '|' + at);
          mrr += row ? (row.eopMrr || 0) : 0;
          gp += row ? grossProfit(row) : 0;
        }
      }
      logos.push(live);
      revenue.push(mrr);
      profit.push(gp);
    }

    return { month, size: logos[0] || ids.length, ids, logos, revenue, profit, maxOffset };
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
// The month a cohort covered its cost, using observed data only.
//
// Both the cohort table and the break-even projection need this, and when
// each had its own copy they disagreed on 2025-09 by a month, because one
// tested cumulative over cost against one and the other tested cumulative
// against cost. Floating point makes those different questions at the
// boundary. One implementation, one answer.
export function observedPayback(cohort, cost, margin) {
  if (!cost) return null;
  let cumulative = 0;
  for (let k = 0; k <= cohort.maxOffset; k += 1) {
    const gp = cohort.profit ? cohort.profit[k] : cohort.revenue[k] * margin;
    cumulative += gp / cohort.size;
    if (cumulative >= cost) return k + 1;
  }
  return null;
}

export function cohortEconomics(data, cohorts, { margin }) {
  // The pipeline's own total, already carrying the settled splits.
  const cac = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const newLogosByMonth = new Map(data.waterfall.map(r => [r.month, r.newLogos]));
  // Where the pipeline reports a cost per logo it is preferred outright: it
  // uses the SaaS dashboard's own logo count, which is the figure the business
  // reports. That only covers 2026, so earlier months fall back to the total
  // over the waterfall's new logos rather than being blanked, because blanking
  // them would remove every cohort old enough to have paid back.
  const reportedPerLogo = new Map(
    data.cacMonthly.filter(r => r.cacPerLogo !== null).map(r => [r.month, r.cacPerLogo]));
  const reportedLogosByMonth = new Map(
    data.cacMonthly.filter(r => r.reportedNewLogos !== null)
      .map(r => [r.month, r.reportedNewLogos]));

  return cohorts.map(cohort => {
    const spend = cac.get(cohort.month);
    const acquired = newLogosByMonth.get(cohort.month);

    // Cost per logo needs a real denominator. A cohort month with no recorded
    // new logos has no cost per logo, and forcing one would invent a number.
    const reported = reportedPerLogo.get(cohort.month);
    const costPerLogo = reported !== undefined
      ? reported
      : ((spend === undefined || !acquired) ? null : spend / acquired);
    const costBasis = reported !== undefined ? 'reported' : 'derived';

    let running = 0;
    // Per class where the push carries the classes, flat margin otherwise.
    const monthly = cohort.profit && cohort.profit.length ? cohort.profit : null;
    const cumulativeGpPerLogo = cohort.revenue.map((mrr, i) => {
      const gp = monthly ? monthly[i] : mrr * margin;
      running += gp / cohort.size;
      return running;
    });

    const recovery = costPerLogo === null
      ? []
      : cumulativeGpPerLogo.map(gp => gp / costPerLogo);

    const payback = observedPayback(cohort, costPerLogo, margin);

    return {
      month: cohort.month,
      size: cohort.size,
      maxOffset: cohort.maxOffset,
      costPerLogo,
      costBasis,
      // Three counts of the same thing, carried together so no chart can
      // silently divide by one while labelling another.
      cohortLogos: cohort.size,
      waterfallLogos: acquired ?? null,
      reportedLogos: reportedLogosByMonth.get(cohort.month) ?? null,
      costDivisor: reportedLogosByMonth.has(cohort.month) ? 'reported' : 'waterfall',
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
  const cac = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const reportedPerLogo = new Map(
    data.cacMonthly.filter(r => r.cacPerLogo !== null).map(r => [r.month, r.cacPerLogo]));
  const reportedLogosByMonth = new Map(
    data.cacMonthly.filter(r => r.reportedNewLogos !== null)
      .map(r => [r.month, r.reportedNewLogos]));
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

  // Observed months use the same per class gross profit as the cohort table.
  // Projected months have no class breakdown to work from, so they carry the
  // cohort's own realised profit margin forward rather than a flat assumption,
  // which keeps the two halves of a single curve on one definition.
  const monthsToCover = (cohort, cost, path, terminal) => {
    const observedRevenue = cohort.revenue
      .slice(0, cohort.maxOffset + 1).reduce((s, v) => s + v, 0);
    const observedProfit = (cohort.profit || [])
      .slice(0, cohort.maxOffset + 1).reduce((s, v) => s + v, 0);
    const effective = observedRevenue > 0 ? observedProfit / observedRevenue : margin;

    let cumulative = 0;
    let projected = null;
    for (let k = 0; k < horizon; k += 1) {
      let gp;
      if (k <= cohort.maxOffset) {
        gp = cohort.profit ? cohort.profit[k] : cohort.revenue[k] * margin;
      } else {
        const step = path.has(k) ? path.get(k) : terminal;
        projected = (projected === null ? cohort.revenue[cohort.maxOffset] : projected) * step;
        gp = projected * effective;
      }
      cumulative += gp / cohort.size;
      if (cumulative >= cost) return k + 1;
    }
    return null;
  };

  return cohorts.map(cohort => {
    const spend = cac.get(cohort.month);
    const acquired = newLogos.get(cohort.month);
    // The same rule as cohortEconomics. Two cost-per-logo figures on one page
    // was how a third denominator appeared out of nowhere.
    const reported = reportedPerLogo.get(cohort.month);
    const cost = reported !== undefined
      ? reported
      : ((spend === undefined || !acquired) ? null : spend / acquired);
    if (cost === null) return null;

    // What actually happened, using only observed months. Same function the
    // cohort table uses, so the two cannot drift apart.
    const actual = observedPayback(cohort, cost, margin);

    const base = {
      month: cohort.month, size: cohort.size, cost,
      cohortLogos: cohort.size,
      waterfallLogos: acquired ?? null,
      reportedLogos: reportedLogosByMonth.get(cohort.month) ?? null,
      costDivisor: reported !== undefined ? 'reported' : 'waterfall',
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

  // Customer Success is only part of the function that keeps customers.
  // Technical Account Manager and Support sit beside it, and they have moved
  // in different directions, so measuring Customer Success alone measures
  // roughly half the department and reads the trend of that half as the
  // trend of the whole.
  const RETENTION_TEAMS = ['Customer Success', 'Technical Account Manager', 'Support'];
  const csTotal = new Map();
  const csSalaries = new Map();
  const teamTotals = new Map(RETENTION_TEAMS.map(name => [name, new Map()]));
  const retentionTotal = new Map();

  for (const row of data.expenses) {
    if (row.amount === null) continue;
    const team = RETENTION_TEAMS.find(name => row.account.includes(name));
    if (!team) continue;

    const bucket = teamTotals.get(team);
    bucket.set(row.month, (bucket.get(row.month) || 0) + row.amount);
    retentionTotal.set(row.month, (retentionTotal.get(row.month) || 0) + row.amount);

    if (team === 'Customer Success') {
      csTotal.set(row.month, (csTotal.get(row.month) || 0) + row.amount);
      if (row.account.includes('Salaries')) {
        csSalaries.set(row.month, (csSalaries.get(row.month) || 0) + row.amount);
      }
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
        retentionSpend: retentionTotal.get(month) || 0,
        retentionPerLogo: (retentionTotal.get(month) || 0) / base.size,
        teams: Object.fromEntries(RETENTION_TEAMS.map(name =>
          [name, teamTotals.get(name).get(month) || 0])),
      };
    });

  const churn = points.map(p => p.churn);
  const arrivals = points.map(p => p.newLogos);
  const capacity = points.map(p => p.csPerLogo);
  const wholeFunction = points.map(p => p.retentionPerLogo);
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
      wholeFunction: pair(wholeFunction, churn),
      wholeFunctionGivenTime: partial(wholeFunction, churn, clock),
      salaries: pair(points.map(p => p.salariesPerLogo), churn),
      time: pair(clock, churn),
      arrivalsGivenCapacity: partial(arrivals, churn, capacity),
      capacityGivenArrivals: partial(capacity, churn, arrivals),
      arrivalsGivenTime: partial(arrivals, churn, clock),
      capacityGivenTime: partial(capacity, churn, clock),
    },
    teams: RETENTION_TEAMS,
    rollingArrivals: rolling(arrivals),
    rollingCapacity: rolling(capacity),
    rollingWholeFunction: rolling(wholeFunction),
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

// Reconciliation, rebuilt from what the Logo Evidence tab used to carry.
//
// Walks from what this build derives to what the business reports, naming
// each difference rather than plugging it. The unexplained line is stated. A
// large one is worth more than a matching total, because it means something
// neither system knows about has been found.
export function reconciliation(data, cohorts) {
  const firstSeen = new Map();
  const firstRevenue = new Map();
  const companyName = new Map();
  const source = new Map();

  for (const row of data.customers) {
    const seen = firstSeen.get(row.id);
    if (seen === undefined || row.month < seen) firstSeen.set(row.id, row.month);
    if (row.eopMrr !== null && row.eopMrr > 0) {
      const rev = firstRevenue.get(row.id);
      if (rev === undefined || row.month < rev) firstRevenue.set(row.id, row.month);
    }
    if (row.name) companyName.set(row.id, row.name.trim().toLowerCase());
    if (row.source && !source.has(row.id)) source.set(row.id, row.source);
  }

  // A customer signed but sitting at zero for a while: the month they first
  // carried revenue is later than the month they first appear.
  const lagByMonth = new Map();
  for (const [id, revMonth] of firstRevenue) {
    if (firstSeen.get(id) < revMonth) {
      lagByMonth.set(revMonth, (lagByMonth.get(revMonth) || 0) + 1);
    }
  }

  // One business carried across both Stripe environments is one relationship,
  // not a churn plus a new logo. Matched on company name, which is the only
  // handle the pushed data offers and is therefore a floor rather than a count.
  const byName = new Map();
  for (const [id, name] of companyName) {
    if (!name || !firstRevenue.has(id)) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(id);
  }
  const pairByMonth = new Map();
  let pairsFound = 0;
  for (const ids of byName.values()) {
    if (ids.length < 2) continue;
    if (new Set(ids.map(i => source.get(i))).size < 2) continue;
    pairsFound += 1;
    const starts = ids.map(i => firstRevenue.get(i)).sort();
    for (const later of starts.slice(1)) {
      pairByMonth.set(later, (pairByMonth.get(later) || 0) + 1);
    }
  }

  const neverPaidIds = [...firstSeen.keys()].filter(id => !firstRevenue.has(id));
  const neverPaid = neverPaidIds.length;
  const neverPaidWithSubscription = neverPaidIds.filter(id => data.lifetimes?.has(id)).length;

  const derivedByMonth = new Map();
  for (const cohort of cohorts) derivedByMonth.set(cohort.month, cohort.size);
  const waterfallByMonth = new Map(data.waterfall.map(r => [r.month, r.newLogos]));

  const censoredByMonth = cohorts.windowStart
    ? new Map([[cohorts.windowStart, cohorts.censoredCount || 0]])
    : new Map();

  const rows = data.cacMonthly
    .filter(r => r.reportedNewLogos !== null)
    .map(r => {
      const derived = derivedByMonth.get(r.month) || 0;
      const censored = censoredByMonth.get(r.month) || 0;
      const pairs = pairByMonth.get(r.month) || 0;
      const lag = lagByMonth.get(r.month) || 0;
      const walked = derived - censored - pairs + lag;
      return {
        month: r.month,
        derived,
        waterfall: waterfallByMonth.get(r.month) ?? null,
        censored,
        pairs,
        lag,
        walked,
        reported: r.reportedNewLogos,
        unexplained: r.reportedNewLogos - walked,
      };
    });

  return { rows, neverPaid, neverPaidWithSubscription, pairsFound, totalCustomers: firstSeen.size };
}

// Gross profit by revenue class.
//
// Pass-through is carrier fees. They sit in revenue and in cost of sales at
// once, so any margin applied to them credits profit that does not exist.
// Recognised-elsewhere is a buyout or prepayment whose monthly value is
// already carried by a couponed subscription, so counting it again double
// counts.
//
// The identified classes are carved out of recognised MRR and the remainder
// is treated as platform. One-time revenue is not MRR, so it is added rather
// than carved out. That decomposition is an inference from the shape of the
// data, not something the push states, and it is written on the page so it
// can be corrected rather than assumed.
export const CLASS_MARGINS = {
  platform: 0.757,
  usage: 0.60,
  oneTime: 0.90,
  passThrough: 0,
  recognisedElsewhere: 0,
};

export function grossProfit(row, margins = CLASS_MARGINS) {
  const mrr = row.eopMrr || 0;
  const carved = (row.usage || 0) + (row.passThrough || 0) + (row.recognisedElsewhere || 0);
  const platform = Math.max(0, mrr - carved);
  return platform * margins.platform
    + (row.usage || 0) * margins.usage
    + (row.oneTime || 0) * margins.oneTime
    + (row.passThrough || 0) * margins.passThrough
    + (row.recognisedElsewhere || 0) * margins.recognisedElsewhere;
}

export function hasRevenueClasses(data) {
  return data.customers.some(r => r.usage || r.oneTime || r.passThrough);
}

// How much of the derived new logo count comes from each Stripe environment.
//
// The second environment is where new business has been moving, and its
// customers are largely not reaching the cohort build: they appear in the
// file and never register revenue. That makes any statement about new logo
// volume a statement about the first environment, which is a different and
// much gloomier claim than the one it looks like.
export function environmentSplit(data) {
  const firstRevenue = new Map();
  const source = new Map();
  const everRevenue = new Set();

  for (const row of data.customers) {
    if (row.source && !source.has(row.id)) source.set(row.id, row.source);
    if (row.eopMrr === null || row.eopMrr <= 0) continue;
    everRevenue.add(row.id);
    const seen = firstRevenue.get(row.id);
    if (seen === undefined || row.month < seen) firstRevenue.set(row.id, row.month);
  }

  const byMonth = new Map();
  for (const [id, month] of firstRevenue) {
    if (!byMonth.has(month)) byMonth.set(month, { S1: 0, S2: 0, other: 0 });
    const bucket = byMonth.get(month);
    const env = source.get(id);
    if (env === 'S1') bucket.S1 += 1;
    else if (env === 'S2') bucket.S2 += 1;
    else bucket.other += 1;
  }

  const environments = new Map();
  for (const [id, env] of source) {
    if (!environments.has(env)) environments.set(env, { present: 0, withRevenue: 0 });
    const e = environments.get(env);
    e.present += 1;
    if (everRevenue.has(id)) e.withRevenue += 1;
  }

  return { byMonth, environments };
}

// Customers who cancelled within a month of signing.
//
// These are counted as new at full rate in the month they signed and are
// gone before they ever contributed. Worth seeing on their own, and worth
// seeing by end date rather than only by volume: several cancellations
// landing on one day is usually one account being closed rather than several
// independent decisions, and that is a different problem.
export function quickCancellations(data, { withinDays = 30 } = {}) {
  const parse = value => {
    const text = String(value || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text + 'T00:00:00Z') : null;
  };

  const cancelled = [];
  for (const record of data.lifetimeRecords || []) {
    const start = parse(record.start);
    const end = parse(record.end);
    if (!start || !end) continue;
    const days = Math.round((end - start) / 86400000);
    if (days >= 0 && days <= withinDays) {
      cancelled.push({ ...record, days, month: record.start.slice(0, 7) });
    }
  }

  const byMonth = new Map();
  for (const row of cancelled) {
    byMonth.set(row.month, (byMonth.get(row.month) || 0) + 1);
  }

  // Same-day clusters, which are the tell that these are not independent.
  const byEndDate = new Map();
  for (const row of cancelled) {
    if (!byEndDate.has(row.end)) byEndDate.set(row.end, []);
    byEndDate.get(row.end).push(row);
  }
  const clusters = [...byEndDate.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([date, rows]) => ({ date, count: rows.length }))
    .sort((a, b) => b.count - a.count);

  const totalWithLifetime = (data.lifetimeRecords || []).length;

  return { cancelled, byMonth, clusters, withinDays, totalWithLifetime };
}

// Price at signup against volume.
//
// The page has been telling the volume half of this as though it were the
// whole story. Fewer customers at a higher price is a different business from
// fewer customers, and only one of those is a demand problem.
export function signupEconomics(data, { dropTrailing = true } = {}) {
  const rows = data.signups || [];
  if (!rows.length) return { months: [], startTypes: [], total: 0 };

  const byMonth = new Map();
  for (const row of rows) {
    if (!byMonth.has(row.month)) byMonth.set(row.month, []);
    byMonth.get(row.month).push(row);
  }

  let months = [...byMonth.keys()].sort();
  // The last month is thin enough to be a partial pull rather than a fall.
  if (dropTrailing && months.length > 1) {
    const last = byMonth.get(months[months.length - 1]);
    const previous = byMonth.get(months[months.length - 2]);
    if (last.length < previous.length * 0.4) months = months.slice(0, -1);
  }

  const series = months.map(month => {
    const group = byMonth.get(month);
    const startingMrr = group.reduce((s, r) => s + r.startingMrr, 0);
    const withFee = group.filter(r => r.setupFee > 0);
    const feeTotal = withFee.reduce((s, r) => s + r.setupFee, 0);
    const paidBelow = group.filter(r => r.firstPayment < r.startingMrr).length;
    return {
      month,
      count: group.length,
      startingMrr,
      averagePrice: group.length ? startingMrr / group.length : null,
      attachRate: group.length ? withFee.length / group.length : null,
      averageFee: withFee.length ? feeTotal / withFee.length : null,
      feeTotal,
      firstPayment: group.reduce((s, r) => s + r.firstPayment, 0),
      paidBelow,
      byType: group.reduce((acc, r) => {
        const key = r.startType || 'unclassified';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    };
  });

  const startTypes = [...new Set(rows.map(r => r.startType || 'unclassified'))];
  const typeTotals = startTypes.map(type => {
    const group = rows.filter(r => (r.startType || 'unclassified') === type);
    return {
      type,
      customers: group.length,
      startingMrr: group.reduce((s, r) => s + r.startingMrr, 0),
    };
  }).sort((a, b) => b.customers - a.customers);

  const below = rows.filter(r => r.firstPayment < r.startingMrr);

  return {
    months: series,
    startTypes,
    typeTotals,
    total: rows.length,
    paidBelow: { customers: below.length, startingMrr: below.reduce((s, r) => s + r.startingMrr, 0) },
  };
}

// Signup price is fixed; current MRR moves with expansion and contraction, so
// banding on what a customer was sold is a cleaner question than banding on
// what they pay now. Still stratified by tenure, because tenure is the
// stronger effect and would otherwise do the work.
export function retentionBySignupPrice(data, { horizon = 4, windows = 24 } = {}) {
  const priceOf = new Map((data.signups || []).map(r => [r.id, r.startingMrr]));
  if (!priceOf.size) return null;

  const activeByMonth = new Map();
  const firstMonth = new Map();
  for (const row of data.customers) {
    if (row.eopMrr === null || row.eopMrr <= 0) continue;
    if (!activeByMonth.has(row.month)) activeByMonth.set(row.month, new Set());
    activeByMonth.get(row.month).add(row.id);
    const seen = firstMonth.get(row.id);
    if (seen === undefined || row.month < seen) firstMonth.set(row.id, row.month);
  }

  const months = [...activeByMonth.keys()].sort();
  const last = months[months.length - 1];
  const starts = months.filter(m => monthAdd(m, horizon) <= last).slice(-windows);

  const bands = [
    { label: 'under $750', lo: 0, hi: 750 },
    { label: '$750 to $1.5k', lo: 750, hi: 1500 },
    { label: 'over $1.5k', lo: 1500, hi: Infinity },
  ];
  const tenures = [
    { label: 'first year', lo: 0, hi: 12 },
    { label: 'over a year', lo: 12, hi: Infinity },
  ];

  const cells = tenures.map(tenure => ({
    tenure: tenure.label,
    bands: bands.map(band => {
      let kept = 0, total = 0;
      for (const month of starts) {
        const later = activeByMonth.get(monthAdd(month, horizon)) || new Set();
        for (const id of activeByMonth.get(month)) {
          const price = priceOf.get(id);
          if (price === undefined) continue;
          const age = monthDiff(firstMonth.get(id), month);
          if (price >= band.lo && price < band.hi && age >= tenure.lo && age < tenure.hi) {
            total += 1;
            if (later.has(id)) kept += 1;
          }
        }
      }
      return { label: band.label, n: total, survival: total ? kept / total : null };
    }),
  }));

  return { bands, cells, matched: priceOf.size };
}

// Does price predict retention, once the cohort is held constant?
//
// This has to be asked within a cohort and not across the book. Price rose
// over the period and retention fell over the period, so pooling customers
// from different months lets the era masquerade as the price: the dearest
// customers are disproportionately the most recent, and the most recent
// retain worst whatever they pay.
//
// Comparing each customer only against others who signed in the same month
// removes that entirely. The comparisons are then pooled by customer count,
// which is the Mantel-Haenszel shape: many small within-stratum contrasts
// rather than one large confounded one.
//
// First-month recognised MRR stands in for the price. The signup source knows
// what was sold but only covers 2026, which is exactly the window where price
// and era are most tangled. The proxy reaches back to 2018 and agrees with
// the signup figure for 86% of the customers that have both.
export function priceAgainstRetention(data, { ages = [3, 6, 12], minCohort = 16 } = {}) {
  const active = new Map();
  const firstMonth = new Map();
  const firstMrr = new Map();

  for (const row of data.customers) {
    if (row.eopMrr === null || row.eopMrr <= 0) continue;
    if (!active.has(row.month)) active.set(row.month, new Set());
    active.get(row.month).add(row.id);
    const seen = firstMonth.get(row.id);
    if (seen === undefined || row.month < seen) {
      firstMonth.set(row.id, row.month);
      firstMrr.set(row.id, row.eopMrr);
    }
  }

  const last = [...active.keys()].sort().pop();
  const byCohort = new Map();
  for (const [id, month] of firstMonth) {
    if (!firstMrr.get(id)) continue;
    if (!byCohort.has(month)) byCohort.set(month, []);
    byCohort.get(month).push(id);
  }

  const cohorts = [...byCohort.keys()].sort().filter(m => m >= '2024-01');

  const results = ages.map(age => {
    let keptLow = 0, totalLow = 0, keptHigh = 0, totalHigh = 0, used = 0, dearerWon = 0;

    for (const month of cohorts) {
      const target = monthAdd(month, age);
      if (target > last) continue;
      const ids = byCohort.get(month);
      if (ids.length < minCohort) continue;

      const sorted = [...ids].sort((a, b) => firstMrr.get(a) - firstMrr.get(b));
      const median = firstMrr.get(sorted[Math.floor(sorted.length / 2)]);
      const low = ids.filter(id => firstMrr.get(id) <= median);
      const high = ids.filter(id => firstMrr.get(id) > median);
      if (low.length < 6 || high.length < 6) continue;

      const survivors = new Set(active.get(target) || []);
      const kl = low.filter(id => survivors.has(id)).length;
      const kh = high.filter(id => survivors.has(id)).length;

      used += 1;
      keptLow += kl; totalLow += low.length;
      keptHigh += kh; totalHigh += high.length;
      if (kh / high.length > kl / low.length) dearerWon += 1;
    }

    if (!used) return null;
    const pLow = keptLow / totalLow;
    const pHigh = keptHigh / totalHigh;
    const se = Math.sqrt(pLow * (1 - pLow) / totalLow + pHigh * (1 - pHigh) / totalHigh);
    return {
      age, pLow, pHigh, totalLow, totalHigh, cohorts: used, dearerWon,
      gap: (pHigh - pLow) * 100,
      z: se ? (pHigh - pLow) / se : null,
    };
  }).filter(Boolean);

  return { results, cohortsConsidered: cohorts.length };
}

// New arrivals against forward churn, at a chosen horizon.
//
// The horizon is the whole question here. A thin month and a bad month can be
// the same month for reasons that have nothing to do with each other, and
// whether that shows up depends entirely on how far forward you look. Asking
// it at one fixed window and reporting a single number hides that.
//
// The slope is reported per ten fewer arrivals with a 95% interval, because a
// correlation coefficient on two dozen points is easy to over-read and an
// interval that straddles zero says plainly that nothing has been measured.
export function arrivalsAgainstChurn(data, { horizon = 4, windows = 24 } = {}) {
  const active = new Map();
  for (const row of data.customers) {
    if (row.eopMrr === null || row.eopMrr <= 0) continue;
    if (!active.has(row.month)) active.set(row.month, new Set());
    active.get(row.month).add(row.id);
  }

  const arrivals = new Map(data.waterfall.map(r => [r.month, r.newLogos]));
  const all = [...active.keys()].sort();
  const last = all[all.length - 1];

  // Anchor every horizon to the same starting months.
  //
  // A longer horizon needs more elapsed time, so taking "the last 24 complete
  // windows" at each setting slides the period backwards as the slider moves:
  // one month covers 2024-08 to 2026-07, six months covers 2024-03 to 2026-02.
  // Moving the slider would then change the horizon and the period together,
  // and the effect that appeared at one month turned out to be carried by the
  // five recent thin-intake months that only the short horizons could see.
  // Comparing like with like costs a few months of sample and is worth it.
  const maxHorizon = 6;
  const eligible = hz => all.filter(m => monthAdd(m, hz) <= last && arrivals.get(m) != null);
  const anchor = new Set(eligible(maxHorizon).slice(-windows));
  const months = eligible(horizon).filter(m => anchor.has(m));

  const points = months.map(month => {
    const base = active.get(month);
    const later = active.get(monthAdd(month, horizon)) || new Set();
    let kept = 0;
    for (const id of base) if (later.has(id)) kept += 1;
    return { month, x: arrivals.get(month), y: 1 - kept / base.size, base: base.size };
  });

  const n = points.length;
  if (n < 4) return { horizon, points, n, r: null, slope: null, low: null, high: null };

  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const syy = points.reduce((s, p) => s + (p.y - my) ** 2, 0);
  const sxy = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);

  const r = (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : null;
  const b = sxx ? sxy / sxx : 0;
  const residual = points.reduce((s, p) => s + (p.y - (my + b * (p.x - mx))) ** 2, 0);
  const se = (n > 2 && sxx) ? Math.sqrt(residual / (n - 2) / sxx) : 0;

  // Expressed as the churn effect of ten FEWER arrivals, which is the
  // direction the question is actually asked in.
  const perTenFewer = -b * 10 * 100;
  const half = 1.96 * se * 10 * 100;

  return {
    horizon, points, n, r,
    slope: perTenFewer,
    low: perTenFewer - Math.abs(half),
    high: perTenFewer + Math.abs(half),
    significant: (perTenFewer - Math.abs(half)) * (perTenFewer + Math.abs(half)) > 0,
  };
}
