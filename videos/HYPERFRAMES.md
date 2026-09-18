# HyperFrames: directions and logic

Working notes for building rendered video out of HTML with HeyGen's
HyperFrames, written against the repo cloned to `C:\Users\josha\hyperframes`
(commit fetched 2026-09-18) and the skills installed into `C:\Users\josha\CAC`.

Everything below was verified on this machine unless it says otherwise.

---

## 1. What it actually is

> Write HTML. Render video.

A composition is one HTML file. The DOM declares timing with `data-*`
attributes, the animation runtime is seekable, and the framework owns media
playback. A renderer drives a headless Chrome frame by frame, seeking the page
to each timestamp, and pipes the captured frames to FFmpeg.

That single sentence explains every constraint in this document. Because the
renderer **seeks to a time and screenshots**, a frame must be reproducible
from its time value alone. Anything that makes the page depend on when or how
often it ran is banned, not discouraged.

```
HTML + CSS + GSAP timeline
        │
        ├─ lint      static structure check
        ├─ check     headless Chrome: runtime errors, layout, motion, contrast
        │
        └─ render    seek → screenshot → FFmpeg → MP4
```

It is Apache 2.0, open source, and the local render path needs no account.
There is an optional HeyGen-hosted cloud render and AWS Lambda / GCP Cloud Run
paths, but they are opt-in, not the default.

---

## 2. Prerequisites

| Requirement | Why | State on this machine |
|---|---|---|
| Node.js **22+** | `npx` is Node; the whole CLI is a Node program | installed v26.7.0 via `winget install OpenJS.NodeJS` |
| **FFmpeg** | encodes the captured frames | installed 9.0.1 via `winget install Gyan.FFmpeg` |
| Headless Chrome | the capture surface | the CLI manages its own; `npx hyperframes doctor` checks it |
| bun | only for building the *repo itself*, not for using it | not installed, not needed |

Both winget installs modify PATH, which an already-running shell does not pick
up. In this session every command is prefixed with a PATH refresh:

```bash
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
```

A HeyGen account is **not** required. `npx hyperframes auth status` exits 1
when signed out, which is fine: it only gates TTS voices and the BGM library.
A silent video needs neither.

---

## 3. The skill system

The repo ships 20 agent skills. They are the real interface: the framework has
enough non-obvious rules that generic docs do not get you to a passing render.

```bash
npx skills add heygen-com/hyperframes            # interactive picker
npx skills add heygen-com/hyperframes --all      # all 20, skips the picker
npx hyperframes skills update                    # core set, from current main
npx hyperframes skills update <workflow>         # one workflow, on demand
```

Non-interactive runs without `--skill` install all 20. `skills add` reads the
skills.sh registry blob, which can lag `main` by hours; `hyperframes skills
update` installs from `main`.

Installs land in `.agents/skills/<name>/` and are symlinked to
`.claude/skills/<name>/`. **A running agent session will not see them** until
it restarts or the project is re-scaffolded; in this session `Skill` returned
`Unknown skill: hyperframes` until `hyperframes init` relinked them. Reading
`.claude/skills/<name>/SKILL.md` directly is an equivalent fallback and is what
the dispatch contract tells subagents to do anyway.

### Routing

`/hyperframes` is the mandatory entry point and a router, not a worker. It
matches the **deliverable** against a priority table and hands off:

| Deliverable | Workflow |
|---|---|
| Port existing Remotion source | `/remotion-to-hyperframes` |
| Presentation / navigable deck | `/slideshow` |
| Captions on existing footage | `/embedded-captions` |
| Designed overlays on existing footage | `/talking-head-recut` |
| Beat-synced from a music track | `/music-to-video` |
| Short (<10s), unnarrated, motion-is-the-message | `/motion-graphics` |
| Explain a GitHub PR | `/pr-to-video` |
| Market a website from a URL | `/product-launch-video` |
| **Explain a topic from text, invented visuals** | **`/faceless-explainer`** |
| Anything else | `/general-video` |

Domain skills are pulled on demand by whichever workflow is running:
`hyperframes-core` (composition contract), `-animation`, `-keyframes`,
`-creative`, `-cli`, `-registry`, `-audio`, `media-use`, `figma`.

---

## 4. The directions: how a video actually gets built

This is the `/faceless-explainer` pipeline. The other creation workflows are
the same spine with different capture steps.

```
Step 0  setup      → hyperframes.json + BRIEF.md
Step 1  brief      → capture/extracted/{visible-text.txt, tokens.json}
Step 2  design     → frame.md            (from a shipped preset)
Step 3  storyboard → STORYBOARD.md       (+ SCRIPT.md only if narrated)
Step 3.1 audio     → audio_meta.json     (skipped entirely when silent)
Step 4  visual     → STORYBOARD.md enriched with time-coded shot sequences
Step 5  frames     → compositions/frames/NN-*.html  +  index.html
Step 6  finalize   → renders/video.mp4
```

Each step has a **gate** that must pass before the next one starts.

### The layering that makes it work

```
BRIEF.md        why, for whom, everything the user asked for
  └ STORYBOARD.md   what, frame by frame
      └ frame.md        how it looks (colour, type, spacing)
          └ compositions/   the thing itself
```

`BRIEF.md` is the **no-repeat token**. A workflow that finds it asks no brief
questions. That is what makes a dead session resumable: a decision that lives
only in chat is a decision resume never sees.

### Step 0 — setup

```bash
npx hyperframes init "videos/<project>" --non-interactive --example=blank --skill=faceless-explainer
```

`init` refuses a non-empty directory, so `BRIEF.md` is written *immediately
after*, never before.

### Step 2 — design system

Pick one shipped preset (13 of them: `cartesian`, `cobalt-grid`,
`blue-professional`, `code-editorial`, `broadside`, `bold-poster`, …) and let
a script turn it into the project's `frame.md`:

```bash
node <SKILL_DIR>/scripts/build-frame.mjs --preset cobalt-grid --hyperframes .
```

It copies the preset's `FRAME.md`, remixes it onto any brand colours in
`tokens.json`, copies a caption skin, and self-validates.

> **Watch the remix.** It maps brand colours onto preset colour keys *by
> role*, and it can get the role wrong. Feeding it this project's palette put
> the site's **red** onto `paper-2`, a background surface. Its self-check only
> verifies ink/canvas contrast, so it exited 0 with a brick-red background
> tone. Read the generated `colors:` block before trusting it; hand-editing
> afterward is explicitly allowed.

### Step 3 — storyboard

`STORYBOARD.md` is YAML frontmatter plus one `## Frame N — Title` section per
frame, metadata as `- key: value` bullets, free-form narrative below them.

Frontmatter: `format`, `duration`, `message`, `arc`, `audience`, `mode`.
Per frame: `status` (`outline` → `built` → `animated`), `src`, `duration`,
`transition_in`, `scene`, `voiceover`, `poster`. Unknown keys are preserved
under `extra`, so workflows carry their own per-frame data there.

**The silent marker is exact**: `music: none` in the frontmatter **and** no
`SCRIPT.md`. That combination makes `audio.mjs` a clean no-op. `music: none`
*with* a SCRIPT.md keeps TTS and only kills the music bed. Do not improvise
other spellings.

### Step 4 — the unit is a time-coded shot sequence

This is the part that separates a video from a slide deck. Each frame is
written as a handful of time windows:

```
Scene 1 (0.0–1.4s): only what is being said at t=0 enters, never the whole canvas
Scene 2 (1.4–3.0s): the next piece reveals as the line names it
Scene 3 (3.0–end):  content has resolved; hold the read, STILL
```

The named failure mode is **front-loading**: dumping the whole canvas in the
first ~25% and then sitting there. The rule is that nothing appears before the
narration reaches it, and in a silent piece reveals pace to reading time
instead. The build *is* the teaching.

Per frame you also tag `blueprint:` (one of 22 proven shot shapes, marked
`Reproduce` / `Adapt`, or `compose`), `focal:` (the hero element) and `roles:`
(each element as foreground subject / background / supporting).

Hard constraints from the spec: the invented hero fills **40–60%** of the
frame; at least **3 depth layers**; at least **3 different framings** per
video and never the same framing twice in a row.

### Step 5 — packets and fan-out

```bash
node <SKILL_DIR>/scripts/frame-packets.mjs --project "$DIR" --storyboard "$DIR/STORYBOARD.md"
```

This writes one **bounded packet** per frame into `.hyperframes/frame-packets/`
— that frame's exact storyboard block, plus the blueprint body, plus every
cited rule recipe, inlined — and `_role.md`, the complete worker contract.

Then one subagent per frame, in parallel. The dispatch contract:

- The child's prompt is `_role.md` **verbatim** plus a `## Dispatch context`
  block. Never digested or paraphrased.
- The child never sees your conversation, memory or skills. *The prompt and
  the files on disk are its entire world.*
- Workers read only their packet and `frame.md`. They never open
  `STORYBOARD.md`. They write exactly one file.
- **Completion means the artifact exists on disk**, not that the harness said
  the child finished. Verify, and re-dispatch once on a miss.
- A concurrency cap reduces parallelism, never scope: 9 frames on a cap-3
  harness is 3 waves of 3. Never merge frames into one worker to fit.

### Step 6 — gates, then render

```bash
npx hyperframes lint          # static structure
npx hyperframes check         # headless Chrome gate
npx hyperframes snapshot --at <midpoints>
npx hyperframes preview --background
npx hyperframes render --quality high --output renders/video.mp4
```

---

## 5. The logic: the composition contract

### Minimal renderable composition

```html
<div id="root" data-composition-id="main"
     data-width="1920" data-height="1080" data-duration="5">
  <section id="title-card" class="clip" data-start="0" data-duration="5">
    <h1 id="title">Hello</h1>
  </section>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.from("#title", { y: 48, opacity: 0, duration: 0.6, ease: "power3.out" }, 0.2);
  window.__timelines["main"] = tl;   // key MUST equal data-composition-id
</script>
```

### What the runtime actually requires

- A root with `data-composition-id`, `data-width`, `data-height`.
- A duration source: root `data-duration`, or a GSAP timeline, or media, or an
  adapter that can infer one.
- Exactly **one** `gsap.timeline({ paused: true })` per composition,
  registered on `window.__timelines["<composition-id>"]`.

`window.__timelines` already exists before your inline scripts run; you do not
need to create it.

### Timing

**`data-start` is what makes an element a clip.** The runtime collects
`[data-start]` and drives visibility from it. `class="clip"` is a layout and
tooling convention the runtime never reads — but keep writing it, because
without it the full-frame box collapses and lint warns.
`data-track-index` is a **Studio display lane only**; the render never reads
it and clips on one track may overlap in time.

**The visibility window is half-open: `[start, start + duration)`.** A clip is
hidden at exactly `t = start + duration`. Land an animation's end state
slightly *before* `data-duration` or its last frame never renders. Two clips
can therefore butt up back to back with no overlapping frame.

**Root `data-duration` is read once at compile time**, like width and height.
A script or `--variables` value that rewrites it afterward is ignored. A
*clip's* `data-duration` is different: re-read from the live DOM, so scripts
can drive it.

**Root-level clips get automatic layout**: direct children of the root that
carry `data-start` are forced to `position: absolute`, anchored top-left and
sized to 100%. Elements *without* `data-start` are skipped entirely, so an
untimed full-bleed background needs its own `position: absolute; inset: 0` or
it collapses to zero height.

### Two root forms, not interchangeable

- **Standalone** (`index.html`): root sits directly in `<body>`, **no
  `<template>` wrapper**. Wrapping one hides all content and lint rejects it.
- **Sub-composition** (loaded via `data-composition-src`): root **is** wrapped
  in `<template>`. For a templated sub-composition the assembler drops the
  file's own `<head>` `<style>`/`<script>`, so put them **inside** the
  template. `<link>` is hoisted either way.

### Determinism bans

Same input time must give same pixels. Never use, for visual state:

- `Date.now()`, `performance.now()`, any render-time clock
- unseeded `Math.random()` (use a seeded PRNG)
- render-time network fetches for required assets
- hover / scroll / pointer / focus state — the renderer has no input events
- `repeat: -1`. Compute a finite count with **`floor`, not `ceil`**:
  `repeat: Math.max(0, Math.floor(duration / cycle) - 1)`

Also avoid animating the same property on the same element from two timelines
at once: GSAP's overwrite behaviour is order-dependent and can flip between
renders.

---

## 6. The rules that bite

These are the guaranteed first-build failures. Writing them right the first
time saves a full lint round trip.

| Rule | Lint code |
|---|---|
| Never pair a CSS initial `transform` with a GSAP tween on the same property. Use `gsap.fromTo(el, {x:-40},{x:0})`, not `transform: translateX(-40px)` | `gsap_css_transform_conflict` |
| Never tween `display`, `visibility` or `autoAlpha` **on a `.clip`**. The framework owns clip visibility. Animate a child | `gsap_animates_clip_element` |
| Never put `crossorigin` on `<video>`/`<audio>`. No suppression exists | `media_crossorigin_breaks_preview` |
| Every `<audio>` needs an `id`. Without one it is never mixed and the render is **silent** | `media_missing_id` |
| Never give a `<video data-start>` an ancestor that also has `data-start`. Time the wrapper *or* the video | `video_nested_in_timed_element` |
| A named `font-family` needs an in-file `@font-face` to a shipped local file | `font_family_without_font_face` |
| Sub-comp `#root` uses `width/height: 100%`, never hardcoded `1920px` | — |
| Register the timeline **after** an async build completes, not before | `gsap_timeline_registered_before_async_build` |

Silent bugs the automated gates can miss:

- **No `<br>` in body text.** Forced breaks ignore rendered font width and add
  an extra break when the line already wraps, causing overlap. Use `max-width`.
- **Transformed elements must be block-level and sized.** `scaleX` on an
  inline `<span>` is a no-op, and scaling an auto-width element shows nothing.
- **Pulsing absolute decoratives need clearance at their peak size**, not
  their resting size, and must not straddle an `overflow: hidden` edge.

> **A lint error switches off the layout and contrast audits.** `check` then
> reports `0 sample(s)` and `0/0 text checks`, which reads like a clean file
> but means nothing ran. Clear lint errors before trusting those numbers.

`data-layout-allow-overflow` is the escape hatch for intentional overflow, but
it is **inherited down the subtree** and also suppresses `text-clipping`,
`content-cramped-container` and `foreground-over-panel` for every descendant.
Scope it to the smallest decorative wrapper.

---

## 7. CLI surface

| Need | Command |
|---|---|
| Scaffold | `npx hyperframes init <project>` |
| Find an existing primitive before hand-building | `npx hyperframes catalog --query "<effect in plain English>"` |
| Install one | `npx hyperframes add <name>` |
| Static check | `npx hyperframes lint` |
| Full gate (reruns lint, opens Chrome) | `npx hyperframes check` |
| Contact sheet | `npx hyperframes snapshot --at <times>` |
| Studio preview, survives the invoking command | `npx hyperframes preview --background` |
| Fast iteration | `npx hyperframes render --quality draft` |
| First real encode | `npx hyperframes render --quality looks` |
| Final delivery | `npx hyperframes render --quality delivery` |
| Toolchain diagnosis | `npx hyperframes doctor` |

Deprecated aliases: `validate`, `inspect`, `layout`. Use `check`.
Do not call `events` by hand; it is a telemetry endpoint that exits 0 whatever
you pass it.

**Search the catalog before inventing a named look.** ~400 hosted blocks and
components rank from any directory with nothing installed, no project and no
account. Hand-authoring a "shimmer sweep" that already exists is the most
common waste in this pipeline.

After a render, read the summary's **second line**: `beginframe` vs
`screenshot`, GPU mode, stage timings. `screenshot` + `software gpu` is the
slow path.

---

## 8. Where things live

```
C:\Users\josha\hyperframes\                  full repo clone (1.8 GB)
  docs/concepts/{compositions,data-attributes,determinism,frame-adapters,variables}.mdx
  registry/blocks/                           50+ installable scenes
  packages/{cli,core,engine,player,producer,studio}/

C:\Users\josha\CAC\.claude\skills\           20 skills (symlink → .agents/skills)
  hyperframes/SKILL.md                       the router, read first
  hyperframes-core/references/               the contract, per topic
  faceless-explainer/{SKILL.md,scripts/,references/}

C:\Users\josha\CAC\videos\<project>\
  BRIEF.md STORYBOARD.md frame.md hyperframes.json
  capture/extracted/{visible-text.txt,tokens.json}
  .hyperframes/frame-packets/{_role.md,NN-*.md}
  compositions/frames/NN-*.html
  renders/video.mp4
```

---

## 9. State of the CAC video build

Three videos planned, one per chart, all silent and 1920x1080:

1. **LTV:CAC by cohort** — `videos/ltv-cac-by-cohort` (in progress)
2. **Expected payback by cohort** — not started
3. **Cumulative gross profit against cost** — not started

Video 1 progress:

- [x] Project scaffolded, `BRIEF.md` written
- [x] Source text and `tokens.json` written from the live site figures
- [x] `frame.md` built from `cobalt-grid`, palette hand-corrected to the
      site's own `styles.css` values, `series:` block added so red/green/grey
      keep their meaning from the chart
- [x] `STORYBOARD.md`: 7 frames, 55s, shot sequences written
- [x] Frame packets built (7 packets + `_role.md`)
- [x] Frame 07 built (`07-the-lever.html`)
- [ ] Frames 01–06 — dispatched, then interrupted before completion
- [ ] `lint` / `check` / `snapshot`
- [ ] Assemble `index.html`, inject transitions, render

**Open item carried forward from frame 07's worker:** no fonts ship with the
project, so it inlined `@font-face` rules pointing at Google Fonts URLs for
Newsreader 400 and DM Mono 400. That is a render-time network fetch for a
required asset, which the determinism rules ban. Before rendering, either
stage local `.woff2` files under `assets/fonts/` and repoint every frame, or
accept that the first render depends on network availability. This affects
every frame identically, so fix it once, across all of them.

The figures in the storyboard are live values pulled from
`https://chiirpacc.github.io/CAC/` on 2026-09-18 by importing the site's own
`data.js` and calling `cohortEconomics` with the settled margin (0.757), so
they match the deployed chart exactly rather than being retyped.
