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

// How far back anything on this page is allowed to reach. A hard limit rather
// than a per chart window, applied once where the data is read, so no chart
// can quietly reach further: several of the findings here turned on exactly
// that, where a longer reach pulled in an era that behaved differently and the
// extra months did the work.
//
// Set to land on 2024-01, which is not a preference but a floor. The finance
// tabs — QB Expenses, Serve Monthly and CAC Monthly — all begin there, so a
// cohort older than that has revenue and no denominator. The customer file
// itself runs back to 2018-12 and is clean well before 2024 (its live counts
// match the summary exactly in every month checked), so the day the ledger
// reaches further back, this number is the only thing that has to move.
const MONTHS_OF_HISTORY = 32;

function earliestMonth(reference = CURRENT_MONTH) {
  const [year, month] = reference.split('-').map(Number);
  const total = year * 12 + (month - 1) - MONTHS_OF_HISTORY;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export const HISTORY_STARTS = earliestMonth();

// The event types that mean a customer was in the base that month. 'churn' is
// the month they left and 'inactive' is a row carried for a customer who was
// not there at all, so neither counts. Anything else is presence, whether or
// not money moved.
export const LIVE_EVENTS = new Set([
  'new', 'reactivation', 'flat', 'expansion', 'contraction',
]);

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
const OPTIONAL_TABS = ['QB Accounts', 'Subscription Lifetimes', 'New Customer Cohorts',
  'Serve Monthly', 'Event Costs'];

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

  // One gate for every tab: after the window opens, before the month that is
  // still accruing.
  const inWindow = month => month && month >= HISTORY_STARTS && month < CURRENT_MONTH;
  const complete = rows => rows.filter(r => inWindow(r.month));

  // What it costs to keep a logo, as opposed to winning one. The revenue side
  // of this tab is not populated, so arpa and every contribution column in it
  // are null; the costs are real and are what the build uses. Contribution is
  // computed here from the base's own MRR instead, which is the same
  // arithmetic the tab intends.
  const serveRows = byTab['Serve Monthly'] ? complete(byTab['Serve Monthly'].rows) : [];
  const serve = serveRows.map(r => ({
    month: r.month,
    activeLogos: num(r.active_logos),
    cogsTotal: num(r.cogs_total),
    cogsPerLogo: num(r.cogs_per_logo),
    fromSplit: num(r.from_split),
    opexTotal: num(r.opex_total),
    opexPerLogo: num(r.opex_per_logo),
    totalCost: num(r.total_cost),
    totalPerLogo: num(r.total_per_logo),
    teams: Object.entries(r)
      .filter(([key]) => /^\d{4}-\d{2} /.test(key))
      .map(([key, value]) => ({
        code: key.slice(0, 7),
        label: key.slice(8),
        amount: num(String(value).replace(/[$,]/g, '')),
      })),
  })).filter(r => r.cogsPerLogo !== null && r.activeLogos);

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

  // The pipeline applies the settled splits itself: Customer Success at 0% of
  // acquisition cost, Partnerships at 100%, Technical Account Manager to cost
  // of sales. cac_total_actual already reflects that, so the site reads it
  // rather than re-deriving a total from the expense lines.
  //
  // Only the cost is taken from here. The logo counts on this tab are a second
  // definition of the same thing and are deliberately not read: there is one
  // count now, derived from when a customer actually started.
  const expenses = byTab['QB Expenses'].rows
    .filter(r => inWindow(r.month))
    .map(r => ({
      account: r.account,
      section: r.section,
      month: r.month,
      amount: num(r.amount),
      bucket: r.bucket,
    }));

  // Acquisition cost is built from the expense lines rather than read from
  // CAC Monthly. See isAcquisition for why. The pipeline's own figure is kept
  // alongside as `reported` so the two can be compared on the page.
  const acquisitionByMonth = new Map();
  for (const row of expenses) {
    if (!isAcquisition(row)) continue;
    acquisitionByMonth.set(row.month, (acquisitionByMonth.get(row.month) || 0) + (row.amount || 0));
  }

  const cacMonthly = complete(byTab['CAC Monthly'].rows).map(r => ({
    month: r.month,
    cacTotalActual: acquisitionByMonth.has(r.month)
      ? acquisitionByMonth.get(r.month)
      : num(r.cac_total_actual),
    reported: num(r.cac_total_actual),
    derived: acquisitionByMonth.has(r.month),
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
        if (/^\d{4}-\d{2}$/.test(start) && inWindow(start)) lifetimes.set(id, start);
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

  const customers = byTab['Customer Waterfall'].rows
    .filter(r => inWindow(r.month))
    .map(r => ({
      id: r.customer_id,
      name: r.company_name || null,
      source: r.source || null,
      canonicalId: r.canonical_id || null,
      month: r.month,
      eventType: r.event_type || '',
      active: LIVE_EVENTS.has(r.event_type),
      eopMrr: num(r.eop_mrr),
      // The subscription booked when a customer joins, and the cash that
      // actually arrived. new_mrr is the only price measure that exists for
      // every month in the window; starting_mrr is richer but only populated
      // from 2026-01, which is too short to show the shape.
      newMrr: num(r.new_mrr),
      startingMrr: num(r.starting_mrr),
      startType: r.start_type || '',
      netCash: num(r.net_cash),
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
      if (!month || !row.customer_id || !inWindow(month)) continue;
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

  return {
    pushedAt: index.pushed_at || null,
    historyStarts: HISTORY_STARTS,
    waterfall,
    cacMonthly,
    expenses,
    customers,
    lifetimes,
    lifetimeRecords,
    signups,
    serve,
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
  // Gross profit is measured against the month a customer was actually served
  // in, not against a flat assumption. See platformMargins.
  const platform = platformMargins(data);
  const marginsAt = month => (platform.measured
    ? { ...CLASS_MARGINS, platform: platform.byMonth.get(month) ?? platform.mean }
    : CLASS_MARGINS);
  const firstRevenueMonth = new Map();
  const activeByCustomer = new Map();
  const revenueByCustomer = new Map();
  const rowByCustomerMonth = new Map();

  for (const row of data.customers) {
    if (!row.active) continue;

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
    .filter(r => r.active)
    .reduce((earliest, r) => (earliest === null || r.month < earliest ? r.month : earliest), null);
  //
  // The push now classifies these by hand. A customer marked 'shifted forward'
  // in start_type is one the workbook has already identified as starting
  // before the window, which beats inferring it from where their first row
  // happens to fall: the inference catches everyone sitting on the boundary,
  // including customers who genuinely started there.
  const shiftedForward = new Set(
    data.customers.filter(r => /shifted forward/i.test(r.startType || '')).map(r => r.id));

  const censored = [];
  for (const [id, month] of [...firstRevenueMonth]) {
    const known = data.lifetimes?.has(id);
    const stated = shiftedForward.has(id);
    if ((month === windowStart || stated) && !known) {
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

    // Everything a customer pays that is not subscription, kept one stream per
    // array rather than folded into revenue[]. Every existing chart on this
    // page is built on subscription alone, and silently widening that would
    // move twenty of them at once; keeping the streams apart also lets chart 33
    // switch them on and off individually. Together they are about a tenth more
    // than subscription over the last twelve months.
    const usageRevenue = [];
    const oneTimeRevenue = [];
    const passThroughRevenue = [];

    // Until mid-2025 a joining charge was booked into eop_mrr in a customer's
    // first month and came off again the next, so month 0 carries roughly
    // double what the cohort actually pays per month. Every 2024 cohort runs
    // between 1.9x and 2.9x its own month 1; by 2026 the ratio is 1.0.
    //
    // It is real money and is not thrown away, but leaving it inside MRR makes
    // a recurring measure carry a one-off and makes the eras incomparable:
    // a 2024 cohort recovers more than half its acquisition cost in month 0
    // purely because it charged a fee that 2026 does not. It is separated here
    // and offered as a revenue switch, which is where a one-off belongs.
    const joiningFee = [];

    // Survival, which is not the same as presence.
    //
    // logos[] counts who is present at each age, so a customer who leaves and
    // returns is counted again and the curve can rise. A retention curve that
    // goes up is not a retention curve: it read 100.2% at month 2 for the 2025
    // cohorts and ran 89% then 95% then 87% for 2026. Survival counts a
    // customer only while they have been present every month since their
    // first, so once they are gone they stay gone and the line can only fall.
    //
    // Both are kept. Presence is the right measure for revenue, because a
    // returning customer really is paying again. Survival is the right measure
    // for retention, because the question is how much of an intake is left.
    // What each member was worth at the start, taken from their second month
    // rather than their first. Until mid-2025 the first month carried a joining
    // charge as MRR that came off again the next month, so month one overstates
    // a customer by roughly the size of that fee.
    const startingMrr = new Map();
    for (const id of ids) {
      const second = rowByCustomerMonth.get(id + '|' + monthAdd(month, 1));
      const first = rowByCustomerMonth.get(id + '|' + month);
      startingMrr.set(id, second ? (second.eopMrr || 0) : (first ? (first.eopMrr || 0) : 0));
    }

    const runLength = new Map();
    for (const id of ids) {
      const months = activeByCustomer.get(id);
      let k = 0;
      while (k <= maxOffset && months.has(monthAdd(month, k))) k += 1;
      runLength.set(id, k);
    }
    const survivors = [];

    // Revenue from the survivors alone, as against revenue from whoever is
    // present. A retention chart has to hold one population: the logo line
    // counts customers who have been there since month one, so the money line
    // beside it has to count the money those same customers pay. Presence
    // lets in members the cohort did not start with, through a Stripe start
    // date that predates their first billed month or a return after an
    // absence, and a "revenue kept" line that can be lifted by customers who
    // were not in the base is not measuring what it says.
    const survivorRevenue = [];

    // Revenue churn, which is not the same question as revenue kept.
    //
    // survivorRevenue moves for two reasons at once: customers leaving, and
    // the ones who stay paying more or less. That nets expansion against
    // churn, which is why it can sit above its own starting point and does
    // not line up with the logo curve beside it.
    //
    // This weights each customer by what they were worth at the start and
    // then only asks whether they are still here. It is logo churn with the
    // customers weighted by size, so a cohort that keeps its small accounts
    // and loses its large ones shows the damage that counting heads hides.
    // Monotonic by construction, and directly comparable to the logo line.
    //
    // On its own it turned out to be nearly the logo curve redrawn: across
    // the three eras it sits within four points of it at every age, because
    // departures are not strongly sized. Kept because it isolates that one
    // effect, but it is not the chart to read revenue churn off.
    const retainedStartingRevenue = [];

    // Gross revenue retention, which is the standard measure and the one that
    // actually moves away from the count.
    //
    // Each customer is capped at what they were paying at the start, so
    // expansion cannot lift the line above 100% and a cohort cannot grow its
    // way out of having lost money. What is left falls for both of the ways
    // revenue actually goes away: customers leaving, and customers staying on
    // less than they arrived on. The second is the larger effect here and the
    // one the logo curve cannot see at all, not least because a customer
    // booked down to zero MRR is still counted as present.
    //
    // It is not strictly monotonic, and should not be forced to be. A
    // customer who downgrades and later returns to their original rate adds
    // their money back, and flattening that with a running minimum would hide
    // a real recovery.
    const cappedRetainedRevenue = [];
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const at = monthAdd(month, offset);
      let live = 0;
      let mrr = 0;
      let gp = 0;
      let usage = 0;
      let oneTime = 0;
      let passThrough = 0;
      for (const id of ids) {
        if (activeByCustomer.get(id).has(at)) {
          live += 1;
          const row = rowByCustomerMonth.get(id + '|' + at);
          mrr += row ? (row.eopMrr || 0) : 0;
          gp += row ? grossProfit(row, marginsAt(at)) : 0;
          usage += row ? (row.usage || 0) : 0;
          oneTime += row ? (row.oneTime || 0) : 0;
          passThrough += row ? (row.passThrough || 0) : 0;
        }
      }
      logos.push(live);
      revenue.push(mrr);
      profit.push(gp);
      usageRevenue.push(usage);
      oneTimeRevenue.push(oneTime);
      passThroughRevenue.push(passThrough);
      let intact = 0;
      let intactMrr = 0;
      let intactStartingMrr = 0;
      let intactCappedMrr = 0;
      for (const id of ids) {
        if (runLength.get(id) <= offset) continue;
        intact += 1;
        const row = rowByCustomerMonth.get(id + '|' + at);
        intactMrr += row ? (row.eopMrr || 0) : 0;
        const started = startingMrr.get(id) || 0;
        intactStartingMrr += started;
        intactCappedMrr += Math.min(row ? (row.eopMrr || 0) : 0, started);
      }
      survivors.push(intact);
      survivorRevenue.push(intactMrr);
      retainedStartingRevenue.push(intactStartingMrr);
      cappedRetainedRevenue.push(intactCappedMrr);
    }

    // The fee is whatever month 0 carries above the per-logo rate the cohort
    // settles at in month 1. Measured against the cohort's own next month
    // rather than a fixed figure, because the charge changed size over the
    // period and then stopped. Never negative: a cohort whose month 0 is
    // already at or below its month 1 simply has no fee to separate.
    for (let k = 0; k <= maxOffset; k += 1) joiningFee.push(0);
    if (maxOffset >= 1 && logos[0] > 0 && logos[1] > 0) {
      const settled = revenue[1] / logos[1];
      const excess = revenue[0] - settled * logos[0];
      if (excess > 0) joiningFee[0] = excess;
    }

    // What the cohort pays on a recurring basis, with the one-off taken out.
    const recurringRevenue = revenue.map((v, k) => v - (joiningFee[k] || 0));

    return { month, size: logos[0] || ids.length, ids, logos, survivors, revenue,
             survivorRevenue, retainedStartingRevenue, cappedRetainedRevenue,
             profit, usageRevenue, oneTimeRevenue, passThroughRevenue,
             joiningFee, recurringRevenue, maxOffset };
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
  // One denominator, used on both halves of the ratio. The cohort is what this
  // build can see starting in a month, and the same count divides the cost and
  // the gross profit, so multiplying the two returns the spend rather than a
  // number nobody spent. Earlier versions divided cost by one count and profit
  // by another, which is how three different answers to what a logo costs
  // ended up on one page.

  return cohorts.map(cohort => {
    const spend = cac.get(cohort.month);

    // A cohort month with no recorded spend has no cost per logo, and forcing
    // one would invent a number.
    const costPerLogo = (spend === undefined || !cohort.size) ? null : spend / cohort.size;

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
      cohortLogos: cohort.size,
      cumulativeGpPerLogo,
      recovery,
      payback,
      ltvCac: costPerLogo === null
        ? null
        : cumulativeGpPerLogo[cumulativeGpPerLogo.length - 1] / costPerLogo,
    };
  });
}



// The one rule for what counts as acquisition spend.
//
// Everything that divides by a cost per logo goes through this, and so does
// the cost table, so the categories on that table always sum to the number
// every other chart divides by. They did not before: the table read the
// expense lines while the ratios read cac_total_actual from CAC Monthly, and
// the two ran $114,624 apart over twelve months, almost all of it in two
// months where Customer Success appears to have been counted as acquisition
// despite being settled at 0%.
//
// The expense lines win because they are the ones that can be checked. Each
// category on the table is an account you can point at, and they add up.
// cac_total_actual is still read and carried as `reported`, so the gap stays
// visible rather than being quietly resolved.
export function isAcquisition(expense) {
  if (expense.bucket === 'CAC') return true;
  // Partnerships is the one split line that reaches acquisition, at 100%.
  // Customer Success is settled at 0% and Technical Account Manager sits in
  // cost of sales, so neither does.
  return expense.bucket === 'SPLIT' && /Partnerships/i.test(expense.account || '');
}

// Departures counted from the file rather than taken from the summary.
//
// churned_logos books a departure when the pipeline sees the transition. A
// customer whose subscription simply drops out of the Stripe export never
// produces one: they are present one month, absent the next, and no churn is
// recorded. In 2026 that is 182 customers, 179 of whom carried cash in their
// last six months and 156 of whom the subscription export itself marks
// churned with an end date. They are real departures, not test accounts.
//
// Over the last six months the summary books 240 and the file loses 399, so
// the reported figure understates departures by about two thirds. The
// Two operational changes the business made going into 2026 leave the same
// fingerprint in this file, and it is the fingerprint that separates the logo
// curve from the revenue curve.
//
// The first is requiring a customer to serve out their next billing period
// before a cancellation takes effect. That customer has decided to leave, but
// they sit in the count for another period with their revenue already stopped.
// It shows up as a rising share of present, previously paying customers whose
// MRR drops to zero while they stay on the books.
//
// The second is offering coupons more freely. These are not discounts off the
// rate: the median rate a customer starts on has held. They are free periods,
// so they show up as new customers whose second month books no MRR at all.
//
// Both keep a customer in the head count and take their revenue out of it,
// which is exactly the gap between charts 8 and 9. Computed rather than
// asserted, so the callout moves if the behaviour does.
export function policySignals(data, { split = '2026-01', from = '2025-01' } = {}) {
  const byCustomer = new Map();
  for (const row of data.customers) {
    if (!byCustomer.has(row.id)) byCustomer.set(row.id, []);
    byCustomer.get(row.id).push(row);
  }

  let beforeLive = 0, beforeZero = 0, afterLive = 0, afterZero = 0;
  const startRates = { before: [], after: [] };
  let beforeNew = 0, beforeFree = 0, afterNew = 0, afterFree = 0;

  for (const [, rows] of byCustomer) {
    rows.sort((a, b) => (a.month < b.month ? -1 : 1));

    // Paying last month, still present this month, now at nothing.
    for (let i = 1; i < rows.length; i += 1) {
      const previous = rows[i - 1];
      const current = rows[i];
      if (current.month < from) continue;
      if (!previous.active || !current.active || !(previous.eopMrr > 0)) continue;
      const stopped = !(current.eopMrr > 0);
      if (current.month < split) { beforeLive += 1; if (stopped) beforeZero += 1; }
      else { afterLive += 1; if (stopped) afterZero += 1; }
    }

    // A new customer's second month, which is where a free period shows.
    const first = rows.find(r => r.eventType === 'new');
    if (!first || first.month < from) continue;
    const second = rows[rows.indexOf(first) + 1];
    if (!second || !second.active) continue;
    const rate = second.eopMrr || 0;
    const side = first.month < split ? 'before' : 'after';
    if (rate > 0) startRates[side].push(rate);
    if (side === 'before') { beforeNew += 1; if (!(rate > 0)) beforeFree += 1; }
    else { afterNew += 1; if (!(rate > 0)) afterFree += 1; }
  }

  const median = values => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  return {
    split,
    stopPaying: {
      before: beforeLive ? beforeZero / beforeLive : null,
      after: afterLive ? afterZero / afterLive : null,
      beforeMonths: beforeLive,
      afterMonths: afterLive,
    },
    freeStart: {
      before: beforeNew ? beforeFree / beforeNew : null,
      after: afterNew ? afterFree / afterNew : null,
      beforeCustomers: beforeNew,
      afterCustomers: afterNew,
    },
    medianStart: { before: median(startRates.before), after: median(startRates.after) },
  };
}


// difference decides whether the base is growing or shrinking, so both are
// carried and the charts say which they are using.
export function departures(data) {
  const live = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
    if (!live.has(row.month)) live.set(row.month, new Set());
    live.get(row.month).add(row.id);
  }
  const months = [...live.keys()].sort();
  return months.map((month, i) => {
    if (!i) return { month, left: null, entered: null, base: live.get(month).size, rate: null };
    const prev = live.get(months[i - 1]);
    const now = live.get(month);
    let left = 0;
    for (const id of prev) if (!now.has(id)) left += 1;
    let entered = 0;
    for (const id of now) if (!prev.has(id)) entered += 1;
    return { month, left, entered, base: prev.size, rate: prev.size ? left / prev.size : null };
  });
}





// What the projected part of a cohort bar rests on.
//
// The hatched section of chart 1 is a model, and a reader is entitled to know
// which one and whether it can be trusted. This assembles the answer from the
// same donor set the projection uses, so the page states its own basis rather
// than describing it from memory.
//
// The projection is a revenue path, but it is mostly a churn path: after the
// first month, revenue per surviving customer is roughly flat, so almost all
// of the monthly decay is customers leaving rather than the ones who stay
// paying less. The first step is the exception and is not churn at all, it is
// the first month's charge dropping out.
//
// The check that matters is the last one. The donors skew old by construction,
// since a cohort needs months behind it to contribute a path, and at a twelve
// month threshold that excluded every 2026 cohort outright and built the path
// projecting them entirely out of the two years that retained better. Six
// months lets the newest cohorts into the steps they have. The deep steps
// still come from older cohorts and always will, which is why the comparison
// below is run and reported rather than assumed.
export function projectionBasis(cohorts) {
  const { donors, path, terminal } = donorTrajectory(cohorts);
  const donorSet = new Set(donors.map(c => c.month));
  const rest = cohorts.filter(c => !donorSet.has(c.month) && c.maxOffset >= 5);

  // Pooled monthly survival over months 2 to 6, the range both groups reach.
  const survivalStep = group => {
    let kept = 0, from = 0;
    for (const c of group) {
      for (let k = 1; k <= 5 && k < c.survivors.length; k += 1) {
        if (c.survivors[k - 1] > 0) { kept += c.survivors[k]; from += c.survivors[k - 1]; }
      }
    }
    return from ? kept / from : null;
  };
  const toSix = group => {
    let a = 0, b = 0;
    for (const c of group) if (c.maxOffset >= 5) { a += c.survivors[5]; b += c.survivors[0]; }
    return b ? a / b : null;
  };

  // How much of the steady-state monthly decay is customers leaving, as
  // against survivors paying less. Month 1 is excluded because its step is
  // the first month's charge coming off, not churn.
  const steady = [...path.entries()].filter(([k]) => k >= 2 && k <= 12);
  const revenueStep = steady.length
    ? steady.reduce((s, [, v]) => s + v, 0) / steady.length : null;
  const donorSurvival = survivalStep(donors);

  return {
    donors: donors.length,
    minMonths: 6,
    terminal,
    revenueStep,
    donorSurvival,
    // Roughly what fraction of the monthly revenue decay is churn rather than
    // shrinking spend per survivor.
    churnShareOfDecay: (revenueStep !== null && donorSurvival !== null && revenueStep < 1)
      ? Math.min(1, (1 - donorSurvival) / (1 - revenueStep)) : null,
    recentSurvival: survivalStep(rest),
    donorToSix: toSix(donors),
    recentToSix: toSix(rest),
    recentCohorts: rest.length,
  };
}

// LTV:CAC with every cohort measured at the same age.
//
// The plain version of this chart is age-biased by construction: an old
// cohort has had two years to return its cost and a young one two months, so
// the bars slope even if nothing changed. Cutting every cohort at the same
// age removes that, and what is left is a like-for-like comparison. The price
// is that only cohorts old enough to reach the age appear at all.
export function ltvAtAge(data, cohorts, { age = 6, margin = 0.757 } = {}) {
  const cac = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const offset = age - 1;
  const { path, terminal } = donorTrajectory(cohorts);

  return cohorts.map(cohort => {
    const spend = cac.get(cohort.month);
    const costPerLogo = (spend === undefined || !cohort.size) ? null : spend / cohort.size;

    // No recorded spend means no denominator, and inventing one would invent
    // the whole ratio. These stay absent whatever the age.
    if (costPerLogo === null) {
      return {
        month: cohort.month, size: cohort.size, costPerLogo: null,
        ratio: null, observed: null, projected: null, gpPerLogo: null,
        monthsObserved: cohort.maxOffset + 1, complete: false, survival: null,
      };
    }

    const monthly = cohort.profit && cohort.profit.length ? cohort.profit : null;
    const effective = realisedMargin(cohort, margin);

    // Two accumulators rather than one. A cohort younger than the chosen age
    // used to be dropped, which quietly removed every recent cohort from the
    // chart exactly when the reader moved the slider far enough to ask an
    // interesting question. It carries what it has actually returned plus
    // what the donor trajectory says it will return by that age, and the two
    // are kept apart so the column can show which is which.
    let observedGp = 0;
    let projectedGp = 0;
    let carried = null;
    for (let k = 0; k <= offset; k += 1) {
      if (k <= cohort.maxOffset) {
        observedGp += monthly ? monthly[k] : cohort.revenue[k] * margin;
      } else {
        const step = path.has(k) ? path.get(k) : terminal;
        carried = (carried === null ? cohort.revenue[cohort.maxOffset] : carried) * step;
        projectedGp += carried * effective;
      }
    }

    const complete = cohort.maxOffset >= offset;
    const lastSeen = Math.min(offset, cohort.maxOffset);
    return {
      month: cohort.month,
      size: cohort.size,
      costPerLogo,
      gpPerLogo: (observedGp + projectedGp) / cohort.size,
      observed: (observedGp / cohort.size) / costPerLogo,
      projected: (projectedGp / cohort.size) / costPerLogo,
      ratio: ((observedGp + projectedGp) / cohort.size) / costPerLogo,
      monthsObserved: cohort.maxOffset + 1,
      complete,
      // Survival is only ever read from an observed month. Projecting a
      // logo count would put a made-up number in the tooltip beside two
      // real ones.
      survival: cohort.survivors[0] ? cohort.survivors[lastSeen] / cohort.survivors[0] : null,
      survivalAt: lastSeen + 1,
    };
  });
}

// Price at signup across the whole window, and what each price bought.
//
// signupEconomics() reads the New Customer Cohorts tab, which only covers
// 2026-01 onward. Over seven months price looks like it rose 44%. Over
// twenty-four it is a V: the average new subscription was $1,325 in
// 2024-09, fell to $741 by 2025-11 and has climbed back to about $1,300.
// The recent rise is a recovery to where the business already was, not a
// new high, and no chart drawn on seven months can show that.
//
// The price here is new_mrr, the subscription booked when a customer joins,
// which is the only price measure that exists for all twenty-four months.
// It is lower than starting_mrr because it excludes fees and waived amounts,
// so read the shape rather than the level.
export function signupPriceHistory(data) {
  // Two prices, because new_mrr is not one series.
  //
  // Until mid-2025 the first month's charge was booked as MRR and taken off
  // again the next month as a contraction: a customer booked at $1,488 pays
  // $488 from month two, and the $1,000 appears as contraction. The setup_fee
  // column is zero for those, so the fee was never recorded as a fee. From
  // about 2025-10 the practice stops and new_mrr equals what the customer
  // goes on paying.
  //
  // Booked price therefore falls by half across the window without any price
  // changing, and a chart of it shows a collapse and a recovery that did not
  // happen. What a customer actually pays is their MRR in the following
  // month, which is comparable the whole way along. Both are returned so the
  // gap can be shown rather than asserted.
  const byMonth = new Map();
  const seen = new Map();
  for (const row of data.customers) {
    if (!seen.has(row.id)) seen.set(row.id, new Map());
    seen.get(row.id).set(row.month, row.eopMrr || 0);
  }

  for (const row of data.customers) {
    if (row.eventType !== 'new') continue;
    const price = row.newMrr;
    if (!price || price <= 0) continue;
    if (!byMonth.has(row.month)) byMonth.set(row.month, []);
    byMonth.get(row.month).push({
      booked: price,
      recurring: seen.get(row.id)?.get(monthAdd(row.month, 1)) ?? null,
    });
  }

  const mid = xs => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };
  const mean = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

  return [...byMonth.keys()].sort().map(month => {
    const rows = byMonth.get(month);
    const booked = rows.map(r => r.booked);
    // Only customers still paying the month after can show a recurring price;
    // one who left immediately has none to show rather than a zero.
    const kept = rows.filter(r => r.recurring !== null && r.recurring > 0);
    return {
      month,
      count: rows.length,
      mean: mean(booked),
      median: mid(booked),
      booked: booked.reduce((s, v) => s + v, 0),
      recurringMean: mean(kept.map(r => r.recurring)),
      recurringN: kept.length,
      // Above zero while the first month carried a charge that did not recur.
      firstMonthPremium: kept.length ? mean(kept.map(r => r.booked - r.recurring)) : null,
    };
  });
}

// What a price band actually returns.
//
// The question a dual axis cannot answer: is there a price that maximises
// revenue? A crossing point on that chart is an artefact of two scales and
// means nothing, but the underlying question is real and this is where it
// can be asked. Each band is followed the same number of months, so the
// comparison is age-matched.
export function priceBands(data, { horizon = 6, edges = [0, 500, 750, 1000, 1500, Infinity] } = {}) {
  const live = new Map();
  const cash = new Map();
  for (const row of data.customers) {
    if (row.active) {
      if (!live.has(row.month)) live.set(row.month, new Set());
      live.get(row.month).add(row.id);
    }
    if (!cash.has(row.id)) cash.set(row.id, new Map());
    cash.get(row.id).set(row.month, row.netCash || 0);
  }
  const last = data.lastMonth;

  const starts = [];
  for (const row of data.customers) {
    if (row.eventType !== 'new' || !row.newMrr || row.newMrr <= 0) continue;
    if (monthAdd(row.month, horizon - 1) > last) continue;
    starts.push({ id: row.id, month: row.month, price: row.newMrr });
  }

  const bands = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const lo = edges[i], hi = edges[i + 1];
    const group = starts.filter(s => s.price >= lo && s.price < hi);
    if (group.length < 10) continue;
    const target = s => monthAdd(s.month, horizon - 1);
    const alive = group.filter(s => live.get(target(s))?.has(s.id)).length;
    const total = group.reduce((sum, s) => {
      let paid = 0;
      for (let k = 0; k < horizon; k += 1) paid += cash.get(s.id)?.get(monthAdd(s.month, k)) || 0;
      return sum + paid;
    }, 0);
    const price = group.reduce((s, x) => s + x.price, 0) / group.length;
    bands.push({
      lo, hi, n: group.length,
      label: hi === Infinity ? `$${lo.toLocaleString()}+`
        : `$${lo.toLocaleString()}–${hi.toLocaleString()}`,
      survival: alive / group.length,
      price,
      cashPerCustomer: total / group.length,
      // Six months of cash per dollar of monthly price. Flat would mean price
      // buys exactly proportional revenue; falling means diminishing returns.
      perDollar: total / group.length / price,
      total,
    });
  }
  return { horizon, bands, n: starts.length };
}


// Pricing strategies compared, on the site's own data.
//
// The question is whether one fixed price would have beaten the gradual climb
// that was actually run, or a skim that starts high and comes down. It cannot
// be answered by fitting a demand curve, because price was never varied
// independently of time: the elasticity is -0.20 with a t of -1.1, and adding
// a trend flips it positive. So elasticity is swept rather than estimated, and
// what matters is whether the ranking holds across the sweep. It does.
//
// Two inputs come from the data rather than from assumption. Months paid rises
// with price, fitted across the observed bands, which is why a cheap customer
// is a short customer twice over. And cost per logo has no relationship to
// price, so a pricing choice is not allowed to move it.
export function pricingScenarios(data, { months = 23, horizon = 12, cac: cacOverride = null } = {}) {
  const live = new Map();
  const cash = new Map();
  const mrr = new Map();
  for (const row of data.customers) {
    if (row.active) {
      if (!live.has(row.month)) live.set(row.month, new Set());
      live.get(row.month).add(row.id);
    }
    if (!cash.has(row.id)) { cash.set(row.id, new Map()); mrr.set(row.id, new Map()); }
    cash.get(row.id).set(row.month, row.netCash || 0);
    mrr.get(row.id).set(row.month, row.eopMrr || 0);
  }
  const last = data.lastMonth;

  // Price is the second month's MRR, which is clean of the first-month charge.
  const starts = [];
  for (const row of data.customers) {
    if (row.eventType !== 'new') continue;
    const price = mrr.get(row.id)?.get(monthAdd(row.month, 1)) || 0;
    if (price > 0) starts.push({ id: row.id, month: row.month, price });
  }

  const matured = starts.filter(s => monthAdd(s.month, horizon - 1) <= last);
  const BANDS = [[0, 600], [600, 800], [800, 1100], [1100, 1500]];
  const bands = BANDS
    .map(([lo, hi]) => {
      const g = matured.filter(s => s.price >= lo && s.price < hi);
      if (g.length < 12) return null;
      const paid = g.reduce((sum, s) => {
        let k = 0;
        for (let i = 0; i < horizon; i += 1) {
          if (live.get(monthAdd(s.month, i))?.has(s.id)) k += 1;
        }
        return sum + k;
      }, 0) / g.length;
      return { lo, hi, price: g.reduce((s, x) => s + x.price, 0) / g.length,
               paid, n: g.length };
    }).filter(Boolean);

  // How far the months-paid fit is actually supported. Beyond the top of the
  // highest band that survived the twelve customer minimum, the line below is
  // an extrapolation and nothing in this file tests it. Plans that price above
  // this are flagged rather than silently scored, because the fit keeps
  // returning a number long after it has stopped having evidence behind it.
  const fitCeiling = bands.length ? bands[bands.length - 1].hi : null;
  const aboveCeiling = fitCeiling ? matured.filter(s => s.price >= fitCeiling) : [];
  const everAboveCeiling = fitCeiling ? starts.filter(s => s.price >= fitCeiling) : [];
  const topBand = bands.length ? bands[bands.length - 1] : null;

  // Straight line through the bands: months paid as a function of price.
  const mp = bands.reduce((s, b) => s + b.price, 0) / bands.length;
  const mm = bands.reduce((s, b) => s + b.paid, 0) / bands.length;
  const slope = bands.reduce((s, b) => s + (b.price - mp) * (b.paid - mm), 0)
    / bands.reduce((s, b) => s + (b.price - mp) ** 2, 0);
  const paidAt = p => Math.max(1, Math.min(horizon, mm + slope * (p - mp)));

  // The price at which the fit stops discriminating. Above it the line asks
  // for more months than the horizon has, so every plan is credited with a
  // customer who never leaves inside the window and the only thing left
  // pushing back on price is the elasticity. Any scenario priced above this
  // is being scored on an assumption rather than on the data, and the number
  // is carried out so the page can say where that starts.
  let capsAtPrice = null;
  for (let price = 100; price <= 10000; price += 10) {
    if (mm + slope * (price - mp) >= horizon) { capsAtPrice = price; break; }
  }

  // The base: the eleven months before any rise, and the window's cost per logo.
  const early = data.waterfall.filter(w => w.month < '2025-08');
  const baseQ = early.reduce((s, w) => s + (w.newLogos || 0), 0) / (early.length || 1);
  const byMonth = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const cpl = data.waterfall
    .filter(w => w.newLogos && byMonth.has(w.month))
    .map(w => byMonth.get(w.month) / w.newLogos);
  // Two costs per logo, because which one you use is a real decision rather
  // than a detail. The mean across the whole window is the cheaper, historical
  // figure; the trailing twelve months is what a logo costs now and is the one
  // a forward looking recommendation should be judged against. The caller can
  // override either, which is what the chart's slider does.
  const cacWindow = cpl.reduce((s, v) => s + v, 0) / cpl.length;
  const recentCpl = cpl.slice(-12);
  const cacRecent = recentCpl.length
    ? recentCpl.reduce((s, v) => s + v, 0) / recentCpl.length : cacWindow;
  const cac = cacOverride !== null ? cacOverride : cacRecent;
  const basePrices = starts.filter(s => s.month < '2025-08').map(s => s.price);
  const baseP = basePrices.reduce((s, v) => s + v, 0) / basePrices.length;

  const plans = [
    { label: 'Fixed, never raised', at: () => baseP },
    { label: 'What happened, a gradual rise', at: t => baseP + (930 - baseP) * Math.min(1, t / 14) },
    { label: 'Fixed at $930 from month one', at: () => 930 },
    { label: 'Fixed at $1,200', at: () => 1200 },
    { label: 'Skim, $1,300 down to $800', at: t => Math.max(800, 1300 - 500 * t / (months - 1)) },
    { label: 'Skim, $2,500 down to $1,200',
      at: t => Math.max(1200, 2500 - 1300 * t / (months - 1)) },
  ];

  // The real months, not a flat assumption repeated.
  //
  // This ran on one cost per logo and one monthly volume held constant across
  // the window. Both were contradicted by the same page: cost per logo has run
  // between $2,231 and $7,000 a month and the intake between 29 and 63, and a
  // page arguing that acquisition cost is the problem cannot then hold it
  // still in the model that follows. Each month now carries its own cost and
  // its own volume, and the elasticity scales that month's actual intake
  // rather than a constant.
  //
  // The flat figure is kept as an override so the sensitivity rows can ask
  // what happens at a cost per logo the business has not yet seen.
  const series = data.waterfall
    .filter(w => w.newLogos && byMonth.has(w.month))
    .map(w => ({ month: w.month, logos: w.newLogos, cpl: byMonth.get(w.month) / w.newLogos }));

  const run = (at, elasticity, cacOverrideForRun = null) => {
    let gross = 0;
    let customers = 0;
    let cost = 0;
    series.forEach((m, t) => {
      const p = at(t);
      const q = m.logos * Math.pow(p / baseP, elasticity);
      gross += q * p * paidAt(p);
      customers += q;
      cost += q * (cacOverrideForRun !== null ? cacOverrideForRun : m.cpl);
    });
    return { gross, customers, net: gross - cost };
  };

  const elasticities = [0, -0.25, -0.5, -1];
  // What the ranking does if a logo costs more than it ever has. Asked because
  // the flat version of this model was fairly accused of assuming the problem
  // away, and the answer is worth having on the page rather than in a drawer.
  const sensitivity = [null, 6000, 8000].map(level => ({
    level,
    label: level === null ? 'Each month at its own cost per logo' : `Every month at $${level.toLocaleString()} a logo`,
    plans: plans.map(pl => ({
      label: pl.label,
      net: run(pl.at, -0.5, level).net,
    })),
  }));
  return {
    baseP, baseQ, cac, cacWindow, cacRecent,
    cacRange: cpl.length ? [Math.min(...cpl), Math.max(...cpl)] : null,
    horizon, months, bands, slope,
    elasticities,
    series,
    sensitivity,
    realMonths: series.length,
    realVolume: series.length ? series.reduce((s, m) => s + m.logos, 0) / series.length : null,
    realCplRange: series.length
      ? [Math.min(...series.map(m => m.cpl)), Math.max(...series.map(m => m.cpl))] : null,
    fitCeiling,
    capsAtPrice,
    maxObservedStart: starts.reduce((hi, x) => Math.max(hi, x.price), 0),
    // Every starting price ever recorded, sorted, so the page can ask its own
    // questions of the upper tail rather than having thresholds baked in here.
    // The tail is the whole argument for a high opening price, and it is
    // thinner and more interesting than a single maximum suggests.
    startPrices: starts.map(x => x.price).sort((a, b) => a - b),
    topBand,
    aboveCeiling: aboveCeiling.length,
    everAboveCeiling: everAboveCeiling.length,
    // The demand side drawn out as a curve rather than as six chosen points.
    //
    // Holding one price for the whole window, what share of the base intake
    // still arrives, and what does the month's worth of them return after the
    // cost of winning them. One curve per elasticity, because elasticity is
    // not identified here and the honest picture is a family of curves rather
    // than a line. The peak of each is the price that maximises contribution
    // under that assumption, which is the number the six strategies are only
    // ever approximating.
    priceCurve: (() => {
      const prices = [];
      for (let price = 400; price <= 4000; price += 100) prices.push(price);
      // A wider sweep than the table uses, and deliberately past the point
      // where the answer changes. With constant elasticity demand, revenue
      // rises with price for anything milder than -1 and falls for anything
      // steeper, so a curve only turns over on the far side of -1. Stopping
      // the sweep at -1, as the table does, shows only curves that rise and
      // makes "charge more" look like a finding rather than an assumption.
      const curveElasticities = [0, -0.5, -1, -1.5, -2];
      return {
        prices,
        fitCeiling,
        capsAtPrice,
        elasticities: curveElasticities,
        series: curveElasticities.map(elasticity => {
          const volume = prices.map(price => baseQ * Math.pow(price / baseP, elasticity));
          const perMonth = prices.map((price, i) =>
            volume[i] * (price * paidAt(price) - cac));
          const best = perMonth.reduce((bi, v, i) => (v > perMonth[bi] ? i : bi), 0);
          return {
            elasticity,
            volume,
            // A month's intake at that price, over the whole window, so the
            // level is comparable with the table above.
            net: perMonth.map(v => v * months),
            bestPrice: prices[best],
            bestNet: perMonth[best] * months,
            bestVolume: volume[best],
            shareOfBase: volume[best] / baseQ,
          };
        }),
      };
    })(),
    plans: plans.map(pl => {
      // The highest price the plan ever asks for, against the highest price
      // the fit was built on. A plan that opens above the ceiling is scored
      // the same way as the others and then marked, so a reader can see which
      // numbers rest on observed behaviour and which on a straight line drawn
      // past the end of it.
      let peak = 0;
      for (let t = 0; t < months; t += 1) peak = Math.max(peak, pl.at(t));
      return {
        label: pl.label,
        peak,
        extrapolated: fitCeiling ? peak > fitCeiling : false,
        byElasticity: elasticities.map(e => ({ elasticity: e, ...run(pl.at, e) })),
      };
    }),
  };
}

// Three ways to price the same demand curve, and what each leaves behind.
//
// The lesson rather than the model. A single price wins one rectangle under
// the curve: price times however many buyers will pay it. Negotiating each
// deal down from an anchor toward a floor instead collects what each buyer is
// actually willing to pay, which is the area under the curve between those two
// prices rather than a rectangle inside it. The difference between the two is
// money left on the table, and it is large.
//
// Buyers above the anchor pay the anchor, not their true maximum, because an
// anchor is a ceiling on what anyone is asked for. Buyers below the floor are
// not served at all, under any of the three. So the comparison is honest about
// both ends: nobody here is credited with perfect discrimination.
export function priceComparison(data, { anchor = 2500, floor = 1250, elasticity = -0.5 } = {}) {
  const s = pricingScenarios(data);
  const baseP = s.baseP;
  const baseQ = s.baseQ;
  const quantity = price => baseQ * Math.pow(price / baseP, elasticity);
  const willingness = units => baseP * Math.pow(units / baseQ, 1 / elasticity);

  // Numerically, because the closed form has a singularity at unit elasticity
  // and the slider runs straight through it.
  const areaUnder = (from, to, steps = 4000) => {
    const width = (to - from) / steps;
    let total = 0;
    for (let i = 0; i < steps; i += 1) total += willingness(from + width * (i + 0.5)) * width;
    return total;
  };

  const atAnchor = quantity(anchor);
  const atFloor = quantity(floor);
  const negotiated = anchor * atAnchor + areaUnder(atAnchor, atFloor);

  const rows = [
    {
      label: `Fixed at $${Math.round(anchor).toLocaleString()}`,
      detail: 'One price, take it or leave it',
      logos: atAnchor,
      mrr: anchor * atAnchor,
      missing: 'everyone who would pay between the floor and the anchor',
    },
    {
      label: `Fixed at $${Math.round(floor).toLocaleString()}`,
      detail: 'One price, set low enough to win the volume',
      logos: atFloor,
      mrr: floor * atFloor,
      missing: 'the extra every high payer would have paid',
    },
    {
      label: 'Anchor high, negotiate to the floor',
      detail: 'Each deal closed at what that customer will pay',
      logos: atFloor,
      mrr: negotiated,
      missing: null,
    },
  ];

  return {
    anchor,
    floor,
    elasticity,
    baseP,
    baseQ,
    months: s.months,
    rows: rows.map(row => ({ ...row, left: negotiated - row.mrr })),
    best: negotiated,
  };
}


// Every cost the business carries, sorted into groups a reader can switch on
// and off, and defined so that switching them all on counts each dollar once.
//
// The groups partition the expense lines rather than describing them: the
// tests are mutually exclusive and, between them, catch every cost row in the
// file. That is the property the whole chart depends on. Overlapping groups
// would let a reader tick two boxes and charge the same salary twice, and
// gaps would let a cost vanish from a chart whose whole claim is that it holds
// all of them.
//
// What is deliberately outside every group: revenue (4000 and Other Income)
// and taxes. Taxes are a consequence of profit rather than a cost of serving
// anybody, and putting them in the denominator of a recovery ratio would make
// a good month look worse than a bad one.
export const COST_GROUPS = [
  // Charged once, in the month the cohort arrived, because that is when it was
  // spent. Read from the same derived total every other chart divides by, so
  // this chart and chart 1 cannot drift apart.
  { key: 'acquisition', label: 'Acquisition', once: true, defaultOn: true,
    hint: 'Sales, marketing and partnerships. One charge, in the month the cohort signed.',
    match: isAcquisition },

  { key: 'platform', label: 'Platform cost of sales', defaultOn: true,
    hint: 'Software, hosting and merchant processing. The closest thing here to a true per-customer cost.',
    match: r => r.bucket === 'COGS' && /^5000-00/.test(r.section || '') },

  // Support, technical account management and customer success are one team
  // from a customer's point of view and are split three ways only because the
  // chart of accounts splits them. Rolled up, because a reader deciding
  // whether to charge "the people who look after customers" against a cohort
  // is not going to want to tick that box three times.
  //
  // Customer Success reaches this group through the SPLIT bucket, where it is
  // settled at 0% acquisition. Partnerships is the other half of that bucket
  // and goes to acquisition at 100%, which is why the test excludes it by name
  // rather than by bucket.
  { key: 'support', label: 'Customer Support', defaultOn: true,
    hint: 'Support, technical account management and customer success together. '
        + 'Salaries, bonuses, taxes and benefits.',
    match: r => (r.bucket === 'COGS' && /^5050-[12]0/.test(r.section || ''))
      || (r.bucket === 'SPLIT' && !/Partnerships/i.test(r.account || '')) },

  // Booked to cost of sales, and correctly: this is the Service Titan revenue
  // share and partner rebates, both paid on revenue from customers already
  // won. They scale with what those customers bill, they recur while the
  // customer stays, and they would carry on if acquisition stopped tomorrow.
  // Strictly it is contra-revenue; it sits in cost of sales because there is
  // nothing here to net it against.
  { key: 'revshare', label: 'Revenue share and partner rebates', defaultOn: true,
    hint: 'Paid on what existing customers bill, so it recurs while they stay. '
        + 'A cost of keeping them, not of winning them.',
    match: r => r.bucket === 'COGS' && /^6100-00/.test(r.section || '') },

  { key: 'ga', label: 'General and administrative', defaultOn: false,
    hint: 'Rent, insurance, legal, accounting and the G&A payroll. Spread evenly across active logos.',
    match: r => /^6200-/.test(r.section || '') },

  { key: 'rd', label: 'Research and development', defaultOn: false,
    hint: 'The product engineering payroll and its software. Spread evenly across active logos.',
    match: r => /^6300-/.test(r.section || '') },

  { key: 'da', label: 'Depreciation and amortisation', defaultOn: false,
    hint: 'Non-cash. Off by default, because a recovery ratio is a cash question.',
    match: r => /^8000-/.test(r.section || '') },
];


// The revenue side, split the same way the cost side is.
//
// Every other chart on this page counts subscription and stops. That is the
// conservative reading and it is also the wrong one for a recovery ratio: the
// hosting, carrier and merchant lines sitting in the denominator are largely
// there to carry exactly the usage that subscription-only leaves out. Over the
// last twelve months the three non-subscription streams are about a tenth more
// on top of subscription, so leaving them out is not a rounding choice.
//
// They are switches rather than a decision because they are genuinely
// arguable. Pass-through in particular is money that arrives and leaves again,
// and a reader who wants it out should be able to take it out and watch what
// happens rather than be told it does not matter.
export const REVENUE_GROUPS = [
  { key: 'subscription', label: 'Subscription', defaultOn: true,
    hint: 'Recurring MRR, with the old first-month joining charge taken out of it.',
    pick: (c, k) => (c.recurringRevenue ? c.recurringRevenue[k] : c.revenue[k]) || 0 },

  { key: 'usage', label: 'Usage: message and AI credits', defaultOn: true,
    hint: 'Metered messaging, AI and voice. The largest of the three.',
    pick: (c, k) => (c.usageRevenue && c.usageRevenue[k]) || 0 },

  // The joining charge joins the other one-offs here. Switching this off is
  // the only way to compare a 2024 cohort with a 2026 one on equal terms,
  // because 2024 charged the fee and 2026 does not.
  { key: 'setup', label: 'Setup, onboarding and the old joining charge', defaultOn: true,
    hint: 'Charged once, in the first month. 2024 cohorts carry a large joining fee here '
        + 'that was phased out during 2025 — switch this off to compare eras fairly.',
    pick: (c, k) => ((c.oneTimeRevenue && c.oneTimeRevenue[k]) || 0)
      + ((c.joiningFee && c.joiningFee[k]) || 0) },

  { key: 'passthrough', label: '10DLC and carrier pass-through', defaultOn: true,
    hint: 'Registration and carrier fees. Arrives and leaves again, so arguably not ours.',
    pick: (c, k) => (c.passThroughRevenue && c.passThroughRevenue[k]) || 0 },
];


// Monthly cost per active logo for each group, plus the acquisition total.
//
// Everything ongoing divides by the company-wide active logo count for the
// month, which is the same denominator chart 28 uses. Acquisition does not: it
// divides by the size of the cohort that arrived. The two are different
// questions and the numbers are not interchangeable, which is why the
// acquisition group is flagged `once` and handled apart from the rest.
export function costRates(data) {
  const liveByMonth = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
    liveByMonth.set(row.month, (liveByMonth.get(row.month) || 0) + 1);
  }

  const ongoing = COST_GROUPS.filter(g => !g.once);
  const totals = new Map();
  for (const row of data.expenses) {
    if (row.amount === null) continue;
    const group = ongoing.find(g => g.match(row));
    if (!group) continue;
    if (!totals.has(row.month)) totals.set(row.month, new Map());
    const bucket = totals.get(row.month);
    bucket.set(group.key, (bucket.get(group.key) || 0) + row.amount);
  }

  const months = [...liveByMonth.keys()].filter(m => totals.has(m)).sort();
  const rates = new Map();
  for (const month of months) {
    const logos = liveByMonth.get(month);
    if (!logos) continue;
    const row = {};
    for (const g of ongoing) row[g.key] = (totals.get(month).get(g.key) || 0) / logos;
    rates.set(month, row);
  }

  // A cohort measured at month 18 runs past the end of the file, and those
  // months need a rate. The mean of the last three is used, and the fact that
  // it is a carried figure rather than a measured one is reported alongside so
  // the chart can say how much of its own cost side is assumed.
  const tail = months.slice(-3);
  const carried = {};
  for (const g of ongoing) {
    carried[g.key] = tail.length
      ? tail.reduce((s, m) => s + rates.get(m)[g.key], 0) / tail.length
      : 0;
  }

  return { rates, carried, months, lastMonth: months[months.length - 1] || null };
}


// What each cohort has returned against everything it has cost, at a matched
// age, with the cost side assembled from whichever groups are switched on.
//
// This is chart 1 with the assumed margin taken out and replaced by the actual
// cost lines. Chart 1 multiplies revenue by a fixed 75.7% and compares the
// result against acquisition alone; here the numerator is the revenue itself
// and every cost sits in the denominator where it can be seen and switched
// off. The two answer the same question and only this one shows its working.
//
// Months a cohort has not lived through yet are projected, both the revenue it
// will bring and the logos that will still be there to cost money. Projecting
// one without the other would be the flattering version of this chart: revenue
// carried forward while the cost of serving it stops.
export function fullCostRecovery(data, cohorts, { age = 6, groups = null,
                                                 revenueGroups = null,
                                                 halfLife = 9,
                                                 horizon = 60 } = {}) {
  const on = groups || new Set(COST_GROUPS.filter(g => g.defaultOn).map(g => g.key));
  const revOn = revenueGroups
    || new Set(REVENUE_GROUPS.filter(g => g.defaultOn).map(g => g.key));
  const offset = age - 1;
  const cac = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const { rates, carried, lastMonth } = costRates(data);
  // Projected on recency-weighted retention rather than a flat pool, because a
  // cohort that arrived last month will live in this year's conditions and not
  // in 2024's. Chart 1 and the projected break-even chart still use the flat
  // pool, so this one reads slightly harder on recent cohorts than they do.
  const { path, terminal } = donorTrajectory(cohorts, { halfLife });
  const logoPath = donorLogoPath(cohorts, { halfLife });

  const ongoingOn = COST_GROUPS.filter(g => !g.once && on.has(g.key)).map(g => g.key);
  const rateAt = month => {
    const row = rates.has(month) ? rates.get(month) : carried;
    let total = 0;
    for (const key of ongoingOn) total += row[key] || 0;
    return { total, measured: rates.has(month) };
  };

  // What a customer pays, counting only the streams switched on. Charging every
  // cost against subscription alone would be asking the wrong question: the
  // hosting and carrier lines in the denominator are largely there to serve
  // exactly the usage that leaves out.
  const streams = REVENUE_GROUPS.filter(g => revOn.has(g.key));
  const paid = (cohort, k) => {
    let total = 0;
    for (const s of streams) total += s.pick(cohort, k);
    return total;
  };

  if (!streams.length) return [];

  return cohorts.map(cohort => {
    const spend = cac.get(cohort.month);
    const acquisition = on.has('acquisition') && spend !== undefined ? spend : 0;

    // No recorded acquisition spend and acquisition switched on means no
    // denominator, and inventing one would invent the whole ratio.
    if (on.has('acquisition') && (spend === undefined || !cohort.size)) {
      return { month: cohort.month, size: cohort.size, ratio: null, observed: null,
               projected: null, costPerLogo: null, revenuePerLogo: null,
               breakEven: null, breakEvenProjected: false,
               complete: false, monthsObserved: cohort.maxOffset + 1 };
    }

    // One walk forward, long enough to answer both questions. The ratio stops
    // at the chosen age; break-even keeps going until the cohort has covered
    // itself or the horizon runs out, because a break-even that only ever
    // reported ages the slider happened to be sitting on would be useless.
    const deepest = Math.max(offset, horizon);
    let observedRevenue = 0;
    let projectedRevenue = 0;
    let ongoing = 0;
    let assumedCost = 0;
    let carriedRevenue = null;
    let carriedLogos = null;

    let cumRevenue = 0;
    let cumCost = acquisition;
    let breakEven = null;
    let breakEvenProjected = false;

    for (let k = 0; k <= deepest; k += 1) {
      const month = monthAdd(cohort.month, k);
      const { total: rate, measured } = rateAt(month);

      let logos;
      let revenue;
      const seen = k <= cohort.maxOffset;
      if (seen) {
        revenue = paid(cohort, k);
        logos = cohort.logos[k];
      } else {
        const step = path.has(k) ? path.get(k) : terminal;
        carriedRevenue = (carriedRevenue === null ? paid(cohort, cohort.maxOffset)
                                                  : carriedRevenue) * step;
        revenue = carriedRevenue;

        const logoStep = logoPath.path.has(k) ? logoPath.path.get(k) : logoPath.terminal;
        carriedLogos = (carriedLogos === null ? cohort.logos[cohort.maxOffset]
                                              : carriedLogos) * logoStep;
        logos = carriedLogos;
      }

      const cost = rate * logos;

      if (k <= offset) {
        if (seen) observedRevenue += revenue; else projectedRevenue += revenue;
        ongoing += cost;
        if (!measured || !seen) assumedCost += cost;
      }

      if (breakEven === null) {
        cumRevenue += revenue;
        cumCost += cost;
        if (cumRevenue >= cumCost) {
          breakEven = k + 1;
          breakEvenProjected = !seen;
        }
      }
    }

    const totalCost = acquisition + ongoing;
    const revenue = observedRevenue + projectedRevenue;
    const complete = cohort.maxOffset >= offset
      && monthAdd(cohort.month, offset) <= (lastMonth || '9999-99');

    return {
      month: cohort.month,
      size: cohort.size,
      complete,
      monthsObserved: cohort.maxOffset + 1,
      acquisition,
      acquisitionPerLogo: cohort.size ? acquisition / cohort.size : null,
      ongoingPerLogo: cohort.size ? ongoing / cohort.size : null,
      costPerLogo: cohort.size ? totalCost / cohort.size : null,
      revenuePerLogo: cohort.size ? revenue / cohort.size : null,
      ratio: totalCost > 0 ? revenue / totalCost : null,
      observed: totalCost > 0 ? observedRevenue / totalCost : null,
      projected: totalCost > 0 ? projectedRevenue / totalCost : null,
      // The month cumulative revenue first covers cumulative cost, counting
      // the signup month as month 1. Null means it has not covered itself
      // inside the horizon, which is a different statement from a large
      // number and is drawn differently.
      breakEven,
      // Whether that crossing happened in a month anybody has observed or in
      // a projected one. A break-even the model reached on its own is worth
      // less than one the ledger did.
      breakEvenProjected,
      horizon,
      halfLife,
      assumedCostShare: totalCost > 0 ? assumedCost / totalCost : null,
    };
  });
}


// The same donor pooling as donorTrajectory, run on logo counts instead of
// revenue.
//
// The revenue path alone is not enough here. A projected month needs to know
// how many customers are still there to cost money, and reusing the revenue
// step for that would assume revenue per logo never moves — which is exactly
// the assumption the rest of this page spends its time disproving.
function donorLogoPath(cohorts, { halfLife = null } = {}) {
  const donors = cohorts.filter(c => c.month >= '2023-01' && c.maxOffset >= 6);
  const weigh = donorWeights(donors, halfLife);
  const numerator = new Map();
  const denominator = new Map();
  const counts = new Map();
  for (const cohort of donors) {
    const w = weigh(cohort);
    for (let k = 1; k < cohort.logos.length; k += 1) {
      if (cohort.logos[k - 1] <= 0) continue;
      numerator.set(k, (numerator.get(k) || 0) + w * cohort.logos[k]);
      denominator.set(k, (denominator.get(k) || 0) + w * cohort.logos[k - 1]);
      counts.set(k, (counts.get(k) || 0) + w);
    }
  }
  const minDonors = Math.max(2, weigh.total / 2);
  const path = new Map();
  for (const [k, den] of denominator) {
    if (den > 0 && (counts.get(k) || 0) >= minDonors) path.set(k, numerator.get(k) / den);
  }
  return { path, terminal: terminalRate(path, 6, counts, minDonors) };
}


// How much each donor cohort counts toward the pooled path.
//
// Without this every donor counts the same, which quietly makes a projection
// for a 2026 cohort mostly a statement about how 2024 behaved. That is the one
// assumption this page spends its time disproving: chart 8 is an argument that
// the retention era changed, and a projection built on the old era contradicts
// it. Weighting by recency does not throw the old cohorts away — they are the
// only evidence that exists past month eight — but it stops them outvoting the
// recent ones at ages where both have something to say.
//
// The effect is not a level shift and cannot be done with one multiplier. At
// month 1 recent cohorts retain BETTER, because deferred cancellation holds a
// leaver in for another billing period; by months four to seven they retain
// two points a month worse. A flat factor averages those to nothing.
//
// Half-life is in months and is measured back from the newest donor, so the
// weights move with the data rather than being pinned to a date.
function donorWeights(donors, halfLife) {
  if (!halfLife || !donors.length) {
    const flat = () => 1;
    flat.total = donors.length;
    return flat;
  }
  const newest = donors.reduce((a, c) => (c.month > a ? c.month : a), donors[0].month);
  const weigh = cohort => Math.pow(0.5, monthDiff(cohort.month, newest) / halfLife);
  // The threshold below counts weight rather than cohorts, so it has to be
  // measured against the weight that exists. With flat weights this is the
  // donor count and the rule is exactly the one it replaces; the first version
  // of this left the threshold at half the raw count, which no weighted age
  // could reach, and the revenue path lost half its depth without saying so.
  weigh.total = donors.reduce((s, c) => s + weigh(c), 0);
  return weigh;
}


// Where the business goes over the next twelve months, on its own numbers.
//
// A projection is only worth drawing if it can be checked, so this one is
// built to be backtested: run it from twelve months ago with the new-logo
// counts that actually happened and it lands within 3.4% on logos and 2.6% on
// MRR. That is the accuracy claim, it is recomputed on every load, and it is
// printed on the chart rather than asserted here.
//
// The model is a cohort roll-forward and nothing more clever than that:
//
//   every customer sits in a bucket by how many months they have been here;
//   each month a bucket keeps its measured age-specific survival rate and the
//   survivors age by one; a new bucket arrives at age zero; and revenue is the
//   logo count at each age times what a logo of that age actually pays.
//
// Two things it deliberately does not do. It does not model price changes,
// because nothing in the file forecasts them. And it does not forecast new
// logo volume, because that is a decision rather than a prediction — the
// scenarios are three volumes the business has actually run, and the reader
// picks which one they believe.
export function projectBase(data, { months = 12 } = {}) {
  const first = new Map();
  const live = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
    if (!live.has(row.month)) live.set(row.month, new Map());
    live.get(row.month).set(row.id, row.eopMrr || 0);
    if (!first.has(row.id) || row.month < first.get(row.id)) first.set(row.id, row.month);
  }
  const all = [...live.keys()].sort();
  if (all.length < 13) return null;
  const last = all[all.length - 1];

  // Age-specific monthly survival, pooled over every month-pair in the window.
  // Ages with a thin denominator fall back to the overall rate rather than
  // carrying a number built on a handful of customers.
  const kept = new Map();
  const seen = new Map();
  for (let i = 0; i < all.length - 1; i += 1) {
    const now = live.get(all[i]);
    const next = live.get(all[i + 1]);
    for (const id of now.keys()) {
      const age = Math.min(monthDiff(first.get(id), all[i]), 24);
      seen.set(age, (seen.get(age) || 0) + 1);
      if (next.has(id)) kept.set(age, (kept.get(age) || 0) + 1);
    }
  }
  let heldTotal = 0;
  let sawTotal = 0;
  for (const [age, n] of seen) { sawTotal += n; heldTotal += kept.get(age) || 0; }
  const blended = sawTotal ? heldTotal / sawTotal : 0.955;
  const survival = age => {
    const k = Math.min(age, 24);
    return (seen.get(k) || 0) >= 30 ? kept.get(k) / seen.get(k) : blended;
  };

  // What a logo of a given age pays, measured across the last six months so
  // the curve reflects current pricing rather than the whole window's.
  const payN = [];
  const payS = [];
  for (const month of all.slice(-6)) {
    for (const [id, mrr] of live.get(month)) {
      const age = Math.min(monthDiff(first.get(id), month), 36);
      payN[age] = (payN[age] || 0) + 1;
      payS[age] = (payS[age] || 0) + mrr;
    }
  }
  const deep = payN.length
    ? payS.slice(24).reduce((s, v) => s + (v || 0), 0)
      / Math.max(payN.slice(24).reduce((s, v) => s + (v || 0), 0), 1)
    : 0;
  const pays = age => {
    const k = Math.min(age, 36);
    return payN[k] >= 10 ? payS[k] / payN[k] : deep;
  };

  const stateAt = month => {
    const v = [];
    for (const id of live.get(month).keys()) {
      const age = monthDiff(first.get(id), month);
      v[age] = (v[age] || 0) + 1;
    }
    return v.map(x => x || 0);
  };

  const run = (from, steps, arrivals) => {
    let state = stateAt(from);
    const out = [];
    for (let k = 1; k <= steps; k += 1) {
      const next = [];
      for (let age = 0; age < state.length; age += 1) {
        next[age + 1] = (next[age + 1] || 0) + state[age] * survival(age);
      }
      next[0] = typeof arrivals === 'function' ? arrivals(k) : arrivals;
      state = next.map(x => x || 0);
      out.push({
        month: monthAdd(from, k),
        logos: state.reduce((s, v) => s + v, 0),
        mrr: state.reduce((s, v, age) => s + v * pays(age), 0),
      });
    }
    return out;
  };

  // The accuracy claim, recomputed rather than remembered. Run the same model
  // from twelve months back using the arrivals that actually happened, and
  // compare the last step against what the file says.
  const backFrom = all[all.length - 13];
  const arrivalsByMonth = new Map(data.waterfall.map(w => [w.month, w.newLogos]));
  const test = run(backFrom, 12, k => arrivalsByMonth.get(monthAdd(backFrom, k)) ?? 0);
  const endLogos = live.get(last).size;
  const endMrr = [...live.get(last).values()].reduce((s, v) => s + v, 0);
  const tail = test[test.length - 1];

  const history = all.slice(-18).map(month => ({
    month,
    logos: live.get(month).size,
    mrr: [...live.get(month).values()].reduce((s, v) => s + v, 0),
  }));

  return {
    lastMonth: last,
    history,
    run: arrivals => run(last, months, arrivals),
    survival,
    pays,
    blended,
    backtest: {
      from: backFrom,
      logoError: endLogos ? (tail.logos - endLogos) / endLogos : null,
      mrrError: endMrr ? (tail.mrr - endMrr) / endMrr : null,
    },
  };
}


// The three arrival rates worth drawing, each one a volume the business has
// actually run rather than a number chosen to make a point.
export function arrivalScenarios(data) {
  const w = data.waterfall.filter(r => r.newLogos != null);
  if (!w.length) return [];
  const mean = rows => rows.reduce((s, r) => s + r.newLogos, 0) / rows.length;
  const latest = w[w.length - 1];
  return [
    { key: 'long', label: 'Long-run average', rate: Math.round(mean(w)),
      hint: 'the average across the whole window' },
    { key: 'recent', label: 'Recent three months', rate: Math.round(mean(w.slice(-3))),
      hint: 'the average of the last three months' },
    { key: 'latest', label: 'Latest month holds', rate: latest.newLogos,
      hint: `${fmtMonth(latest.month)} repeated` },
  ].sort((a, b) => b.rate - a.rate);
}

function fmtMonth(m) {
  const [y, mm] = m.split('-');
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mm) - 1] + " '" + y.slice(2);
}


// The accounts worth a conversation, named.
//
// Two groups, and they need different conversations. The zero-MRR accounts are
// not a price rise, they are a customer who stopped paying and stayed on the
// platform: the ask is to start paying anything at all. The under-$306 group
// pays something but less than it costs to serve once support and overhead are
// counted, so the ask there is an upgrade to a supported tier.
//
// Sorted by how much the account is short of the target rather than by size,
// because the sales effort per conversation is roughly constant and the
// biggest gaps are where that effort pays.
export function upgradeList(data, { lowBand = 306 } = {}) {
  const months = [...new Set(data.customers.filter(r => r.active).map(r => r.month))].sort();
  if (!months.length) return null;
  const last = months[months.length - 1];

  const firstSeen = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
    if (!firstSeen.has(row.id) || row.month < firstSeen.get(row.id)) {
      firstSeen.set(row.id, row.month);
    }
  }

  // Six months of history per account, so a caller can see whether this is a
  // customer who has always been small or one who has fallen.
  const window = months.slice(-6);
  const historyBy = new Map();
  for (const row of data.customers) {
    if (!row.active || !window.includes(row.month)) continue;
    if (!historyBy.has(row.id)) historyBy.set(row.id, new Map());
    historyBy.get(row.id).set(row.month, row.eopMrr || 0);
  }

  const build = row => {
    const hist = historyBy.get(row.id) || new Map();
    const series = window.map(m => (hist.has(m) ? hist.get(m) : null));
    const seen = series.filter(v => v !== null);
    const peak = seen.length ? Math.max(...seen) : 0;
    return {
      id: row.id,
      canonicalId: row.canonicalId || null,
      name: row.name || null,
      source: row.source || null,
      since: firstSeen.get(row.id) || null,
      tenure: firstSeen.has(row.id) ? monthDiff(firstSeen.get(row.id), last) : null,
      mrr: row.eopMrr || 0,
      cash: row.netCash || 0,
      usage: row.usage || 0,
      oneTime: row.oneTime || 0,
      series,
      peak,
      // A customer who used to pay more is a different conversation from one
      // who never did: the first is a recovery, the second is an upgrade.
      fallen: peak > (row.eopMrr || 0),
    };
  };

  // A never-payer is not an upgrade prospect, it is a record to clean up.
  const never = neverPaidIds(data);
  const live = data.customers.filter(r => r.active && r.month === last
    && !never.has(r.id));
  const zeros = live.filter(r => !(r.eopMrr > 0)).map(build);
  const low = live.filter(r => r.eopMrr > 0 && r.eopMrr < lowBand).map(build);

  const byGap = (a, b) => (b.peak - b.mrr) - (a.peak - a.mrr) || a.mrr - b.mrr;
  zeros.sort(byGap);
  low.sort((a, b) => a.mrr - b.mrr);

  return {
    month: last, window, lowBand,
    zeros, low,
    totals: {
      accounts: zeros.length + low.length,
      zeroCount: zeros.length,
      lowCount: low.length,
      lowMrr: low.reduce((s, r) => s + r.mrr, 0),
      zerosWithCash: zeros.filter(r => r.cash > 0 || r.usage > 0).length,
      zerosFallen: zeros.filter(r => r.fallen).length,
      namesMissing: zeros.concat(low).filter(r => !r.name).length,
      // What each group is worth if it moves to the band edge.
      upliftToLow: zeros.reduce((s) => s + lowBand, 0)
        + low.reduce((s, r) => s + (lowBand - r.mrr), 0),
    },
  };
}


// Logos that have never carried a subscription in the whole window.
//
// A customer who has never once had MRR is not a customer who stopped paying;
// it is a test account, an agency monitoring seat or a record that should not
// have been counted. Keeping them inflates every denominator here a little
// and misdescribes them a lot.
//
// The number is far smaller than it looks from outside: of the accounts at
// zero in the latest month, the large majority paid something earlier and
// fell, which is a churn story rather than a housekeeping one. That is why
// this is a separate idea from "pays nothing this month" and not the same one.
export function neverPaidIds(data) {
  const peak = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
    const seen = peak.get(row.id) || 0;
    peak.set(row.id, Math.max(seen, row.eopMrr || 0));
  }
  const never = new Set();
  for (const [id, top] of peak) if (!(top > 0)) never.add(id);
  return never;
}


// Every cost line the business carries, by account, for the last few months.
//
// Everything else on this page aggregates. This does not: one row per
// QuickBooks account, with its code, so any figure quoted anywhere can be
// traced to the ledger lines underneath it. If a number here disagrees with
// the accounts, the accounts are right and this is wrong.
//
// Grouped into the layers the floors use, and the grouping is the only
// editorial act: which layer an account belongs to is a judgement, the
// amounts are not.
export const COST_LAYERS = [
  { key: 'platform', label: 'Platform', basis: 'per logo',
    note: 'Per-seat licences and hosting. Follows the customer.',
    match: a => /^5000-0[23]/.test(a) },
  { key: 'people', label: 'Support and success', basis: 'per logo',
    note: 'Everyone who looks after customers, whichever account they sit in.',
    match: a => /^5050-/.test(a) || /^6150-3/.test(a) },
  { key: 'variable', label: 'Merchant and revenue share', basis: 'per payment',
    note: 'Follows the payment rather than the customer, so it scales with price.',
    match: a => /^5000-04/.test(a) || /^6100-06/.test(a) },
  { key: 'ga', label: 'General and administrative', basis: 'per logo',
    note: 'The cost of being a company. Spread evenly because nothing ties it to a customer.',
    match: a => /^6200-/.test(a) || /^8000-/.test(a) || /^6999-/.test(a) },
  { key: 'rd', label: 'Research and development', basis: 'per logo',
    note: 'Tomorrow\u2019s product. Carried apart from the floors for that reason.',
    match: a => /^6300-/.test(a) },
  { key: 'acquisition', label: 'Acquisition', basis: 'per NEW logo',
    note: 'Winning customers, not keeping them. Divides by NEW logos, so its per-logo '
        + 'figure is not comparable with any row above it.',
    match: a => /^6150-1/.test(a) || /^6150-2/.test(a) || /^6150-4/.test(a)
      || /^6150-5/.test(a) || /^6150-6/.test(a)
      || (/^6100-/.test(a) && !/^6100-06/.test(a)) },
];

export function costLedger(data, { months = 3 } = {}) {
  const all = [...new Set(data.customers.filter(r => r.active).map(r => r.month))].sort();
  const window = all.slice(-months);
  if (!window.length) return null;

  // Accounts that have never carried a subscription are out of every
  // denominator here, not just out of the paying count.
  const never = neverPaidIds(data);
  const counts = window.map(month => {
    const all = data.customers.filter(r => r.active && r.month === month);
    const live = all.filter(r => !never.has(r.id));
    return {
      month,
      active: live.length,
      excluded: all.length - live.length,
      paying: live.filter(r => (r.eopMrr || 0) > 0).length,
      // Subscription and everything else a customer pays, kept apart.
      // Comparing a full cost base against subscription alone understates
      // the business by about a tenth, which is roughly the whole margin.
      mrr: live.reduce((s, r) => s + (r.eopMrr || 0), 0),
      usage: live.reduce((s, r) => s + (r.usage || 0), 0),
      oneTime: live.reduce((s, r) => s + (r.oneTime || 0), 0),
      passThrough: live.reduce((s, r) => s + (r.passThrough || 0), 0),
      revenue: live.reduce((s, r) => s + (r.eopMrr || 0) + (r.usage || 0)
        + (r.oneTime || 0) + (r.passThrough || 0), 0),
      // What actually arrived, as a check on the four components above.
      netCash: live.reduce((s, r) => s + (r.netCash || 0), 0),
      newLogos: (data.waterfall.find(w => w.month === month) || {}).newLogos || 0,
    };
  });

  const byAccount = new Map();
  for (const row of data.expenses) {
    if (!window.includes(row.month) || row.amount === null) continue;
    const a = row.account || '';
    // Revenue, other income and taxes are not costs of anything.
    if (/^4000|^7000|^9000/.test(a)) continue;
    const layer = COST_LAYERS.find(l => l.match(a));
    if (!layer) continue;
    if (!byAccount.has(a)) {
      byAccount.set(a, { account: a, layer: layer.key, bucket: row.bucket, by: new Map() });
    }
    const entry = byAccount.get(a);
    entry.by.set(row.month, (entry.by.get(row.month) || 0) + row.amount);
  }

  const groups = COST_LAYERS.map(layer => {
    const accounts = [...byAccount.values()]
      .filter(e => e.layer === layer.key)
      .map(e => ({
        ...e,
        values: window.map(m => e.by.get(m) || 0),
        total: window.reduce((s, m) => s + (e.by.get(m) || 0), 0),
      }))
      .filter(e => e.values.some(v => Math.abs(v) >= 1))
      .sort((x, y) => y.total - x.total);
    const subtotal = window.map((m, i) => accounts.reduce((s, e) => s + e.values[i], 0));
    return { ...layer, accounts, subtotal };
  }).filter(g => g.accounts.length);

  const ongoing = groups.filter(g => g.key !== 'acquisition');
  const ongoingTotal = window.map((m, i) => ongoing.reduce((s, g) => s + g.subtotal[i], 0));
  const acqGroup = groups.find(g => g.key === 'acquisition');

  return {
    window, counts, groups,
    ongoingTotal,
    acquisitionTotal: acqGroup ? acqGroup.subtotal : window.map(() => 0),
    accountCount: byAccount.size,
  };
}


// What it costs to keep one paying customer, month by month, in layers.
//
// The page had cost of sales per logo by team, which stops before G&A and
// R&D, and a chart of what is left after costs, where the cost itself is only
// the gap between two lines. Neither shows the cost.
//
// Divided by PAYING logos rather than all of them, because a zero-MRR account
// cannot carry any of this and pretending otherwise flatters every month.
// Acquisition is not here: it belongs to the cohort that caused it.
export function ongoingCostPerLogo(data) {
  const months = [...new Set(data.customers.filter(r => r.active).map(r => r.month))].sort();
  if (!months.length) return null;

  const never = neverPaidIds(data);
  return months.map(month => {
    const live = data.customers.filter(r => r.active && r.month === month
      && !never.has(r.id));
    const paying = live.filter(r => (r.eopMrr || 0) > 0).length;
    const mrr = live.reduce((s, r) => s + (r.eopMrr || 0), 0);
    const revenue = live.reduce((s, r) => s + (r.eopMrr || 0) + (r.usage || 0)
      + (r.oneTime || 0) + (r.passThrough || 0), 0);
    if (!paying) return null;

    const spend = {};
    for (const row of data.expenses) {
      if (row.month !== month || row.amount === null) continue;
      const a = row.account || '';
      let key = null;
      // Variable: follows the payment rather than the customer.
      if (/^5000-04/.test(a) || /^6100-06/.test(a)) key = 'variable';
      // Platform: per-seat licence and hosting. Follows the customer.
      else if (/^5000-0[23]/.test(a)) key = 'platform';
      // The people who look after customers, whichever account they sit in.
      else if (/^5050-/.test(a)) key = 'people';
      else if (row.bucket === 'SPLIT' && !/Partnerships/i.test(a)) key = 'people';
      else if (/^6200-|^8000-/.test(a)) key = 'admin';
      else if (/^6300-/.test(a)) key = 'product';
      if (key) spend[key] = (spend[key] || 0) + row.amount;
    }

    const per = k => (spend[k] || 0) / paying;
    const layers = {
      platform: per('platform'),
      people: per('people'),
      variable: per('variable'),
      admin: per('admin'),
      product: per('product'),
    };
    return {
      month, paying, activeLogos: live.length,
      arpa: revenue / paying,
      subscriptionOnly: mrr / paying,
      ...layers,
      total: Object.values(layers).reduce((s, v) => s + v, 0),
    };
  }).filter(Boolean);
}


// What a customer has to pay to be worth keeping, and what happens if you act
// on it. Two different floors, and confusing them is the expensive mistake.
//
// The MARGINAL floor is what one more or one fewer customer actually changes:
// the per-seat licence and hosting that follow a logo, plus the merchant fee
// and revenue share that follow a payment. Nothing else moves this month if a
// single customer leaves. A customer above this line puts cash in the bank.
//
// The ALLOCATED floor spreads every fixed cost — support, customer success,
// G&A, R&D — evenly across the paying base. It is the right number for pricing
// new business and for setting a discount limit, because a book priced below
// it cannot cover the company. It is the wrong number for deciding whether to
// keep an individual customer, because none of that cost leaves with them.
//
// The gap between the two is the whole argument: on current numbers it is
// $120 against $665.
export function priceFloors(data, { window = 6 } = {}) {
  const months = [...new Set(data.customers.filter(r => r.active).map(r => r.month))].sort();
  if (!months.length) return null;
  const last = months[months.length - 1];
  const recent = new Set(months.slice(-window));

  const bucket = {};
  for (const row of data.expenses) {
    if (!recent.has(row.month) || row.amount === null) continue;
    const a = row.account || '';
    let key = null;
    if (/^5000-04/.test(a)) key = 'merchant';
    else if (/^6100-06/.test(a)) key = 'revshare';
    else if (/^5000-02/.test(a)) key = 'software';
    else if (/^5000-03/.test(a)) key = 'hosting';
    else if (/^5050-/.test(a)) key = 'support';
    else if (row.bucket === 'SPLIT' && !/Partnerships/i.test(a)) key = 'success';
    else if (/^6100-0/.test(a)) key = 'otherSM';
    else if (/^6200-|^6300-|^8000-/.test(a)) key = 'overhead';
    if (key) bucket[key] = (bucket[key] || 0) + row.amount;
  }

  // Per month rather than pooled, so the summary can be a median.
  //
  // A pooled mean over the window is the obvious choice and it is wrong here.
  // The ledger books an invoice and its credit note in different months, and
  // the window closes between them: in 2026-08 a $69,847 revenue-share bill
  // was raised and credited in full, the credit landed in 2026-09, and the
  // window ends at 2026-08. So the charge is counted and the reversal never
  // is. That single month reads 18.9% of revenue against a usual 9.7% and
  // drags the pooled rate to 11.1%.
  //
  // A median across the months ignores it without anyone having to hand-code
  // which month to drop, and it will ignore the next one too.
  const neverPaid = neverPaidIds(data);
  const byMonth = [];
  for (const month of months.slice(-window)) {
    const rows = data.customers.filter(r => r.active && r.month === month
      && !neverPaid.has(r.id));
    const mrr = rows.reduce((s, r) => s + (r.eopMrr || 0), 0);
    if (!rows.length || !mrr) continue;
    const spend = {};
    for (const row of data.expenses) {
      if (row.month !== month || row.amount === null) continue;
      const a = row.account || '';
      let key = null;
      if (/^5000-04/.test(a)) key = 'merchant';
      else if (/^6100-06/.test(a)) key = 'revshare';
      else if (/^5000-02/.test(a)) key = 'software';
      else if (/^5000-03/.test(a)) key = 'hosting';
      else if (/^5050-/.test(a)) key = 'support';
      else if (row.bucket === 'SPLIT' && !/Partnerships/i.test(a)) key = 'success';
      // 6100-0x other than the revenue share above is acquisition spend —
      // professional services, advertising, tradeshows, content — and sits in
      // the CAC bucket. It was being counted here as a cost of serving, which
      // put $78 a logo a month of acquisition into the price floor and pushed
      // it about $86 too high. Acquisition belongs to the cohort that caused
      // it, which is chart 33's job, not to the standing base.
      else if (/^6200-/.test(a)) key = 'ga';
      else if (/^6300-/.test(a)) key = 'rd';
      else if (/^8000-/.test(a)) key = 'da';
      if (key) spend[key] = (spend[key] || 0) + row.amount;
    }
    byMonth.push({ month, logos: rows.length, mrr, spend });
  }
  if (!byMonth.length) return null;

  const median = values => {
    const s = values.slice().sort((a, b) => a - b);
    if (!s.length) return 0;
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const per = k => median(byMonth.map(r => (r.spend[k] || 0) / r.logos));
  const share = k => median(byMonth.map(r => (r.spend[k] || 0) / r.mrr));
  const logoMonths = byMonth.reduce((s, r) => s + r.logos, 0);
  const revenue = byMonth.reduce((s, r) => s + r.mrr, 0);

  const variablePct = share('merchant') + share('revshare');
  const marginalPerLogo = per('software') + per('hosting');
  // Cost to serve on its own, and the fully loaded version beside it. R&D is
  // deliberately in neither of the first two: charging tomorrow's product to
  // today's customers concludes that a company investing in product has worse
  // unit economics than one that is not, which is backwards. It is carried
  // separately so a reader can put it back.
  const serveOnly = median(byMonth.map(r =>
    (r.spend.software || 0) + (r.spend.hosting || 0)
    + (r.spend.support || 0) + (r.spend.success || 0)));
  const fixedPerMonth = median(byMonth.map(r =>
    (r.spend.software || 0) + (r.spend.hosting || 0) + (r.spend.support || 0)
    + (r.spend.success || 0) + (r.spend.ga || 0) + (r.spend.da || 0)));
  const fullyLoadedPerMonth = median(byMonth.map(r =>
    (r.spend.software || 0) + (r.spend.hosting || 0) + (r.spend.support || 0)
    + (r.spend.success || 0) + (r.spend.ga || 0) + (r.spend.da || 0)
    + (r.spend.rd || 0)));

  const base = data.customers.filter(r => r.active && r.month === last
    && !neverPaid.has(r.id)).map(r => r.eopMrr || 0);
  const paying = base.filter(v => v > 0).sort((a, b) => a - b);
  const zeros = base.length - paying.length;

  const marginalFloor = marginalPerLogo / (1 - variablePct);
  const allocatedFloor = (fixedPerMonth / paying.length) / (1 - variablePct);

  return {
    month: last,
    paying, zeros,
    totalMrr: paying.reduce((s, v) => s + v, 0),
    variablePct,
    marginalPerLogo,
    marginalFloor,
    fixedPerMonth,
    fixedPerLogo: fixedPerMonth / paying.length,
    allocatedFloor,
    // Three floors for three questions. Serve covers what it costs to keep a
    // customer working; allocated adds G&A, the cost of being a company;
    // fully loaded adds R&D on top. None of them contains acquisition.
    servePerLogo: serveOnly / paying.length,
    serveFloor: (serveOnly / paying.length) / (1 - variablePct),
    fullyLoadedPerLogo: fullyLoadedPerMonth / paying.length,
    fullyLoadedFloor: (fullyLoadedPerMonth / paying.length) / (1 - variablePct),
    // What actually comes out if enough customers go that headcount follows.
    removablePayrollPerLogo: per('support') + per('success'),
    components: Object.fromEntries(
      ['merchant', 'revshare', 'software', 'hosting', 'support', 'success', 'ga', 'rd', 'da']
        .map(k => [k, per(k)])),
    // Months whose variable rate sits far from the median, which on this
    // ledger means an invoice booked in one month and credited in another.
    // Reported rather than silently smoothed.
    outliers: byMonth
      .map(r => ({ month: r.month,
        rate: ((r.spend.merchant || 0) + (r.spend.revshare || 0)) / r.mrr }))
      .filter(r => r.rate > variablePct * 1.5 || r.rate < variablePct * 0.5),
  };
}


// Cut them or re-price them, run both to their conclusion.
//
// Cutting is modelled honestly: the customer's revenue and variable cost go,
// the fixed cost stays, so the floor rises for everyone left and more of them
// fall under it. Repeat until nobody is below the line. It does not converge
// anywhere useful, which is the finding.
export function repriceOutcomes(data) {
  const f = priceFloors(data);
  if (!f) return null;

  const spiral = [];
  let keep = f.paying.slice();
  for (let round = 0; round < 10 && keep.length; round += 1) {
    const floor = (f.fixedPerMonth / keep.length) / (1 - f.variablePct);
    const below = keep.filter(v => v < floor);
    spiral.push({ round: round + 1, logos: keep.length, floor, below: below.length,
      mrr: keep.reduce((s, v) => s + v, 0) });
    if (!below.length) break;
    keep = keep.filter(v => v >= floor);
  }

  // Re-pricing, by how many of the under-floor customers accept. The ones who
  // refuse are assumed to leave, cheapest first, which is the kind end of the
  // assumption: in practice the cheapest are also the likeliest to go.
  const below = f.paying.filter(v => v < f.allocatedFloor);
  const acceptance = [0, 0.25, 0.5, 0.75, 1].map(rate => {
    const upgraded = Math.round(below.length * rate);
    const churned = below.length - upgraded;
    const lost = below.slice(0, churned).reduce((s, v) => s + v, 0);
    const kept = f.paying.length - churned;
    const newFloor = kept ? (f.fixedPerMonth / kept) / (1 - f.variablePct) : Infinity;
    const gained = below.slice(churned)
      .reduce((s, v) => s + Math.max(0, newFloor - v), 0);
    return {
      rate, upgraded, churned, logos: kept, floor: newFloor,
      mrr: f.totalMrr - lost + gained,
      change: gained - lost,
    };
  });

  // Where re-pricing stops being worth doing at all.
  const breakEven = (() => {
    for (let r = 0; r <= 100; r += 1) {
      const rate = r / 100;
      const upgraded = Math.round(below.length * rate);
      const churned = below.length - upgraded;
      const lost = below.slice(0, churned).reduce((s, v) => s + v, 0);
      const kept = f.paying.length - churned;
      if (!kept) continue;
      const newFloor = (f.fixedPerMonth / kept) / (1 - f.variablePct);
      const gained = below.slice(churned).reduce((s, v) => s + Math.max(0, newFloor - v), 0);
      if (gained - lost >= 0) return rate;
    }
    return null;
  })();

  // Converting a zero-MRR account works the recursion the other way: it adds a
  // payer to the denominator, so the floor falls for everybody.
  const floorIfZerosConvert = f.zeros
    ? (f.fixedPerMonth / (f.paying.length + f.zeros)) / (1 - f.variablePct)
    : f.allocatedFloor;

  return { floors: f, spiral, acceptance, breakEven, below, floorIfZerosConvert };
}


// What it costs to keep a logo, against what a logo pays.
//
// Until this tab arrived, margin was a single assumption applied to
// everything. It is measured now, and it is not what was assumed: cost of
// sales alone runs around forty per cent of what the average customer pays.
//
// Two figures, deliberately kept apart. Gross contribution is what a customer
// pays less what it costs to serve them, which is the number ratios like
// LTV:CAC are built on and the one every outside benchmark uses. Net
// contribution takes off G&A and R&D too, and answers a different question:
// whether a customer at a given price pays for the whole business rather than
// just its own cost of service. Neither should be presented as the other.
//
// G&A and R&D are spread evenly across active logos, because nothing ties a
// landlord or a developer to a particular customer and per active logo is the
// plainest convention available. Note the denominator: cost to serve divides
// by ACTIVE logos where acquisition divides by NEW ones. They answer different
// questions and nothing here should divide one by the other's base.
export function costToServe(data) {
  if (!data.serve || !data.serve.length) return null;

  // Two corrections that this function and everything drawn from it were
  // missing, both of which made the business look worse than it is.
  //
  // Accounts that have never once carried a subscription are out of the
  // denominator: a test account or an agency monitoring seat is not a
  // customer whose cost anybody should be spreading.
  //
  // And what a customer pays is everything they pay. Comparing a full cost
  // base against subscription alone understates revenue by about a tenth,
  // which on these numbers is most of the margin. Usage and message credits,
  // setup and one-time charges, and 10DLC and carrier pass-through are all
  // money that arrived; the cash column agrees with their sum to within half
  // a per cent, which is the reason to trust the four of them together.
  const never = neverPaidIds(data);
  const mrrByMonth = new Map();
  const revByMonth = new Map();
  const liveByMonth = new Map();
  for (const row of data.customers) {
    if (!row.active || never.has(row.id)) continue;
    mrrByMonth.set(row.month, (mrrByMonth.get(row.month) || 0) + (row.eopMrr || 0));
    revByMonth.set(row.month, (revByMonth.get(row.month) || 0)
      + (row.eopMrr || 0) + (row.usage || 0) + (row.oneTime || 0) + (row.passThrough || 0));
    liveByMonth.set(row.month, (liveByMonth.get(row.month) || 0) + 1);
  }

  const months = data.serve
    .filter(r => mrrByMonth.has(r.month) && liveByMonth.get(r.month))
    .map(r => {
      const logos = liveByMonth.get(r.month);
      const arpa = revByMonth.get(r.month) / logos;
      const subscriptionOnly = mrrByMonth.get(r.month) / logos;
      return {
        month: r.month,
        activeLogos: logos,
        // The tab's own count, carried so the page can show the two agree
        // rather than asserting it.
        reportedLogos: r.activeLogos,
        arpa,
        subscriptionOnly,
        cogsPerLogo: r.cogsPerLogo,
        opexPerLogo: r.opexPerLogo,
        totalPerLogo: r.totalPerLogo,
        grossPerLogo: arpa - r.cogsPerLogo,
        grossMargin: arpa ? (arpa - r.cogsPerLogo) / arpa : null,
        netPerLogo: arpa - r.totalPerLogo,
        netMargin: arpa ? (arpa - r.totalPerLogo) / arpa : null,
        teams: r.teams,
      };
    });

  if (!months.length) return null;
  const recent = months.slice(-6);
  const meanOf = (rows, pick) => rows.reduce((s, m) => s + pick(m), 0) / rows.length;

  return {
    months,
    meanGrossMargin: meanOf(months, m => m.grossMargin),
    recentGrossMargin: meanOf(recent, m => m.grossMargin),
    recentNetMargin: meanOf(recent, m => m.netMargin),
    recentGrossPerLogo: meanOf(recent, m => m.grossPerLogo),
    recentNetPerLogo: meanOf(recent, m => m.netPerLogo),
    recentArpa: meanOf(recent, m => m.arpa),
    // Every team that carries cost of sales, totalled across the window.
    teamTotals: (() => {
      const totals = new Map();
      for (const m of months) {
        for (const team of m.teams) {
          totals.set(team.label, (totals.get(team.label) || 0) + (team.amount || 0));
        }
      }
      return [...totals.entries()]
        .map(([label, amount]) => ({ label, amount }))
        .sort((a, b) => b.amount - a.amount);
    })(),
    logosAgree: months.every(m => !m.reportedLogos || m.reportedLogos === m.activeLogos),
  };
}


// How much of what a cohort cost to win it has earned back by a given age.
//
// The ratio chart answers this with a multiple, which reads as alarming at an
// age where a healthy cohort is legitimately still below one. A share of cost
// recovered says the same thing without the arithmetic getting in the way:
// recovering half your cost by month six against a previous year's full
// recovery is a fact that needs no explaining.
//
// Contribution uses the measured cost of sales for the month rather than an
// assumed margin, so this moves when the cost of serving customers moves.
export function costRecovery(data, cohorts, { age = 6 } = {}) {
  const spend = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));
  const cogs = new Map((data.serve || []).map(r => [r.month, r.cogsPerLogo]));
  if (!cogs.size) return [];

  return cohorts.map(cohort => {
    const cost = spend.get(cohort.month);
    if (cost === undefined || !cohort.size || cohort.maxOffset < age) {
      return { month: cohort.month, value: null, size: cohort.size };
    }
    let recovered = 0;
    for (let k = 0; k <= age; k += 1) {
      const at = monthAdd(cohort.month, k);
      const perLogo = cogs.get(at);
      if (perLogo === undefined || perLogo === null) continue;
      recovered += (cohort.revenue[k] || 0) - perLogo * (cohort.logos[k] || 0);
    }
    return { month: cohort.month, value: recovered / cost, size: cohort.size };
  });
}


// Monthly churn split by how long a customer has been here.
//
// The cohort charts describe intakes and this describes the standing book, cut
// into tenure bands. It exists to answer one objection directly: that what has
// gone wrong is a new customer problem. Every band moved, and the tenured one
// is the largest share of the base, so it carries more of the damage in
// absolute terms even when its rate is lower.
//
// Three bands rather than two, because "new" and "everyone else" hides the
// thing worth seeing. The first months and the months just after onboarding
// ends behave differently from each other, and lumping them together reports
// one rate for two populations.
//
// Customers already present when the window opens have unknowable tenure and
// go in the oldest band, which is the conservative choice: it puts them in the
// band this is trying not to blame.
export function churnByTenure(data, { cuts = [3, 6, 12] } = {}) {
  const live = new Map();
  const firstSeen = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
    if (!live.has(row.month)) live.set(row.month, new Set());
    live.get(row.month).add(row.id);
    if (!firstSeen.has(row.id) || row.month < firstSeen.get(row.id)) {
      firstSeen.set(row.id, row.month);
    }
  }
  const months = [...live.keys()].sort();
  const position = new Map(months.map((m, i) => [m, i]));

  // Bands are built from the cut points so the labels and the arithmetic can
  // never disagree: [0,3) then [3,6) then [6,infinity).
  const edges = [0, ...cuts, Infinity];
  const bands = edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1];
    return {
      from,
      to,
      key: to === Infinity ? `${from}plus` : `${from}-${to}`,
      label: to === Infinity
        ? `${from} months and over`
        : (from === 0 ? `Under ${to} months` : `${from} to ${to} months`),
    };
  });

  const rows = months.slice(1).map((month, i) => {
    const before = live.get(months[i]);
    const now = live.get(month);
    const tally = bands.map(() => ({ base: 0, gone: 0 }));
    let totalGone = 0;

    for (const id of before) {
      const censored = firstSeen.get(id) === months[0];
      const tenure = position.get(months[i]) - position.get(firstSeen.get(id));
      const gone = !now.has(id);
      // A censored customer has no knowable tenure and goes in the last band.
      const index = censored
        ? bands.length - 1
        : bands.findIndex(b => tenure >= b.from && tenure < b.to);
      tally[index].base += 1;
      if (gone) { tally[index].gone += 1; totalGone += 1; }
    }

    return {
      month,
      bands: bands.map((b, k) => ({
        ...b,
        base: tally[k].base,
        gone: tally[k].gone,
        rate: tally[k].base ? tally[k].gone / tally[k].base : null,
        // What this band contributes to everyone who left that month, which is
        // the part that decides where fixing it would actually help.
        shareOfLosses: totalGone ? tally[k].gone / totalGone : null,
      })),
      totalGone,
      base: tally.reduce((s, x) => s + x.base, 0),
    };
  });

  rows.bands = bands;
  return rows;
}


// Customers present in every count who are paying nothing.
//
// Presence on this page is an event type, not an amount, so a customer booked
// down to zero MRR is still a live logo in every count that follows. This is
// the measurement underneath the cancellation policy, the gap between the logo
// and money retention curves, and a good deal of the revenue churn. It has
// been asserted in several notes and never drawn.
export function zeroMrrShare(data) {
  // A never-payer is a record to clean up, not a customer who stopped paying.
  // Counting them here made this chart 15% larger than the thing it describes.
  const never = neverPaidIds(data);
  const live = new Map();
  const zero = new Map();
  const zeroCash = new Map();
  for (const row of data.customers) {
    if (!row.active || never.has(row.id)) continue;
    live.set(row.month, (live.get(row.month) || 0) + 1);
    if (!(row.eopMrr > 0)) {
      zero.set(row.month, (zero.get(row.month) || 0) + 1);
      // Some of these are real customers whose MRR is simply not booked; the
      // rest have no money attached at all. Worth separating, because they are
      // different problems.
      const anyMoney = (row.netCash || 0) > 0 || (row.usage || 0) > 0
        || (row.oneTime || 0) > 0;
      if (!anyMoney) zeroCash.set(row.month, (zeroCash.get(row.month) || 0) + 1);
    }
  }
  return [...live.keys()].sort().map(month => ({
    month,
    base: live.get(month),
    zero: zero.get(month) || 0,
    share: live.get(month) ? (zero.get(month) || 0) / live.get(month) : null,
    noMoneyAtAll: zeroCash.get(month) || 0,
    noMoneyShare: live.get(month) ? (zeroCash.get(month) || 0) / live.get(month) : null,
  }));
}


// Acquisition cost broken out by category, month by month.
//
// The categories are the ones the spend actually divides into, not the
// ledger's own sections: who you employ to sell, what you buy to generate
// demand, and what it costs to stand in a room with customers. The bucket
// rules are the pipeline's; only the grouping is here.
//
// Partnerships is the one split line that reaches acquisition, at 100%.
// Customer Success is settled at 0% and Technical Account Manager sits in
// cost of sales, so neither appears. The total reconciles to
// cac_total_actual, which is what the pipeline itself reports.
export const COST_CATEGORIES = [
  { key: 'ae',          label: 'Account Executives',   match: /Account Executive/i },
  { key: 'sdr',         label: 'SDR',                  match: /SDR/i },
  { key: 'salesmgmt',   label: 'Sales management',     match: /Sales Management/i },
  { key: 'partnerships',label: 'Partnerships',         match: /Partnerships/i },
  { key: 'affiliate',   label: 'Affiliate marketing',  match: /Affiliate/i },
  { key: 'services',    label: 'Agencies and services',match: /Professional Services/i },
  { key: 'advertising', label: 'Advertising',          match: /Advertising/i },
  { key: 'software',    label: 'Sales software',       match: /S&M - Software/i },
  { key: 'events',      label: 'Trade shows and events',match: /6100-07/ },
  { key: 'travel',      label: 'Travel',               match: /6100-4[1-5]/ },
];

export function acquisitionCosts(data, { months = 12 } = {}) {
  const rows = data.expenses.filter(isAcquisition);

  const all = [...new Set(rows.map(e => e.month))].sort();
  const window = all.slice(-months);
  const inWindow = new Set(window);

  const byCategory = new Map();
  for (const c of COST_CATEGORIES) byCategory.set(c.key, new Map());
  const other = new Map();

  for (const e of rows) {
    if (!inWindow.has(e.month)) continue;
    const cat = COST_CATEGORIES.find(c => c.match.test(e.account || ''));
    const target = cat ? byCategory.get(cat.key) : other;
    target.set(e.month, (target.get(e.month) || 0) + (e.amount || 0));
  }

  const logos = new Map(data.waterfall.map(r => [r.month, r.newLogos]));
  const reported = new Map(data.cacMonthly.map(r => [r.month, r.reported]));

  const categories = COST_CATEGORIES.map(c => ({
    key: c.key,
    label: c.label,
    values: window.map(m => byCategory.get(c.key).get(m) || 0),
  }));
  const otherValues = window.map(m => other.get(m) || 0);
  if (otherValues.some(v => v > 0)) {
    categories.push({ key: 'other', label: 'Other acquisition', values: otherValues });
  }

  const totals = window.map((m, i) => categories.reduce((s, c) => s + c.values[i], 0));

  return {
    months: window,
    categories,
    totals,
    logos: window.map(m => logos.get(m) ?? null),
    costPerLogo: window.map((m, i) => {
      const n = logos.get(m);
      return n ? totals[i] / n : null;
    }),
    // What the pipeline says the same months cost, so the table can show
    // whether this build and the workbook agree.
    reported: window.map(m => reported.get(m) ?? null),
  };
}

// The whole book pooled, in logos and in money, on the same basis as chart 8.
//
// At each age the count is every customer of every cohort that has had that
// long to run, so nothing is excluded for being young and the line stops where
// the time does. The sample therefore shrinks as the line runs right, and the
// count behind each point is returned so the chart can show it.
//
// Both lines are indexed to month 1 rather than month 0. Month 0 carries the
// joining charge that was booked as MRR until mid-2025 and a part-billed first
// month besides, so indexing there would put a fee dropping out into the
// revenue line as though it were churn. Indexing both the same way is what
// makes the gap between them mean something: it is expansion and contraction
// among the survivors and nothing else.
export function blendedRetention(cohorts, { minAtRisk = 150, minCohorts = 4, maxMonths = 24 } = {}) {
  const eligible = cohorts.filter(c => c.survivors[1] > 0);
  if (!eligible.length) return [];

  const points = [];
  for (let age = 1; age < maxMonths; age += 1) {
    const live = eligible.filter(c => c.maxOffset >= age);
    const logoBase = live.reduce((s, c) => s + c.survivors[1], 0);
    const revenueBase = live.reduce((s, c) => s + (c.survivorRevenue[1] || 0), 0);
    // A tail resting on one or two cohorts is the oldest customers talking,
    // not the book, so the line stops before it gets there.
    if (live.length < minCohorts || logoBase < minAtRisk) break;
    points.push({
      offset: age,
      logos: logoBase ? live.reduce((s, c) => s + c.survivors[age], 0) / logoBase : null,
      // Both on the survivors, so the gap between the lines is expansion and
      // contraction among the customers who stayed rather than a difference in
      // who is being counted.
      revenue: revenueBase
        ? live.reduce((s, c) => s + (c.survivorRevenue[age] || 0), 0) / revenueBase : null,
      cohorts: live.length,
      atRisk: logoBase,
    });
  }

  // Where the logo line reads better than the month before. Survival cannot
  // rise, so it is always a cohort ageing out of the sample. Detected rather
  // than described, because the sample thins as the line runs right and which
  // months kink will move as new data lands.
  points.rises = points.filter((p, i) => i > 0 && p.logos > points[i - 1].logos + 1e-9)
    .map(p => {
      const before = points[points.indexOf(p) - 1];
      return { offset: p.offset, from: before.logos, to: p.logos,
               lostFromSample: before.atRisk - p.atRisk };
    });
  return points;
}


// Retention at a fixed age, one point per cohort. A cohort is only plotted
// once that age is behind it, otherwise its last observed month doubles as
// its retention and every recent cohort reads as perfect.
export function retentionAtAge(cohorts, age) {
  return cohorts.map(cohort => {
    if (cohort.maxOffset < age || !cohort.survivors[0]) {
      return { month: cohort.month, value: null };
    }
    // Against the signup month, so age 6 means six months after signing up
    // rather than five. Indexing to the second month, as this did, quietly
    // made every figure one month younger than its label.
    return { month: cohort.month, value: cohort.survivors[age] / cohort.survivors[0] };
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
// `windows` was 24 back when nothing could reach further than 24 months, so it
// did nothing; once the window widened it silently held this chart at the old
// sample. Null means every month with a complete forward window.
export function forwardSurvival(data, { horizon = 4, windows = null } = {}) {
  const activeByMonth = new Map();
  const firstMonth = new Map();

  for (const row of data.customers) {
    if (!row.active) continue;
    if (!activeByMonth.has(row.month)) activeByMonth.set(row.month, new Map());
    activeByMonth.get(row.month).set(row.id, row.eopMrr);

    const seen = firstMonth.get(row.id);
    if (seen === undefined || row.month < seen) firstMonth.set(row.id, row.month);
  }

  const months = [...activeByMonth.keys()].sort();
  const last = months[months.length - 1];
  const complete = months.filter(m => monthAdd(m, horizon) <= last);
  const starts = windows ? complete.slice(-windows) : complete;

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

export function correlate(input) {
  // Drop incomplete pairs rather than arithmetic on them. A single missing
  // month used to turn the whole correlation into NaN, which then rendered as
  // a blank where a reader would take it for "no relationship" rather than
  // "not computed".
  const pairs = input.filter(p =>
    p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  const sx = Math.sqrt(pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0));
  const sy = Math.sqrt(pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0));
  if (!sx || !sy) return null;
  return pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / (sx * sy);
}

// Retention by the year a customer arrived, on every cohort of that year.
//
// At age k the denominator is every customer of the year whose cohort has had
// k months to run, and the numerator is how many of those are still there.
// Cohorts too young to have reached age k are not in either, so the line
// extends only as far as there is time for it to.
//
// The sample therefore shrinks as the line runs right, and that has a visible
// consequence: the curve can rise. It is not customers coming back, which the
// survival rule forbids. It is a bad cohort ageing out of the denominator. In
// 2026 the June intake lost 43% in its first month, and when it drops out at
// age 3 the remaining customers read better than the month before. The count
// behind every point is returned so the chart can show it, because a reader
// who cannot see the denominator move cannot interpret the line.
//
// Survival, not presence: once a customer is absent they stay absent, so a
// customer who leaves and returns is not counted back in. Pooled by customer
// rather than averaged over cohorts, so a large intake carries more weight
// than a small one.
export function retentionByYear(cohorts, { maxMonths = 12, minAtRisk = 20 } = {}) {
  const byYear = new Map();
  for (const cohort of cohorts) {
    const year = cohort.month.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(cohort);
  }

  const years = [...byYear.keys()].sort().slice(-3);

  return years.map(year => {
    const group = byYear.get(year).filter(c => c.survivors[0] > 0);

    // Everything below is computed on the cohorts that have reached the age in
    // question, recomputed at every age rather than fixed once.
    const reached = age => group.filter(c => c.maxOffset >= age);
    const sum = (rows, pick) => rows.reduce((s, c) => s + (pick(c) || 0), 0);

    const points = [];
    const atRisk = [];
    const cohortsAt = [];
    const grossRevenue = [];
    const revenue = [];
    const logosFromMonth2 = [];

    for (let age = 0; age < maxMonths; age += 1) {
      const live = reached(age);
      const base = sum(live, c => c.survivors[0]);
      const enough = live.length && base >= minAtRisk;
      atRisk.push(enough ? base : null);
      cohortsAt.push(enough ? live.length : null);
      points.push(enough ? sum(live, c => c.survivors[age]) / base : null);

      // Money on the same footing: same cohorts, same age, indexed to month 2
      // because month 1 carried a joining charge as MRR until mid-2025 and a
      // part-billed first month leaves a customer under the rate they arrive
      // on.
      const capBase = sum(live, c => (c.cappedRetainedRevenue || [])[1]);
      grossRevenue.push(enough && capBase && age >= 1
        ? sum(live, c => (c.cappedRetainedRevenue || [])[age]) / capBase : null);

      const startBase = sum(live, c => (c.retainedStartingRevenue || [])[0]);
      revenue.push(enough && startBase
        ? sum(live, c => (c.retainedStartingRevenue || [])[age]) / startBase : null);

      const logoBase = sum(live, c => c.survivors[1]);
      logosFromMonth2.push(enough && logoBase && age >= 1
        ? sum(live, c => c.survivors[age]) / logoBase : null);
    }

    const deepest = points.reduce((last, v, i) => (v === null ? last : i), 0);

    // First month loss across every cohort of the year that has one. Reported
    // as a median as well as a mean, because a single bad intake moves a mean
    // by several points and a year holds only a handful of cohorts.
    const withFirstMonth = group.filter(c => c.maxOffset >= 1 && c.survivors[0] > 0);
    const lossOf = c => 1 - c.survivors[1] / c.survivors[0];
    const meanLoss = rows => (rows.length
      ? rows.reduce((s, c) => s + lossOf(c), 0) / rows.length : null);
    const medianLoss = rows => {
      if (!rows.length) return null;
      const sorted = rows.map(lossOf).sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const worst = withFirstMonth.length
      ? withFirstMonth.reduce((x, c) => (lossOf(c) > lossOf(x) ? c : x)) : null;

    // Where the line reads better than the month before. Always the sample
    // changing rather than customers returning, and worth naming rather than
    // leaving for someone to spot.
    const rises = [];
    for (let age = 1; age < points.length; age += 1) {
      if (points[age] !== null && points[age - 1] !== null
        && points[age] > points[age - 1] + 1e-9) {
        rises.push({ age, from: points[age - 1], to: points[age],
                     lostFromSample: (atRisk[age - 1] || 0) - (atRisk[age] || 0) });
      }
    }

    return {
      year,
      points,
      atRisk,
      cohortsAt,
      deepest,
      rises,
      cohorts: group.length,
      cohortsInYear: group.length,
      reach: deepest,
      reachedMonth6: reached(5).length,
      month3: points[3],
      month6: points[6],
      grossRevenue,
      grossMonth6: grossRevenue[6],
      grossMonth12: grossRevenue[12],
      revenue,
      revenueMonth6: revenue[6],
      revenueMonth12: revenue[12],
      logosFromMonth2,
      logosMonth6FromMonth2: logosFromMonth2[6],
      month1LossAll: meanLoss(withFirstMonth),
      month1MedianAll: medianLoss(withFirstMonth),
      month1ExWorst: meanLoss(withFirstMonth.filter(c => c !== worst)),
      month1WorstCohort: worst ? { month: worst.month, loss: lossOf(worst) } : null,
      cohortsWithFirstMonth: withFirstMonth.length,
      monthsCovered: withFirstMonth.length
        ? `${withFirstMonth[0].month} to ${withFirstMonth[withFirstMonth.length - 1].month}` : null,
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
// The rate a projection settles at once the observed path runs out.
//
// This took the last six steps of the path, which are the thinnest: a pooled
// path runs as deep as its oldest donor, so its final steps rest on one or two
// cohorts. Averaging exactly those to get the rate that carries every
// projection past the observed data put the most consequential number on the
// least evidence. It now averages the deepest steps that still have a real
// sample behind them, and the caller says what "real" means.
function terminalRate(path, depth = 6, counts = null, minDonors = 1) {
  const ages = [...path.keys()]
    .filter(k => !counts || (counts.get(k) || 0) >= minDonors)
    .sort((a, b) => a - b)
    .slice(-depth);
  if (!ages.length) return 0.97;
  return ages.reduce((s, k) => s + path.get(k), 0) / ages.length;
}

// The pooled donor trajectory: what one month of a cohort's revenue does to
// the next, averaged over every cohort old enough to have shown it.
//
// Both projections on this page read it. The equal-age chart could compute
// its own and would then disagree with the break-even projection about what
// the same young cohort is worth, which is the defect that produced three
// cost-per-logo figures: one number, two implementations, and the quiet one
// stays wrong.
export function donorTrajectory(cohorts, { halfLife = null } = {}) {
  // Donors need enough history to be worth pooling, but requiring a full year
  // of it excluded every recent cohort by construction: nothing from 2026 can
  // be twelve months old, so the path projecting 2026 cohorts was built
  // entirely from 2024 and 2025, the era that retained better. Six months
  // lets the newest cohorts contribute to the steps they actually have while
  // the deep steps still fall back on the older ones, which is unavoidable and
  // is what the per-step donor count below makes visible.
  const donors = cohorts.filter(c => c.month >= '2023-01' && c.maxOffset >= 6);
  const weigh = donorWeights(donors, halfLife);
  const numerator = new Map();
  const denominator = new Map();
  const counts = new Map();
  for (const cohort of donors) {
    const w = weigh(cohort);
    for (let k = 1; k < cohort.revenue.length; k += 1) {
      if (cohort.revenue[k - 1] <= 0) continue;
      numerator.set(k, (numerator.get(k) || 0) + w * cohort.revenue[k]);
      denominator.set(k, (denominator.get(k) || 0) + w * cohort.revenue[k - 1]);
      counts.set(k, (counts.get(k) || 0) + w);
    }
  }

  // A pooled path runs as deep as its oldest donor, so its deepest steps rest
  // on one or two cohorts and move with them. Steps below half the donor pool
  // are dropped rather than drawn, and the terminal rate is taken from the
  // deepest steps that survive that rule.
  const minDonors = Math.max(2, weigh.total / 2);
  const path = new Map();
  for (const [k, den] of denominator) {
    if (den > 0 && (counts.get(k) || 0) >= minDonors) path.set(k, numerator.get(k) / den);
  }
  return {
    donors, path, counts, minDonors,
    depth: path.size ? Math.max(...path.keys()) : 0,
    terminal: terminalRate(path, 6, counts, minDonors),
  };
}

// A projected month has no revenue class breakdown to work from, so a cohort
// carries its own realised margin forward rather than the flat assumption.
// Same rule wherever a month is projected.
export function realisedMargin(cohort, margin) {
  const revenue = cohort.revenue.slice(0, cohort.maxOffset + 1).reduce((s, v) => s + v, 0);
  const profit = (cohort.profit || []).slice(0, cohort.maxOffset + 1).reduce((s, v) => s + v, 0);
  return revenue > 0 ? profit / revenue : margin;
}

export function projectedBreakEven(data, cohorts, options) {
  const { csShare, partnershipsShare, margin, replicates = 300, horizon = 120 } = options;
  const cac = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));

  // Donors need enough history to lend a trajectory, and recent enough to be
  // lending one from the same regime.
  const { donors, path: pooled, terminal: pooledTerminal } = donorTrajectory(cohorts);
  const donorPaths = donors.map(ratioPath);
  const donorTerminals = donorPaths.map(p => terminalRate(p));

  // Observed months use the same per class gross profit as the cohort table.
  // Projected months have no class breakdown to work from, so they carry the
  // cohort's own realised profit margin forward rather than a flat assumption,
  // which keeps the two halves of a single curve on one definition.
  const monthsToCover = (cohort, cost, path, terminal) => {
    const effective = realisedMargin(cohort, margin);

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
    // The same rule as cohortEconomics. Two cost-per-logo figures on one page
    // was how a third denominator appeared out of nowhere.
    const cost = (spend === undefined || !cohort.size) ? null : spend / cohort.size;
    if (cost === null) return null;

    // What actually happened, using only observed months. Same function the
    // cohort table uses, so the two cannot drift apart.
    const actual = observedPayback(cohort, cost, margin);

    const base = {
      month: cohort.month, size: cohort.size, cost,
      cohortLogos: cohort.size,
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
export function capacityAnalysis(data, { horizon = 4, windows = null } = {}) {
  const activeByMonth = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
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

  // Every month the spend covers, not only the ones with a full forward
  // window. Capacity is known right up to the trailing month; it is the churn
  // that cannot be measured for the last few, so that series carries nulls and
  // the line stops while the spending line runs on. Truncating both to the
  // shorter one threw away four months of the thing being asked about.
  const points = months
    .filter(m => csTotal.has(m) && newLogos.get(m) != null)
    .slice(windows ? -(windows + horizon) : 0)
    .map(month => {
      const base = activeByMonth.get(month);
      const complete = monthAdd(month, horizon) <= last;
      const later = complete ? (activeByMonth.get(monthAdd(month, horizon)) || new Set()) : null;
      let kept = 0;
      if (later) for (const id of base) if (later.has(id)) kept += 1;
      return {
        month,
        churn: later ? 1 - kept / base.size : null,
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

  // Everything statistical below runs on the complete rows only. The partial
  // tail is for drawing, not for measuring.
  const measured = points.filter(p => p.churn !== null);
  const churn = measured.map(p => p.churn);
  const arrivals = measured.map(p => p.newLogos);
  const capacity = measured.map(p => p.csPerLogo);
  const wholeFunction = measured.map(p => p.retentionPerLogo);
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
  // Average subscription booked in each measured month, lined up with the
  // same months the other series use.
  const priceByMonth = new Map();
  for (const row of data.customers) {
    if (row.eventType !== 'new' || !row.newMrr || row.newMrr <= 0) continue;
    if (!priceByMonth.has(row.month)) priceByMonth.set(row.month, []);
    priceByMonth.get(row.month).push(row.newMrr);
  }
  const priceSeries = measured.map(p => {
    const v = priceByMonth.get(p.month);
    return v && v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  });

  const rolling = (xs, width = 12) => measured.map((_, i) => {
    if (i < width - 1) return null;
    const a = xs.slice(i - width + 1, i + 1);
    const b = churn.slice(i - width + 1, i + 1);
    return pair(a, b);
  });

  return {
    points,
    measured,
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
    // Price belongs on this chart as much as spend does. It is the one lever
    // the business has actually pulled over the window, and the pooled tests
    // elsewhere say higher payers churn less, so whether that relationship is
    // strengthening or fading is worth watching rather than assuming.
    rollingPrice: rolling(priceSeries),
    priceAgainstChurn: pair(priceSeries, churn),
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
    if (!row.active) continue;
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
    if (!row.active) continue;
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

  // How much of each month this tab actually holds.
  //
  // The signups tab is filled in by hand and it runs behind. Every customer
  // who starts paying produces a `new` event in the customer file, so that is
  // the count to measure it against. Coverage was complete in January and is
  // near half by June, which means the recent months of any chart drawn from
  // this tab rest on a part of their intake rather than all of it. Falling
  // coverage also looks exactly like falling sales if nobody checks, and it is
  // the reason the tab reads about 25 a month while the billed count holds
  // near 46.
  const billed = new Map();
  for (const row of data.customers) {
    if (row.eventType !== 'new') continue;
    billed.set(row.month, (billed.get(row.month) || 0) + 1);
  }

  const series = months.map(month => {
    const group = byMonth.get(month);
    const startingMrr = group.reduce((s, r) => s + r.startingMrr, 0);
    const withFee = group.filter(r => r.setupFee > 0);
    const feeTotal = withFee.reduce((s, r) => s + r.setupFee, 0);
    const paidBelow = group.filter(r => r.firstPayment < r.startingMrr).length;
    const billedNew = billed.get(month) || 0;
    return {
      month,
      count: group.length,
      billedNew,
      coverage: billedNew ? group.length / billedNew : null,
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
    if (!row.active) continue;
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
    if (!row.active) continue;
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
// `windows` caps how many starting months are used. It was 24 when nothing on
// this page could reach further than 24 months anyway, so it did nothing; once
// the window widened to the full reach of the finance data it silently became
// the binding constraint and held this chart at its old sample. Null means use
// every eligible month, which is what it always meant to do.
export function arrivalsAgainstChurn(data, { horizon = 4, windows = null } = {}) {
  const active = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
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
  const eligibleAtMax = eligible(maxHorizon);
  const anchor = new Set(windows ? eligibleAtMax.slice(-windows) : eligibleAtMax);
  const months = eligible(horizon).filter(m => anchor.has(m));

  // Everyone active in the starting month, followed forward.
  //
  // Briefly changed to follow the month's own intake instead, so this and
  // chart 8 measured the same population. That was not needed: what made the
  // two disagree was a sample rule inside chart 8, and fixing that removed the
  // contradiction on its own. Following the intake also cost most of the
  // precision here, since a month brings about forty five customers against a
  // standing base of eleven hundred, and on forty five the values quantise in
  // two point steps and a month with no departures reads as a flat zero. The
  // question this chart asks is whether a thin month costs the business
  // customers, which is about the book rather than the intake, so the book is
  // what it follows.
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
// than carved out. That decomposition is inferred from the shape of the data
// rather than stated by the push, and it is written on the page so it can be
// corrected rather than assumed.
export const CLASS_MARGINS = {
  platform: 0.757,
  usage: 0.60,
  oneTime: 0.90,
  passThrough: 0,
  recognisedElsewhere: 0,
};

// The class columns sit alongside recognised MRR, not inside it.
//
// This used to carve usage and pass-through out of eop_mrr before applying the
// platform margin, on the assumption that eop_mrr was a total the classes
// divided up. It is not. Against net_cash, eop_mrr plus the classes matches to
// the cent on 69% of rows where eop_mrr alone matches on 27%, and 863 rows
// carry more class revenue than they carry MRR at all, which is impossible if
// one contained the other. The ledger agrees: eop_mrr tracks 4000-11 Platform
// Revenue Recurring, while usage sits in its own account, 4000-22.
//
// Carving therefore subtracted revenue that was never in the base and cost
// about 6% of gross profit in the months that carry classes. It moved no
// ranking and changed no conclusion, but it was wrong in the direction of
// pessimism and it is not the kind of thing to leave in.
export function grossProfit(row, margins = CLASS_MARGINS) {
  return (row.eopMrr || 0) * margins.platform
    + (row.usage || 0) * margins.usage
    + (row.oneTime || 0) * margins.oneTime
    + (row.passThrough || 0) * margins.passThrough
    + (row.recognisedElsewhere || 0) * margins.recognisedElsewhere;
}

// The platform margin, solved for rather than assumed.
//
// 0.757 was an estimate carried on this page from the beginning, and the cost
// ledger disagrees with it by about twenty points. Now that cost of sales is
// measured monthly there is no reason to keep guessing: the other classes have
// defensible margins of their own, so the platform figure is whatever makes
// the whole book add up to what the ledger actually says.
//
//   platform = (all revenue - cost of sales - 0.60 x usage - 0.90 x one-time)
//              / platform revenue
//
// Pass-through and recognised-elsewhere stay at zero and so drop out. The
// result runs between 0.44 and 0.66 across the window, against the flat 0.757
// it replaces, and it moves month to month because the cost of serving the
// book moves month to month. A cohort passing through an expensive month is
// charged for it.
//
// Months with no cost row fall back to the mean of the months that have one,
// which is stated wherever this is used rather than hidden.
export function platformMargins(data) {
  const cogs = new Map((data.serve || []).map(r => [r.month, r.cogsTotal]));
  if (!cogs.size) return { byMonth: new Map(), mean: CLASS_MARGINS.platform, measured: false };

  const totals = new Map();
  for (const row of data.customers) {
    if (!row.active) continue;
    const a = totals.get(row.month) || { P: 0, U: 0, O: 0, T: 0, R: 0 };
    a.P += row.eopMrr || 0;
    a.U += row.usage || 0;
    a.O += row.oneTime || 0;
    a.T += row.passThrough || 0;
    a.R += row.recognisedElsewhere || 0;
    totals.set(row.month, a);
  }

  const byMonth = new Map();
  for (const [month, a] of totals) {
    const cost = cogs.get(month);
    if (cost === undefined || cost === null || a.P <= 0) continue;
    const revenue = a.P + a.U + a.O + a.T + a.R;
    const margin = (revenue - cost
      - CLASS_MARGINS.usage * a.U
      - CLASS_MARGINS.oneTime * a.O) / a.P;
    // A month that lands outside [0, 1] is a data problem rather than a
    // finding, and letting it through would put a negative margin into every
    // cohort passing through it.
    if (margin > 0 && margin < 1) byMonth.set(month, margin);
  }

  const values = [...byMonth.values()];
  return {
    byMonth,
    mean: values.length
      ? values.reduce((s, v) => s + v, 0) / values.length
      : CLASS_MARGINS.platform,
    measured: values.length > 0,
    months: values.length,
    low: values.length ? Math.min(...values) : null,
    high: values.length ? Math.max(...values) : null,
  };
}

export function hasRevenueClasses(data) {
  return data.customers.some(r => r.usage || r.oneTime || r.passThrough);
}

// How much of the derived new logo count comes from each Stripe environment.
//
// New business has been moving to the second environment and its customers
// are largely not reaching the cohort build: they appear in the file and
// never register revenue. That makes any statement about new logo volume a
// statement about the first environment, which is a different and much
// gloomier claim than the one it looks like.
export function environmentSplit(data) {
  const firstRevenue = new Map();
  const source = new Map();
  const everRevenue = new Set();

  for (const row of data.customers) {
    if (row.source && !source.has(row.id)) source.set(row.id, row.source);
    if (!row.active) continue;
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
