// Hand-drawn SVG. No chart library.
//
// Every chart here needs something a general purpose library fights: blanks
// that stay blank rather than dropping to zero, reference lines at a chosen
// goal, a series that is the sum of two others and must not be drawn like
// them, and a redraw when an assumption changes. Writing the paths directly
// is less code than bending a library into that shape.

const NS = 'http://www.w3.org/2000/svg';

const W = 720;
const H = 300;
const PAD = { top: 18, right: 56, bottom: 34, left: 54 };

const plot = {
  x0: PAD.left,
  x1: W - PAD.right,
  y0: PAD.top,
  y1: H - PAD.bottom,
  get width() { return this.x1 - this.x0; },
  get height() { return this.y1 - this.y0; },
};

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

function linearScale(min, max) {
  const span = max - min || 1;
  return value => plot.y1 - ((value - min) / span) * plot.height;
}

function bandScale(count) {
  const step = plot.width / Math.max(count, 1);
  return {
    step,
    centre: i => plot.x0 + step * (i + 0.5),
    left: i => plot.x0 + step * i,
    width: Math.max(step * 0.68, 1),
  };
}

export const fmt = {
  int: v => v === null ? '--' : Math.round(v).toLocaleString(),
  money: v => v === null ? '--' : '$' + Math.round(v).toLocaleString(),
  money1: v => v === null ? '--' : '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
  pct: (v, digits = 0) => v === null ? '--' : (v * 100).toFixed(digits) + '%',
  ratio: v => v === null ? '--' : v.toFixed(2) + 'x',
  months: v => v === null ? 'not recovered' : v + (v === 1 ? ' month' : ' months'),
  monthLabel: m => {
    if (!m) return '';
    const [y, mm] = m.split('-');
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mm) - 1] + " '" + y.slice(2);
  },
};

function frame(svg, { yMin, yMax, ticks = 5, yFormat = fmt.int, zeroLine = false }) {
  const y = linearScale(yMin, yMax);

  for (let i = 0; i <= ticks; i += 1) {
    const value = yMin + ((yMax - yMin) * i) / ticks;
    const yy = y(value);
    el('line', {
      x1: plot.x0, x2: plot.x1, y1: yy, y2: yy,
      class: value === 0 && zeroLine ? 'grid grid-zero' : 'grid',
    }, svg);
    el('text', { x: plot.x0 - 8, y: yy + 4, class: 'tick tick-y' }, svg)
      .textContent = yFormat(value);
  }
  return y;
}

function xLabels(svg, labels, band, { every = null } = {}) {
  const stride = every || Math.max(1, Math.ceil(labels.length / 9));
  labels.forEach((label, i) => {
    if (i % stride !== 0 && i !== labels.length - 1) return;
    el('text', { x: band.centre(i), y: plot.y1 + 20, class: 'tick tick-x' }, svg)
      .textContent = label;
  });
}

function referenceLine(svg, y, value, label, variant = '') {
  const yy = y(value);
  el('line', { x1: plot.x0, x2: plot.x1, y1: yy, y2: yy, class: `ref ${variant}` }, svg);
  const text = el('text', { x: plot.x1 - 4, y: yy - 6, class: `ref-label ${variant}` }, svg);
  text.textContent = label;
}

// A path that breaks wherever a value is null, so a gap reads as a gap and
// never as a fall to zero.
function gappedPath(points, x, y) {
  let d = '';
  let open = false;
  points.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) { open = false; return; }
    d += `${open ? 'L' : 'M'}${x(i).toFixed(2)},${y(value).toFixed(2)}`;
    open = true;
  });
  return d;
}

function makeSvg(container) {
  container.innerHTML = '';
  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
  }, container);
  return svg;
}

// Shared hover behaviour: one invisible band per x position, which is far
// more forgiving on a phone than expecting a finger to find a line.
function attachHover(svg, container, band, count, describe) {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  container.appendChild(tip);

  const marker = el('line', { class: 'hover-marker', y1: plot.y0, y2: plot.y1, opacity: 0 }, svg);

  for (let i = 0; i < count; i += 1) {
    const hit = el('rect', {
      x: band.left(i), y: plot.y0, width: band.step, height: plot.height,
      fill: 'transparent', class: 'hit',
    }, svg);

    const show = () => {
      const html = describe(i);
      if (!html) return;
      tip.innerHTML = html;
      tip.hidden = false;
      marker.setAttribute('x1', band.centre(i));
      marker.setAttribute('x2', band.centre(i));
      marker.setAttribute('opacity', 1);
      const ratio = band.centre(i) / W;
      tip.style.left = `${ratio * 100}%`;
      tip.style.transform = `translateX(${ratio > 0.6 ? '-100%' : '0'})`;
    };
    const hide = () => { tip.hidden = true; marker.setAttribute('opacity', 0); };

    hit.addEventListener('mouseenter', show);
    hit.addEventListener('mousemove', show);
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('touchstart', show, { passive: true });
  }
}

function legend(container, items) {
  const wrap = document.createElement('div');
  wrap.className = 'legend';
  for (const item of items) {
    const key = document.createElement('span');
    key.className = 'legend-item';
    // A faint item marks a line drawn as a comparison rather than as a
    // measure in its own right, and its swatch says so.
    key.innerHTML = `<span class="swatch${item.faint ? ' swatch-faint' : ''}" `
      + `style="background:${item.colour}"></span>${item.label}`;
    if (item.faint) key.classList.add('legend-faint');
    wrap.appendChild(key);
  }
  container.appendChild(wrap);
}

const INK = {
  primary: 'var(--series-1)',
  secondary: 'var(--series-2)',
  tertiary: 'var(--series-3)',
  positive: 'var(--series-pos)',
  negative: 'var(--series-neg)',
  accent: 'var(--series-4)',
};

// A single line over months.
export function lineChart(container, { labels, values, yFormat = fmt.int, describe,
                                       colour = INK.primary, yMin = null, yMax = null,
                                       refs = [], area = false }) {
  const svg = makeSvg(container);
  const real = values.filter(v => v !== null && Number.isFinite(v));
  if (!real.length) { container.innerHTML = '<p class="empty">No data.</p>'; return; }

  const lo = yMin !== null ? yMin : Math.min(...real);
  const hi = yMax !== null ? yMax : niceCeil(Math.max(...real));
  const bottom = yMin !== null ? lo : Math.max(0, lo - (hi - lo) * 0.15);

  const y = frame(svg, { yMin: bottom, yMax: hi, yFormat });
  const band = bandScale(labels.length);
  const x = i => band.centre(i);

  for (const ref of refs) referenceLine(svg, y, ref.value, ref.label, ref.variant || '');

  if (area) {
    const d = gappedPath(values, x, y);
    if (d) {
      const firstIndex = values.findIndex(v => v !== null);
      const lastIndex = values.length - 1 - [...values].reverse().findIndex(v => v !== null);
      el('path', {
        d: `${d}L${x(lastIndex)},${plot.y1}L${x(firstIndex)},${plot.y1}Z`,
        class: 'area', fill: colour,
      }, svg);
    }
  }

  el('path', { d: gappedPath(values, x, y), class: 'line', stroke: colour }, svg);

  values.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) return;
    if (labels.length <= 40) {
      el('circle', { cx: x(i), cy: y(value), r: 2.5, class: 'dot', fill: colour }, svg);
    }
  });

  xLabels(svg, labels, band);
  attachHover(svg, container, band, labels.length, describe);
}

// Several lines sharing an axis.
export function multiLineChart(container, { labels, series, yFormat = fmt.int, describe,
                                            yMin = null, yMax = null, refs = [],
                                            showLegend = true, legendItems = null,
                                            xTitle = null }) {
  const svg = makeSvg(container);
  const all = series.flatMap(s => s.values).filter(v => v !== null && Number.isFinite(v));
  if (!all.length) { container.innerHTML = '<p class="empty">Not enough data yet.</p>'; return; }

  const lo = yMin !== null ? yMin : Math.min(...all, 0);
  const hi = yMax !== null ? yMax : niceCeil(Math.max(...all));
  const y = frame(svg, { yMin: lo, yMax: hi, yFormat });
  const band = bandScale(labels.length);
  const x = i => band.centre(i);

  for (const ref of refs) referenceLine(svg, y, ref.value, ref.label, ref.variant || '');

  for (const s of series) {
    el('path', {
      d: gappedPath(s.values, x, y),
      class: `line ${s.dashed ? 'line-dashed' : ''} ${s.thin ? 'line-thin' : ''}`,
      stroke: s.colour,
    }, svg);
    if (s.thin) continue;
    if (labels.length <= 40) {
      s.values.forEach((value, i) => {
        if (value === null || !Number.isFinite(value)) return;
        el('circle', { cx: x(i), cy: y(value), r: 2.5, class: 'dot', fill: s.colour }, svg);
      });
    }
  }

  xLabels(svg, labels, band);
  if (xTitle) {
    el('text', { x: plot.x0 + plot.width / 2, y: H - 2, class: 'axis-title' }, svg)
      .textContent = xTitle;
  }
  attachHover(svg, container, band, labels.length, describe);
  // A chart drawing dozens of faint lines needs a legend that names what they
  // are, not one entry per line.
  if (legendItems) legend(container, legendItems);
  else if (showLegend) legend(container, series.map(s => ({ label: s.label, colour: s.colour })));
}

// Columns, optionally with reference lines. Nulls leave a gap rather than a
// zero-height bar sitting on the axis.
export function columnChart(container, { labels, values, yFormat = fmt.int, describe,
                                         colour = INK.primary, refs = [], yMax = null,
                                         colourFor = null, legendItems = null }) {
  const svg = makeSvg(container);
  const real = values.filter(v => v !== null && Number.isFinite(v));
  if (!real.length) { container.innerHTML = '<p class="empty">Not enough data yet.</p>'; return; }

  const hi = yMax !== null ? yMax : niceCeil(Math.max(...real, ...refs.map(r => r.value)));
  const lo = Math.min(0, ...real);
  const y = frame(svg, { yMin: lo, yMax: hi, yFormat, zeroLine: lo < 0 });
  const band = bandScale(labels.length);

  values.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) return;

    // A value past the top is drawn to the ceiling and marked, rather than
    // being allowed to rescale the axis. One bar at sixty months would push
    // every real one into the bottom sixth of the chart and make the part
    // anybody cares about unreadable.
    const clipped = value > hi;
    const drawn = clipped ? hi : value;
    const top = Math.min(y(drawn), y(0));

    el('rect', {
      x: band.centre(i) - band.width / 2,
      y: top,
      width: band.width,
      height: Math.max(Math.abs(y(drawn) - y(0)), 1),
      class: 'bar',
      fill: colourFor ? colourFor(value, i) : colour,
    }, svg);

    if (clipped) {
      const cx = band.centre(i);
      const w = Math.min(band.width / 2, 7);
      el('path', {
        d: `M${cx - w},${top + 1}L${cx},${top - 6}L${cx + w},${top + 1}Z`,
        class: 'clip-marker',
        fill: colourFor ? colourFor(value, i) : colour,
      }, svg);
    }
  });

  for (const ref of refs) referenceLine(svg, y, ref.value, ref.label, ref.variant || '');

  xLabels(svg, labels, band);
  attachHover(svg, container, band, labels.length, describe);
  if (legendItems) legend(container, legendItems);
}

// One diagonal hatch per colour, built on demand. Keyed by the colour itself
// so three semantic colours produce three patterns rather than one per bar.
function hatchPattern(svg, colour) {
  const key = colour.replace(/[^a-z0-9]+/gi, '-');
  const id = `hatch-${key}`;
  if (svg.querySelector(`#${id}`)) return id;
  let defs = svg.querySelector('defs');
  if (!defs) defs = el('defs', {}, svg);
  const pattern = el('pattern', {
    id, width: 7, height: 7, patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)',
  }, defs);
  el('rect', { width: 7, height: 7, fill: colour, opacity: 0.18 }, pattern);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: colour, 'stroke-width': 2.4 }, pattern);
  return id;
}

// A column in two parts: what a cohort has actually returned by a given age,
// and what the donor trajectory says it will have returned by then.
//
// One hue per column, because the verdict is about the whole column. Two
// textures, because a reader must never be able to mistake the projected part
// for evidence. Solid is observed, hatched is projected, and a hairline marks
// the seam so where the evidence stops is never a matter of judging a shade.
export function stackedColumnChart(container, { labels, observed, projected,
                                                yFormat = fmt.int, describe, colourFor,
                                                colour = INK.primary, refs = [], yMax = null,
                                                legendItems = null, columnLabels = null,
                                                columnLabelTitle = null }) {
  const svg = makeSvg(container);
  const totals = labels.map((_, i) => {
    const seen = observed[i];
    if (seen === null || !Number.isFinite(seen)) return null;
    const ahead = projected[i];
    return seen + (Number.isFinite(ahead) ? ahead : 0);
  });
  const real = totals.filter(v => v !== null && Number.isFinite(v));
  if (!real.length) { container.innerHTML = '<p class="empty">Not enough data yet.</p>'; return; }

  const hi = yMax !== null ? yMax : niceCeil(Math.max(...real, ...refs.map(r => r.value)));
  const y = frame(svg, { yMin: 0, yMax: hi, yFormat });
  const band = bandScale(labels.length);
  const base = y(0);

  totals.forEach((total, i) => {
    if (total === null) return;
    const paint = colourFor ? colourFor(total, i) : colour;
    const x = band.centre(i) - band.width / 2;
    const seen = Math.max(0, Math.min(observed[i], hi));

    el('rect', {
      x, y: y(seen), width: band.width,
      height: Math.max(base - y(seen), 1),
      class: 'bar', fill: paint,
    }, svg);

    // Clipped at the ceiling rather than rescaling the axis, the same rule
    // the plain column chart uses.
    const top = Math.min(total, hi);
    if (top > seen) {
      el('rect', {
        x, y: y(top), width: band.width,
        height: Math.max(y(seen) - y(top), 1),
        class: 'bar bar-projected', fill: `url(#${hatchPattern(svg, paint)})`,
      }, svg);
      el('line', {
        x1: x, y1: y(seen), x2: x + band.width, y2: y(seen),
        class: 'seam', stroke: paint, 'stroke-width': 1.5,
      }, svg);
    }
  });

  for (const ref of refs) referenceLine(svg, y, ref.value, ref.label, ref.variant || '');

  // A second number per column, printed along the top rather than given its
  // own axis. It answers a different question from the bar height and has a
  // different unit, so drawing it as a line would invite reading the two
  // against each other. Dropped entirely once the columns are too narrow to
  // carry a legible label.
  if (columnLabels && band.width >= 13) {
    if (columnLabelTitle) {
      el('text', { x: plot.x0, y: plot.y0 - 6, class: 'column-label-title' }, svg)
        .textContent = columnLabelTitle;
    }
    columnLabels.forEach((text, i) => {
      if (text === null || text === undefined || text === '') return;
      el('text', {
        x: band.centre(i), y: plot.y0 + 8,
        class: 'column-label' + (String(text).endsWith('+') ? ' column-label-over' : ''),
      }, svg).textContent = text;
    });
  }

  xLabels(svg, labels, band);
  attachHover(svg, container, band, labels.length, describe);
  if (legendItems) legend(container, legendItems);
}

// New and reactivated stack upward, churned is drawn downward, and net is a
// line on its own axis. Net is the sum of the other two, so drawing it as a
// third column would read as a third independent quantity.
export function flowChart(container, { labels, added, reactivated, churned, net, describe }) {
  const svg = makeSvg(container);
  const upper = added.map((v, i) => (v || 0) + (reactivated[i] || 0));
  const extent = niceCeil(Math.max(
    Math.max(...upper, 1),
    Math.max(...churned.map(v => Math.abs(v || 0)), 1),
  ));
  const hi = extent;
  const lo = -extent;

  // Tick the two halves separately so a tick lands exactly on zero. With a
  // single run of ticks across an asymmetric domain, zero falls between two
  // of them and the baseline the columns diverge about is never drawn.
  const steps = 3;
  const y = frame(svg, {
    yMin: lo, yMax: hi, ticks: steps * 2,
    yFormat: v => Math.abs(Math.round(v)).toLocaleString(),
    zeroLine: true,
  });
  const band = bandScale(labels.length);

  // Draw the baseline explicitly rather than relying on a tick landing there.
  el('line', { x1: plot.x0, x2: plot.x1, y1: y(0), y2: y(0), class: 'grid grid-zero' }, svg);

  labels.forEach((_, i) => {
    const a = added[i] || 0;
    const r = reactivated[i] || 0;
    const c = Math.abs(churned[i] || 0);
    const x = band.centre(i) - band.width / 2;

    if (a) el('rect', { x, y: y(a), width: band.width, height: y(0) - y(a),
                        class: 'bar', fill: INK.positive }, svg);
    if (r) el('rect', { x, y: y(a + r), width: band.width, height: y(a) - y(a + r),
                        class: 'bar', fill: INK.tertiary }, svg);
    if (c) el('rect', { x, y: y(0), width: band.width, height: y(-c) - y(0),
                        class: 'bar', fill: INK.negative }, svg);
  });

  const netValues = net.map(v => (v === null ? null : v));
  el('path', { d: gappedPath(netValues, i => band.centre(i), y), class: 'line line-net' }, svg);

  xLabels(svg, labels, band);
  attachHover(svg, container, band, labels.length, describe);
  legend(container, [
    { label: 'New', colour: INK.positive },
    { label: 'Reactivated', colour: INK.tertiary },
    { label: 'Churned', colour: INK.negative },
    { label: 'Net change', colour: 'var(--ink)' },
  ]);
}


// Two series on their own scales, left and right.
//
// A dual axis is normally a way to manufacture a crossing that means nothing,
// because the two scales can be slid until the lines touch wherever you like.
// It earns its place here only because the question is literally "what
// happened to these two quantities at once" and both are wanted in their real
// units rather than indexed. Each axis is coloured to its series so there is
// no guessing which belongs to which, and neither is zero-suppressed.
export function dualAxisChart(container, { labels, left, right, describe, refs = [] }) {
  const svg = makeSvg(container);
  const realLeft = left.values.filter(v => v !== null && Number.isFinite(v));
  const realRight = right.values.filter(v => v !== null && Number.isFinite(v));
  if (!realLeft.length || !realRight.length) {
    container.innerHTML = '<p class="empty">Not enough data yet.</p>';
    return;
  }

  const leftMax = niceCeil(Math.max(...realLeft));
  const rightMax = niceCeil(Math.max(...realRight));
  const ticks = 5;

  for (let i = 0; i <= ticks; i += 1) {
    const yy = plot.y1 - (plot.height * i) / ticks;
    el('line', { x1: plot.x0, x2: plot.x1, y1: yy, y2: yy, class: 'grid' }, svg);
    el('text', { x: plot.x0 - 8, y: yy + 4, class: 'tick tick-y', fill: left.colour }, svg)
      .textContent = left.format((leftMax * i) / ticks);
    el('text', { x: plot.x1 + 8, y: yy + 4, class: 'tick tick-y-right', fill: right.colour }, svg)
      .textContent = right.format((rightMax * i) / ticks);
  }

  const band = bandScale(labels.length);
  const x = i => band.centre(i);
  const yLeft = v => plot.y1 - (v / leftMax) * plot.height;
  const yRight = v => plot.y1 - (v / rightMax) * plot.height;

  for (const ref of refs) referenceLine(svg, yLeft, ref.value, ref.label, ref.variant || '');

  // A faint companion line on the same scale as its series, for showing a
  // measure against the one it replaced without a third axis.
  for (const [series, scale] of [[left, yLeft], [right, yRight]]) {
    if (series.shadow) {
      el('path', {
        d: gappedPath(series.shadow.values, x, scale),
        class: 'line line-shadow',
        stroke: series.colour,
        'stroke-opacity': 0.34,
        'stroke-dasharray': '3 3',
      }, svg);
    }
  }

  for (const [series, scale] of [[left, yLeft], [right, yRight]]) {
    el('path', {
      d: gappedPath(series.values, x, scale),
      class: `line ${series.dashed ? 'line-dashed' : ''}`,
      stroke: series.colour,
    }, svg);
    series.values.forEach((value, i) => {
      if (value === null || !Number.isFinite(value)) return;
      el('circle', { cx: x(i), cy: scale(value), r: 2.5, class: 'dot', fill: series.colour }, svg);
    });
  }

  xLabels(svg, labels, band);
  attachHover(svg, container, band, labels.length, describe);
  const items = [
    { label: `${left.label} (left)`, colour: left.colour },
    { label: `${right.label} (right)`, colour: right.colour },
  ];
  for (const series of [left, right]) {
    if (series.shadow) items.push({ label: series.shadow.label, colour: series.colour, faint: true });
  }
  legend(container, items);
}

// One point per cohort with a horizontal mean for each series.
export function scatterOverTime(container, { labels, series, describe, yFormat = fmt.pct }) {
  const svg = makeSvg(container);
  const all = series.flatMap(s => s.values).filter(v => v !== null && Number.isFinite(v));
  if (!all.length) { container.innerHTML = '<p class="empty">Not enough data yet.</p>'; return; }

  const y = frame(svg, { yMin: 0, yMax: Math.min(1, niceCeil(Math.max(...all))), yFormat });
  const band = bandScale(labels.length);

  for (const s of series) {
    if (s.mean !== null && s.mean !== undefined) {
      el('line', {
        x1: plot.x0, x2: plot.x1, y1: y(s.mean), y2: y(s.mean),
        class: 'ref ref-mean', stroke: s.colour,
      }, svg);
      el('text', { x: plot.x0 + 4, y: y(s.mean) - 5, class: 'ref-label', fill: s.colour }, svg)
        .textContent = `${s.label} mean ${fmt.pct(s.mean)}`;
    }
    s.values.forEach((value, i) => {
      if (value === null || !Number.isFinite(value)) return;
      el('circle', { cx: band.centre(i), cy: y(value), r: 3.2, class: 'dot', fill: s.colour }, svg);
    });
  }

  xLabels(svg, labels, band);
  attachHover(svg, container, band, labels.length, describe);
  legend(container, series.map(s => ({ label: s.label, colour: s.colour })));
}

// A true scatter with a numeric x axis, for asking whether two monthly
// quantities move together.
export function scatterXY(container, { points, xLabel, yLabel,
                                       xFormat = fmt.int, yFormat = fmt.pct,
                                       colour = INK.primary, describe,
                                       xMax = null, yMax = null }) {
  const svg = makeSvg(container);
  if (!points.length) { container.innerHTML = '<p class="empty">Not enough data yet.</p>'; return; }

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const xLo = 0;
  // Bounds can be pinned by the caller. A scatter that is stepped through a
  // series of settings has to keep the same axes at every step, or the cloud
  // appears to stay where it is while the numbers underneath it change, which
  // is the opposite of what the sequence is for.
  const xHi = xMax !== null ? xMax : niceCeil(Math.max(...xs));
  const yLo = 0;
  const yHi = yMax !== null ? yMax : niceCeil(Math.max(...ys));

  const y = frame(svg, { yMin: yLo, yMax: yHi, yFormat });
  const x = v => plot.x0 + ((v - xLo) / (xHi - xLo || 1)) * plot.width;

  for (let i = 0; i <= 5; i += 1) {
    const value = xLo + ((xHi - xLo) * i) / 5;
    el('text', { x: x(value), y: plot.y1 + 20, class: 'tick tick-x' }, svg)
      .textContent = xFormat(value);
  }

  el('text', { x: plot.x0 + plot.width / 2, y: H - 2, class: 'axis-title' }, svg)
    .textContent = xLabel;

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  container.appendChild(tip);

  points.forEach((point, i) => {
    const dot = el('circle', {
      cx: x(point.x), cy: y(point.y), r: 4.5, class: 'dot dot-hit', fill: colour,
    }, svg);
    const show = () => {
      tip.innerHTML = describe(i);
      tip.hidden = false;
      const ratio = x(point.x) / W;
      tip.style.left = `${ratio * 100}%`;
      tip.style.top = `${(y(point.y) / H) * 100}%`;
      tip.style.transform = `translate(${ratio > 0.6 ? '-100%' : '0'}, -110%)`;
    };
    dot.addEventListener('mouseenter', show);
    dot.addEventListener('touchstart', show, { passive: true });
    dot.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}

export { INK };
