# Event attribution: the rules and the workflow

How the site decides which leads, wins and revenue belong to an event, and what
people and the pipeline must do so that it decides correctly without anyone
reading event pages one by one. Written 12 Oct 2026. The code is in
`site/data.js` (`eventFunnel`, `eventRoi`, `eventUpsells`); the definitions
are in `LINEAGE.md`.

Two principles hold throughout.

- **Stripe decides money.** Revenue, first payment and "won" all come from
  Stripe. HubSpot says who touched the event; it never says what they paid.
- **A tag is a claim, not evidence.** A contact or company carrying an event's
  tag is where the search starts. It counts only with something dated that
  ties it to the event.

## 1. The rules (applied to every event automatically)

### 1.1 Which contacts count as the event's leads

Each contact tagged to an event falls into exactly one state.

| State | Rule | Counted? |
|---|---|---|
| New lead | Created on or after the event date, and arrived by doing something: a form, meetings link, booth scan, chat or rep. | Yes |
| Re-engaged | Already in HubSpot, and a deal opened within 90 days after the event, or in the 45 days before it through the event's own form or link, or as a deal tagged to the event that was won (Riverstone Plumbing, Hoorah 2026). | Yes |
| Upsell lead | The company was paying going into the event, or the contact came through the event's upsell form or link. | No; watched as an upsell (1.4) |
| Loaded from a list | Arrived in a file (`arrived_as` list), however soon after the event the file was loaded. | No |
| Arrived earlier | In HubSpot before the event with no deal near it: the tag was added later. | No |
| Undated event | The event has no date, so before and after cannot be told apart. | Shown apart, flagged |

The site's new-lead count must agree with Lead Counts' `earned_after_event`
for every dated event. The validator checks this on every push.

### 1.2 Which wins count

- The deal is marked won **and** Stripe's customer was not won through another
  source. A deal won in HubSpot whose Stripe customer was won through another
  channel shows as "Won, credited elsewhere".
- The deal opened within 6 months of the event (`WIN_WINDOW_MONTHS`).

### 1.3 Which revenue counts (customer credit, default rule `won6`)

A tagged Stripe customer is credited to the event only if all of these hold.

1. **New:** not paying in the months before the event. A former customer who
   had paid nothing for 3 months is a win-back and counts from the event month.
2. **On time:** first paid between the event month and 6 months after.
3. **Not won elsewhere:** no won deal naming another source.
4. **Evidence beyond the tag:** either a won deal names the event, or the tag
   was written by the end of the month after the event **and** not on a day a
   list was loaded into that source (20 or more contacts arriving as a list on
   one day).

What a credited customer paid is counted from Stripe, from the event month on.
An existing customer's pre-event revenue, and the rate they keep paying, is
never the event's.

5. **The won deal's event as a fallback:** a customer whose earliest-source
   event cannot credit them (they first paid outside its window), and whose
   won deal names another event inside that event's window, is credited to
   that event as direct. A partner or webinar that came first keeps its
   customer.

6. **Organisers' lists sit beside the event, never in its return** (decided 13 Oct
   2026). A contact who arrived in a list the organiser handed over is not
   the event's lead, and a later win from it is not the event's win unless
   that won deal names the event. The Events summary and each event page show
   list follow-up wins as their own line. Once HubSpot carries `List Source`,
   lists are named by it rather than told apart by how they were imported.

**Switch: Deal attribution only (rule `deal`).** On the Events tab, every
event page and the Events summary, one switch credits an event only with
customers whose won deal's lead source names it: last touch on the deal. The
contact's or company's tag is ignored, there is no window, and a customer
whose won deal names no event is credited to none. The default rule above
stays the figure of record; the audit runs on it.

### 1.3.7 Cost of an event still ahead: no guesses

An event past the last month of data takes its fee only from the Event Costs
tab, the Event Hub or a bill; with none it reads "fee unknown" and adds
nothing to committed. Its travel is what is booked, or an estimate only when
the estimate names attendees confirmed as going (not "not registered"). The
code ignores any other estimate for such an event, and `no-guess-ahead`
fails if one is put on file (Josh, 20 Oct 2026). Past events with partial
records can still be estimated, labelled as estimates.

### 1.4 Upsells

- An existing customer (paying the month before the event) whose contact came
  through the event's own form or meetings link, or its upsell form or link.
- Measured from their MRR going into the event to their MRR 6 months after.
- Only the increase above the book's usual expansion (1.8% a month in v172) is
  credited, with the contribution on it at the account's own margin.
- Shown beside the event's return ("with upsells"), never folded into it.
- Watched from the event day, even before a month after it has closed.

### 1.5 Evidence grades, shown on every credited customer

- **Direct:** the event's own won deal closed them.
- **Indirect:** touched by the event; something else closed them.
- **Tag only:** no won deal; the tag is the only link (and must pass rule 1.3.4).

## 2. What people must do in HubSpot

These are what make the rules above find the right answer. Without them, every
figure is a floor.

**Before the event**
1. Add the event to the Event Dates tab and the Event Costs tab: name, date,
   expected fee.
2. Create one lead source value, spelled `YYYY - Event Name`, and use only it.
3. Create the event's own meetings link and form, named for the event (for
   example `2027-pantheon-round-robin`), and a separate upsell link or form
   with "upsell" in its name for existing customers.

**At the event and within a week**
4. Scans and booth meetings go in through those links and forms, never as a
   list.
5. The lead source is set when the contact is captured. Do not tag existing
   contacts afterwards, and never tag a loaded file with the event.
6. Record the setter on every booked meeting.
7. Open the deal when the demo is sat. Set its `sub_lead_source` to the event,
   or let the workflow copy it from the contact (see 4.1).

**After the event**
8. Close deals promptly, won or lost, so a win can be dated.
9. If an attendee list arrives from the organiser, load it under its own
   source (for example `2027 - Pantheon attendee list`), not the event's tag.
   Follow-up wins from it are then visible and kept apart, and only a won deal
   naming the event credits them to it.

## 3. Every push

1. Wait for `data/index.json` to change: it is written last. Do not push site
   commits while a data push is running.
2. Check the index: `failed` and `missing_required` must be empty, and
   `pipeline_version` and `pull_version` as announced.
3. Run `py -3 scripts/validate_data.py` and `node scripts/audit_attribution.mjs`
   (GitHub runs both on every push; section 7). Errors block; warnings to read:
   - an event whose new leads disagree with Lead Counts;
   - setters with more sits than leads;
   - Lead Counts' conversion columns not summing to the total;
   - lists loaded after an event that later won (named in the notes).
4. Open the Events tab and read **Attribution checks: what to look at after a
   push**. It is the only thing to read. It lists what the rules could not
   settle, each with what fixes it:
   - a credited customer resting on the tag (or graded indirect) with no lead
     row and no deal naming the event;
   - a deal won in HubSpot whose Stripe customer was won through another source;
   - a list loaded after an event that later produced wins;
   - an upsell lead not matched to a Stripe customer;
   - an event with no date, or with a fee expected and not found.

   An empty list means every event is attributed by rule.
5. Anything new goes in `BRIEF_TO_PIPELINE.md` as a numbered item: what is
   wrong, and what is needed.

## 4. Monthly

1. The Event Hub and Ramp cost run (`EVENT_COSTS_MONTHLY.md`), then the
   QuickBooks close. September 2026 is estimated until the 15th.
2. Update fees that are still settling on the Event Costs tab.
3. Events whose 6-month window closed this month: their wins and upsells are
   final. Read their pages once.

### 4.1 The one HubSpot change that would fix most of this

A workflow: when a deal is created and `sub_lead_source` is empty, copy it from
the contact. Only about 21% of deals carry a tag, and setters about 18%. This
is the only change that creates attribution rather than grading what exists.

### 4.2 Auditing past events

1. **On the site.** The Events tab's **Event audit** table checks every past
   event in one row: cost final, dated, new leads agreeing with Lead Counts,
   customers credited (and how many by the event's own won deal), won leads
   matched to Stripe, setter and owner coverage, and what is wrong or
   missing. **Last 12 months** narrows it to the year to the last closed
   month. A problem means a figure may be wrong; a gap means something is
   missing.
2. **Against live HubSpot, monthly.** Every won deal whose `sub_lead_source`
   names an event in the window is pulled straight from HubSpot (Claude runs
   this with the HubSpot connector) and compared, by its Stripe link, with
   the customers the site credits. Each deal is either credited to the same
   event, or not credited for a stated rule: never paid in Stripe (refunded
   or under $100), already a customer before the event, first paid outside
   the window, a cancellation record, no Stripe link, or a partner or webinar
   that came first. Anything else is a finding. On 13 Oct 2026 the year to
   September held 62 won deals: 47 credited to the same event, 13 explained,
   2 by the earliest-source rule (a partner and a webinar came first). It
   found Bacon Plumbing credited to no event, which led to the rule in 1.3.5.

## 5. What the pipeline still owes (brief items)

| Item | What | Why |
|---|---|---|
| 22 | `stripe_customer_id` on each Event Leads row | Leads are matched to Stripe by company name; a short HubSpot name fails to match a long Stripe one. |
| 23 | One row per event-tagged deal, with `deal_link` and `closed_at` | Customers credited through a deal or company tag have no lead row and no HubSpot link. |
| 19 | `won_date` and `first_paid` per lead | Wins are dated by when the deal opened until then. |
| 16 | `contact_link` on Event Leads | Only the company is linked today. |

## 6. Settings, and when to revisit them

| Setting | Value | Where |
|---|---|---|
| Win window | 6 months after the event month | `WIN_WINDOW_MONTHS` |
| Re-engaged | deal within 90 days after, or 45 before through the event's own form or link | `REENGAGE_AFTER_DAYS`, `REENGAGE_BEFORE_DAYS` |
| List-import day | 20 or more list arrivals into one source on one day | `listDayOf` |
| Tag on time | written by the end of the month after the event | rule 1.3.4 |
| Book expansion | measured each push from the last 12 months | `bookExpansionRate` |

Open judgement call: a customer from an organiser's attendee list who later
books through a general link, where a rep put the event on the winning deal.
This counts today, because a person named the event on the deal. If attendee
lists are loaded under their own source (2.9), the call makes itself.

## 7. The audit (runs on every push)

`attributionAudit` in `site/data.js` checks every rule above against what the
site actually computed. It runs in three places, always with the same code:

- **GitHub**, on every data push and every change to `site/data.js`
  (`.github/workflows/validate-data.yml` runs `scripts/audit_attribution.mjs`).
  A failure is added to the open "Data push did not validate" issue.
- **The Events tab**, under Attribution checks ("Rule audit: all 16 checks pass",
  or the failures, opened).
- **By hand:** `node scripts/audit_attribution.mjs`.

| Check | Rule |
|---|---|
| `credit-window` | Every credited customer first paid from the event month to 6 months after (win-backs from the event month). |
| `credit-not-elsewhere` | No credited customer was won through another source. |
| `credit-tag-evidence` | A customer credited on the tag alone was tagged by the month after the event, not on a list-import day. |
| `credit-company-once` | Each event counts a company once, even with an account in both Stripe environments. |
| `credit-default-rule` | Every figure uses the default credit rule. |
| `leads-no-list` | No contact from a loaded list is counted as a lead, unless the event re-engaged its deal. |
| `leads-no-backtag` | No contact HubSpot held before the event is counted, unless its deal opened near the event. |
| `leads-upsell-apart` | No existing customer is counted as a new lead. |
| `wins-stripe` | No win Stripe credits to another source is counted, rechecked against Stripe independently. |
| `wins-window` | No win whose deal opened more than 6 months after the event is counted. |
| `leads-totals` | The Events tab totals are the sum of its events. |
| `leads-match-lead-counts` | Every dated event's arrivals agree with Lead Counts within 10%. |
| `sales-matches-events` | The Sales tab counts the same leads as the Events tab. |
| `upsell-not-new` | No upsell customer is also credited as a new customer of the same event. |
| `upsell-baseline` | Every upsell was paying going in and is credited no more than its increase. |
| `no-guess-ahead` | No event still ahead (past the last month of data) carries a guessed fee, or estimated travel without confirmed attendees; no such guess is on file either. |

The audit was tested by breaking the code on purpose: dropping the win window
failed `credit-window` on the 9 late payers, and counting lists as leads failed
`leads-no-list`, `wins-stripe` and `leads-totals`.

A new rule goes into this file, into the code, and into the audit, in the same
commit.
