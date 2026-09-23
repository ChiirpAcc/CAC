# Ten accounts to audit

From push `2026-09-23T16:50:30`. The data window ends at **2026-08** — there are no
September rows, so nothing here reflects this month or the September overbilling.

`event_type` decides presence on the site, `eop_mrr` is run rate, `net_cash` is what
actually cleared after refunds. Three fields are known broken and are marked where they appear:
`last_paid_at` (corrupt on every row), `sub_start` (28% in the wrong format), `credit_notes` (empty).

## At a glance

| # | Account | Stripe ID | Env | Present | Months with cash | Peak MRR | Lifetime cash | Shape |
|---|---|---|---|---|---|---|---|---|
| 1 | Luxor Garage Door | `cus_UjUuKNG1w93E81` | S1 | 3 mo | 0 mo | $0 | $-1,238 | started 2026, still live |
| 2 | Cool Beans Heating and Air | `cus_TlKziILtRaHP3l` | S1 | 8 mo | 8 mo | $1,050 | $8,092 | started 2026, still live |
| 3 | Andreas Plumbing, Heating  | `cus_UsxNLhiGl86GsC` | S1 | 2 mo | 2 mo | $7,650 | $7,674 | started 2026, still live |
| 4 | WattStar Electric | `cus_ULgTj7NNpmTo3T` | S2 | 5 mo | 3 mo | $1,500 | $1,725 | started 2026, still live (S2) |
| 5 | East Texas Refrigeration C | `cus_U2v2tgki9r6dDd` | S1 | 4 mo | 3 mo | $50 | $180 | started AND churned in 2026 |
| 6 | Atlantic Refrigeration | `cus_UlqUvA08S0dK24` | S1 | 2 mo | 1 mo | $1,000 | $1,000 | started AND churned in 2026 |
| 7 | Plumbing Pro- Tampa | `cus_TxguvfeqzJEJlX` | S1 | 6 mo | 4 mo | $2,300 | $4,530 | started AND churned in 2026 |
| 8 | RCL Mechanical | `cus_Q1T52CXtsXhANB` | S1 | 25 mo | 14 mo | $50 | $672 | older, churned in 2026 |
| 9 | Sanders Plumbing, Heat & A | `cus_OCGPK8AfadsQsO` | S1 | 31 mo | 30 mo | $1,199 | $22,340 | older, churned in 2026 |
| 10 | 5 Star Home Services | `cus_OHRjtf7WG1letb` | S1 | 34 mo | 29 mo | $14,000 | $190,612 | older, churned in 2026 |

## Three corrections since this was written

**"Months with cash" is not "months paid."** The column counts months where
`net_cash` was positive. Where a customer pays by wire and a payment lands
late, one month gets two payments and the month before gets none, so a month
that was genuinely paid can read as zero. 5 Star reads 29 here against 30
actually paid.

**Lifetime cash is understated wherever there was a refund.** `net_cash`
has the refund subtracted from a figure already net of it, so every account
that was ever refunded is short by exactly the refund. In this list that is
Luxor (-$1,250), Plumbing Pro (-$2,300), Sanders (-$959) and 5 Star
(-$2,500). The figures below are left as the pipeline publishes them,
because that is what is being audited.

**Peak MRR for Andreas (#3) is now corrected on the page.** The raw column
reads $7,650, which is a year paid up front. The site divides annual lines
by twelve and carries the rate forward, so it shows $637.50. The table below
still shows the raw value.

## Two things that show up across several of these

**Counted present for a month longer than they paid.** The usual shape at the end of a
life is `contraction` to $0, then `churn` the month after. The contraction month is still
a live logo carrying $0, so "months present" runs one ahead of "months paid" — East Texas
is 4 against 3, Atlantic is 2 against 1. That is the site behaving as designed (presence is
an event type, not an amount) and it is worth knowing it inflates logo counts slightly.

**Paying customers reading $0 MRR before 2025-10.** RCL Mechanical (#8) paid every
month from 2024-04 and its MRR reads $0 until exactly 2025-10, when it jumps to $50 as
an `expansion`. That is not a change in what the customer paid, it is the month revenue
classification switched on. Across the book:

| month | live rows with cash but $0 MRR |
|---|---|
| 2024-06 | 152 of 869 (17.5%) |
| 2025-08 | 99 of 1,144 (8.7%) |
| 2025-09 | 72 of 1,164 (6.2%) |
| **2025-10** | **22 of 1,202 (1.8%)** |
| 2026-08 | 16 of 1,111 (1.4%) |

So a pre-2025-10 "expansion" may be a classification event rather than a real upsell,
and revenue retention curves crossing that line will show growth that did not happen.
This is the 2025-10 boundary made concrete, and it is not fixable retroactively.

**`subscription_status` is a snapshot, not per-month state.** East Texas reads `canceled`
in 2026-02, the month it started. The field describes the subscription as of the export,
so it cannot be used to judge whether an account was live in a past month.

---

## 1. Luxor Garage Door
`cus_UjUuKNG1w93E81` — started 2026, still live
| | |
|---|---|
| Stripe environment | S1 |
| Months on file | 3 (2026-06 to 2026-08) |
| Months counted present | 3 |
| Peak MRR | $0 |
| Lifetime cash | $-1,238 |
| sub_start / sub_end | `2026-06` / `-` |
| subscription_status | `active` |
| has_live_sub / sub_count | 1 / 1 |
| last_paid_at | `2026-09-19` (**known corrupt**) |
| fidelity (final month) | `resolved` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2026-06 | new | 0 | -1,238 | 12 | 0 | 1,250 | 0 | active |
| 2026-07 | flat | 0 | 0 | 20 | 0 | 0 | 0 | active |
| 2026-08 | flat | 0 | 0 | 0 | 0 | 0 | 0 | active |

**Check:**
- **Peak MRR is $0** — counted as a live logo in every month it appears. Is this a real customer, a test account, or an agency monitoring account?
- First counted present in **2026-06**. Does that match the signup / first invoice?
- Carries refunds — check whether they are ordinary refunds or the September overbilling class.

---

## 2. Cool Beans Heating and Air LLC
`cus_TlKziILtRaHP3l` — started 2026, still live
| | |
|---|---|
| Stripe environment | S1 |
| Months on file | 8 (2026-01 to 2026-08) |
| Months counted present | 8 |
| Peak MRR | $1,050 |
| Lifetime cash | $8,092 |
| sub_start / sub_end | `2026-01` / `-` |
| subscription_status | `active` |
| has_live_sub / sub_count | 1 / 1 |
| last_paid_at | `2026-09-09` (**known corrupt**) |
| fidelity (final month) | `resolved` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2026-01 | new | 1,050 | 1,168 | 32 | 0 | 0 | 1,000 | active |
| 2026-02 | flat | 1,050 | 1,148 | 12 | 0 | 0 | 1,000 | active |
| 2026-03 | flat | 1,050 | 1,148 | 12 | 0 | 0 | 1,000 | active |
| 2026-04 | flat | 1,050 | 1,148 | 12 | 0 | 0 | 1,000 | active |
| 2026-05 | flat | 1,050 | 1,148 | 12 | 0 | 0 | 1,000 | active |
| 2026-06 | flat | 1,050 | 62 | 12 | 0 | 0 | 1,000 | active |
| 2026-07 | flat | 1,050 | 1,148 | 12 | 0 | 0 | 1,000 | active |
| 2026-08 | flat | 1,050 | 1,125 | 12 | 0 | 0 | 1,000 | active |

**Check:**
- First counted present in **2026-01**. Does that match the signup / first invoice?

---

## 3. Andreas Plumbing, Heating and Air Conditioning, Inc.
`cus_UsxNLhiGl86GsC` — started 2026, still live
| | |
|---|---|
| Stripe environment | S1 |
| Months on file | 2 (2026-07 to 2026-08) |
| Months counted present | 2 |
| Peak MRR | $7,650 |
| Lifetime cash | $7,674 |
| sub_start / sub_end | `2026-07` / `-` |
| subscription_status | `active` |
| has_live_sub / sub_count | 1 / 1 |
| last_paid_at | `2026-09-14` (**known corrupt**) |
| fidelity (final month) | `resolved` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2026-07 | new | 7,650 | 7,662 | 12 | 0 | 0 | 7,650 | active |
| 2026-08 | contraction | 0 | 12 | 12 | 0 | 0 | 0 | active |

**Check:**
- First counted present in **2026-07**. Does that match the signup / first invoice?

---

## 4. WattStar Electric
`cus_ULgTj7NNpmTo3T` — started 2026, still live (S2)
| | |
|---|---|
| Stripe environment | S2 |
| Months on file | 5 (2026-04 to 2026-08) |
| Months counted present | 5 |
| Peak MRR | $1,500 |
| Lifetime cash | $1,725 |
| sub_start / sub_end | `2026-04` / `-` |
| subscription_status | `active` |
| has_live_sub / sub_count | 1 / 1 |
| last_paid_at | `2026-09-17` (**known corrupt**) |
| fidelity (final month) | `resolved` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2026-04 | new | 12 | -1,488 | 0 | 0 | 1,500 | 0 | active |
| 2026-05 | contraction | 0 | -51 | 0 | 0 | 500 | 0 | active |
| 2026-06 | expansion | 1,500 | 240 | 0 | 0 | 1,272 | 0 | active |
| 2026-07 | flat | 1,500 | 1,512 | 12 | 0 | 0 | 0 | active |
| 2026-08 | flat | 1,500 | 1,512 | 12 | 0 | 0 | 0 | active |

**Check:**
- First counted present in **2026-04**. Does that match the signup / first invoice?
- Carries refunds — check whether they are ordinary refunds or the September overbilling class.
- `platform_mrr` is 0 while MRR is booked — this revenue was never matched to a named product.

---

## 5. East Texas Refrigeration Co. Inc.
`cus_U2v2tgki9r6dDd` — started AND churned in 2026
| | |
|---|---|
| Stripe environment | S1 |
| Months on file | 5 (2026-02 to 2026-06) |
| Months counted present | 4 |
| Peak MRR | $50 |
| Lifetime cash | $180 |
| sub_start / sub_end | `2/1/26` / `2026-05` |
| subscription_status | `canceled` |
| has_live_sub / sub_count | 0 / 1 |
| last_paid_at | `2026-04-25` (**known corrupt**) |
| fidelity (final month) | `-` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2026-02 | new | 50 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2026-03 | flat | 50 | 80 | 30 | 0 | 0 | 0 | canceled |
| 2026-04 | flat | 50 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2026-05 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | canceled |
| 2026-06 | churn | 0 | 0 | 0 | 0 | 0 | 0 | canceled |

**Check:**
- Churn booked in **2026-06**. Does Stripe agree the subscription ended then?
- First counted present in **2026-02**. Does that match the signup / first invoice?
- `sub_start` reads `2/1/26` — one of the 9,348 rows still in the broken format.

---

## 6. Atlantic Refrigeration
`cus_UlqUvA08S0dK24` — started AND churned in 2026
| | |
|---|---|
| Stripe environment | S1 |
| Months on file | 3 (2026-06 to 2026-08) |
| Months counted present | 2 |
| Peak MRR | $1,000 |
| Lifetime cash | $1,000 |
| sub_start / sub_end | `2026-06` / `2026-07` |
| subscription_status | `canceled` |
| has_live_sub / sub_count | 0 / 1 |
| last_paid_at | `2026-06-25` (**known corrupt**) |
| fidelity (final month) | `-` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2026-06 | new | 1,000 | 1,000 | 0 | 0 | 0 | 1,000 | canceled |
| 2026-07 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | canceled |
| 2026-08 | churn | 0 | 0 | 0 | 0 | 0 | 0 | canceled |

**Check:**
- Churn booked in **2026-08**. Does Stripe agree the subscription ended then?
- First counted present in **2026-06**. Does that match the signup / first invoice?

---

## 7. Plumbing Pro- Tampa
`cus_TxguvfeqzJEJlX` — started AND churned in 2026
| | |
|---|---|
| Stripe environment | S1 |
| Months on file | 7 (2026-02 to 2026-08) |
| Months counted present | 6 |
| Peak MRR | $2,300 |
| Lifetime cash | $4,530 |
| sub_start / sub_end | `2026-02` / `2026-07` |
| subscription_status | `canceled` |
| has_live_sub / sub_count | 0 / 1 |
| last_paid_at | `2026-07-13` (**known corrupt**) |
| fidelity (final month) | `-` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2026-02 | new | 1,300 | 1,330 | 30 | 0 | 0 | 1,250 | canceled |
| 2026-03 | flat | 1,300 | 1,300 | 0 | 0 | 0 | 1,250 | canceled |
| 2026-04 | expansion | 1,800 | 1,800 | 0 | 0 | 0 | 1,750 | canceled |
| 2026-05 | expansion | 2,300 | 2,300 | 0 | 0 | 0 | 2,250 | canceled |
| 2026-06 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | canceled |
| 2026-07 | flat | 0 | -2,200 | 0 | 0 | 2,300 | 0 | canceled |
| 2026-08 | churn | 0 | 0 | 0 | 0 | 0 | 0 | canceled |

**Check:**
- Churn booked in **2026-08**. Does Stripe agree the subscription ended then?
- First counted present in **2026-02**. Does that match the signup / first invoice?
- Carries refunds — check whether they are ordinary refunds or the September overbilling class.

---

## 8. RCL Mechanical
`cus_Q1T52CXtsXhANB` — older, churned in 2026
| | |
|---|---|
| Stripe environment | S1 |
| Months on file | 26 (2024-04 to 2026-05) |
| Months counted present | 25 |
| Peak MRR | $50 |
| Lifetime cash | $672 |
| sub_start / sub_end | `2022-09` / `2026-04` |
| subscription_status | `canceled` |
| has_live_sub / sub_count | 0 / 1 |
| last_paid_at | `2025-09-29` (**known corrupt**) |
| fidelity (final month) | `-` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2024-04 | new | 0 | 60 | 0 | 0 | 0 | 0 | canceled |
| 2024-05 | flat | 0 | 37 | 0 | 0 | 0 | 0 | canceled |
| 2024-06 | flat | 0 | 0 | 0 | 0 | 0 | 0 | canceled |
| 2025-05 | flat | 0 | 0 | 0 | 0 | 0 | 0 | canceled |
| 2025-06 | flat | 0 | 100 | 0 | 0 | 0 | 0 | canceled |
| 2025-07 | flat | 0 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2025-08 | flat | 0 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2025-09 | flat | 0 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2025-10 | expansion | 50 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2025-11 | flat | 50 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2025-12 | flat | 50 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2026-01 | flat | 50 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2026-02 | flat | 50 | 50 | 0 | 0 | 0 | 0 | canceled |
| 2026-03 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | canceled |
| 2026-04 | flat | 0 | 0 | 0 | 0 | 0 | 0 | canceled |
| 2026-05 | churn | 0 | 0 | 0 | 0 | 0 | 0 | canceled |

**Check:**
- Churn booked in **2026-05**. Does Stripe agree the subscription ended then?
- First counted present in **2024-04**. Does that match the signup / first invoice?

---

## 9. Sanders Plumbing, Heat & Air
`cus_OCGPK8AfadsQsO` — older, churned in 2026
| | |
|---|---|
| Stripe environment | S1 |
| Months on file | 32 (2023-07 to 2026-02) |
| Months counted present | 31 |
| Peak MRR | $1,199 |
| Lifetime cash | $22,340 |
| sub_start / sub_end | `7/1/2023` / `2026-01` |
| subscription_status | `canceled` |
| has_live_sub / sub_count | 0 / 1 |
| last_paid_at | `2024-09-30` (**known corrupt**) |
| fidelity (final month) | `-` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2023-07 | new | 1,199 | 1,329 | 0 | 0 | 0 | 0 | canceled |
| 2023-08 | contraction | 699 | 699 | 0 | 0 | 0 | 0 | canceled |
| 2023-09 | flat | 699 | 699 | 0 | 0 | 0 | 0 | canceled |
| 2025-02 | flat | 699 | 699 | 0 | 0 | 0 | 0 | canceled |
| 2025-03 | flat | 699 | 699 | 0 | 0 | 0 | 0 | canceled |
| 2025-04 | flat | 699 | 699 | 0 | 0 | 0 | 0 | canceled |
| 2025-05 | flat | 699 | 699 | 0 | 0 | 0 | 0 | canceled |
| 2025-06 | expansion | 749 | 749 | 0 | 0 | 0 | 0 | canceled |
| 2025-07 | expansion | 923 | 923 | 0 | 0 | 0 | 0 | canceled |
| 2025-08 | expansion | 949 | 949 | 0 | 0 | 0 | 0 | canceled |
| 2025-09 | flat | 949 | 949 | 0 | 0 | 0 | 0 | canceled |
| 2025-10 | flat | 949 | 959 | 10 | 0 | 0 | 699 | canceled |
| 2025-11 | flat | 949 | 959 | 10 | 0 | 0 | 699 | canceled |
| 2025-12 | flat | 949 | 959 | 10 | 0 | 0 | 699 | canceled |
| 2026-01 | contraction | 0 | -959 | 0 | 0 | 959 | 0 | canceled |
| 2026-02 | churn | 0 | 0 | 0 | 0 | 0 | 0 | canceled |

**Check:**
- Churn booked in **2026-02**. Does Stripe agree the subscription ended then?
- First counted present in **2023-07**. Does that match the signup / first invoice?
- `sub_start` reads `7/1/2023` — one of the 9,348 rows still in the broken format.
- Carries refunds — check whether they are ordinary refunds or the September overbilling class.

---

## 10. 5 Star Home Services
`cus_OHRjtf7WG1letb` — older, churned in 2026
| | |
|---|---|
| Stripe environment | S1 |
| Months on file | 35 (2023-07 to 2026-05) |
| Months counted present | 34 |
| Peak MRR | $14,000 |
| Lifetime cash | $190,612 |
| sub_start / sub_end | `2023-07` / `2026-03` |
| subscription_status | `canceled` |
| has_live_sub / sub_count | 0 / 1 |
| last_paid_at | `2024-09-28` (**known corrupt**) |
| fidelity (final month) | `-` |

| month | event | MRR | cash | usage | one-off | refunded | platform | status |
|---|---|---|---|---|---|---|---|---|
| 2023-07 | new | 7,000 | 7,000 | 0 | 0 | 0 | 0 | canceled |
| 2023-08 | flat | 7,000 | 7,000 | 0 | 0 | 0 | 0 | canceled |
| 2023-09 | flat | 7,000 | 7,000 | 0 | 0 | 0 | 0 | canceled |
| 2025-05 | flat | 5,000 | 5,000 | 0 | 0 | 0 | 0 | canceled |
| 2025-06 | flat | 5,000 | 5,000 | 0 | 0 | 0 | 0 | canceled |
| 2025-07 | flat | 5,000 | 5,000 | 0 | 0 | 0 | 0 | canceled |
| 2025-08 | flat | 5,000 | 5,000 | 0 | 0 | 0 | 0 | canceled |
| 2025-09 | flat | 5,000 | 5,000 | 0 | 0 | 0 | 0 | canceled |
| 2025-10 | flat | 5,000 | 5,000 | 0 | 0 | 0 | 0 | canceled |
| 2025-11 | flat | 5,000 | 5,000 | 0 | 0 | 0 | 0 | canceled |
| 2025-12 | contraction | 2,500 | 0 | 0 | 0 | 2,500 | 0 | canceled |
| 2026-01 | flat | 2,500 | 2,500 | 0 | 0 | 0 | 0 | canceled |
| 2026-02 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | canceled |
| 2026-03 | expansion | 2,500 | 2,500 | 0 | 0 | 0 | 0 | canceled |
| 2026-04 | flat | 2,500 | 2,612 | 12 | 0 | 0 | 2,500 | canceled |
| 2026-05 | churn | 0 | 0 | 0 | 0 | 0 | 0 | canceled |

**Check:**
- Churn booked in **2026-05**. Does Stripe agree the subscription ended then?
- First counted present in **2023-07**. Does that match the signup / first invoice?
- Carries refunds — check whether they are ordinary refunds or the September overbilling class.
