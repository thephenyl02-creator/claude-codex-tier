import { describe, expect, test } from 'claude-code/testing'

import type { TierGate, TierHandoff, TierRecord } from '../types'
import { FACTS_ADDENDUM, RULE_BLOCK } from './facts-text'
import { TIER_MOD_VERSION } from './version'
import {
  addHelperCall,
  classifyTool,
  costUsd,
  countsSaving,
  countLines,
  dayOfKey,
  daysToRoll,
  emptySavingsInputs,
  escalationNote,
  exampleCall,
  exitCodeOf,
  failureSignature,
  findOldTierHooks,
  findRuleTag,
  freshGate,
  gateAgent,
  gateWorkflow,
  isClaudeOwnFile,
  isEscalate,
  isWebCommand,
  mainPrices,
  isCheckCommand,
  asksOverride,
  shellWrites,
  editTargets,
  limitsText,
  nextRung,
  parseTag,
  readAgentPins,
  readSettings,
  recordKey,
  refusalCostUsd,
  savingsOf,
  scanWorkflowScript,
  summarizeDay,
  totalsOf,
  unlockDecide,
  userAsksMaxOrFable,
  workAfter,
  workBefore,
} from './core'

const S = { readTokens: 8000, readLines: 300, editFiles: 2 }
const gate = (over: Partial<TierGate> = {}): TierGate => ({ ...freshGate(), ...over })
const noOne = { handoffs: [], userAskedMaxOrFable: false }

describe('settings and tags', () => {
  test('defaults: enforce on, 8000 tokens, 300 lines, 2 files, facts auto', () => {
    expect(readSettings({})).toEqual({ enforce: true, readTokens: 8000, readLines: 300, editFiles: 2, facts: 'auto' })
    expect(readSettings({ enforce: false, readTokens: 4000, readLines: 100, editFiles: 1, facts: 'off' })).toEqual({
      enforce: false,
      readTokens: 4000,
      readLines: 100,
      editFiles: 1,
      facts: 'off',
    })
    expect(readSettings({ readTokens: -1 }).readTokens).toBe(8000)
  })
  test('task tag: [t=x], the legacy [tier t=x ...], none', () => {
    expect(parseTag('[t=fix-auth] fix the login')).toBe('fix-auth')
    expect(parseTag('fix it [t=b2]')).toBe('b2')
    expect(parseTag('[tier t=old r=2 route=judgment check=-] x')).toBe('old')
    expect(parseTag('no tag here')).toBeNull()
    expect(parseTag(undefined)).toBeNull()
  })
})

describe('cost and savings (worked numbers)', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }
  test('helper cost: opus sub-agent in 4 + out 20 + read 0.2 + 5m write 5; main writes at 1h', () => {
    expect(costUsd(u, 'claude-opus-5-5')).toBe(29.2)
    expect(costUsd(u, 'opus', 'main')).toBe(32.2)
    // 3M prompt tokens: over 100K, Haiku is billed 5x on all four rates
    expect(costUsd(u, 'haiku')).toBe(3.675)
    expect(costUsd(u, 'gpt-x')).toBeUndefined()
  })
  test('#15 long-prompt pricing: Haiku only, over 100K prompt tokens, 5x on all four rates', () => {
    // a prompt = input + cache read + cache write; 1M output each time: 1M x 0.5 = $0.5 (x5 when long)
    const at = (prompt: number) => ({ input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: prompt, cache_creation_input_tokens: 0 })
    expect(costUsd(at(99_000), 'haiku')).toBe(0.50099)
    expect(costUsd(at(100_000), 'haiku')).toBe(0.501)
    expect(costUsd(at(101_000), 'haiku')).toBe(2.50505)
    expect(costUsd(at(312_000), 'claude-haiku-5-5')).toBe(2.5156)
    // no other model: opus, sonnet and fable are flat
    expect(Math.abs((costUsd(at(312_000), 'claude-opus-5-5'))! - (20.0624)) < 1e-6).toBe(true)
    expect(Math.abs((costUsd(at(312_000), 'sonnet'))! - (10.0624)) < 1e-6).toBe(true)
    expect(Math.abs((costUsd(at(312_000), 'fable'))! - (50.078)) < 1e-6).toBe(true)
    // main prices: haiku x5 over 100K, the TTL picks the write rate
    const near = (got: ReturnType<typeof mainPrices>, want: { read: number; write: number; output: number }) => {
      expect(Math.abs((got!.read) - (want.read)) < 1e-12).toBe(true)
      expect(Math.abs((got!.write) - (want.write)) < 1e-12).toBe(true)
      expect(Math.abs((got!.output) - (want.output)) < 1e-12).toBe(true)
    }
    near(mainPrices('haiku', '1h', 100_000), { read: 0.01e-6, write: 0.2e-6, output: 0.5e-6 })
    near(mainPrices('haiku', '1h', 100_001), { read: 0.05e-6, write: 1e-6, output: 2.5e-6 })
    near(mainPrices('haiku', '5m', 150_000), { read: 0.05e-6, write: 0.625e-6, output: 2.5e-6 })
    near(mainPrices('opus', '1h', 312_000), { read: 0.2e-6, write: 8e-6, output: 20e-6 })
    expect(Math.abs((refusalCostUsd(312_000, 'haiku'))! - (312_000 * 0.05e-6)) < 1e-9).toBe(true)
    expect(Math.abs((refusalCostUsd(99_000, 'haiku'))! - (99_000 * 0.01e-6)) < 1e-9).toBe(true)
  })
  test('L2 the main write price follows the TTL (1h 2x input, 5m 1.25x input; 1h by default)', () => {
    expect(mainPrices('opus')!.write).toBe(8e-6)
    expect(mainPrices('opus', '1h')!.write).toBe(8e-6)
    expect(mainPrices('opus', '5m')!.write).toBe(5e-6)
    const s = { ...emptySavingsInputs('claude-opus-5-5', '5m', 150_000), digestTokens: 1000 }
    const r5 = savingsOf({ ...s, resultTokens: 1000 }, 0, 0)!
    const r1 = savingsOf({ ...s, ttl: '1h', resultTokens: 1000 }, 0, 0)!
    // 1000 result tokens written into the main context: $0.005 on the 5m cache, $0.008 on the 1h one; the digest the same
    expect(r5.normalUsd).toBe(0.005)
    expect(r1.normalUsd).toBe(0.008)
    expect(r5.actualUsd).toBe(0.005)
  })
  test('a research hand-off at a 150K opus context: normal $0.61, actual $0.229, saved $0.381, 29K tokens kept out', () => {
    // 10 helper calls, each a main round trip at 150K (x $0.20/MTok read = $0.03) and a 3K-token result.
    let s: ReturnType<typeof emptySavingsInputs> = { ...emptySavingsInputs('claude-opus-5-5'), briefTokens: 500, digestTokens: 1000, handoffRoundTripUsd: 0.03 }
    for (let i = 0; i < 10; i++) s = addHelperCall(s, 150_000, 'claude-opus-5-5', 'x'.repeat(12_000))
    expect(s.helperCalls).toBe(10)
    expect(s.roundTripUsd).toBe(0.3)
    expect(s.resultTokens).toBe(30_000)
    // normal = 0.30 round trips + 30K x $8/MTok written (0.24) + 2K helper output x $20/MTok (0.04)
    //        + 30K x $0.20/MTok re-read on 5 later main requests (0.03)
    // actual = helper $0.18 + 500 brief x $20/MTok (0.01) + 1K digest x $8/MTok (0.008)
    //        + the hand-off's own main round trip at 150K (0.03) + 1K digest x $0.20/MTok re-read on 5 later requests (0.001)
    expect(savingsOf({ ...s, laterMainRequests: 5 }, 0.18, 2000)).toEqual({ normalUsd: 0.61, actualUsd: 0.229, savedUsd: 0.381, tokensKeptOut: 29_000 })
    // no later requests: normal 0.58, actual 0.228
    expect(savingsOf({ ...s, laterMainRequests: 0 }, 0.18, 2000)?.savedUsd).toBe(0.352)
  })
  test('one quick lookup saves nothing (the two round trips cancel); an unknown main model gives no estimate', () => {
    let s: ReturnType<typeof emptySavingsInputs> = { ...emptySavingsInputs('opus'), briefTokens: 300, digestTokens: 400, handoffRoundTripUsd: 0.03 }
    s = addHelperCall(s, 150_000, undefined, 'x'.repeat(2000))
    // normal 0.03 + 500 x 8e-6 (0.004) + 300 x 20e-6 (0.006) = 0.04; actual 0.02 + 0.006 + 0.0032 + hand-off round trip 0.03 = 0.0592
    expect(savingsOf(s, 0.02, 300)).toEqual({ normalUsd: 0.04, actualUsd: 0.0592, savedUsd: -0.0192, tokensKeptOut: 100 })
    expect(savingsOf(emptySavingsInputs(), 0.02, 300)).toBeUndefined()
  })
  test('a hand-off at 150K opus whose helper made ONE work call with a small result saves about zero or slightly negative', () => {
    let s: ReturnType<typeof emptySavingsInputs> = { ...emptySavingsInputs('claude-opus-5-5'), briefTokens: 300, digestTokens: 100, handoffRoundTripUsd: 0.03 }
    s = addHelperCall(s, 150_000, 'claude-opus-5-5', 'x'.repeat(400))
    // normal 0.03 + 100 x 8e-6 (0.0008) + 200 out x 20e-6 (0.004) = 0.0348; actual 0.01 + 0.006 + 0.0008 + 0.03 = 0.0468
    const r = savingsOf(s, 0.01, 200)
    expect(r).toEqual({ normalUsd: 0.0348, actualUsd: 0.0468, savedUsd: -0.012, tokensKeptOut: 0 })
    expect(r!.savedUsd).toBeLessThanOrEqual(0.005)
    expect(r!.savedUsd).toBeGreaterThan(-0.03)
  })
  test('a 10-call research hand-off at 150K with ~3K-token results each still saves clearly positive', () => {
    let s: ReturnType<typeof emptySavingsInputs> = { ...emptySavingsInputs('claude-opus-5-5'), briefTokens: 500, digestTokens: 1000, handoffRoundTripUsd: 0.03 }
    for (let i = 0; i < 10; i++) s = addHelperCall(s, 150_000, 'claude-opus-5-5', 'x'.repeat(12_000))
    expect(savingsOf(s, 0.18, 2000)!.savedUsd).toBeGreaterThan(0.2)
  })
  test('a record missing handoffRoundTripUsd (older code) gives a finite number', () => {
    const old: Record<string, unknown> = { ...emptySavingsInputs('opus'), briefTokens: 300, digestTokens: 400, laterMainRequests: 2 }
    delete old.handoffRoundTripUsd
    const r = savingsOf(old as ReturnType<typeof emptySavingsInputs>, 0.02, 300)
    expect(Number.isFinite(r!.savedUsd)).toBe(true)
    expect(Number.isFinite(r!.actualUsd)).toBe(true)
  })
  test('a refusal costs one main request re-reading the context', () => {
    expect(refusalCostUsd(150_000, 'claude-opus-5-5')).toBe(0.03)
    expect(refusalCostUsd(undefined, 'opus')).toBeUndefined()
  })
  test('totals: spend, saved less block costs, kept out; would-refuse is not counted', () => {
    const h = (over: Partial<TierHandoff>): TierRecord =>
      ({ kind: 'handoff', outcome: 'done', costUsd: 0.1, saved: { normalUsd: 1, actualUsd: 0.1, savedUsd: 0.9, tokensKeptOut: 1000 }, ...over }) as TierRecord
    const t = totalsOf([
      h({}),
      h({ outcome: 'escalated' }),
      h({ outcome: 'running', costUsd: undefined, saved: undefined }),
      { kind: 'block', action: 'refused', costUsd: 0.03 } as TierRecord,
      { kind: 'block', action: 'would-refuse', costUsd: 0.03 } as TierRecord,
    ])
    // only the 'done' hand-off saves: the escalated one spends (0.1) but saves nothing; the running one has neither
    expect(t).toEqual({ handoffs: 3, running: 1, spentUsd: 0.2, savedUsd: 0.87, tokensKeptOut: 1000, blocks: 1, blocksUsd: 0.03, escalations: 1, checkFailed: 0 })
  })
  test('#14/#21 saved counts only done hand-offs with a known cost; spent counts every cost', () => {
    const h = (over: Partial<TierHandoff>): TierRecord =>
      ({ kind: 'handoff', outcome: 'done', costUsd: 0.1, saved: { normalUsd: 1, actualUsd: 0.1, savedUsd: 0.9, tokensKeptOut: 1000 }, ...over }) as TierRecord
    const t = totalsOf([
      h({ outcome: 'check failed' }),
      h({ outcome: 'cut off' }),
      h({ outcome: 'running', costUsd: 0.05 }),
      h({ costUsd: undefined }), // done, cost not known (yet)
      h({ outcome: 'escalated' }),
    ])
    expect(t).toMatchObject({ handoffs: 5, spentUsd: 0.35, savedUsd: 0, tokensKeptOut: 0, running: 1, escalations: 1, checkFailed: 1 })
    expect(countsSaving({ outcome: 'done', costUsd: 0 })).toBe(true)
    expect(countsSaving({ outcome: 'done', costUsd: undefined })).toBe(false)
    expect(countsSaving({ outcome: 'running', costUsd: 1 })).toBe(false)
  })
})

describe('the hand-off gate', () => {
  test('model and effort on the call pass; a missing effort is refused with an exact example', () => {
    expect(gateAgent({ model: 'opus', effort: 'low', subagentType: 'tier-mod:reader', filePins: {} }, null, noOne)).toEqual({ kind: 'pass' })
    const v = gateAgent({ model: 'sonnet' }, null, noOne)
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') {
      expect(v.reason).toStartWith('Tier: this Agent call names no effort')
      expect(v.reason).toContain(exampleCall('reader'))
      expect(v.reason.includes('\n')).toBe(false)
    }
  })
  test('file pins count; fork passes; an unknown plugin type is unverifiable; Explore with nothing is refused', () => {
    expect(gateAgent({ subagentType: 'scout', filePins: { model: 'haiku', effort: 'low' } }, null, noOne)).toEqual({ kind: 'pass' })
    expect(gateAgent({ subagentType: 'fork' }, null, noOne)).toEqual({ kind: 'pass' })
    expect(gateAgent({ subagentType: 'other:thing', filePins: null }, null, noOne)).toEqual({ kind: 'pass', unverifiable: true })
    expect(gateAgent({ subagentType: 'Explore' }, null, noOne).kind).toBe('refuse')
  })
  test('readAgentPins reads the frontmatter, inherit is no pin', () => {
    expect(readAgentPins('---\nname: x\nmodel: haiku\neffort: low\n---\nbody')).toEqual({ model: 'haiku', effort: 'low' })
    expect(readAgentPins('---\r\nname: x\r\nmodel: inherit\r\n---\r\n')).toEqual({})
  })
  test('max / fable: refused untagged or with no opus failure of that tag this session', () => {
    expect(unlockDecide('opus', 'max', null, noOne).kind).toBe('refuse')
    const v = unlockDecide('opus', 'max', 'q', noOne)
    expect(v.kind === 'refuse' && v.reason).toContain('[t=q]')
    expect(unlockDecide('opus', 'xhigh', null, noOne)).toEqual({ kind: 'pass' })
  })
  test('max / fable: an opus ESCALATE: or failed check of the same tag unlocks it; sonnet or another tag does not', () => {
    const opusEsc = [{ tag: 'q', model: 'claude-opus-5-5', outcome: 'escalated' as const, effort: 'xhigh' }]
    expect(unlockDecide('fable', 'high', 'q', { handoffs: opusEsc, userAskedMaxOrFable: false })).toEqual({ kind: 'pass' })
    expect(unlockDecide('opus', 'max', 'q', { handoffs: [{ tag: 'q', model: 'opus', effort: 'max', outcome: 'check failed' as const }], userAskedMaxOrFable: false })).toEqual({ kind: 'pass' })
    expect(unlockDecide('opus', 'max', 'q', { handoffs: [{ tag: 'q', model: 'sonnet', outcome: 'escalated' as const }], userAskedMaxOrFable: false }).kind).toBe('refuse')
    expect(unlockDecide('opus', 'max', 'r', { handoffs: opusEsc, userAskedMaxOrFable: false }).kind).toBe('refuse')
    expect(unlockDecide('claude-fable-5-1', 'low', null, { handoffs: [], userAskedMaxOrFable: true })).toEqual({ kind: 'pass' })
  })
  test('the user asking for max or Fable', () => {
    expect(userAsksMaxOrFable('run this one on Fable please')).toBe(true)
    expect(userAsksMaxOrFable('use max effort for the proof')).toBe(true)
    expect(userAsksMaxOrFable('keep it to max 5 lines')).toBe(false)
  })
})

describe('workflow scan', () => {
  test('literal model, effort and agentType pass', () => {
    const script = `export const meta = { name: 'x', description: 'agent(nope)' }
// agent('in a comment')
const a = await agent('List files', { label: '[t=ls] list', model: 'haiku', effort: "low", agentType: 'tier-mod:reader' })
const b = await pipeline(files, f => agent(\`Audit \${f}\`, { model: 'sonnet', effort: \`high\`, agentType: 'tier-mod:reader', label: f }))`
    const entries = scanWorkflowScript(script)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ index: 1, label: '[t=ls] list', model: 'haiku', effort: 'low', agentType: 'tier-mod:reader', status: 'ok', missing: [] })
    expect(gateWorkflow(entries, noOne)).toEqual({ kind: 'pass' })
  })
  test('a missing agentType is refused with the fix named', () => {
    const entries = scanWorkflowScript(`await agent('b', { model: 'sonnet', effort: 'low', label: 'readme' })`)
    expect(entries[0]?.missing).toEqual(['agentType'])
    const v = gateWorkflow(entries, noOne)
    expect(v.kind === 'refuse' && v.reason).toContain('#1 (readme) names no agentType')
    expect(scanWorkflowScript(`await agent('c')`)[0]?.missing).toEqual(['model', 'effort', 'agentType'])
  })
  test('a non-literal value or a spread is unverifiable and passes', () => {
    const entries = scanWorkflowScript(`await agent('a', { model: m, effort: 'low', agentType: 'x' })
await agent('b', { ...opts })
await agent('c', opts)`)
    expect(entries.map(e => e.status)).toEqual(['unverifiable', 'unverifiable', 'unverifiable'])
    expect(gateWorkflow(entries, noOne)).toEqual({ kind: 'pass', unverifiable: true })
  })
  test('the max unlock applies to a literal max in a workflow, by its label tag', () => {
    const v = gateWorkflow(scanWorkflowScript(`await agent('x', { model: 'opus', effort: 'max', agentType: 'tier-mod:editor', label: '[t=q] prove' })`), noOne)
    expect(v.kind === 'refuse' && v.reason).toContain('[t=q]')
  })
})

describe('the work gate', () => {
  test('tool classes', () => {
    expect(['Agent', 'Workflow', 'AskUserQuestion', 'ToolSearch', 'Skill', 'SendMessage', 'TaskCreate', 'mcp__ccd_session__x', 'ArtifactCheck', 'mcp__tier-mod__x'].map(classifyTool)).toEqual(
      Array(10).fill('exempt'),
    )
    expect(classifyTool('mcp__Claude_Browser__navigate')).toBe('browser')
    expect(classifyTool('mcp__claude-in-chrome__read_page')).toBe('browser')
    expect(['WebSearch', 'WebFetch', 'mcp__exa__web_search_exa'].map(classifyTool)).toEqual(['web', 'web', 'web'])
    expect(classifyTool('Grep')).toBe('other')
  })
  test('web commands: curl, wget, Invoke-WebRequest, Invoke-RestMethod, iwr, irm, npx ctx7', () => {
    for (const c of ['curl -s https://x', '  wget x', 'Invoke-WebRequest x', 'invoke-restmethod x', 'iwr x', 'irm x', 'npx ctx7 docs /a/b q', 'npx ctx7@latest library x', 'curl.exe x']) {
      expect(isWebCommand(c)).toBe(true)
    }
    for (const c of ['git status', 'npm test', 'echo curl', 'curling', 'npx tsc']) expect(isWebCommand(c)).toBe(false)
  })
  test('web commands at any command boundary, wrapped in a shell, behind env, and fetch one-liners', () => {
    for (const c of [
      'cd x && curl https://x',
      'echo; curl x',
      'false || wget x',
      'cat a | curl -d @- x',
      'echo $(curl -s x)',
      'echo `curl -s x`',
      'powershell -c "irm https://x"',
      'pwsh -NoProfile -Command "Invoke-WebRequest x"',
      'cmd /c curl.exe x',
      'bash -c "curl x"',
      'node -e "fetch(\'https://x\').then(r => r.text())"',
      'python -c "import urllib.request; print(urllib.request.urlopen(\'https://x\').read())"',
      'python3 -c "import requests; requests.get(\'https://x\')"',
      'gh api repos/a/b',
      'npx -y ctx7 docs /a/b q',
      'npx --yes ctx7@latest library x',
      'FOO=1 curl.exe x',
      '& curl.exe x',
    ]) {
      expect([c, isWebCommand(c)]).toEqual([c, true])
    }
    for (const c of ['git commit -m "use curl"', 'node -e "console.log(1)"', 'python -c "print(1)"', 'gh pr list', 'npm run build && npm test', 'grep -r fetch src']) {
      expect([c, isWebCommand(c)]).toEqual([c, false])
    }
  })
  test('other web tools: known web MCP servers, or named web_search / web_fetch (not a local search)', () => {
    for (const t of ['mcp__fetch__fetch', 'mcp__other__web_fetch', 'mcp__firecrawl__firecrawl_scrape', 'mcp__brave__brave_search', 'mcp__tavily__tavily-search', 'mcp__perplexity__ask', 'mcp__x__web_search', 'web_fetch']) {
      expect([t, classifyTool(t)]).toEqual([t, 'web'])
    }
    for (const t of ['Grep', 'Glob', 'mcp__filesystem__search_files', 'LSP', 'mcp__mcp-registry__search_mcp_registry', 'mcp__x__crawl_site', 'mcp__github__search_code']) {
      expect([t, classifyTool(t)]).toEqual([t, 'other'])
    }
    expect(workBefore({ tool: 'mcp__fetch__fetch' }, gate(), S).kind).toBe('refuse')
  })
  test('web is refused with the brief\'s exact line; "do it yourself" lifts it', () => {
    const v = workBefore({ tool: 'WebSearch' }, gate(), S)
    expect(v.kind === 'refuse' && v.reason).toBe(
      'Tier: hand this to a helper - Agent(subagent_type "tier-mod:reader", model "sonnet", effort "medium", description "[t=<task>] ..."). Limits: web always, 8K tokens reading, 2 files editing per message. The user can say "do it yourself".',
    )
    expect(v.kind === 'refuse' && v.toast).toBe('Tier handed off a web search - say "do it yourself" to skip')
    expect(workBefore({ tool: 'Bash', command: 'curl https://x' }, gate(), S).kind).toBe('refuse')
    expect(workBefore({ tool: 'WebSearch' }, gate({ override: true }), S)).toEqual({ kind: 'pass' })
    expect(freshGate('Please do it yourself this time').override).toBe(true)
    expect(freshGate('DO IT YOURSELF').override).toBe(true)
    expect(freshGate('no delegation').override).toBe(false)
  })
  test('a Read of a 300+ line file with no range is refused; a range passes', () => {
    const v = workBefore({ tool: 'Read', filePath: '/a.ts', hasRange: false }, gate(), S, 900)
    expect(v.kind === 'refuse' && v.toast).toBe('Tier handed off a 900-line read - say "do it yourself" to skip')
    expect(workBefore({ tool: 'Read', filePath: '/a.ts', hasRange: true }, gate(), S, 900)).toEqual({ kind: 'pass' })
    expect(workBefore({ tool: 'Read', filePath: '/a.ts', hasRange: false }, gate(), S, 299)).toEqual({ kind: 'pass' })
    expect(workBefore({ tool: 'Read', filePath: '/a.ts', hasRange: false }, gate(), S, 300).kind).toBe('refuse')
  })
  test('edits: a third distinct file is refused, the same file again passes; a Write over 150 lines is refused', () => {
    expect(workBefore({ tool: 'Edit', filePath: 'C:\\A.ts' }, gate({ editFiles: ['c:/a.ts', '/b.ts'] }), S)).toEqual({ kind: 'pass' })
    // Claude's own memory and plan files never count against the allowance
    for (const f of ['C:\\Users\\x\\.claude\\projects\\C--p\\memory\\MEMORY.md', '/home/x/.claude/plans/plan.md']) {
      expect([f, isClaudeOwnFile(f), workBefore({ tool: 'Write', filePath: f, content: 'x' }, gate({ editFiles: ['c:/a.ts', '/b.ts'] }), S)]).toEqual([f, true, { kind: 'pass' }])
    }
    // scratch paths (OS temp, the session scratchpad) are exempt for Write/Edit/NotebookEdit too, and from the line limit
    const full = gate({ editFiles: ['c:/a.ts', '/b.ts'] })
    for (const f of ['C:\\Users\\X\\AppData\\Local\\Temp\\claude\\p\\s\\scratchpad\\a.html', '/tmp/x.md']) {
      for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
        expect([f, tool, workBefore({ tool, filePath: f, content: 'x' }, full, S)]).toEqual([f, tool, { kind: 'pass' }])
      }
      expect(editTargets({ tool: 'Write', filePath: f, content: 'x' })).toEqual([])
      expect(workBefore({ tool: 'Write', filePath: f, content: 'x\n'.repeat(400) }, full, S)).toEqual({ kind: 'pass' })
    }
    // a project file still counts, and the 3rd distinct one is still refused
    expect(editTargets({ tool: 'Write', filePath: 'C:\\Users\\X\\proj\\a.ts', content: 'x' })).toEqual(['c:/users/x/proj/a.ts'])
    expect(workBefore({ tool: 'Write', filePath: 'C:\\Users\\X\\proj\\c.ts', content: 'x' }, full, S).kind).toBe('refuse')
    expect(workBefore({ tool: 'Write', filePath: 'C:\\Users\\X\\proj\\c.ts', content: 'x' }, gate({ editFiles: ['c:/a.ts'] }), S)).toEqual({ kind: 'pass' })
    expect(isClaudeOwnFile('/home/x/.claude/projects/p/src/a.ts')).toBe(false)
    expect(isClaudeOwnFile('/repo/memory/a.md')).toBe(false)
    const v = workBefore({ tool: 'Edit', filePath: '/c.ts' }, gate({ editFiles: ['c:/a.ts', '/b.ts'] }), S)
    expect(v.kind === 'refuse' && v.reason).toContain('tier-mod:editor')
    const w = workBefore({ tool: 'Write', filePath: '/d.ts', content: 'x\n'.repeat(151) }, gate(), S)
    expect(w.kind === 'refuse' && w.reason).toContain('a Write of 151 lines')
    expect(workBefore({ tool: 'Write', filePath: '/d.ts', content: 'x\n'.repeat(150) }, gate(), S)).toEqual({ kind: 'pass' })
  })
  test('after: a read-only result past the allowance is withheld; only output it can withhold counts (not a command, not a browser)', () => {
    expect(workAfter('Grep', true, 3000, gate({ readTokens: 5000 }), S)).toEqual({ counts: true })
    const w = workAfter('Grep', true, 3001, gate({ readTokens: 5000 }), S)
    expect(w.withhold?.reason).toContain("reading allowance (8K tokens) is used up")
    expect(workAfter('Bash', false, 50_000, gate({ readTokens: 7000 }), S)).toEqual({ counts: false })
    // a read-only Bash (core marks `cat`, `rg`, `ls` read-only) past the allowance is withheld like any read
    expect(workAfter('Bash', true, 3001, gate({ readTokens: 5000 }), S).withhold?.reason).toContain('reading allowance')
    expect(workAfter('mcp__Claude_Browser__read', true, 50_000, gate(), S)).toEqual({ counts: false })
    expect(workAfter('Grep', true, 50_000, gate({ override: true }), S)).toEqual({ counts: true })
    expect(workAfter('Agent', true, 50_000, gate(), S)).toEqual({ counts: false })
  })
  test('limits text follows the settings; line counting', () => {
    expect(limitsText({ readTokens: 4000, editFiles: 3 })).toContain('4K tokens reading, 3 files editing')
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('')).toBe(0)
  })
  test('a folded message keeps the override; a new one resets the counters', () => {
    const before: TierGate = { readTokens: 5000, editFiles: ['/a'], override: true, userAskedMaxOrFable: false }
    expect(freshGate('more', before, true)).toEqual({ readTokens: 0, editFiles: [], override: true, userAskedMaxOrFable: false })
    expect(freshGate('more', before, false).override).toBe(false)
  })
})

describe('checks and escalation', () => {
  test('exit codes of Bash results', () => {
    expect(exitCodeOf({ text: 'ok' })).toBe(0)
    expect(exitCodeOf({ isError: true, text: 'Exit code 2\nboom' })).toBe(2)
    expect(exitCodeOf({ text: 'Exit code 1\nfail' })).toBe(1)
    expect(exitCodeOf({ isError: true, text: 'no header' })).toBe(1)
  })
  test('ESCALATE: detection and failure signatures', () => {
    expect(isEscalate('  ESCALATE: the spec contradicts itself')).toBe(true)
    expect(isEscalate('Done. ESCALATE: no')).toBe(false)
    expect(failureSignature('escalated', 'ESCALATE: spec unclear\nmore')).toBe('ESCALATE: spec unclear')
    expect(failureSignature('check failed', '', 'npm test', 1)).toBe('npm test exit 1')
  })
  test('the ladder: haiku -> sonnet/high -> opus/low -> rewrite the brief -> opus/xhigh -> opus/max -> stop', () => {
    expect(nextRung('haiku', 'low', 's', [])).toBe('sonnet/high')
    expect(nextRung('claude-sonnet-5-5', 'high', 's', [])).toBe('opus/low')
    expect(nextRung('opus', 'low', 's', [])).toBe('rewrite the brief, then opus/low again')
    expect(nextRung('opus', 'low', 's', [{ model: 'opus', effort: 'low', failure: 'x' }])).toBe('opus/xhigh')
    expect(nextRung('opus', 'xhigh', 's', [])).toBe('opus/max (fable/high on plans with Fable)')
    expect(nextRung('opus', 'max', 's', [])).toBe('stop and report to the user')
    expect(nextRung('fable', 'high', 's', [])).toBe('stop and report to the user')
  })
  test('the same failure on two rungs jumps to opus/low', () => {
    expect(nextRung('sonnet', 'high', 'npm test exit 1', [{ model: 'haiku', effort: 'low', failure: 'npm test exit 1' }])).toBe('opus/low (the same failure on two rungs)')
    expect(nextRung('sonnet', 'high', 'npm test exit 1', [{ model: 'haiku', effort: 'low', failure: 'other' }])).toBe('opus/low')
  })
  test('the note names the tag, try, rung and the check command', () => {
    const h = { tag: 'fix', try: 1, model: 'claude-haiku-5-5', effort: 'low', lastCommand: 'npm test', lastExit: 1 }
    const note = escalationNote(h, 'check failed', 'sonnet/high', 'npm test exit 1')
    expect(note).toStartWith('[tier] [t=fix] try 1 on haiku/low failed its check (npm test - exit 1). Next rung: sonnet/high. Keep the tag [t=fix].')
    expect(escalationNote({ ...h, tag: null, try: 0 }, 'escalated', 'sonnet/high', 'ESCALATE: x')).toContain('this untagged hand-off on haiku/low replied ESCALATE:')
  })
})

describe('facts, storage, install', () => {
  test('the tier-rule tag', () => {
    expect(findRuleTag('## x\n<!-- tier-rule v1.11.1 -->\n')).toBe('1.11.1')
    expect(findRuleTag('no tag')).toBeNull()
  })
  test('one store key per record; its day reads back', () => {
    const key = recordKey({ day: '2026-10-24', sessionId: 's-1', id: 'toolu_1' })
    expect(key).toBe('rec:2026-10-24:s-1:toolu_1')
    expect(dayOfKey(key)).toBe('2026-10-24')
    expect(dayOfKey('cache:2026-10-24')).toBeNull()
  })
  test('days older than 30 roll up, then the oldest while over budget', () => {
    expect(daysToRoll(['2026-09-01', '2026-09-24', '2026-10-24'], '2026-10-24', {})).toEqual(['2026-09-01'])
    expect(daysToRoll(['2026-10-01', '2026-10-02', '2026-10-24'], '2026-10-24', { '2026-10-01': 50, '2026-10-02': 50, '2026-10-24': 50 }, 120)).toEqual(['2026-10-01'])
  })
  test('a day summary adds onto an earlier one, by model and by tag', () => {
    const r = { kind: 'handoff', model: 'claude-haiku-5-5', effort: 'low', tag: 'x', outcome: 'done', costUsd: 0.01 } as TierRecord
    const once = summarizeDay('2026-09-01', [r])
    const twice = summarizeDay('2026-09-01', [r], once)
    expect(twice.handoffs).toBe(2)
    expect(twice.byModel['haiku/low']).toEqual({ count: 2, usd: 0.02 })
    expect(twice.byTag.x).toEqual({ count: 2, usd: 0.02 })
  })
  test('old hooks: pin-enforcer is flagged, a statusLine never is', () => {
    const settings = {
      statusLine: { type: 'command', command: 'node statusline-cache.mjs | deadman' },
      hooks: { PreToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command: 'node pin-enforcer.mjs' }] }] },
    }
    expect(findOldTierHooks(settings)).toEqual(['hooks.PreToolUse (pin-enforcer)'])
    expect(findOldTierHooks({ statusLine: { command: 'statusline-cache' } })).toEqual([])
  })
})

test('the person\'s presses in the gate: "Do it myself" while idle lifts the next message once; "Allow max" tags stand for the session', () => {
  const carried = freshGate('next thing', { ...freshGate(), carryOverride: true })
  expect(carried.override).toBe(true)
  expect(carried.carryOverride).toBeUndefined()
  expect(freshGate('and again', carried).override).toBe(false)
  const allowed = freshGate('hi', { ...freshGate(), allowMaxTags: ['q'] })
  expect(allowed.allowMaxTags).toEqual(['q'])
  expect(freshGate('x', allowed).allowMaxTags).toEqual(['q'])
  expect(unlockDecide('opus', 'max', 'q', { handoffs: [], userAskedMaxOrFable: false, allowedTags: ['q'] })).toEqual({ kind: 'pass' })
  expect(unlockDecide('fable', 'high', 'r', { handoffs: [], userAskedMaxOrFable: false, allowedTags: ['q'] }).kind).toBe('refuse')
  expect(unlockDecide('opus', 'max', null, { handoffs: [], userAskedMaxOrFable: false, allowedTags: ['q'] }).kind).toBe('refuse')
})

describe('audit 0.19.0 batch 3: enforcement', () => {
  test('#1 PowerShell is a shell; Monitor is a shell with a command and web with a socket', () => {
    expect(classifyTool('PowerShell')).toBe('bash')
    expect(classifyTool('Monitor', { command: 'tail -f x' })).toBe('bash')
    expect(classifyTool('Monitor', { ws: { url: 'wss://x' } })).toBe('web')
    expect(workBefore({ tool: 'PowerShell', command: 'irm https://x' }, gate(), S).kind).toBe('refuse')
    expect(workBefore({ tool: 'PowerShell', command: 'curl.exe -s https://x' }, gate(), S).kind).toBe('refuse')
    expect(workBefore({ tool: 'Monitor', command: 'curl -N https://x' }, gate(), S).kind).toBe('refuse')
    expect(workBefore({ tool: 'Monitor', ws: true }, gate(), S).kind).toBe('refuse')
    expect(workBefore({ tool: 'PowerShell', command: 'Get-ChildItem' }, gate(), S)).toEqual({ kind: 'pass' })
  })
  test('#2 shell writes: clear targets count; null devices, fds, unclear and temp targets do not', () => {
    const t = (c: string) => shellWrites(c).files
    expect(t('echo x > a.txt')).toEqual(['a.txt'])
    expect(t('echo x >> "b c.txt" 2>&1')).toEqual(['b c.txt'])
    expect(t('npm test > /dev/null 2>&1; echo x >NUL')).toEqual([])
    expect(t('ls 2>&1 | tee log.txt')).toEqual(['log.txt'])
    expect(t("sed -i 's/a/b/' src/x.ts src/y.ts")).toEqual(['src/x.ts', 'src/y.ts'])
    expect(t("sed -n '1,5p' x.ts")).toEqual([])
    expect(t("perl -pi -e 's/a/b/' z.pl")).toEqual(['z.pl'])
    expect(t("Set-Content -Path C:\\a\\b.txt -Value 'x'")).toEqual(['C:\\a\\b.txt'])
    expect(t("'x' | Out-File out.txt; Add-Content -Value y log.md")).toEqual(['out.txt', 'log.md'])
    expect(t('cp a.ts b.ts && mv c.ts d/')).toEqual(['b.ts', 'd/'])
    expect(t('Copy-Item a.ts -Destination e.ts')).toEqual(['e.ts'])
    expect(t('echo x > $OUT; cat a > *.txt')).toEqual([])
    expect(t('git commit -m "a > b"')).toEqual([])
    const doc = `cat > f.ts <<'EOF'\n${'x\n'.repeat(151)}EOF`
    expect(shellWrites(doc)).toEqual({ files: ['f.ts'], bodyLines: 151 })
    expect(workBefore({ tool: 'Bash', command: doc }, gate(), S)).toMatchObject({ kind: 'refuse', gate: 'edit' })
    const here = `@'\n${'x\n'.repeat(160)}'@ | Set-Content g.ts`
    expect(workBefore({ tool: 'PowerShell', command: here }, gate(), S)).toMatchObject({ kind: 'refuse', gate: 'edit' })
    expect(workBefore({ tool: 'Bash', command: 'echo a > /c.ts' }, gate({ editFiles: ['c:/a.ts', '/b.ts'] }), S)).toMatchObject({ kind: 'refuse', gate: 'edit' })
    expect(workBefore({ tool: 'Bash', command: 'echo a > /b.ts' }, gate({ editFiles: ['c:/a.ts', '/b.ts'] }), S)).toEqual({ kind: 'pass' })
    expect(workBefore({ tool: 'Bash', command: 'echo a > /x.ts; echo b > /y.ts; echo c > /z.ts' }, gate(), S).kind).toBe('refuse')
    for (const f of ['/tmp/x.txt', 'C:\\Users\\F\\AppData\\Local\\Temp\\claude\\s\\scratchpad\\n.md', 'C:\\Users\\F\\.claude\\plans\\p.md']) {
      expect([f, editTargets({ tool: 'Bash', command: `echo x > "${f}"` })]).toEqual([f, []])
    }
    const big = `cat > /tmp/big <<EOF\n${'x\n'.repeat(200)}EOF`
    expect(editTargets({ tool: 'Bash', command: big })).toEqual([])
    expect(workBefore({ tool: 'Bash', command: big }, gate(), S)).toEqual({ kind: 'pass' })
  })
  test("#3 only the person's own typed words ask: pasted, fenced, quoted and negated asks do not", () => {
    expect(asksOverride('please do it yourself')).toBe(true)
    expect(asksOverride("don't do it yourself, hand it off")).toBe(false)
    expect(asksOverride('never do it yourself')).toBe(false)
    expect(asksOverride('the rule says "do it yourself" lifts it')).toBe(false)
    expect(asksOverride('> The user can say do it yourself.\nwhat does this mean?')).toBe(false)
    expect(asksOverride('```\ndo it yourself\n```')).toBe(false)
    expect(asksOverride('<pasted_content>The user can say do it yourself</pasted_content> thoughts?')).toBe(false)
    expect(userAsksMaxOrFable('do not use max effort here')).toBe(false)
    expect(userAsksMaxOrFable('no fable for this one')).toBe(false)
    expect(userAsksMaxOrFable('the doc mentions "fable" pricing')).toBe(false)
    expect(userAsksMaxOrFable('try fable on it')).toBe(true)
    expect(freshGate("don't do it yourself").override).toBe(false)
  })
  test('#7 web commands behind paths, wrappers with arguments, assignments, script blocks, passthroughs', () => {
    for (const c of [
      '/usr/bin/curl https://x',
      'C:\\Windows\\System32\\curl.exe https://x',
      'bash -lc "curl x"',
      'powershell -ExecutionPolicy Bypass -Command "irm x"',
      '$r = iwr https://x',
      'if ($true) { irm https://x }',
      'echo u | xargs curl',
      'wsl curl https://x',
      'Start-Process curl https://x',
      'ls | % { irm https://x }',
      `node -e "require('https').get('https://x')"`,
      'bash <<EOF\ncurl https://x\nEOF',
    ]) {
      expect([c, isWebCommand(c)]).toEqual([c, true])
    }
  })
  test('#8 no false refusal inside quotes or heredoc bodies', () => {
    for (const c of [
      'git commit -m "add retry; curl support"',
      "git commit -m 'fix | curl'",
      'grep -E "a|curl" src',
      'cat > notes.md <<EOF\ncurl is used\nwget too\nEOF',
      "echo 'x && wget y'",
    ]) {
      expect([c, isWebCommand(c)]).toEqual([c, false])
    }
    expect(isWebCommand('echo "$(curl -s x)"')).toBe(true)
    expect(isWebCommand('echo "unclosed; curl x')).toBe(true) // malformed: falls back to the plain split
  })
  test('#9 web MCP prefixes anchored on the server separator; claude.ai exa included', () => {
    expect(classifyTool('mcp__fetch_local__list')).toBe('other')
    expect(classifyTool('mcp__firecrawler_local__x')).toBe('other')
    expect(classifyTool('mcp__claude_ai_exa__agent_run')).toBe('web')
    expect(classifyTool('mcp__fetch__fetch')).toBe('web')
  })
  test('#10 only real check commands are checks', () => {
    for (const c of ['npm test', 'pnpm run build', 'yarn lint', 'bun test', 'pytest -q', 'cargo test', 'go build ./...', 'tsc -p .', 'make test', '"$CLAUDE_CODE_EXECPATH" plugin test C:/x', 'claude plugin test .', 'C:/bin/claude.exe plugin test x', 'dotnet test', 'gradle test', 'mvn test', 'cd x && npm test', 'node "C:/a/typescript/lib/tsc.js" -p tsconfig.json']) {
      expect([c, isCheckCommand(c)]).toEqual([c, true])
    }
    for (const c of ['grep -r foo src', 'rg foo', 'test -f x', 'git diff --quiet', '[ -f x ]', 'npm install', 'ls', 'grep -rn "plugin test" docs', 'echo plugin test']) {
      expect([c, isCheckCommand(c)]).toEqual([c, false])
    }
  })
})

describe('audit 0.19.0 batch 4: rule', () => {
  test('max / fable: an opus/low or opus/high failure does not unlock; xhigh or max does', () => {
    for (const effort of ['low', 'high', undefined]) {
      const v = unlockDecide('opus', 'max', 'q', { handoffs: [{ tag: 'q', model: 'opus', effort, outcome: 'escalated' as const }], userAskedMaxOrFable: false })
      expect(v.kind).toBe('refuse')
      expect(v.kind === 'refuse' && v.reason).toContain('opus/xhigh')
    }
    expect(unlockDecide('fable', 'high', 'q', { handoffs: [{ tag: 'q', model: 'opus', effort: 'XHIGH', outcome: 'check failed' as const }], userAskedMaxOrFable: false })).toEqual({ kind: 'pass' })
    expect(unlockDecide('opus', 'max', 'q', { handoffs: [{ tag: 'q', model: 'opus', effort: 'low', outcome: 'escalated' as const }], userAskedMaxOrFable: true })).toEqual({ kind: 'pass' })
  })
  test('rule and addendum wording', () => {
    expect(RULE_BLOCK).toContain('Mod on: LIMITS, pins, max/Fable unlock enforced in code; ladder = [tier] note.')
    expect(RULE_BLOCK).toContain('(haiku 5x above 100K prompt)')
    expect(RULE_BLOCK).toContain('Mod keep-warm (1h cache only): per-session, off by default')
    expect(RULE_BLOCK).toContain('after an opus/xhigh failure of that [t=] task')
    expect(RULE_BLOCK).toContain('inline edits up to 2 files incl. shell writes (a Write <= 150 lines)')
    expect(FACTS_ADDENDUM).toContain('A Write is at most 150 lines; shell writes count as edits; the PowerShell tool is gated like Bash')
    expect(TIER_MOD_VERSION).toBe('0.20.0')
  })
})
