// tier-mod, part 1: the core. Facts (prompt.compose), the hand-off gate (Agent and Workflow, any loop),
// the work gate (the main loop's own tool calls), the ledger (agent.spawn, turn.step, turn.complete, the
// helpers' tool calls) and the savings meter. Every gate fails OPEN on its own error: the call goes
// through, the part is named in a toast, the health atom and ~/.claude/tier-mod-status.json.
//
// The screen (part2.tsx) reads the $.state atoms declared in types/index.d.ts (keys in state.ts).
import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  TierBlock,
  TierFacts,
  TierGate,
  TierHandoff,
  TierMain,
  TierNotice,
  TierOutcome,
  TierRecord,
  TierRuntime,
  TierScanEntry,
  TierSettings,
  TierTotals,
  TierTtl,
} from '../types'
import {
  RECORD_PREFIX,
  SUMMARY_KEY,
  addHelperCall,
  mainPrices,
  addTotals,
  classifyTool,
  editTargets,
  isCheckCommand,
  compareVersions,
  costUsd,
  dayKey,
  dayOfKey,
  daysToRoll,
  emptySavingsInputs,
  emptyTotals,
  escalationNote,
  exitCodeOf,
  failureSignature,
  findOldTierHooks,
  findRuleTag,
  freshGate,
  gateAgent,
  gateWorkflow,
  isClaudeOwnFile,
  isEscalate,
  isLineFile,
  kTokens,
  nextRung,
  normPath,
  countLines,
  oldHooksNotice,
  parseTag,
  readAgentPins,
  readSettings,
  recordKey,
  refusalCostUsd,
  savingsOf,
  scanWorkflowScript,
  summarizeDay,
  tokensOf,
  totalsOf,
  workAfter,
  workBefore,
} from './core'
import type { AgentPins, GateVerdict, WorkCall } from './core'
import { FACTS_ADDENDUM, RULE_BLOCK, RULE_VERSION } from './facts-text'
import { isPinging, part2SessionStart, part2StepResult, part2TurnComplete, part2TurnStep, registerPart2 } from './part2'
import { errorMessage, hookFailed, homeDir, join, pluginVersion, readText, reportError, resetReport, status, toast, writeStatus } from './report'
import type { BootVia } from './report'
import { withOverrideNotes, withPromptNotes } from './override'
import { currentLoad, enforceValue, liveErrors, newLoad, readStoredEnforce, setEnforceLocal } from './state'

type $ = EngineInterface

// $.state refs: the engine lists them from consts of this file (keys documented in state.ts).
const HANDOFFS = { plugin: 'tier-mod', key: 'handoffs' } as const
const BLOCKS = { plugin: 'tier-mod', key: 'blocks' } as const
const TOTALS = { plugin: 'tier-mod', key: 'totals' } as const
const ENFORCE = { plugin: 'tier-mod', key: 'enforce' } as const
const HEALTH = { plugin: 'tier-mod', key: 'health' } as const
const GATE = { plugin: 'tier-mod', key: 'gate' } as const
const MAIN = { plugin: 'tier-mod', key: 'main' } as const
const NOTICES = { plugin: 'tier-mod', key: 'notices' } as const
const FACTS = { plugin: 'tier-mod', key: 'facts' } as const
const SETTINGS = { plugin: 'tier-mod', key: 'settings' } as const
const RUNTIME = { plugin: 'tier-mod', key: 'runtime' } as const
const METER = { plugin: 'tier-mod', key: 'meter' } as const

/** The section id the facts ride under in the system prompt. */
export const FACTS_SECTION_ID = 'tier:facts'
const MAX_HANDOFFS = 300
const MAX_BLOCKS = 100

/** tool.describe lines (constant text: the prompt cache). */
export const DESCRIBE_HANDOFF =
  'Tier: name model and effort on every call (workflow agent(): model, effort, agentType), tag it [t=<task>]; calls without them are refused.'
export const DESCRIBE_WEB = 'Tier: the main session hands web work to tier-mod:reader.'

export type { BootVia }
/** Facts of a lazy (mid-session) boot: nothing injected, so the cache is not rebuilt. */
const SKIPPED_FACTS: TierFacts = { mode: 'skipped', reason: 'mid-session load', text: '' }

export function emptyRuntime(sessionId = 'unknown'): TierRuntime {
  return { sessionId, pendingSpawn: {}, agentRecord: {}, scans: {}, tagTries: {}, pendingNotes: {}, returned: {}, resumes: {} }
}

/** A runtime an older version left in $.state (it survives a reload) gains the maps it lacks. */
export function normalizeRuntime(r: Partial<TierRuntime> | null | undefined, sessionId: string): TierRuntime {
  const base = emptyRuntime(typeof r?.sessionId === 'string' ? r.sessionId : sessionId)
  if (!r || typeof r !== 'object') return base
  const out: Record<string, unknown> = { ...base, ...r }
  for (const k of Object.keys(base)) {
    if (k === 'sessionId') continue
    const v = out[k]
    if (!v || typeof v !== 'object' || Array.isArray(v)) out[k] = (base as Record<string, unknown>)[k]
  }
  return out as TierRuntime
}

/**
 * The addendum with the person's CURRENT limits (the source text is written with the defaults 8K / 2 / 300).
 * Built once per session: decideFacts stores the result in $.state, so the system prompt stays constant (cached).
 */
export function factsAddendum(settings: Pick<TierSettings, 'readTokens' | 'readLines' | 'editFiles'>): string {
  const files = `${settings.editFiles} file${settings.editFiles === 1 ? '' : 's'}`
  return FACTS_ADDENDUM.replace('up to 8K tokens', `up to ${kTokens(settings.readTokens)} tokens`)
    .replace('edit up to 2 files', `edit up to ${files}`)
    .replace('a Read of a 300+ line file', `a Read of a ${settings.readLines}+ line file`)
}

/** The facts text for a session, from the tier-rule tag a loaded CLAUDE.md carries (or none). */
export function factsFor(
  settings: Pick<TierSettings, 'facts' | 'readTokens' | 'readLines' | 'editFiles'>,
  found: { version: string; path: string } | null,
): TierFacts {
  if (settings.facts === 'off') return { mode: 'off', text: '' }
  const addendum = factsAddendum(settings)
  if (found && (!RULE_VERSION || compareVersions(found.version, RULE_VERSION) >= 0)) {
    return { mode: 'addendum', foundVersion: found.version, foundIn: found.path, text: addendum }
  }
  const full = `${addendum}\n\n${RULE_BLOCK}`
  if (found) return { mode: 'addendum+rule', foundVersion: found.version, foundIn: found.path, text: full }
  return { mode: 'addendum+rule', text: full }
}

// ------------------------------------------------------------------ small helpers

function clip(text: string | undefined, n: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 3)}...` : t
}

/** Keeps the newest `max` keys of a record (insertion order). */
function capKeys<V>(rec: Record<string, V>, max: number): Record<string, V> {
  const keys = Object.keys(rec)
  if (keys.length <= max) return rec
  const out: Record<string, V> = {}
  for (const k of keys.slice(-max)) out[k] = rec[k] as V
  return out
}

function withContext<R extends { deny?: unknown; context?: readonly string[] }>(ran: R, notes: string[]): R {
  if (notes.length === 0 || ran.deny !== undefined) return ran
  return { ...ran, context: [...(ran.context ?? []), ...notes] }
}


/** One main request re-reading the whole context: the round trip the hand-off result itself causes. 0 when unknown. */
function handoffRoundTrip(model: string | undefined, contextTokens: number | undefined, ttl?: TierTtl): number {
  const p = mainPrices(model, ttl, contextTokens)
  return p && contextTokens ? Math.round(contextTokens * p.read * 1e6) / 1e6 : 0
}

const WORKFLOW_UNREADABLE = "Tier can't check this workflow's agents: pass the script inline or a readable scriptPath."

/** A named workflow's script: the project's .claude/workflows/ first, then ~/.claude/workflows/. Null when neither has it. */
async function readNamedWorkflow($: $, name: string): Promise<string | null> {
  let root: string | undefined
  try {
    root = await $.session.cwd()
  } catch {
    root = undefined
  }
  if (!root) {
    try {
      root = await $.session.root()
    } catch {
      root = undefined
    }
  }
  let home: string | undefined
  try {
    home = await homeDir($)
  } catch {
    home = undefined
  }
  const dirs = [root && join(root, '.claude', 'workflows'), home && join(home, '.claude', 'workflows')].filter((d): d is string => !!d)
  const names = /\.(m|c)?[jt]s$/i.test(name) ? [name] : ['.js', '.mjs', '.cjs', '.ts', '.mts'].map(x => name + x)
  for (const dir of dirs) {
    for (const n of names) {
      const text = await readText($, join(dir, n))
      if (text !== null) return text
    }
  }
  return null
}

/** Records a refusal; a ledger failure is reported and never undoes the refusal. */
async function addBlockSafe($: $, b: Parameters<typeof addBlock>[1], toolUseId: string | undefined): Promise<void> {
  try {
    await addBlock($, b, toolUseId)
  } catch (err) {
    await reportError($, 'block ledger', err)
  }
}

async function rt($: $, fn: (r: TierRuntime) => TierRuntime): Promise<TierRuntime> {
  return update($, RUNTIME, r => fn(normalizeRuntime(r, sessionIdCache)))
}

async function readRuntime($: $): Promise<TierRuntime> {
  return normalizeRuntime((await $.state.get(RUNTIME)).value, sessionIdCache)
}

async function readHandoffs($: $): Promise<TierHandoff[]> {
  return (await $.state.get(HANDOFFS)).value ?? []
}

async function readGate($: $): Promise<TierGate> {
  return (await $.state.get(GATE)).value ?? freshGate()
}

async function readMain($: $): Promise<TierMain> {
  return (await $.state.get(MAIN)).value ?? { requests: 0 }
}

/** The main session's cache TTL as the meter last saw it (undefined before the first request: priced as 1h). */
async function readTtl($: $): Promise<TierTtl | undefined> {
  try {
    return (await $.state.get(METER)).value?.ttl
  } catch {
    return undefined
  }
}

let sessionIdCache = 'unknown'
async function sessionId($: $): Promise<string> {
  if (sessionIdCache !== 'unknown') return sessionIdCache
  try {
    const id = await $.session.id()
    if (id) sessionIdCache = id
  } catch {
    // stays 'unknown'
  }
  return sessionIdCache
}

// ------------------------------------------------------------------ ledger (append-only, one store key per record)

let storeChain: Promise<unknown> = Promise.resolve()
const dirty = new Set<string>()

function persist($: $, rec: TierRecord): Promise<void> {
  const run = storeChain.then(() => $.store.set(recordKey(rec), rec))
  storeChain = run.catch(() => undefined)
  return run.catch(err => reportError($, 'ledger', err))
}

/** Other sessions' records of today, loaded at boot. */
let othersToday: TierTotals = emptyTotals()
let othersDay = ''

async function refreshTotals($: $): Promise<void> {
  const now = await $.clock.now()
  const today = dayKey(now)
  const handoffs = await readHandoffs($)
  const blocks = (await $.state.get(BLOCKS)).value ?? []
  const mine: TierRecord[] = [...handoffs, ...blocks]
  const session = totalsOf(mine)
  const todayMine = totalsOf(mine.filter(r => r.day === today))
  const base = othersDay === today ? othersToday : emptyTotals()
  await update($, TOTALS, () => ({ day: today, session, today: addTotals(base, todayMine) }))
}

function withSavings(h: TierHandoff): TierHandoff {
  const saved = savingsOf(h.savingsInputs, h.costUsd, h.tokens?.output ?? 0)
  const upd = { ...h }
  if (saved) upd.saved = saved
  else delete upd.saved
  return upd
}

/** The newest MAX_HANDOFFS records: the oldest settled ones go first, a 'running' one is never evicted. */
export function capHandoffs(list: readonly TierHandoff[], max = MAX_HANDOFFS): TierHandoff[] {
  let over = list.length - max
  if (over <= 0) return [...list]
  return list.filter(h => {
    if (over > 0 && h.outcome !== 'running') {
      over--
      return false
    }
    return true
  })
}

/** Removes a hand-off whose helper never started (a denied or errored Agent call). True when it did. */
async function dropUnstarted($: $, id: string): Promise<boolean> {
  const h = (await readHandoffs($)).find(x => x.id === id)
  if (!h || h.outcome !== 'running' || h.agentId !== undefined) return false
  await update($, HANDOFFS, list => (list ?? []).filter(x => x.id !== id))
  dirty.delete(id)
  const run = storeChain.then(() => $.store.delete(recordKey(h)))
  storeChain = run.catch(() => undefined)
  await run.catch(err => reportError($, 'ledger', err))
  await rt($, r => {
    const { [id]: _gone, ...pendingSpawn } = r.pendingSpawn
    return { ...r, pendingSpawn }
  })
  await refreshTotals($)
  return true
}

async function addHandoff($: $, h: TierHandoff): Promise<void> {
  const rec = withSavings(h)
  await update($, HANDOFFS, list => capHandoffs([...(list ?? []).filter(r => r.id !== rec.id), rec]))
  await persist($, rec)
  await refreshTotals($)
}

/** Patches one hand-off; `store` false keeps it in state only (marked dirty, persisted later). */
async function patchHandoff($: $, id: string, fn: (h: TierHandoff) => TierHandoff, store = true): Promise<TierHandoff | undefined> {
  let changed: TierHandoff | undefined
  await update($, HANDOFFS, list =>
    (list ?? []).map(h => {
      if (h.id !== id) return h
      changed = withSavings(fn(h))
      return changed
    }),
  )
  if (!changed) return undefined
  if (store) {
    dirty.delete(id)
    await persist($, changed)
  } else dirty.add(id)
  await refreshTotals($)
  return changed
}

async function flushDirty($: $): Promise<void> {
  if (dirty.size === 0) return
  const ids = new Set(dirty)
  dirty.clear()
  for (const h of await readHandoffs($)) if (ids.has(h.id)) await persist($, h)
}

async function addBlock($: $, b: Omit<TierBlock, 'kind' | 'id' | 'day' | 'sessionId' | 'at' | 'costUsd'>, toolUseId: string | undefined): Promise<void> {
  const at = await $.clock.now()
  const main = await readMain($)
  const block: TierBlock = { kind: 'block', id: `block:${toolUseId ?? at}`, at, day: dayKey(at), sessionId: await sessionId($), ...b }
  const cost = refusalCostUsd(main.contextTokens, main.model, (await readTtl($)) ?? '1h')
  if (cost !== undefined) block.costUsd = cost
  await update($, BLOCKS, list => [...(list ?? []), block].slice(-MAX_BLOCKS))
  await persist($, block)
  await refreshTotals($)
  if (block.action !== 'would-refuse') toast($, block.toast)
}

/** Notes for a hand-off: on its tool result when still to come, else as a message after it. */
async function deliverNotes($: $, sinkId: string | undefined, notes: string[]): Promise<void> {
  if (notes.length === 0) return
  const runtime = await readRuntime($)
  if (sinkId === undefined || runtime.returned[sinkId]) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: notes.join('\n\n') }] } })
    return
  }
  await rt($, r => ({ ...r, pendingNotes: { ...r.pendingNotes, [sinkId]: [...(r.pendingNotes[sinkId] ?? []), ...notes] } }))
}

/** Marks a tool result as returned and takes the notes waiting for it. */
async function takeNotes($: $, sinkId: string): Promise<string[]> {
  let notes: string[] = []
  await rt($, r => {
    notes = r.pendingNotes[sinkId] ?? []
    const pendingNotes = { ...r.pendingNotes }
    delete pendingNotes[sinkId]
    return { ...r, pendingNotes, returned: capKeys({ ...r.returned, [sinkId]: true as const }, 200) }
  })
  return notes
}

async function bumpTry($: $, tag: string | null): Promise<number> {
  if (!tag) return 0
  let n = 0
  await rt($, r => {
    n = (r.tagTries[tag] ?? 0) + 1
    return { ...r, tagTries: { ...r.tagTries, [tag]: n } }
  })
  return n
}

// ------------------------------------------------------------------ agent files (pins)

async function enabledPluginDirs($: $, name: string): Promise<string[]> {
  try {
    const enabled = (await $.settings.read({ key: 'enabledPlugins' })) as Record<string, unknown> | undefined
    const home = await homeDir($)
    if (!enabled || !home) return []
    const text = await readText($, join(home, '.claude', 'plugins', 'installed_plugins.json'))
    if (text === null) return []
    const installed = (JSON.parse(text) as { plugins?: Record<string, { installPath?: unknown }[]> }).plugins ?? {}
    const dirs: string[] = []
    for (const [id, installs] of Object.entries(installed)) {
      if (!id.startsWith(`${name}@`) || enabled[id] !== true || !Array.isArray(installs)) continue
      for (const i of installs) if (typeof i?.installPath === 'string') dirs.push(i.installPath)
    }
    return dirs
  } catch {
    return []
  }
}

/** Pins of an agent type's file; undefined for a built-in or no type, null when not found. */
const pinCache = new Map<string, AgentPins | null>()
async function lookupPins($: $, type: string | undefined): Promise<AgentPins | null | undefined> {
  if (!type || type === 'fork' || type === 'general-purpose') return undefined
  const hit = pinCache.get(type)
  if (hit !== undefined) return hit
  let pins: AgentPins | null = null
  const colon = type.indexOf(':')
  if (colon > 0) {
    const plugin = type.slice(0, colon)
    const file = `${type.slice(colon + 1)}.md`
    if (plugin === $.plugin.name) {
      const text = await readText($, join($.plugin.root, 'agents', file))
      pins = text === null ? null : readAgentPins(text)
    } else {
      for (const dir of await enabledPluginDirs($, plugin)) {
        const text = await readText($, join(dir, 'agents', file))
        if (text !== null) {
          pins = readAgentPins(text)
          break
        }
      }
    }
  } else {
    const home = await homeDir($)
    let root: string | undefined
    try {
      root = await $.session.root()
    } catch {
      root = undefined
    }
    const dirs = [root && join(root, '.claude', 'agents'), home && join(home, '.claude', 'agents')].filter((d): d is string => !!d)
    for (const dir of dirs) {
      const text = await readText($, join(dir, `${type}.md`))
      if (text !== null) {
        pins = readAgentPins(text)
        break
      }
    }
  }
  pinCache.set(type, pins)
  return pins
}

// ------------------------------------------------------------------ boot
// Run once per module instance. A mod enabled mid-session never sees session.start, so the first
// prompt.submit / turn.step / tool.call / agent.spawn boots it instead (lazy: no facts section).

let bootSettings: TierSettings = readSettings({})
let bootPromise: Promise<void> | undefined

function resetBoot(settings: TierSettings): void {
  bootSettings = settings
  bootPromise = undefined
  resetReport()
  storeChain = Promise.resolve()
  dirty.clear()
  othersToday = emptyTotals()
  othersDay = ''
  sessionIdCache = 'unknown'
  setEnforceLocal(undefined)
  newLoad()
}

async function step($: $, label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    await reportError($, label, err)
  }
}

async function runBoot($: $, cwd: string | undefined, via: BootVia): Promise<void> {
  const settings = bootSettings
  status.bootedVia = via
  try {
    status.at = new Date(await $.clock.now()).toISOString()
  } catch {
    status.at = new Date().toISOString()
  }
  const sid = await sessionId($)
  await step($, 'version', async () => {
    status.version = await pluginVersion($)
  })
  await step($, 'settings', () => update($, SETTINGS, () => settings))
  await step($, 'runtime', () => update($, RUNTIME, r => normalizeRuntime(r, sid)))
  await step($, 'atoms', async () => {
    await update($, GATE, g => g ?? freshGate())
    await update($, MAIN, m => m ?? { requests: 0 })
    await update($, HEALTH, h => h ?? { errors: [] })
    await update($, HANDOFFS, l => l ?? [])
    await update($, BLOCKS, l => l ?? [])
  })
  await step($, 'enforce', async () => {
    const on = await readStoredEnforce($, settings.enforce)
    setEnforceLocal(on)
    await update($, ENFORCE, () => on)
  })
  if (via === 'session.start') await step($, 'facts', () => decideFacts($, settings, cwd))
  else await step($, 'facts', () => update($, FACTS, prev => prev ?? SKIPPED_FACTS))
  await step($, 'facts-status', async () => {
    const f = (await $.state.get(FACTS)).value
    status.facts = f ? (f.mode === 'skipped' ? `skipped: ${f.reason ?? 'mid-session load'}` : f.mode) : 'undecided'
  })
  await step($, 'effort-env', () => warnEffortEnv($))
  await step($, 'old-hooks', () => detectOldHooks($))
  await step($, 'ledger', () => loadLedger($, sid))
  await step($, 'totals', () => refreshTotals($))
  await step($, 'part2', () => part2SessionStart($, (name, result) => recordRegistration($, name, result)))
  await writeStatus($)
}

async function recordRegistration($: $, name: string, result: string): Promise<void> {
  status.registrations[name] = result
  // A registration (command:...) that is not 'ok' is a part that failed to start: chip and toast too.
  if (name.startsWith('command:') && result !== 'ok') await reportError($, name, result)
  else await writeStatus($)
}

/** Idempotent: the first caller starts the boot, every other gets the same promise. Never rejects. */
export function boot($: $, cwd: string | undefined, via: BootVia): Promise<void> {
  if (bootPromise === undefined) {
    if (via === 'session.start') status.sessionStartSeen = true
    bootPromise = runBoot($, cwd, via).catch(err => reportError($, 'boot', err))
  } else if (via === 'session.start' && !status.sessionStartSeen) {
    status.sessionStartSeen = true
    void bootPromise.then(() => writeStatus($))
  }
  return bootPromise
}

async function lazyBoot($: $, via: BootVia): Promise<void> {
  if (bootPromise !== undefined) return
  try {
    await boot($, undefined, via)
  } catch {
    // never throws
  }
}

function lazyFire($: $, via: BootVia): void {
  if (bootPromise !== undefined) return
  try {
    void boot($, undefined, via).catch(() => undefined)
  } catch {
    // never throws
  }
}

// ------------------------------------------------------------------ register

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  resetBoot(settings)
  const enforceOn = () => enforceValue(settings.enforce)

  // ---------------------------------------------------------------- session start / end
  on('session.start', async ($, e, next) => {
    await boot($, e.cwd, 'session.start')
    return next(e)
  }).catch(async ($, e, next) => {
    await hookFailed($, 'session.start', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- the note to the model (constant)
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const facts = (await $.state.get(FACTS)).value
    if (!facts || !facts.text || result.sections.some(s => s.id === FACTS_SECTION_ID)) return result
    return { sections: [...result.sections, { id: FACTS_SECTION_ID, text: facts.text, scope: 'session' as const }] }
  }).catch(async ($, e, next) => {
    await hookFailed($, 'prompt.compose', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- the user's own message: counters reset
  on('prompt.submit', async ($, e, next) => {
    await lazyBoot($, 'prompt.submit')
    const kind = e.origin.kind
    if (!e.isMeta && !e.command && (kind === 'composer' || kind === 'bridge')) {
      try {
        const folded = e.turnId !== undefined
        await update($, GATE, g => freshGate(e.text, g, folded))
      } catch (err) {
        await reportError($, 'message counter', err)
      }
    }
    // The notes about the person's presses ("Do it myself", "Allow max") ride on their own message.
    return next(await withPromptNotes($, e))
  }).catch(async ($, e, next) => {
    await hookFailed($, 'prompt.submit', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- tool descriptions (constant lines)
  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    const line = e.tool === 'Agent' || e.tool === 'Workflow' ? DESCRIBE_HANDOFF : e.tool === 'WebSearch' || e.tool === 'WebFetch' ? DESCRIBE_WEB : undefined
    return line ? { ...r, description: `${r.description}\n\n${line}` } : r
  }).catch(async ($, e, next) => {
    await hookFailed($, 'tool.describe', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- the heavy general-purpose agent is not offered
  on('agent.offer', async ($, e, next) => {
    if (e.agent === 'general-purpose') return { isOffered: false }
    return next(e)
  }).catch(async ($, e, next) => {
    await hookFailed($, 'agent.offer', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- hand-off gate + ledger: Agent (any loop)
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    lazyFire($, 'tool.call')
    const id = e.tool_use_id
    try {
      const tag = parseTag(e.description)
      const pins = await lookupPins($, e.subagent_type)
      const gate = await readGate($)
      const handoffs = await readHandoffs($)
      const verdict = gateAgent(
        { model: e.model, effort: e.effort, subagentType: e.subagent_type, filePins: pins },
        tag,
        { handoffs, userAskedMaxOrFable: gate.userAskedMaxOrFable, allowedTags: gate.allowMaxTags ?? [] },
      )
      if (verdict.kind === 'refuse') {
        const enforce = enforceOn()
        const why = verdict.reason.includes('names no') ? 'it named no model/effort' : 'max/fable is for escalation only'
        const block: Omit<TierBlock, 'kind' | 'id' | 'day' | 'sessionId' | 'at' | 'costUsd'> = {
          gate: 'handoff',
          tool: 'Agent',
          action: enforce ? 'refused' : 'would-refuse',
          reason: verdict.reason,
          toast: `Tier refused a hand-off: ${why}`,
        }
        if (tag) block.tag = tag
        // A ledger failure never turns the decided refusal into an allow.
        await addBlockSafe($, block, id)
        if (enforce) return { deny: verdict.reason }
      }
      const now = await $.clock.now()
      const main = await readMain($)
      const ttl = await readTtl($)
      const type = e.subagent_type ?? 'general-purpose'
      const h: TierHandoff = {
        kind: 'handoff',
        id,
        at: now,
        day: dayKey(now),
        sessionId: await sessionId($),
        tag,
        try: await bumpTry($, tag),
        via: type === 'fork' ? 'fork' : 'agent',
        helperType: type,
        title: clip(e.description, 80),
        model: type === 'fork' ? main.model ?? 'inherit' : e.model ?? pins?.model ?? 'inherit',
        effort: e.effort ?? pins?.effort ?? 'unknown',
        effortSource: e.effort ?? pins?.effort ? 'call' : 'unknown',
        outcome: 'running',
        savingsInputs: {
          ...emptySavingsInputs(main.model, ttl, main.contextTokens),
          briefTokens: tokensOf(e.prompt) + tokensOf(e.description),
          handoffRoundTripUsd: handoffRoundTrip(main.model, main.contextTokens, ttl),
        },
      }
      if (verdict.kind === 'pass' && verdict.unverifiable) h.unverifiable = true
      if (verdict.kind === 'refuse') h.unverifiable = true
      await addHandoff($, h)
      await rt($, r => ({ ...r, pendingSpawn: capKeys({ ...r.pendingSpawn, [id]: id }, 300) }))
    } catch (err) {
      await reportError($, 'hand-off gate', err)
    }

    const ran = await next(e)

    try {
      if (ran.deny !== undefined) {
        // Denied before the helper started: no cost, no saving - the 'running' record goes.
        await dropUnstarted($, id)
        return ran
      }
      const notes = await takeNotes($, id)
      if (ran.isError && (await dropUnstarted($, id))) return withContext(ran, notes)
      // A background launch returns an acknowledgement, not the digest: that is counted when the helper finishes.
      const h = await patchHandoff($, id, x => (x.background ? x : { ...x, savingsInputs: { ...x.savingsInputs, digestTokens: tokensOf(ran.text) } }))
      // Fallback: a foreground result that says ESCALATE: when no turn.complete reached the mod.
      if (h && h.outcome === 'running' && notes.length === 0 && !ran.isError && isEscalate(ran.text)) {
        const note = await settleOutcome($, h, ran.text ?? '')
        if (note) notes.push(note)
      }
      return withContext(ran, notes)
    } catch (err) {
      await reportError($, 'ledger', err)
      return ran
    }
  }).catch(async ($, e, next) => {
    await hookFailed($, 'tool.call Agent', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- hand-off gate: Workflow (before launch; a resume is scanned again)
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    lazyFire($, 'tool.call')
    const id = e.tool_use_id
    try {
      let text: string | null = null
      if (e.scriptPath) text = await readText($, e.scriptPath)
      if (text === null && e.script) text = e.script
      if (text === null && !e.scriptPath && e.name) text = await readNamedWorkflow($, e.name)
      if (text === null && (e.scriptPath || e.name)) {
        // Neither the script nor the scriptPath can be read (a built-in or missing named workflow too).
        const enforce = enforceOn()
        await reportError($, 'hand-off gate', new Error(e.scriptPath ? `unreadable scriptPath ${e.scriptPath}` : `unresolved workflow name ${e.name}`))
        await addBlockSafe($, { gate: 'handoff', tool: 'Workflow', action: enforce ? 'refused' : 'would-refuse', reason: WORKFLOW_UNREADABLE, toast: "Tier refused a workflow: its agents can't be checked" }, id)
        if (enforce) return { deny: WORKFLOW_UNREADABLE }
      }
      if (text !== null) {
        const entries = scanSafe(text)
        const gate = await readGate($)
        const verdict = gateWorkflow(entries, { handoffs: await readHandoffs($), userAskedMaxOrFable: gate.userAskedMaxOrFable, allowedTags: gate.allowMaxTags ?? [] })
        if (verdict.kind === 'refuse') {
          const enforce = enforceOn()
          const why = verdict.reason.includes('names no') ? 'an agent() named no model/effort/agentType' : 'max/fable is for escalation only'
          await addBlockSafe($, { gate: 'handoff', tool: 'Workflow', action: enforce ? 'refused' : 'would-refuse', reason: verdict.reason, toast: `Tier refused a workflow: ${why}` }, id)
          if (enforce) return { deny: verdict.reason }
        }
        await rt($, r => ({ ...r, scans: capKeys({ ...r.scans, [id]: entries }, 20) }))
      }
    } catch (err) {
      await reportError($, 'hand-off gate', err)
    }
    const ran = await next(e)
    try {
      return withContext(ran, await takeNotes($, id))
    } catch {
      return ran
    }
  }).catch(async ($, e, next) => {
    await hookFailed($, 'tool.call Workflow', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- every other tool call: the work gate (main) or a helper's call (ledger)
  // Every call passes here (Agent and Workflow too): a main-loop result carries the notes about the person's
  // presses (override.ts); a refused or withheld one keeps them queued.
  on('tool.call', async ($, e, next) => {
    const out = await (async () => {
      lazyFire($, 'tool.call')
      const tool = String(e.tool)
      if (e.agentId !== undefined) return helperCall($, e as unknown as HelperCallInput, tool, () => next(e))
      const args = e as unknown as Record<string, unknown>
      const cls = classifyTool(tool, args)
      if (cls === 'exempt') return next(e)
      try {
        const gate = await readGate($)
        const call: WorkCall = { tool }
        if (typeof args.command === 'string') call.command = args.command
        const path = typeof args.file_path === 'string' ? args.file_path : typeof args.notebook_path === 'string' ? args.notebook_path : undefined
        if (path) call.filePath = path
        call.hasRange = args.offset !== undefined || args.limit !== undefined || args.pages !== undefined
        if (typeof args.content === 'string') call.content = args.content
        if (tool === 'Monitor' && args.ws !== undefined && args.ws !== null) call.ws = true
        let fileLines: number | undefined
        if (cls === 'read' && !call.hasRange && path && isLineFile(path) && !gate.override) {
          const text = await readText($, path)
          if (text !== null) fileLines = countLines(text)
        }
        const decided = { verdict: workBefore(call, gate, settings, fileLines) }
        const files = editTargets(call)
        const withFiles = (g: TierGate): TierGate => {
          const add = files.filter(f => !g.editFiles.includes(f))
          return add.length > 0 ? { ...g, editFiles: [...g.editFiles, ...add] } : g
        }
        if (decided.verdict.kind === 'pass' && files.length > 0) {
          // Decide and count in one read-modify-write: parallel calls cannot both slip under the limit.
          await update($, GATE, g => {
            const base = g ?? freshGate()
            decided.verdict = workBefore(call, base, settings, fileLines)
            return decided.verdict.kind === 'refuse' ? base : withFiles(base)
          })
        }
        const verdict = decided.verdict
        if (verdict.kind === 'refuse') {
          const enforce = enforceOn()
          await addBlockSafe($, { gate: verdict.gate, tool, action: enforce ? 'refused' : 'would-refuse', reason: verdict.reason, toast: verdict.toast }, e.tool_use_id)
          if (enforce) return { deny: verdict.reason }
          if (files.length > 0) await update($, GATE, g => withFiles(g ?? freshGate()))
        }
      } catch (err) {
        await reportError($, 'work gate', err)
        return next(e)
      }

      const ran = await next(e)

      try {
        if (ran.deny !== undefined) return ran
        const tokens = tokensOf(ran.text)
        const readOnly = ran.isReadOnly === true
        const checked = { after: workAfter(tool, readOnly, tokens, await readGate($), settings) }
        const addTokens = (g: TierGate | undefined): TierGate => ({ ...(g ?? freshGate()), readTokens: (g?.readTokens ?? 0) + tokens })
        if (checked.after.counts) {
          // Decide and count in one read-modify-write: parallel reads cannot both fit the same room.
          await update($, GATE, g => {
            checked.after = workAfter(tool, readOnly, tokens, g ?? freshGate(), settings)
            return checked.after.counts ? addTokens(g) : g ?? freshGate()
          })
        }
        const after = checked.after
        if (after.withhold) {
          const enforce = enforceOn()
          await addBlockSafe($, { gate: 'read', tool, action: enforce ? 'withheld' : 'would-refuse', reason: after.withhold.reason, toast: after.withhold.toast }, e.tool_use_id)
          if (enforce) return { deny: after.withhold.reason }
          await update($, GATE, addTokens)
        }
        return ran
      } catch (err) {
        await reportError($, 'work gate', err)
        return ran
      }
    })()
    return withOverrideNotes($, e.agentId, out)
  }).catch(async ($, e, next) => {
    await hookFailed($, 'tool.call', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- ledger: spawn -> agentId (every helper, however it started)
  on('agent.spawn', async ($, e, next) => {
    lazyFire($, 'agent.spawn')
    const spawned = await next(e)
    try {
      if (spawned.deny !== undefined || !spawned.agentId) return spawned
      const agentId = spawned.agentId
      const runtime = await readRuntime($)
      const now = await $.clock.now()
      const main = await readMain($)
      const ttl = await readTtl($)
      const base = async (id: string, tag: string | null, via: TierHandoff['via']): Promise<TierHandoff> => ({
        kind: 'handoff',
        id,
        at: now,
        day: dayKey(now),
        sessionId: await sessionId($),
        tag,
        try: 0,
        via,
        helperType: e.subagentType,
        title: clip(e.description, 80),
        model: spawned.model || e.model || 'inherit',
        effort: 'unknown',
        effortSource: 'unknown',
        agentId,
        outcome: 'running',
        savingsInputs: {
          ...emptySavingsInputs(main.model, ttl, main.contextTokens),
          briefTokens: tokensOf(e.prompt),
          handoffRoundTripUsd: handoffRoundTrip(main.model, main.contextTokens, ttl),
        },
      })
      if (e.resume) {
        // A continuation (SendMessage, a background wake): a new record that inherits the tag and try.
        const prevId = runtime.agentRecord[agentId]
        const prev = prevId ? (await readHandoffs($)).find(h => h.id === prevId) : undefined
        const n = (runtime.resumes[agentId] ?? 0) + 1
        const h = await base(`resume:${agentId}:${n}`, prev?.tag ?? parseTag(e.description), 'resume')
        h.try = prev?.try ?? 0
        if (prev) {
          h.helperType = prev.helperType
          h.title = prev.title
          h.effort = prev.effort
          h.effortSource = prev.effortSource
        }
        await addHandoff($, h)
        await rt($, r => ({ ...r, agentRecord: capKeys({ ...r.agentRecord, [agentId]: h.id }, 300), resumes: { ...r.resumes, [agentId]: n } }))
        return spawned
      }
      if (e.workflow) {
        // agentIndex restarts when a run resumes: a retry of agent #1 must not overwrite the first attempt's record.
        const baseId = `${e.workflow.runId}#${e.workflow.agentIndex}`
        const taken = (await readHandoffs($)).some(x => x.id === baseId && x.agentId !== undefined && x.agentId !== agentId)
        const recId = taken ? `${baseId}:${agentId}` : baseId
        const scan: TierScanEntry[] = runtime.scans[e.tool_use_id] ?? []
        const tag = parseTag(e.description)
        const entry = matchScanEntry(scan, e.description)
        const h = await base(recId, tag, 'workflow')
        h.try = await bumpTry($, tag)
        if (entry?.effort) {
          h.effort = entry.effort
          h.effortSource = 'call'
        }
        if (!entry || entry.status !== 'ok') h.unverifiable = true
        await addHandoff($, h)
        await rt($, r => ({
          ...r,
          agentRecord: capKeys({ ...r.agentRecord, [agentId]: recId }, 300),
          // Notes for a workflow agent go to the Workflow call's result.
          pendingSpawn: capKeys({ ...r.pendingSpawn, [recId]: e.tool_use_id }, 300),
        }))
        return spawned
      }
      const recId = runtime.pendingSpawn[e.tool_use_id]
      if (recId && (await readHandoffs($)).some(h => h.id === recId)) {
        await patchHandoff($, recId, h => {
          const upd: TierHandoff = { ...h, agentId, model: spawned.model || h.model, via: e.fork ? 'fork' : h.via }
          if (e.background) upd.background = true
          return upd
        })
        await rt($, r => ({ ...r, agentRecord: capKeys({ ...r.agentRecord, [agentId]: recId }, 300) }))
        return spawned
      }
      // A helper the mod saw no Agent call for (another plugin's spawn, a teammate): recorded too.
      const h = await base(`spawn:${agentId}`, parseTag(e.description), e.fork ? 'fork' : 'other')
      h.try = await bumpTry($, h.tag)
      if (e.background) h.background = true
      await addHandoff($, h)
      await rt($, r => ({ ...r, agentRecord: capKeys({ ...r.agentRecord, [agentId]: h.id }, 300) }))
    } catch (err) {
      await reportError($, 'ledger', err)
    }
    return spawned
  }).catch(async ($, e, next) => {
    await hookFailed($, 'agent.spawn', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- each model request: real effort (helpers), the main context (meter)
  on('turn.step', async function* ($, e, next) {
    await lazyBoot($, 'turn.step')
    try {
      // A keep-warm ping (a fork) is not a real request: the core does not count it.
      if (!isPinging()) await onStep($, e)
    } catch (err) {
      await reportError($, 'meter', err)
    }
    await part2TurnStep($, e)
    const result = yield* next(e)
    if (e.agentId !== undefined && result?.usage) addStepUsage(e.agentId, result.usage)
    // The request's own usage: the keep-warm live check reads the first real request after a ping from it.
    await part2StepResult($, e, result?.usage).catch(err => reportError($, 'cache meter', err))
    return result
  }).catch(async function* ($, e, next) {
    await hookFailed($, 'turn.step', next.error)
    return yield* next(e)
  })

  // ---------------------------------------------------------------- ledger: outcomes
  on('turn.complete', async ($, e, next) => {
    try {
      if (e.agentId !== undefined) await onAgentComplete($, e.agentId, e.answer, e.usage, e.reason)
      else await flushDirty($)
    } catch (err) {
      await reportError($, 'ledger', err)
    }
    await part2TurnComplete($, e.agentId, e.usage)
    return next(e)
  }).catch(async ($, e, next) => {
    await hookFailed($, 'turn.complete', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- compaction: the counterfactual results leave the main context
  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        for (const h of await readHandoffs($)) {
          if (!h.savingsInputs.frozen) await patchHandoff($, h.id, x => ({ ...x, savingsInputs: { ...x.savingsInputs, frozen: true } }))
        }
      } catch (err) {
        await reportError($, 'meter', err)
      }
    }
    return next(e)
  }).catch(async ($, e, next) => {
    await hookFailed($, 'session.compact', next.error)
    return next(e)
  })

  // ---------------------------------------------------------------- part 2: cache meter + screen
  registerPart2(on, settings)
}

// ------------------------------------------------------------------ hook bodies

type HelperCallInput = { tool_use_id: string; agentId: string; command?: unknown }

/** A helper's tool call: count it for the savings meter; a Bash command's exit code is the hand-off's check. */
async function helperCall<R extends { deny?: unknown; text?: string; isError?: boolean; result?: unknown }>(
  $: $,
  e: HelperCallInput,
  tool: string,
  run: () => Promise<R>,
): Promise<R> {
  const ran = await run()
  try {
    if (ran.deny !== undefined) return ran
    const recId = (await readRuntime($)).agentRecord[e.agentId]
    if (!recId) return ran
    const main = await readMain($)
    await patchHandoff(
      $,
      recId,
      h => {
        // The final-report tools are the hand-back, not work the main session would have done.
        const isHandback = tool === 'SubagentHandback' || tool === 'StructuredOutput'
        const upd: TierHandoff = isHandback ? { ...h } : { ...h, savingsInputs: addHelperCall(h.savingsInputs, main.contextTokens, main.model, ran.text) }
        // Only a real check (tests, build, lint, type check) is the hand-off's check: a grep with no match is not.
        if ((tool === 'Bash' || tool === 'PowerShell') && typeof e.command === 'string' && isCheckCommand(e.command)) {
          upd.lastCommand = clip(e.command, 120)
          upd.lastExit = exitCodeOf(ran as { isError?: boolean; text?: string; result?: unknown })
        }
        return upd
      },
      false,
    )
  } catch (err) {
    await reportError($, 'ledger', err)
  }
  return ran
}

async function onStep($: $, e: { agentId?: string; model: string; effort?: string | number }): Promise<void> {
  if (e.agentId !== undefined) {
    const recId = (await readRuntime($)).agentRecord[e.agentId]
    if (!recId) return
    await patchHandoff(
      $,
      recId,
      h => (e.effort !== undefined ? { ...h, effort: String(e.effort), effortSource: 'turn.step', model: e.model || h.model } : { ...h, model: e.model || h.model }),
      false,
    )
    return
  }
  let contextTokens: number | undefined
  try {
    contextTokens = (await $.session.usage()).context.tokens ?? undefined
  } catch {
    contextTokens = undefined
  }
  await update($, MAIN, m => {
    const upd: TierMain = { ...(m ?? { requests: 0 }), model: e.model, requests: (m?.requests ?? 0) + 1 }
    if (contextTokens !== undefined) upd.contextTokens = contextTokens
    return upd
  })
  // Every later main request re-reads what the helpers' results would have added (until compaction).
  for (const h of await readHandoffs($)) {
    if (h.outcome === 'running' || h.savingsInputs.frozen || h.savingsInputs.resultTokens === 0) continue
    await patchHandoff($, h.id, x => ({ ...x, savingsInputs: { ...x.savingsInputs, laterMainRequests: x.savingsInputs.laterMainRequests + 1 } }), false)
  }
}

/** Sets the hand-off's outcome from its answer and its last command; answers the escalation note, if any. */
async function settleOutcome($: $, h: TierHandoff, answer: string): Promise<string | undefined> {
  const escalated = isEscalate(answer)
  const failed = !escalated && h.lastExit !== undefined && h.lastExit !== 0
  const outcome: TierOutcome = escalated ? 'escalated' : failed ? 'check failed' : 'done'
  const kind = escalated ? 'escalated' : 'check failed'
  const signature = outcome === 'done' ? undefined : failureSignature(kind, answer, h.lastCommand, h.lastExit)
  const updated = await patchHandoff($, h.id, x => {
    const upd: TierHandoff = { ...x, outcome }
    if (signature) upd.failure = signature
    return upd
  })
  if (outcome === 'done' || !updated || !signature) return undefined
  const earlier = (await readHandoffs($))
    .filter(o => o.id !== h.id && h.tag !== null && o.tag === h.tag && (o.outcome === 'escalated' || o.outcome === 'check failed'))
    .map(o => (o.failure !== undefined ? { model: o.model, effort: o.effort, failure: o.failure } : { model: o.model, effort: o.effort }))
  const upd = nextRung(updated.model, updated.effort, signature, earlier)
  return escalationNote(updated, kind, upd, escalated ? answer : `${updated.lastCommand ?? ''} exit ${updated.lastExit ?? ''}`)
}

type StepUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }

/** Each helper request's own usage, summed until its turn.complete: the fallback when the end carries none (an API error). */
const stepUsage = new Map<string, StepUsage>()
function addStepUsage(agentId: string, u: Partial<StepUsage>): void {
  const t = stepUsage.get(agentId) ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: '' }
  stepUsage.set(agentId, {
    input_tokens: t.input_tokens + (u.input_tokens ?? 0),
    output_tokens: t.output_tokens + (u.output_tokens ?? 0),
    cache_read_input_tokens: t.cache_read_input_tokens + (u.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: t.cache_creation_input_tokens + (u.cache_creation_input_tokens ?? 0),
    model: u.model || t.model,
  })
}

async function onAgentComplete(
  $: $,
  agentId: string,
  answer: string,
  turnUsage: StepUsage | undefined,
  reason?: string,
): Promise<void> {
  const stepped = stepUsage.get(agentId)
  stepUsage.delete(agentId)
  const usage = turnUsage ?? stepped
  const runtime = await readRuntime($)
  const recId = runtime.agentRecord[agentId]
  if (!recId) return
  const before = (await readHandoffs($)).find(x => x.id === recId)
  // Settled as cut off already: a later end for the same record adds nothing (no double count).
  if (!before || before.outcome === 'cut off') return
  const cutOff = before.outcome === 'running' && (reason === 'error' || reason === 'aborted')
  // A foreground Agent/fork call's digest is its tool result (set at the call). Every other hand-off (background,
  // workflow, resume, other spawns) hands its answer back later: that answer is what the main loop receives.
  const digestFromAnswer = (r: TierHandoff): TierHandoff =>
    r.background || (r.via !== 'agent' && r.via !== 'fork')
      ? { ...r, savingsInputs: { ...r.savingsInputs, digestTokens: tokensOf(answer) } }
      : r
  const h = await patchHandoff($, recId, r0 => {
    const r = digestFromAnswer(r0)
    if (!usage) return cutOff ? { ...r, outcome: 'cut off' } : r
    const t = r.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const upd: TierHandoff = {
      ...r,
      tokens: {
        input: t.input + usage.input_tokens,
        output: t.output + usage.output_tokens,
        cacheRead: t.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + usage.cache_creation_input_tokens,
      },
    }
    const c = costUsd(usage, usage.model || r.model, 'subagent')
    if (c !== undefined) upd.costUsd = Math.round(((r.costUsd ?? 0) + c) * 1e6) / 1e6
    if (usage.model) upd.model = usage.model
    if (cutOff) upd.outcome = 'cut off'
    return upd
  })
  if (!h || h.outcome !== 'running') return
  const note = await settleOutcome($, h, answer)
  if (!note) return
  const sink = h.via === 'workflow' ? runtime.pendingSpawn[recId] : h.via === 'agent' || h.via === 'fork' ? recId : undefined
  await deliverNotes($, sink, [note])
}

/** The scan entry a workflow agent came from: by its label, else the only entry. */
export function matchScanEntry(scan: readonly TierScanEntry[], description: string): TierScanEntry | undefined {
  const byLabel = scan.filter(s => s.label !== null && s.label === description)
  if (byLabel.length >= 1) return byLabel[0]
  const tag = parseTag(description)
  if (tag) {
    const byTag = scan.filter(s => parseTag(s.label) === tag)
    if (byTag.length === 1) return byTag[0]
  }
  return scan.length === 1 ? scan[0] : undefined
}

function scanSafe(text: string): TierScanEntry[] {
  try {
    return scanWorkflowScript(text)
  } catch {
    return [{ index: 1, label: null, model: null, effort: null, agentType: null, status: 'unverifiable', missing: [] }]
  }
}

// ------------------------------------------------------------------ boot steps

async function addNotice($: $, notice: TierNotice): Promise<void> {
  await update($, NOTICES, list => {
    const all = list ?? []
    return all.some(n => n.id === notice.id) ? all : [...all, notice]
  })
}

/** Facts: decided once per session, so the injected text never changes mid-session. */
async function decideFacts($: $, settings: TierSettings, cwd: string | undefined): Promise<void> {
  const decided = await $.state.get(FACTS)
  if (decided.value !== undefined) return
  let found: { version: string; path: string } | null = null
  if (settings.facts !== 'off') {
    let home: string | undefined
    try {
      home = await homeDir($)
    } catch {
      home = undefined
    }
    let root = cwd
    try {
      root = await $.session.root()
    } catch {
      // keep cwd
    }
    const files = [
      home && join(home, '.claude', 'CLAUDE.md'),
      root && join(root, 'CLAUDE.md'),
      root && join(root, '.claude', 'CLAUDE.md'),
      root && join(root, 'CLAUDE.local.md'),
    ].filter((f): f is string => !!f)
    for (const file of files) {
      const text = await readText($, file)
      const version = text === null ? null : findRuleTag(text)
      if (version && (!found || compareVersions(version, found.version) > 0)) found = { version, path: file }
    }
  }
  const facts = factsFor(settings, found)
  await update($, FACTS, prev => prev ?? facts)
  if (found && RULE_VERSION && compareVersions(found.version, RULE_VERSION) < 0) {
    await addNotice($, {
      id: 'outdated-rule',
      at: await $.clock.now(),
      text: `Your CLAUDE.md Tier rule is outdated (v${found.version}, current v${RULE_VERSION}) - run /tier to upgrade it.`,
    })
  }
}

/** The older pin-enforcer / statusline-cache shell hooks double up with the mod. Settings are only read. */
const OLD_HOOKS_SEEN_KEY = 'seen:old-hooks'
async function detectOldHooks($: $): Promise<void> {
  const bySource: { source: string; entries: string[] }[] = []
  for (const source of ['user', 'project', 'local'] as const) {
    try {
      bySource.push({ source, entries: findOldTierHooks(await $.settings.read({ source })) })
    } catch {
      // a source that cannot be read is skipped
    }
  }
  const text = oldHooksNotice(bySource)
  if (!text) return
  if ((await $.store.get(OLD_HOOKS_SEEN_KEY)) === text) return
  await addNotice($, { id: 'old-hooks', at: await $.clock.now(), text })
  await $.store.set(OLD_HOOKS_SEEN_KEY, text)
}

async function warnEffortEnv($: $): Promise<void> {
  const effortEnv = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
  if (!effortEnv) return
  await addNotice($, {
    id: 'effort-env',
    at: await $.clock.now(),
    text: `CLAUDE_CODE_EFFORT_LEVEL is set (${effortEnv}): it silently overrides every effort pin. Unset it for Tier's effort choices to take effect.`,
  })
}

/** Ledger: roll days older than 30 (or past the byte budget) into the summary key; other sessions' today -> totals. */
async function loadLedger($: $, mySession: string): Promise<void> {
  const now = await $.clock.now()
  const today = dayKey(now)
  const byDay: Record<string, { key: string; rec: TierRecord }[]> = {}
  const sizes: Record<string, number> = {}
  for (const key of await $.store.keys()) {
    if (!key.startsWith(RECORD_PREFIX)) continue
    const day = dayOfKey(key)
    if (!day) continue
    const rec = (await $.store.get(key)) as TierRecord | undefined
    if (!rec) continue
    ;(byDay[day] ??= []).push({ key, rec })
    sizes[day] = (sizes[day] ?? 0) + JSON.stringify(rec).length
  }
  const roll = daysToRoll(Object.keys(byDay), today, sizes)
  if (roll.length > 0) {
    const sums = ((await $.store.get(SUMMARY_KEY)) as Record<string, ReturnType<typeof summarizeDay>> | undefined) ?? {}
    for (const day of roll) sums[day] = summarizeDay(day, (byDay[day] ?? []).map(x => x.rec), sums[day])
    await $.store.set(SUMMARY_KEY, sums)
    for (const day of roll) for (const { key } of byDay[day] ?? []) await $.store.delete(key)
  }
  othersDay = today
  othersToday = totalsOf((byDay[today] ?? []).map(x => x.rec).filter(r => r.sessionId !== mySession))
}

export type { GateVerdict }
