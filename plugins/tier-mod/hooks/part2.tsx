// tier-mod, part 2: the cache meter (spec 5) and the screen (the Strata design, slate; tier-v1-ui-brief.md).
// The core (register.tsx) owns the atoms this file reads (types/index.d.ts, keys in state.ts).
// The screen, desktop = the full design, other surfaces = the text fallback:
//   1. the footer pill (SessionMode)                     terminal: the status line
//   2. the hover strip (AbovePrompt, revealed by the pill's hover scope; desktop only)
//   3. the hand-off strip under each Agent row (ToolUse) terminal: one text line
//   4. the refusal card / quiet line (ToolResult)        other surfaces: the engine's error text
//   5. the side pane `tier` (Now | Today | 7 days)        other surfaces: the same sections as text rows
// plus toasts and /tier-pane. The two override Buttons call override.ts (the person's presses only).
import { update } from 'claude-code'
import type { BoxProps, ButtonProps, ElementConstructor, EngineInterface, On, SvgProps, TextProps, Timer } from 'claude-code'

import type { TierBlock, TierCacheDay, TierDaySummary, TierGate, TierHandoff, TierKeepWarm, TierMeter, TierRecord, TierSettings, TierTotals, TierTtl } from '../types'
import type { Layer, Rung, StrataPoint } from './art'
import { C, LAYER_NAMES, hairSvg, iconSvg, ladderSvg, layerOf, markSvg, rampColor, refusalTile, ringState, ringSvg, runStack, stackBarSvg, stopStack, strataSvg, stripRingSvg, stripSwitchSvg, swatchSvg, switchSvg, vruleSvg } from './art'
import {
  KEEP_WARM_PROMPT,
  PING_EVERY_MS,
  TTL_MS,
  addColdGap,
  addPing,
  cachePhase,
  coldGapAccount,
  emptyCacheDay,
  formatTokens,
  formatUsd,
  keepWarmDecision,
  lastTouchMs,
  nextPingDueMs,
  pingBudget,
  pingBudgetDecision,
  rebuildCostUsd,
  ttlFor,
} from './cache'
import { addTotals, costUsd, countsSaving, dayKey, emptyTotals, mainPrices, modelFamily, nextRung, parseTag, recordKey, shiftDay, totalsOf } from './core'
import { isMainTurnRunning, pressAllowMax, pressDoItMyself, setMainTurnRunning } from './override'
import { hookFailed, reportError } from './report'
import { liveErrors, readLedger, setEnforce, visibleNotices } from './state'

type $ = EngineInterface

// $.state refs (consts of this file, as the engine requires; written by register.tsx except METER).
const HANDOFFS = { plugin: 'tier-mod', key: 'handoffs' } as const
const BLOCKS = { plugin: 'tier-mod', key: 'blocks' } as const
const TOTALS = { plugin: 'tier-mod', key: 'totals' } as const
const HEALTH = { plugin: 'tier-mod', key: 'health' } as const
const NOTICES = { plugin: 'tier-mod', key: 'notices' } as const
const ENFORCE = { plugin: 'tier-mod', key: 'enforce' } as const
const METER = { plugin: 'tier-mod', key: 'meter' } as const
const GATE = { plugin: 'tier-mod', key: 'gate' } as const
const MAIN = { plugin: 'tier-mod', key: 'main' } as const
const KEEP_WARM = { plugin: 'tier-mod', key: 'keepWarm' } as const

export const PANE_ID = 'tier'
export const PANE_COMMAND = 'tier-pane'
export const CACHE_PREFIX = 'cache:'
/** ~460px: the dock's width asked in cells (a request; the person's width wins). */
export const PANE_COLUMNS = 58
/** The hover group the footer pill and its card (drawn in the AbovePrompt band) share. */
export const PILL_SCOPE = 'tier-pill'
/** The store key 0.2.0 kept its old-hooks notice under (one naming a statusLine is dropped). */
const OLD_HOOKS_SEEN_KEY = 'seen:old-hooks'
/** A desktop surface attached and no SessionMode render reached Tier within this: the footer is taken. */
export const FOOTER_WAIT_MS = 5_000
/** The footer item's visible characters at most, "Tier " included. */
export const FOOTER_MAX_CHARS = 27
export const WAITING_TEXT = 'Waiting for the first turn since Tier loaded.'
const HOUR_MS = 3_600_000

export type PaneView = 'now' | 'today' | '7d'

type Els = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }
type DesktopEls = Els & { Svg: ElementConstructor<SvgProps> }

let tickTimer: Timer | undefined
let footerTimer: Timer | undefined
let cacheChain: Promise<unknown> = Promise.resolve()
/** A desktop SessionMode render reached Tier and Tier drew its pill there. */
let footerSeen = false
/** Another mod owns the footer (it drew a tree of its own), or no render reached Tier in time. */
let footerTaken = false
/** What the fallback did when the footer was taken. */
let fallback: 'none' | 'placed' | 'not-placed' = 'none'
let paneView: PaneView = 'now'
let recordFn: ((name: string, result: string) => Promise<unknown>) | undefined
/** Refusal cards the person closed (×), and those whose "Do it myself" they pressed, by tool_use_id. */
const dismissed = new Set<string>()
const selfPressed = new Set<string>()
/** What the status file last said of the hover card (a line is written when it changes). */
let cardRecorded = ''
/** The store's records of today, read at most once a minute for the hover card. */
let todayCache: { day: string; at: number; records: TierRecord[] } | undefined
/** The keep-warm switch as this load holds it (this session's $.state value; a new session starts off). */
let keepWarmOn = false
let keepWarmTimer: Timer | undefined
/** Above 0 while a keep-warm fork runs: its turn events (if the engine raises any) are not a real request. */
let pingDepth = 0
export function isPinging(): boolean {
  return pingDepth > 0
}

/** Reports a caught failure through the one error path (report.ts): chip, one toast per part, status file. Never throws. */
async function fail($: $, part: string, err: unknown): Promise<void> {
  await reportError($, part, err)
}

/** Fail open and loud: a throw is reported as `part` (chip, toast, status file) and its message answered (undefined when it ran). */
async function safe($: $, part: string, fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
    return undefined
  } catch (err) {
    await fail($, part, err)
    return err instanceof Error ? err.message : String(err)
  }
}

/** A press handler that reports its failure instead of dropping it (a Button's onPress promise is not awaited by anyone). */
function guard($: $, part: string, fn: () => unknown): () => Promise<void> {
  return async () => {
    try {
      await fn()
    } catch (err) {
      await fail($, part, err)
    }
  }
}

function toast($: $, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // no surface
  }
}

async function record(name: string, result: string): Promise<void> {
  try {
    await recordFn?.(name, result)
  } catch {
    // the recorder is the status file itself (it reports its own write failure and never throws)
  }
}

// ---------------------------------------------------------------- pure text and figures (tested)

/** Money: below $0.01 three decimals ($0.004), never "$0.00" for an amount that is not zero; else two. */
export function formatSmallUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '$?'
  const a = Math.abs(usd)
  const sign = usd < 0 ? '-' : ''
  if (a > 0 && a < 0.0005) return `${sign}<$0.001`
  if (a > 0 && a < 0.01) return `${sign}$${a.toFixed(3)}`
  return formatUsd(usd)
}

const money = formatSmallUsd
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** `sonnet · medium` */
export function modelEffort(model: string, effort: string): string {
  return `${modelFamily(model) ?? model} · ${effort}`
}

/** `12s`, `1m 04s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export type CacheView = {
  phase: TierMeter['phase']
  state: 'warm' | 'low' | 'cold' | 'none'
  minutesLeft: number
  ttlMinutes: number
  /** The pill's: `warm 41m`, `9m`, `cold · rebuild $2.61`; '' before the first turn. */
  pill: string
  /** The card's: `cache warm · 41m`, `cache cooling · 9m`, `cache cold`. */
  card: string
  /** The pane's: `Cache warm` / `41 of 60m`. */
  title: string
  detail: string
  rebuildUsd: number | undefined
}

export function cacheView(meter: TierMeter, now: number): CacheView {
  const { phase, msLeft } = cachePhase(meter, now)
  const ttlMs = TTL_MS[meter.ttl ?? '5m']
  const ttlMinutes = ttlMs / 60_000
  const minutesLeft = Math.max(0, Math.ceil(msLeft / 60_000))
  const rebuild = meter.rebuildUsd
  if (phase === 'none') return { phase, state: 'none', minutesLeft: 0, ttlMinutes, pill: '', card: 'cache · waiting for the first turn', title: 'Cache', detail: WAITING_TEXT, rebuildUsd: rebuild }
  const state = ringState(msLeft, ttlMs, phase)
  if (state === 'cold') {
    return { phase, state, minutesLeft: 0, ttlMinutes, pill: rebuild !== undefined ? `cold · rebuild ${money(rebuild)}` : 'cold', card: 'cache cold', title: 'Cache cold', detail: 'next request rebuilds', rebuildUsd: rebuild }
  }
  // The footer's format everywhere: whole minutes, `41m`, `60m` (never `1h00`).
  const m = `${minutesLeft}m`
  return {
    phase,
    state,
    minutesLeft,
    ttlMinutes,
    pill: state === 'low' ? m : `warm ${m}`,
    card: state === 'low' ? `cache cooling · ${m}` : `cache warm · ${m}`,
    title: state === 'low' ? 'Cache cooling' : 'Cache warm',
    detail: `${minutesLeft} of ${ttlMinutes}m`,
    rebuildUsd: rebuild,
  }
}

/** The broken part named on the pill: `Paused · ledger broke` (+n when more broke). */
export function pausedText(parts: readonly string[]): string {
  const uniq = [...new Set(parts)]
  return `Paused · ${uniq[0] ?? 'a part'} broke${uniq.length > 1 ? ` +${uniq.length - 1}` : ''}`
}

/** The cache glyph from the fraction of the TTL left: > 3/4 full .. > 0 a sliver; none left an empty ring. */
export function cacheGlyph(minutesLeft: number, ttlMinutes: number): string {
  const f = ttlMinutes > 0 ? minutesLeft / ttlMinutes : 0
  return f > 3 / 4 ? '●' : f > 1 / 2 ? '◕' : f > 1 / 4 ? '◑' : f > 0 ? '◔' : '○'
}

/** The footer's saving: `$1.84 saved` (saved colour); a negative one reads `$0.40 over` (dim), never `-$`. */
export function footerSavedText(savedUsd: number): { text: string; over: boolean } {
  return savedUsd >= 0 ? { text: `${money(savedUsd)} saved`, over: false } : { text: `${money(Math.abs(savedUsd))} over`, over: true }
}

/** The footer's cache text: `◕ 41m`, `○ cold`; '' before the first request. */
export function footerCacheText(c: CacheView): string {
  if (c.state === 'none') return ''
  if (c.state === 'cold') return '○ cold'
  return `${cacheGlyph(c.minutesLeft, c.ttlMinutes)} ${c.minutesLeft}m`
}

/** The footer's fault text: `error · ledger` (the gates fail open: never "paused"). */
export function footerErrorText(parts: readonly string[]): string {
  return `error · ${[...new Set(parts)][0] ?? 'a part'}`
}

/**
 * The footer Button's dim text after "Tier · ": `$50.69 saved · ◕ 60m`, kept within FOOTER_MAX_CHARS in all: past it the
 * word " saved" goes first, then the cache glyph (`60m`, `cold`), then the cache part, then the main text is cut
 * with an ellipsis. (" over" stays: `$0.40` alone would read as a saving.)
 */
export function footerDetail(mainText: string, cacheText: string): string {
  const room = FOOTER_MAX_CHARS - 'Tier · '.length
  const short = mainText.replace(/ saved$/, '')
  const tries = cacheText ? [`${mainText} · ${cacheText}`, `${short} · ${cacheText}`, `${short} · ${cacheText.replace(/^\S+\s/, '')}`, short] : [mainText, short]
  for (const t of tries) if ([...t].length <= room) return t
  return `${[...short].slice(0, room - 1).join('')}…`
}

/** The footer detail split for drawing: the text before the cache glyph, the glyph, the text after it (null: no glyph). */
export function footerSplit(detail: string): { lead: string; glyph: string; rest: string } | null {
  const m = /^(.*) · ([○◔◑◕●]) (.+)$/u.exec(detail)
  return m ? { lead: m[1]!, glyph: m[2]!, rest: m[3]! } : null
}

/** The whole dim text of the footer Button after "Tier · ": the saving, the cache part, or the fault. */
export function footerText(savedUsd: number, c: CacheView, broken: readonly string[]): string {
  if (broken.length > 0) return footerDetail(footerErrorText(broken), '')
  return footerDetail(footerSavedText(savedUsd).text, footerCacheText(c))
}

/** The terminal's status line: `Tier · 19 · $1.84 saved · warm 41m`. */
export function statusText(args: { today: TierTotals | undefined; meter: TierMeter; now: number; broken: readonly string[] }): string {
  if (args.broken.length > 0) return `Tier · ${pausedText(args.broken)}`
  const t = args.today ?? emptyTotals()
  const parts = ['Tier', String(t.handoffs), `${money(t.savedUsd)} saved`]
  const c = cacheView(args.meter, args.now)
  if (c.pill) parts.push(c.pill)
  return parts.join(' · ')
}

/** What the hero and the card say: saved, helpers' spend, the main-session-only estimate and the share saved. */
export function heroFigures(t: TierTotals): { saved: number; spent: number; mainOnly: number | undefined; pct: number | undefined } {
  const mainOnly = t.savedUsd > 0 ? t.spentUsd + t.savedUsd : undefined
  const pct = mainOnly && mainOnly > 0 ? Math.round((t.savedUsd / mainOnly) * 100) : undefined
  return { saved: t.savedUsd, spent: t.spentUsd, mainOnly, pct }
}

export type StripFigures = { helpers: number; rows: LayerRow[]; spent: number; saved: number; mainOnly: number | undefined; pct: number | undefined }

/**
 * Every figure of the hover strip from ONE source, today's records: helpers = the hand-offs, the by-layer amounts
 * (layerRows), spent = the sum of those amounts, saved = the hand-offs' savings less the blocks' cost (totalsOf),
 * main-only = spent + saved, the share = saved / main-only (heroFigures). So the parts always add up.
 */
export function stripFigures(records: readonly TierRecord[]): StripFigures {
  const rows = layerRows(records)
  const t = totalsOf(records)
  const spent = Math.round(rows.reduce((a, r) => a + r.usd, 0) * 1e6) / 1e6
  const f = heroFigures({ ...t, spentUsd: spent })
  return { helpers: t.handoffs, rows, spent: f.spent, saved: f.saved, mainOnly: f.mainOnly, pct: f.pct }
}

export type LayerRow = { name: (typeof LAYER_NAMES)[number]; layer: Layer; runs: number; usd: number }

/** Runs and spend per layer, fable .. haiku; rolled-up days (their byModel keys are "family/effort") count too. */
export function layerRows(records: readonly TierRecord[], summaries: readonly TierDaySummary[] = []): LayerRow[] {
  return LAYER_NAMES.map(name => {
    const layer = layerOf(name) as Layer
    let runs = 0
    let usd = 0
    for (const r of records) {
      if (r.kind !== 'handoff' || modelFamily(r.model) !== name) continue
      runs++
      usd += r.costUsd ?? 0
    }
    for (const s of summaries) {
      for (const [key, v] of Object.entries(s.byModel)) {
        if (key.split('/')[0] !== name) continue
        runs += v.count
        usd += v.usd
      }
    }
    return { name, layer, runs, usd: Math.round(usd * 1e6) / 1e6 }
  })
}

const isFailed = (h: Pick<TierHandoff, 'outcome'>) => h.outcome === 'escalated' || h.outcome === 'check failed'

/** The rung after a failed (or, given `asIfFailed`, a running) hand-off, as nextRung names it. */
export function rungAfter(h: TierHandoff, handoffs: readonly TierHandoff[]): string {
  const earlier = handoffs.filter(x => x.tag !== null && x.tag === h.tag && x.id !== h.id && x.at <= h.at && isFailed(x))
  return nextRung(h.model, h.effort, h.failure ?? '', earlier.map(x => ({ model: x.model, effort: x.effort, ...(x.failure ? { failure: x.failure } : {}) })))
}

/** `sonnet/high`, `opus/low`; the reason in brackets dropped. */
function shortRung(text: string): string {
  return text.replace(/\s*\(.*\)\s*$/, '').trim()
}

export type StripView = {
  layer: Layer | null
  failed: boolean
  modelEffort: string
  tryText?: string
  check?: { text: string; ok: boolean }
  escalated?: string
  /** The helper ended without a hand-back (usage limit, API error, killed, cancelled). */
  cutOff?: boolean
  elapsed?: string
  unverifiable?: boolean
  cost?: string
  saved?: string
}

/** The hand-off strip's parts. The tag is NOT repeated: the engine's row already shows the description. */
export function stripView(h: TierHandoff, handoffs: readonly TierHandoff[], now: number): StripView {
  const v: StripView = { layer: layerOf(modelFamily(h.model)), failed: isFailed(h), modelEffort: modelEffort(h.model, h.effort) }
  if (h.tag && h.try > 0) v.tryText = `try ${h.try}`
  if (h.lastCommand !== undefined) v.check = { text: `${shortCommand(h.lastCommand)} · exit ${h.lastExit ?? '?'}`, ok: h.lastExit === 0 }
  if (isFailed(h)) v.escalated = `${h.outcome === 'escalated' ? 'escalated' : 'check failed'} → ${shortRung(rungAfter(h, handoffs))}`
  if (h.outcome === 'cut off') v.cutOff = true
  if (h.outcome === 'running') v.elapsed = formatElapsed(now - h.at)
  if (h.unverifiable) v.unverifiable = true
  if (h.costUsd !== undefined) v.cost = money(h.costUsd)
  if (h.saved && countsSaving(h)) v.saved = `saved ${money(h.saved.savedUsd)}`
  return v
}

/** The strip as one text line (terminal, VS Code, mobile). */
export function stripLine(v: StripView): string {
  const parts = [v.modelEffort]
  if (v.tryText) parts.push(v.tryText)
  if (v.check) parts.push(v.check.text)
  if (v.escalated) parts.push(`↑ ${v.escalated}`)
  if (v.cutOff) parts.push('cut off')
  if (v.elapsed) parts.push(v.elapsed)
  if (v.unverifiable) parts.push('unverifiable')
  if (v.cost) parts.push(v.cost)
  if (v.saved) parts.push(v.saved)
  return parts.join(' · ')
}

function shortCommand(cmd: string): string {
  const one = cmd.replace(/\s+/g, ' ').trim()
  return one.length > 40 ? `${one.slice(0, 39)}…` : one
}

/** The ladder of the latest task that failed a rung: failed rungs, the current one, the next, the ceiling. */
export function ladderFor(handoffs: readonly TierHandoff[]): { tag: string; rungs: Rung[] } | undefined {
  const lastFailed = [...handoffs].filter(h => h.tag && isFailed(h)).sort((a, b) => a.at - b.at).pop()
  const tag = lastFailed?.tag
  if (!lastFailed || !tag) return undefined
  const attempts = handoffs.filter(h => h.tag === tag).sort((a, b) => a.at - b.at)
  const fails = attempts.filter(isFailed).slice(-2)
  const latest = attempts[attempts.length - 1]
  const current = latest && !isFailed(latest) ? latest : undefined
  const rungs: Rung[] = fails.map(f => ({ label: modelEffort(f.model, f.effort), kind: 'failed' as const }))
  if (current) rungs.push({ label: modelEffort(current.model, current.effort), kind: 'now' })
  const next = current ? rungAfter({ ...current, outcome: 'escalated' }, handoffs) : rungAfter(lastFailed, handoffs)
  if (!/^stop/.test(next)) rungs.push({ label: shortRung(next).replace(/\//g, ' · '), kind: 'next' })
  rungs.push({ label: 'opus · max', kind: 'ceiling' })
  return { tag, rungs }
}

export function ladderText(l: { tag: string; rungs: readonly Rung[] }): string {
  return `Ladder · ${l.tag}: ${l.rungs.map(r => `${r.label} ${r.kind}`).join(' → ')}`
}

/** The pane's "Stopped" section: its title follows the selected view, and the dim line says what it counts. */
export const STOPPED_TITLE = 'Stopped today'
export function stoppedTitle(view: PaneView): string {
  return view === 'now' ? 'Stopped this session' : view === 'today' ? STOPPED_TITLE : 'Stopped · last 7 days'
}
export const STOPPED_SUB = 'times Tier stopped the main session doing work itself'
/** Each gate's chip in plain words. */
export const STOPPED_LABELS = { web: 'web search', read: 'big read', edit: 'extra edit', handoff: 'hand-off missing model/effort' } as const

/** Stops by gate (refused or withheld; enforcement-off records are not stops); only kinds that occurred. */
export function blockCounts(blocks: readonly TierBlock[], rolledUp = 0): { total: number; chips: { label: string; n: number }[] } {
  const n: Record<string, number> = { [STOPPED_LABELS.web]: 0, [STOPPED_LABELS.read]: 0, [STOPPED_LABELS.edit]: 0, [STOPPED_LABELS.handoff]: 0 }
  for (const b of blocks) {
    if (b.action === 'would-refuse') continue
    const k = STOPPED_LABELS[b.gate]
    n[k] = (n[k] ?? 0) + 1
  }
  const chips = (Object.entries(n) as [string, number][]).filter(([, v]) => v > 0).map(([label, v]) => ({ label, n: v }))
  // Rolled-up days keep only their block total, not the gate: one chip says so.
  if (rolledUp > 0) chips.push({ label: 'rolled-up days', n: rolledUp })
  return { total: chips.reduce((a, c) => a + c.n, 0), chips }
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Cumulative spend by layer: by hour from the first hand-off to now, or by day over the range. */
export function strataPoints(records: readonly TierRecord[], now: number, by: 'hour' | { days: string[] }, summaries: readonly TierDaySummary[] = []): StrataPoint[] {
  const hs = records.filter((r): r is TierHandoff => r.kind === 'handoff').sort((a, b) => a.at - b.at)
  const cum = (until: (h: TierHandoff) => boolean): Record<Layer, number> => {
    const v: Record<Layer, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
    for (const h of hs) {
      const l = layerOf(modelFamily(h.model))
      if (l && until(h)) v[l] += h.costUsd ?? 0
    }
    return v
  }
  // Rolled-up days have no hand-offs left, only spend per model: added by their day.
  const rolled = (until: (day: string) => boolean): Record<Layer, number> => {
    const v: Record<Layer, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
    for (const sm of summaries) {
      if (!until(sm.day)) continue
      for (const [key, m] of Object.entries(sm.byModel)) {
        const l = layerOf(key.split('/')[0])
        if (l) v[l] += m.usd
      }
    }
    return v
  }
  if (by === 'hour') {
    // Today starts at local midnight; the last point is now (labelled so, not with its hour).
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const out: StrataPoint[] = []
    for (let t = start.getTime(); t < now; t += HOUR_MS) out.push({ label: String(new Date(t).getHours()).padStart(2, '0'), byLayer: cum(h => h.at < t) })
    out.push({ label: 'now', byLayer: cum(() => true) })
    return out
  }
  return by.days.map(day => {
    const [y, m, d] = day.split('-').map(Number)
    const a = cum(h => h.day <= day)
    const b = rolled(sd => sd <= day)
    return { label: WEEKDAY[new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getDay()] ?? day, byLayer: { 1: a[1] + b[1], 2: a[2] + b[2], 3: a[3] + b[3], 4: a[4] + b[4] } }
  })
}

export type RefusalView =
  | { kind: 'card'; tile: 'down' | 'held'; title: string; titleTail?: string; detail: string; savedText?: string; buttons: 'self' | 'max'; tag?: string }
  | { kind: 'line'; text: string }

/** What the refusal draws: the hand-off card (web/read/edit), the quiet line (model/effort missing), the max card. */
export function refusalView(b: TierBlock, mainModel: string | undefined, ttl?: TierTtl, contextTokens?: number): RefusalView {
  if (b.gate === 'handoff') {
    if (/names no/.test(b.reason)) return { kind: 'line', text: 'Hand-off needed a model and effort - Claude adds them and retries' }
    const tag = b.tag ?? parseTag(b.reason) ?? undefined
    const what = /fable model/.test(b.reason) ? 'The Fable model' : 'Max effort'
    const detail = tag ? 'No failed Opus attempt for this task yet · next rung: opus/low' : 'This hand-off has no [t=<task>] tag · next rung: opus/low'
    const v: RefusalView = { kind: 'card', tile: 'held', title: `${what} is for escalation`, detail, buttons: 'max' }
    if (tag) v.tag = tag
    return v
  }
  if (b.gate === 'web') {
    const tool = b.tool === 'WebFetch' ? 'Web fetch' : b.tool === 'Bash' ? 'Web command' : 'Web search'
    return { kind: 'card', tile: 'down', title: 'Sent down to T1', titleTail: ' · haiku reader', detail: tool, buttons: 'self' }
  }
  const title = b.gate === 'read' ? 'Read handed to a helper' : 'Edit handed to a helper'
  const parts: string[] = [b.tool]
  let savedText: string | undefined
  const held = b.toast.match(/held back a (\d+)(K?)-token result/)
  if (held) {
    const tokens = Number(held[1]) * (held[2] ? 1000 : 1)
    parts.push(`${formatTokens(tokens)} tokens kept out of this chat`)
    const p = mainPrices(mainModel, ttl, contextTokens)
    const net = p ? tokens * p.write - (b.costUsd ?? 0) : undefined
    if (net !== undefined && net > 0) savedText = `~${money(net)} saved`
  }
  const lines = b.toast.match(/a (\d+)-line (read|write)/)
  if (lines) parts.push(`${lines[1]} lines`)
  const nth = b.toast.match(/edits to a (\w+) file/)
  if (nth) parts.push(`${nth[1]} file this message`)
  const v: RefusalView = { kind: 'card', tile: 'down', title, detail: parts.join(' · '), buttons: 'self' }
  if (savedText) v.savedText = savedText
  return v
}

export type TagRow = { tag: string; count: number; usd: number; savedUsd: number }
export type RangeView = { totals: TierTotals; byTag: TagRow[]; blocks: TierBlock[] }

/** Today / 7 days: totals over detail records plus rolled-up days, per task tag, the blocks. */
export function rangeView(records: readonly TierRecord[], summaries: readonly TierDaySummary[]): RangeView {
  let totals = totalsOf(records)
  const tags = new Map<string, TagRow>()
  const row = (tag: string) => {
    let r = tags.get(tag)
    if (!r) tags.set(tag, (r = { tag, count: 0, usd: 0, savedUsd: 0 }))
    return r
  }
  for (const r of records) {
    if (r.kind !== 'handoff') continue
    const g = row(r.tag ?? '(untagged)')
    g.count++
    g.usd += r.costUsd ?? 0
    if (countsSaving(r)) g.savedUsd += r.saved?.savedUsd ?? 0
  }
  for (const s of summaries) {
    const { day: _d, byModel: _m, byTag, ...t } = s
    totals = addTotals(totals, t)
    for (const [tag, v] of Object.entries(byTag)) {
      const g = row(tag)
      g.count += v.count
      g.usd += v.usd
    }
  }
  const byTag = [...tags.values()].sort((a, b) => b.usd - a.usd || b.count - a.count)
  const blocks = records.filter((r): r is TierBlock => r.kind === 'block')
  return { totals, byTag, blocks }
}

/** Store records of the range with this session's live atoms laid over them (the atoms are newer). */
export function mergeRecords(stored: readonly TierRecord[], live: readonly TierRecord[], fromDay: string, toDay: string): TierRecord[] {
  const byKey = new Map<string, TierRecord>()
  for (const r of stored) byKey.set(recordKey(r), r)
  for (const r of live) if (r.day >= fromDay && r.day <= toDay) byKey.set(recordKey(r), r)
  return [...byKey.values()].sort((a, b) => a.at - b.at)
}

export function cacheLine(meter: TierMeter, now: number): string {
  const { phase, msLeft } = cachePhase(meter, now)
  const ttl = meter.ttl ? ` (${meter.ttl} TTL)` : ''
  if (phase === 'none') return WAITING_TEXT
  if (phase === 'cold') return `Cold${ttl}: the next message rebuilds the cache.`
  return `Warm, ${Math.max(0, Math.ceil(msLeft / 60_000))}m left${ttl}.`
}

/** The strip's rows: three text rows and the large saved figure. Never more than the band's maxRows. */
export const STRIP_ROWS = 4
/** The spend bar's height (px), the dividers' height (px). */
export const STRIP_BAR_H = 8
export const STRIP_RULE_PX = 56
/** The mark, the cache ring and the keep-warm switch (px). */
export const STRIP_MARK_PX = 22
export const STRIP_RING_PX = 30
export const STRIP_SWITCH_PX = 28
/** The band's padding (cells) either side, and the gap (cells) either side of each 1-cell divider. */
export const STRIP_BAND_PAD = 1
export const STRIP_GAP = 1
const DIVIDER_CELLS = 1 + 2 * STRIP_GAP
/** The bar's floor (cells) when the spend section is at its narrowest. */
export const STRIP_BAR_MIN_CELLS = 12
/**
 * Cells a character takes at each Text size, from the live band (0.14.0, high-DPI): a cell 15.5 device px, caption
 * text 21 px, body 24 px, the title figure 40 px; system-ui draws ~0.55 em a character (tabular digits the same).
 * A section's width in cells is the widest of its lines by these, so every Text stays on one line.
 */
export const CELLS_PER_CHAR = { caption: 0.75, footnote: 0.8, body: 0.85, heading: 1.15, title: 1.45 } as const
export type StripSize = keyof typeof CELLS_PER_CHAR
export const textCells = (text: string, size: StripSize): number => Math.ceil([...text].length * CELLS_PER_CHAR[size] - 1e-9)
/**
 * CSS px per cell for an Svg (its width is CSS px, the band's are cells): a floor - a cell is ~0.6 em of the code
 * font, 13 px or more - so an Svg sized by it never runs past the cells it was given.
 */
export const SVG_PX_PER_CELL = 7.75
export const svgCells = (px: number): number => Math.ceil(px / SVG_PX_PER_CELL - 1e-9)
export const cellsPx = (cells: number): number => Math.floor(cells * SVG_PX_PER_CELL)
/** The widths (cells) each section grows to while the band has room: 3 + 22 + 28 + 19 + 14, 4 dividers of 3, padding 2 = 100. */
export const STRIP_TARGET = { mark: 3, saved: 22, spend: 28, cache: 19, actions: 14 } as const

export type StripSection = keyof typeof STRIP_TARGET
/** The strip's texts, as drawn: the legend top-two and top-one variants ('' when no layer spent). */
export type StripTexts = { saved: string; sub: string; head: string; legend2: string; legend1: string; cacheTitle: string; cacheTitleShort: string; cacheSub: string }
export type StripPlan = {
  mark: boolean
  /** The legend drawn: 2 = the top two layers (+n), 1 = the top layer (+n), 0 = none. */
  legend: 0 | 1 | 2
  /** The cache title without its minutes (the ring shows them): the last step before the band is overfull. */
  cacheShort: boolean
  widths: Record<StripSection, number>
  rows: number
  /** Cells the strip takes, padding and dividers included. */
  columns: number
  /** Cells past the band's columns (0 when it fits; the Texts then truncate, never wrap). */
  over: number
  fits: boolean
}

/** The actions' least width: the switch, a gap, and the Button's text at 'body' (the desktop ignores a Text child's size) + 1 cell of safety. */
export const STRIP_ACTION_CELLS = svgCells(STRIP_SWITCH_PX) + 1 + textCells('Keep warm', 'body') + 1
/** Cells left unplanned at the band's right edge. */
export const STRIP_SAFETY = 2

/** The strip's type scale by the band's bodyColumns: roomy >= 110, normal 85..109, compact < 85. */
export type StripTier = { name: 'roomy' | 'normal' | 'compact'; figure: StripSize; primary: StripSize; label: StripSize; ringPx: number; markPx: number }
export const STRIP_TIERS: Record<StripTier['name'], StripTier> = {
  roomy: { name: 'roomy', figure: 'title', primary: 'footnote', label: 'caption', ringPx: 30, markPx: 22 },
  normal: { name: 'normal', figure: 'heading', primary: 'caption', label: 'caption', ringPx: 30, markPx: 22 },
  compact: { name: 'compact', figure: 'footnote', primary: 'caption', label: 'caption', ringPx: 24, markPx: 18 },
}
export const stripTier = (columns: number): StripTier => (columns >= 110 ? STRIP_TIERS.roomy : columns >= 85 ? STRIP_TIERS.normal : STRIP_TIERS.compact)

/** Each section's least width (cells) for the texts it shows. */
export function stripNeeds(t: StripTexts, legend: 0 | 1 | 2, cacheShort: boolean, tier: StripTier = STRIP_TIERS.normal): Record<StripSection, number> {
  const lg = legend === 2 ? t.legend2 : legend === 1 ? t.legend1 : ''
  return {
    mark: svgCells(tier.markPx),
    saved: Math.max(textCells('Saved today', tier.label), textCells(t.saved, tier.figure), textCells(t.sub, tier.label)),
    spend: Math.max(STRIP_BAR_MIN_CELLS, textCells(t.head, tier.primary), lg ? textCells(lg, tier.label) : 0),
    cache: svgCells(tier.ringPx) + 1 + Math.max(textCells(cacheShort ? t.cacheTitleShort : t.cacheTitle, tier.primary), textCells(t.cacheSub, tier.label)),
    actions: STRIP_ACTION_CELLS,
  }
}

const stripTotal = (w: Record<StripSection, number>, mark: boolean) => {
  const secs = mark ? (['mark', 'saved', 'spend', 'cache', 'actions'] as const) : (['saved', 'spend', 'cache', 'actions'] as const)
  return 2 * STRIP_BAND_PAD + secs.reduce((a, s) => a + w[s], 0) + (secs.length - 1) * DIVIDER_CELLS
}

/**
 * The strip by a CELL budget of the band's columns: every section as wide as its widest line (so no Text wraps),
 * grown toward STRIP_TARGET while there is room. Past the columns: the mark goes, then the legend shortens to the
 * top layer, then the legend goes, then the cache title leaves its minutes to the ring; the saved figure, the
 * bar, the cache and the actions always stay. Drawn only when STRIP_ROWS fit maxRows.
 */
export function stripPlan(columns: number, maxRows: number, t: StripTexts): StripPlan {
  const tier = stripTier(columns)
  const budget = columns - STRIP_SAFETY
  const hasLegend = t.legend2 !== ''
  const steps: { mark: boolean; legend: 0 | 1 | 2; cacheShort: boolean }[] = [
    { mark: true, legend: hasLegend ? 2 : 0, cacheShort: false },
    { mark: false, legend: hasLegend ? 2 : 0, cacheShort: false },
    { mark: false, legend: hasLegend ? 1 : 0, cacheShort: false },
    { mark: false, legend: 0, cacheShort: false },
    { mark: false, legend: 0, cacheShort: true },
  ]
  let pick = steps[steps.length - 1] as (typeof steps)[number]
  for (const s of steps) {
    if (stripTotal(stripNeeds(t, s.legend, s.cacheShort, tier), s.mark) <= budget) {
      pick = s
      break
    }
  }
  const widths = stripNeeds(t, pick.legend, pick.cacheShort, tier)
  if (!pick.mark) widths.mark = 0
  let room = budget - stripTotal(widths, pick.mark)
  for (const s of ['saved', 'spend', 'cache', 'actions', 'mark'] as const) {
    if (room <= 0 || (s === 'mark' && !pick.mark)) continue
    const grow = Math.max(0, Math.min(room, STRIP_TARGET[s] - widths[s]))
    widths[s] += grow
    room -= grow
  }
  const total = stripTotal(widths, pick.mark)
  return { ...pick, widths, rows: STRIP_ROWS, columns: total, over: Math.max(0, total - columns), fits: STRIP_ROWS <= maxRows }
}

/** The strip's legend line: the top `n` layers by spend, `● opus $16.12 · ● sonnet $0.96`, ` +k` when more spent. */
export function stripLegendSpans(rows: readonly LayerRow[], n: number): { text: string; color: string }[] {
  const used = [...rows].filter(r => r.usd > 0).sort((a, b) => b.usd - a.usd || b.layer - a.layer)
  const out: { text: string; color: string }[] = []
  used.slice(0, n).forEach((r, i) => {
    if (i > 0) out.push({ text: ' · ', color: C.mut })
    out.push({ text: '●', color: rampColor(r.layer) }, { text: ` ${r.name} ${money(r.usd)}`, color: C.mut })
  })
  if (used.length > n && n > 0) out.push({ text: ` +${used.length - n}`, color: C.mut })
  return out
}

/** The spend legend, T1..T4 (haiku..fable), layers with spend only; initials when it runs past `maxChars`. */
export function legendItems(rows: readonly LayerRow[], maxChars = 34): { layer: Layer; text: string }[] {
  const used = [...rows].filter(r => r.usd > 0).sort((a, b) => a.layer - b.layer)
  const full = used.map(r => ({ layer: r.layer, text: `${r.name} ${money(r.usd)}` }))
  const len = full.reduce((a, x) => a + x.text.length + 3, 0)
  return len <= maxChars ? full : used.map(r => ({ layer: r.layer, text: `${r.name[0]} ${money(r.usd)}` }))
}

/** The saved figure's sub line, ONE line: `65% less` (saved colour) + ` · vs $62.88` (dim). */
export function stripSavedSub(f: Pick<StripFigures, 'pct' | 'mainOnly' | 'spent'>): { text: string; color: string }[] {
  if (f.pct !== undefined && f.mainOnly !== undefined) return [{ text: `${f.pct}% less`, color: C.saved }, { text: ` · vs ${money(f.mainOnly)}`, color: C.mut }]
  return [{ text: `${money(f.spent)} on helpers · est.`, color: C.mut }]
}

/**
 * The strip's cache texts: warm `Cache warm · 60m` / `rebuild $5.23` (keep-warm on: `kept warm · ping in 4m`);
 * cold `Cache cold` / `next msg rebuilds $5.23`. `short` is the title without the minutes.
 */
export function stripCacheText(c: CacheView, kwOn: boolean, kw: TierKeepWarm | undefined, now: number): { title: string; short: string; sub: string } {
  const rebuild = c.rebuildUsd !== undefined ? money(c.rebuildUsd) : undefined
  if (c.state === 'none') return { title: 'Cache', short: 'Cache', sub: 'waiting for a turn' }
  if (c.state === 'cold') return { title: 'Cache cold', short: 'Cache cold', sub: `next msg rebuilds${rebuild ? ` ${rebuild}` : ''}` }
  const title = `${c.title} · ${c.minutesLeft}m`
  if (kwOn) {
    const due = kw?.status === 'scheduled' && kw.dueMs !== undefined ? ` · ping in ${Math.max(0, Math.ceil((kw.dueMs - now) / 60_000))}m` : ''
    return { title, short: c.title, sub: `kept warm${due}` }
  }
  return { title, short: c.title, sub: `rebuild ${rebuild ?? '$?'}` }
}

/** The pane's cache row: `Cache warm · 41 of 60m · rebuild $4.20`, `Cache cold · rebuild $4.20`. */
export function paneCacheText(c: CacheView): string {
  if (c.state === 'none') return 'Cache'
  const parts = [c.title]
  if (c.state !== 'cold') parts.push(c.detail)
  if (c.rebuildUsd !== undefined) parts.push(`rebuild ${money(c.rebuildUsd)}`)
  return parts.join(' · ')
}

/**
 * The pane's keep-warm line. Scheduled and priceable (`price` = the meter's context, model and TTL):
 * `next ping in 14m · ping 3 of 40 · $0.45 of $5.90` (the upcoming ping's number, the pings' cost since the last real
 * request of the one-rebuild budget). Otherwise `next ping in 14m · 2 pings · $0.16 today`, or why this round stopped.
 */
export function keepWarmLine(
  kw: TierKeepWarm | undefined,
  today: TierCacheDay | undefined,
  now: number,
  price?: { contextTokens?: number | undefined; model?: string | undefined; ttl?: TierMeter['ttl'] },
): string {
  const n = today?.pingsSent ?? 0
  const tail = `${n} ping${n === 1 ? '' : 's'} · ${money(today?.pingsSentUsd ?? 0)} today`
  if (kw?.status === 'scheduled' && kw.dueMs !== undefined) {
    const inM = `next ping in ${Math.max(0, Math.ceil((kw.dueMs - now) / 60_000))}m`
    const budget = price ? pingBudget({ contextTokens: price.contextTokens, model: price.model, ttl: price.ttl ?? '1h' }) : undefined
    if (budget) return `${inM} · ping ${Math.min((kw.pingsSinceReal ?? 0) + 1, budget.maxPings)} of ${budget.maxPings} · ${money(kw.pingsSinceRealUsd ?? 0)} of ${money(budget.rebuildUsd)}`
    return `${inM} · ${tail}`
  }
  if (kw?.status === 'stopped') return `${kw.reason ?? 'stopped'} · ${tail}`
  return `waiting for a request · ${tail}`
}

// ---------------------------------------------------------------- the meter

async function readMeter($: $): Promise<TierMeter> {
  return (await $.state.get(METER)).value ?? { phase: 'none' }
}

async function usageOrUndefined($: $) {
  try {
    return await $.session.usage()
  } catch {
    return undefined
  }
}

/** Applies `fn` to a day's cache figures in the store (serialized), mirroring today's into the meter. */
function addCacheDay($: $, day: string, fn: (d: TierCacheDay) => TierCacheDay): Promise<void> {
  const run = cacheChain.then(async () => {
    const key = CACHE_PREFIX + day
    const before = ((await $.store.get(key)) as TierCacheDay | undefined) ?? emptyCacheDay(day)
    const after = fn(before)
    await $.store.set(key, after)
    if (day === dayKey(await $.clock.now())) await update($, METER, m => ({ ...(m ?? { phase: 'none' as const }), today: after }))
  })
  cacheChain = run.catch(() => undefined)
  return run.catch(err => fail($, 'cache meter', err))
}

/**
 * The status line is for the terminal and VS Code, and the desktop's fallback. It is one line per session (no
 * per-surface switch), so while a desktop is attached and Tier draws its footer item there, it is cleared: it
 * would only repeat that item. Also cleared when the footer is taken and the fallback pane is placed.
 */
async function wantStatus($: $): Promise<boolean> {
  let surfaces: readonly string[] = []
  try {
    surfaces = await $.session.surfaces()
  } catch {
    return true
  }
  if (!surfaces.includes('desktop')) return true
  if (footerTaken) return fallback !== 'placed'
  return !footerSeen
}

async function brokenParts($: $): Promise<string[]> {
  const health = (await $.state.get(HEALTH)).value
  return liveErrors(health?.errors).map(x => x.part)
}

async function refreshStatus($: $): Promise<void> {
  if (!(await wantStatus($))) {
    $.ui.status(undefined)
    return
  }
  const now = await $.clock.now()
  const meter = await readMeter($)
  // The saving from the footer's and the strip's one source (today's merged records, local midnight rolls it over).
  const f = stripFigures(await stripRecords($, now))
  const today: TierTotals = { ...emptyTotals(), handoffs: f.helpers, savedUsd: f.saved }
  $.ui.status(statusText({ today, meter, now, broken: await brokenParts($) }))
}

// ---------------------------------------------------------------- keep-warm (off by default; only the person's press switches it)

function cancelKeepWarm(): void {
  keepWarmTimer?.cancel()
  keepWarmTimer = undefined
}

/** Writes keep-warm's round into the meter (the session's ping count and a pending live check carried over). */
async function setKeepWarmStatus($: $, status: TierKeepWarm['status'], o: { dueMs?: number; reason?: string } = {}): Promise<void> {
  await update($, METER, m => {
    const base: TierMeter = m ?? { phase: 'none' }
    const prev = base.keepWarm
    // The round's status, due time and reason are replaced; the session's counts and a pending live check carry over.
    const { status: _s, dueMs: _d, reason: _r, ...carry } = prev ?? { pings: 0 }
    const next: TierKeepWarm = { ...carry, status, pings: prev?.pings ?? 0 }
    if (o.dueMs !== undefined) next.dueMs = o.dueMs
    if (o.reason !== undefined) next.reason = o.reason
    return { ...base, keepWarm: next }
  })
}

/** Arms one ping for `dueMs` (55 minutes after the last real request's start, or the last ping's). */
async function armKeepWarm($: $, dueMs: number): Promise<void> {
  cancelKeepWarm()
  const now = await $.clock.now()
  // The switch went off while this was awaiting (a press, or a ping in flight): it never arms after Off.
  if (!keepWarmOn) return
  keepWarmTimer = $.clock.after(Math.max(0, dueMs - now), () => void fireKeepWarm($))
  await setKeepWarmStatus($, 'scheduled', { dueMs })
}

/** Ends this round (the next real request arms again while the switch is on); the reason goes to the status file. */
async function stopKeepWarm($: $, reason: string, quiet = false): Promise<void> {
  cancelKeepWarm()
  await setKeepWarmStatus($, 'stopped', { reason })
  await record('keep-warm', `stopped: ${reason}; at ${new Date(await $.clock.now()).toISOString()}`)
  // A failed ping is a surprise (policy skips stay quiet): one toast per stopped round; an exception was already reported.
  if (!quiet && reason.startsWith('ping failed')) toast($, `Tier: keep-warm stopped - ${reason}. It arms again at your next request.`)
}

/** The keep-warm timer fired: decide, ping with a fork (not a real request), record it, arm again. */
async function fireKeepWarm($: $): Promise<void> {
  keepWarmTimer = undefined
  const err = await safe($, 'keep-warm', async () => {
    if (!keepWarmOn) return
    const now = await $.clock.now()
    const meter = await readMeter($)
    const usage = await usageOrUndefined($)
    const ttl = usage ? ttlFor(usage.rateLimits) : meter.ttl ?? '5m'
    const contextTokens = usage?.context.tokens ?? meter.contextTokens
    const d = keepWarmDecision({
      on: keepWarmOn,
      lastRealStartMs: meter.lastMainRequestStartMs,
      ttl,
      contextTokens,
      rateLimits: usage?.rateLimits ?? [],
      turnRunning: isMainTurnRunning(),
      model: meter.mainModel,
      spentUsd: meter.keepWarm?.pingsSinceRealUsd ?? 0,
      now,
      ...(meter.lastPingStartMs !== undefined ? { lastPingStartMs: meter.lastPingStartMs } : {}),
    })
    if (d.kind === 'skip') return await stopKeepWarm($, `skipped: ${d.reason}`)
    pingDepth++
    let reply: Awaited<ReturnType<$['model']['fork']>>
    try {
      reply = await $.model.fork({ prompt: KEEP_WARM_PROMPT })
    } finally {
      pingDepth--
    }
    // The switch went off while the ping was in flight: it does not arm again (the ping's cost is still counted below).
    const stillOn = keepWarmOn
    if (!reply.isAnswered && reply.reason !== 'empty-reply') {
      const why = reply.reason === 'api-error' ? `api-error ${reply.status ?? ''} ${reply.error}`.replace(/\s+/g, ' ').trim() : reply.reason
      if (!keepWarmOn) return await setKeepWarmStatus($, 'off')
      return await stopKeepWarm($, `ping failed: ${why}`)
    }
    const used = reply.usage
    const cost = costUsd(used, meter.mainModel, 'main')
    await update($, METER, m => {
      const base: TierMeter = m ?? { phase: 'none' }
      const prev = base.keepWarm
      // A new ping restarts the live check; the pings since the last real request add up toward one rebuild.
      const { status: _s, dueMs: _d, reason: _r, checkContextTokens: _c, checkFirstRequest: _f, ...carry } = prev ?? { pings: 0 }
      const kw: TierKeepWarm = {
        ...carry,
        status: 'stopped',
        pings: (prev?.pings ?? 0) + 1,
        checkAfterPingMs: now,
        pingsSinceReal: (prev?.pingsSinceReal ?? 0) + 1,
        pingsSinceRealUsd: round6((prev?.pingsSinceRealUsd ?? 0) + (cost ?? 0)),
      }
      const next: TierMeter = { ...base, lastPingStartMs: now, keepWarm: kw }
      next.phase = cachePhase(next, now).phase
      return next
    })
    await addCacheDay($, dayKey(now), day => addPing(day, cost))
    await record(
      'keep-warm',
      `ping at ${new Date(now).toISOString()}: cost ${money(cost)}; the ping read ${used.cache_read_input_tokens} cached tokens, wrote ${used.cache_creation_input_tokens}`,
    )
    // The same stop rule, asked now: when the next ping would take the pings past one rebuild, the round ends here.
    const after = (await readMeter($)).keepWarm
    const more = pingBudgetDecision({ contextTokens, model: meter.mainModel, ttl, spentUsd: after?.pingsSinceRealUsd ?? 0 })
    if (!stillOn || !keepWarmOn) {
      cancelKeepWarm()
      return await setKeepWarmStatus($, 'off')
    }
    if (more.kind === 'skip') return await stopKeepWarm($, `skipped: ${more.reason}`)
    await armKeepWarm($, now + PING_EVERY_MS)
  })
  if (err) await safe($, 'keep-warm', () => stopKeepWarm($, `ping failed: ${err}`, true))
}

/** Where keep-warm stands after the switch turned on, or a real request started: armed, or why not. */
async function resumeKeepWarm($: $): Promise<void> {
  if (!keepWarmOn) {
    cancelKeepWarm()
    await setKeepWarmStatus($, 'off')
    return
  }
  const now = await $.clock.now()
  const meter = await readMeter($)
  const due = nextPingDueMs(meter)
  if (meter.lastMainRequestStartMs === undefined || due === undefined) {
    cancelKeepWarm()
    return await setKeepWarmStatus($, 'stopped', { reason: 'waiting for a request' })
  }
  if ((meter.ttl ?? '5m') !== '1h') return await stopKeepWarm($, 'skipped: 5m TTL')
  const budget = pingBudgetDecision({ contextTokens: meter.contextTokens, model: meter.mainModel, ttl: meter.ttl ?? '5m', spentUsd: meter.keepWarm?.pingsSinceRealUsd ?? 0 })
  // Unpriceable here is left to the timer's own decision; only a spent budget ends the round now.
  if (budget.kind === 'skip' && budget.reason.startsWith('pings reached')) return await stopKeepWarm($, `skipped: ${budget.reason}`)
  if (cachePhase(meter, now).phase === 'cold') return await stopKeepWarm($, 'cache already cold: the next request arms it')
  await armKeepWarm($, due)
}

/** The person's press (pane or card): the only thing that switches keep-warm. Per session ($.state only). */
async function pressKeepWarm($: $, from: string): Promise<void> {
  await guard($, 'keep-warm', async () => {
    // What the switch shows is the state value (it outlives a reload); the module variable follows it.
    let shown = keepWarmOn
    await safe($, 'keep-warm', async () => {
      shown = (await $.state.get(KEEP_WARM)).value ?? keepWarmOn
    })
    const on = !shown
    keepWarmOn = on
    await safe($, 'keep-warm', () => update($, KEEP_WARM, () => on))
    await safe($, 'keep-warm', () => resumeKeepWarm($))
    await record('press', `${from} at ${new Date().toISOString()}: keep-warm ${on ? 'on' : 'off'}`)
    toast($, on ? 'Tier: keep-warm on for this session - a ping ~55 min after your last request, until the pings add up to one rebuild.' : 'Tier: keep-warm off.')
    $.ui.invalidate('ui.render')
  })()
}

/** The live check's verdict: cold iff the first request's cache read is under half of (read + write). */
export function warmVerdictFirstRequest(read: number, write: number): 'warm' | 'cold (rebuilt)' | 'unknown' {
  if (!(read + write > 0)) return 'unknown'
  return read < (read + write) / 2 ? 'cold (rebuilt)' : 'warm'
}

/** From the turn total alone: cold iff the cache write is at least half the context the turn started with. */
export function warmVerdictTurnTotal(write: number, contextTokens: number | undefined): 'warm' | 'cold (rebuilt)' | 'unknown' {
  if (contextTokens === undefined || !(contextTokens > 0)) return 'unknown'
  return write >= contextTokens / 2 ? 'cold (rebuilt)' : 'warm'
}

/**
 * After a ping, the first real main turn: whether the ping kept the cache warm (the live check). The first real
 * request's own usage (turn.step) decides when the engine gave it; else the turn total against the context the turn
 * started with (a turn total mixes the first request with its later, always-warm ones, so read alone cannot tell).
 */
async function checkAfterPing($: $, usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number } | undefined): Promise<void> {
  const meter = await readMeter($)
  const at = meter.keepWarm?.checkAfterPingMs
  if (at === undefined) return
  const first = meter.keepWarm?.checkFirstRequest
  if (!first && !usage) return
  const ctx = meter.keepWarm?.checkContextTokens
  const read = first ? first.read : (usage?.cache_read_input_tokens ?? 0)
  const write = first ? first.write : (usage?.cache_creation_input_tokens ?? 0)
  const verdict = first ? warmVerdictFirstRequest(read, write) : warmVerdictTurnTotal(write, ctx)
  await update($, METER, m => {
    const base: TierMeter = m ?? { phase: 'none' }
    if (!base.keepWarm) return base
    const { checkAfterPingMs: _c, checkContextTokens: _t, checkFirstRequest: _f, ...kw } = base.keepWarm
    return { ...base, keepWarm: kw }
  })
  await record(
    'keep-warm-check',
    `first real turn after the ping at ${new Date(at).toISOString()}: cache read ${read}, cache write ${write} (${first ? 'first request' : 'turn total'}), context ${ctx ?? '?'} -> ${verdict}`,
  )
}

/** A real main-loop request starts: account a cold gap, update the meter. */
async function onMainRequest($: $, model: string): Promise<void> {
  const now = await $.clock.now()
  const usage = await usageOrUndefined($)
  const meter = await readMeter($)
  const ttl = usage ? ttlFor(usage.rateLimits) : meter.ttl ?? '5m'
  const contextTokens = usage?.context.tokens ?? meter.contextTokens
  const touch = lastTouchMs(meter)
  if (touch !== undefined && meter.lastMainRequestStartMs !== undefined) {
    const gap = coldGapAccount({ gapMs: now - touch, ttl, contextTokens, model: meter.mainModel ?? model })
    if (gap) await addCacheDay($, dayKey(now), d => addColdGap(d, gap))
  }
  await update($, METER, m => {
    const next: TierMeter = { ...(m ?? { phase: 'none' }), lastMainRequestStartMs: now, mainModel: model, ttl }
    if (contextTokens !== undefined) next.contextTokens = contextTokens
    const rebuild = rebuildCostUsd(contextTokens, model, ttl)
    if (rebuild !== undefined) next.rebuildUsd = rebuild
    next.phase = cachePhase(next, now).phase
    // A real request ends the pings' tally; the first one after a ping also notes the context it starts with.
    if (next.keepWarm) {
      const kw: TierKeepWarm = { ...next.keepWarm, pingsSinceReal: 0, pingsSinceRealUsd: 0 }
      if (kw.checkAfterPingMs !== undefined && kw.checkContextTokens === undefined && contextTokens !== undefined) kw.checkContextTokens = contextTokens
      next.keepWarm = kw
    }
    return next
  })
  // Keep-warm re-arms 55 minutes from this request's start (or says why not) while the person has it on.
  if (keepWarmOn) await resumeKeepWarm($)
}

/** turn.step result (main loop): the first real request after a ping, by its own usage (the live check). */
export async function part2StepResult($: $, e: { agentId?: string }, usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number } | null | undefined): Promise<void> {
  if (e.agentId !== undefined || pingDepth > 0 || !usage) return
  await safe($, 'cache meter', async () => {
    const meter = await readMeter($)
    const kw = meter.keepWarm
    if (kw?.checkAfterPingMs === undefined || kw.checkFirstRequest !== undefined) return
    await update($, METER, m => {
      const base: TierMeter = m ?? { phase: 'none' }
      if (base.keepWarm?.checkAfterPingMs === undefined || base.keepWarm.checkFirstRequest !== undefined) return base
      return { ...base, keepWarm: { ...base.keepWarm, checkFirstRequest: { read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens } } }
    })
  })
}

/** After a turn: the context grew, so the rebuild price moves. */
async function onMainTurnEnd($: $): Promise<void> {
  const usage = await usageOrUndefined($)
  if (!usage) return
  await update($, METER, m => {
    const base: TierMeter = m ?? { phase: 'none' }
    const ttl = base.ttl ?? ttlFor(usage.rateLimits)
    const next: TierMeter = { ...base, ttl }
    if (usage.context.tokens !== undefined) next.contextTokens = usage.context.tokens
    const rebuild = rebuildCostUsd(next.contextTokens, next.mainModel, ttl)
    if (rebuild !== undefined) next.rebuildUsd = rebuild
    return next
  })
}

async function tick($: $): Promise<void> {
  const now = await $.clock.now()
  await update($, METER, m => {
    const base: TierMeter = m ?? { phase: 'none' }
    return { ...base, tickMs: now, phase: cachePhase(base, now).phase }
  })
  await refreshStatus($)
}

// ---------------------------------------------------------------- the pane and the footer fallback

async function openPane($: $): Promise<{ isPlaced: true } | { isPlaced: false; reason?: string }> {
  const opened = await $.ui.open({ id: PANE_ID, title: 'Tier', columns: PANE_COLUMNS })
  return opened.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: (opened as { reason?: string }).reason }
}

async function openPaneFromPress($: $): Promise<void> {
  const opened = await openPane($).catch(async err => {
    await fail($, 'pane', err)
    return { isPlaced: false as const, reason: 'open failed' }
  })
  if (!opened.isPlaced) toast($, `Tier: the pane could not open (${opened.reason ?? 'no room'}) - try /tier-pane`)
}

/** The pane is open (the engine's record, so a reload still finds it). */
async function paneIsOpen($: $): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE_ID)
  } catch {
    return false
  }
}

/** The footer item and the card's button: the pane open -> close it, else open it. Recorded in the status file. */
async function togglePaneFromPress($: $, from: string): Promise<void> {
  await guard($, 'pane', async () => {
    const at = new Date().toISOString()
    if (await paneIsOpen($)) {
      const err = await safe($, 'pane', () => $.ui.close({ id: PANE_ID }))
      await record('press', `${from} at ${at}: closed the pane${err ? ` (failed: ${err})` : ''}`)
      return
    }
    await openPaneFromPress($)
    await record('press', `${from} at ${at}: opened the pane`)
  })()
}

/** The footer is not Tier's: open the pane by itself; not placed -> the status line. Recorded in the status file. */
async function footerIsTaken($: $, why: string): Promise<void> {
  if (footerTaken) return
  footerTaken = true
  await record('footer', `taken: ${why}`)
  const opened = await openPane($).catch(async err => {
    await fail($, 'pane', err)
    return { isPlaced: false as const, reason: err instanceof Error ? err.message : String(err) }
  })
  fallback = opened.isPlaced ? 'placed' : 'not-placed'
  await record('footer-fallback', opened.isPlaced ? 'pane opened' : `pane not placed (${opened.reason ?? 'no reason'}); status line`)
  await refreshStatus($)
}

/** ~5 s after the start (or a desktop attaching): a desktop is there and its footer never reached Tier -> taken. */
function armFooterCheck($: $): void {
  if (footerTimer || footerSeen || footerTaken) return
  footerTimer = $.clock.after(FOOTER_WAIT_MS, () => {
    footerTimer = undefined
    void safe($, 'footer', async () => {
      if (footerSeen || footerTaken) return
      const surfaces = await $.session.surfaces()
      if (surfaces.includes('desktop')) await footerIsTaken($, `no SessionMode render reached Tier within ${FOOTER_WAIT_MS / 1000} s`)
    })
  })
}

/** Today's records (every session's) for the hover card: the store read at most once a minute, the live atoms over it. */
async function todayRecords($: $, now: number, live: readonly TierRecord[]): Promise<TierRecord[]> {
  const day = dayKey(now)
  if (!todayCache || todayCache.day !== day || now - todayCache.at > 60_000) {
    const stored = await readLedger($, day, day)
    todayCache = { day, at: now, records: stored.records }
  }
  return mergeRecords(todayCache.records, live, day, day)
}

/** Today's records of every session: the store, the live atoms over it - what the strip and the footer both read. */
async function stripRecords($: $, now: number): Promise<TierRecord[]> {
  const live: TierRecord[] = [...((await $.state.get(HANDOFFS)).value ?? []), ...((await $.state.get(BLOCKS)).value ?? [])]
  return todayRecords($, now, live)
}

/** The footer's saving: the strip's figure (stripFigures over stripRecords), so the two never differ. */
async function stripSaved($: $, now: number): Promise<number> {
  return stripFigures(await stripRecords($, now)).saved
}

// ---------------------------------------------------------------- entry points the core's hooks call

/** session.start: /tier-pane, today's cache figures, the minute ticker, the footer check, the status line. */
export async function part2SessionStart($: $, rec?: (name: string, result: string) => Promise<unknown>): Promise<void> {
  recordFn = rec
  footerSeen = false
  footerTaken = false
  fallback = 'none'
  paneView = 'now'
  dismissed.clear()
  selfPressed.clear()
  todayCache = undefined
  cardRecorded = ''
  setMainTurnRunning(false)
  cancelKeepWarm()
  pingDepth = 0
  footerTimer?.cancel()
  footerTimer = undefined
  const reg = async (name: string, fn: () => Promise<unknown>) => {
    let result = 'ok'
    try {
      await fn()
    } catch (err) {
      result = err instanceof Error ? err.message : String(err)
    }
    // A registration that is not 'ok' is reported by the recorder (register.tsx recordRegistration).
    await record(name, result)
  }
  await reg('command:tier-pane', () => $.command.register({ name: PANE_COMMAND, description: 'Open the Tier pane: live helpers, blocks, spend and savings, the on/off switch.' }))
  // An older version's notice naming a statusLine (it survives a reload in $.state, and its store key) is dropped.
  await safe($, 'status line', async () => {
    await update($, NOTICES, list => visibleNotices(list))
    const seen = await $.store.get(OLD_HOOKS_SEEN_KEY)
    if (typeof seen === 'string' && /statusLine/.test(seen)) await $.store.delete(OLD_HOOKS_SEEN_KEY)
  })
  await safe($, 'cache meter', async () => {
    const today = (await $.store.get(CACHE_PREFIX + dayKey(await $.clock.now()))) as TierCacheDay | undefined
    await update($, METER, m => {
      const base: TierMeter = m ?? { phase: 'none' }
      return today ? { ...base, today } : base
    })
  })
  // Keep-warm: this session's switch ($.state outlives a reload of the session; a new session has none = off).
  // Nothing turns it on but the person's press; the shared store is not read.
  await safe($, 'keep-warm', async () => {
    keepWarmOn = (await $.state.get(KEEP_WARM)).value === true
    await update($, KEEP_WARM, () => keepWarmOn)
    await resumeKeepWarm($)
  })
  await safe($, 'ticker', async () => {
    tickTimer?.cancel()
    tickTimer = $.clock.every(60_000, () => void safe($, 'ticker', () => tick($)))
  })
  await safe($, 'footer', async () => armFooterCheck($))
  await safe($, 'status line', () => refreshStatus($))
}

/** turn.step: a real main-loop request starts, so the meter moves (and a turn runs: "Do it myself" is for it). */
export async function part2TurnStep($: $, e: { agentId?: string; model: string }): Promise<void> {
  // A keep-warm ping is not a real request: it neither moves the meter nor re-arms keep-warm.
  if (e.agentId === undefined && pingDepth === 0) {
    setMainTurnRunning(true)
    await safe($, 'cache meter', async () => {
      await onMainRequest($, e.model)
      await refreshStatus($)
    })
  }
}

/** turn.complete (any loop): the main context moved; the status line's totals moved; after a ping, the live check. */
export async function part2TurnComplete(
  $: $,
  agentId: string | undefined,
  usage?: { cache_read_input_tokens: number; cache_creation_input_tokens: number },
): Promise<void> {
  if (pingDepth > 0) return
  if (agentId === undefined) setMainTurnRunning(false)
  await safe($, 'cache meter', async () => {
    if (agentId === undefined) await checkAfterPing($, usage)
  })
  await safe($, 'cache meter', async () => {
    if (agentId === undefined) await onMainTurnEnd($)
    await refreshStatus($)
  })
}

// ---------------------------------------------------------------- drawing helpers

/** A labelled row: left text, right text (the page's `.kv`). */
function kv(E: Els, left: string, right: string, opts: { leftColor?: string; rightColor?: string; size?: TextProps['size'] } = {}) {
  const { Box, Text } = E
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text color={opts.leftColor ?? C.mut} size={opts.size}>
        {left}
      </Text>
      <Text color={opts.rightColor ?? C.ink} size={opts.size} tabular>
        {right}
      </Text>
    </Box>
  )
}

/** The page's switch: a plain Button `On`/`Off` (text style, dim when off) beside the 28 x 16 switch drawing. */
function onOff(D: DesktopEls, key: string, on: boolean, name: string, press: () => unknown) {
  const { Box, Button, Svg } = D
  return (
    <Box key={`${key}-switch`} flexDirection="row" alignItems="center" gap={1}>
      <Button key={key} plain dimColor={!on} onPress={() => void press()}>
        {on ? 'On' : 'Off'}
      </Button>
      {switchHit(D, `${key}-hit`, <Svg source={switchSvg(on)} alt={`${name} ${on ? 'on' : 'off'}`} width={28} height={16} />, 28, press)}
    </Box>
  )
}

/**
 * A switch drawing that takes the click: an Svg is not pressable (a Button's children may only be strings and Text),
 * so a blank plain Button (its label spaces, the drawing's width in cells) lies over it in an absolute Box.
 */
function switchHit(D: DesktopEls, key: string, svg: JSX.Element, px: number, press: () => unknown) {
  const { Box, Button } = D
  return (
    <Box key={`${key}-box`} flexShrink={0} flexDirection="row" alignItems="center">
      {svg}
      <Box key={key} position="absolute" top={0} bottom={0} left={0} right={0} alignItems="center" justifyContent="center">
        <Button key={`${key}-btn`} plain label={' '.repeat(svgCells(px))} hover={{ backgroundColor: '#00000000' }} onPress={() => void press()} />
      </Box>
    </Box>
  )
}

function ring(D: DesktopEls, size: number, c: CacheView) {
  return <D.Svg source={ringSvg(size, c.minutesLeft, c.ttlMinutes, c.state === 'none' ? 'cold' : c.state)} alt={c.card} width={size} height={size} />
}

// ---------------------------------------------------------------- register

export function registerPart2(on: On, settings: TierSettings): void {
  on('session.end', async ($, e, next) => {
    tickTimer?.cancel()
    tickTimer = undefined
    cancelKeepWarm()
    footerTimer?.cancel()
    footerTimer = undefined
    return next(e)
  }).catch(async ($, e, next) => {
    await hookFailed($, 'session.end', next.error)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    if (e.surface === 'desktop') await safe($, 'footer', async () => armFooterCheck($))
    return r
  }).catch(async ($, e, next) => {
    await hookFailed($, 'session.attach', next.error)
    return next(e)
  })

  on('command.run', { command: PANE_COMMAND }, async $ => {
    try {
      const opened = await openPane($)
      return opened.isPlaced ? { text: 'Tier pane opened.' } : {}
    } catch (err) {
      await fail($, 'pane', err)
      return {}
    }
  })

  // ---- 1. the footer pill: the engine's modes text kept, then only Text and plain Buttons (this slot draws no Box chrome, Svg or overlay).
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.surface !== 'desktop') return drawn
    if ((drawn as { type?: string } | null)?.type !== 'engine') {
      // Another mod beneath draws the footer: leave its tree untouched, fall back (outside the render).
      if (!footerTaken) {
        try {
          $.clock.after(0, () => void safe($, 'footer', () => footerIsTaken($, 'another mod draws the footer (SessionMode)')))
        } catch {
          // the 5 s check still runs
        }
      }
      return drawn
    }
    if (!footerSeen) {
      footerSeen = true
      // The status line repeats this item on the desktop: cleared at once (outside the render).
      try {
        $.clock.after(0, () => void safe($, 'status line', () => refreshStatus($)))
      } catch {
        // the minute tick clears it
      }
    }
    const D = $.ui.resolve(e) as DesktopEls
    const { Box, Text, Button } = D
    const now = await $.clock.now()
    const meter = (await $.state.get(METER)).value ?? { phase: 'none' as const }
    // The saving from the strip's ONE source (stripFigures over today's merged records): footer = strip, always.
    const saved = await stripSaved($, now)
    const broken = await brokenParts($)
    const c = cacheView(meter, now)
    const detail = footerText(saved, c, broken)
    // The app's own button: a NON-plain Button, no `label` (a label is drawn truncated with a tooltip instead of the
    // children), the hover scope with a background that reveals the card. Children: "Tier", a dim Text, the glyph in
    // its own dim Text (size heading), a dim Text with the minutes. Nothing after the Button.
    const split = footerSplit(detail)
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        {e.props.modes.length > 0 ? <Text dimColor>{e.props.modes.join(' & ')}</Text> : null}
        <Button key="tier-chip" hover={{ scope: PILL_SCOPE, backgroundColor: C.sb }} onPress={() => togglePaneFromPress($, 'footer')}>
          {'Tier'}
          <Text dimColor>{' · ' + (split ? split.lead + ' · ' : detail)}</Text>
          {split ? <Text dimColor size="heading">{split.glyph}</Text> : null}
          {split ? <Text dimColor>{' ' + split.rest}</Text> : null}
        </Button>
      </Box>
    )
  }).catch(async ($, e, next) => {
    await hookFailed($, 'SessionMode', next.error)
    return next(e)
  })

  // ---- 2. the hover strip: drawn hidden in the band above the prompt, revealed while the pill (same scope) is hovered.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const drawn = await next(e)
    // Not gated on the footer having been drawn: the band can be asked first, and a hidden strip costs no row.
    if (e.surface !== 'desktop' || e.props.hasSurvey || footerTaken) return drawn
    const D = $.ui.resolve(e) as DesktopEls
    const { Box, Text, Button, Svg } = D
    const now = await $.clock.now()
    const meter = (await $.state.get(METER)).value ?? { phase: 'none' as const }
    // ONE source for every figure of the strip (and the footer's): today's records of every session.
    const f = stripFigures(await stripRecords($, now))
    const c = cacheView(meter, now)
    const kwOn = (await $.state.get(KEEP_WARM)).value ?? keepWarmOn
    const ct = stripCacheText(c, kwOn, meter.keepWarm, now)
    const sub = stripSavedSub(f)
    const lg2 = stripLegendSpans(f.rows, 2)
    const lg1 = stripLegendSpans(f.rows, 1)
    const join = (s: readonly { text: string }[]) => s.map(x => x.text).join('')
    const texts: StripTexts = { saved: money(f.saved), sub: join(sub), head: `By layer · ${money(f.spent)}`, legend2: join(lg2), legend1: join(lg1), cacheTitle: ct.title, cacheTitleShort: ct.short, cacheSub: ct.sub }
    // The surface drops a band tree taller than maxRows whole, without a word: the strip fits maxRows, and a CELL
    // budget of the band's bodyColumns (every Text one line): the mark goes first, then the legend shortens, then goes.
    const maxRows = typeof e.props.maxRows === 'number' ? e.props.maxRows : STRIP_ROWS
    const columns = typeof e.props.bodyColumns === 'number' ? e.props.bodyColumns : Number.POSITIVE_INFINITY
    const plan = stripPlan(columns, maxRows, texts)
    const legendCut = texts.legend2 !== '' && plan.legend < 2 && !(plan.legend === 1 && texts.legend1 === texts.legend2)
    const dropped = [...(plan.mark ? [] : ['mark']), ...(legendCut ? [plan.legend === 1 ? 'legend past the top layer' : 'legend'] : []), ...(plan.cacheShort ? ['cache minutes (in the ring)'] : [])]
    const line = plan.fits
      ? `drawn hidden in AbovePrompt (strip across the band, ${plan.rows} rows, maxRows ${maxRows}, ${plan.columns} of ${Number.isFinite(columns) ? columns : '?'} columns${plan.over ? `, ${plan.over} over (Texts truncate)` : ''}${dropped.length ? `, left out: ${dropped.join(', ')}` : ''}), revealed by hover scope ${PILL_SCOPE} shared with the footer`
      : `not drawn: the band has ${maxRows} rows, the strip needs ${plan.rows}`
    if (line !== cardRecorded) {
      cardRecorded = line
      // The reveal itself happens on the surface (no hook runs): the file says the strip is in place, and how.
      void record('hover-card', `${line}; at ${new Date().toISOString()}`)
    }
    if (!plan.fits) return drawn
    const w = plan.widths
    const rule = (key: string) => (
      <Box key={`tier-card-rule-${key}`} flexDirection="row" alignItems="center" width={1 + 2 * STRIP_GAP} paddingX={STRIP_GAP} flexShrink={0}>
        <Svg source={vruleSvg(STRIP_RULE_PX)} alt="│" width={1} height={STRIP_RULE_PX} />
      </Box>
    )
    const byLayer: Record<Layer, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
    for (const r of f.rows) byLayer[r.layer] = r.usd
    const barPx = cellsPx(w.spend)
    const lg = plan.legend === 2 ? lg2 : plan.legend === 1 ? lg1 : []
    const tier = stripTier(columns)
    const ringCells = svgCells(tier.ringPx)
    // ONE row across the app's own grey band (no box, border or background of ours): each section a fixed number of
    // cells, 1px hairlines with a cell either side, the actions at the right edge. Every Text one line (truncate-end,
    // never wrap); a line of two colours is ONE Text with nested spans. Buttons plain, no label prop.
    return (
      <Box flexDirection="column">
        {drawn}
        <Box key="tier-card" display="none" hover={{ scope: PILL_SCOPE, display: 'flex' }} flexDirection="row" alignItems="center" width="100%" paddingX={STRIP_BAND_PAD}>
          {plan.mark ? (
            <Box key="tier-card-mark" flexDirection="row" alignItems="center" width={w.mark} flexShrink={0}>
              <Svg source={markSvg(tier.markPx)} alt="Tier" width={tier.markPx} height={tier.markPx} />
            </Box>
          ) : null}
          {plan.mark ? rule('mark') : null}
          <Box key="tier-card-saved" flexDirection="column" width={w.saved} flexShrink={0}>
            <Text color={C.mut} size={tier.label} wrap="truncate-end">
              Saved today
            </Text>
            <Text color={C.saved} size={tier.figure} tabular wrap="truncate-end">
              {money(f.saved)}
            </Text>
            <Text size={tier.label} tabular wrap="truncate-end">
              {sub.map((x, i) => (
                <Text key={`tier-card-sub-${i}`} color={x.color}>
                  {x.text}
                </Text>
              ))}
            </Text>
          </Box>
          {rule('saved')}
          <Box key="tier-card-spend" flexDirection="column" width={w.spend} flexShrink={0}>
            <Text size={tier.primary} tabular wrap="truncate-end">
              <Text color={C.mut}>{'By layer · '}</Text>
              <Text color={C.ink}>{money(f.spent)}</Text>
            </Text>
            <Svg source={stackBarSvg(barPx, STRIP_BAR_H, byLayer)} alt={`Spend by layer: ${f.rows.map(r => `${r.name} ${money(r.usd)}`).join(', ')}`} width={barPx} height={STRIP_BAR_H} />
            {lg.length > 0 ? (
              <Text size={tier.label} tabular wrap="truncate-end">
                {lg.map((x, i) => (
                  <Text key={`tier-card-legend-${i}`} color={x.color}>
                    {x.text}
                  </Text>
                ))}
              </Text>
            ) : null}
          </Box>
          {rule('spend')}
          <Box key="tier-card-cache" flexDirection="row" alignItems="center" gap={1} width={w.cache} flexShrink={0}>
            <Box flexDirection="row" alignItems="center" width={ringCells} flexShrink={0}>
              <Svg source={stripRingSvg(c.minutesLeft, c.ttlMinutes, c.state)} alt={c.card} width={tier.ringPx} height={tier.ringPx} />
            </Box>
            <Box flexDirection="column" width={Math.max(1, w.cache - ringCells - 1)}>
              <Text color={C.ink} size={tier.primary} wrap="truncate-end">
                {plan.cacheShort ? ct.short : ct.title}
              </Text>
              <Text color={C.mut} size={tier.label} tabular wrap="truncate-end">
                {ct.sub}
              </Text>
            </Box>
          </Box>
          <Box key="tier-card-push" flexGrow={1} />
          {rule('actions')}
          <Box key="tier-card-actions" flexDirection="column" alignItems="flex-end" width={w.actions} flexShrink={0}>
            <Box flexDirection="row" alignItems="center" gap={1}>
              {switchHit(D, 'tier-card-keepwarm-switch', <Svg source={stripSwitchSvg(kwOn)} alt={`Keep warm ${kwOn ? 'on' : 'off'}`} width={STRIP_SWITCH_PX} height={16} />, STRIP_SWITCH_PX, () =>
                pressKeepWarm($, 'card'),
              )}
              <Button key="tier-card-keepwarm" plain onPress={() => pressKeepWarm($, 'card')}>
                Keep warm
              </Button>
            </Box>
          </Box>
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) => {
    await hookFailed($, 'AbovePrompt', next.error)
    return next(e)
  })

  // ---- 3. the hand-off strip under each Agent row (live while running). The tag shows once: in the engine's row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.props.tool !== 'Agent') return drawn
    const handoffs = (await $.state.get(HANDOFFS)).value ?? []
    const id = e.props.tool_use_id || e.requestId
    const rec = handoffs.find(x => x.id === id)
    if (!rec) return drawn
    const v = stripView(rec, handoffs, await $.clock.now())
    if (e.surface !== 'desktop') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {drawn}
          {v.failed ? <Text color="warning">{stripLine(v)}</Text> : <Text dimColor>{stripLine(v)}</Text>}
        </Box>
      )
    }
    const { Box, Text, Svg } = $.ui.resolve(e) as DesktopEls
    return (
      <Box flexDirection="column">
        {drawn}
        <Box key="tier-strip" flexDirection="row" alignItems="center" gap={2} paddingX={1} backgroundColor={C.s1} borderStyle="round" borderColor={C.sb}>
          <Svg source={runStack(v.layer, v.failed)} alt={v.modelEffort} width={12} height={12} />
          <Text color={C.ink}>{v.modelEffort}</Text>
          {v.tryText ? <Text color={C.mut}>{v.tryText}</Text> : null}
          {v.check ? (
            <Box flexDirection="row" alignItems="center" gap={1}>
              {v.check.ok ? <Svg source={iconSvg('ok', C.mut)} alt="check passed" width={12} height={12} /> : null}
              <Text color={v.check.ok ? C.mut : C.fault}>{v.check.text}</Text>
            </Box>
          ) : null}
          {v.escalated ? (
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Svg source={iconSvg('up', C.t2)} alt="escalated" width={12} height={12} />
              <Text color={C.ink}>{v.escalated}</Text>
            </Box>
          ) : null}
          {v.cutOff ? <Text color={C.fault}>cut off</Text> : null}
          {v.elapsed ? (
            <Text color={C.mut} tabular>
              {v.elapsed}
            </Text>
          ) : null}
          {v.unverifiable ? <Text color={C.mut}>unverifiable</Text> : null}
          <Box flexGrow={1} />
          {v.cost ? (
            <Text color={C.ink} tabular>
              {v.cost}
            </Text>
          ) : null}
          {v.saved ? (
            <Text color={C.saved} tabular>
              {v.saved}
            </Text>
          ) : null}
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) => {
    await hookFailed($, 'ToolUse', next.error)
    return next(e)
  })

  // ---- 4. a Tier refusal's result: drawn instead of the raw error text, on the desktop only.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || !e.props.isErrored) return next(e)
    const id = e.props.tool_use_id || e.requestId
    const out = e.props.output
    if (typeof out === 'string' && !out.trimStart().startsWith('Tier:')) return next(e)
    const blocks = (await $.state.get(BLOCKS)).value ?? []
    const b = blocks.find(x => x.id === `block:${id}`)
    if (!b || b.action === 'would-refuse') return next(e)
    const main = (await $.state.get(MAIN)).value
    const gate: TierGate | undefined = (await $.state.get(GATE)).value
    const v = refusalView(b, main?.model, (await readMeter($)).ttl, main?.contextTokens)
    const { Box, Text, Button, Svg } = $.ui.resolve(e) as DesktopEls
    if (v.kind === 'line') {
      return (
        <Box key="tier-handoff-line" flexDirection="row" alignItems="center" gap={1}>
          <Svg source={stopStack()} alt="hand-off stopped" width={12} height={12} />
          <Text color={C.mut}>{v.text}</Text>
        </Box>
      )
    }
    if (dismissed.has(id)) {
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={v.tile === 'down' ? runStack(1) : runStack(3)} alt="Tier" width={12} height={12} />
          <Text color={C.mut}>{`${v.title}${v.titleTail ?? ''}`}</Text>
        </Box>
      )
    }
    const allowed = v.tag !== undefined && (gate?.allowMaxTags ?? []).includes(v.tag)
    const tag = v.tag
    return (
      <Box key="tier-refusal" flexDirection="row" alignItems="center" gap={2} padding={1} backgroundColor={C.s2} borderStyle="round" borderColor={C.rb}>
        <Svg source={refusalTile(v.tile)} alt={v.title} width={44} height={44} />
        <Box flexDirection="column" flexGrow={1}>
          <Text color={C.ink} weight="medium">
            {v.title}
            {v.titleTail ? (
              <Text color={C.mut} weight="regular">
                {v.titleTail}
              </Text>
            ) : null}
          </Text>
          <Text color={C.mut} size="footnote" tabular>
            {v.detail}
            {v.savedText ? <Text color={C.saved}>{` · ${v.savedText}`}</Text> : null}
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {v.buttons === 'self' && !selfPressed.has(id) ? (
            <Button
              key={`tier-self-${id}`}
              plain
              dimColor
              onPress={guard($, 'override button', async () => {
                const when = await pressDoItMyself($)
                selfPressed.add(id)
                toast($, when === 'current' ? 'Tier: you do it - the work gate is off for this message.' : 'Tier: you do it - the work gate is off for your next message.')
                $.ui.invalidate('ui.render')
              })}
            >
              Do it myself
            </Button>
          ) : null}
          {v.buttons === 'self' && selfPressed.has(id) ? <Text color={C.mut}>Claude does it this message</Text> : null}
          {v.buttons === 'self' ? (
            <Box borderStyle="round" borderColor={C.t3} paddingX={1}>
              <Button key={`tier-open-${id}`} plain onPress={guard($, 'pane', () => openPaneFromPress($))}>
                Open Tier
              </Button>
            </Box>
          ) : null}
          {v.buttons === 'max' && tag !== undefined && !allowed ? (
            <Box borderStyle="round" borderColor={C.t3} paddingX={1}>
              <Button
                key={`tier-allow-${id}`}
                plain
                onPress={guard($, 'override button', async () => {
                  await pressAllowMax($, tag)
                  toast($, `Tier: max effort and Fable allowed for [t=${tag}] for this session.`)
                  $.ui.invalidate('ui.render')
                })}
              >
                Allow max
              </Button>
            </Box>
          ) : null}
          {v.buttons === 'max' && allowed ? <Text color={C.mut}>{`Allowed for [t=${tag}] this session`}</Text> : null}
        </Box>
        <Button
          key={`tier-x-${id}`}
          plain
          dimColor
          role="dismiss"
          onPress={guard($, 'refusal card', () => {
            dismissed.add(id)
            $.ui.invalidate('ui.render')
          })}
        >
          ×
        </Button>
      </Box>
    )
  }).catch(async ($, e, next) => {
    await hookFailed($, 'ToolResult', next.error)
    return next(e)
  })

  // ---- 5. the side pane: Now | Today | 7 days; desktop draws the design, other surfaces the same sections as text.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const now = await $.clock.now()
    const meter = (await $.state.get(METER)).value ?? { phase: 'none' as const }
    const handoffs = (await $.state.get(HANDOFFS)).value ?? []
    const blocks = (await $.state.get(BLOCKS)).value ?? []
    const totals = (await $.state.get(TOTALS)).value
    const health = (await $.state.get(HEALTH)).value
    const broken = [...new Set(liveErrors(health?.errors).map(x => x.part))]
    const notices = visibleNotices((await $.state.get(NOTICES)).value)
    const enforce = (await $.state.get(ENFORCE)).value ?? settings.enforce
    const kwOn = (await $.state.get(KEEP_WARM)).value ?? keepWarmOn
    const pressKw = () => pressKeepWarm($, 'pane')
    const room = Math.max(3, Math.min(12, (e.props.scroll?.bodyRows ?? 24) - 14))
    const view = paneView

    // The view's records and totals.
    const toDay = dayKey(now)
    let records: TierRecord[]
    let t: TierTotals
    let byTag: TagRow[]
    let rangeBlocks: TierBlock[]
    let points: StrataPoint[]
    let rolled: readonly TierDaySummary[] = []
    if (view === 'now') {
      records = [...handoffs, ...blocks]
      const r = rangeView(records, [])
      t = totals?.session ?? r.totals
      byTag = r.byTag
      rangeBlocks = blocks
      points = strataPoints(records, now, 'hour')
    } else {
      const fromDay = view === 'today' ? toDay : shiftDay(toDay, -6)
      const stored = await readLedger($, fromDay, toDay)
      records = mergeRecords(stored.records, [...handoffs, ...blocks], fromDay, toDay)
      const r = rangeView(records, stored.summaries)
      rolled = stored.summaries
      t = r.totals
      byTag = r.byTag
      rangeBlocks = r.blocks
      points = view === 'today' ? strataPoints(records, now, 'hour') : strataPoints(records, now, { days: Array.from({ length: 7 }, (_, i) => shiftDay(fromDay, i)) }, rolled)
    }
    const heroLabel = view === 'now' ? 'Saved this session' : view === 'today' ? 'Saved today' : 'Saved · last 7 days'
    const f = heroFigures(t)
    const heroSub = f.mainOnly !== undefined && f.pct !== undefined ? `−${f.pct}% vs ${money(f.mainOnly)} main session only` : `${money(f.spent)} on helpers · est.`
    const layers = layerRows(records, rolled)
    const running = handoffs.filter(x => x.outcome === 'running')
    const ladder = ladderFor(handoffs)
    const c = cacheView(meter, now)
    const bc = blockCounts(rangeBlocks, rolled.reduce((a, x) => a + x.blocks, 0))
    const stopped = stoppedTitle(view)
    // The pane's real width in cells (the Pane's bodyColumns; the requested width when the host gave none).
    const cols = typeof e.props.bodyColumns === 'number' && e.props.bodyColumns > 0 ? e.props.bodyColumns : PANE_COLUMNS
    const rulePx = cellsPx(cols)
    // A section pads 2 cells each side; the charts fill what is left (never past it, never past the design's 420).
    const chartPx = Math.min(420, Math.max(60, cellsPx(cols - 4)))

    const setView = (v: PaneView) =>
      guard($, 'pane', () => {
        paneView = v
        $.ui.invalidate('ui.render')
      })
    const toggle = guard($, 'enforce switch', async () => {
      await setEnforce($, !enforce)
      toast($, !enforce ? 'Tier: enforcement on - the gates refuse.' : 'Tier: enforcement off - the gates only record.')
      $.ui.invalidate('ui.render')
    })
    const close = guard($, 'pane', () => $.ui.close({ id: PANE_ID }))
    const views: [PaneView, string, string][] = [
      ['now', 'view-now', 'Now'],
      ['today', 'view-today', 'Today'],
      ['7d', 'view-7d', '7 days'],
    ]
    const runningLabel = (x: TierHandoff) => `${x.tag ?? x.title ?? x.helperType}`

    if (e.surface !== 'desktop') {
      const { Box, Text, Button } = $.ui.resolve(e)
      const blockLine = (b: TierBlock) => <Text dimColor>{`${b.action} ${b.tool} (${b.gate}) · ${b.toast}`}</Text>
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>Tier</Text>
            {views.map(([v, key, label]) =>
              view === v ? <Button key={key} variant="primary" label={label} onPress={setView(v)} /> : <Button key={key} label={label} onPress={setView(v)} />,
            )}
          </Box>
          <Text bold>{view === 'now' ? 'This session' : view === 'today' ? 'Today' : 'Last 7 days'}</Text>
          <Text>{`${heroLabel}: ${money(f.saved)} est. · ${heroSub}`}</Text>
          <Text>{`${t.handoffs} helpers ${money(t.spentUsd)} · ${formatTokens(t.tokensKeptOut)} kept out · ${t.escalations} escalations · ${t.checkFailed} checks failed`}</Text>
          <Text>{`Layers: ${layers.map(l => `${l.name} ${l.runs} ${money(l.usd)}`).join(' · ')}`}</Text>
          <Text bold>Running</Text>
          {running.length === 0 ? (
            <Text dimColor>No helper running.</Text>
          ) : (
            running.slice(-room).map(x => <Text>{`${runningLabel(x)} · ${modelFamily(x.model) ?? x.model} · ${formatElapsed(now - x.at)} · ${money(x.costUsd ?? 0)}`}</Text>)
          )}
          {ladder ? <Text>{ladderText(ladder)}</Text> : null}
          <Text bold>Cache</Text>
          <Text>{cacheLine(meter, now)}</Text>
          {meter.rebuildUsd !== undefined ? <Text dimColor>{`Rebuild if it goes cold ${money(meter.rebuildUsd)} · context ${formatTokens(meter.contextTokens)}`}</Text> : null}
          <Button key="keepwarm" label={kwOn ? 'Keep warm on' : 'Keep warm off'} onPress={pressKw} />
          {kwOn ? <Text dimColor>{keepWarmLine(meter.keepWarm, meter.today, now, { contextTokens: meter.contextTokens, model: meter.mainModel, ttl: meter.ttl })}</Text> : null}
          <Text bold>{`${stopped} ${bc.total}`}</Text>
          <Text dimColor>{STOPPED_SUB}</Text>
          {bc.chips.length > 0 ? <Text>{bc.chips.map(x => `${x.label} ${x.n}`).join(' · ')}</Text> : <Text dimColor>None.</Text>}
          {rangeBlocks.slice(-room).reverse().map(blockLine)}
          {byTag.length > 0 ? <Text bold>By task</Text> : null}
          {byTag.slice(0, room).map(g => <Text>{`[t=${g.tag}] ${g.count} · ${money(g.usd)} · saved ${money(g.savedUsd)}`}</Text>)}
          <Button key="enforce" label={enforce ? 'Enforcement on' : 'Enforcement off'} onPress={toggle} />
          {broken.length > 0 ? <Text color="error">{`Tier · ${pausedText(broken)}`}</Text> : null}
          {notices.map(n => (
            <Text color="warning">{n.text}</Text>
          ))}
        </Box>
      )
    }

    const D = $.ui.resolve(e) as DesktopEls
    const { Box, Text, Button, Svg } = D
    const sec = (key: string, children: JSX.Element) => (
      <Box key={key} flexDirection="column">
        <Svg source={hairSvg(rulePx, C.hl)} alt="" width={rulePx} height={1} />
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          {children}
        </Box>
      </Box>
    )
    const col = (w: number, text: string, color: string, right = false) => (
      <Box width={w} justifyContent={right ? 'flex-end' : 'flex-start'}>
        <Text color={color} tabular>
          {text}
        </Text>
      </Box>
    )
    return (
      <Box flexDirection="column" backgroundColor={C.s1}>
        <Box key="header" flexDirection="row" alignItems="center" gap={1} paddingX={2} paddingY={1}>
          <Svg source={markSvg(16)} alt="Tier" width={16} height={16} />
          <Text color={C.ink} weight="medium">
            Tier
          </Text>
          <Box flexGrow={1} />
          {/* the page's `.seg`: a dark track, the chosen view on a lighter chip; plain Buttons (text style) */}
          <Box key="seg" flexDirection="row" backgroundColor={C.s2}>
            {views.map(([v, key, label]) =>
              view === v ? (
                <Box key={`seg-${v}`} backgroundColor={C.line} paddingX={1}>
                  <Button key={key} plain onPress={setView(v)}>
                    {label}
                  </Button>
                </Box>
              ) : (
                <Box key={`seg-${v}`} paddingX={1}>
                  <Button key={key} plain dimColor onPress={setView(v)}>
                    {label}
                  </Button>
                </Box>
              ),
            )}
          </Box>
          <Button key="pane-close" plain dimColor role="dismiss" onPress={close}>
            ×
          </Button>
        </Box>
        {sec(
          'hero',
          <Box flexDirection="column">
            <Text color={C.mut} size="footnote" weight="medium">
              {heroLabel}
            </Text>
            <Box flexDirection="row" alignItems="flex-end" gap={2}>
              <Text color={C.saved} size="title" weight="regular" tabular>
                {money(f.saved)}
              </Text>
              <Text color={C.mut} tabular>
                {heroSub}
              </Text>
            </Box>
            <Svg source={strataSvg(points, `${money(f.spent)} by now`, chartPx)} alt={`Cumulative helper spend by layer: ${money(f.spent)}`} width={chartPx} height={120} />
          </Box>,
        )}
        {sec(
          'layers',
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {col(2, '', C.mut)}
              {col(20, 'Layer', C.mut)}
              {col(6, 'runs', C.mut, true)}
              {col(9, 'spend', C.mut, true)}
            </Box>
            {layers.map(l => (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box width={2}>
                  <Svg source={swatchSvg(rampColor(l.layer))} alt={l.name} width={10} height={10} />
                </Box>
                {col(20, l.name, l.runs === 0 ? C.mut : C.ink)}
                {col(6, String(l.runs), l.runs === 0 ? C.mut : C.ink, true)}
                {col(9, money(l.usd), l.runs === 0 ? C.mut : C.ink, true)}
              </Box>
            ))}
          </Box>,
        )}
        {sec(
          'running',
          <Box flexDirection="column">
            <Text color={C.mut} size="footnote" weight="medium">
              Running
            </Text>
            {running.length === 0 ? <Text color={C.mut}>No helper running.</Text> : null}
            {running.slice(-room).map(x => (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box width={2}>
                  <Svg source={runStack(layerOf(modelFamily(x.model)))} alt={modelFamily(x.model) ?? x.model} width={12} height={12} />
                </Box>
                <Box flexGrow={1}>
                  <Text color={C.ink}>
                    {runningLabel(x)}
                    <Text color={C.mut}>{` · ${modelFamily(x.model) ?? x.model}`}</Text>
                  </Text>
                </Box>
                {col(8, formatElapsed(now - x.at), C.mut, true)}
                {col(9, money(x.costUsd ?? 0), C.ink, true)}
              </Box>
            ))}
          </Box>,
        )}
        {ladder
          ? sec(
              'ladder',
              <Box flexDirection="column">
                {kv(D, `Ladder · ${ladder.tag}`, '↑ climbs', { size: 'footnote' })}
                <Svg source={ladderSvg(ladder.rungs, chartPx)} alt={ladderText(ladder)} width={chartPx} height={ladder.rungs.length * 30} />
              </Box>,
            )
          : null}
        {sec(
          'cache',
          <Box flexDirection="row" alignItems="center" gap={2}>
            {ring(D, 32, c)}
            <Box flexDirection="column" flexGrow={1}>
              <Text color={c.state === 'low' ? C.warn : C.ink} tabular>
                {paneCacheText(c)}
              </Text>
              {c.state === 'none' ? <Text color={C.mut}>{WAITING_TEXT}</Text> : null}
              <Box flexDirection="row" alignItems="center" justifyContent="space-between">
                <Text color={C.ink}>Keep warm</Text>
                {onOff(D, 'keepwarm', kwOn, 'Keep warm', pressKw)}
              </Box>
              {kwOn ? (
                <Text color={C.mut} size="footnote" tabular>
                  {keepWarmLine(meter.keepWarm, meter.today, now, { contextTokens: meter.contextTokens, model: meter.mainModel, ttl: meter.ttl })}
                </Text>
              ) : null}
            </Box>
          </Box>,
        )}
        {sec(
          'blocks',
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              {kv(D, stopped, String(bc.total), { leftColor: C.ink })}
              <Text color={C.mut} size="footnote">
                {STOPPED_SUB}
              </Text>
            </Box>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {bc.chips.map(x => (
                <Box borderStyle="round" borderColor={C.line} paddingX={1}>
                  <Text color={C.ink} size="footnote">{`${x.label} ${x.n}`}</Text>
                </Box>
              ))}
            </Box>
          </Box>,
        )}
        {sec(
          'enforce',
          <Box flexDirection="row" alignItems="center" justifyContent="space-between">
            <Box flexDirection="column">
              <Text color={C.ink}>Enforcement</Text>
              <Text color={C.mut} size="footnote">
                Refuse calls that break the rules
              </Text>
            </Box>
            {onOff(D, 'enforce', enforce, 'Enforcement', toggle)}
          </Box>,
        )}
        {broken.length > 0 ? sec('errors', <Text color={C.fault}>{`Tier · ${pausedText(broken)} - it lets calls through`}</Text>) : null}
        {notices.length > 0
          ? sec(
              'notices',
              <Box flexDirection="column">
                {notices.map(n => (
                  <Text color={C.warn}>{n.text}</Text>
                ))}
              </Box>,
            )
          : null}
        {/* Not on the approved page: kept last, three tasks at most, so it never crowds the design above. */}
        {byTag.length > 0
          ? sec(
              'tasks',
              <Box flexDirection="column">
                <Text color={C.mut} size="footnote" weight="medium">
                  By task
                </Text>
                {byTag.slice(0, Math.min(3, room)).map(g => kv(D, `[t=${g.tag}] · ${g.count}`, `${money(g.usd)} · saved ${money(g.savedUsd)}`))}
              </Box>,
            )
          : null}
      </Box>
    )
  }).catch(async ($, e, next) => {
    await hookFailed($, 'Pane', next.error)
    return next(e)
  })
}
