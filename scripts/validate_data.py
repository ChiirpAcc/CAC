#!/usr/bin/env python3
"""Check a data push and report what looks wrong.

The workbook used to carry its own checks. Those were removed when it became
a pipeline, and the site derives everything now, so nothing between the Stripe
export and a chart looks at the numbers. A bad push lands silently and the
first person to notice is whoever reads a wrong chart and believes it.

This does not block the deploy. A push that fails here still publishes,
because a site showing questionable data with a warning beside it is more
useful than no site. It opens an issue instead.

Two rules run through all of it, and they are the two that have actually
bitten. Months are YYYY-MM text, because Sheets reparses an unprotected
2025-01 and 2025-1 sorts after 2025-10. And blank is null, never zero,
because a cohort that never recovered has no payback number and zero plots
as instant payback.
"""

import json
import re
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
LIVE_EVENTS = {"new", "reactivation", "flat", "expansion", "contraction"}

MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

REQUIRED_TABS = {
    "Waterfall Summary": {
        "file": "waterfall_summary.json",
        "min_rows": 24,
        "months": ["month"],
        "not_all_blank": ["active_logos", "new_logos", "churned_logos"],
    },
    "CAC Monthly": {
        "file": "cac_monthly.json",
        "min_rows": 12,
        "months": ["month"],
        "not_all_blank": ["cac_total_actual"],
    },
    "QB Expenses": {
        "file": "qb_expenses.json",
        "min_rows": 100,
        "months": ["month"],
        "not_all_blank": ["amount"],
        "allowed": {"bucket": ["CAC", "COGS", "SPLIT", "OPEN", "EXCLUDED", "UNMAPPED"]},
    },
    "Customer Waterfall": {
        "file": "customer_waterfall.json",
        "min_rows": 1000,
        "months": ["month"],
        "not_all_blank": ["eop_mrr"],
    },
}

findings = []


def report(level, tab, message):
    findings.append({"level": level, "tab": tab, "message": message})


def number(value):
    """Parse a cell the way the site does, so the checks see what charts see."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("$", "")
    if text in ("", "-", "--") or text.lower() in ("n/a", "na"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


# The push can send rows either way.
#
# Until v102 each row was an object repeating its column names. From v102 a
# tab may instead send bare arrays with the names carried once in "columns",
# declared by "row_format": "arrays". Both forms are in the wild, so read the
# declaration rather than sniffing: an empty tab sniffs as neither.
def widen(doc, name="?"):
    if not isinstance(doc, dict) or doc.get("row_format") != "arrays":
        return doc
    # index.json carries the declaration for the whole push and has no rows
    # of its own, so there is nothing to widen.
    if "rows" not in doc:
        return doc
    columns = doc.get("columns") or []
    if not columns:
        raise ValueError(f'{name}: row_format is "arrays" but columns is missing')
    rows = []
    for i, row in enumerate(doc.get("rows") or []):
        if not isinstance(row, list):
            rows.append(row)
            continue
        if len(row) > len(columns):
            raise ValueError(
                f"{name}: row {i} has {len(row)} values against {len(columns)} columns")
        rows.append({c: (row[j] if j < len(row) else None)
                     for j, c in enumerate(columns)})
    return {**doc, "rows": rows}


def load(name):
    path = DATA / name
    if not path.exists():
        return None
    return widen(json.loads(path.read_text(encoding="utf-8")), name)


def check_tab(tab, spec, doc):
    rows = doc.get("rows", [])

    if len(rows) < spec["min_rows"]:
        report("error", tab,
               f"{len(rows)} rows, fewer than the {spec['min_rows']} expected. "
               f"The tab was probably not rebuilt, or a filter is hiding rows.")

    stated = doc.get("row_count")
    if stated is not None and stated != len(rows):
        report("error", tab,
               f"row_count says {stated} but there are {len(rows)} rows. "
               f"The push was interrupted partway through writing this file.")

    for column in spec.get("months", []):
        bad = [r.get(column) for r in rows
               if not (r.get(column) and MONTH.match(str(r[column])))]
        if bad:
            sample = ", ".join(repr(v) for v in list(dict.fromkeys(map(str, bad)))[:4])
            report("error", tab,
                   f"column {column!r} has {len(bad)} values that are not YYYY-MM text "
                   f"({sample}). The column lost its plain-text format and Sheets reparsed "
                   f"it as a date. As text 2025-1 sorts after 2025-10, so cost months stop "
                   f"lining up with cohort months without looking wrong.")

    for column in spec.get("not_all_blank", []):
        values = [number(r.get(column)) for r in rows]
        if all(v in (None, 0) for v in values):
            report("error", tab,
                   f"column {column!r} is entirely blank or zero across {len(rows)} rows. "
                   f"A column this central is never legitimately all zero.")

    for column, allowed in spec.get("allowed", {}).items():
        permitted = set(allowed)
        bad = sorted({str(r.get(column)) for r in rows
                      if r.get(column) is not None and r.get(column) not in permitted})
        if bad:
            report("error", tab,
                   f"column {column!r} holds values outside {sorted(permitted)}: "
                   f"{', '.join(bad[:5])}. Either a new classification was introduced "
                   f"upstream or a typo crept in.")


def check_zero_for_blank(doc, tab, columns):
    """A column that is suspiciously free of nulls where nulls are expected."""
    rows = doc.get("rows", [])
    for column in columns:
        if column not in doc.get("columns", []):
            continue
        nulls = sum(1 for r in rows if r.get(column) is None)
        zeros = sum(1 for r in rows if number(r.get(column)) == 0)
        if nulls == 0 and zeros > len(rows) * 0.3:
            report("warning", tab,
                   f"column {column!r} has no nulls but {zeros} zeros across {len(rows)} "
                   f"rows. Blanks may be arriving as zero, which plots as a real "
                   f"observation and means the opposite of missing.")


def check_presence_is_not_payment(waterfall, customers):
    """Catch presence being decided by whether cash arrived.

    A customer who is billed but misses a payment drops to zero, reads as
    churned, and reads as a reactivation when they pay again. Presence and
    payment are different questions, and treating them as one inflates both
    sides of the funnel while the base drifts down.

    Neither check below looks at a single month, because a single month never
    breaches a sensible threshold. The signature is a rate that stays high.
    """
    rows = [r for r in waterfall.get("rows", []) if MONTH.match(str(r.get("month", "")))]
    rows.sort(key=lambda r: r["month"])

    # A base does not reactivate a large share of itself every year. Twelve
    # months smooths out a seasonal return and still catches a standing rate.
    window = rows[-13:]
    if len(window) >= 13:
        reactivated = sum(number(r.get("reactivated_logos")) or 0 for r in window[1:])
        bases = [number(r.get("active_logos")) or 0 for r in window[:-1]]
        average = sum(bases) / len(bases) if bases else 0
        if average >= 200 and reactivated / average > 0.15:
            report("error", "Waterfall Summary",
                   f"{reactivated:,.0f} reactivations over the last twelve months against an "
                   f"average base of {average:,.0f}, {reactivated / average:.0%}. A base does "
                   f"not reactivate that share of itself in a year. This is the signature of "
                   f"presence being decided by whether a payment arrived: a billed customer "
                   f"who misses a month reads as churned and reads as reactivated when they "
                   f"pay again. Churn and acquisition are both inflated and the base drifts "
                   f"down.")

    # The same fault seen per customer rather than in the totals.
    #
    # A revenue gap is not the fault and never was. A billed customer who pays
    # late has a zero month and belongs in the base throughout, which is why
    # presence is read from event_type. The fault is that gap being recorded as
    # a departure: a churn with revenue on both sides of it, which invents a
    # loss and an acquisition out of one late payment.
    if not customers:
        return
    by_customer = {}
    for row in customers.get("rows", []):
        by_customer.setdefault(row.get("customer_id"), {})[row.get("month")] = (
            number(row.get("eop_mrr")) or 0, str(row.get("event_type") or ""))

    spurious = 0
    paying = 0
    gap_only = 0
    for months in by_customer.values():
        keys = sorted(k for k in months if k)
        live = [i for i, k in enumerate(keys) if months[k][0] > 0]
        if not live:
            continue
        paying += 1
        first, last = live[0], live[-1]
        interior = range(first + 1, last)
        if any(months[keys[i]][0] == 0 for i in interior):
            gap_only += 1
        if any(months[keys[i]][1] == "churn" for i in interior):
            spurious += 1

    if paying and spurious / paying > 0.05:
        report("error", "Customer Waterfall",
               f"{spurious:,} of {paying:,} paying customers ({spurious / paying:.0%}) are "
               f"marked churned in a month that has revenue on both sides of it. A customer "
               f"who was there in March and there in May did not leave in April, so presence "
               f"is being read from payment rather than from a subscription or a base "
               f"membership.")
    elif gap_only:
        report("note", "Customer Waterfall",
               f"{gap_only:,} of {paying:,} paying customers ({gap_only / paying:.0%}) have a "
               f"zero revenue month with revenue on both sides. None of them is recorded as a "
               f"departure, which is the expected shape: these are late payments, and "
               f"presence is carried by event_type rather than by the amount.")


def check_departures_are_booked(waterfall, customers):
    """Catch customers leaving the base without a churn event.

    churned_logos books a departure when the pipeline sees the transition. A
    customer whose subscription drops out of the Stripe export never produces
    one: they are present one month, absent the next, and nothing is recorded.
    Those are real departures, not test accounts, and leaving them uncounted
    understates churn by enough to reverse the direction of the base.
    """
    if not customers:
        return
    live = {}
    for row in customers.get("rows", []):
        month = str(row.get("month", ""))
        if not MONTH.match(month) or row.get("event_type") not in LIVE_EVENTS:
            continue
        live.setdefault(month, set()).add(row.get("customer_id"))

    months = sorted(live)
    if len(months) < 8:
        return
    window = months[-6:]

    left = 0
    for month in window:
        previous = months[months.index(month) - 1]
        left += len(live[previous] - live[month])

    booked = 0
    for row in waterfall.get("rows", []):
        if str(row.get("month", "")) in window:
            booked += number(row.get("churned_logos")) or 0

    if booked and left > booked * 1.15:
        report("error", "Waterfall Summary",
               f"over {window[0]} to {window[-1]} the push books {booked:,.0f} departures "
               f"while {left:,} customers present in one month are absent the next, "
               f"{left / booked - 1:.0%} more. A customer whose subscription drops out of "
               f"the source stops appearing without generating a churn event, so churn is "
               f"understated. Check the derived figure before using churned_logos.")
    elif booked:
        report("note", "Waterfall Summary",
               f"departures reconcile: {booked:,.0f} booked against {left:,} observed over "
               f"the last six months.")



LEAD_MEDIUMS = {"event", "webinar", "digital", "partner or referral"}
YEAR_PREFIX = re.compile(r"^20\d\d - ")


def check_lead_source(customers):
    """The four checks the v120 brief asks for on lead_source and lead_medium.

    A blank is expected for most customers, so a high blank rate is a note. A
    blank rate of 100% is not: it means the Lead Source tab was empty or the
    join to Stripe found nothing, and every event figure on the page then
    reads zero for a reason that has nothing to do with events.
    """
    if not customers:
        return
    cols = customers.get("columns") or []
    if "lead_source" not in cols:
        return
    source_of, medium_of, conflicts = {}, {}, 0
    for r in customers["rows"]:
        src = str(r.get("lead_source") or "").strip()
        med = str(r.get("lead_medium") or "").strip()
        cid = r.get("customer_id")
        if not src:
            continue
        if cid in source_of and source_of[cid] != src:
            conflicts += 1
        source_of[cid] = src
        medium_of[cid] = med
    ids = {r.get("customer_id") for r in customers["rows"]}
    if not source_of:
        report("error", "Customer Waterfall",
               f"lead_source and lead_medium are present but blank on all {len(customers['rows']):,} "
               f"rows. The brief expects most customers untagged, never all of them: the Lead "
               f"Source tab is empty or the Stripe id join matched nothing. Every event figure "
               f"on the page reads zero until this is fixed.")
        return
    bad = sorted({m for m in medium_of.values() if m not in LEAD_MEDIUMS})
    if bad:
        report("warning", "Customer Waterfall",
               f"lead_medium carries values outside the four mediums: {', '.join(bad)}.")
    event_no_year = sorted({s for c, s in source_of.items()
                            if medium_of[c] == "event" and not YEAR_PREFIX.match(s)})
    # v149 keeps a year-prefixed podcast or webinar out of event, by a deny list.
    year_not_event = sorted({s for c, s in source_of.items()
                             if medium_of[c] != "event" and YEAR_PREFIX.match(s)
                             and not re.search(r"podcast|webinar", s, re.I)})
    if event_no_year or year_not_event:
        report("warning", "Customer Waterfall",
               f"the year-prefix rule does not hold: {len(event_no_year)} event values without a "
               f"year ({', '.join(event_no_year[:4])}), {len(year_not_event)} year-prefixed values not "
               f"marked event ({', '.join(year_not_event[:4])}).")
    if conflicts:
        report("warning", "Customer Waterfall",
               f"{conflicts} rows carry a lead_source different from the same customer's other "
               f"rows. A customer keeps one source.")
    if "lead_source_first" in cols:
        firsts = [r for r in customers["rows"] if str(r.get("lead_source_first") or "").strip()]
        if firsts and not any(str(r.get("lead_source_first_at") or "").strip() for r in firsts):
            report("warning", "Customer Waterfall", "lead_source_first is filled but lead_source_first_at is blank on "
                   "every row, so first-touch tags cannot be dated.")
    set_at = [r for r in customers["rows"] if str(r.get("lead_source") or "").strip()]
    if "lead_set_at" in cols and set_at and not any(str(r.get("lead_set_at") or "").strip() for r in set_at):
        # A note, not a warning: the pipeline is not being changed (Oct 2026),
        # so this would fire on every push. The Events tab says it at the top.
        report("note", "Customer Waterfall",
               f"lead_set_at is present but blank on every tagged row, so the site cannot tell a tag "
               f"written on the day from one added in a batch months later.")
    counts = {}
    for m in medium_of.values():
        counts[m] = counts.get(m, 0) + 1
    report("note", "Customer Waterfall",
           f"lead source on {len(source_of):,} of {len(ids):,} customers "
           f"({len(source_of) / len(ids):.0%}); by medium "
           + ", ".join(f"{k} {v:,}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1]))
           + ".")


def check_ledger_closed(expenses):
    """Flag a trailing ledger month that has not closed in QuickBooks.

    The site stops at the last month whose ledger is at least half the median
    of the six before it. This says so on the push, so the reader of the
    report knows why the page ends a month earlier than the customer file.
    """
    if not expenses:
        return
    totals = {}
    for r in expenses["rows"]:
        v = number(r.get("amount"))
        m = str(r.get("month") or "")
        if v is None or not MONTH.match(m):
            continue
        totals[m] = totals.get(m, 0.0) + v
    months = sorted(totals)
    if len(months) < 4:
        return
    last = months[-1]
    prior = sorted(totals[m] for m in months[-7:-1])
    mid = len(prior) // 2
    median = prior[mid] if len(prior) % 2 else (prior[mid - 1] + prior[mid]) / 2
    if totals[last] < median * 0.5:
        report("note", "QB Expenses",
               f"{last} holds ${totals[last]:,.0f} of ledger against a median of ${median:,.0f}, "
               f"so it has not closed. The site stops at the month before it until it does.")

def check_missing_customers(customers):
    """Stripe customers the workbook's payment tabs never picked up.

    Subscription Lifetimes and New Customer Cohorts are both read from Stripe,
    and the Customer Waterfall is built from the workbook's own payment pull.
    A customer in the first two and not the third has no revenue anywhere on
    the site. On 5 Oct 2026 Stripe's own metrics (the Sigma pull) put almost
    every such customer at $0 of new MRR: refunded, never paid, or a $10 card
    check. So this is a note, and the pipeline is not being changed; it turns
    into a warning only if the share grows past what that explains.

    Companies whose name is already in the waterfall under another Stripe id
    are left out: the same company billed on a second customer record.
    Only ids are printed, because these findings are posted publicly.
    """
    if not customers:
        return
    lifetimes = load("subscription_lifetimes.json")
    cohorts = load("signup_pricing.json")
    if not lifetimes and not cohorts:
        return
    norm = lambda s: re.sub(r"[^a-z0-9]", "", re.sub(r"\b(llc|inc|co|company|the|and|corp|ltd)\b", "",
                                                    str(s or "").lower()))
    known = set()
    names = set()
    for r in customers["rows"]:
        known.add(r.get("customer_id"))
        known.add(r.get("canonical_id"))
        names.add(norm(r.get("company_name")))
    missing = {}
    for r in (lifetimes or {}).get("rows", []):
        cid = str(r.get("Stripe Customer ID") or "").strip()
        if cid.startswith("cus_") and cid not in known and norm(r.get("Account")) not in names:
            missing[cid] = {"active": str(r.get("Status") or "").lower() == "active", "paid": None}
    signed = 0
    for r in (cohorts or {}).get("rows", []):
        cid = str(r.get("customer_id") or "").strip()
        if not cid:
            continue
        signed += 1
        if cid not in known and norm(r.get("customer_name")) not in names:
            entry = missing.setdefault(cid, {"active": False, "paid": None})
            entry["paid"] = number(r.get("first_payment"))
    if not missing:
        report("note", "Customer Waterfall",
               "every Stripe customer in Subscription Lifetimes and New Customer Cohorts is in the waterfall.")
        return
    real = sorted(c for c, v in missing.items() if (v["paid"] or 0) >= 100)
    active = sum(1 for v in missing.values() if v["active"])
    share = len(real) / signed if signed else 0
    level = "warning" if share > 0.08 else "note"
    report(level, "Customer Waterfall",
           f"{len(missing)} Stripe customers in Subscription Lifetimes or New Customer Cohorts have no "
           f"waterfall rows ({active} still active in Stripe). {len(real)} of them paid a first invoice "
           f"of $100 or more ({share:.0%} of {signed} cohort signups); in Oct 2026 every one of those "
           f"had been refunded or stopped paying. The Sigma query (q020) drops a customer whose charges are "
           f"refunded more than half or net under $100, so a real customer paying under $100 would be "
           f"dropped too. Paid a first invoice: {', '.join(real) or 'none'}.")


def check_lead_counts(doc):
    """The Lead Counts tab (hs-v23): the checks its brief asks for on every push.

    Earned plus list must not exceed the total; before plus after must equal the
    total where the event has a date; event sources must be a real share of the
    rows. A source that is mostly a loaded list is reported, because its total
    describes a file rather than leads, and the site uses earned for it.
    """
    if not doc:
        return
    rows = doc.get("rows") or []
    if not rows:
        report("warning", "Lead Counts", "the tab is in the push with no rows.")
        return
    n = lambda v: number(v) or 0
    bad_sum = [r.get("source") for r in rows
               if n(r.get("earned")) + n(r.get("list")) > n(r.get("total")) + 3]
    bad_split = [r.get("source") for r in rows
                 if str(r.get("event date") or "").strip()
                 and n(r.get("before the event")) + n(r.get("after the event")) not in (0, n(r.get("total")))]
    if bad_sum:
        report("warning", "Lead Counts", f"earned plus list exceeds the total for {len(bad_sum)} sources: "
               f"{', '.join(map(str, bad_sum[:8]))}.")
    if bad_split:
        report("warning", "Lead Counts", f"before plus after the event does not equal the total for "
               f"{len(bad_split)} dated events: {', '.join(map(str, bad_split[:8]))}.")
    fewer_companies = [r.get("source") for r in rows if n(r.get("with a company")) < n(r.get("with a stripe id"))]
    if fewer_companies:
        report("warning", "Lead Counts", f"fewer companies than customers for {len(fewer_companies)} sources, so the "
               f"company resolution did not run: {', '.join(map(str, fewer_companies[:8]))}.")
    # Customers after the event are a subset of the Stripe customers carrying
    # the tag (customers_total, v139), and new earned leads a subset of both
    # earned and after-the-event contacts.
    total_col = "customers_total" if any("customers_total" in r for r in rows) else "with a stripe id"
    more_after = [r.get("source") for r in rows
                  if str(r.get("customer_after_event") or "").strip() not in ("", "..")
                  and n(r.get("customer_after_event")) > n(r.get(total_col))]
    if more_after:
        report("warning", "Lead Counts", f"customer_after_event is larger than {total_col} for {len(more_after)} "
               f"sources, which cannot both be right: {', '.join(map(str, more_after[:8]))}.")
    bad_new = [r.get("source") for r in rows
               if str(r.get("earned_after_event") or "").strip() not in ("", "..")
               and n(r.get("earned_after_event")) > min(n(r.get("earned")), n(r.get("after the event")))]
    if bad_new:
        report("warning", "Lead Counts", f"earned_after_event is larger than earned or after the event for "
               f"{len(bad_new)} sources: {', '.join(map(str, bad_new[:8]))}.")
    events = [r for r in rows if str(r.get("medium") or "") == "event"]
    if len(events) < 5:
        report("warning", "Lead Counts", f"only {len(events)} of {len(rows)} sources are events; the medium "
               f"classification may not be landing.")
    listy = [r for r in events if n(r.get("total")) >= 50 and n(r.get("list")) / max(n(r.get("total")), 1) > 0.5]
    report("note", "Lead Counts",
           f"{len(rows)} sources, {len(events)} of them events. Mostly a loaded list, so read by earned leads: "
           + (", ".join(f"{r.get('source')} ({n(r.get('list')):,.0f} of {n(r.get('total')):,.0f})" for r in listy)
              or "none") + ".")


def check_event_costs(doc):
    """v133 marks costs that are not final. The site works out no cost per lead on
    them, so the push should say how many there are."""
    if not doc:
        return
    rows = doc.get("rows") or []
    states = {}
    for r in rows:
        src = str(r.get("cost_source") or "").lower()
        state = "not yet" if "not yet" in src else "pending" if "pending" in src else "settling" if "settling" in src else None
        if state:
            states.setdefault(state, []).append(str(r.get("event")))
    if states:
        report("note", "Event Costs", "costs not final, so no cost per lead is shown for them: "
               + "; ".join(f"{k} ({', '.join(v)})" for k, v in states.items()) + ".")


def check_waterfall_complete(summary, customers):
    """The customer waterfall must add up to the summary built from the same
    payments. On 8 Oct 2026 (v154) the S2 side was missing: 1,493 customers
    against 3,120, and every chart read half the book. A gap this size is an
    error, never a note."""
    if not summary or not customers:
        return
    cols = customers.get("columns") or []
    if "month" not in cols or "eop_mrr" not in cols:
        return
    mi, ei = cols.index("month"), cols.index("eop_mrr")
    by_month = {}
    for r in customers.get("rows") or []:
        v = number(r[ei]) if isinstance(r, list) else number(r.get("eop_mrr"))
        m = r[mi] if isinstance(r, list) else r.get("month")
        if v is not None:
            by_month[m] = by_month.get(m, 0) + v
    rows = [r for r in summary.get("rows") or [] if MONTH.match(str(r.get("month", "")))]
    rows.sort(key=lambda r: r["month"])
    gaps = []
    for r in rows[-6:]:
        want = number(r.get("eop_mrr"))
        got = by_month.get(r["month"])
        if want and got is not None and abs(got - want) / want > 0.10:
            gaps.append(f"{r['month']} summary ${want:,.0f} against waterfall ${got:,.0f}")
    if gaps:
        report("error", "Customer Waterfall", "the waterfall does not add up to Waterfall Summary, so customers "
               "are missing from it and every customer chart reads part of the book: " + "; ".join(gaps) + ".")
    if "source" in cols:
        si = cols.index("source")
        envs = {r[si] if isinstance(r, list) else r.get("source") for r in customers.get("rows") or []}
        if len(envs) < 2:
            report("error", "Customer Waterfall", f"only one Stripe environment is present ({', '.join(map(str, envs))}); "
                   "both S1 and S2 are expected.")


def check_event_credit(customers):
    """event_credit (v147, rules v148): how the event-tagged customers grade. A
    direct grade with no lag means an event graded without a date, which the
    pipeline says cannot happen."""
    if not customers or "event_credit" not in (customers.get("columns") or []):
        return
    seen = {}
    for r in customers.get("rows") or []:
        cid = r.get("customer_id")
        if cid and cid not in seen:
            seen[cid] = r
    grades = {}
    undated_direct = 0
    direct_before = 0
    lag_not_event = {}
    for r in seen.values():
        g = str(r.get("event_credit") or "").strip().lower()
        lag = number(r.get("event_lag_months"))
        if g:
            grades[g] = grades.get(g, 0) + 1
            if g == "direct" and lag is None:
                undated_direct += 1
            if g == "direct" and lag is not None and lag < 0:
                direct_before += 1
        if lag is not None and str(r.get("lead_medium") or "").strip().lower() != "event":
            src = str(r.get("lead_source") or "untagged")
            lag_not_event[src] = lag_not_event.get(src, 0) + 1
    if direct_before:
        report("warning", "Customer Waterfall", f"{direct_before:,} customers are graded direct with a negative "
               f"event_lag_months, so they paid before the event; v149 grades those indirect.")
    if lag_not_event:
        report("warning", "Customer Waterfall", "event_lag_months is filled on customers whose source is not an "
               "event: " + ", ".join(f"{k} {v:,}" for k, v in sorted(lag_not_event.items(), key=lambda x: -x[1])[:6]) + ".")
    if grades:
        report("note", "Customer Waterfall", "event credit: "
               + ", ".join(f"{k} {v:,}" for k, v in sorted(grades.items())) + ".")
    if undated_direct:
        report("warning", "Customer Waterfall", f"{undated_direct:,} customers are graded direct with no "
               f"event_lag_months, so they were graded without an event date; v148 says an undated event is "
               f"capped at indirect.")


def check_marketing_monthly(doc, present):
    """The Marketing Monthly tab (gh-v7): one row per month and HubSpot value. The
    site reads it from September 2025, where the vendor split of advertising
    starts. A month far past today is a date nobody meant, and a bulk count above
    the deals opened is a count of the wrong thing."""
    if "Marketing Monthly" not in present:
        stale = load("marketing_monthly.json")
        report("note", "Marketing Monthly", "not in the push; the Marketing tab reads "
               + (f"the copy pushed {stale.get('pushed_at')} ({stale.get('pipeline_version')})." if stale
                  else "its 5 Oct 2026 snapshot."))
        return
    if not doc:
        return
    rows = doc.get("rows") or []
    if not rows:
        report("warning", "Marketing Monthly", "the tab is in the push with no rows.")
        return
    n = lambda v: number(v) or 0
    bad_month = [r for r in rows if not MONTH.match(str(r.get("month") or ""))]
    if bad_month:
        report("warning", "Marketing Monthly", f"{len(bad_month)} row(s) have no month in YYYY-MM form.")
    far = {}
    for r in rows:
        m = str(r.get("month") or "")
        if MONTH.match(m) and m[:4] > "2030":
            far[m] = far.get(m, 0) + n(r.get("deals_won")) + n(r.get("deals_opened")) + n(r.get("leads"))
    if far:
        report("warning", "Marketing Monthly", "rows dated far in the future, so a close or create date is wrong: "
               + ", ".join(f"{m} ({c:,.0f} leads and deals)" for m, c in sorted(far.items()))
               + ". The site leaves them out.")
    negative = [r for r in rows if any(n(r.get(c)) < 0 for c in
                                       ("leads", "deals_opened", "deals_won", "won_mrr", "opened_in_a_bulk_day"))]
    if negative:
        report("warning", "Marketing Monthly", f"{len(negative)} row(s) carry a negative count.")
    over = [r for r in rows if n(r.get("opened_in_a_bulk_day")) > n(r.get("deals_opened"))]
    if over:
        report("warning", "Marketing Monthly", f"{len(over)} row(s) have more deals opened on a bulk day than deals opened.")
    held = [r for r in rows if re.search(r"close date in the future|placeholder", str(r.get("category") or ""), re.I)]
    if held:
        report("note", "Marketing Monthly", f"{sum(n(r.get('deals_won')) for r in held):,.0f} won deals carry a close "
               f"date in the future ({', '.join(sorted({str(r.get('month')) for r in held}))}), marked as renewal "
               f"placeholders; the site leaves them out.")



def main():
    index = load("index.json")
    if index is None:
        report("error", "index.json", "missing from the push, so nothing can be read")
        return finish()

    present = {entry["tab"]: entry for entry in index.get("files", [])}

    # gh-v11 stamps the HubSpot pull's version beside the pipeline's.
    if index.get("pull_version"):
        report("note", "index.json", f"pipeline {index.get('pipeline_version')}, HubSpot pull {index.get('pull_version')}, "
               f"push {index.get('push_version')}.")
    elif int((re.search(r"(\d+)$", str(index.get("push_version") or "")) or [0, 0])[1]) >= 11:
        report("warning", "index.json", "no pull_version, so a stale HubSpot pull cannot be told from a fresh one.")

    # gh-v10 writes the index even when a tab fails, and names the gaps.
    for field, level in (("failed", "error"), ("missing_required", "error")):
        gaps = index.get(field) or []
        if gaps:
            report(level, "index.json", f"the push lists {field.replace('_', ' ')}: "
                   + ", ".join(str(g) for g in gaps) + ".")

    # A push writes the tabs first and the index last. Tabs newer than the
    # index mean a push stopped part way.
    newer = {}
    for entry in index.get("files", []):
        doc = load(entry["file"])
        if doc and str(doc.get("pushed_at") or "") > str(index.get("pushed_at") or ""):
            newer[entry["tab"]] = (doc.get("pushed_at"), doc.get("pipeline_version"))
    if newer:
        when = sorted({v for v in newer.values()})
        report("warning", "index.json", f"{len(newer)} tabs were pushed after the index "
               f"({', '.join(f'{a} {b}' for a, b in when)} against {index.get('pushed_at')} "
               f"{index.get('pipeline_version')}), so a push stopped before writing the index; "
               f"tabs it did not reach are the earlier copies.")

    for tab, spec in REQUIRED_TABS.items():
        if tab not in present:
            report("error", tab, "not listed in index.json")
            continue

        doc = load(present[tab]["file"])
        if doc is None:
            report("error", tab, f"index.json lists {present[tab]['file']} but it is not there")
            continue

        listed = present[tab].get("rows")
        if listed is not None and listed != len(doc.get("rows", [])):
            report("error", tab,
                   f"index.json says {listed} rows, the file holds "
                   f"{len(doc.get('rows', []))}. The index was written against a different "
                   f"version of this file.")

        check_tab(tab, spec, doc)

    waterfall = load("waterfall_summary.json")
    if waterfall:
        check_zero_for_blank(waterfall, "Waterfall Summary", ["new_mrr", "churn_mrr"])
        customers = load("customer_waterfall.json")
        check_presence_is_not_payment(waterfall, customers)
        check_departures_are_booked(waterfall, customers)
        check_lead_source(customers)
        check_missing_customers(customers)
        check_waterfall_complete(waterfall, load("customer_waterfall.json"))
        check_event_credit(customers)
        lead_counts = present.get("Lead Counts")
        check_lead_counts(load(lead_counts["file"]) if lead_counts else None)
        event_costs = present.get("Event Costs")
        check_event_costs(load(event_costs["file"]) if event_costs else None)
        check_ledger_closed(load("qb_expenses.json"))
        mm = present.get("Marketing Monthly")
        check_marketing_monthly(load(mm["file"]) if mm else None, present)

        # The base count is the one number that needs no interpretation, so a
        # sharp move in it is worth a look even when nothing is malformed.
        rows = [r for r in waterfall["rows"] if MONTH.match(str(r.get("month", "")))]
        rows.sort(key=lambda r: r["month"])
        # Only recent months, and only once the base is large enough that a
        # step means a rule changed rather than the company growing. Early
        # years legitimately move 15% a month and a check that fires on those
        # is a check somebody turns off.
        recent = rows[-24:]
        for previous, current in zip(recent, recent[1:]):
            before = number(previous.get("active_logos"))
            after = number(current.get("active_logos"))
            if before and after and before >= 200 and abs(after - before) / before > 0.12:
                report("warning", "Waterfall Summary",
                       f"active logos moved {before:,.0f} to {after:,.0f} between "
                       f"{previous['month']} and {current['month']}, more than 12%. "
                       f"Real bases do not step like that, so check whether a "
                       f"membership rule changed.")

    return finish()


def finish():
    errors = [f for f in findings if f["level"] == "error"]
    warnings = [f for f in findings if f["level"] == "warning"]
    # Notes record a check that passed in a way worth stating, so a reader can
    # tell "this was tested and is fine" from "this was never looked at".
    notes = [f for f in findings if f["level"] == "note"]

    if not findings:
        print("No problems found.")
        return 0

    lines = []
    if errors:
        lines.append(f"## {len(errors)} error{'s' if len(errors) != 1 else ''}\n")
        lines += [f"- **{f['tab']}** - {f['message']}" for f in errors]
        lines.append("")
    if warnings:
        lines.append(f"## {len(warnings)} warning{'s' if len(warnings) != 1 else ''}\n")
        lines += [f"- **{f['tab']}** - {f['message']}" for f in warnings]
        lines.append("")
    if notes:
        lines.append(f"## {len(notes)} note{'s' if len(notes) != 1 else ''}\n")
        lines += [f"- **{f['tab']}** - {f['message']}" for f in notes]
        lines.append("")
    if errors or warnings:
        lines.append("The site still deployed. Nothing here blocks publishing, because a "
                     "site carrying a warning is more useful than no site.")
    else:
        lines.append("No errors or warnings. The notes above are checks that passed.")

    body = "\n".join(lines)
    print(body)
    Path("validation-report.md").write_text(body, encoding="utf-8")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
