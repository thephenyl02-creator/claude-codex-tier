// The hooks through the engine: the test's own hooks stand for the engine
// beneath the plugin (tool results, spawns, files, the store, toasts).
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { FACTS_ADDENDUM, RULE_BLOCK, RULE_VERSION } from './facts-text'
import { TIER_MOD_VERSION } from './version'
import { DESCRIBE_HANDOFF, DESCRIBE_WEB, capHandoffs, emptyRuntime, factsAddendum, normalizeRuntime } from './register'

import type { TierBlock, TierFacts, TierGate, TierHandoff, TierNotice, TierRecord, TierTotals } from '../types'

/** What the plugin last wrote to each of its $.state keys. */
type Seen = {
  handoffs?: TierHandoff[]
  blocks?: TierBlock[]
  totals?: { day: string; session: TierTotals; today: TierTotals }
  health?: { errors: { part: string; message: string }[] }
  gate?: TierGate
  enforce?: boolean
  facts?: TierFacts
  notices?: TierNotice[]
}

type World = { seen: Seen; toasts: string[]; ran: string[]; store: Map<string, unknown>; writes: { path: string; text: string }[]; commands: string[] }

const OPUS = 'claude-opus-5-5'
const ESCALATION = 'ESCALATE: the spec contradicts itself on retries'
const READER = 'Agent(subagent_type "tier-mod:reader", model "sonnet", effort "medium", description "[t=<task>] ...")'
const WEB_LINE = `Tier: hand this to a helper - ${READER}. Limits: web always, 8K tokens reading, 2 files editing per message. The user can say "do it yourself".`

/** The engine beneath: files, a store, a clock, toasts, a main context of 150K on opus, and tools that answer. */
function engine(on: On, opts: { files?: Record<string, string>; env?: Record<string, string>; store?: Record<string, unknown>; clock?: boolean; keysBroken?: boolean; commandFails?: boolean; writeBroken?: boolean } = {}): World {
  const world: World = { seen: {}, toasts: [], ran: [], store: new Map(Object.entries(opts.store ?? {})), writes: [], commands: [] }
  const seen = world.seen as Record<string, unknown>
  on('state.set', (_, e, next) => {
    if (e.plugin === 'tier-mod') seen[e.key] = e.value
    return next(e)
  })
  const store = world.store
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => {
    if (opts.keysBroken) throw new Error('keys gone')
    return { value: [...store.keys()] }
  })
  if (opts.clock !== false) mock.clock(on)
  mock.env(on, { USERPROFILE: '/home', ...(opts.env ?? {}) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's-1' }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_, e) => {
    if (opts.commandFails) throw new Error('no room for a command')
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('fs.write', (_, e) => {
    if (opts.writeBroken) throw new Error('disk full')
    world.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  const files = opts.files ?? {}
  on('fs.read', (_, e) => {
    const hit = Object.entries(files).find(([name]) => e.path.replace(/\\/g, '/').endsWith(name))
    if (!hit) return { deny: `ENOENT ${e.path}` }
    return { value: hit[1] }
  })
  on('session.root', () => ({ value: '/proj' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 150_000, window: 1_000_000 }, rateLimits: [] } }))
  on('agent.spawn', (_, e) => ({ model: e.model === 'opus' ? OPUS : e.model === 'sonnet' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5', agentId: e.resume?.agentId ?? `agent-${e.tool_use_id}` }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    // A test passes a request's usage as `testUsage`; else the request reported none.
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: (e as unknown as { testUsage?: typeof usage }).testUsage ?? null }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine intro', scope: 'shared' as const }] }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('agent.offer', () => ({ isOffered: true }))
  on('tool.describe', (_, e) => ({ description: e.description }))
  on('session.compact', (_, e) => ({ messages: e.messages }) as never)
  return world
}

const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }

const spawnInput = (toolUseId: string, model = 'haiku') => ({
  tool_use_id: toolUseId,
  prompt: 'p',
  description: 'd',
  subagentType: 'tier-mod:reader',
  provider: { plugin: 'engine', tier: 'core' as const },
  model,
  parentModel: OPUS,
  background: false,
  fork: false,
})

/**
 * Tools beneath: an Agent runs one sub-agent turn (optionally Bash commands first, as the helper) and
 * answers `answer`; other tools answer `text` (read-only unless named in `writes`).
 */
function tools(on: On, $: Engine, o: { answer?: string; handback?: string; helperBash?: { command: string; text: string; isError?: boolean }[]; text?: string; readOnly?: boolean } = {}) {
  on('tool.call', async (_, e) => {
    const tool = String(e.tool)
    if (tool === 'Agent') {
      const a = e as unknown as { model?: string }
      const spawned = await $.agent.spawn(spawnInput(e.tool_use_id ?? '', a.model ?? 'haiku'))
      for (const b of o.helperBash ?? []) await $.tool.call({ tool: 'Bash', command: b.command, agentId: spawned.agentId } as never)
      if (o.handback) await $.tool.call({ tool: o.handback, agentId: spawned.agentId } as never)
      const answer = o.answer ?? 'done'
      await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: `t-${e.tool_use_id}`, agentId: spawned.agentId, usage: { ...usage, model: spawned.model }, reason: 'answer' } as never)
      return { result: { agentId: spawned.agentId ?? '' }, text: answer }
    }
    const helper = (e as unknown as { agentId?: string }).agentId !== undefined ? (o.helperBash ?? []).find(b => b.command === (e as unknown as { command?: string }).command) : undefined
    if (helper) return helper.isError ? { isError: true as const, result: {}, text: helper.text } : { result: {}, text: helper.text }
    // the engine ran it
    return o.readOnly === false ? { result: {}, text: o.text ?? 'ok' } : { result: {}, text: o.text ?? 'ok', isReadOnly: true as const }
  })
}

/** Records the tools that really ran beneath (a refusal never reaches here). */
function tracking(on: On, world: World, text = 'ok', readOnly = true) {
  on('tool.call', (_, e) => {
    world.ran.push(String(e.tool))
    return readOnly ? { result: {}, text, isReadOnly: true as const } : { result: {}, text }
  })
}

const start = ($: Engine) => $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
async function mainStep($: Engine, turnId = 'm1'): Promise<void> {
  for await (const _ of $.turn.step({ turnId, index: 0, model: OPUS, messageCount: 3 })) void _
}

// ---------------------------------------------------------------- the hand-off gate

test('hand-off gate: an Agent call with no effort is refused with an exact fix, a toast and a ledger block; no loop cap', async ($, on) => {
  const w = engine(on)
  tracking(on, w)
  await start($)
  await mainStep($)
  const call = { tool: 'Agent' as const, description: 'look around', prompt: 'p', model: 'sonnet' as const }
  for (let i = 0; i < 3; i++) {
    const ran = await $.tool.call(call)
    expect(ran.deny ?? ran.text).toStartWith('Tier: this Agent call names no effort - name both on every call, e.g. Agent(subagent_type "tier-mod:reader"')
  }
  expect(w.ran).toEqual([])
  expect(w.toasts).toEqual(Array(3).fill('Tier refused a hand-off: it named no model/effort'))
  const blocks = w.seen.blocks ?? []
  expect(blocks).toHaveLength(3)
  expect(blocks[0]).toMatchObject({ kind: 'block', gate: 'handoff', tool: 'Agent', action: 'refused', costUsd: 0.03, sessionId: 's-1' })
  expect([...w.store.keys()].filter(k => k.startsWith('rec:')).length).toBe(3)
})

test('enforcement off (setting): the call goes through, recorded as would-refuse, no toast', { options: { enforce: false } }, async ($, on) => {
  const w = engine(on)
  tracking(on, w)
  await start($)
  const ran = await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'p', model: 'sonnet' })
  expect(ran.deny).toBeUndefined()
  expect(w.ran).toEqual(['Agent'])
  expect(w.seen.blocks?.[0]?.action).toBe('would-refuse')
  expect(w.toasts).toEqual([])
})

test('enforcement off (the per-user switch in the store) wins over the setting', async ($, on) => {
  const w = engine(on, { store: { enforce: false } })
  tracking(on, w)
  await start($)
  expect(w.seen.enforce).toBe(false)
  expect((await $.tool.call({ tool: 'WebSearch', query: 'x' } as never)).deny).toBeUndefined()
  expect(w.ran).toEqual(['WebSearch'])
})

test('max: refused with no opus failure; an opus ESCALATE: of the same tag unlocks it; the user asking unlocks it', async ($, on) => {
  const w = engine(on)
  tools(on, $, { answer: ESCALATION })
  await start($)
  const max = { tool: 'Agent' as const, description: '[t=q] prove it', prompt: 'p', model: 'opus' as const, effort: 'max' as const, subagent_type: 'tier-mod:editor' }
  expect((await $.tool.call(max)).deny).toContain('max effort for [t=q] needs an ESCALATE:')
  // a sonnet failure does not unlock it
  await $.tool.call({ ...max, model: 'sonnet', effort: 'high' })
  expect((await $.tool.call(max)).deny).toBeDefined()
  // an opus/low failure of the same tag does not (batch 4: the ladder goes rewrite -> opus/xhigh first)
  await $.tool.call({ ...max, model: 'opus', effort: 'low' })
  expect((await $.tool.call(max)).deny).toContain('opus/xhigh')
  // an opus/xhigh failure of the same tag does
  await $.tool.call({ ...max, model: 'opus', effort: 'xhigh' })
  expect((await $.tool.call(max)).deny).toBeUndefined()
  // another tag stays locked until the user asks
  const other = { ...max, description: '[t=r] other' }
  expect((await $.tool.call(other)).deny).toBeDefined()
  await say($, 'run that at max effort')
  expect((await $.tool.call(other)).deny).toBeUndefined()
  expect(w.seen.handoffs?.filter(h => h.tag === 'q').map(h => h.try)).toEqual([1, 2, 3, 4])
})

test('a runtime left by an older version (reload mid-session) gains the maps it lacks, keeping what it had', () => {
  const old = { spawnedThisTurn: [], awaitingCheck: [], pendingSpawn: { a: 1 } } as unknown as Parameters<typeof normalizeRuntime>[0]
  const r = normalizeRuntime(old, 's1')
  expect(r.sessionId).toBe('s1')
  expect(r.tagTries).toEqual({})
  expect(r.agentRecord).toEqual({})
  expect(r.pendingSpawn).toEqual({ a: 1 })
  expect(normalizeRuntime(undefined, 's2')).toEqual(emptyRuntime('s2'))
  expect(normalizeRuntime({ tagTries: null } as unknown as Parameters<typeof normalizeRuntime>[0], 's3').tagTries).toEqual({})
})

test('ESCALATE: the Agent result carries a [tier] note naming the next rung; tag, try, cost and outcome recorded', async ($, on) => {
  const w = engine(on)
  tools(on, $, { answer: ESCALATION })
  await start($)
  const ran = await $.tool.call({ tool: 'Agent', description: '[t=fix] fix it', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:editor' })
  expect(ran.context?.[0]).toStartWith('[tier] [t=fix] try 1 on haiku/low replied ESCALATE:. Next rung: sonnet/high. Keep the tag [t=fix].')
  const h = w.seen.handoffs?.[0]
  expect(h).toMatchObject({ tag: 'fix', try: 1, outcome: 'escalated', helperType: 'tier-mod:editor', agentId: expect.stringMatching(/^agent-/), costUsd: 0.0006, failure: ESCALATION })
})

test('checks inside the hand-off: the last command and its exit code; a nonzero exit is a failed check with a note', async ($, on) => {
  const w = engine(on)
  tools(on, $, { helperBash: [{ command: 'npm install', text: 'ok' }, { command: 'npm test', text: 'Exit code 1\n2 tests failed', isError: true }] })
  await start($)
  const ran = await $.tool.call({ tool: 'Agent', description: '[t=fix] fix', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:editor' })
  expect(ran.context?.[0]).toStartWith('[tier] [t=fix] try 1 on haiku/low failed its check (npm test - exit 1). Next rung: sonnet/high.')
  expect(w.seen.handoffs?.[0]).toMatchObject({ outcome: 'check failed', lastCommand: 'npm test', lastExit: 1 })
})

test('checks inside the hand-off: a passing last command is done, with no note', async ($, on) => {
  const w = engine(on)
  tools(on, $, { helperBash: [{ command: 'npm test', text: '12 passed' }] })
  await start($)
  const ran = await $.tool.call({ tool: 'Agent', description: '[t=fix] fix', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:editor' })
  expect(ran.context).toBeUndefined()
  expect(w.seen.handoffs?.[0]).toMatchObject({ outcome: 'done', lastCommand: 'npm test', lastExit: 0 })
})

test('the same failure on two rungs: the note jumps to opus/low', async ($, on) => {
  engine(on)
  tools(on, $, { helperBash: [{ command: 'npm test', text: 'Exit code 1\nfail', isError: true }] })
  await start($)
  await $.tool.call({ tool: 'Agent', description: '[t=fix] a', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:editor' })
  const ran = await $.tool.call({ tool: 'Agent', description: '[t=fix] b', prompt: 'p', model: 'sonnet', effort: 'high', subagent_type: 'tier-mod:editor' })
  expect(ran.context?.[0]).toContain('[t=fix] try 2 on sonnet/high failed its check')
  expect(ran.context?.[0]).toContain('Next rung: opus/low (the same failure on two rungs)')
})

test('real effort: the helper\'s turn.step effort replaces the call\'s value', async ($, on) => {
  const w = engine(on)
  on('tool.call', async (_, e) => {
    const spawned = await $.agent.spawn(spawnInput(e.tool_use_id ?? ''))
    for await (const _ of $.turn.step({ turnId: 'h1', index: 0, model: 'claude-haiku-5-5', effort: 'high', messageCount: 1, agentId: spawned.agentId })) void _
    return { result: {}, text: 'done' }
  })
  await start($)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader' })
  expect(w.seen.handoffs?.[0]).toMatchObject({ effort: 'high', effortSource: 'turn.step' })
})

test('a fork passes with no model or effort and is recorded as a fork', async ($, on) => {
  const w = engine(on)
  tracking(on, w)
  await start($)
  expect((await $.tool.call({ tool: 'Agent', description: 'f', prompt: 'p', subagent_type: 'fork' })).deny).toBeUndefined()
  expect(w.seen.handoffs?.[0]).toMatchObject({ via: 'fork', helperType: 'fork' })
})

test('a SendMessage continuation (resumed spawn) is recorded with the original tag and try', async ($, on) => {
  const w = engine(on)
  tools(on, $)
  await start($)
  await $.tool.call({ tool: 'Agent', description: '[t=bg] watch', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader', tool_use_id: 'tu1' } as never)
  await $.agent.spawn({ ...spawnInput('tu9'), prompt: 'more', resume: { agentId: 'agent-tu1' } })
  const resumed = w.seen.handoffs?.find(h => h.via === 'resume')
  expect(resumed).toMatchObject({ id: 'resume:agent-tu1:1', tag: 'bg', try: 1, helperType: 'tier-mod:reader' })
})

test('a G1 plugin agent: pins both pass, a missing effort pin is refused', async ($, on) => {
  const w = engine(on, {
    files: {
      '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'kit@mkt': [{ scope: 'user', installPath: '/plugins/kit/1.0.0' }] } }),
      '/plugins/kit/1.0.0/agents/scout.md': '---\nname: scout\nmodel: haiku\neffort: low\n---\nbody\n',
      '/plugins/kit/1.0.0/agents/half.md': '---\nname: half\nmodel: haiku\n---\nbody\n',
    },
    env: { USERPROFILE: '/home' },
  })
  on('settings.read', () => ({ value: { enabledPlugins: { 'kit@mkt': true } } }))
  tracking(on, w)
  await start($)
  expect((await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'p', subagent_type: 'kit:scout' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'p', subagent_type: 'kit:half' })).deny).toContain('names no effort')
})

// ---------------------------------------------------------------- workflows

const wfOk = `export const meta = { name: 'w', description: 'd', phases: [] }\nawait agent('x', { label: '[t=wf] x', model: 'haiku', effort: 'low', agentType: 'tier-mod:reader' })`

test('workflow: an agent() with no agentType is refused; all three literal passes; a resumed run is scanned again', async ($, on) => {
  const w = engine(on)
  tracking(on, w)
  await start($)
  const bad = wfOk.replace(", agentType: 'tier-mod:reader'", '')
  expect((await $.tool.call({ tool: 'Workflow', script: bad })).deny).toContain('names no agentType')
  expect((await $.tool.call({ tool: 'Workflow', script: wfOk })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Workflow', script: bad, resumeFromRunId: 'wf_1' })).deny).toContain('names no agentType')
  expect(w.toasts).toContain('Tier refused a workflow: an agent() named no model/effort/agentType')
})

test('workflow: a non-literal value passes (unverifiable); scriptPath is read; an unreadable one is refused', async ($, on) => {
  const w = engine(on, { files: { '/proj/wf.js': `await agent('x', { effort: 'low', agentType: 'r' })` } })
  tracking(on, w)
  await start($)
  expect((await $.tool.call({ tool: 'Workflow', script: `await agent('x', { model: m, effort: 'low', agentType: 'r' })` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Workflow', scriptPath: '/proj/wf.js' })).deny).toContain('names no model')
  expect((await $.tool.call({ tool: 'Workflow', scriptPath: '/proj/gone.js' })).deny).toBe("Tier can't check this workflow's agents: pass the script inline or a readable scriptPath.")
  expect(w.seen.health?.errors?.some(x => x.part === 'hand-off gate')).toBe(true)
})

test('#5 workflow by name: resolved from .claude/workflows/ and scanned; an unknown name is refused; a resume with a readable scriptPath is scanned', async ($, on) => {
  const w = engine(on, {
    files: {
      '/proj/.claude/workflows/review.js': `await agent('x', { effort: 'low', agentType: 'r' })`,
      '/proj/.claude/workflows/good.mjs': wfOk,
      '/proj/wf-resume.js': `await agent('x', { effort: 'low', agentType: 'r' })`,
    },
  })
  tracking(on, w)
  await start($)
  expect((await $.tool.call({ tool: 'Workflow', name: 'review' })).deny).toContain('names no model')
  expect((await $.tool.call({ tool: 'Workflow', name: 'good' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Workflow', name: 'built-in-thing' })).deny).toBe("Tier can't check this workflow's agents: pass the script inline or a readable scriptPath.")
  expect((await $.tool.call({ tool: 'Workflow', scriptPath: '/proj/wf-resume.js', resumeFromRunId: 'wf_1' })).deny).toContain('names no model')
  expect(w.ran).toEqual(['Workflow'])
})

test('workflow agents are recorded with their tag, try and the scanned effort', async ($, on) => {
  const w = engine(on)
  on('tool.call', async (_, e) => {
    await $.agent.spawn({ ...spawnInput(e.tool_use_id ?? ''), description: '[t=wf] x', workflow: { runId: 'wf_1', agentIndex: 1 } })
    return { result: {}, text: 'ok' }
  })
  await start($)
  await $.tool.call({ tool: 'Workflow', script: wfOk })
  expect(w.seen.handoffs?.[0]).toMatchObject({ id: 'wf_1#1', via: 'workflow', tag: 'wf', try: 1, effort: 'low', effortSource: 'call' })
})

test('a helper cut off by an API error (usage limit) gets one record: outcome cut off, its requests priced; the retry in a resumed run keeps its own', async ($, on) => {
  const w = engine(on)
  const step = { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5_000, model: OPUS }
  on('tool.call', async (_, e) => {
    const tuid = e.tool_use_id ?? ''
    const first = await $.agent.spawn({ ...spawnInput(tuid, 'opus'), description: '[t=wf] x', workflow: { runId: 'wf_1', agentIndex: 1 } })
    for (let i = 0; i < 3; i++) {
      for await (const _ of $.turn.step({ turnId: 'c1', index: i, model: OPUS, messageCount: 1, agentId: first.agentId, testUsage: step } as never)) void _
    }
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'c1', agentId: first.agentId, reason: 'error' } as never)
    // A late normal end for the same agent adds nothing.
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'c1b', agentId: first.agentId, usage: { ...usage, model: OPUS }, reason: 'answer' } as never)
    // The run resumes: the journal restarts agentIndex, a new agent retries #1.
    const retry = await $.agent.spawn({ ...spawnInput(`${tuid}-r`, 'opus'), description: '[t=wf] x', workflow: { runId: 'wf_1', agentIndex: 1 } })
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'c2', agentId: retry.agentId, usage: { ...usage, model: OPUS }, reason: 'answer' } as never)
    return { result: {}, text: 'ok' }
  })
  await start($)
  await $.tool.call({ tool: 'Workflow', script: wfOk })
  const hs = w.seen.handoffs ?? []
  expect(hs.length).toBe(2)
  const cut = hs.filter(h => h.outcome === 'cut off')
  expect(cut.length).toBe(1)
  expect(cut[0]).toMatchObject({ id: 'wf_1#1', tokens: { input: 30, output: 1500, cacheRead: 300_000, cacheWrite: 15_000 } })
  expect(cut[0]?.costUsd).toBeGreaterThan(0.1)
  expect(cut[0]?.costUsd).toBeLessThan(0.3)
  expect(hs.find(h => h.outcome === 'done')?.id).toMatch(/^wf_1#1:/)
  const stored = [...w.store.values()].filter((v): v is TierHandoff => (v as TierHandoff)?.kind === 'handoff')
  expect(stored.length).toBe(2)
})

// ---------------------------------------------------------------- the work gate

test('work gate: WebSearch, WebFetch, exa, curl and npx ctx7 are refused before running, with the exact line', async ($, on) => {
  const w = engine(on)
  tracking(on, w)
  await start($)
  const calls = [
    { tool: 'WebSearch', query: 'x' },
    { tool: 'WebFetch', url: 'https://x', prompt: 'p' },
    { tool: 'mcp__exa__web_search_exa', query: 'x' },
    { tool: 'Bash', command: '  curl -s https://x' },
    { tool: 'Bash', command: 'npx ctx7@latest docs /a/b q' },
  ]
  for (const c of calls) expect((await $.tool.call(c as never)).deny).toBe(WEB_LINE)
  expect(w.ran).toEqual([])
  expect(w.toasts[0]).toBe('Tier handed off a web search - say "do it yourself" to skip')
  expect(w.seen.blocks?.map(b => b.gate)).toEqual(['web', 'web', 'web', 'web', 'web'])
})

test('work gate: helpers are never gated; "do it yourself" lifts the gate for that message only', async ($, on) => {
  const w = engine(on)
  tracking(on, w)
  await start($)
  expect((await $.tool.call({ tool: 'WebSearch', query: 'x', agentId: 'a1' } as never)).deny).toBeUndefined()
  await say($, 'just do it yourself')
  expect((await $.tool.call({ tool: 'WebSearch', query: 'x' } as never)).deny).toBeUndefined()
  await say($, 'next thing')
  expect((await $.tool.call({ tool: 'WebSearch', query: 'x' } as never)).deny).toBeDefined()
  expect(w.ran).toEqual(['WebSearch', 'WebSearch'])
})

test('work gate: a Read of a 400-line file with no range is refused; with offset/limit it runs', async ($, on) => {
  const w = engine(on, { files: { '/proj/big.ts': 'line\n'.repeat(400) } })
  tracking(on, w)
  await start($)
  const r = await $.tool.call({ tool: 'Read', file_path: '/proj/big.ts' })
  expect(r.deny).toStartWith('Tier: that file has 400 lines (limit 300) - read a range (offset/limit), or hand this to a helper')
  expect(w.toasts).toEqual(['Tier handed off a 400-line read - say "do it yourself" to skip'])
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/big.ts', offset: 1, limit: 50 })).deny).toBeUndefined()
  expect(w.ran).toEqual(['Read'])
})

test('work gate: a read-only result that pushes past 8K tokens is withheld; a new message resets the count', async ($, on) => {
  const w = engine(on)
  tracking(on, w, 'x'.repeat(20_000)) // 5000 tokens each
  await start($)
  await say($, 'look')
  expect((await $.tool.call({ tool: 'Grep', pattern: 'a' } as never)).deny).toBeUndefined()
  const second = await $.tool.call({ tool: 'Grep', pattern: 'b' } as never)
  expect(second.deny ?? second.text).toContain("this message's reading allowance (8K tokens) is used up")
  expect(w.ran).toEqual(['Grep', 'Grep'])
  expect(w.seen.blocks?.[0]).toMatchObject({ gate: 'read', action: 'withheld', tool: 'Grep' })
  expect(w.seen.gate?.readTokens).toBe(5000)
  await say($, 'more')
  expect(w.seen.gate?.readTokens).toBe(0)
  expect((await $.tool.call({ tool: 'Grep', pattern: 'c' } as never)).deny).toBeUndefined()
})

test('work gate: Bash that is not read-only is never withheld and does not count; browser tools neither count nor are refused', async ($, on) => {
  const w = engine(on)
  tracking(on, w, 'x'.repeat(40_000), false)
  await start($)
  expect((await $.tool.call({ tool: 'Bash', command: 'npm run build' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'mcp__Claude_Browser__read_page' } as never)).deny).toBeUndefined()
  expect(w.seen.gate?.readTokens ?? 0).toBe(0)
  expect(w.seen.blocks ?? []).toEqual([])
})

test('work gate: a third distinct file to edit is refused; the same file again passes; a Write over 150 lines is refused', async ($, on) => {
  const w = engine(on)
  tracking(on, w, 'ok', false)
  await start($)
  await say($, 'edit')
  expect((await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/b.ts', content: 'x' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Edit', file_path: '/A.ts', old_string: 'a', new_string: 'c' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Edit', file_path: '/c.ts', old_string: 'a', new_string: 'b' })).deny).toContain('tier-mod:editor')
  await say($, 'next')
  expect((await $.tool.call({ tool: 'Write', file_path: '/d.ts', content: 'x\n'.repeat(200) })).deny).toContain('a Write of 200 lines (over 150)')
  expect(w.ran).toEqual(['Edit', 'Write', 'Edit'])
})

test('work gate: AskUserQuestion, ToolSearch, Task*, mcp__ccd_* and the mod\'s own tools are never gated', async ($, on) => {
  const w = engine(on)
  tracking(on, w, 'x'.repeat(100_000))
  await start($)
  for (const tool of ['AskUserQuestion', 'ToolSearch', 'TaskCreate', 'mcp__ccd_session__mark', 'mcp__tier-mod__x', 'Skill']) {
    expect((await $.tool.call({ tool } as never)).deny).toBeUndefined()
  }
  expect(w.seen.gate?.readTokens ?? 0).toBe(0)
})

test('fail open: a gate that breaks lets the call through, names the part in a toast and the health atom', async ($, on) => {
  let broken = false
  on('clock.now', () => {
    if (broken) throw new Error('clock gone')
    return { value: 0 }
  })
  const w = engine(on, { clock: false })
  tracking(on, w)
  await start($)
  broken = true
  const ran = await $.tool.call({ tool: 'Agent', description: '[t=q] x', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader' })
  broken = false
  expect(ran.deny).toBeUndefined()
  expect(w.ran).toEqual(['Agent'])
  expect(w.toasts).toContain('Tier: the hand-off gate broke and lets calls through - details in ~/.claude/tier-mod-status.json')
  expect(w.seen.health?.errors?.some(x => x.part === 'hand-off gate')).toBe(true)
})

test('#4/#23 a ledger failure after a decided refusal still refuses (work, Agent and Workflow gates) and is reported', async ($, on) => {
  let broken = false
  on('clock.now', () => {
    if (broken) throw new Error('clock gone')
    return { value: 0 }
  })
  const w = engine(on, { clock: false })
  tracking(on, w)
  await start($)
  broken = true
  expect((await $.tool.call({ tool: 'WebSearch', query: 'x' } as never)).deny).toBe(WEB_LINE)
  expect((await $.tool.call({ tool: 'Agent', description: '[t=q] x', prompt: 'p', model: 'opus', effort: 'max', subagent_type: 'tier-mod:reader' })).deny).toContain('max')
  expect((await $.tool.call({ tool: 'Workflow', script: wfOk.replace(", agentType: 'tier-mod:reader'", '') })).deny).toContain('names no agentType')
  broken = false
  expect(w.ran).toEqual([])
  expect(w.seen.health?.errors?.some(x => x.part === 'block ledger')).toBe(true)
})

// ---------------------------------------------------------------- describe, offer

test('tool.describe: one constant line on Agent, Workflow, WebSearch, WebFetch; others unchanged', async ($, on) => {
  engine(on)
  await start($)
  const provider = { plugin: 'engine', tier: 'core' as const }
  expect((await $.tool.describe({ tool: 'Agent', description: 'Launch an agent.', provider })).description).toBe(`Launch an agent.\n\n${DESCRIBE_HANDOFF}`)
  expect((await $.tool.describe({ tool: 'Workflow', description: 'W.', provider })).description).toBe(`W.\n\n${DESCRIBE_HANDOFF}`)
  expect((await $.tool.describe({ tool: 'WebFetch', description: 'F.', provider })).description).toBe(`F.\n\n${DESCRIBE_WEB}`)
  expect((await $.tool.describe({ tool: 'Read', description: 'R.', provider })).description).toBe('R.')
})

test('agent.offer: general-purpose is not offered; the light helpers and Explore are', async ($, on) => {
  engine(on)
  await start($)
  const provider = { plugin: 'engine', tier: 'core' as const }
  expect((await $.agent.offer({ agent: 'general-purpose', description: 'd', source: 'built-in', provider })).isOffered).toBe(false)
  expect((await $.agent.offer({ agent: 'Explore', description: 'd', source: 'built-in', provider })).isOffered).toBe(true)
  expect((await $.agent.offer({ agent: 'tier-mod:reader', description: 'd', source: 'plugin', provider: { plugin: 'tier-mod', tier: 'user' as never } })).isOffered).toBe(true)
})

// ---------------------------------------------------------------- savings meter + totals

test('savings: a hand-off at a 150K opus context, worked through the engine; later main requests grow it; compaction freezes it', async ($, on) => {
  const w = engine(on)
  tools(on, $, { helperBash: [{ command: 'ls', text: 'x'.repeat(4000) }, { command: 'cat a', text: 'y'.repeat(4000) }] })
  await start($)
  await mainStep($, 'm1')
  // brief: prompt 400 chars (100 tokens) + description "[t=x] read" (3 tokens); digest "done" (1 token)
  await $.tool.call({ tool: 'Agent', description: '[t=x] read', prompt: 'p'.repeat(400), model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader' })
  // The main session is on the 5m cache here (no subscription windows): a write is 1.25x input, $5/MTok on opus.
  // normal = 2 x 150K x 0.2e-6 (0.06) + 2000 x 5e-6 (0.01) + 1000 out x 20e-6 (0.02) = 0.09
  // actual = 0.0006 haiku + 103 x 20e-6 (0.00206) + 1 x 5e-6 + the hand-off's own main round trip (150K x 0.2e-6 = 0.03) = 0.032665
  expect(w.seen.handoffs?.[0]?.saved).toEqual({ normalUsd: 0.09, actualUsd: 0.032665, savedUsd: 0.057335, tokensKeptOut: 1999 })
  await mainStep($, 'm2')
  expect(w.seen.handoffs?.[0]?.saved?.savedUsd).toBe(0.057735) // + 2000 x 0.2e-6 (digest re-read adds 1 x 0.2e-6 to actual: rounds away)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  await mainStep($, 'm3')
  expect(w.seen.handoffs?.[0]?.saved?.savedUsd).toBe(0.057735)
  expect(w.seen.totals?.session).toMatchObject({ handoffs: 1, running: 0, spentUsd: 0.0006, savedUsd: 0.057735, tokensKeptOut: 1999 })
  // a refusal's cost comes off the saved total
  await $.tool.call({ tool: 'WebSearch', query: 'x' } as never)
  expect(w.seen.totals?.session).toMatchObject({ blocks: 1, blocksUsd: 0.03, savedUsd: 0.027735 })
})

test('savings: the helper SubagentHandback call is the hand-back, not work: it does not count as a helper call', async ($, on) => {
  const w = engine(on)
  tools(on, $, { handback: 'SubagentHandback' })
  await start($)
  await mainStep($, 'm1')
  await $.tool.call({ tool: 'Agent', description: '[t=x] read', prompt: 'p'.repeat(400), model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader' })
  // no round trip and no result tokens: normal is only the helper's 1000 output tokens x 20e-6
  expect(w.seen.handoffs?.[0]?.saved?.normalUsd).toBe(0.02)
  expect((w.seen.handoffs?.[0] as unknown as { savingsInputs?: { helperCalls: number } }).savingsInputs?.helperCalls ?? 0).toBe(0)
})

test('ledger: one store key per record; other sessions\' records today count in today\'s totals; days older than 30 roll into the summary key', async ($, on) => {
  const T0 = new Date(2026, 9, 24, 9, 0, 0).getTime()
  const other: TierRecord = { kind: 'handoff', id: 'x', at: T0, day: '2026-10-24', sessionId: 's-0', tag: null, try: 0, via: 'agent', helperType: 'r', title: '', model: 'claude-haiku-5-5', effort: 'low', effortSource: 'call', outcome: 'done', costUsd: 0.5, savingsInputs: { helperCalls: 0, roundTripUsd: 0, resultTokens: 0, briefTokens: 0, digestTokens: 0, laterMainRequests: 0 } }
  const old = { ...other, id: 'o', day: '2026-09-01', sessionId: 's-0', costUsd: 0.25 }
  const w = engine(on, { clock: false, store: { 'rec:2026-10-24:s-0:x': other, 'rec:2026-09-01:s-0:o': old } })
  mock.clock(on, { now: T0 })
  tools(on, $)
  await start($)
  expect(w.store.has('rec:2026-09-01:s-0:o')).toBe(false)
  expect((w.store.get('ledger:summary') as Record<string, { handoffs: number; spentUsd: number }>)['2026-09-01']).toMatchObject({ handoffs: 1, spentUsd: 0.25 })
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader', tool_use_id: 'tu5' } as never)
  expect(w.store.get('rec:2026-10-24:s-1:tu5')).toMatchObject({ kind: 'handoff', outcome: 'done', sessionId: 's-1' })
  expect(w.seen.totals?.today).toMatchObject({ handoffs: 2, spentUsd: 0.5006 })
  expect(w.seen.totals?.session).toMatchObject({ handoffs: 1, spentUsd: 0.0006 })
})

// ---------------------------------------------------------------- facts, notices

const compose = { model: OPUS, promptModel: OPUS, surfaces: [], tools: [], outputStyle: null, traits: [] }

test('facts: addendum + rule block when no CLAUDE.md carries a tag; one section, session scope', async ($, on) => {
  engine(on)
  await start($)
  const composed = await $.prompt.compose(compose)
  const mine = composed.sections.filter(s => s.id === 'tier:facts')
  expect(mine).toHaveLength(1)
  expect(mine[0]?.scope).toBe('session')
  expect(mine[0]?.text).toBe(`${FACTS_ADDENDUM}\n\n${RULE_BLOCK}`)
})

test('facts: an older tier-rule tag injects the current rule too and raises the outdated notice', async ($, on) => {
  const w = engine(on, { files: { '/proj/CLAUDE.md': '# rules\n<!-- tier-rule v1.10.0 -->\n' } })
  await start($)
  expect(w.seen.facts).toMatchObject({ mode: 'addendum+rule', foundVersion: '1.10.0', text: `${FACTS_ADDENDUM}\n\n${RULE_BLOCK}` })
  expect((w.seen.notices ?? []).map(n => n.id)).toEqual(['outdated-rule'])
})

test('facts: the embedded rule block carries the tag RULE_VERSION names (1.12.0, past the shipped 1.11.1)', () => {
  expect(RULE_VERSION).toBe('1.12.0')
  expect(RULE_BLOCK).toContain(`<!-- tier-rule v${RULE_VERSION} -->`)
})

test('facts: the shipped 1.11.1 block counts as outdated and gets the new rule', async ($, on) => {
  const w = engine(on, { files: { '/proj/CLAUDE.md': '# rules\n<!-- tier-rule v1.11.1 -->\n' } })
  await start($)
  expect(w.seen.facts).toMatchObject({ mode: 'addendum+rule', foundVersion: '1.11.1', text: `${FACTS_ADDENDUM}\n\n${RULE_BLOCK}` })
  expect((w.seen.notices ?? []).map(n => n.id)).toEqual(['outdated-rule'])
})

test('facts: a same-version tier-rule tag injects the addendum alone', async ($, on) => {
  const w = engine(on, { files: { '/proj/CLAUDE.md': `# rules\n<!-- tier-rule v${RULE_VERSION} -->\n` } })
  await start($)
  expect(w.seen.facts).toMatchObject({ mode: 'addendum', foundVersion: RULE_VERSION, text: FACTS_ADDENDUM })
})

test('facts: the addendum carries the CURRENT limits, not the defaults; the default settings leave the text as written', () => {
  expect(factsAddendum({ readTokens: 8000, readLines: 300, editFiles: 2 })).toBe(FACTS_ADDENDUM)
  const t = factsAddendum({ readTokens: 12000, readLines: 500, editFiles: 1 })
  expect(t).toContain('read up to 12K tokens of tool output and edit up to 1 file;')
  expect(t).toContain('a Read of a 500+ line file needs an offset/limit')
  expect(t).not.toContain('8K')
  expect(FACTS_ADDENDUM).not.toContain('no delegation')
})

test('facts: built from the settings once per session', { options: { readTokens: 16000, readLines: 400, editFiles: 3 } }, async ($, on) => {
  engine(on)
  await start($)
  const first = (await $.prompt.compose(compose)).sections.find(s => s.id === 'tier:facts')?.text
  expect(first).toContain('read up to 16K tokens of tool output and edit up to 3 files;')
  expect(first).toContain('a Read of a 400+ line file')
  expect((await $.prompt.compose(compose)).sections.find(s => s.id === 'tier:facts')?.text).toBe(first)
})

test('facts off: nothing is injected', { options: { facts: 'off' } }, async ($, on) => {
  engine(on)
  await start($)
  expect((await $.prompt.compose(compose)).sections.map(s => s.id)).toEqual(['intro'])
})

test('CLAUDE_CODE_EFFORT_LEVEL set: a one-time warning', async ($, on) => {
  const w = engine(on, { env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } })
  await start($)
  expect((w.seen.notices ?? []).find(n => n.id === 'effort-env')?.text).toContain('CLAUDE_CODE_EFFORT_LEVEL is set (high)')
})

test('old hooks: pin-enforcer is flagged; a statusLine (wrapping deadman\'s line) is not', async ($, on) => {
  const w = engine(on)
  const user = {
    statusLine: { type: 'command', command: 'node C:/Users/x/.claude/hooks/statusline-cache.mjs' },
    hooks: { PreToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command: 'node pin-enforcer.mjs' }] }] },
  }
  on('settings.read', (_, e) => ({ value: e.source === 'user' ? user : {} }))
  await start($)
  const notice = (w.seen.notices ?? []).find(n => n.id === 'old-hooks')
  expect(notice?.text).toContain('hooks.PreToolUse (pin-enforcer)')
  expect(notice?.text).not.toContain('statusLine')
})

test('old hooks: a statusLine alone raises no notice', async ($, on) => {
  const w = engine(on)
  on('settings.read', () => ({ value: { statusLine: { type: 'command', command: 'statusline-cache.mjs' } } }))
  await start($)
  expect((w.seen.notices ?? []).map(n => n.id)).toEqual([])
})

// ---------------------------------------------------------------- lazy boot

test('lazy boot: prompt.submit boots when session.start never fired; /tier-pane only, no facts section', async ($, on) => {
  const w = engine(on)
  await say($, 'hello')
  expect(w.commands).toEqual(['tier-pane'])
  const last = JSON.parse(w.writes[w.writes.length - 1]?.text ?? '{}')
  expect(w.writes[0]?.path.endsWith('tier-mod-status.json')).toBe(true)
  expect(last).toMatchObject({ version: '0.20.0', bootedVia: 'prompt.submit', sessionStartSeen: false, registrations: { 'command:tier-pane': 'ok' }, facts: 'skipped: mid-session load' })
  expect((await $.prompt.compose(compose)).sections.map(s => s.id)).toEqual(['intro'])
})

test('lazy boot via tool.call does not hold the call; a late session.start does not boot again', async ($, on) => {
  const w = engine(on)
  tracking(on, w)
  const ran = await $.tool.call({ tool: 'Grep', pattern: 'x' } as never)
  expect(ran.deny).toBeUndefined()
  await settle()
  await start($)
  await settle()
  expect(JSON.parse(w.writes[w.writes.length - 1]?.text ?? '{}')).toMatchObject({ bootedVia: 'tool.call', sessionStartSeen: true })
})

declare const setTimeout: (fn: () => void, ms: number) => unknown
const settle = () => new Promise<void>(r => void setTimeout(r, 30))

test('#10 checks inside the hand-off: a grep with no match after a passing test is done; a failed check before it still counts', async ($, on) => {
  const w = engine(on)
  tools(on, $, { helperBash: [{ command: 'npm test', text: '12 passed' }, { command: 'grep -r nothing src', text: 'Exit code 1', isError: true }] })
  await start($)
  const ran = await $.tool.call({ tool: 'Agent', description: '[t=fix] fix', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:editor' })
  expect(ran.context).toBeUndefined()
  expect(w.seen.handoffs?.[0]).toMatchObject({ outcome: 'done', lastCommand: 'npm test', lastExit: 0 })
})

test('#1 PowerShell: web refused on the main loop; a helper\'s PowerShell check exit code is recorded', async ($, on) => {
  const w = engine(on)
  tracking(on, w)
  await start($)
  expect((await $.tool.call({ tool: 'PowerShell', command: 'irm https://x' } as never)).deny).toBe(WEB_LINE)
  expect((await $.tool.call({ tool: 'Monitor', description: 'd', timeout_ms: 1000, ws: { url: 'wss://x' } } as never)).deny).toBe(WEB_LINE)
  expect(w.ran).toEqual([])
})

test('#1 a helper PowerShell check that fails is the hand-off\'s failed check', async ($, on) => {
  const w = engine(on)
  on('tool.call', async (_, e) => {
    if (String(e.tool) === 'PowerShell') return { isError: true as const, result: {}, text: 'Exit code 1\nfailed' }
    if (String(e.tool) !== 'Agent') return { result: {}, text: 'ok' }
    const spawned = await $.agent.spawn(spawnInput(e.tool_use_id ?? '', 'haiku'))
    await $.tool.call({ tool: 'PowerShell', command: 'dotnet test', agentId: spawned.agentId } as never)
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: `t-${e.tool_use_id}`, agentId: spawned.agentId, usage: { ...usage, model: spawned.model }, reason: 'answer' } as never)
    return { result: { agentId: spawned.agentId ?? '' }, text: 'done' }
  })
  await start($)
  await $.tool.call({ tool: 'Agent', description: '[t=ps] x', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:editor' })
  expect(w.seen.handoffs?.[0]).toMatchObject({ outcome: 'check failed', lastCommand: 'dotnet test', lastExit: 1 })
})

test('#2 shell writes count toward the files-edited limit; temp targets do not', async ($, on) => {
  const w = engine(on)
  tracking(on, w, 'ok', false)
  await start($)
  await say($, 'edit')
  expect((await $.tool.call({ tool: 'Bash', command: "sed -i 's/a/b/' /a.ts" })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'PowerShell', command: "Set-Content -Path /b.ts -Value 'x'" } as never)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'echo x > /tmp/scratch.txt' })).deny).toBeUndefined()
  expect(w.seen.gate?.editFiles).toEqual(['/a.ts', '/b.ts'])
  expect((await $.tool.call({ tool: 'Edit', file_path: '/c.ts', old_string: 'a', new_string: 'b' })).deny).toContain('tier-mod:editor')
  expect((await $.tool.call({ tool: 'Bash', command: 'echo x > /d.ts' })).deny).toContain('tier-mod:editor')
  expect(w.ran).toEqual(['Bash', 'PowerShell', 'Bash'])
})

test('L1 parallel edits decide and count atomically: two new files at once cannot both slip past the limit', async ($, on) => {
  const w = engine(on)
  tracking(on, w, 'ok', false)
  await start($)
  await say($, 'edit')
  expect((await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })).deny).toBeUndefined()
  const [x, y] = await Promise.all([
    $.tool.call({ tool: 'Edit', file_path: '/b.ts', old_string: 'a', new_string: 'b' }),
    $.tool.call({ tool: 'Edit', file_path: '/c.ts', old_string: 'a', new_string: 'b' }),
  ])
  expect([x.deny === undefined, y.deny === undefined].filter(Boolean).length).toBe(1)
  expect(w.seen.gate?.editFiles?.length).toBe(2)
})

// ---------------------------------------------------------------- the money batch (v0.20 audit, batch 1)

test('#12 an Agent call denied before the helper started leaves no record: no ghost "running", nothing stored', async ($, on) => {
  const w = engine(on)
  on('tool.call', () => ({ deny: 'Agent denied by another hook' }))
  await start($)
  const ran = await $.tool.call({ tool: 'Agent', description: '[t=x] read', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader', tool_use_id: 'tu-deny' } as never)
  expect(ran.deny).toBe('Agent denied by another hook')
  expect(w.seen.handoffs ?? []).toEqual([])
  expect([...w.store.keys()].filter(k => k.startsWith('rec:'))).toEqual([])
  expect(w.seen.totals?.session).toMatchObject({ handoffs: 0, running: 0, spentUsd: 0, savedUsd: 0 })
})

test('#12 an Agent call that errored before any helper started drops its record too; one whose helper started keeps it', async ($, on) => {
  const w = engine(on)
  on('tool.call', async (_, e) => {
    if (e.tool_use_id === 'tu-started') {
      await $.agent.spawn(spawnInput('tu-started'))
      return { isError: true as const, result: {}, text: 'the helper crashed' }
    }
    return { isError: true as const, result: {}, text: 'invalid input' }
  })
  await start($)
  const call = (id: string) => ({ tool: 'Agent', description: '[t=x] read', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader', tool_use_id: id }) as never
  const bad = await $.tool.call(call('tu-bad'))
  expect(bad.isError).toBe(true)
  expect((w.seen.handoffs ?? []).map(h => h.id)).toEqual([])
  expect([...w.store.keys()].filter(k => k.endsWith('tu-bad'))).toEqual([])
  await $.tool.call(call('tu-started'))
  expect((w.seen.handoffs ?? []).map(h => h.id)).toEqual(['tu-started'])
})

test('#16 the hand-off cap evicts the oldest settled records first and never a running one', () => {
  const h = (id: string, outcome: TierHandoff['outcome']): TierHandoff => ({ id, outcome }) as TierHandoff
  const list = [h('a', 'running'), h('b', 'done'), h('c', 'done'), h('d', 'running'), h('e', 'done')]
  expect(capHandoffs(list, 5).map(x => x.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(capHandoffs(list, 3).map(x => x.id)).toEqual(['a', 'd', 'e'])
  expect(capHandoffs(list, 1).map(x => x.id)).toEqual(['a', 'd'])
  expect(capHandoffs([h('x', 'running'), h('y', 'running')], 1).map(x => x.id)).toEqual(['x', 'y'])
})

test('#13 a workflow agent and an unseen spawn count the answer the main loop gets back as their digest, plus the hand-off round trip', async ($, on) => {
  const w = engine(on)
  on('tool.call', async (_, e) => {
    if (e.tool !== 'Workflow') return { result: {}, text: 'ok' }
    const wf = await $.agent.spawn({ ...spawnInput(e.tool_use_id ?? ''), description: '[t=wf] x', workflow: { runId: 'wf_1', agentIndex: 1 } })
    await $.turn.complete({ answer: 'w'.repeat(800), durationMs: 5, isAborted: false, turnId: 'w1', agentId: wf.agentId, usage: { ...usage, model: 'claude-haiku-5-5' }, reason: 'answer' } as never)
    const other = await $.agent.spawn({ ...spawnInput('tu-other'), description: 'other' })
    await $.turn.complete({ answer: 'o'.repeat(400), durationMs: 5, isAborted: false, turnId: 'o1', agentId: other.agentId, usage: { ...usage, model: 'claude-haiku-5-5' }, reason: 'answer' } as never)
    return { result: {}, text: 'ok' }
  })
  await start($)
  await mainStep($, 'm1')
  await $.tool.call({ tool: 'Workflow', script: wfOk })
  const wf = w.seen.handoffs?.find(h => h.via === 'workflow')
  expect(wf?.savingsInputs.digestTokens).toBe(200)
  expect(Math.abs((wf?.savingsInputs.handoffRoundTripUsd ?? 0) - (0.03)) < 1e-6).toBe(true)
  const other = w.seen.handoffs?.find(h => h.id === 'spawn:agent-tu-other')
  expect(other?.savingsInputs.digestTokens).toBe(100)
  expect(Math.abs((other?.savingsInputs.handoffRoundTripUsd ?? 0) - (0.03)) < 1e-6).toBe(true)
})

test('#13 a background Agent call: the digest is the answer that comes back later, not the launch acknowledgement', async ($, on) => {
  const w = engine(on)
  on('tool.call', async (_, e) => {
    await $.agent.spawn({ ...spawnInput(e.tool_use_id ?? ''), background: true })
    return { result: {}, text: 'Async agent launched' }
  })
  await start($)
  await $.tool.call({ tool: 'Agent', description: '[t=bg] watch', prompt: 'p', model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader', tool_use_id: 'tu-bg' } as never)
  // the launch acknowledgement is not the digest
  expect(w.seen.handoffs?.find(x => x.id === 'tu-bg')?.savingsInputs.digestTokens).toBe(0)
  // the helper finishes later and its answer reaches the main loop
  await $.turn.complete({ answer: 'b'.repeat(2000), durationMs: 5, isAborted: false, turnId: 'b1', agentId: 'agent-tu-bg', usage: { ...usage, model: 'claude-haiku-5-5' }, reason: 'answer' } as never)
  const h = w.seen.handoffs?.find(x => x.id === 'tu-bg')
  expect(h?.background).toBe(true)
  expect(h?.savingsInputs.digestTokens).toBe(500)
})

test('#14/#21 an escalated hand-off adds nothing to the saved total; its spend still counts', async ($, on) => {
  const w = engine(on)
  tools(on, $, { helperBash: [{ command: 'ls', text: 'x'.repeat(40_000) }], answer: ESCALATION })
  await start($)
  await mainStep($, 'm1')
  await $.tool.call({ tool: 'Agent', description: '[t=x] read', prompt: 'p'.repeat(400), model: 'haiku', effort: 'low', subagent_type: 'tier-mod:reader', tool_use_id: 'tu-e' } as never)
  const h = w.seen.handoffs?.find(x => x.id === 'tu-e')
  expect(h?.outcome).toBe('escalated')
  expect(h?.saved?.savedUsd).toBeGreaterThan(0)
  expect(w.seen.totals?.session).toMatchObject({ handoffs: 1, escalations: 1, spentUsd: 0.0006, savedUsd: 0, tokensKeptOut: 0 })
})

// ---------------------------------------------------------------- audit 0.19.0 batch 2: one error path, the status file

const statusWrites = (w: World) => w.writes.filter(x => x.path.endsWith('tier-mod-status.json'))
const lastStatus = (w: World) => JSON.parse(statusWrites(w).pop()?.text ?? '{}')

test('#20 a boot step that throws (the ledger load) shows: red chip, one toast, a status-file entry', async ($, on) => {
  const w = engine(on, { keysBroken: true })
  await start($)
  expect(w.toasts.filter(t => t.includes('the ledger broke'))).toHaveLength(1)
  expect(w.seen.health?.errors?.some(x => x.part === 'ledger' && x.message.length > 0)).toBe(true)
  expect(lastStatus(w).errors.some((x: string) => x.startsWith('ledger: '))).toBe(true)
})

test('#20 a command that fails to register shows too (it was a status-file line only)', async ($, on) => {
  const w = engine(on, { commandFails: true })
  await start($)
  expect(w.toasts.some(t => t.includes('the command:tier-pane broke'))).toBe(true)
  expect(w.seen.health?.errors?.some(x => x.part === 'command:tier-pane')).toBe(true)
  expect(lastStatus(w).registrations['command:tier-pane']).not.toBe('ok')
})

test('#22 the status file sits under the home directory the API gives; with no home nothing is written', async ($, on) => {
  const w = engine(on, { env: { USERPROFILE: 'C:/Users/Zed/' } })
  await start($)
  expect(statusWrites(w).length).toBeGreaterThan(0)
  expect(new Set(statusWrites(w).map(x => x.path.split(String.fromCharCode(92)).join('/')))).toEqual(new Set(['C:/Users/Zed/.claude/tier-mod-status.json']))
})

test('#22 an unknown home directory skips the write (no hard-coded path)', async ($, on) => {
  const w = engine(on, { env: { USERPROFILE: '' } })
  await start($)
  expect(w.writes).toEqual([])
})

test('#22 the status file carries the version of plugin.json when it can be read, else the one constant', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(lastStatus(w).version).toBe(TIER_MOD_VERSION)
})

test('#22 a readable plugin.json gives the status file its version', async ($, on) => {
  const w = engine(on, { files: { 'plugin.json': JSON.stringify({ name: 'tier-mod', version: '9.8.7' }) } })
  await start($)
  expect(lastStatus(w).version).toBe('9.8.7')
})

test('#22 each session has its own section; other sessions are kept; the top level is the most recent boot', async ($, on) => {
  const other = { version: '0.19.0', sessionId: 's-0', bootedVia: 'session.start', at: '1960-01-01T00:00:00.000Z', updatedAt: '1960-01-01T00:00:01.000Z', sessionStartSeen: true, registrations: {}, facts: 'addendum', errors: ['old: boom'] }
  const w = engine(on, { files: { 'tier-mod-status.json': JSON.stringify({ ...other, sessions: { 's-0': other } }) } })
  await start($)
  const file = lastStatus(w)
  expect(Object.keys(file.sessions).sort()).toEqual(['s-0', 's-1'])
  expect(file.sessions['s-0'].errors).toEqual(['old: boom'])
  expect(file.sessionId).toBe('s-1')
  expect(file.sessions['s-1']).toMatchObject({ sessionId: 's-1', bootedVia: 'session.start' })
})

test('#22 a session that booted after this one keeps the top level; this one still has its own section', async ($, on) => {
  const newer = { version: '0.19.0', sessionId: 's-9', bootedVia: 'session.start', at: '2999-01-01T00:00:00.000Z', updatedAt: '2999-01-01T00:00:01.000Z', sessionStartSeen: true, registrations: {}, facts: null, errors: [] }
  const w = engine(on, { files: { 'tier-mod-status.json': JSON.stringify({ ...newer, sessions: { 's-9': newer } }) } })
  await start($)
  expect(lastStatus(w)).toMatchObject({ sessionId: 's-9' })
  expect(Object.keys(lastStatus(w).sessions).sort()).toEqual(['s-1', 's-9'])
})

test('#22 a status-file write that fails is not swallowed: chip and toast', async ($, on) => {
  const w = engine(on, { writeBroken: true })
  await start($)
  expect(w.toasts.some(t => t.startsWith('Tier: could not write ~/.claude/tier-mod-status.json: '))).toBe(true)
  expect(w.toasts.some(t => t.includes('the status file broke') || t.includes('details in'))).toBe(false)
  expect(w.seen.health?.errors?.some(x => x.part === 'status file')).toBe(true)
})

test('#19 a hook that throws is reported by its .catch handler (chip, toast), and the call still goes on', async ($, on) => {
  const w = engine(on)
  // beneath the plugin: once armed, the facts the hook reads are malformed, so the hook returns what the site refuses
  let armed = false
  on('state.get', (_, e, next) => (armed && e.plugin === 'tier-mod' && e.key === 'facts' ? { value: { value: { mode: 'addendum', text: 5 }, version: 0 } as never } : next(e)))
  await start($)
  armed = true
  const composed = await $.prompt.compose(compose)
  expect(composed.sections.map(s => s.id)).toEqual(['intro'])
  expect(w.toasts.some(t => t.includes('the prompt.compose hook broke'))).toBe(true)
  expect(w.seen.health?.errors?.some(x => x.part === 'prompt.compose hook')).toBe(true)
  // the same failure again is not stacked (one entry per distinct message)
  await $.prompt.compose(compose)
  expect(w.seen.health?.errors?.filter(x => x.part === 'prompt.compose hook')).toHaveLength(1)
})
