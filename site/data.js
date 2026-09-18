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

// Nothing reaches a chart from more than two years back. A hard limit rather
// than a per chart window, applied once where the data is read, so no chart
// can quietly reach further: several of the findings on this page turned on
// exactly that, where a longer reach pulled in an era that behaved
// differently and the extra months did the work.
const MONTHS_OF_HISTORY = 24;

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
const OPTIONAL_TABS = ['QB Accounts', 'Subscription Lifetimes', 'New Customer Cohorts'];

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
  const cacMonthly = complete(byTab['CAC Monthly'].rows).map(r => ({
    month: r.month,
    cacTotalActual: num(r.cac_total_actual),
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

  const expenses = byTab['QB Expenses'].rows
    .filter(r => inWindow(r.month))
    .map(r => ({
      account: r.account,
      section: r.section,
      month: r.month,
      amount: num(r.amount),
      bucket: r.bucket,
    }));

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
    const runLength = new Map();
    for (const id of ids) {
      const months = activeByCustomer.get(id);
      let k = 0;
      while (k <= maxOffset && months.has(monthAdd(month, k))) k += 1;
      runLength.set(id, k);
    }
    const survivors = [];
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
      let intact = 0;
      for (const id of ids) if (runLength.get(id) > offset) intact += 1;
      survivors.push(intact);
    }

    return { month, size: logos[0] || ids.length, ids, logos, survivors, revenue, profit, maxOffset };
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
  const rows = data.expenses.filter(e =>
    e.bucket === 'CAC' || (e.bucket === 'SPLIT' && /Partnerships/i.test(e.account || '')));

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
  const reported = new Map(data.cacMonthly.map(r => [r.month, r.cacTotalActual]));

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

// Blended retention, indexed to month 2.
//
// Month 1 carries setup and onboarding fees, so indexing there turns a
// one-off charge ending into what reads as a cliff. The sample rule keeps the
// tail from being drawn by a handful of old cohorts.
export function blendedRetention(cohorts, { minCohorts = 12, maxMonths = 24 } = {}) {
  const points = [];
  for (let offset = 1; ; offset += 1) {
    // Two limits, whichever bites first. The sample rule stops the tail being
    // drawn by a handful of old cohorts, and the horizon keeps the curve to a
    // span somebody can actually reason about.
    if (offset + 1 > maxMonths) break;
    const inSample = cohorts.filter(c => c.maxOffset >= offset && c.survivors[1] > 0);
    if (inSample.length < minCohorts) break;

    const logoBase = inSample.reduce((sum, c) => sum + c.survivors[1], 0);
    const revenueBase = inSample.reduce((sum, c) => sum + c.revenue[1], 0);
    points.push({
      offset: offset + 1,
      // Survival for the logo line, presence for revenue. A customer who
      // returns is genuinely paying again, so revenue counts them; retention
      // asks how much of the intake is left, so it does not.
      logos: logoBase ? inSample.reduce((s, c) => s + c.survivors[offset], 0) / logoBase : null,
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
    if (cohort.maxOffset < offset || !cohort.survivors[1]) {
      return { month: cohort.month, value: null };
    }
    return { month: cohort.month, value: cohort.survivors[offset] / cohort.survivors[1] };
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
    if (!row.active) continue;
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
    const group = byYear.get(year).filter(c => c.survivors[0] > 0);

    // The sample has to be the same at every age, or the line moves because
    // its membership moved. Recomputing it per point let the 2026 curve run
    // 86.7% then 91.6%: the cohorts that had reached month four were simply
    // better than the ones that had only reached month three. Fix the set to
    // the cohorts that reach the far end, then read every point off it, and
    // stop the line where that set would have to change.
    let reach = 0;
    for (let offset = maxMonths - 1; offset >= 0; offset -= 1) {
      if (group.filter(c => c.maxOffset >= offset).length >= minCohorts) { reach = offset; break; }
    }
    const inSample = group.filter(c => c.maxOffset >= reach);
    const base = inSample.reduce((s, c) => s + c.survivors[0], 0);

    const points = [];
    for (let offset = 0; offset < maxMonths; offset += 1) {
      if (offset > reach || !base || inSample.length < minCohorts) { points.push(null); continue; }
      points.push(inSample.reduce((s, c) => s + c.survivors[offset], 0) / base);
    }
    const reached = offset => group.filter(c => c.maxOffset >= offset).length;
    return {
      year,
      cohorts: inSample.length,
      cohortsInYear: group.length,
      reach,
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

// The pooled donor trajectory: what one month of a cohort's revenue does to
// the next, averaged over every cohort old enough to have shown it.
//
// Both projections on this page read it. The equal-age chart could compute
// its own and would then disagree with the break-even projection about what
// the same young cohort is worth, which is the defect that produced three
// cost-per-logo figures: one number, two implementations, and the quiet one
// stays wrong.
export function donorTrajectory(cohorts) {
  const donors = cohorts.filter(c => c.month >= '2023-01' && c.maxOffset >= 12);
  const numerator = new Map();
  const denominator = new Map();
  for (const cohort of donors) {
    for (let k = 1; k < cohort.revenue.length; k += 1) {
      if (cohort.revenue[k - 1] <= 0) continue;
      numerator.set(k, (numerator.get(k) || 0) + cohort.revenue[k]);
      denominator.set(k, (denominator.get(k) || 0) + cohort.revenue[k - 1]);
    }
  }
  const path = new Map();
  for (const [k, den] of denominator) if (den > 0) path.set(k, numerator.get(k) / den);
  return { donors, path, terminal: terminalRate(path) };
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
export function capacityAnalysis(data, { horizon = 4, windows = 24 } = {}) {
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
    .slice(-(windows + horizon))
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
export function arrivalsAgainstChurn(data, { horizon = 4, windows = 24 } = {}) {
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
