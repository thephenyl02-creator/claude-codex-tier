// Part 2 through the engine: the meter, /tier-pane, the five screen components on the desktop and the text
// fallbacks, the override Buttons and their notes, stale errors and the old statusLine notice.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { StripSize, StripTexts } from './part2'
import type { TierBlock, TierGate, TierHandoff, TierHealthError, TierNotice, TierOverrideNote, TierRecord } from '../types'
import { C, barWidths, ladderSvg, ringSvg, stackBarSvg, strataSvg, stripRingSvg, stripSwitchSvg } from './art'
import { SUMMARY_KEY, recordKey } from './core'
import { KEEP_WARM_MIN_CONTEXT, PING_EVERY_MS, keepWarmDecision, nextPingDueMs } from './cache'
import { doItMyselfNote, allowMaxNote, splitNotes } from './override'
import {
  PANE_COLUMNS,
  STRIP_ROWS,
  stripCacheText,
  stripFigures,
  stripPlan,
  stripTier,
  stripLegendSpans,
  textCells,
  CELLS_PER_CHAR,
  svgCells,
  cellsPx,
  STRIP_TARGET,
  STRIP_SAFETY,
  STRIP_ACTION_CELLS,
  STRIP_BAND_PAD,
  STRIP_MARK_PX,
  STRIP_RING_PX,
  STRIP_SWITCH_PX,
  SVG_PX_PER_CELL,
  stripSavedSub,
  footerText,
  FOOTER_MAX_CHARS,
  footerDetail,
  footerSplit,
  PILL_SCOPE,
  blockCounts,
  keepWarmLine,
  warmVerdictFirstRequest,
  warmVerdictTurnTotal,
  paneCacheText,
  cacheGlyph,
  footerSavedText,
  cacheView,
  formatElapsed,
  formatSmallUsd,
  heroFigures,
  ladderFor,
  layerRows,
  mergeRecords,
  rangeView,
  refusalView,
  statusText,
  strataPoints,
  stripLine,
  stripView,
} from './part2'
import { liveErrors, visibleNotices } from './state'

const OPUS = 'claude-opus-5-5'
const MIN = 60_000
/** 2026-10-24 09:00 local. */
const T0 = new Date(2026, 9, 24, 9, 0, 0).getTime()

type World = {
  clock: ReturnType<typeof mock.clock>
  status: (string | undefined)[]
  commands: string[]
  tools: string[]
  opened: { id: string; columns?: number }[]
  closed: string[]
  toasts: string[]
  writes: { path: string; text: string }[]
  store: Map<string, unknown>
  /** The context each prompt.submit carried to the model. */
  promptContext: (readonly string[] | undefined)[]
  /** Keep-warm pings ($.model.fork) the plugin sent, by clock time. */
  forks: number[]
  /** What session.usage answers (tests move it). */
  usage: { tokens: number; fivePct: number; subscription: boolean }
  /** What the next real main request's turn.step reports as its own usage (null = none reported). */
  stepUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string } | null
  /** What the next fork answers: a reply, or a failure. */
  forkReply: 'ok' | 'api-error'
  /** What the plugin last wrote to its $.state keys. */
  seen: { gate?: TierGate; health?: { errors: TierHealthError[] }; overrideNotes?: TierOverrideNote[]; notices?: TierNotice[] }
}

/** What the plugin last wrote to its per-session keep-warm switch ($.state; the shared store never holds it). */
const kwState = (w: World) => (w.seen as Record<string, unknown>).keepWarm

function engine(on: On, o: { surfaces?: string[]; placed?: boolean; storeBroken?: () => boolean; store?: Record<string, unknown>; state?: Record<string, unknown>; onFork?: () => Promise<void> } = {}): World {
  const world: World = {
    clock: mock.clock(on, { now: T0 }),
    status: [],
    commands: [],
    tools: [],
    opened: [],
    closed: [],
    toasts: [],
    writes: [],
    store: new Map(Object.entries(o.store ?? {})),
    promptContext: [],
    forks: [],
    usage: { tokens: 300_000, fivePct: 10, subscription: true },
    forkReply: 'ok',
    stepUsage: null,
    seen: {},
  }
  const seen = world.seen as Record<string, unknown>
  // $.state an older load left behind (it survives a reload): answered until the plugin writes the key.
  const preset = new Map(Object.entries(o.state ?? {}))
  on('state.get', (_, e, next) => (e.plugin === 'tier-mod' && preset.has(e.key) ? { value: { value: preset.get(e.key), version: 0 } as never } : next(e)))
  on('state.set', (_, e, next) => {
    if (e.plugin === 'tier-mod') {
      seen[e.key] = e.value
      preset.delete(e.key)
    }
    return next(e)
  })
  const store = world.store
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    if (o.storeBroken?.()) throw new Error('store gone')
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, { USERPROFILE: '/home' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.surfaces', () => ({ value: (o.surfaces ?? []) as never }))
  on('fs.read', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('fs.write', (_, e) => {
    world.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.root', () => ({ value: '/proj' }))
  on('command.register', (_, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_, e) => {
    world.tools.push(e.name)
    return { value: { tool: `mcp__tier-mod__${e.name}` } }
  })
  on('ui.status', (_, e) => {
    world.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    world.opened.push({ id: e.id, ...(e.columns !== undefined ? { columns: e.columns } : {}) })
    return { value: o.placed === false ? { isPlaced: false as const, reason: 'too narrow' } : { isPlaced: true as const } }
  })
  on('ui.close', (_, e, next) => {
    world.closed.push(e.id)
    return next(e)
  })
  // the engine's record of open panes: an id opened more often than closed
  on('ui.panes', () => {
    const ids = [...new Set(world.opened.map(x => x.id))]
    const open = ids.filter(id => world.opened.filter(x => x.id === id).length > world.closed.filter(x => x === id).length)
    return { value: open.map(id => ({ id, title: 'Tier', isShown: true, isFocused: false, isPlaced: true })) as never }
  })
  on('session.usage', () => ({
    value: {
      startedAt: T0,
      context: { tokens: world.usage.tokens, window: 1_000_000 },
      rateLimits: world.usage.subscription ? [{ kind: 'five_hour', percentUsed: world.usage.fivePct }] : [],
    } as never,
  }))
  on('model.fork', async () => {
    world.forks.push(await world.clock.now())
    await o.onFork?.()
    // a ping reads the whole context from the cache: its cost is exactly context x the read price
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: world.usage.tokens, cache_creation_input_tokens: 0 }
    return { value: (world.forkReply === 'ok' ? { isAnswered: true, text: 'OK', usage } : { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage }) as never }
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: world.stepUsage }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    world.promptContext.push(e.context)
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-5-5', agentId: `agent-${e.tool_use_id}` }))
  return world
}

/** The engine's own drawing beneath the plugin (core answers `{ type: 'engine', ref }`). */
function engineDraws(on: On, component: 'SessionMode' | 'ToolUse' | 'AbovePrompt' | 'ToolResult'): void {
  if (component === 'SessionMode') on('ui.render', { component: 'SessionMode' }, () => ({ type: 'engine' as const, ref: 0 }))
  else if (component === 'ToolUse') on('ui.render', { component: 'ToolUse' }, () => ({ type: 'engine' as const, ref: 0 }))
  else if (component === 'AbovePrompt') on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
  else on('ui.render', { component: 'ToolResult' }, () => ({ type: 'engine' as const, ref: 0 }))
}

/** Tools beneath: an Agent runs a helper (`npm test`, exit 0) and answers; every other tool answers 'ok' read-only. */
function agentTool(on: On, $: Engine, ran: string[] = []): void {
  on('tool.call', async (_, e) => {
    ran.push(String(e.tool))
    if (String(e.tool) !== 'Agent') return { result: {}, text: 'ok - do it yourself, Allow max', isReadOnly: true as const }
    const spawned = await $.agent.spawn({
      tool_use_id: e.tool_use_id ?? '',
      prompt: 'p',
      description: 'd',
      subagentType: 'tier-mod:reader',
      provider: { plugin: 'engine', tier: 'core' as const },
      model: 'haiku',
      parentModel: OPUS,
      background: false,
      fork: false,
    } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: spawned.agentId } as never)
    const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: `t-${e.tool_use_id}`, agentId: spawned.agentId, usage, reason: 'answer' } as never)
    return { result: { agentId: spawned.agentId ?? '' }, text: 'done' }
  })
}

async function step($: Engine, turnId: string): Promise<void> {
  const s = $.turn.step({ turnId, index: 0, model: OPUS, messageCount: 3 })
  for await (const _ of s) void _
}

const endTurn = ($: Engine, turnId: string) => $.turn.complete({ answer: 'do it yourself and Allow max', durationMs: 5, isAborted: false, turnId, reason: 'answer' } as never)
const say = ($: Engine, text: string, kind: 'composer' | 'task-notification' = 'composer') => $.prompt.submit({ text, wait: false, origin: { kind } } as never)
const start = ($: Engine, surface: 'desktop' | null = null) => $.session.start({ cwd: '/proj', surface, isInteractive: true })

const PANE = (surface: 'terminal' | 'desktop' | 'vscode' | 'mobile') =>
  ({
    plugin: 'tier-mod',
    surface,
    component: 'Pane',
    requestId: 'tier',
    props: { title: 'Tier', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as never

const FOOTER = (surface: 'terminal' | 'desktop') => ({ plugin: 'tier-mod', surface, component: 'SessionMode', requestId: 'mode', props: { modes: ['focus'] } }) as never

const BAND = (surface: 'terminal' | 'desktop', hasSurvey = false) =>
  ({
    plugin: 'tier-mod',
    surface,
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  }) as never

const RESULT = (surface: 'terminal' | 'desktop', id: string, tool: string, output: string) =>
  ({ plugin: 'tier-mod', surface, component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool, output, isErrored: true } }) as never

const ROW = (surface: 'terminal' | 'desktop' | 'vscode' | 'mobile', id: string, tool = 'Agent') =>
  ({
    plugin: 'tier-mod',
    surface,
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool, input: { description: '[t=x] read it' }, isRunning: false, isErrored: false, isInterrupted: false },
  }) as never

/** The drawn element whose props carry `key` (its `hover` and `group` are on the element, not in props). */
function drawnByKey(node: unknown, key: string): { props?: Record<string, unknown>; hover?: Record<string, unknown> } | undefined {
  if (!node || typeof node !== 'object') return undefined
  const el = node as { props?: Record<string, unknown>; children?: unknown[]; hover?: Record<string, unknown> }
  if (el.props?.key === key) return el
  for (const c of el.children ?? []) {
    const hit = drawnByKey(c, key)
    if (hit) return hit
  }
  return undefined
}

const handoff = (over: Partial<TierHandoff>): TierHandoff => ({
  kind: 'handoff',
  id: 'h',
  at: T0,
  day: '2026-10-24',
  sessionId: 's',
  tag: 'x',
  try: 1,
  via: 'agent',
  helperType: 'tier-mod:reader',
  title: 't',
  model: 'claude-haiku-5-5',
  effort: 'low',
  effortSource: 'call',
  outcome: 'done',
  savingsInputs: { helperCalls: 0, roundTripUsd: 0, resultTokens: 0, briefTokens: 0, digestTokens: 0, laterMainRequests: 0 },
  ...over,
})

const block = (over: Partial<TierBlock>): TierBlock => ({ kind: 'block', id: 'block:b', at: T0, day: '2026-10-24', sessionId: 's', gate: 'web', tool: 'WebSearch', action: 'refused', reason: 'Tier: hand this', toast: 'Tier handed off a web search', ...over })

// ---------------------------------------------------------------- pure: money, cache, status

test('money: three decimals below $0.01, never "$0.00" for a cost above zero; two decimals above', () => {
  expect(formatSmallUsd(0.004)).toBe('$0.004')
  expect(formatSmallUsd(0.0006)).toBe('$0.001')
  expect(formatSmallUsd(0.0001)).toBe('<$0.001')
  expect(formatSmallUsd(0.0099)).toBe('$0.010')
  expect(formatSmallUsd(0)).toBe('$0.00')
  expect(formatSmallUsd(1.234)).toBe('$1.23')
  expect(formatSmallUsd(-0.004)).toBe('-$0.004')
  expect(formatSmallUsd(undefined)).toBe('$?')
  for (const x of [0.00001, 0.0004, 0.001, 0.0049]) expect(formatSmallUsd(x)).not.toBe('$0.00')
})

test('cache view: warm, the last sixth of the TTL (10 minutes of the hour) low, cold with the rebuild', () => {
  const meter = { phase: 'warm' as const, lastMainRequestStartMs: 0, ttl: '1h' as const, rebuildUsd: 2.61 }
  expect(cacheView(meter, 19 * MIN)).toMatchObject({ state: 'warm', pill: 'warm 41m', card: 'cache warm · 41m', title: 'Cache warm', detail: '41 of 60m' })
  expect(cacheView(meter, 51 * MIN)).toMatchObject({ state: 'low', pill: '9m', card: 'cache cooling · 9m' })
  expect(cacheView(meter, 61 * MIN)).toMatchObject({ state: 'cold', pill: 'cold · rebuild $2.61', card: 'cache cold' })
  expect(cacheView({ phase: 'none' }, 0)).toMatchObject({ state: 'none', pill: '' })
})

test('status line: `Tier · 19 · $1.84 saved · warm 41m`; a broken part pauses it', () => {
  const today = { handoffs: 19, running: 0, spentUsd: 1.12, savedUsd: 1.84, tokensKeptOut: 0, blocks: 0, blocksUsd: 0, escalations: 0, checkFailed: 0 }
  const meter = { phase: 'warm' as const, lastMainRequestStartMs: 0, ttl: '1h' as const, rebuildUsd: 2.61 }
  expect(statusText({ today, meter, now: 19 * MIN, broken: [] })).toBe('Tier · 19 · $1.84 saved · warm 41m')
  expect(statusText({ today, meter, now: 61 * MIN, broken: [] })).toBe('Tier · 19 · $1.84 saved · cold · rebuild $2.61')
  expect(statusText({ today: undefined, meter: { phase: 'none' }, now: 0, broken: [] })).toBe('Tier · 0 · $0.00 saved')
  expect(statusText({ today, meter, now: 0, broken: ['ledger', 'ledger', 'work gate'] })).toBe('Tier · Paused · ledger broke +1')
})

test('hero figures: saved, helpers, main-session-only estimate and the share saved', () => {
  const t = { handoffs: 19, running: 0, spentUsd: 1.12, savedUsd: 1.84, tokensKeptOut: 0, blocks: 0, blocksUsd: 0, escalations: 0, checkFailed: 0 }
  expect(heroFigures(t)).toEqual({ saved: 1.84, spent: 1.12, mainOnly: 2.96, pct: 62 })
  expect(heroFigures({ ...t, savedUsd: 0 }).mainOnly).toBeUndefined()
})

// ---------------------------------------------------------------- pure: strip, ladder, layers, blocks, chart

test('strip: model · effort, try, check, cost, saved; the tag is never repeated; escalated names the next rung; running shows elapsed', () => {
  const done = handoff({ costUsd: 0.21, lastCommand: 'plugin test', lastExit: 0, saved: { normalUsd: 1.5, actualUsd: 0.41, savedUsd: 1.09, tokensKeptOut: 1 }, model: 'claude-sonnet-5-5', effort: 'medium' })
  const v = stripView(done, [done], T0)
  expect(stripLine(v)).toBe('sonnet · medium · try 1 · plugin test · exit 0 · $0.21 · saved $1.09')
  expect(stripLine(v)).not.toContain('[t=')
  const esc = handoff({ id: 'e', outcome: 'escalated', costUsd: 0.004, failure: 'ESCALATE: no' })
  expect(stripLine(stripView(esc, [esc], T0))).toBe('haiku · low · try 1 · ↑ escalated → sonnet/high · $0.004')
  const run = handoff({ id: 'r', outcome: 'running', tag: null, try: 0 })
  expect(stripLine(stripView(run, [run], T0 + 64_000))).toBe('haiku · low · 1m 04s')
  expect(formatElapsed(12_000)).toBe('12s')
})

test('strip: a row shows saved only where the totals count it (done with a known cost)', () => {
  const saved = { normalUsd: 1.5, actualUsd: 0.41, savedUsd: 1.09, tokensKeptOut: 1 }
  for (const outcome of ['escalated', 'check failed', 'cut off'] as const) {
    const h = handoff({ id: outcome, outcome, costUsd: 0.2, saved, failure: 'ESCALATE: x' })
    expect(stripView(h, [h], T0).saved).toBeUndefined()
  }
  const noCost = handoff({ id: 'n', saved })
  expect(stripView(noCost, [noCost], T0).saved).toBeUndefined()
  const ok = handoff({ id: 'o', costUsd: 0.2, saved })
  expect(stripView(ok, [ok], T0).saved).toBe('saved $1.09')
})

test('ladder: failed rungs, the current, the next, the ceiling; none without a failure', () => {
  const failed = handoff({ id: 'a', at: 1, outcome: 'escalated', failure: 'ESCALATE: x' })
  const now = handoff({ id: 'b', at: 2, model: 'claude-sonnet-5-5', effort: 'high', try: 2, outcome: 'running' })
  const l = ladderFor([failed, now])
  expect(l?.tag).toBe('x')
  expect(l?.rungs).toEqual([
    { label: 'haiku · low', kind: 'failed' },
    { label: 'sonnet · high', kind: 'now' },
    { label: 'opus · low', kind: 'next' },
    { label: 'opus · max', kind: 'ceiling' },
  ])
  expect(ladderFor([now])).toBeUndefined()
  const svg = ladderSvg(l?.rungs ?? [])
  expect(svg).toContain('stroke-dasharray="3 2"')
  expect(svg).toContain(`fill="${C.t2}"`)
  expect(svg).toContain(`stroke="${C.fault}"`)
})

test('layers, blocks and the strata chart come from the records', () => {
  const recs: TierRecord[] = [
    handoff({ id: '1', costUsd: 0.04, at: T0 }),
    handoff({ id: '2', model: 'claude-sonnet-5-5', costUsd: 0.71, at: T0 + 2 * 3_600_000 }),
    handoff({ id: '3', model: 'opus', costUsd: 0.37, at: T0 + 3 * 3_600_000 }),
    block({ id: 'k1', gate: 'web' }),
    block({ id: 'k2', gate: 'handoff' }),
    block({ id: 'k3', gate: 'read', action: 'would-refuse' }),
  ]
  expect(layerRows(recs).map(r => [r.name, r.runs, r.usd])).toEqual([
    ['fable', 0, 0],
    ['opus', 1, 0.37],
    ['sonnet', 1, 0.71],
    ['haiku', 1, 0.04],
  ])
  expect(blockCounts(recs.filter((r): r is TierBlock => r.kind === 'block'))).toEqual({ total: 2, chips: [{ label: 'web search', n: 1 }, { label: 'hand-off missing model/effort', n: 1 }] })
  const pts = strataPoints(recs, T0 + 4 * 3_600_000, 'hour')
  expect(pts.map(p => p.label)).toEqual(['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', 'now'])
  expect(pts[13]?.byLayer).toEqual({ 1: 0.04, 2: 0.71, 3: 0.37, 4: 0 })
  expect(pts[10]?.byLayer).toEqual({ 1: 0.04, 2: 0, 3: 0, 4: 0 })
  const svg = strataSvg(pts, '$1.12 by now')
  expect(svg.match(/<polygon/g)?.length).toBe(3)
  expect(svg).toContain('$1.12 by now')
  expect(strataPoints(recs, T0, { days: ['2026-10-23', '2026-10-24'] }).map(p => p.label)).toEqual(['Fri', 'Sat'])
})

test('today chart: a day whose only hand-off was at 21:58 starts at local midnight, ends on "now", no duplicate hour', () => {
  const at = new Date(2026, 9, 24, 21, 58, 0).getTime()
  const now = new Date(2026, 9, 24, 23, 40, 0).getTime()
  const pts = strataPoints([handoff({ id: 'late', model: 'claude-sonnet-5-5', costUsd: 0.5, at })], now, 'hour')
  const labels = pts.map(p => p.label)
  expect(labels[0]).toBe('00')
  expect(labels[labels.length - 1]).toBe('now')
  expect(labels.length).toBe(25)
  expect(new Set(labels).size).toBe(labels.length)
  expect(pts[21]?.byLayer[2]).toBe(0)
  expect(pts[22]?.byLayer[2]).toBe(0.5)
  // The renderer thins 25 labels to a few; "now" always shows and none crowds it.
  const shown = [...strataSvg(pts, 'x').matchAll(/<text x="\d+" y="116">([^<]+)<\/text>/g)].map(m => m[1])
  expect(shown[0]).toBe('00')
  expect(shown[shown.length - 1]).toBe('now')
  expect(shown.length).toBeLessThan(8)
})

test('the cache ring: arc over the TTL, warning colour when low, dotted track when cold, minutes inside from 28px', () => {
  expect(ringSvg(13, 41, 60, 'warm')).toContain(`stroke="${C.t2}"`)
  expect(ringSvg(13, 9, 60, 'low')).toContain(`stroke="${C.warn}"`)
  const cold = ringSvg(13, 0, 60, 'cold')
  expect(cold).toContain('stroke-dasharray="1 2"')
  expect(cold).not.toContain('pathLength')
  expect(ringSvg(32, 41, 60, 'warm')).toContain('>41</text>')
  // from 24px: a track in the line colour and an arc of the same width, at least 3
  expect(ringSvg(24, 59, 60, 'warm')).toContain(`stroke="${C.line}" stroke-width="3"`)
  expect(ringSvg(24, 59, 60, 'warm')).toContain(`stroke="${C.t2}" stroke-width="3"`)
  expect(ringSvg(24, 0, 60, 'cold')).not.toContain(C.line)
})

test('refusal views: work handed down (with real numbers when known), the quiet hand-off line, max held back', () => {
  expect(refusalView(block({}), OPUS)).toMatchObject({ kind: 'card', tile: 'down', title: 'Sent down to T1', titleTail: ' · haiku reader', detail: 'Web search', buttons: 'self' })
  const held = refusalView(block({ gate: 'read', tool: 'Read', action: 'withheld', toast: 'Tier held back a 14K-token result (reading allowance used)', costUsd: 0.02 }), OPUS)
  // 14000 tokens x opus write ($8/MTok) = $0.112, less the refusal's $0.02
  expect(held).toMatchObject({ title: 'Read handed to a helper', detail: 'Read · 14K tokens kept out of this chat', savedText: '~$0.09 saved' })
  expect(refusalView(block({ gate: 'read', tool: 'Read', action: 'withheld', toast: 'Tier held back a 14K-token result' }), undefined)).not.toHaveProperty('savedText')
  expect(refusalView(block({ gate: 'edit', tool: 'Write', toast: 'Tier handed off a 200-line write' }), OPUS)).toMatchObject({ title: 'Edit handed to a helper', detail: 'Write · 200 lines' })
  expect(refusalView(block({ gate: 'handoff', tool: 'Agent', reason: 'Tier: this Agent call names no effort - name both' }), OPUS)).toEqual({
    kind: 'line',
    text: 'Hand-off needed a model and effort - Claude adds them and retries',
  })
  const max = refusalView(block({ gate: 'handoff', tool: 'Agent', tag: 'q', reason: 'Tier: max effort for [t=q] needs an ESCALATE:' }), OPUS)
  expect(max).toMatchObject({ kind: 'card', tile: 'held', title: 'Max effort is for escalation', detail: 'No failed Opus attempt for this task yet · next rung: opus/low', buttons: 'max', tag: 'q' })
  expect(refusalView(block({ gate: 'handoff', tool: 'Workflow', reason: 'Tier: the fable model for [t=w] needs' }), OPUS)).toMatchObject({ title: 'The Fable model is for escalation', tag: 'w' })
})

test('stale errors and the old statusLine notice are filtered on read', () => {
  const errs = [
    { part: 'ledger', message: 'old', at: 1 },
    { part: 'ledger', message: 'older load', at: 2, load: 'L0' },
    { part: 'work gate', message: 'now', at: 3, load: 'L1' },
  ]
  expect(liveErrors(errs, 'L1').map(e => e.part)).toEqual(['work gate'])
  const notices = [
    { id: 'old-hooks', at: 1, text: 'Older Tier shell hooks are still installed (user settings: statusLine (statusline-cache)).' },
    { id: 'effort-env', at: 2, text: 'CLAUDE_CODE_EFFORT_LEVEL is set' },
  ]
  expect(visibleNotices(notices).map(n => n.id)).toEqual(['effort-env'])
})

test('override notes: a tool result delivers this message\'s; the next message gets the rest; an expired "Do it myself" is dropped', () => {
  const now: TierOverrideNote = { kind: 'work', text: 'a', at: 1 }
  const next: TierOverrideNote = { kind: 'work', next: true, text: 'b', at: 2 }
  const max: TierOverrideNote = { kind: 'max', text: 'c', at: 3 }
  expect(splitNotes([now, next, max], 'tool')).toEqual({ deliver: [now, max], keep: [next] })
  expect(splitNotes([now, next, max], 'message')).toEqual({ deliver: [next, max], keep: [] })
  expect(splitNotes([now, next, max], 'folded')).toEqual({ deliver: [now, next, max], keep: [] })
})

test('range view: totals, per tag (with rolled-up days), blocks; live atoms override stored records', () => {
  const base = { kind: 'handoff' as const, at: 1, day: '2026-10-24', sessionId: 's', try: 1, via: 'agent' as const, helperType: 'r', title: 't', model: 'haiku', effort: 'low', effortSource: 'call' as const, savingsInputs: { helperCalls: 0, roundTripUsd: 0, resultTokens: 0, briefTokens: 0, digestTokens: 0, laterMainRequests: 0 } }
  const a: TierHandoff = { ...base, id: 'a', tag: 'x', outcome: 'running', costUsd: 0.01 }
  const aDone: TierHandoff = { ...a, outcome: 'escalated', costUsd: 0.05, saved: { normalUsd: 1, actualUsd: 0.2, savedUsd: 0.8, tokensKeptOut: 100 } }
  const b: TierHandoff = { ...base, id: 'b', tag: null, outcome: 'done', costUsd: 0.02, saved: { normalUsd: 1, actualUsd: 0.7, savedUsd: 0.3, tokensKeptOut: 10 } }
  const blk: TierBlock = { kind: 'block', id: 'k', at: 2, day: '2026-10-24', sessionId: 's', gate: 'web', tool: 'WebSearch', action: 'refused', reason: 'r', toast: 'Tier: web', costUsd: 0.1 }
  const merged = mergeRecords([a, b], [aDone, blk], '2026-10-18', '2026-10-24')
  expect(merged).toHaveLength(3)
  const summary = { day: '2026-10-19', handoffs: 2, running: 0, spentUsd: 1, savedUsd: 2, tokensKeptOut: 0, blocks: 0, blocksUsd: 0, escalations: 1, checkFailed: 0, byModel: {}, byTag: { x: { count: 2, usd: 1 } } }
  const r = rangeView(merged as TierRecord[], [summary])
  // the escalated hand-off spent 0.05 but saved nothing (#14): only b's 0.3 and the summary's 2, less the block's 0.1
  expect(r.totals).toMatchObject({ handoffs: 4, escalations: 2, blocks: 1, spentUsd: 1.07, savedUsd: 2.2 })
  expect(r.byTag[0]).toMatchObject({ tag: 'x', count: 3, usd: 1.05, savedUsd: 0 })
  expect(r.byTag.find(t => t.tag === '(untagged)')).toMatchObject({ savedUsd: 0.3 })
  expect(r.blocks.map(x => x.tool)).toEqual(['WebSearch'])
})

// ---------------------------------------------------------------- registration, /tier-pane, status

test('session start registers /tier-pane only: no /tier-report, no model tools', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(w.commands).toEqual(['tier-pane'])
  expect(w.tools).toEqual([])
})

test('/tier-pane opens the pane (asking ~460px of columns); not placed: no text', async ($, on) => {
  const w = engine(on)
  await start($)
  const ran = await $.command.run({ command: 'tier-pane' } as never)
  expect(w.opened).toEqual([{ id: 'tier', columns: 58 }])
  expect(ran.text).toBe('Tier pane opened.')
})

test('/tier-pane not placed: no text', async ($, on) => {
  engine(on, { placed: false })
  await start($)
  const ran = await $.command.run({ command: 'tier-pane' } as never)
  expect(ran.text).toBeUndefined()
})

test('terminal: the status line is `Tier · <helpers today> · $x saved · warm <m>`', async ($, on) => {
  const w = engine(on, { surfaces: ['terminal'] })
  await start($)
  await step($, 't1')
  expect(w.status[w.status.length - 1]).toBe('Tier · 0 · $0.00 saved · warm 60m')
  await w.clock.advance(51 * MIN)
  expect(w.status[w.status.length - 1]).toBe('Tier · 0 · $0.00 saved · 9m')
})

// ---------------------------------------------------------------- 5. the pane

test('the pane, text surfaces: the same sections as text rows; Now | Today | 7 days switch views', async ($, on) => {
  engine(on)
  await start($)
  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    expect(await ui.find({ type: 'Text', text: 'Waiting for the first turn since Tier loaded.' })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['Now', 'Today', '7 days', 'Keep warm off', 'Enforcement on'])
    expect(await ui.find({ type: 'Text', text: /^Saved this session: \$0\.00 est\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Layers: fable 0 \$0\.00 · opus 0/ })).toBeDefined()
    for (const t of ['Running', 'Cache', 'Stopped this session 0', 'times Tier stopped the main session doing work itself']) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.press({ key: 'view-today' })
    expect(await ui.find({ type: 'Text', text: /^Saved today: / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Stopped today 0' })).toBeDefined()
    await ui.press({ key: 'view-7d' })
    expect(await ui.find({ type: 'Text', text: 'Last 7 days' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Stopped · last 7 days 0' })).toBeDefined()
    await ui.press({ key: 'view-now' })
    await ui.unmount()
  }
})

test('the pane, desktop: mark, segmented views, hero in the saved colour, strata chart, layer table, cache ring, blocks, switch, ×', async ($, on) => {
  const w = engine(on)
  agentTool(on, $)
  await start($)
  await step($, 't1')
  await $.tool.call({ tool: 'Agent', description: '[t=x] read it', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader', tool_use_id: 'tu1' } as never)
  await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 'w1' } as never)
  await w.clock.advance(18 * MIN)
  const ui = await $.ui.mount(PANE('desktop'))
  // each switch: its On/Off Button, then the blank Button laid over the switch drawing (an Svg takes no click)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['Now', 'Today', '7 days', '×', 'Off', '    ', 'On', '    '])
  // every control a plain Button (text style, no grey block): none carries a variant
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.every(b => b.props.plain === true && b.props.variant === undefined)).toBe(true)
  // the segmented views: the chosen one at full strength on its chip, the others dim
  expect(buttons.filter(b => b.props.dimColor !== true && b.text.trim() !== '').map(b => b.text)).toEqual(['Now', 'On'])
  expect((await ui.find({ type: 'Box', key: 'seg-now' }))?.props.backgroundColor).toBe(C.line)
  // the sections in the page's order (no ladder without a failure; "By task" last)
  const keys = (((await ui.drawn()) as { children?: { props?: { key?: string } }[] }).children ?? []).map(x => x?.props?.key)
  expect(keys).toEqual(['header', 'hero', 'layers', 'running', 'cache', 'blocks', 'enforce', 'tasks'])
  const svgs = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  // the page's switches beside the On/Off text
  expect(svgs).toContain('Keep warm off')
  expect(svgs).toContain('Enforcement on')
  expect(svgs).toContain('Tier')
  expect(svgs.some(a => a.startsWith('Cumulative helper spend by layer'))).toBe(true)
  expect(svgs).toContain('cache warm · 42m')
  expect(await ui.find({ type: 'Text', text: 'Saved this session' })).toBeDefined()
  const hero = (await ui.findAll({ type: 'Text' })).filter(t => t.props.size === 'title')
  // the session's saved estimate (here negative: the web refusal's round trip, no helper savings yet)
  expect(hero.map(t => t.props.color)).toEqual([C.saved])
  expect(hero[0]?.text).toMatch(/^-?\$\d+\.\d\d$/)
  expect(await ui.find({ type: 'Text', text: /^Cache warm · 42 of 60m · rebuild \$\d+\.\d\d$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Keep warm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'web search 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Stopped this session' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'times Tier stopped the main session doing work itself' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'haiku' })).toBeDefined()
  await ui.press({ key: 'view-today' })
  expect(await ui.find({ type: 'Text', text: 'Saved today' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'view-today' }))?.props.dimColor).not.toBe(true)
  expect((await ui.find({ type: 'Button', key: 'view-now' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'pane-close' })
  expect(w.closed).toEqual(['tier'])
  await ui.unmount()
})

test('the pane\'s Enforcement switch: off then on, stored per user, toasted, on the terminal and the desktop', async ($, on) => {
  const w = engine(on)
  await start($)
  for (const [surface, onLabel, offLabel] of [
    ['terminal', 'Enforcement on', 'Enforcement off'],
    ['desktop', 'On', 'Off'],
  ] as const) {
    const ui = await $.ui.mount(PANE(surface))
    await ui.press({ key: 'enforce' })
    expect((await ui.find({ type: 'Button', key: 'enforce' }))?.text).toBe(offLabel)
    expect(w.store.get('enforce')).toBe(false)
    expect(w.toasts[w.toasts.length - 1]).toBe('Tier: enforcement off - the gates only record.')
    await ui.press({ key: 'enforce' })
    expect((await ui.find({ type: 'Button', key: 'enforce' }))?.text).toBe(onLabel)
    expect(w.store.get('enforce')).toBe(true)
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- 1. the footer pill

const textsOf = async (ui: { findAll: (q: never) => Promise<{ text?: string }[]> }, type: string) => (await ui.findAll({ type } as never)).map(n => n.text ?? '')

test('desktop footer: modes kept, then ONE non-plain Button (the app\'s own button style), no label prop, children "Tier " + one dim Text, in the hover scope of the card; a press opens the pane, a second closes it', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'] })
  engineDraws(on, 'SessionMode')
  await start($, 'desktop')
  // the footer reaches Tier at once (no fallback)
  await (await $.ui.mount(FOOTER('desktop'))).unmount()
  await step($, 't1')
  await w.clock.advance(19 * MIN)
  const ui = await $.ui.mount(FOOTER('desktop'))
  expect(await ui.find({ type: 'Text', text: 'focus' })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toEqual([])
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(b => b.props.position === 'absolute' || b.props.borderStyle !== undefined || b.props.backgroundColor !== undefined)).toBe(false)
  // exactly one Button: NOT plain, no variant, no label prop (live: a label is drawn instead of the children,
  // truncated, with a tooltip and no card), the hover scope with a background that revealed the card live
  expect((await ui.findAll({ type: 'Button' })).length).toBe(1)
  const chip = await ui.find({ type: 'Button', key: 'tier-chip' })
  expect(chip?.props.plain).toBeUndefined()
  expect(chip?.props.variant).toBeUndefined()
  // no label prop: the only label is the one the surface derives from the children's text
  expect(String(chip?.props.label ?? chip?.text).trim()).toBe('Tier · $0.00 saved · ◕ 41m')
  const chipEl = drawnByKey(await ui.drawn(), 'tier-chip') as { props?: Record<string, unknown>; children?: unknown[]; hover?: unknown }
  expect(chipEl.hover).toEqual({ scope: PILL_SCOPE, backgroundColor: '#2c3036' })
  // children: "Tier", a dim Text, the glyph in its own dim Text (size heading), a dim Text with the minutes
  const kids = (chipEl.children ?? []).filter(x => x !== null && x !== undefined && x !== false)
  const shape = kids.map(x => (typeof x === 'string' ? x : (x as { type?: string }).type))
  expect(shape).toEqual(['Tier', 'Text', 'Text', 'Text'])
  const dim = await ui.find({ type: 'Text', text: ' · $0.00 saved · ' })
  expect(dim?.props.dimColor).toBe(true)
  expect(dim?.props.color).toBeUndefined()
  const glyphT = await ui.find({ type: 'Text', text: '◕' })
  expect(glyphT?.props.dimColor).toBe(true)
  expect(glyphT?.props.size).toBe('heading')
  expect(glyphT?.props.color).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: ' 41m' }))?.props.size).toBeUndefined()
  // the row: modes, then the Button and nothing else
  const row = (await ui.drawn()) as { children?: { type?: string }[] }
  expect((row.children ?? []).slice(1).map(x => x.type)).toEqual(['Button'])
  // the toggle: open, close, open again; each press is in the status file
  await ui.press({ key: 'tier-chip' })
  expect(w.opened.length).toBe(1)
  expect(w.closed).toEqual([])
  await ui.press({ key: 'tier-chip' })
  expect(w.closed).toEqual(['tier'])
  expect(w.opened.length).toBe(1)
  await ui.press({ key: 'tier-chip' })
  expect(w.opened.length).toBe(2)
  const pressed = w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).pop()
  expect(pressed?.text).toMatch(/footer at .*: opened the pane/)
  await ui.unmount()
  // the footer is drawn: the status line is cleared at once (no turn needed); no fallback after 5 s
  expect(w.status[w.status.length - 1]).toBeUndefined()
  await w.clock.advance(6_000)
  expect(w.opened.length).toBe(2)
  await step($, 't2')
  expect(w.status[w.status.length - 1]).toBeUndefined()

  const term = await $.ui.mount(FOOTER('terminal'))
  expect(await term.find({ type: 'Button', key: 'tier-chip' })).toBeUndefined()
  await term.unmount()
})

test('desktop footer: the cache glyph follows the TTL left (50/40/20/5/0 of 60m); dim Text, no colour props', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'] })
  engineDraws(on, 'SessionMode')
  await start($, 'desktop')
  await step($, 't1')
  let spent = 0
  for (const [left, glyph] of [[50, '\u25cf'], [40, '◕'], [20, '\u25d1'], [5, '\u25d4']] as const) {
    await w.clock.advance((60 - left - spent) * MIN)
    spent = 60 - left
    const ui = await $.ui.mount(FOOTER('desktop'))
    const t = await ui.find({ type: 'Text', text: glyph })
    expect(t?.props.dimColor).toBe(true)
    expect(t?.props.size).toBe('heading')
    expect(t?.props.color).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ` ${left}m` })).toBeDefined()
    await ui.unmount()
  }
  await w.clock.advance(10 * MIN)
  const ui = await $.ui.mount(FOOTER('desktop'))
  expect((await ui.find({ type: 'Text', text: '○' }))?.props.size).toBe('heading')
  expect((await ui.find({ type: 'Text', text: ' cold' }))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('footer text: "Tier · $50.69 saved · ◕ 60m"; cold "○ cold"; no cache part before the first request; "over"; error; within 27 characters', () => {
  const warm = cacheView({ phase: 'warm', lastMainRequestStartMs: 0, ttl: '1h', rebuildUsd: 4.91 }, MIN)
  const none = cacheView({ phase: 'none' }, MIN)
  const cold = cacheView({ phase: 'cold', lastMainRequestStartMs: 0, ttl: '1h', rebuildUsd: 4.91 }, 2 * 3_600_000)
  expect(footerText(50.69, cacheView({ phase: 'warm', lastMainRequestStartMs: 0, ttl: '1h' }, 0), [])).toBe('$50.69 saved · ● 60m')
  expect(footerText(21.44, warm, [])).toBe('$21.44 saved · ● 59m')
  expect(footerText(21.44, none, [])).toBe('$21.44 saved')
  expect(footerText(1, cold, [])).toBe('$1.00 saved · ○ cold')
  expect(footerText(-0.4, warm, [])).toBe('$0.40 over · ● 59m')
  expect(footerText(1, warm, ['ledger'])).toBe('error · ledger')
  for (const [sv, b] of [[123456789012.5, []], [-99999.99, []], [1, ['the hand-off gate']]] as const) expect([...`Tier · ${footerText(sv, warm, b)}`].length).toBeLessThanOrEqual(27)
  expect(footerSplit('$50.69 saved · ◕ 60m')).toEqual({ lead: '$50.69 saved', glyph: '◕', rest: '60m' })
  expect(footerSplit('$1.00 saved · ○ cold')).toEqual({ lead: '$1.00 saved', glyph: '○', rest: 'cold' })
  expect(footerSplit('$21.44 saved')).toBeNull()
  expect(footerSplit('error · ledger')).toBeNull()
})

test('cache glyph helper: thresholds at 3/4, 1/2, 1/4 of the TTL', () => {
  expect([45, 46, 30, 31, 15, 16, 1, 0].map(m => cacheGlyph(m, 60)).join('')).toBe('◕\u25cf\u25d1◕\u25d4\u25d1\u25d4\u25cb')
})

test('desktop footer: a negative saving reads "over", not "-$"', () => {
  expect(footerSavedText(-0.4)).toEqual({ text: '$0.40 over', over: true })
  expect(footerSavedText(1.84)).toEqual({ text: '$1.84 saved', over: false })
  expect(footerSavedText(0)).toEqual({ text: '$0.00 saved', over: false })
  expect(footerSavedText(-0.4).text).not.toContain('-$')
})

test('desktop footer: a part broken since this load says "error \u00b7" (the gates fail open, never "Paused"); stale errors from an older load do not', async ($, on) => {
  let broken = false
  // $.state survives a reload: an older load left an error behind
  const w = engine(on, { surfaces: ['desktop'], storeBroken: () => broken, state: { health: { errors: [{ part: 'work gate', message: 'old', at: 0, load: 'an-older-load' }] } } })
  engineDraws(on, 'SessionMode')
  on('tool.call', () => ({ result: {}, text: 'ok', isReadOnly: true as const }))
  await start($, 'desktop')
  let ui = await $.ui.mount(FOOTER('desktop'))
  expect(await ui.find({ type: 'Text', text: /^error/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '$0.00' })).toBeDefined()
  await ui.unmount()

  broken = true
  // a refused WebSearch writes a ledger record; the store fails, so the ledger part reports itself broken
  await $.tool.call({ tool: 'WebSearch', query: 'x' } as never)
  expect(w.toasts.some(t => t.includes('the ledger broke'))).toBe(true)
  // the stale error is dropped when this load records its own
  expect(w.seen.health?.errors.map(e => e.part)).toEqual(['ledger'])
  ui = await $.ui.mount(FOOTER('desktop'))
  expect((await ui.find({ type: 'Text', text: 'error · ledger' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'tier-chip' }))?.props.plain).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Paused/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /saved/ })).toBeUndefined()
  await ui.unmount()
})

test('the old statusLine notice (0.2.0, kept in $.state and the store) is dropped at start and never shown', async ($, on) => {
  const old = 'Older Tier shell hooks are still installed (user settings: statusLine (statusline-cache)). They double up with this mod\'s status line and guard.'
  const w = engine(on, { store: { 'seen:old-hooks': old }, state: { notices: [{ id: 'old-hooks', at: 0, text: old }] } })
  await start($)
  expect(w.store.has('seen:old-hooks')).toBe(false)
  expect(w.seen.notices).toEqual([])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    expect(await ui.find({ type: 'Text', text: /statusLine/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('footer taken by another mod: its tree untouched, the pane opens by itself, recorded in the status file', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'] })
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other mod</Text>
  })
  await start($, 'desktop')
  const ui = await $.ui.mount(FOOTER('desktop'))
  expect(await ui.find({ type: 'Text', text: 'other mod' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'tier-chip' })).toBeUndefined()
  await ui.unmount()
  await w.clock.advance(10)
  expect(w.opened.length).toBe(1)
  const last = w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).pop()
  expect(last?.text).toContain('another mod draws the footer')
})

test('footer never reached Tier within 5 s on a desktop: taken; the pane not placed -> the status line', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], placed: false })
  await start($, 'desktop')
  await w.clock.advance(4_000)
  expect(w.opened.length).toBe(0)
  await w.clock.advance(2_000)
  expect(w.opened.length).toBe(1)
  await step($, 't1')
  expect(w.status[w.status.length - 1]).toMatch(/^Tier · 0 · \$0\.00 saved · warm/)
  const last = w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).pop()
  expect(last?.text).toContain('pane not placed (too narrow); status line')
})

// ---------------------------------------------------------------- 2. the hover strip

const sized = (maxRows: number, bodyColumns = 400) =>
  ({ ...(BAND('desktop') as object), props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: Math.max(0, maxRows - 1) }, view: {} } }) as never
/** The strip's one-line Texts (the outer ones: they carry wrap) whose text matches. */
const SUB = /(% less · vs |on helpers · est.)/
const HEAD = /^By layer · /
const LEGEND = /^● /
const line = async (band: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string; props: Record<string, unknown> }[]> }, re: RegExp) =>
  (await band.findAll({ type: 'Text' })).find(t => t.props.wrap !== undefined && re.test(String(t.text)))
const statusOf = (w: World) => w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).map(x => x.text).join('\n')

test('hover strip: ONE row across the band, sections in order with hairline dividers, no box or background of its own, hidden until the footer is hovered; every Text one line; plain Buttons without label; not on the terminal', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'] })
  engineDraws(on, 'SessionMode')
  engineDraws(on, 'AbovePrompt')
  agentTool(on, $)
  await start($, 'desktop')
  // the band can be asked before the footer: the strip is drawn (hidden) all the same
  let band = await $.ui.mount(BAND('desktop'))
  expect(await band.find({ type: 'Box', key: 'tier-card' })).toBeDefined()
  await band.unmount()
  await (await $.ui.mount(FOOTER('desktop'))).unmount()
  await step($, 't1')
  await $.tool.call({ tool: 'Agent', description: '[t=x] read it', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader', tool_use_id: 'tu1' } as never)
  await w.clock.advance(19 * MIN)

  band = await $.ui.mount(sized(12))
  // the reveal: the root Box display none, shown by the footer's hover scope
  const root = await band.find({ type: 'Box', key: 'tier-card' })
  expect(root?.props).toMatchObject({ display: 'none', flexDirection: 'row', paddingX: STRIP_BAND_PAD })
  const drawnRoot = drawnByKey(await band.drawn(), 'tier-card') as { hover?: unknown; children?: { props?: { key?: string } }[] }
  expect(drawnRoot.hover).toEqual({ scope: PILL_SCOPE, display: 'flex' })
  // no box-in-a-box: the app paints the grey band; no Box of ours has a background or a border
  expect((await band.findAll({ type: 'Box' })).filter(b => b.props.backgroundColor !== undefined || b.props.borderStyle !== undefined)).toEqual([])
  // the sections left to right, a 1px hairline (a cell either side) between each, the actions at the right edge
  expect((drawnRoot.children ?? []).map(c => c.props?.key)).toEqual([
    'tier-card-mark',
    'tier-card-rule-mark',
    'tier-card-saved',
    'tier-card-rule-saved',
    'tier-card-spend',
    'tier-card-rule-spend',
    'tier-card-cache',
    'tier-card-push',
    'tier-card-rule-actions',
    'tier-card-actions',
  ])
  expect((await band.find({ type: 'Box', key: 'tier-card-push' }))?.props.flexGrow).toBe(1)
  for (const k of ['mark', 'saved', 'spend', 'actions']) expect((await band.find({ type: 'Box', key: `tier-card-rule-${k}` }))?.props).toMatchObject({ width: 3, paddingX: 1 })
  // each section a fixed number of cells: at a wide band, the targets
  for (const [k, cells] of Object.entries(STRIP_TARGET)) {
    if (k === 'cache' || k === 'actions') continue
    expect((await band.find({ type: 'Box', key: `tier-card-${k}` }))?.props.width).toBe(cells)
  }
  const svgs = await band.findAll({ type: 'Svg' })
  const rules = svgs.filter(s => s.props.width === 1)
  expect(rules.length).toBe(4)
  for (const r of rules) {
    expect(r.props.height).toBe(56)
    expect(String(r.props.source)).toContain(`fill="${C.line}"`)
  }
  // the mark (~3 cells)
  expect(svgs.some(s => s.props.width === STRIP_MARK_PX && s.props.alt === 'Tier')).toBe(true)
  expect(svgCells(STRIP_MARK_PX)).toBe(3)
  // saved: "Saved today" small dim / the figure large in the saved colour / ONE line under it
  expect((await band.find({ type: 'Text', text: 'Saved today' }))?.props).toMatchObject({ color: C.mut, size: 'caption' })
  expect((await band.find({ type: 'Text', text: /^-?\$\d/ }))?.props).toMatchObject({ color: C.saved, size: 'title' })
  expect(await line(band, SUB)).toBeDefined()
  // spend: "By layer · $x" (the amount ink); the bar sized to the section; the legend ONE line with ramp dots
  expect(String((await line(band, HEAD))?.text)).toMatch(/^By layer · \$\d/)
  const bar = svgs.find(s => s.props.height === 8)
  expect(bar?.props.width).toBe(cellsPx(STRIP_TARGET.spend))
  expect(String(bar?.props.alt)).toMatch(/^Spend by layer: /)
  expect(String(bar?.props.source)).toContain(`fill="${C.t1}"`)
  expect(String((await line(band, LEGEND))?.text)).toMatch(/^● haiku \$/)
  expect((await band.find({ type: 'Text', text: /^●$/ }))?.props.color).toBe(C.t1)
  // cache: the 30px ring (track in the line colour, arc T2, stroke 3, the minutes inside) beside the cache lines
  const ringSrc = String(svgs.find(s => s.props.width === 30)?.props.source)
  expect(ringSrc).toContain(`stroke="${C.line}" stroke-width="3"`)
  expect(ringSrc).toContain(`stroke="${C.t2}" stroke-width="3"`)
  expect(ringSrc).toContain('>41m</text>')
  expect((await band.find({ type: 'Text', text: 'Cache warm · 41m' }))?.props.color).toBe(C.ink)
  expect(await band.find({ type: 'Text', text: /^rebuild \$\d+\.\d\d$/ })).toBeDefined()
  // every Text of the strip one line: the outer ones truncate at the edge, never wrap
  const outer = (await band.findAll({ type: 'Text' })).filter(t => t.props.wrap !== undefined)
  expect(outer.length).toBe(7)
  for (const t of outer) expect(t.props.wrap).toBe('truncate-end')
  // actions: "Keep warm" (the switch Svg FIRST, then a plain Button with children only, no label prop)
  const buttons = await band.findAll({ type: 'Button' })
  // the switch drawing takes the click through a blank plain Button laid over it; then the text Button
  expect(buttons.map(b => b.text)).toEqual(['    ', 'Keep warm'])
  expect(buttons[0]?.props.key).toBe('tier-card-keepwarm-switch-btn')
  for (const b of buttons.slice(1)) {
    expect(b.props.plain).toBe(true)
    // no label prop: the drawn label is the one the surface derives from the children
    expect(b.props.label ?? b.text).toBe(b.text)
    expect(b.props.variant).toBeUndefined()
  }
  const sw = svgs.find(s => s.props.width === 28)
  expect(sw?.props).toMatchObject({ height: 16, alt: 'Keep warm off' })
  expect(String(sw?.props.source)).toContain(`stroke="${C.line}"`)
  expect(String(sw?.props.source)).toContain(`fill="${C.dim}"`)
  await band.unmount()
  expect(statusOf(w)).toContain('strip across the band, 4 rows, maxRows 12')
  expect(statusOf(w)).toContain(`revealed by hover scope ${PILL_SCOPE}`)

  // no "Open pane" Button: the footer button toggles the pane
  band = await $.ui.mount(BAND('desktop'))
  expect(await band.find({ type: 'Button', key: 'tier-card-open' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /Open pane/ })).toBeUndefined()
  await band.unmount()

  // within maxRows: 4 rows draw, 3 do not
  band = await $.ui.mount(sized(4))
  expect(await band.find({ type: 'Box', key: 'tier-card' })).toBeDefined()
  await band.unmount()
  band = await $.ui.mount(sized(3))
  expect(await band.find({ type: 'Box', key: 'tier-card' })).toBeUndefined()
  await band.unmount()
  expect(statusOf(w)).toContain('not drawn: the band has 3 rows, the strip needs 4')

  band = await $.ui.mount(BAND('desktop', true))
  expect(await band.find({ type: 'Box', key: 'tier-card' })).toBeUndefined()
  await band.unmount()
  const term = await $.ui.mount(BAND('terminal'))
  expect(await term.find({ type: 'Box', key: 'tier-card' })).toBeUndefined()
  await term.unmount()
})

/** The live day of 0.14.0's screenshot: opus $16.12, sonnet $4.93, haiku $0.96 = $22.01 spent; $40.87 saved of $62.88. */
const sv = (savedUsd: number) => ({ normalUsd: 0, actualUsd: 0, savedUsd, tokensKeptOut: 0 })
const liveDay = (): TierRecord[] => [
  handoff({ id: 'o1', sessionId: 'other', model: 'claude-opus-5-5', costUsd: 16.12, saved: sv(30) }),
  handoff({ id: 'o2', sessionId: 'other', model: 'claude-sonnet-5-5', costUsd: 4.93, saved: sv(8.87) }),
  handoff({ id: 'o3', sessionId: 'other', model: 'claude-haiku-5-5', costUsd: 0.96, saved: sv(2) }),
]

test('hover strip at the live band (99 columns): every section within its cells, the sub line ONE Text with nested spans; narrower bands drop the mark, shorten then drop the legend - never wrap', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'] })
  engineDraws(on, 'SessionMode')
  engineDraws(on, 'AbovePrompt')
  await start($, 'desktop')
  await (await $.ui.mount(FOOTER('desktop'))).unmount()
  // a warm cache, as on the live band: `Cache warm · 58m` / `rebuild $x`
  await step($, 't1')
  await endTurn($, 't1')
  for (const r of liveDay()) w.store.set(recordKey(r), r)
  await w.clock.advance(2 * MIN)
  let band = await $.ui.mount(sized(12, 99))
  // "65% less" (saved colour) + " · vs $62.88" (dim): ONE Text, its two spans nested - never two boxes
  const saved3 = (drawnByKey(await band.drawn(), 'tier-card-saved') as { children?: unknown[] }).children ?? []
  expect(saved3.length).toBe(3)
  const subTree = saved3[2] as { type?: string; children?: { type?: string; props?: Record<string, unknown> }[] }
  expect(subTree.type).toBe('Text')
  expect((subTree.children ?? []).map(c => c.type)).toEqual(['Text', 'Text'])
  expect((await line(band, SUB))?.text).toBe('65% less · vs $62.88')
  expect((await band.find({ type: 'Text', text: /^65% less$/ }))?.props.color).toBe(C.saved)
  expect((await band.find({ type: 'Text', text: /^ · vs \$62\.88$/ }))?.props.color).toBe(C.mut)
  expect((await band.find({ type: 'Text', text: /^\$\d/ }))?.text).toBe('$40.87')
  expect((await line(band, HEAD))?.text).toBe('By layer · $22.01')
  expect((await line(band, LEGEND))?.text).toBe('● opus $16.12 · ● sonnet $4.93 +1')
  // the cell budget: the section Boxes as planned, and the whole within the band's 99 less the 2-column safety
  const widthOf = async (k: string) => Number((await band.find({ type: 'Box', key: `tier-card-${k}` }))?.props.width ?? 0)
  const ws = { mark: await widthOf('mark'), saved: await widthOf('saved'), spend: await widthOf('spend'), cache: await widthOf('cache'), actions: await widthOf('actions') }
  expect(ws).toEqual({ mark: 3, saved: 22, spend: 27, cache: 17, actions: 14 })
  expect(2 * STRIP_BAND_PAD + Object.values(ws).reduce((a, x) => a + x, 0) + 4 * 3).toBe(97)
  // no Text of the strip runs past its section: each one-line Text by its cells at its size
  const fit = async (re: RegExp, sec: keyof typeof ws, room = ws[sec]) => {
    const t = await line(band, re)
    expect(t).toBeDefined()
    expect(textCells(String(t?.text), (t?.props.size ?? 'body') as StripSize)).toBeLessThanOrEqual(room)
  }
  await fit(SUB, 'saved')
  await fit(HEAD, 'spend')
  await fit(LEGEND, 'spend')
  for (const [text, size, sec, room] of [
    ['Saved today', 'caption', 'saved', ws.saved],
    ['$40.87', 'heading', 'saved', ws.saved],
    [String((await band.find({ type: 'Text', text: /^Cache / }))?.text), 'caption', 'cache', ws.cache - svgCells(STRIP_RING_PX) - 1],
    [String((await band.find({ type: 'Text', text: /^rebuild|^next msg|^kept warm|^waiting/ }))?.text), 'caption', 'cache', ws.cache - svgCells(STRIP_RING_PX) - 1],
  ] as const) {
    expect(sec in ws).toBe(true)
    expect(textCells(text, size)).toBeLessThanOrEqual(room)
  }
  expect((await band.findAll({ type: 'Svg' })).find(s => s.props.height === 8)?.props.width).toBeLessThanOrEqual(ws.spend * SVG_PX_PER_CELL)
  await band.unmount()
  expect(statusOf(w)).toContain('97 of 99 columns), revealed')

  // narrower: 80 drops the mark and keeps the top layer; 70 drops the legend; the figure, bar, cache, actions stay
  const cases = [
    [84, { mark: false, legend: '● opus $16.12 · ● sonnet $4.93 +1' }],
    [80, { mark: false, legend: '● opus $16.12 +2' }],
    [70, { mark: false, legend: undefined }],
    [66, { mark: false, legend: undefined }],
    [60, { mark: false, legend: undefined }],
  ] as const
  for (const [cols, want] of cases) {
    band = await $.ui.mount(sized(12, cols))
    expect(Boolean(await band.find({ type: 'Box', key: 'tier-card-mark' }))).toBe(want.mark)
    expect((await line(band, LEGEND))?.text).toBe(want.legend)
    expect((await band.find({ type: 'Text', text: /^\$\d/ }))?.props.size).toBe('footnote')
    expect(await band.find({ type: 'Box', key: 'tier-card-cache' })).toBeDefined()
    expect(await band.find({ type: 'Button', key: 'tier-card-keepwarm' })).toBeDefined()
    expect(await band.find({ type: 'Button', key: 'tier-card-open' })).toBeUndefined()
    expect((await band.findAll({ type: 'Svg' })).some(s => s.props.height === 8)).toBe(true)
    for (const t of (await band.findAll({ type: 'Text' })).filter(t => t.props.wrap !== undefined)) expect(t.props.wrap).toBe('truncate-end')
    await band.unmount()
  }
  expect(statusOf(w)).toContain('82 of 84 columns, left out: mark)')
  expect(statusOf(w)).toContain('78 of 80 columns, left out: mark, legend past the top layer)')
  expect(statusOf(w)).toContain('68 of 70 columns, left out: mark, legend, cache minutes (in the ring))')
  expect(statusOf(w)).toMatch(/68 of 66 columns, 2 over \(Texts truncate\), left out: mark, legend, cache minutes/)
  // 60: past every step the least widths stand, over the band; the Texts truncate, never wrap
  expect(statusOf(w)).toMatch(/of 60 columns, \d+ over \(Texts truncate\), left out: mark, legend, cache minutes/)
})

test('footer and strip show the same saving: both read stripFigures over today\'s merged records (other sessions\' too)', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'] })
  engineDraws(on, 'SessionMode')
  engineDraws(on, 'AbovePrompt')
  await start($, 'desktop')
  await (await $.ui.mount(FOOTER('desktop'))).unmount()
  // written after this session booted: they reach the records, never this session's totals
  for (const r of liveDay()) w.store.set(recordKey(r), r)
  await w.clock.advance(2 * MIN)
  const band = await $.ui.mount(sized(12, 99))
  const strip = (await band.find({ type: 'Text', text: /^-?\$\d/ }))?.text
  await band.unmount()
  const footer = await $.ui.mount(FOOTER('desktop'))
  const chip = (await footer.find({ type: 'Text', text: /^ · \$\d/ }))?.text
  await footer.unmount()
  expect(strip).toBe('$40.87')
  expect(chip?.slice(3).split(' ')[0]).toBe(strip)
})

test('hover strip states: warm (arc + minutes), cold (dotted ring, no minutes, "next msg rebuilds"), keep warm on (switch on, "kept warm · ping in")', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'] })
  engineDraws(on, 'SessionMode')
  engineDraws(on, 'AbovePrompt')
  await start($, 'desktop')
  await (await $.ui.mount(FOOTER('desktop'))).unmount()
  await step($, 't1')
  await endTurn($, 't1')
  // warm
  await w.clock.advance(1 * MIN)
  let band = await $.ui.mount(BAND('desktop'))
  expect(await band.find({ type: 'Text', text: 'Cache warm · 59m' })).toBeDefined()
  expect(String((await band.findAll({ type: 'Svg' })).find(s => s.props.width === 24)?.props.source)).toContain('>59m</text>')
  await band.unmount()
  // keep warm on: the switch on (T3 track, knob right), "kept warm · ping in 34m"
  band = await $.ui.mount(BAND('desktop'))
  await band.press({ key: 'tier-card-keepwarm' })
  await band.unmount()
  expect(kwState(w)).toBe(true)
  await step($, 't2')
  await endTurn($, 't2')
  await w.clock.advance(20 * MIN)
  band = await $.ui.mount(BAND('desktop'))
  expect(await band.find({ type: 'Text', text: /^Cache warm · \d+m$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^kept warm · ping in \d+m$/ })).toBeDefined()
  const sw = (await band.findAll({ type: 'Svg' })).find(s => s.props.width === 28)
  expect(sw?.props.alt).toBe('Keep warm on')
  expect(String(sw?.props.source)).toContain(`fill="${C.t3}"`)
  await band.press({ key: 'tier-card-keepwarm' })
  await band.unmount()
  expect(kwState(w)).toBe(false)
  // cold
  await w.clock.advance(3 * 60 * MIN)
  band = await $.ui.mount(BAND('desktop'))
  expect(await band.find({ type: 'Text', text: 'Cache cold' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^next msg rebuilds( \$\d+\.\d\d)?$/ })).toBeDefined()
  const src = String((await band.findAll({ type: 'Svg' })).find(s => s.props.width === 24)?.props.source)
  expect(src).toContain('stroke-dasharray="0.01 2"')
  expect(src).not.toContain('stroke-width="3"')
  expect(src).not.toContain('<text')
  await band.unmount()
})

test('hover strip figures add up: by-layer = helpers spent, main-only - saved = spent, the share = saved / main-only; other sessions\' records after this boot included', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'] })
  engineDraws(on, 'SessionMode')
  engineDraws(on, 'AbovePrompt')
  await start($, 'desktop')
  await (await $.ui.mount(FOOTER('desktop'))).unmount()
  // another session's hand-offs, written AFTER this one booted (the live bug: they reached the layers, not the totals)
  const recs: TierRecord[] = [
    handoff({ id: 'o1', sessionId: 'other', model: 'claude-opus-5-5', costUsd: 16.12, saved: sv(15) }),
    handoff({ id: 'o2', sessionId: 'other', model: 'claude-sonnet-5-5', costUsd: 0.96, saved: sv(6) }),
    handoff({ id: 'o3', sessionId: 'other', model: 'claude-haiku-5-5', costUsd: 0.002, saved: sv(0.44) }),
  ]
  for (const r of recs) w.store.set(recordKey(r), r)
  await w.clock.advance(2 * MIN)
  const band = await $.ui.mount(sized(12))
  const num = (t: string | undefined) => Number(String(t).replace(/[^\d.]/g, ''))
  const legend = (await band.findAll({ type: 'Text' })).filter(t => /^ (fable|opus|sonnet|haiku) \$/.test(String(t.text)))
  const spent = num((await line(band, HEAD))?.text)
  const saved = num((await band.find({ type: 'Text', text: /^-?\$\d/ }))?.text)
  const mainOnly = num((await band.find({ type: 'Text', text: /^ · vs \$/ }))?.text)
  const pct = num((await band.find({ type: 'Text', text: /^\d+% less$/ }))?.text)
  // the legend: the top two by spend, +1 for the third
  expect(legend.map(t => t.text)).toEqual([' opus $16.12', ' sonnet $0.96'])
  expect((await line(band, LEGEND))?.text).toBe('● opus $16.12 · ● sonnet $0.96 +1')
  expect(spent).toBe(17.08)
  expect(Math.abs(recs.reduce((a, r) => a + (r.kind === 'handoff' ? r.costUsd ?? 0 : 0), 0) - spent)).toBeLessThan(0.01)
  expect(saved).toBe(21.44)
  expect(mainOnly).toBe(38.52)
  expect(Math.abs(mainOnly - saved - spent)).toBeLessThan(0.011)
  expect(pct).toBe(Math.round((saved / mainOnly) * 100))
  await band.unmount()
})

// ---------------------------------------------------------------- 3. the hand-off strip

test('hand-off strip: desktop draws the strip (glyph, model · effort, try, check, cost) under the engine\'s row; text surfaces one line; the tag never repeated', async ($, on) => {
  engine(on, { surfaces: ['terminal'] })
  engineDraws(on, 'ToolUse')
  agentTool(on, $)
  await start($)
  await step($, 't1')
  await $.tool.call({ tool: 'Agent', description: '[t=x] read it', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader', tool_use_id: 'tu1' } as never)
  const desk = await $.ui.mount(ROW('desktop', 'tu1'))
  const strip = await desk.find({ type: 'Box', key: 'tier-strip' })
  expect(strip?.props).toMatchObject({ backgroundColor: C.s1, borderColor: C.sb })
  for (const t of ['haiku · low', 'try 1', 'npm test · exit 0', '$0.001']) expect(await desk.find({ type: 'Text', text: t })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /\[t=/ })).toBeUndefined()
  expect((await desk.findAll({ type: 'Svg' })).map(s => s.props.alt)).toEqual(['haiku · low', 'check passed'])
  // the strip is information only: no Button (no grey block) in it
  expect(await desk.findAll({ type: 'Button' })).toEqual([])
  await desk.unmount()
  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const row = await $.ui.mount(ROW(surface, 'tu1'))
    expect((await row.find({ type: 'Text', text: /^haiku · low/ }))?.text).toMatch(/^haiku · low · try 1 · npm test · exit 0 · \$0\.001 · saved \$\d/)
    expect(await row.find({ type: 'Box', key: 'tier-strip' })).toBeUndefined()
    await row.unmount()
  }
  const other = await $.ui.mount(ROW('terminal', 'tu2', 'Bash'))
  expect(await other.find({ type: 'Text', text: /haiku/ })).toBeUndefined()
  await other.unmount()
})

// ---------------------------------------------------------------- 4. refusals and the override Buttons

test('refusal card (web): drawn instead of the error on the desktop; the terminal keeps the text; × closes it to a quiet line', async ($, on) => {
  const w = engine(on)
  engineDraws(on, 'ToolResult')
  agentTool(on, $)
  await start($)
  await step($, 't1')
  const refused = await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 'w1' } as never)
  expect(refused.deny).toMatch(/^Tier: /)
  const ui = await $.ui.mount(RESULT('desktop', 'w1', 'WebSearch', String(refused.deny)))
  expect((await ui.find({ type: 'Box', key: 'tier-refusal' }))?.props).toMatchObject({ backgroundColor: C.s2, borderColor: C.rb })
  expect(await ui.find({ type: 'Text', text: 'Sent down to T1 · haiku reader' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Web search' })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['Do it myself', 'Open Tier', '×'])
  // plain text actions (no heavy grey blocks): every Button plain, none with a variant
  expect((await ui.findAll({ type: 'Button' })).every(b => b.props.plain === true && b.props.variant === undefined)).toBe(true)
  expect((await ui.find({ type: 'Svg' }))?.props).toMatchObject({ width: 44, height: 44 })
  await ui.press({ key: 'tier-open-w1' })
  expect(w.opened.length).toBe(1)
  await ui.press({ key: 'tier-x-w1' })
  expect(await ui.find({ type: 'Box', key: 'tier-refusal' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Sent down to T1 · haiku reader' })).toBeDefined()
  await ui.unmount()
  const term = await $.ui.mount(RESULT('terminal', 'w1', 'WebSearch', String(refused.deny)))
  expect(await term.find({ type: 'Box', key: 'tier-refusal' })).toBeUndefined()
  await term.unmount()
  // an error that is not Tier's is left alone
  const plain = await $.ui.mount(RESULT('desktop', 'zz', 'Bash', 'command not found'))
  expect(await plain.find({ type: 'Box', key: 'tier-refusal' })).toBeUndefined()
  await plain.unmount()
})

test('"Do it myself" mid-turn: the work gate lifts for this message, the model is told on the next main-loop result, the next message resets it', async ($, on) => {
  const w = engine(on)
  engineDraws(on, 'ToolResult')
  const ran: string[] = []
  agentTool(on, $, ran)
  await start($)
  await say($, 'look it up')
  await step($, 't1')
  const refused = await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 'w1' } as never)
  const ui = await $.ui.mount(RESULT('desktop', 'w1', 'WebSearch', String(refused.deny)))
  await ui.press({ key: 'tier-self-w1' })
  expect(w.seen.gate?.override).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'tier-self-w1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Claude does it this message' })).toBeDefined()
  expect(w.toasts[w.toasts.length - 1]).toBe('Tier: you do it - the work gate is off for this message.')
  await ui.unmount()
  // the retried search runs, and carries the note to the model (once)
  const again = await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 'w2' } as never)
  expect(again.deny).toBeUndefined()
  expect(again.context).toEqual([doItMyselfNote(false)])
  expect((await $.tool.call({ tool: 'WebSearch', query: 'r', tool_use_id: 'w3' } as never)).context).toBeUndefined()
  expect(ran.filter(t => t === 'WebSearch')).toHaveLength(2)
  // the next user message: the gate is back
  await endTurn($, 't1')
  await say($, 'thanks')
  expect(w.seen.gate?.override).toBe(false)
  expect((await $.tool.call({ tool: 'WebSearch', query: 's', tool_use_id: 'w4' } as never)).deny).toBeDefined()
  expect(w.promptContext[w.promptContext.length - 1]).toBeUndefined()
})

test('"Do it myself" with no turn running: it holds for the next user message, and that message carries the note', async ($, on) => {
  const w = engine(on)
  engineDraws(on, 'ToolResult')
  agentTool(on, $)
  await start($)
  await step($, 't1')
  const refused = await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 'w1' } as never)
  await endTurn($, 't1')
  const ui = await $.ui.mount(RESULT('desktop', 'w1', 'WebSearch', String(refused.deny)))
  await ui.press({ key: 'tier-self-w1' })
  await ui.unmount()
  expect(w.seen.gate).toMatchObject({ override: false, carryOverride: true })
  expect(w.toasts[w.toasts.length - 1]).toBe('Tier: you do it - the work gate is off for your next message.')
  await say($, 'go on')
  expect(w.seen.gate?.override).toBe(true)
  expect(w.seen.gate?.carryOverride).toBeUndefined()
  expect(w.promptContext[w.promptContext.length - 1]).toEqual([doItMyselfNote(true)])
  await step($, 't2')
  expect((await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 'w2' } as never)).deny).toBeUndefined()
  // spent: the message after that is gated again
  await endTurn($, 't2')
  await say($, 'and again')
  expect((await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 'w3' } as never)).deny).toBeDefined()
})

test('max held back: the card names the next rung; "Allow max" allows that tag for the session and tells the model', async ($, on) => {
  const w = engine(on)
  engineDraws(on, 'ToolResult')
  agentTool(on, $)
  await start($)
  await step($, 't1')
  const max = { tool: 'Agent', description: '[t=q] prove it', prompt: 'p', model: 'opus', effort: 'max', subagent_type: 'tier-mod:editor', tool_use_id: 'm1' }
  const refused = await $.tool.call(max as never)
  expect(refused.deny).toBeDefined()
  const term = await $.ui.mount(RESULT('terminal', 'm1', 'Agent', String(refused.deny)))
  expect(await term.find({ type: 'Box', key: 'tier-refusal' })).toBeUndefined()
  await term.unmount()
  const ui = await $.ui.mount(RESULT('desktop', 'm1', 'Agent', String(refused.deny)))
  expect(await ui.find({ type: 'Text', text: 'Max effort is for escalation' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No failed Opus attempt for this task yet · next rung: opus/low' })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['Allow max', '×'])
  expect((await ui.findAll({ type: 'Button' })).every(b => b.props.plain === true && b.props.variant === undefined)).toBe(true)
  expect((await ui.find({ type: 'Svg' }))?.props).toMatchObject({ width: 44, height: 44 })
  await ui.press({ key: 'tier-allow-m1' })
  expect(w.seen.gate?.allowMaxTags).toEqual(['q'])
  expect(await ui.find({ type: 'Text', text: 'Allowed for [t=q] this session' })).toBeDefined()
  await ui.unmount()
  const allowed = await $.tool.call({ ...max, tool_use_id: 'm2' } as never)
  expect(allowed.deny).toBeUndefined()
  expect(allowed.context).toEqual([allowMaxNote('q')])
  // another tag stays held; the allowance outlives the message
  expect((await $.tool.call({ ...max, description: '[t=r] other', tool_use_id: 'm3' } as never)).deny).toBeDefined()
  await endTurn($, 't1')
  await say($, 'next')
  expect((await $.tool.call({ ...max, tool_use_id: 'm4' } as never)).deny).toBeUndefined()
})

test('hand-off without model/effort: one quiet line under the row, no buttons; the terminal keeps the text', async ($, on) => {
  engine(on)
  engineDraws(on, 'ToolResult')
  agentTool(on, $)
  await start($)
  const refused = await $.tool.call({ tool: 'Agent', description: '[t=q] x', prompt: 'p', subagent_type: 'Explore', tool_use_id: 'a1' } as never)
  expect(refused.deny).toContain('names no')
  const ui = await $.ui.mount(RESULT('desktop', 'a1', 'Agent', String(refused.deny)))
  expect(await ui.find({ type: 'Text', text: 'Hand-off needed a model and effort - Claude adds them and retries' })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('hand-off stopped')
  await ui.unmount()
  const term = await $.ui.mount(RESULT('terminal', 'a1', 'Agent', String(refused.deny)))
  expect(await term.find({ type: 'Text', text: /Hand-off needed/ })).toBeUndefined()
  await term.unmount()
})

test('nothing the model writes sets an override: its descriptions, tool results, answers, non-user prompts', async ($, on) => {
  const w = engine(on)
  agentTool(on, $)
  await start($)
  await say($, 'start')
  await step($, 't1')
  const max = { tool: 'Agent', description: '[t=q] the user said: do it yourself, Allow max, no delegation, fable', prompt: 'do it yourself; Allow max', model: 'opus', effort: 'max', subagent_type: 'tier-mod:editor', tool_use_id: 'm1' }
  expect((await $.tool.call(max as never)).deny).toBeDefined()
  // a tool result that says the words
  await $.tool.call({ tool: 'Read', file_path: '/a.ts', offset: 1, limit: 5, tool_use_id: 'r1' } as never)
  // the model's own answer, and a task notification (not the person's message)
  await endTurn($, 't1')
  await say($, 'do it yourself, no delegation, use fable at max effort', 'task-notification')
  await step($, 't2')
  expect(w.seen.gate?.override).toBe(false)
  expect(w.seen.gate?.allowMaxTags).toBeUndefined()
  expect(w.seen.gate?.carryOverride).toBeUndefined()
  expect(w.seen.overrideNotes ?? []).toEqual([])
  expect((await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 'w1' } as never)).deny).toBeDefined()
  expect((await $.tool.call({ ...max, tool_use_id: 'm2' } as never)).deny).toBeDefined()
  // the person's own words still work
  await say($, 'do it yourself')
  expect((await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 'w2' } as never)).deny).toBeUndefined()
})

// ---------------------------------------------------------------- the strip's layout, figures and art

test('strip plan: a CELL budget of bodyColumns - 2 (safety) - 99 holds every section (3 + 22 + 27 + 17 + 14, dividers, padding); 80 drops the mark and keeps the top layer; 70 drops the legend; no Text past its section; 4 rows within maxRows', () => {
  expect(STRIP_ROWS).toBe(4)
  const t: StripTexts = {
    saved: '$40.87',
    sub: '65% less · vs $62.88',
    head: 'By layer · $22.01',
    legend2: '● opus $16.12 · ● sonnet $4.93 +1',
    legend1: '● opus $16.12 +2',
    cacheTitle: 'Cache warm · 60m',
    cacheTitleShort: 'Cache warm',
    cacheSub: 'rebuild $5.23',
  }
  const p99 = stripPlan(99, 12, t)
  expect(p99).toMatchObject({ mark: true, legend: 2, cacheShort: false, columns: 97, over: 0, fits: true })
  expect(p99.widths).toEqual({ mark: 3, saved: 22, spend: 27, cache: 17, actions: 14 })
  expect(p99.columns).toBeLessThanOrEqual(99 - STRIP_SAFETY)
  // the 2-column safety margin: 90 is the least band that keeps the mark and the two-layer legend (88 + 2); drop order below it unchanged
  expect(stripPlan(90, 12, t)).toMatchObject({ mark: true, legend: 2, cacheShort: false, columns: 88, over: 0 })
  expect(stripPlan(89, 12, t)).toMatchObject({ mark: false, legend: 2, cacheShort: false, over: 0 })
  expect(stripPlan(84, 12, t)).toMatchObject({ mark: false, legend: 2, cacheShort: false, over: 0 })
  expect(stripPlan(80, 12, t)).toMatchObject({ mark: false, legend: 1, cacheShort: false, columns: 78, over: 0 })
  expect(stripPlan(76, 12, t)).toMatchObject({ mark: false, legend: 1, cacheShort: false, over: 0 })
  expect(stripPlan(72, 12, t)).toMatchObject({ mark: false, legend: 1, cacheShort: false, over: 0 })
  expect(stripPlan(70, 12, t)).toMatchObject({ mark: false, legend: 0, cacheShort: true, over: 0 })
  for (const cols of [120, 99, 90, 85, 84, 80, 76, 72, 70]) expect(stripPlan(cols, 12, t).columns).toBeLessThanOrEqual(cols - STRIP_SAFETY)
  expect(stripPlan(120, 12, t)).toMatchObject({ mark: true, legend: 2, columns: 100, widths: STRIP_TARGET })
  // past every step: the least widths, the Texts truncate (never wrap)
  const p60 = stripPlan(60, 12, t)
  expect(p60).toMatchObject({ mark: false, legend: 0, cacheShort: true })
  expect(p60.over).toBe(p60.columns - 60)
  // a wide band: the sections stop at their targets, the rest is the push before the actions
  expect(stripPlan(400, 12, t)).toMatchObject({ columns: 100, mark: true, legend: 2, widths: STRIP_TARGET })
  // cold, keep-warm texts fit 99 too
  for (const sub of ['next msg rebuilds $5.23', 'kept warm · ping in 4m']) expect(stripPlan(99, 12, { ...t, cacheTitle: 'Cache cold', cacheTitleShort: 'Cache cold', cacheSub: sub })).toMatchObject({ mark: true, legend: 2, over: 0 })
  // no Text past its section, at every width
  for (const cols of [120, 99, 90, 80, 76, 70, 66, 60]) {
    const p = stripPlan(cols, 12, t)
    const lg = p.legend === 2 ? t.legend2 : p.legend === 1 ? t.legend1 : ''
    const tr = stripTier(cols)
    const cacheText = p.widths.cache - svgCells(tr.ringPx) - 1
    expect(textCells('Saved today', tr.label)).toBeLessThanOrEqual(p.widths.saved)
    expect(textCells(t.saved, tr.figure)).toBeLessThanOrEqual(p.widths.saved)
    expect(textCells(t.sub, tr.label)).toBeLessThanOrEqual(p.widths.saved)
    expect(textCells(t.head, tr.primary)).toBeLessThanOrEqual(p.widths.spend)
    expect(textCells(lg, tr.label)).toBeLessThanOrEqual(p.widths.spend)
    expect(textCells(p.cacheShort ? t.cacheTitleShort : t.cacheTitle, tr.primary)).toBeLessThanOrEqual(cacheText)
    expect(textCells(t.cacheSub, tr.label)).toBeLessThanOrEqual(cacheText)
    expect(textCells('Keep warm', 'body') + 1 + 1 + svgCells(STRIP_SWITCH_PX)).toBeLessThanOrEqual(p.widths.actions)
    expect(p.columns - p.over).toBeLessThanOrEqual(cols)
    if (!p.over) expect(p.columns).toBeLessThanOrEqual(cols - STRIP_SAFETY)
    expect(cellsPx(p.widths.spend)).toBeLessThanOrEqual(p.widths.spend * SVG_PX_PER_CELL)
  }
  expect(stripPlan(99, 4, t).fits).toBe(true)
  expect(stripPlan(99, 3, t).fits).toBe(false)
  // no layer spent: no legend step
  expect(stripPlan(99, 12, { ...t, legend2: '', legend1: '' })).toMatchObject({ legend: 0, mark: true })
  // the legend spans: the top two by spend in their ramp colours, +n for the rest
  const rows = layerRows([handoff({ id: 'a', model: 'claude-opus-5-5', costUsd: 16.12 }), handoff({ id: 'b', model: 'claude-sonnet-5-5', costUsd: 4.93 }), handoff({ id: 'c', model: 'claude-haiku-5-5', costUsd: 0.96 })])
  const two = stripLegendSpans(rows, 2)
  expect(two.map(x => x.text).join('')).toBe('● opus $16.12 · ● sonnet $4.93 +1')
  expect(two.filter(x => x.text === '●').map(x => x.color)).toEqual([C.t3, C.t2])
  expect(stripLegendSpans(rows, 1).map(x => x.text).join('')).toBe('● opus $16.12 +2')
  expect(stripLegendSpans([], 2)).toEqual([])
})

test('strip figures: ONE source - spent = the sum of the by-layer amounts, main-only = spent + saved, the share = saved / main-only', () => {
  const sv = (savedUsd: number) => ({ normalUsd: 0, actualUsd: 0, savedUsd, tokensKeptOut: 0 })
  const recs: TierRecord[] = [
    handoff({ id: 'a', model: 'claude-opus-5-5', costUsd: 16.12, saved: sv(15) }),
    handoff({ id: 'b', sessionId: 'other', model: 'claude-sonnet-5-5', costUsd: 0.96, saved: sv(6) }),
    handoff({ id: 'c', model: 'claude-haiku-5-5', costUsd: 0.002, saved: sv(0.44) }),
    handoff({ id: 'd', model: 'claude-haiku-5-5', outcome: 'running' }),
    block({ id: 'block:x', costUsd: 0.5 }),
  ]
  const f = stripFigures(recs)
  expect(f.helpers).toBe(4)
  expect(Math.abs((f.spent) - (f.rows.reduce((a, r) => a + r.usd, 0)))).toBeLessThan(1e-6)
  expect(Math.abs((f.spent) - (17.082))).toBeLessThan(1e-6)
  expect(Math.abs((f.saved) - (21.44 - 0.5))).toBeLessThan(1e-6)
  expect(Math.abs((f.mainOnly ?? 0) - (f.spent + f.saved))).toBeLessThan(1e-6)
  expect(f.pct).toBe(Math.round((f.saved / (f.mainOnly ?? 1)) * 100))
  expect(stripSavedSub(f).map(x => x.text).join('')).toBe(`${f.pct}% less · vs $38.02`)
  // nothing saved yet: no share, the sub line says what helpers spent
  const none = stripFigures([handoff({ id: 'z', model: 'claude-sonnet-5-5', costUsd: 0.5 })])
  expect(none).toMatchObject({ spent: 0.5, saved: 0, mainOnly: undefined, pct: undefined })
  expect(stripSavedSub(none).map(x => x.text)).toEqual(['$0.50 on helpers · est.'])
  expect(stripFigures([])).toMatchObject({ helpers: 0, spent: 0, saved: 0 })
})

test('strip cache texts: warm `Cache warm · 59m` / `rebuild $x`, kept warm, cold `next msg rebuilds $x`, before the first turn; minutes as `4m`', () => {
  const meter = { phase: 'warm' as const, lastMainRequestStartMs: 0, ttl: '1h' as const, rebuildUsd: 4.91 }
  const warm = cacheView(meter, 1 * MIN)
  expect(stripCacheText(warm, false, undefined, MIN)).toEqual({ title: 'Cache warm · 59m', short: 'Cache warm', sub: 'rebuild $4.91' })
  expect(stripCacheText(warm, true, { status: 'scheduled', dueMs: 5 * MIN, pings: 0 }, MIN)).toEqual({ title: 'Cache warm · 59m', short: 'Cache warm', sub: 'kept warm · ping in 4m' })
  expect(stripCacheText(cacheView(meter, 61 * MIN), false, undefined, 61 * MIN)).toEqual({ title: 'Cache cold', short: 'Cache cold', sub: 'next msg rebuilds $4.91' })
  expect(stripCacheText(cacheView({ phase: 'none' }, 0), false, undefined, 0).title).toBe('Cache')
})

test('strip art: the stacked bar (min width for a layer that spent, 2px gaps, deepest layer left), the 30px ring, the switch', () => {
  const ws = barWidths(268, [0, 16.12, 0.96, 0.002])
  expect(ws[0]).toBe(0)
  expect(ws[3]).toBe(4)
  expect(Math.abs((ws.reduce((a, x) => a + x, 0) + 2 * 2) - (268))).toBeLessThan(1e-6)
  expect(ws[1] ?? 0).toBeGreaterThan(ws[2] ?? 0)
  const bar = stackBarSvg(268, 8, { 1: 0.002, 2: 0.96, 3: 16.12, 4: 0 })
  expect(bar).toContain('width="268" height="8"')
  expect(bar.indexOf(C.t3)).toBeLessThan(bar.indexOf(C.t1))
  expect(stackBarSvg(268, 8, { 1: 0, 2: 0, 3: 0, 4: 0 })).toContain(`fill="${C.line}"`)
  const warm = stripRingSvg(59, 60, 'warm')
  expect(warm).toContain('pathLength="60" stroke-dasharray="59 60"')
  expect(warm).toContain('>59m</text>')
  expect(stripRingSvg(9, 60, 'low')).toContain(`stroke="${C.warn}"`)
  expect(stripRingSvg(0, 60, 'cold')).not.toContain('<text')
  expect(stripSwitchSvg(true)).toContain(`fill="${C.t3}"`)
  expect(stripSwitchSvg(true)).toContain('cx="21"')
  expect(stripSwitchSvg(false)).toContain(`stroke="${C.line}"`)
  expect(C.dim).toBe('#6b7179')
})

test('footer text: at most 27 visible characters with "Tier · "; " saved" goes first, then the glyph, then the cache part', () => {
  expect(FOOTER_MAX_CHARS).toBe(27)
  expect(footerDetail('$1.84 saved', '◕ 41m')).toBe('$1.84 saved · ◕ 41m')
  expect(footerDetail('$50.69 saved', '◕ 60m')).toBe('$50.69 saved · ◕ 60m')
  expect(footerDetail('$123.45 saved', '◕ 60m')).toBe('$123.45 · ◕ 60m')
  expect(footerDetail('$1234.56 saved', '◕ 41m')).toBe('$1234.56 · ◕ 41m')
  expect(footerDetail('$1234.56 saved', '○ cold')).toBe('$1234.56 · ○ cold')
  expect(footerDetail('$12345.67 saved', '◕ 41m')).toBe('$12345.67 · ◕ 41m')
  expect(footerDetail('$123456.78 saved', '◕ 41m')).toBe('$123456.78 · ◕ 41m')
  expect(footerDetail('$123456789.12 saved', '◕ 41m')).toBe('$123456789.12 · 41m')
  expect(footerDetail('$1234567890.12 saved', '◕ 41m')).toBe('$1234567890.12 · 41m')
  expect(footerDetail('$1234567890.12 saved', '○ cold')).toBe('$1234567890.12')
  expect(footerDetail('$123456789012.34 saved', '◕ 41m')).toBe('$123456789012.34')
  expect(footerDetail('$123456789012.34 saved', '')).toBe('$123456789012.34')
  expect(footerDetail('$0.40 over', '◕ 41m')).toBe('$0.40 over · ◕ 41m')
  expect(footerDetail('error · ledger', '')).toBe('error · ledger')
  expect(footerDetail('error · the hand-off gate', '')).toBe('error · the hand-of…')
  for (const [m, c] of [['$123456.78 saved', '◕ 41m'], ['$9.99 over', '○ cold'], ['$99999999999.99 saved', '◕ 41m'], ['error · x', '']] as const) expect([...`Tier · ${footerDetail(m, c)}`].length).toBeLessThanOrEqual(27)
})

test('cache minutes read the same everywhere: `60m`, never `1h00`; the pane row joins state, minutes and rebuild', () => {
  const meter = { phase: 'warm' as const, lastMainRequestStartMs: 0, ttl: '1h' as const, rebuildUsd: 4.2 }
  expect(cacheView(meter, 0)).toMatchObject({ card: 'cache warm · 60m', pill: 'warm 60m' })
  expect(paneCacheText(cacheView(meter, 19 * MIN))).toBe('Cache warm · 41 of 60m · rebuild $4.20')
  expect(paneCacheText(cacheView(meter, 61 * MIN))).toBe('Cache cold · rebuild $4.20')
})

// ---------------------------------------------------------------- keep-warm

test('keep-warm decision: pings only when on, on the 1h TTL, from 20K context, no turn running, five-hour window under 90%, and until the pings add up to one rebuild', () => {
  const base = { on: true, lastRealStartMs: 0, ttl: '1h' as const, contextTokens: 300_000, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], turnRunning: false, model: OPUS, spentUsd: 0 }
  expect(keepWarmDecision(base)).toEqual({ kind: 'ping' })
  expect(keepWarmDecision({ ...base, on: false }).kind).toBe('skip')
  expect(keepWarmDecision({ ...base, ttl: '5m' })).toEqual({ kind: 'skip', reason: '5m TTL' })
  expect(keepWarmDecision({ ...base, contextTokens: KEEP_WARM_MIN_CONTEXT - 1 })).toEqual({ kind: 'skip', reason: 'context under 20K' })
  expect(keepWarmDecision({ ...base, turnRunning: true })).toEqual({ kind: 'skip', reason: 'a turn is running' })
  expect(keepWarmDecision({ ...base, rateLimits: [{ kind: 'five_hour', percentUsed: 91 }] })).toEqual({ kind: 'skip', reason: 'five-hour window 91% used' })
  expect(keepWarmDecision({ ...base, model: 'mystery-model' })).toEqual({ kind: 'skip', reason: 'cannot price the rebuild' })
  // no 6-hour window any more: a day after the last request still pings while the budget holds
  expect(keepWarmDecision({ ...base, spentUsd: 0.06 * 30 })).toEqual({ kind: 'ping' })
  // Opus at 737,425 tokens: rebuild $5.8994 = 40 pings of $0.147485; the 40th fits, the 41st does not
  const opus737 = { ...base, contextTokens: 737_425 }
  const ping = (737_425 * 0.2) / 1e6
  expect(keepWarmDecision({ ...opus737, spentUsd: 39 * ping })).toEqual({ kind: 'ping' })
  expect(keepWarmDecision({ ...opus737, spentUsd: 40 * ping })).toEqual({ kind: 'skip', reason: 'pings reached one rebuild ($5.90)' })
  expect(nextPingDueMs({ lastMainRequestStartMs: 0 })).toBe(PING_EVERY_MS)
  expect(nextPingDueMs({ lastMainRequestStartMs: 0, lastPingStartMs: PING_EVERY_MS })).toBe(2 * PING_EVERY_MS)
})

test('keep-warm line: scheduled and priceable `next ping in 14m · ping 3 of 40 · $0.45 of $5.90`; otherwise the old format', () => {
  const day = { day: 'd', coldStarts: 0, rebuildUsd: 0, pingsUsd: 0, savedUsd: 0, pingsSent: 2, pingsSentUsd: 0.16 }
  const kw = { status: 'scheduled' as const, dueMs: 55 * MIN, pings: 9, pingsSinceReal: 2, pingsSinceRealUsd: 0.45 }
  const price = { contextTokens: 737_425, model: OPUS, ttl: '1h' as const }
  const line = keepWarmLine(kw, day, 41 * MIN, price)
  expect(line).toBe('next ping in 14m · ping 3 of 40 · $0.45 of $5.90')
  expect(line.length).toBeLessThanOrEqual(58)
  // the first ping of a round
  expect(keepWarmLine({ status: 'scheduled', dueMs: 55 * MIN, pings: 0 }, undefined, 0, price)).toBe('next ping in 55m · ping 1 of 40 · $0.00 of $5.90')
  // not priceable (no model/context) or no price given: the old format
  expect(keepWarmLine(kw, day, 41 * MIN)).toBe('next ping in 14m · 2 pings · $0.16 today')
  expect(keepWarmLine(kw, day, 41 * MIN, { contextTokens: 737_425, model: 'mystery-model', ttl: '1h' })).toBe('next ping in 14m · 2 pings · $0.16 today')
  expect(keepWarmLine({ status: 'stopped', reason: 'skipped: pings reached one rebuild ($5.90)', pings: 40 }, day, 0, price)).toBe('skipped: pings reached one rebuild ($5.90) · 2 pings · $0.16 today')
  expect(keepWarmLine(undefined, day, 0, price)).toBe('waiting for a request · 2 pings · $0.16 today')
})

test('warm check verdicts: the first request decides (cold iff its read is under half of read + write); the turn total only against the starting context', () => {
  // tonight: the first request rebuilt everything, the turn total (later requests read the fresh cache) looked "warm"
  expect(warmVerdictFirstRequest(0, 737_425)).toBe('cold (rebuilt)')
  expect(warmVerdictFirstRequest(299_000, 1_000)).toBe('warm')
  expect(warmVerdictFirstRequest(150_000, 150_000)).toBe('warm')
  expect(warmVerdictFirstRequest(149_999, 150_001)).toBe('cold (rebuilt)')
  expect(warmVerdictFirstRequest(0, 0)).toBe('unknown')
  expect(warmVerdictTurnTotal(746_113, 737_425)).toBe('cold (rebuilt)')
  expect(warmVerdictTurnTotal(1_000, 300_000)).toBe('warm')
  expect(warmVerdictTurnTotal(150_000, 300_000)).toBe('cold (rebuilt)')
  expect(warmVerdictTurnTotal(149_999, 300_000)).toBe('warm')
  expect(warmVerdictTurnTotal(746_113, undefined)).toBe('unknown')
})

test('keep-warm switch: off by default (no ping ever); only a press turns it on, stored per user; the card\'s press too', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'] })
  engineDraws(on, 'SessionMode')
  engineDraws(on, 'AbovePrompt')
  await start($, 'desktop')
  await (await $.ui.mount(FOOTER('desktop'))).unmount()
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(3 * 60 * MIN)
  expect(w.forks).toEqual([])
  expect(kwState(w)).toBeFalsy()
  // nothing the model writes, no turn, no tick turns it on
  await say($, 'keep warm on please')
  expect(kwState(w)).toBeFalsy()
  const pane = await $.ui.mount(PANE('desktop'))
  expect((await pane.find({ type: 'Button', key: 'keepwarm' }))?.text).toBe('Off')
  await pane.press({ key: 'keepwarm' })
  expect(kwState(w)).toBe(true)
  expect((await pane.find({ type: 'Button', key: 'keepwarm' }))?.text).toBe('On')
  await pane.press({ key: 'keepwarm' })
  expect(kwState(w)).toBe(false)
  await pane.unmount()
  const band = await $.ui.mount(BAND('desktop'))
  await band.press({ key: 'tier-card-keepwarm' })
  expect(kwState(w)).toBe(true)
  expect((await band.findAll({ type: 'Svg' })).find(x => x.props.width === 28)?.props.alt).toBe('Keep warm on')
  // the switch drawing itself: the blank Button over it toggles too (the live bug: a click on the Svg did nothing)
  await band.press({ key: 'tier-card-keepwarm-switch-btn' })
  expect(kwState(w)).toBe(false)
  await band.press({ key: 'tier-card-keepwarm-switch-btn' })
  expect(kwState(w)).toBe(true)
  await band.unmount()
  const pane2 = await $.ui.mount(PANE('desktop'))
  await pane2.press({ key: 'keepwarm-hit-btn' })
  expect(kwState(w)).toBe(false)
  expect((await pane2.find({ type: 'Button', key: 'keepwarm' }))?.text).toBe('Off')
  await pane2.unmount()
  const statusFile = w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).map(x => x.text).join('\n')
  expect(statusFile).toMatch(/pane at .*: keep-warm on/)
  expect(statusFile).toMatch(/card at .*: keep-warm on/)
  // per session: the press writes $.state only, never the shared store
  expect(w.store.has('keepWarm')).toBe(false)
  expect(w.toasts).toContain('Tier: keep-warm on for this session - a ping ~55 min after your last request, until the pings add up to one rebuild.')
})

test('keep-warm switch is per session: a new session starts off whatever the shared store says; a reload of the session keeps its $.state value', async ($, on) => {
  // an old version left 'keepWarm': true in the shared store: ignored, no state of its own = off
  const w = engine(on, { surfaces: ['desktop'], store: { keepWarm: true } })
  await start($, 'desktop')
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(3 * 60 * MIN)
  expect(w.forks).toEqual([])
  expect(kwState(w)).toBe(false)
  expect(w.store.get('keepWarm')).toBe(true)
  const pane = await $.ui.mount(PANE('desktop'))
  expect((await pane.find({ type: 'Button', key: 'keepwarm' }))?.text).toBe('Off')
  await pane.unmount()
})

test('keep-warm switch survives a reload of the same session ($.state), with no store key at all', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], state: { keepWarm: true } })
  await start($, 'desktop')
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(56 * MIN)
  expect(w.forks.length).toBe(1)
  expect(kwState(w)).toBe(true)
  expect(w.store.has('keepWarm')).toBe(false)
})

test('keep-warm on: one ping 55 min after the last request START, re-armed after each ping and each real request; stops when the pings add up to one rebuild (40 on Opus, a real request restarts the count); pings recorded per day; the next real turn\'s cache read vs write goes to the status file', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], state: { keepWarm: true } })
  await start($, 'desktop')
  await step($, 't1')
  // a long turn: the ping still counts from the request's start
  await w.clock.advance(10 * MIN)
  await endTurn($, 't1')
  await w.clock.advance(44 * MIN)
  expect(w.forks).toEqual([])
  await w.clock.advance(1 * MIN)
  expect(w.forks).toEqual([T0 + 55 * MIN])
  // a ping is not a real request: the next ping counts from the ping's start
  await w.clock.advance(55 * MIN)
  expect(w.forks).toEqual([T0 + 55 * MIN, T0 + 110 * MIN])
  const day = w.store.get('cache:2026-10-24') as { pingsSent: number; pingsSentUsd: number }
  expect(day.pingsSent).toBe(2)
  expect(day.pingsSentUsd).toBeGreaterThan(0)
  // a real request re-arms from its own start
  await w.clock.advance(20 * MIN)
  await step($, 't2')
  await $.turn.complete({
    answer: 'ok',
    durationMs: 5,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 299_000, cache_creation_input_tokens: 1_000, model: OPUS },
  } as never)
  let statusFile = w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).map(x => x.text).join('\n')
  expect(statusFile).toMatch(/ping at .*: cost \$/)
  expect(statusFile).toMatch(/first real turn after the ping at .*: cache read 299000, cache write 1000 .*warm/)
  const t2 = T0 + 130 * MIN
  await w.clock.advance(54 * MIN)
  expect(w.forks.length).toBe(2)
  await w.clock.advance(1 * MIN)
  expect(w.forks[2]).toBe(t2 + 55 * MIN)
  // no more real requests: pings every 55 min until together they cost one rebuild ($2.40 = 40 x $0.06); the two pings
  // before t2 do not count, a real request restarted the tally
  await w.clock.advance(48 * 60 * MIN)
  const after = w.forks.filter(t => t > t2)
  expect(after.length).toBe(40)
  expect(after.every((t, i) => t === t2 + (i + 1) * 55 * MIN)).toBe(true)
  statusFile = w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).map(x => x.text).join('\n')
  expect(statusFile).toContain('stopped: skipped: pings reached one rebuild ($2.40)')
  // a real request starts a new round: the tally is back to 0 and 40 more pings follow
  const t3 = await w.clock.now()
  await step($, 't3')
  await endTurn($, 't3')
  await w.clock.advance(55 * MIN)
  expect(w.forks.filter(t => t > t3)).toEqual([t3 + 55 * MIN])
})

test('keep-warm stop rule on Opus at 737,425 tokens: exactly 40 pings ($5.90 = one rebuild), the 41st is skipped; the pane line counts them; a real request restarts', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], state: { keepWarm: true } })
  w.usage.tokens = 737_425
  await start($, 'desktop')
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(55 * MIN)
  expect(w.forks.length).toBe(1)
  const pane = await $.ui.mount(PANE('desktop'))
  expect(await pane.find({ type: 'Text', text: /^next ping in 55m · ping 2 of 40 · \$0\.15 of \$5\.90$/ })).toBeDefined()
  await pane.unmount()
  await w.clock.advance(45 * 60 * MIN)
  expect(w.forks.length).toBe(40)
  const file = () => w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).map(x => x.text).join('\n')
  expect(file()).toContain('stopped: skipped: pings reached one rebuild ($5.90)')
  await w.clock.advance(5 * 60 * MIN)
  expect(w.forks.length).toBe(40)
  // a real request resets the tally; keep-warm is on, so it pings again
  await step($, 't2')
  await endTurn($, 't2')
  await w.clock.advance(55 * MIN)
  expect(w.forks.length).toBe(41)
})

test('keep-warm live check: the 2026-10-25 first request rebuilt everything (read 0, write 737,425; turn total read 2,956,466 / write 746,113) -> cold, from the request own usage', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], state: { keepWarm: true } })
  w.usage.tokens = 737_425
  await start($, 'desktop')
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(56 * MIN)
  expect(w.forks.length).toBe(1)
  // the first real request after the ping reports its own usage; the turn's later requests read the fresh cache
  w.stepUsage = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 737_425, model: OPUS }
  await step($, 't2')
  w.stepUsage = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 737_425, cache_creation_input_tokens: 8_688, model: OPUS }
  await step($, 't2')
  await $.turn.complete({
    answer: 'ok',
    durationMs: 5,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 2_956_466, cache_creation_input_tokens: 746_113, model: OPUS },
  } as never)
  const file = w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).map(x => x.text).join('\n')
  expect(file).toMatch(/first real turn after the ping at .*: cache read 0, cache write 737425 \(first request\), context 737425 -> cold \(rebuilt\)/)
  expect(file).not.toMatch(/-> warm/)
})

test('keep-warm live check without a per-request usage: the turn total against the context the turn started with (those totals -> cold); a normal warm turn -> warm; no known context -> unknown', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], state: { keepWarm: true } })
  w.usage.tokens = 737_425
  await start($, 'desktop')
  const file = () => w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).map(x => x.text).join('\n')
  const turn = (id: string, read: number, write: number) =>
    $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: id, reason: 'answer', usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: write, model: OPUS } } as never)
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(56 * MIN)
  await step($, 't2')
  await turn('t2', 2_956_466, 746_113)
  expect(file()).toMatch(/\(turn total\), context 737425 -> cold \(rebuilt\)/)
  // a normal warm turn after the next ping
  await w.clock.advance(56 * MIN)
  await step($, 't3')
  await turn('t3', 2_100_000, 9_000)
  expect(file()).toMatch(/cache read 2100000, cache write 9000 \(turn total\), context 737425 -> warm/)
})

test('keep-warm skips: under 20K context, the five-hour window over 90%, the 5m TTL; a failed ping stops it and says why', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], state: { keepWarm: true } })
  await start($, 'desktop')
  const lastFile = () => w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).map(x => x.text).join('\n')
  w.usage.tokens = 10_000
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(56 * MIN)
  expect(w.forks).toEqual([])
  expect(lastFile()).toContain('skipped: context under 20K')
  w.usage.tokens = 300_000
  w.usage.fivePct = 95
  await step($, 't2')
  await endTurn($, 't2')
  await w.clock.advance(56 * MIN)
  expect(w.forks).toEqual([])
  expect(lastFile()).toContain('skipped: five-hour window 95% used')
  w.usage.fivePct = 10
  w.usage.subscription = false
  await step($, 't3')
  await endTurn($, 't3')
  await w.clock.advance(56 * MIN)
  expect(w.forks).toEqual([])
  expect(lastFile()).toContain('skipped: 5m TTL')
  w.usage.subscription = true
  w.forkReply = 'api-error'
  await step($, 't4')
  await endTurn($, 't4')
  await w.clock.advance(55 * MIN)
  expect(w.forks.length).toBe(1)
  expect(lastFile()).toContain('stopped: ping failed: api-error 529 overloaded')
  await w.clock.advance(120 * MIN)
  expect(w.forks.length).toBe(1)
  // the switch itself stays as the person left it
  expect(kwState(w)).toBe(true)
})

test('keep-warm: no ping while a turn runs', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], state: { keepWarm: true } })
  await start($, 'desktop')
  await step($, 't1')
  await w.clock.advance(56 * MIN)
  expect(w.forks).toEqual([])
  expect(w.writes.filter(x => x.path.endsWith('tier-mod-status.json')).map(x => x.text).join('\n')).toContain('skipped: a turn is running')
})

test('strip size tier by bodyColumns: 120 roomy, 99 normal, 80 compact set the Text sizes and Svg px; at 99 nothing needs truncation', async ($, on) => {
  expect(CELLS_PER_CHAR).toEqual({ caption: 0.75, footnote: 0.8, body: 0.85, heading: 1.15, title: 1.45 })
  expect([120, 110, 109, 99, 85, 84, 80].map(c => stripTier(c).name)).toEqual(['roomy', 'roomy', 'normal', 'normal', 'normal', 'compact', 'compact'])
  const w = engine(on, { surfaces: ['desktop'] })
  engineDraws(on, 'SessionMode')
  engineDraws(on, 'AbovePrompt')
  await start($, 'desktop')
  await (await $.ui.mount(FOOTER('desktop'))).unmount()
  await step($, 't1')
  await endTurn($, 't1')
  for (const r of liveDay()) w.store.set(recordKey(r), r)
  await w.clock.advance(2 * MIN)
  const want = {
    120: { figure: 'title', primary: 'footnote', label: 'caption', ring: 30, mark: 22 },
    99: { figure: 'heading', primary: 'caption', label: 'caption', ring: 30, mark: 22 },
    80: { figure: 'footnote', primary: 'caption', label: 'caption', ring: 24, mark: 18 },
  } as const
  for (const cols of [120, 99, 80] as const) {
    const x = want[cols]
    const band = await $.ui.mount(sized(12, cols))
    const sizeOf = async (re: RegExp) => (await band.find({ type: 'Text', text: re }))?.props.size
    expect(await sizeOf(/^\$\d/)).toBe(x.figure)
    expect(await sizeOf(/^Cache /)).toBe(x.primary)
    expect(await sizeOf(/^By layer/)).toBe(x.primary)
    expect(await sizeOf(/% less · vs /)).toBe(x.label)
    expect(await sizeOf(/^Saved today$/)).toBe(x.label)
    expect(await sizeOf(/^rebuild|^next msg|^kept warm|^waiting/)).toBe(x.label)
    const kw = await band.find({ type: 'Button', key: 'tier-card-keepwarm' })
    expect(kw?.text).toBe('Keep warm')
    // children only (no Text child: the desktop ignores its size), the switch Svg BEFORE the Button
    const acts = drawnByKey(await band.drawn(), 'tier-card-actions') as { children?: { children?: unknown[] }[] }
    const rowKids = (acts.children?.[0]?.children ?? []) as { type?: string; children?: unknown[] }[]
    expect(rowKids.map(k => k.type)).toEqual(['Box', 'Button'])
    // no Text child (the desktop would ignore its size), no label prop in the drawn props
    expect((rowKids[1]?.children ?? []).every(k => typeof k === 'string')).toBe(true)
    const svgs = await band.findAll({ type: 'Svg' })
    expect(svgs.some(s => s.props.width === x.ring && s.props.height === x.ring)).toBe(true)
    if (cols !== 80) expect(svgs.some(s => s.props.alt === 'Tier' && s.props.width === x.mark)).toBe(true)
    await band.unmount()
  }
  // at 99: every planned width holds its texts at the chosen sizes, the whole within 99
  const band = await $.ui.mount(sized(12, 99))
  const widthOf = async (k: string) => Number((await band.find({ type: 'Box', key: `tier-card-${k}` }))?.props.width ?? 0)
  const ws = { mark: await widthOf('mark'), saved: await widthOf('saved'), spend: await widthOf('spend'), cache: await widthOf('cache'), actions: await widthOf('actions') }
  expect(2 * STRIP_BAND_PAD + Object.values(ws).reduce((a, x) => a + x, 0) + 4 * 3).toBeLessThanOrEqual(99 - STRIP_SAFETY)
  const cacheRoom = ws.cache - svgCells(30) - 1
  const cell = async (re: RegExp) => {
    const t = await band.find({ type: 'Text', text: re })
    expect(t).toBeDefined()
    return textCells(String(t?.text), t?.props.size as StripSize)
  }
  expect(await cell(/^\$\d/)).toBeLessThanOrEqual(ws.saved)
  expect(await cell(/^Saved today$/)).toBeLessThanOrEqual(ws.saved)
  expect(await cell(/% less · vs /)).toBeLessThanOrEqual(ws.saved)
  expect(await cell(/^By layer/)).toBeLessThanOrEqual(ws.spend)
  expect(await cell(/^● opus/)).toBeLessThanOrEqual(ws.spend)
  expect(await cell(/^Cache /)).toBeLessThanOrEqual(cacheRoom)
  expect(await cell(/^rebuild|^next msg|^kept warm|^waiting/)).toBeLessThanOrEqual(cacheRoom)
  expect(textCells('Keep warm', 'body') + 1 + 1 + svgCells(STRIP_SWITCH_PX)).toBeLessThanOrEqual(ws.actions)
  expect(STRIP_ACTION_CELLS).toBeLessThanOrEqual(ws.actions)
  await band.unmount()
})

test('L4 keep-warm: the switch turned off while a ping is in flight does not arm the next ping', async ($, on) => {
  let pane: Awaited<ReturnType<typeof $.ui.mount>> | undefined
  let pressed = false
  const w = engine(on, {
    surfaces: ['desktop'],
    state: { keepWarm: true },
    onFork: async () => {
      if (pressed) return
      pressed = true
      await pane?.press({ key: 'keepwarm' })
    },
  })
  await start($, 'desktop')
  pane = await $.ui.mount(PANE('desktop'))
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(56 * MIN)
  expect(w.forks.length).toBe(1)
  expect(pressed).toBe(true)
  expect(kwState(w)).toBe(false)
  expect((w.seen as { meter?: { keepWarm?: { status: string } } }).meter?.keepWarm?.status).toBe('off')
  await w.clock.advance(180 * MIN)
  expect(w.forks.length).toBe(1)
  await pane.unmount()
})

test('#17 status line: the saving comes from the strip records (other sessions after boot too) and rolls over at local midnight', async ($, on) => {
  const w = engine(on, { surfaces: ['terminal'] })
  await start($)
  await step($, 't1')
  expect(w.status[w.status.length - 1]).toStartWith('Tier · 0 · $0.00 saved')
  // another session's hand-offs land after this one booted
  for (const r of liveDay()) w.store.set(recordKey(r), r)
  await w.clock.advance(2 * MIN)
  expect(w.status[w.status.length - 1]).toStartWith('Tier · 3 · $40.87 saved')
  // past local midnight (09:00 + 16 h): yesterday's records are not today's
  await w.clock.advance(16 * 60 * MIN)
  expect(w.status[w.status.length - 1]).toStartWith('Tier · 0 · $0.00 saved')
})

// ---------------------------------------------------------------- audit 0.19.0 batch 2: one error path, the pane

test('#18 a cache-meter failure (the store gone at a cold gap) shows: red chip, one toast, a status-file entry', async ($, on) => {
  let broken = false
  const w = engine(on, { storeBroken: () => broken })
  await start($)
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(70 * MIN)
  broken = true
  await step($, 't2')
  expect(w.toasts.filter(t => t.includes('the cache meter broke'))).toHaveLength(1)
  expect(w.seen.health?.errors.some(x => x.part === 'cache meter')).toBe(true)
  expect(statusOf(w)).toContain('cache meter: ')
})

test('L7 a ping that fails stops the round with ONE toast saying so', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], state: { keepWarm: true } })
  w.forkReply = 'api-error'
  await start($, 'desktop')
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(55 * MIN)
  expect(w.forks).toEqual([T0 + 55 * MIN])
  expect(w.toasts.filter(t => t.includes('keep-warm stopped - ping failed: api-error 529 overloaded'))).toHaveLength(1)
  expect(statusOf(w)).toContain('stopped: ping failed: api-error 529 overloaded')
})

test('L7 a policy skip (5m TTL) stays quiet: no toast', async ($, on) => {
  const w = engine(on, { surfaces: ['desktop'], state: { keepWarm: true } })
  w.usage.subscription = false
  await start($, 'desktop')
  await step($, 't1')
  await endTurn($, 't1')
  await w.clock.advance(55 * MIN)
  expect(w.forks).toEqual([])
  expect(w.toasts.filter(t => t.includes('keep-warm') && t.includes('stopped'))).toEqual([])
})

const PANE_AT = (columns: number | undefined) => {
  const p = PANE('desktop') as unknown as { props: Record<string, unknown> }
  const props = { ...p.props }
  if (columns === undefined) delete props.bodyColumns
  else props.bodyColumns = columns
  return { ...p, props } as never
}

test('#24 the pane draws its dividers and charts to its real width (bodyColumns), never wider than the cells it has', async ($, on) => {
  engine(on)
  await start($)
  for (const columns of [40, 58, 90]) {
    const ui = await $.ui.mount(PANE_AT(columns))
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.length).toBeGreaterThan(5)
    for (const s of svgs) expect(Number(s.props.width)).toBeLessThanOrEqual(cellsPx(columns))
    // the dividers are exactly the pane's width; the chart fills the padded section, at most the design's 420
    const rules = svgs.filter(s => s.props.height === 1)
    expect(rules.length).toBeGreaterThan(0)
    for (const r of rules) expect(r.props.width).toBe(cellsPx(columns))
    const chart = svgs.find(s => String(s.props.alt).startsWith('Cumulative helper spend'))
    expect(chart?.props.width).toBe(Math.min(420, cellsPx(columns - 4)))
    await ui.unmount()
  }
})

test('#24 a pane told no width falls back to the requested one', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(PANE_AT(undefined))
  const rules = (await ui.findAll({ type: 'Svg' })).filter(s => s.props.height === 1)
  expect(rules.length).toBeGreaterThan(0)
  for (const r of rules) expect(r.props.width).toBe(cellsPx(PANE_COLUMNS))
  await ui.unmount()
})

test('L5 the 7-day view counts rolled-up days: the layer table and the stopped count, each with its own title', async ($, on) => {
  const day = '2026-10-24'
  const summary = { day, handoffs: 2, running: 0, spentUsd: 0.5, savedUsd: 1, tokensKeptOut: 100, blocks: 3, blocksUsd: 0, escalations: 0, checkFailed: 0, byModel: { 'haiku/low': { count: 2, usd: 0.5 } }, byTag: { x: { count: 2, usd: 0.5 } } }
  engine(on, { store: { [SUMMARY_KEY]: { [day]: summary } } })
  await start($)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: 'Stopped this session 0' })).toBeDefined()
  await ui.press({ key: 'view-7d' })
  expect(await ui.find({ type: 'Text', text: /^Layers: .*haiku 2 \$0\.50/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Stopped · last 7 days 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'rolled-up days 3' })).toBeDefined()
  await ui.press({ key: 'view-today' })
  expect(await ui.find({ type: 'Text', text: 'Stopped today 3' })).toBeDefined()
  await ui.unmount()
})

test('#19 a render that throws is reported by its .catch handler (toast, status file) and the engine\'s own draw stands', async ($, on) => {
  // a malformed health list ($.state survives a reload): the footer's read of it throws inside the render
  const w = engine(on, { surfaces: ['desktop'], state: { health: { errors: 5 } } })
  engineDraws(on, 'SessionMode')
  await start($, 'desktop')
  const ui = await $.ui.mount(FOOTER('desktop'))
  await ui.unmount()
  expect(w.toasts.filter(t => t.includes('the SessionMode hook broke'))).toHaveLength(1)
  expect(statusOf(w)).toContain('SessionMode hook: threw')
  // mounting again does not stack the same failure
  const again = await $.ui.mount(FOOTER('desktop'))
  await again.unmount()
  expect(w.toasts.filter(t => t.includes('the SessionMode hook broke'))).toHaveLength(1)
  expect(statusOf(w).match(/SessionMode hook: threw/g)?.length).toBeGreaterThan(0)
})

test('L7 a pane press that fails (× with nothing beneath to close it) is reported, not dropped', async ($, on) => {
  const w = engine(on)
  await start($)
  const ui = await $.ui.mount(PANE('desktop'))
  await ui.press({ key: 'pane-close' })
  expect(w.closed).toEqual(['tier'])
  expect(w.toasts.filter(t => t.includes('the pane broke'))).toHaveLength(1)
  expect(w.seen.health?.errors.some(x => x.part === 'pane')).toBe(true)
  await ui.unmount()
})
