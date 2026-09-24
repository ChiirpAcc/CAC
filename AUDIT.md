# Ten accounts to audit — v108

Push `2026-09-24T11:47:44`, pipeline v108. Window ends **2026-08**, so nothing
here reflects September.

These are chosen to test what is still open rather than sampled at random. `sub_start`
and `sub_end` are now clean on every row, so the dates below are worth checking against
Stripe as a verification of that fix.

## At a glance

| # | Account | Stripe ID | Tests |
|---|---|---|---|
| 1 | Stuart Quick Dry Carpet Cl | `cus_NVBH7DyIVrXKCz` | Wire timing, and platform_mrr doubled with it |
| 2 | The Favret Company | `cus_T9Vw0f1919dDOL` | Same pattern, three times over |
| 3 | 5 Star Home Services | `cus_OHRjtf7WG1letb` | The largest wire case, no subscription line |
| 4 | Deljo Heating & Cooling In | `cus_QZ7SyCh3RqpRM8` | Wire timing plus a cancelled status |
| 5 | Northside Tree Professiona | `cus_PwUTY6mouLCQp7` | One month of revenue on a zero base, largest |
| 6 | DropStar Plumbing | `cus_U0dkg8xOW9PSpQ` | Same shape, with a readable line |
| 7 | Get Lit Electrical and Plu | `cus_LFRwj4Jhpx9GFX` | Was cancelled-but-billing, now looks right |
| 8 | Embrich Plumbing | `cus_UGnlLKGBulpuk1` | Billed then reversed, still present |
| 9 | Powersol USA Marketing | `cus_R9rWiTJ3mQLMwW` | Refund repeating every month for six months |
| 10 | General Air Conditioning & | `cus_PeWAeP0bzsEyPh` | Wire timing three times, line present twice |

## What these are testing

**Wire timing is the big one left, and `platform_mrr` cannot fix it.** The
shape is a zero month followed by exactly twice the base — one payment
landing late, so one month gets two and the month before gets none. There
are 57 recent cases. Critically:

| | count |
|---|---|
| `platform_mrr` also doubled | 19 |
| `platform_mrr` steady | **0** |
| no subscription line at all | 38 |

Not one has a steady line, so the discriminator that fixed the other 177
cases can never catch these. Where the line exists it moves with the cash,
which means it is derived from the same place and is not an independent
check. That is the thing worth confirming in Stripe: **is the contracted
monthly amount steady across these months?**

**One month of revenue on a zero base** is a different question: 133 of the
183 remaining pairs look like this. A single month between two zeros may be
an annual, a one-off project, or a genuine single month, and the data cannot
tell them apart.

**`sub_start` is now clean on all 33,491 values.** I verified the 10,671
repairs were correct rather than blanked, but I verified them against my own
normalisation, not against Stripe. These ten are a chance to confirm the
dates are actually right.

---

---

## 1. Stuart Quick Dry Carpet Cleaning
`cus_NVBH7DyIVrXKCz` — Wire timing, and platform_mrr doubled with it

| | |
|---|---|
| Env | S1 |
| Months on file | 42 (2023-03 to 2026-08) |
| sub_start / sub_end | `2023-03` / `-` |
| subscription_status | `active` |
| has_live_sub / unpaid_due | 1 / 0 |
| Lifetime cash | $20,308 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2026-04 | flat | 500 | 500 | 512 | 500 | 0 | 0 | 0 |
| 2026-05 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2026-06 | expansion | 1,000 | 1,000 | 1,024 | 1,000 | 0 | 0 | 0 |
| 2026-07 | contraction | 500 | 500 | 512 | 500 | 0 | 0 | 0 |
| 2026-08 | flat | 500 | 500 | 512 | 500 | 0 | 0 | 0 |

**Question:** Zero in 2026-05 then $1,000 in 2026-06 on a $500 base. platform_mrr reads 1,000 that month too, so the subscription line is NOT an independent check here. Is the real rate $500 throughout?

---

## 2. The Favret Company
`cus_T9Vw0f1919dDOL` — Same pattern, three times over

| | |
|---|---|
| Env | S1 |
| Months on file | 12 (2025-09 to 2026-08) |
| sub_start / sub_end | `2025-09` / `-` |
| subscription_status | `active` |
| has_live_sub / unpaid_due | 1 / 0 |
| Lifetime cash | $7,683 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2025-10 | flat | 749 | 699 | 774 | 749 | 0 | 0 | 0 |
| 2025-11 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2025-12 | expansion | 1,498 | 1,398 | 1,498 | 1,498 | 0 | 0 | 0 |
| 2026-01 | contraction | 749 | 699 | 749 | 749 | 0 | 0 | 0 |
| 2026-02 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2026-03 | expansion | 1,498 | 1,188 | 1,498 | 1,498 | 0 | 0 | 0 |
| 2026-04 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2026-05 | expansion | 1,498 | 1,398 | 1,610 | 1,498 | 0 | 0 | 0 |
| 2026-06 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2026-07 | expansion | 749 | 699 | 805 | 749 | 0 | 0 | 0 |
| 2026-08 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**Question:** Repeats in 2025-12, 2026-03 and 2026-05. A recurring wire that lands late should show as one steady rate. Confirm the contracted monthly amount.

---

## 3. 5 Star Home Services
`cus_OHRjtf7WG1letb` — The largest wire case, no subscription line

| | |
|---|---|
| Env | S1 |
| Months on file | 35 (2023-07 to 2026-05) |
| sub_start / sub_end | `2023-07` / `2026-03` |
| subscription_status | `canceled` |
| has_live_sub / unpaid_due | 0 / 0 |
| Lifetime cash | $193,112 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2023-11 | flat | 7,000 | 0 | 7,000 | 7,000 | 0 | 0 | 0 |
| 2023-12 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2024-01 | expansion | 14,000 | 0 | 14,000 | 14,000 | 0 | 0 | 0 |
| 2024-02 | contraction | 7,000 | 0 | 7,000 | 7,000 | 0 | 0 | 0 |
| 2024-03 | flat | 7,000 | 0 | 7,000 | 7,000 | 0 | 0 | 0 |
| 2024-04 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2024-05 | expansion | 14,000 | 0 | 14,000 | 14,000 | 0 | 0 | 0 |
| 2024-06 | contraction | 7,000 | 0 | 7,000 | 7,000 | 0 | 0 | 0 |
| 2024-07 | flat | 7,000 | 0 | 7,000 | 7,000 | 0 | 0 | 0 |
| 2024-08 | flat | 7,000 | 0 | 7,000 | 7,000 | 0 | 0 | 0 |
| 2024-09 | flat | 7,000 | 0 | 7,000 | 7,000 | 0 | 0 | 0 |
| 2024-10 | flat | 7,000 | 0 | 7,000 | 7,000 | 0 | 0 | 0 |
| 2024-11 | flat | 7,000 | 0 | 7,000 | 7,000 | 0 | 0 | 0 |
| 2024-12 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2025-01 | expansion | 14,000 | 0 | 14,000 | 14,000 | 0 | 0 | 0 |
| 2025-02 | contraction | 5,000 | 0 | 5,000 | 5,000 | 0 | 0 | 0 |
| 2025-03 | flat | 5,000 | 0 | 5,000 | 5,000 | 0 | 0 | 0 |

**Question:** Zero months in 2023-12, 2024-04 and 2024-12, each followed by exactly 14,000. platform_mrr is 0 throughout, so nothing in the push can see the true rate. Should be 7,000 every month.

---

## 4. Deljo Heating & Cooling Inc.
`cus_QZ7SyCh3RqpRM8` — Wire timing plus a cancelled status

| | |
|---|---|
| Env | S1 |
| Months on file | 26 (2024-07 to 2026-08) |
| sub_start / sub_end | `2024-07` / `2026-09` |
| subscription_status | `canceled` |
| has_live_sub / unpaid_due | 0 / 0 |
| Lifetime cash | $27,894 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2024-11 | flat | 999 | 0 | 1,311 | 999 | 0 | 0 | 0 |
| 2024-12 | contraction | 0 | 0 | 270 | 0 | 0 | 0 | 0 |
| 2025-01 | expansion | 1,998 | 0 | 2,022 | 1,998 | 0 | 0 | 0 |
| 2025-02 | contraction | 999 | 0 | 1,219 | 999 | 0 | 0 | 0 |
| 2025-03 | flat | 999 | 0 | 1,499 | 999 | 0 | 0 | 0 |
| 2025-04 | flat | 999 | 0 | 1,499 | 999 | 0 | 0 | 0 |
| 2025-05 | flat | 999 | 0 | 1,099 | 999 | 0 | 0 | 0 |
| 2025-06 | flat | 999 | 0 | 999 | 999 | 0 | 0 | 0 |
| 2025-07 | flat | 999 | 0 | 999 | 999 | 0 | 0 | 0 |
| 2025-08 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2025-09 | expansion | 1,998 | 0 | 1,998 | 1,998 | 999 | 0 | 0 |
| 2025-10 | contraction | 999 | 999 | 1,011 | 999 | 0 | 0 | 0 |
| 2025-11 | flat | 999 | 999 | 1,011 | 999 | 0 | 0 | 0 |
| 2025-12 | flat | 999 | 999 | 1,011 | 999 | 0 | 0 | 0 |
| 2026-01 | flat | 999 | 999 | 1,011 | 999 | 0 | 0 | 0 |
| 2026-02 | flat | 999 | 789 | 1,011 | 999 | 0 | 0 | 0 |
| 2026-03 | flat | 999 | 999 | 1,011 | 999 | 0 | 0 | 0 |
| 2026-04 | flat | 999 | 999 | 1,011 | 999 | 0 | 0 | 0 |
| 2026-05 | flat | 999 | 999 | 1,011 | 999 | 0 | 0 | 0 |
| 2026-06 | flat | 999 | 999 | 1,011 | 999 | 0 | 0 | 0 |
| 2026-07 | flat | 999 | 999 | 1,011 | 999 | 0 | 0 | 0 |
| 2026-08 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**Question:** Two 1,998 months on a 999 base. Also reads subscription_status canceled. Is this account live, and at what rate?

---

## 5. Northside Tree Professionals
`cus_PwUTY6mouLCQp7` — One month of revenue on a zero base, largest

| | |
|---|---|
| Env | S1 |
| Months on file | 29 (2024-04 to 2026-08) |
| sub_start / sub_end | `2024-04` / `-` |
| subscription_status | `active` |
| has_live_sub / unpaid_due | 1 / 0 |
| Lifetime cash | $25,009 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2025-01 | flat | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2025-02 | flat | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2025-03 | expansion | 8,500 | 0 | 8,500 | 8,500 | 0 | 0 | 0 |
| 2025-04 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2025-05 | flat | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2025-06 | flat | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**Question:** 0 -> 8,500 -> 0 with 8,500 of cash and no platform line. Is this an annual, a one-off project, or a real month of subscription?

---

## 6. DropStar Plumbing
`cus_U0dkg8xOW9PSpQ` — Same shape, with a readable line

| | |
|---|---|
| Env | S1 |
| Months on file | 7 (2026-02 to 2026-08) |
| sub_start / sub_end | `2026-02` / `-` |
| subscription_status | `unpaid` |
| has_live_sub / unpaid_due | 1 / 0 |
| Lifetime cash | $6,315 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2026-02 | new | 1,040 | 1,040 | 1,545 | 1,040 | 0 | 0 | 505 |
| 2026-03 | contraction | 0 | 0 | 20 | 0 | 0 | 0 | 0 |
| 2026-04 | expansion | 3,500 | 3,500 | 4,000 | 3,500 | 0 | 0 | 0 |
| 2026-05 | contraction | 0 | 750 | 750 | 0 | 0 | 0 | 0 |
| 2026-06 | flat | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2026-07 | flat | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2026-08 | flat | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**Question:** 0 -> 3,500 -> 0, platform_mrr 3,500, cash 4,000. The line agrees with the spike, so if this is a one-off the line is wrong too.

---

## 7. Get Lit Electrical and Plumbing
`cus_LFRwj4Jhpx9GFX` — Was cancelled-but-billing, now looks right

| | |
|---|---|
| Env | S1 |
| Months on file | 35 (2022-03 to 2026-08) |
| sub_start / sub_end | `2026-04` / `2026-08` |
| subscription_status | `canceled` |
| has_live_sub / unpaid_due | 0 / 0 |
| Lifetime cash | $15,816 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2026-04 | reactivation | 0 | 0 | 42 | 0 | 0 | 0 | 0 |
| 2026-05 | expansion | 200 | 0 | 212 | 200 | 0 | 0 | 0 |
| 2026-06 | flat | 200 | 0 | 232 | 200 | 0 | 0 | 0 |
| 2026-07 | flat | 200 | 0 | 224 | 200 | 0 | 0 | 0 |
| 2026-08 | flat | 200 | 0 | 224 | 200 | 0 | 0 | 0 |

**Question:** Was MRR 2,450 against 224 of cash. Now 200 against 224, which matches. But subscription_status still reads canceled while they pay every month. Which is true?

---

## 8. Embrich Plumbing
`cus_UGnlLKGBulpuk1` — Billed then reversed, still present

| | |
|---|---|
| Env | S2 |
| Months on file | 5 (2026-04 to 2026-08) |
| sub_start / sub_end | `2026-04` / `-` |
| subscription_status | `active` |
| has_live_sub / unpaid_due | 1 / 0 |
| Lifetime cash | $2,262 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2026-04 | new | 2,250 | 0 | 2,262 | 2,250 | 0 | 0 | 0 |
| 2026-05 | contraction | 0 | 0 | 0 | 0 | 2,262 | 0 | 0 |
| 2026-06 | flat | 0 | 0 | 0 | 0 | 2,262 | 0 | 0 |
| 2026-07 | flat | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2026-08 | flat | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**Question:** Refunded in full in 2026-05 and 2026-06 and still on the book after. Under the next-month test this is an overbilling rather than a cancellation. Confirm.

---

## 9. Powersol USA Marketing
`cus_R9rWiTJ3mQLMwW` — Refund repeating every month for six months

| | |
|---|---|
| Env | S1 |
| Months on file | 22 (2024-11 to 2026-08) |
| sub_start / sub_end | `2019-02` / `-` |
| subscription_status | `active` |
| has_live_sub / unpaid_due | 1 / 0 |
| Lifetime cash | $889 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2026-01 | contraction | 0 | 0 | 12 | 0 | 200 | 0 | 0 |
| 2026-02 | flat | 0 | 0 | 12 | 0 | 200 | 0 | 0 |
| 2026-03 | flat | 0 | 0 | 12 | 0 | 200 | 0 | 0 |
| 2026-04 | flat | 0 | 0 | 12 | 0 | 200 | 0 | 0 |
| 2026-05 | flat | 0 | 0 | 12 | 0 | 200 | 0 | 0 |
| 2026-06 | flat | 0 | 0 | 12 | 0 | 200 | 0 | 0 |
| 2026-07 | flat | 0 | 0 | 12 | 0 | 0 | 0 | 0 |
| 2026-08 | flat | 0 | 0 | 12 | 0 | 0 | 0 | 0 |

**Question:** The same 200 refund against 12 of cash, six months running. A correction that repeats is a billing configuration. What is this account actually on?

---

## 10. General Air Conditioning & Plumbing
`cus_PeWAeP0bzsEyPh` — Wire timing three times, line present twice

| | |
|---|---|
| Env | S1 |
| Months on file | 31 (2024-02 to 2026-08) |
| sub_start / sub_end | `2024-02` / `-` |
| subscription_status | `active` |
| has_live_sub / unpaid_due | 1 / 0 |
| Lifetime cash | $28,461 |

| month | event | MRR | platform_mrr | cash | recurring | refunded | usage | one-off |
|---|---|---|---|---|---|---|---|---|
| 2025-05 | expansion | 900 | 0 | 900 | 900 | 0 | 0 | 0 |
| 2025-06 | contraction | 0 | 0 | 100 | 0 | 0 | 0 | 0 |
| 2025-07 | expansion | 1,800 | 0 | 1,800 | 1,800 | 0 | 0 | 0 |
| 2025-08 | contraction | 900 | 0 | 900 | 900 | 0 | 0 | 0 |
| 2025-09 | flat | 900 | 0 | 900 | 900 | 0 | 0 | 0 |
| 2025-10 | flat | 900 | 850 | 900 | 900 | 0 | 0 | 0 |
| 2025-11 | flat | 900 | 850 | 900 | 900 | 0 | 0 | 0 |
| 2025-12 | flat | 900 | 850 | 900 | 900 | 0 | 0 | 0 |
| 2026-01 | contraction | 0 | 0 | 20 | 0 | 0 | 0 | 0 |
| 2026-02 | expansion | 1,800 | 1,700 | 1,800 | 1,800 | 0 | 0 | 0 |
| 2026-03 | contraction | 900 | 850 | 900 | 900 | 0 | 0 | 0 |
| 2026-04 | flat | 900 | 850 | 900 | 900 | 0 | 0 | 0 |
| 2026-05 | flat | 900 | 850 | 900 | 900 | 0 | 0 | 0 |
| 2026-06 | contraction | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2026-07 | expansion | 1,800 | 1,700 | 1,800 | 1,800 | 0 | 0 | 0 |
| 2026-08 | contraction | 900 | 850 | 900 | 900 | 0 | 0 | 0 |

**Question:** Doubles in 2025-07, 2026-02 and 2026-07. platform_mrr is 0 for the first and 1,700 for the later two, so the same customer changes class mid-history.
