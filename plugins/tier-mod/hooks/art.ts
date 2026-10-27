// tier-mod: the Strata look (slate palette), as SVG strings for the desktop's Svg element. Pure: no `$`.
// Reproduces the approved reference page (tier-strata-final.html, #slate): the mark, the stack glyphs, the
// cache ring, the refusal tiles, the strata chart, the ladder.

/** Slate: T1..T4 ramp (haiku..fable), saved, warning, fault, surfaces and inks. */
export const C = {
  t1: '#cfd9e5',
  t2: '#94aac3',
  t3: '#617c9c',
  t4: '#45607f',
  saved: '#e3b968',
  warn: '#f0a35e',
  fault: '#ee7f68',
  off: '#3a3f46',
  s1: '#1f2124',
  s2: '#26292d',
  line: '#33373d',
  hl: '#2a2e33',
  sb: '#2c3036',
  rb: '#3a4757',
  ink: '#e8ebef',
  mut: '#8b919a',
  dim: '#6b7179',
  on: '#111820',
  failBg: '#2a2d31',
  errb: '#6b3a31',
} as const

export type Layer = 1 | 2 | 3 | 4
export const LAYER_NAMES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type LayerName = (typeof LAYER_NAMES)[number]

/** T1 haiku (the wide pale base) .. T4 fable (the narrow deep top). */
export function layerOf(family: string | null | undefined): Layer | null {
  return family === 'haiku' ? 1 : family === 'sonnet' ? 2 : family === 'opus' ? 3 : family === 'fable' ? 4 : null
}

export function rampColor(layer: Layer): string {
  return layer === 1 ? C.t1 : layer === 2 ? C.t2 : layer === 3 ? C.t3 : C.t4
}

const svg = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

/** The mark: four stepped bars, wide pale base to narrow deep top. */
export function markSvg(size = 16): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">` +
    `<rect x="6" y="0" width="4" height="3" fill="${C.t4}"/><rect x="4" y="4" width="8" height="3" fill="${C.t3}"/>` +
    `<rect x="2" y="8" width="12" height="3" fill="${C.t2}"/><rect x="0" y="12" width="16" height="3" fill="${C.t1}"/></svg>`
  )
}

/** The 12px stack glyph; `fill[layer]` colours each bar (absent: off). */
export function stackSvg(fill: Partial<Record<Layer, string>>): string {
  const bar = (l: Layer, x: number, y: number, w: number) => `<rect x="${x}" y="${y}" width="${w}" height="2" fill="${fill[l] ?? C.off}"/>`
  return svg(12, 12, bar(4, 4, 0, 4) + bar(3, 3, 3, 6) + bar(2, 2, 6, 8) + bar(1, 1, 9, 10))
}

/** A run's glyph: its layer lit (in the fault colour when it failed). */
export function runStack(layer: Layer | null, failed = false): string {
  if (layer === null) return stackSvg({})
  return stackSvg({ [layer]: failed ? C.fault : rampColor(layer) })
}

/** The quiet hand-off line's glyph: the stack dark with a stop bar over it. */
export function stopStack(): string {
  return svg(
    12,
    12,
    `<rect x="4" y="3" width="4" height="2" fill="${C.off}"/><rect x="3" y="6" width="6" height="2" fill="${C.off}"/>` +
      `<rect x="1" y="9" width="10" height="2" fill="${C.off}"/><path d="M2 1.25H10" stroke="${C.ink}" stroke-width="1.25"/>`,
  )
}

/** 12px icons of the page: ok (check), up (escalated), arrow (open). */
export function iconSvg(name: 'ok' | 'up' | 'ar' | 'x', color: string): string {
  const d = name === 'ok' ? 'M2.5 6.5L5 9l4.5-5.5' : name === 'up' ? 'M6 10.5V2M3 5l3-3 3 3' : name === 'ar' ? 'M2 6h8M7 3l3 3-3 3' : 'M3 3l6 6M9 3l-6 6'
  return svg(12, 12, `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>`)
}

export type RingState = 'warm' | 'low' | 'cold'

/** The cache state for the ring: low = the last sixth of the TTL (10 minutes of the hour). */
export function ringState(msLeft: number, ttlMs: number, phase: 'none' | 'warm' | 'cooling' | 'cold'): RingState {
  if (phase === 'cold' || msLeft <= 0) return 'cold'
  return msLeft <= ttlMs / 6 ? 'low' : 'warm'
}

/**
 * The cache ring: the arc (T2) gives back clockwise from 12 over the TTL on a track in the line colour; low in the
 * warning colour; cold a dotted track only. From 28px it carries the minutes inside.
 */
export function ringSvg(size: number, minutesLeft: number, ttlMinutes: number, state: RingState): string {
  const s = size
  // From 24px the arc is at least 3 wide and sits on a track of the same width in the line colour: a ring that
  // reads at a glance (0.12.0's 1px grey track and 2px arc looked empty live).
  const w = s < 16 ? 1.5 : s < 24 ? 2 : 3
  const c = s / 2
  const r = c - w / 2
  const col = state === 'low' ? C.warn : C.t2
  const m = Math.max(0, Math.min(ttlMinutes, minutesLeft))
  const track =
    state === 'cold'
      ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${C.mut}" stroke-width="1" stroke-dasharray="1 ${s < 16 ? 2 : 3}"/>`
      : `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${C.line}" stroke-width="${w}"/>`
  const arc =
    state === 'cold'
      ? ''
      : `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="${w}" pathLength="${ttlMinutes}" stroke-dasharray="${m} ${ttlMinutes}" stroke-dashoffset="${m - ttlMinutes}" transform="rotate(-90 ${c} ${c})"/>`
  const fill = state === 'cold' ? C.mut : state === 'low' ? C.warn : C.ink
  const txt =
    s >= 28 ? `<text x="${c}" y="${c + 4}" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="${fill}">${state === 'cold' ? '–' : Math.round(m)}</text>` : ''
  return svg(s, s, track + arc + txt)
}

/**
 * The refusal card's 44px tile.
 * - down: an arrow from a hollow dot above the stack into T1, lit (work handed down);
 * - held: the top layer dashed (held back), opus lit.
 */
export function refusalTile(kind: 'down' | 'held'): string {
  const bg = `<rect x="0" y="0" width="44" height="44" rx="8" fill="${C.s1}"/>`
  if (kind === 'down') {
    return svg(
      44,
      44,
      bg +
        `<rect x="16" y="12" width="12" height="5" rx="1" fill="${C.off}"/><rect x="12" y="19" width="20" height="5" rx="1" fill="${C.off}"/>` +
        `<rect x="8" y="26" width="28" height="5" rx="1" fill="${C.off}"/><rect x="4" y="33" width="36" height="5" rx="1" fill="${C.t1}"/>` +
        `<circle cx="38" cy="5" r="2" fill="none" stroke="${C.ink}"/><path d="M38 8.5V32M35.5 29.5L38 32l2.5-2.5" fill="none" stroke="${C.ink}" stroke-width="1.25"/>`,
    )
  }
  return svg(
    44,
    44,
    bg +
      `<rect x="16.5" y="12.5" width="11" height="4" rx="1" fill="none" stroke="${C.t2}" stroke-dasharray="2 1.5"/>` +
      `<rect x="12" y="19" width="20" height="5" rx="1" fill="${C.t3}"/><rect x="8" y="26" width="28" height="5" rx="1" fill="${C.off}"/>` +
      `<rect x="4" y="33" width="36" height="5" rx="1" fill="${C.off}"/>`,
  )
}

/** A 1px hairline (section rules). */
export function hairSvg(width: number, color: string): string {
  return svg(width, 1, `<rect x="0" y="0" width="${width}" height="1" fill="${color}"/>`)
}

/** The page's 28 x 16 switch (`.sw2`): on = T3 track, knob right; off = the off track, knob left. */
export function switchSvg(on: boolean): string {
  return svg(28, 16, `<rect x="0" y="0" width="28" height="16" rx="8" fill="${on ? C.t3 : C.off}"/><circle cx="${on ? 20 : 8}" cy="8" r="6" fill="${on ? C.ink : C.mut}"/>`)
}

/** A 10px colour swatch (the layer table). */
export function swatchSvg(color: string): string {
  return svg(10, 10, `<rect x="0" y="0" width="10" height="10" rx="2" fill="${color}"/>`)
}

export type StrataPoint = { label: string; byLayer: Record<Layer, number> }

const escapeXml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The strata chart (420 x 120): cumulative spend by layer, stacked haiku (bottom) .. fable (top), one point per
 * bucket; axis labels under it, "$x by now" over it. Empty points draw the baseline alone.
 */
export function strataSvg(points: readonly StrataPoint[], totalLabel: string, width = 420, height = 120): string {
  const base = 100
  const top = 18
  const n = points.length
  const xs = n <= 1 ? [0, width] : points.map((_, i) => (i * width) / (n - 1))
  const pts = n <= 1 ? [points[0] ?? { label: '', byLayer: { 1: 0, 2: 0, 3: 0, 4: 0 } }, points[0] ?? { label: '', byLayer: { 1: 0, 2: 0, 3: 0, 4: 0 } }] : points
  const total = (p: StrataPoint) => p.byLayer[1] + p.byLayer[2] + p.byLayer[3] + p.byLayer[4]
  const max = Math.max(0, ...pts.map(total))
  const y = (v: number) => (max > 0 ? base - (v / max) * (base - top) : base)
  let body = `<line x1="0" y1="${top + 0.5}" x2="${width}" y2="${top + 0.5}" stroke="${C.hl}" stroke-dasharray="2 4"/>`
  // Paint the tallest stack first: fable+opus+sonnet+haiku, then without fable, ... haiku alone.
  for (const upTo of [4, 3, 2, 1] as Layer[]) {
    const sum = (p: StrataPoint) => {
      let v = 0
      for (let l = 1; l <= upTo; l++) v += p.byLayer[l as Layer]
      return v
    }
    // A layer with no spend draws no stratum of its own (its band would repeat the one below).
    if (max === 0 || pts.every(p => p.byLayer[upTo] === 0)) continue
    const line = pts.map((p, i) => `${(xs[i] ?? 0).toFixed(1)},${y(sum(p)).toFixed(2)}`).join(' ')
    body += `<polygon points="0,${base} ${line} ${width},${base} 0,${base}" fill="${rampColor(upTo)}" stroke="${C.s1}"/>`
  }
  body += `<line x1="0" y1="${base + 0.5}" x2="${width}" y2="${base + 0.5}" stroke="${C.off}"/>`
  const labels: string[] = []
  const step = Math.max(1, Math.ceil(n / 5))
  points.forEach((p, i) => {
    // Thinned to about five labels; the last always shows, and a thinned one too close to it gives way.
    if (i !== n - 1 && (i % step !== 0 || n - 1 - i < step / 2)) return
    const x = Math.min(width - 14, xs[i] ?? 0)
    labels.push(`<text x="${x.toFixed(0)}" y="116">${escapeXml(p.label)}</text>`)
  })
  body += `<g fill="${C.mut}" font-size="11" font-family="system-ui,sans-serif">${labels.join('')}<text x="0" y="12">${escapeXml(totalLabel)}</text></g>`
  return svg(width, height, body)
}

export type Rung = { label: string; kind: 'failed' | 'now' | 'next' | 'ceiling' }

/**
 * The ladder (top to bottom: ceiling, next, now, failed): failed rungs struck in the fault colour, the current
 * filled T2, the next outlined, the ceiling dashed. Rows narrow as they climb.
 */
export function ladderSvg(rungs: readonly Rung[], width = 420): string {
  const order: Rung['kind'][] = ['ceiling', 'next', 'now', 'failed']
  const rows = [...rungs].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  const rowH = 28
  const gap = 2
  const h = rows.length * (rowH + gap)
  let body = ''
  rows.forEach((r, i) => {
    const frac = 1 - (rows.length - 1 - i) * 0.12
    const w = Math.max(120, width * frac)
    const y0 = i * (rowH + gap)
    const ty = y0 + 18
    const text = (x: number, t: string, fill: string, anchor = 'start', strike = false) =>
      `<text x="${x}" y="${ty}" text-anchor="${anchor}" font-size="12" font-family="system-ui,sans-serif" fill="${fill}"${strike ? ` text-decoration="line-through"` : ''}>${escapeXml(t)}</text>`
    if (r.kind === 'ceiling') {
      body += `<rect x="0.5" y="${y0 + 0.5}" width="${w - 1}" height="${rowH - 1}" rx="3" fill="none" stroke="${C.off}" stroke-dasharray="3 2"/>`
      body += text(10, r.label, C.mut) + text(w - 10, 'ceiling', C.mut, 'end')
    } else if (r.kind === 'next') {
      body += `<rect x="0.5" y="${y0 + 0.5}" width="${w - 1}" height="${rowH - 1}" rx="3" fill="none" stroke="${C.t3}"/>`
      body += text(10, r.label, C.ink) + text(w - 10, 'next', C.mut, 'end')
    } else if (r.kind === 'now') {
      body += `<rect x="0" y="${y0}" width="${w}" height="${rowH}" rx="3" fill="${C.t2}"/>`
      body += text(10, r.label, C.on) + text(w - 10, 'now', C.on, 'end')
    } else {
      body += `<rect x="0" y="${y0}" width="${w}" height="${rowH}" rx="3" fill="${C.failBg}"/>`
      body += text(10, r.label, C.mut, 'start', true)
      body += `<line x1="10" y1="${ty - 4}" x2="${10 + r.label.length * 6.2}" y2="${ty - 4}" stroke="${C.fault}"/>`
      body += text(w - 10, 'failed', C.fault, 'end')
    }
  })
  return svg(width, Math.max(h, 1), body)
}

// ---------------------------------------------------------------- the hover strip (tier-hover-strip.html)

/** The strip's spend bar: no layer that spent narrower than this; this gap between layers. */
export const BAR_MIN_PX = 4
export const BAR_GAP_PX = 2

/**
 * The px width of each amount in a stacked bar `width` wide: proportional to the amount, every amount above zero
 * at least BAR_MIN_PX (the others share what is left), BAR_GAP_PX between drawn parts; zero for an amount <= 0.
 */
export function barWidths(width: number, amounts: readonly number[]): number[] {
  const live = amounts.map((a, i) => (a > 0 ? i : -1)).filter(i => i >= 0)
  const out = amounts.map(() => 0)
  if (live.length === 0) return out
  const avail = Math.max(0, width - BAR_GAP_PX * (live.length - 1))
  const floored = new Set<number>()
  for (;;) {
    const rest = avail - BAR_MIN_PX * floored.size
    const free = live.filter(i => !floored.has(i))
    const sum = free.reduce((a, i) => a + (amounts[i] ?? 0), 0)
    let changed = false
    for (const i of free) {
      const w = sum > 0 ? ((amounts[i] ?? 0) / sum) * rest : 0
      if (w < BAR_MIN_PX) {
        floored.add(i)
        changed = true
      } else out[i] = w
    }
    if (!changed || floored.size === live.length) break
  }
  for (const i of floored) out[i] = BAR_MIN_PX
  return out
}

/**
 * The strip's ONE stacked bar of spend by layer (268 x 8 on the page): rounded ends, the deepest layer that spent
 * at the left (T4 .. T1, as the page), 2px gaps, every layer that spent at least 4px; an empty track when none.
 */
export function stackBarSvg(width: number, height: number, byLayer: Readonly<Record<Layer, number>>): string {
  const order: Layer[] = [4, 3, 2, 1]
  const ws = barWidths(width, order.map(l => byLayer[l]))
  const r = height / 2
  if (ws.every(w => w === 0)) return svg(width, height, `<rect x="0" y="0" width="${width}" height="${height}" rx="${r}" fill="${C.line}"/>`)
  let body = `<clipPath id="tier-sb"><rect x="0" y="0" width="${width}" height="${height}" rx="${r}"/></clipPath><g clip-path="url(#tier-sb)">`
  let x = 0
  order.forEach((l, i) => {
    const w = ws[i] ?? 0
    if (w <= 0) return
    body += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" fill="${rampColor(l)}"/>`
    x += w + BAR_GAP_PX
  })
  return svg(width, height, body + '</g>')
}

/**
 * The strip's 30px cache ring: a track in the line colour, the arc (T2; the warning colour in the last sixth)
 * stroke 3 clockwise from 12 for the minutes left, the minutes (`59m`) small inside. Cold (or no turn yet): a dotted
 * ring, no arc, no minutes.
 */
export function stripRingSvg(minutesLeft: number, ttlMinutes: number, state: RingState | 'none'): string {
  const s = 30
  const c = 15
  const r = 13.5
  if (state === 'cold' || state === 'none') {
    return svg(s, s, `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${C.mut}" stroke-width="1.5" pathLength="60" stroke-dasharray="0.01 2" stroke-linecap="round"/>`)
  }
  const m = Math.max(0, Math.min(ttlMinutes, Math.round(minutesLeft)))
  const col = state === 'low' ? C.warn : C.t2
  return svg(
    s,
    s,
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${C.line}" stroke-width="3"/>` +
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="3" pathLength="${ttlMinutes}" stroke-dasharray="${m} ${ttlMinutes}" transform="rotate(-90 ${c} ${c})"/>` +
      `<text x="${c}" y="${c + 3.5}" text-anchor="middle" font-size="10" font-family="system-ui,sans-serif" fill="${C.ink}">${m}m</text>`,
  )
}

/** The strip's 28 x 16 switch: off = a hairline track and a dim knob left; on = a T3 track, the knob right. */
export function stripSwitchSvg(on: boolean): string {
  const track = on
    ? `<rect x="0" y="0" width="28" height="16" rx="8" fill="${C.t3}"/>`
    : `<rect x="0.5" y="0.5" width="27" height="15" rx="7.5" fill="none" stroke="${C.line}"/>`
  return svg(28, 16, track + `<circle cx="${on ? 21 : 7}" cy="8" r="5" fill="${on ? C.ink : C.dim}"/>`)
}

/** A 1px vertical hairline (the strip's section dividers), `height` px tall. */
export function vruleSvg(height: number): string {
  return svg(1, height, `<rect x="0" y="0" width="1" height="${height}" fill="${C.line}"/>`)
}
