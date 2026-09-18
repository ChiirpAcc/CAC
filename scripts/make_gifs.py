#!/usr/bin/env python3
"""Render the animated charts straight from data/.

  arrivals_vs_churn.gif   churn against arrivals, horizons 1 to 6
  ltv_cac_by_age.gif      LTV:CAC as cohorts mature

Two files where there were four. The price-split scatter and the paired
difference that corrected it are gone: the split version read as though
nothing was there, the paired view existed only to say why that reading was
wrong, and neither survived the question being answered. A chart kept to
argue with a chart nobody is looking at any more is just maintenance.

The arrivals animation anchors every horizon to the same starting months, the
same rule the interactive chart uses, so stepping through the horizons changes
the horizon and nothing else. Taking the last 24 complete windows at each
setting instead slides the period backwards as the horizon grows, and the
effect that appeared at one month turned out to be carried by the recent
thin-intake months that only the short horizons could see.

Axes are fixed across every frame. If each frame rescaled to its own data the
cloud would look much the same at every horizon and the movement would be
invisible.

Output goes to site/media/ so the deploy serves it, and the build regenerates
these on every data push rather than trusting a committed copy to be current.

Run: python scripts/make_gifs.py [output_dir]
"""

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "site" / "media"

INK = (28, 30, 34)
SOFT = (122, 128, 136)
RULE = (219, 222, 226)
LOW = (168, 66, 58)
HIGH = (31, 111, 139)
BG = (255, 255, 255)

W, H = 900, 660
PAD = {"l": 96, "r": 40, "t": 110, "b": 132}
HORIZONS = range(1, 7)
WINDOWS = 24          # the same two year limit the site applies


def history_starts(reference=None):
    """The month the site's window opens, derived the same way it derives it.

    Taking the last 24 eligible starting months instead reached six months
    further back than the site allows, because eligibility shrinks with the
    horizon: at six months the newest eligible start is 2026-02, so the last
    24 of them began in 2024-03. The animation and the chart it animates then
    reported different correlations for the same question, +0.11 against
    -0.18 at four months, with nothing on either to say why.
    """
    from datetime import date
    today = reference or date.today()
    total = today.year * 12 + (today.month - 1) - WINDOWS
    return f"{total // 12}-{total % 12 + 1:02d}"


HISTORY_STARTS = history_starts()


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def number(value):
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("$", "")
    if text in ("", "-", "--"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def month_add(month, offset):
    year, m = map(int, month.split("-"))
    total = year * 12 + (m - 1) + offset
    return f"{total // 12}-{total % 12 + 1:02d}"


def font(size, bold=False):
    names = ("segoeuib.ttf", "arialbd.ttf") if bold else ("segoeui.ttf", "arial.ttf")
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


F_TITLE, F_LABEL, F_TICK, F_BIG = font(26, True), font(15), font(13), font(19, True)


# Presence is an event type, not a payment. Same rule the site uses: a
# customer billed but not yet collected is in the base, and reading presence
# off the amount instead turned one late payment into a churn and a
# reactivation. The value kept against each id is still the revenue, which is
# legitimately zero for those customers.
LIVE_EVENTS = {"new", "reactivation", "flat", "expansion", "contraction"}


def read_months():
    mrr = defaultdict(dict)
    for row in load("customer_waterfall.json")["rows"]:
        if row.get("event_type") not in LIVE_EVENTS:
            continue
        mrr[row["month"]][row["customer_id"]] = number(row.get("eop_mrr")) or 0.0

    waterfall = {r["month"]: r for r in load("waterfall_summary.json")["rows"]}
    last = max(mrr)

    def eligible(horizon):
        return [m for m in sorted(mrr)
                if month_add(m, horizon) <= last
                and waterfall.get(m, {}).get("new_logos") is not None]

    # Every horizon uses the same starting months. Taking the most recent
    # complete windows at each setting instead would slide the period backwards
    # as the horizon grows, so the slider would change two things at once, and
    # an effect that appeared at one month turned out to be carried entirely by
    # the recent thin-intake months only the short horizons could reach.
    # Inside the window, not merely the most recent 24 that qualify.
    anchor = set(m for m in eligible(max(HORIZONS)) if m >= HISTORY_STARTS)
    return mrr, waterfall, last, eligible, anchor


def fit(xs, ys):
    """Slope expressed per ten FEWER arrivals, which is how the question is asked."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx
    r = sxy / math.sqrt(sxx * syy)
    residual = sum((y - (my + b * (x - mx))) ** 2 for x, y in zip(xs, ys))
    se = math.sqrt(residual / (n - 2) / sxx)
    return r, -b * 10 * 100, 1.96 * se * 10 * 100


def frame(title, subtitle, y_range, y_format, x_range=(0, 90), x_title="New logos in the starting month",
          y_title="Churn", zero_line=False):
    image = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(image)
    y0, y1 = y_range
    x0, x1 = x_range

    px = lambda v: PAD["l"] + (v - x0) / (x1 - x0) * (W - PAD["l"] - PAD["r"])
    py = lambda v: H - PAD["b"] - (v - y0) / (y1 - y0) * (H - PAD["t"] - PAD["b"])

    draw.text((PAD["l"], 30), title, font=F_TITLE, fill=INK)
    draw.text((PAD["l"], 66), subtitle, font=F_LABEL, fill=SOFT)

    for i in range(6):
        value = y0 + (y1 - y0) * i / 5
        y = py(value)
        draw.line([(PAD["l"], y), (W - PAD["r"], y)], fill=RULE)
        draw.text((PAD["l"] - 14, y - 9), y_format(value), font=F_TICK, fill=SOFT, anchor="ra")
    if zero_line and y0 < 0 < y1:
        draw.line([(PAD["l"], py(0)), (W - PAD["r"], py(0))], fill=SOFT, width=2)

    for i in range(6):
        value = x0 + (x1 - x0) * i / 5
        draw.text((px(value), H - PAD["b"] + 12), f"{value:.0f}", font=F_TICK, fill=SOFT, anchor="ma")

    draw.text((PAD["l"] + (W - PAD["l"] - PAD["r"]) / 2, H - PAD["b"] + 40), x_title,
              font=F_LABEL, fill=SOFT, anchor="ma")
    draw.text((26, PAD["t"] + (H - PAD["t"] - PAD["b"]) / 2), y_title,
              font=F_LABEL, fill=SOFT, anchor="mm")
    return image, draw, px, py


def dot(draw, cx, cy, colour, radius=7):
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
                 fill=colour, outline=BG, width=2)


def save(frames, out):
    # Bounce back rather than jumping, and hold long enough to read.
    sequence = frames + frames[-2:0:-1]
    sequence[0].save(out, save_all=True, append_images=sequence[1:],
                     duration=[1100] * len(sequence), loop=0, optimize=True)
    print(f"  {out.name}  {out.stat().st_size / 1024:.0f} KB")


def bar_frame(title, subtitle, labels, values, y_range, y_format, colours,
              refs=(), y_title="LTV:CAC"):
    """A column chart frame. The scatter helper cannot draw these, and the
    whole point of the LTV animation is that the axis never moves while the
    bars do."""
    image = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(image)
    y0, y1 = y_range
    left, right = PAD["l"], W - PAD["r"]
    py = lambda v: H - PAD["b"] - (v - y0) / (y1 - y0) * (H - PAD["t"] - PAD["b"])

    draw.text((left, 30), title, font=F_TITLE, fill=INK)
    draw.text((left, 66), subtitle, font=F_LABEL, fill=SOFT)

    for i in range(6):
        value = y0 + (y1 - y0) * i / 5
        y = py(value)
        draw.line([(left, y), (right, y)], fill=RULE)
        draw.text((left - 14, y - 9), y_format(value), font=F_TICK, fill=SOFT, anchor="ra")

    for value, label, colour in refs:
        if y0 <= value <= y1:
            y = py(value)
            for x in range(int(left), int(right), 12):
                draw.line([(x, y), (x + 6, y)], fill=colour, width=2)
            draw.text((right, y - 20), label, font=F_TICK, fill=colour, anchor="ra")

    band = (right - left) / max(len(values), 1)
    width = band * 0.68
    for i, v in enumerate(values):
        cx = left + band * (i + 0.5)
        if v is None:
            continue
        top = py(min(v, y1))
        draw.rectangle([cx - width / 2, top, cx + width / 2, py(0)], fill=colours[i])
        if v > y1:
            draw.polygon([(cx - 7, top + 1), (cx, top - 9), (cx + 7, top + 1)], fill=colours[i])
        if i % 3 == 0:
            draw.text((cx, H - PAD["b"] + 12), labels[i], font=F_TICK, fill=SOFT, anchor="ma")

    draw.text((26, PAD["t"] + (H - PAD["t"] - PAD["b"]) / 2), y_title,
              font=F_LABEL, fill=SOFT, anchor="mm")
    return image


def build_ltv_by_age():
    """LTV:CAC with every cohort cut at the same age, stepping the age.

    The static chart measures each cohort to today, so an old cohort has had
    two years to return its cost and a young one two months and the slope is
    mostly the calendar. Holding the axis still and stepping the age shows the
    part that is real: the bars rise together as cohorts mature, and the
    recent ones stay below the older ones at every age they can both reach.
    """
    rows = load("customer_waterfall.json")["rows"]
    cac = {r["month"]: number(r.get("cac_total_actual"))
           for r in load("cac_monthly.json")["rows"]}

    live = {"new", "reactivation", "flat", "expansion", "contraction"}
    first, months_of = {}, defaultdict(dict)
    for r in sorted(rows, key=lambda r: r["month"]):
        if r.get("event_type") not in live:
            continue
        cid, m = r["customer_id"], r["month"]
        first.setdefault(cid, m)
        months_of[cid][m] = r

    last = max(m for c in months_of.values() for m in c)
    window_start = min(first.values())

    cohorts = defaultdict(list)
    for cid, m in first.items():
        if m != window_start:
            cohorts[m].append(cid)

    MARGIN = 0.757
    def gp(r):
        return ((number(r.get("eop_mrr")) or 0) * MARGIN
                + (number(r.get("usage_revenue")) or 0) * 0.60
                + (number(r.get("onetime_revenue")) or 0) * 0.90)

    ordered = sorted(m for m in cohorts if cac.get(m))
    frames = []
    for age in range(1, 13):
        labels, values, colours = [], [], []
        for m in ordered:
            ids = cohorts[m]
            if month_add(m, age - 1) > last:
                continue
            cost = cac[m] / len(ids)
            total = sum(gp(months_of[cid][mm])
                        for cid in ids
                        for k in range(age)
                        if (mm := month_add(m, k)) in months_of[cid])
            ratio = total / len(ids) / cost
            labels.append(m[2:])
            values.append(ratio)
            colours.append(HIGH if ratio >= 1 else LOW)
        if len(values) < 3:
            continue
        frames.append(bar_frame(
            f"LTV:CAC by cohort, measured at month {age}",
            f"{len(values)} cohorts old enough to reach month {age}. "
            f"Same axis every frame, so the bars move and the scale does not.",
            labels, values, (0, 2.0), lambda v: f"{v:.1f}x", colours,
            refs=[(1.0, "1.0x break-even", SOFT)]))

    save(frames, OUT / "ltv_cac_by_age.gif")

def build():
    OUT.mkdir(parents=True, exist_ok=True)
    mrr, waterfall, last, eligible, anchor = read_months()

    # Same anchored window the interactive chart uses: every horizon is
    # measured from the same starting months, so moving through the horizons
    # changes the horizon and nothing else. Taking "the last 24 complete
    # windows" per horizon instead slides the period backwards as the horizon
    # grows, and the effect that appeared at one month turned out to be
    # carried by the recent thin-intake months only the short horizons saw.
    plain = []
    for horizon in HORIZONS:
        months = [m for m in eligible(horizon) if m in anchor]
        xs, whole = [], []
        for month in months:
            base = mrr[month]
            later = set(mrr[month_add(month, horizon)])
            xs.append(waterfall[month]["new_logos"])
            whole.append(1 - sum(1 for c in base if c in later) / len(base))
        plain.append({"h": horizon, "xs": xs, "ys": whole, "months": months,
                      "fit": fit(xs, whole)})

    y_pct = lambda v: f"{v * 100:.0f}%"
    span = lambda f: f"{f['months'][0]} to {f['months'][-1]}"

    frames = []
    for f in plain:
        r, est, ci = f["fit"]
        image, draw, px, py = frame(
            "Does churn rise when fewer customers arrive?",
            f"Churn measured over the following {f['h']} month{'' if f['h'] == 1 else 's'}"
            f"   ·   same {len(f['months'])} starting months, {span(f)}",
            (0, 0.35), y_pct)
        for x, y in zip(f["xs"], f["ys"]):
            dot(draw, px(x), py(y), HIGH)
        draw.text((PAD["l"], H - PAD["b"] + 82),
                  f"r = {r:+.2f}     {est:+.2f} points per 10 fewer arrivals"
                  f"     95% [{est - abs(ci):+.2f}, {est + abs(ci):+.2f}]",
                  font=F_LABEL, fill=SOFT)
        measurable = (est - abs(ci)) * (est + abs(ci)) > 0
        draw.text((W - PAD["r"], H - PAD["b"] + 56),
                  "measurable" if measurable else "indistinguishable from nothing",
                  font=F_BIG, fill=LOW if measurable else SOFT, anchor="ra")
        frames.append(image)
    save(frames, OUT / "arrivals_vs_churn.gif")

    build_ltv_by_age()

    print()
    print("  horizon   r        per 10 fewer     verdict")
    for f in plain:
        r, est, ci = f["fit"]
        verdict = "measurable" if (est - abs(ci)) * (est + abs(ci)) > 0 else "nothing"
        print(f"    {f['h']}mo     {r:+.2f}    {est:+6.2f} pts      {verdict}")


if __name__ == "__main__":
    build()
