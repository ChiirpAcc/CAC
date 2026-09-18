---
format: 1920x1080
duration: 82s
message: "The model works. What broke is the price of a customer, not the value of one."
arc: Hook → Definition → Proof → Break → Diagnosis → Caveats → Lever
audience: Chiirp leadership and operators reading the unit-economics site
mode: autonomous
music: none
---

## Video direction

Silent by construction. No narration, no music, no SFX, so **every `voiceover:`
value below is on-screen copy, not spoken**.

### Timing is derived, not felt

The first cut of this video ran 55s and carried 93s of reading. Frames 5 and 6
were showing text more than twice as fast as anyone could read it, which is why
it felt broken. Durations here are computed, not chosen:

    duration = 0.6s entry + (words / 2.3) + 0.5s per figure + hold

2.3 words per second is a comprehension rate for unfamiliar claims, not a
skimming rate. A figure costs half a second because the eye stops on a numeral.
The hold is what makes the last line land instead of being swept away. If copy
changes, the duration changes with it. **Never shorten a frame without cutting
its words.**

| Frame | Words | Figures | Duration |
|---|---|---|---|
| 1 What a customer costs | 10 | 2 | 7.5s |
| 2 What it measures | 21 | 0 | 11s |
| 3 The model worked | 12 | 3 | 8.5s |
| 4 Below the bar | 17 | chart | 12s |
| 5 The value held | 37 | 4 | 15s |
| 6 What would make this wrong | 63 | 0 | 22s |
| 7 The lever | 9 | 0 | 6s |

Frame 4 holds a full 3s after its last reveal with nothing moving. It is a
24-column distribution and the reader needs to look at it, not read it.

### Hard cuts, never crossfades

`transition_in: cut` on every frame. The first cut crossfaded, and a 0.5s
crossfade between two dense type layouts double-exposes both: six seams of
superimposed sentences. Cuts also suit a riso print aesthetic, where nothing
dissolves.

### One grid, all seven frames

The frames previously each anchored their content differently, so every cut
jumped. All content now sits in three fixed zones, and an element may not
wander outside its zone:

- **Left margin 8cqw, right margin 8cqw.** Everything starts on the same x,
  including the chart's plot area and the closing line.
- **Eyebrow zone, top 9cqw.** Mono caps, 1.3cqw, amber, left set. Every frame
  has one. It is the only thing that tells you where you are.
- **Content zone, 16cqw to 46cqw.** The hero lives here and fills **55-65%** of
  the canvas. The first cut ran nearer 40% and read as empty.
- **Footnote zone, top 49cqw.** Mono, 1.15cqw, ink-soft. Caveats, scale notes,
  and anything that qualifies a number.

Minimum type sizes, because the first cut set body copy at ~1.6cqw and it could
not be read at a glance: display 4.6cqw or larger, body **2.2cqw or larger**,
mono figures 3cqw or larger, mono chrome 1.15cqw or larger.

### Look

`frame.md`: Cobalt Grid remixed onto the site's palette. Cool grey paper,
near-black ink, permanent hairline grid, Newsreader for display, DM Mono for
every figure, always tabular.

Colour carries meaning and is never decoration. Teal is the neutral series.
Green is at or above break-even, red is below it, grey is a cohort too young to
judge, amber is the accent for a label the eye must find.

### An initial state belongs in CSS

Anything hidden at t=0 is hidden by its own CSS rule. Do not rely on a
`fromTo` to stamp a hidden start state: `fromTo` defaults to
`immediateRender: true` and applies its `from` values when the tween is
*built*, so a cut scheduled at 6s leaks its start state onto the frame from
t=0. That is exactly how two caveats ended up printed on top of each other in
the first cut. Every `fromTo` positioned later than 0 carries
`immediateRender: false`, and the resting state it animates from is authored in
CSS.

### Honesty rule

Inherited from the site: the falling right-hand side of this chart must never
read as pure decay. Frame 4 draws the young cohorts in grey, and frame 6 gets
22 seconds to say plainly what would make the whole reading wrong.

## Frame 1 — What a customer costs now

- scene: Two costs swap in place under one fixed line, and the second is nearly four times the first
- duration: 7.5s
- transition_in: cut
- status: outline
- voiceover: "A customer costs $2,583. A customer costs $9,367. 3.6x the price."
- type: hook
- persuasion: Contrast, stated as two numbers and nothing else
- beat: attention
- blueprint: kinetic-type-beats (Reproduce)
- focal: the cost figure, mono at hero scale
- roles: cost figure = foreground subject · fixed lead line = supporting · hairline grid = background
- poster: 6s
- src: compositions/frames/01-what-a-customer-costs.html

Open cold on the number, not the topic. The whole argument is a price change,
so the price change is the first thing on screen and the phrase LTV:CAC does
not appear yet.

Eyebrow: "COST PER LOGO". Hero fills the content zone: the figure is the
largest thing in the video.

Scene 1 (0.0-1.2s): grid settles, eyebrow sets, lead line "A customer costs" writes on in the content zone, left set on the 8cqw margin.
Scene 2 (1.2-3.4s): "$2,583" reveals per character beneath the lead line at hero scale, DM Mono, teal. Amber micro label "2024-10 cohort" rises under it. Two seconds to read a figure and its label.
Scene 3 (3.4-5.8s): HARD CUT in place. "$2,583" is gone and "$9,367" stands on the same baseline in red; the label swaps to "2026-08 cohort" on the SAME frame, never a beat later. Nothing fades.
Scene 4 (5.8-7.5s): an amber bracket draws once across the slot both figures occupied and the mono tag "3.6x the price" settles at its midpoint in the footnote zone. Holds STILL.

## Frame 2 — What the chart actually measures

- scene: The ratio assembles term by term, then names its window
- duration: 11s
- transition_in: cut
- status: outline
- voiceover: "Gross profit realised to date over acquisition cost, per logo. Same cohort count divides both halves. 24 monthly cohorts, 2024-09 to 2026-08."
- type: product_intro
- persuasion: Define before you argue, so the argument cannot be dismissed on definitions
- beat: comprehension
- blueprint: compose
- focal: the two-term fraction
- roles: fraction = foreground subject · cohort ribbon = supporting · hairline grid = background
- poster: 9s
- src: compositions/frames/02-what-it-measures.html

The ratio depends on a cost allocation, so the video earns the right to show it
by first saying exactly what is on each side of the divide.

Eyebrow: "WHAT THIS MEASURES". The fraction is the hero and must fill the
content zone; in the first cut it sat small in the upper left with an empty
bottom half, and that is the single biggest formatting failure to fix here.

Scene 1 (0.0-2.0s): eyebrow sets. "Gross profit realised to date" writes on in Newsreader at display scale, left set on the margin.
Scene 2 (2.0-4.0s): a hairline division rule draws left to right beneath it, then "Acquisition cost" settles below the rule. The two terms now read as one fraction, and the fraction spans most of the content zone.
Scene 3 (4.0-6.2s): a bordered mono tag "per logo" springs in to the right of the fraction, and "Same cohort count divides both halves" sets in the footnote zone.
Scene 4 (6.2-9.4s): the fraction lifts and compacts to roughly a third of its height, staying inside the content zone. Beneath it a full-width ribbon of 24 hairline ticks draws in one continuous sweep, first and last labelled 2024-09 and 2026-08 in amber, with "24 monthly cohorts" above it.
Scene 5 (9.4-11.0s): everything holds STILL.

## Frame 3 — The model worked, and here is the receipt

- scene: One cohort's cost and return resolve into a single ratio
- duration: 8.5s
- transition_in: cut
- status: outline
- voiceover: "Cost per logo $2,583. Gross profit per logo $9,696. Ratio 3.75x, against a 3.0x goal."
- type: social_proof
- persuasion: Proof before problem, so the later bad news cannot read as the model never working
- beat: credibility
- blueprint: dataviz-countup (Adapt)
- focal: the 3.75x ratio
- roles: the two counters = foreground subject · the 3.0x goal rule = supporting · hairline grid = background
- poster: 7.5s
- src: compositions/frames/03-the-model-worked.html

Adapt: keep the count-up signature and the landing on one hero metric, drop the
camera push. Two counters resolving into a third is the shape.

Eyebrow: "2024-10 COHORT". Three columns span the full content zone width.

Scene 1 (0.0-1.2s): eyebrow sets, three columns draw as hairline rules across the content zone.
Scene 2 (1.2-3.2s): left column. "Cost per logo", then "$2,583" counts up from zero in mono, teal. The count-up is driven by the timeline, never by a clock.
Scene 3 (3.2-5.2s): centre column fills the same way, "$9,696" in green, sharing the figures' baseline.
Scene 4 (5.2-7.0s): right column resolves. A hairline divides the two and "3.75x" springs in at hero scale, green, the largest thing on screen.
Scene 5 (7.0-8.5s): the dashed "3.0x goal" reference draws in beneath the ratio, which sits clearly above it. Held STILL. The rule is hidden by its own CSS until this moment.

## Frame 4 — Then it stopped clearing the bar

- scene: All 24 cohorts cascade in as columns, the recent half under the break-even line
- duration: 12s
- transition_in: cut
- status: outline
- voiceover: "12 of 24 below break-even. Grey: fewer than 6 months observed."
- type: pain_point
- persuasion: Show the whole distribution rather than the worst case
- beat: tension
- blueprint: grid-card-assemble (Adapt)
- focal: the 24 column chart
- roles: columns = foreground subject · break-even rule = supporting · grey young cohorts = supporting · hairline grid = background
- poster: 10s
- src: compositions/frames/04-below-the-bar.html

Adapt: keep the staggered cascade, but the items are chart columns on a shared
baseline, so the cascade builds a distribution rather than a wall. This is the
centrepiece and it is the one frame whose last three seconds are pure stillness
by design: the reader has to LOOK at a 24-column distribution, and there is no
reading rate for that.

Eyebrow: "LTV : CAC BY COHORT". The plot spans the full content zone, left edge
on the 8cqw margin.

Scene 1 (0.0-1.0s): eyebrow sets, a full-width baseline rule draws left to right. Nothing above it yet.
Scene 2 (1.0-4.4s): 24 columns grow from the baseline in a staggered left-to-right cascade, heights carrying the real ratios in order: 2.61, 3.75, 2.67, 2.00, 2.76, 2.14, 2.37, 2.07, 1.95, 1.09, 1.83, 1.70, 0.97, 0.99, 0.68, 0.81, 0.61, 0.65, 0.66, 0.55, 0.48, 0.24, 0.31, 0.14. Green at or above 1.0x, red below it, and the five youngest grow in GREY regardless.
Scene 3 (4.4-6.0s): a dashed rule labelled "1.0x break-even" draws across at exactly the 1.0 height, over the columns.
Scene 4 (6.0-7.6s): the seven red columns pulse once together. Grey never pulses. "12 of 24 below break-even" settles in the upper left.
Scene 5 (7.6-9.0s): "Grey: fewer than 6 months observed" fades into the footnote zone with a bracket spanning the five grey columns.
Scene 6 (9.0-12.0s): NOTHING MOVES. Three full seconds of stillness on the finished chart.

## Frame 5 — The value held. The price did not.

- scene: Two eras on one shared scale, and only one number moved
- duration: 15s
- transition_in: cut
- status: outline
- voiceover: "The retention curve did not collapse. Acquisition cost per logo did. Early cohorts $2,583 to $4,920. Recent cohorts $5,126 to $9,367. The price of a customer changed. The value of one did not."
- type: feature_showcase
- persuasion: Isolate the variable that actually moved
- beat: comprehension
- blueprint: comparison-split (Reproduce)
- focal: the two era cards on one scale
- roles: era cards = foreground subject · range bars = supporting · hairline grid = background
- roles_note: the "bought cheap" and "bought dear" badges from the first cut are DROPPED. They added four words and no information, and this frame is the most overloaded in the video.
- poster: 13s
- src: compositions/frames/05-price-not-value.html

The single most important frame. A viewer who leaves with only this one has the
finding. It carried 37 words in 9 seconds in the first cut; it now has 15.

Eyebrow: "THE VARIABLE THAT MOVED".

Scene 1 (0.0-2.0s): eyebrow sets, then "The retention curve did not collapse." writes on in Newsreader at display scale.
Scene 2 (2.0-3.8s): beneath it, "Acquisition cost per logo did." lands, with "did" carrying the amber accent. Two full seconds to read both lines.
Scene 3 (3.8-5.6s): two hairline cards enter from opposite wings with mirrored book-open tilts and settle level. Left "Early cohorts, 2024-09 to 2025-05", right "Recent cohorts, 2025-09 to 2026-08". Both draw an IDENTICAL scale rail, $0 to $10,000, before either bar exists.
Scene 4 (5.6-7.6s): the left range bar draws from $2,583 to $4,920 in teal, endpoints in mono.
Scene 5 (7.6-9.8s): the right bar draws from $5,126 to $9,367 in red, on the SAME scale and at the SAME pixel velocity, so the extra draw time is the extra money.
Scene 6 (9.8-11.4s): "One shared scale, $0 to $10,000" sets in the footnote zone.
Scene 7 (11.4-13.4s): beneath both cards, "The price of a customer changed. The value of one did not." writes on in Newsreader.
Scene 8 (13.4-15.0s): holds STILL.

## Frame 6 — What would make this wrong

- scene: Three caveats replace one another under a header that never moves
- duration: 22s
- transition_in: cut
- status: outline
- voiceover: "Realised, not projected: a young cohort sits low because it is young. Cost per logo assumes a month of spend bought that month of logos. Cohorts before 2024-09 are absent because acquisition cost is not recorded then."
- type: benefit_highlight
- persuasion: State the defeaters yourself, which is what makes the finding usable
- beat: credibility
- blueprint: kinetic-type-beats (Adapt)
- focal: the current caveat line
- roles: caveat line = foreground subject · standing header = supporting · hairline grid = background
- poster: 4s
- src: compositions/frames/06-what-would-make-this-wrong.html

Adapt: statement beats with a hard in-place swap, and deliberately NO payoff.
The last caveat simply holds. A punchline here would undercut the point.

This frame carried 63 words in 9 seconds in the first cut, roughly three times
reading speed, and it is the main reason the video failed. Each caveat now gets
just over 7 seconds, which is about 19 words at 2.7 words per second, and the
tag beneath it is part of that budget rather than an extra.

The header occupies the eyebrow zone at the left margin and NEVER moves after
Scene 1. Each caveat sets in the content zone at body scale or larger; each tag
sets in the footnote zone. Every caveat and tag uses the same slot, so only the
words change.

Scene 1 (0.0-0.8s): header "WHAT WOULD MAKE THIS WRONG" sets once in amber mono caps in the eyebrow zone, with the 01/03 rail counter beneath it.
Scene 2 (0.8-7.8s): caveat 1, "Realised, not projected. A young cohort sits low because it is young.", wipes on line by line. Tag settles at 2.0s: "The right-hand columns will keep rising." Then over four seconds of held reading.
Scene 3 (7.8-15.0s): HARD CUT in place to caveat 2, "Cost per logo assumes a month of spend bought that month of logos." Counter steps to 02/03. Tag at 9.0s: "A long sales cycle would put spend on the wrong cohort." Held.
Scene 4 (15.0-22.0s): HARD CUT to caveat 3, "Cohorts before 2024-09 are absent because acquisition cost is not recorded then." Counter steps to 03/03. Tag at 16.2s: "An absence of data, not a verdict." Holds dead still to the end with no closing move.

## Frame 7 — The lever

- scene: One line lands and the two alternatives are struck out
- duration: 6s
- transition_in: cut
- status: outline
- voiceover: "The lever is acquisition cost. Not upsell. Not pricing."
- type: cta
- persuasion: Name the one action, and name what it is not
- beat: resolution
- blueprint: titlecard-reveal (Reproduce)
- focal: the line "The lever is acquisition cost"
- roles: the lever line = foreground subject · the struck alternatives = supporting · hairline grid = background
- poster: 5s
- src: compositions/frames/07-the-lever.html

Eyebrow: "THE LEVER". The closing line is left set on the same 8cqw margin as
every other frame, not centred: centring it was part of why the video read as a
set of unrelated slides.

Scene 1 (0.0-2.0s): eyebrow sets, then "The lever is acquisition cost." slides up into the content zone at display-closing scale, ink.
Scene 2 (2.0-4.0s): beneath it in mono, "Not upsell." and "Not pricing." settle in the footnote zone and a hairline strikes through each in turn.
Scene 3 (4.0-6.0s): everything holds STILL. A single amber hairline draws across the bottom and stops. No logo, no end card.
