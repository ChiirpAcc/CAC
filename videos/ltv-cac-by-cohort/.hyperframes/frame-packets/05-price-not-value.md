# Frame packet: 05-price-not-value

## Project inputs

- Project: C:\Users\josha\CAC\videos\ltv-cac-by-cohort
- Design tokens: C:\Users\josha\CAC\videos\ltv-cac-by-cohort\frame.md
- RULES_DIR: C:\Users\josha\CAC\.agents\skills\hyperframes-animation\rules

## Assigned storyboard block

## Frame 5 — The value held. The price did not.

- scene: Two eras sit side by side, and only one number moved
- duration: 9s
- transition_in: crossfade
- status: outline
- voiceover: "The retention curve did not collapse. Acquisition cost per logo did. Early cohorts were bought for $2,583 to $4,920. Recent ones cost $5,126 to $9,367."
- type: feature_showcase
- persuasion: Isolate the variable that actually moved
- beat: comprehension
- blueprint: comparison-split (Reproduce)
- focal: the two era cards
- roles: era cards = foreground subject · the cost range bars = supporting · hairline grid = background (dim ~35%)
- poster: 7s
- src: compositions/frames/05-price-not-value.html

The single most important frame in the video. A viewer who leaves with only
this one has the finding.

Scene 1 (0.0-1.6s): two cards enter from opposite wings with mirrored book-open tilts and settle side by side on a split-screen. Left card reads "2024-09 to 2025-05", right reads "2025-09 to 2026-08". Cards are hairline outline only, no fill, no shadow.
Scene 2 (1.6-3.6s): inside the left card a horizontal range bar draws from $2,583 to $4,920 in teal, its two endpoints labelled in mono.
Scene 3 (3.6-5.4s): the right card's range bar draws from $5,126 to $9,367 in red, on the same horizontal scale as the left, so its greater length is literal rather than styled.
Scene 4 (5.4-7.0s): the signature move, an inner-edge pill badge spring-pops on each card: "bought cheap" on the left, "bought dear" on the right, both mono, ink on paper.
Scene 5 (7.0-9.0s): beneath both cards a single Newsreader line writes on: "The price of a customer changed. The value of one did not." Held STILL to the cut.

## Selected blueprint: comparison-split

# comparison-split — Comparison Split-Cards

**intent**: Two paired items of equal weight shown side-by-side with mirrored 3D "book-open" tilts — the eye reads them as a balanced comparison, then a pill badge lands at each card's inner edge to punctuate. The motion IS the symmetry: two cards arriving from opposite wings into a held spread.

**roles served**

- Key_Feature (from `comparison-split-cards`): when two complementary features / capabilities of equal weight should be presented **simultaneously, not sequentially** — an A/B, a "X + Y together," paired concepts the viewer must weigh side-by-side. Not for >2 items (use `grid-card-assemble`) or sequential steps.

**duration**: 4–6s

**shot structure** (a `[bg]` canvas carrying two faint ambient glow blooms — `[accent A]` near 30%, `[accent B]` near 70% — so each side owns a color identity across a 50% symmetry axis; equal-width cards under one shared perspective parent)

- **Scene 1 (0.0–~0.8s) — title sets the concept.** A centered `[title line]` with an `[accent keyword]` slides DOWN into place from just above (a short smooth settle). The downward arrival is deliberate: it forms a non-conflicting T-shape against the cards, which arrive from the sides next.
- **Scene 2 (~0.4–1.9s) — the split-tilt entry (signature move).** Two equal-width feature cards arrive from opposite wings — `[left card]` from the left, `[right card]` from the right ~0.2s behind — each carrying a **mirrored 3D `rotateY` tilt** (left faces right, right faces left, opening like a book) and scaling ~0.85→1 as it lands. The entry overlaps the title's tail so the whole thing reads as ONE arrival, not two beats. Each card holds `[image / label / subtitle]`; box-shadows fall **outward** from the tilt (left shadow right, right shadow left).
- **Scene 3 (~1.9–end) — badges punctuate, then hold.** A pill `[badge]` lands at each card's **inner edge** (left then right, ~0.3s apart), overlapping its card ~15% so it reads as attached, not orbiting. This is the lone overshoot in the shot — it earns the punctuation. Settles and holds.

**motion vocabulary**: title slide-down from above; mirrored opposite-wing card entry; static book-open `rotateY` tilt (`+tilt` left, `−tilt` right); tilt-matched outward box-shadow; inner-edge badge spring-pop; gentle phase-opposed idle float (left vs right, never synchronized) registered as subtle jitter; dual side-glow ambient.

**rule mapping**

- two cards entering from opposite wings with mirrored `rotateY` tilts + tilt-matched shadow → `split-tilt-cards` (the signature; keep the two-layer split so the entry `x`/`scale` and the idle never collide on one alias)
- title slide-down settle → `gsap-effects` (translate + opacity on a long-tail `power3`)
- inner-edge pill badge pop (the one overshoot) → `spring-pop-entrance` (overshoot register — earns the punctuation)
- phase-opposed idle float on the pair → `sine-wave-loop` (low-amplitude register — subtle jitter, NOT lazy breathing; left `sin(t)`, right `sin(t+π)` so they never conveyor-belt)
- the two faint side glows behind the cards → `ambient-glow-bloom` (un-triggered soft bloom, one per accent)

**camera modifier**: camera-static by default — the symmetry is the subject and a move would break the balance.
