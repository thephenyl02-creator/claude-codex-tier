// Pure functions of the Tier mod: no `$`, no state. Unit-tested in core.test.ts.
import type {
  TierDaySummary,
  TierGate,
  TierHandoff,
  TierRecord,
  TierSavings,
  TierSavingsInputs,
  TierScanEntry,
  TierSettings,
  TierTotals,
} from '../types'

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

// ---------------------------------------------------------------- settings

export function readSettings(options: Readonly<Record<string, unknown>>): TierSettings {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    enforce: options.enforce !== false,
    readTokens: num(options.readTokens, 8000),
    readLines: num(options.readLines, 300),
    editFiles: num(options.editFiles, 2),
    facts: options.facts === 'off' ? 'off' : 'auto',
  }
}

/** A Write longer than this many lines is refused (not a setting). */
export const WRITE_MAX_LINES = 150

// ---------------------------------------------------------------- task tag

/** The task tag of a description or label: `[t=<word>]`, or the legacy `[tier t=<word> ...]`. */
export function parseTag(text: string | undefined | null): string | null {
  if (!text) return null
  const m = text.match(/\[t=([^\s\]]+)\]/) ?? text.match(/\[tier\s[^\]]*?\bt=([^\s\]]+)/)
  return m ? (m[1] ?? null) : null
}

// ---------------------------------------------------------------- models and prices

export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku'

export function modelFamily(model: string | undefined | null): ModelFamily | null {
  const m = (model ?? '').toLowerCase()
  if (m.includes('fable')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return null
}

/** $/MTok list prices from the 1.11.1 rule block: input, output; cache read = input x readFactor. */
export const PRICES: Readonly<Record<ModelFamily, { input: number; output: number; readFactor: number }>> = {
  fable: { input: 10, output: 50, readFactor: 0.025 },
  opus: { input: 4, output: 20, readFactor: 0.05 },
  sonnet: { input: 2, output: 10, readFactor: 0.1 },
  haiku: { input: 0.1, output: 0.5, readFactor: 0.1 },
}

/** Long-prompt pricing exists only for Haiku 5.5: a prompt over 100K tokens is billed at 5x (all four rates). */
export const LONG_PROMPT_TOKENS = 100_000
export function longPromptFactor(model: string | undefined | null, promptTokens: number | undefined): number {
  return modelFamily(model) === 'haiku' && promptTokens !== undefined && promptTokens > LONG_PROMPT_TOKENS ? 5 : 1
}

export type UsageLike = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/**
 * USD cost of one turn's usage. Sub-agents write the cache at the 5-minute
 * rate (1.25x input); the main loop at the 1-hour rate (2x input). Undefined
 * when the model is unknown.
 */
export function costUsd(usage: UsageLike | undefined | null, model: string | undefined | null, who: 'subagent' | 'main' = 'subagent'): number | undefined {
  if (!usage) return undefined
  const fam = modelFamily(model)
  if (!fam) return undefined
  const p = PRICES[fam]
  const writeFactor = who === 'subagent' ? 1.25 : 2
  const prompt = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  const long = longPromptFactor(model, prompt)
  const usd =
    long *
    ((usage.input_tokens ?? 0) * p.input +
      (usage.output_tokens ?? 0) * p.output +
      (usage.cache_read_input_tokens ?? 0) * p.input * p.readFactor +
      (usage.cache_creation_input_tokens ?? 0) * p.input * writeFactor) /
    1_000_000
  return round6(usd)
}

/**
 * The main session's per-token prices: read, write (1h cache 2x input, 5m cache 1.25x input; default 1h), output.
 * `contextTokens` is the prompt size: over 100K on Haiku every rate is 5x.
 */
export function mainPrices(
  model: string | undefined | null,
  ttl: '1h' | '5m' = '1h',
  contextTokens?: number,
): { read: number; write: number; output: number } | undefined {
  const fam = modelFamily(model)
  if (!fam) return undefined
  const p = PRICES[fam]
  const long = longPromptFactor(model, contextTokens)
  return {
    read: (long * p.input * p.readFactor) / 1e6,
    write: (long * p.input * (ttl === '5m' ? 1.25 : 2)) / 1e6,
    output: (long * p.output) / 1e6,
  }
}

/** Tokens of a text: length / 4, rounded up. */
export function tokensOf(text: string | undefined | null): number {
  return Math.ceil((text ?? '').length / 4)
}

// ---------------------------------------------------------------- savings meter (spec 2.5)

export function emptySavingsInputs(mainModel?: string, ttl?: '1h' | '5m', mainContextTokens?: number): TierSavingsInputs {
  const s: TierSavingsInputs = { helperCalls: 0, roundTripUsd: 0, handoffRoundTripUsd: 0, resultTokens: 0, briefTokens: 0, digestTokens: 0, laterMainRequests: 0 }
  if (mainModel) s.mainModel = mainModel
  if (ttl) s.ttl = ttl
  if (mainContextTokens !== undefined) s.mainContextTokens = mainContextTokens
  return s
}

/** One helper tool call: a main round trip at this context, and its result tokens. */
export function addHelperCall(s: TierSavingsInputs, mainContextTokens: number | undefined, mainModel: string | undefined, resultText: string | undefined): TierSavingsInputs {
  const model = s.mainModel ?? mainModel
  const p = mainPrices(model, s.ttl, mainContextTokens)
  const next: TierSavingsInputs = {
    ...s,
    helperCalls: s.helperCalls + 1,
    roundTripUsd: round6(s.roundTripUsd + (p && mainContextTokens ? mainContextTokens * p.read : 0)),
    resultTokens: s.resultTokens + tokensOf(resultText),
  }
  if (model) next.mainModel = model
  return next
}

/**
 * The savings estimate of one hand-off.
 * normal = round trips (context x read, per helper call) + result tokens written into the main context
 *          (main write) + helper output at main output price + result tokens x read x later main requests.
 * actual = helper cost + brief tokens x main output + digest tokens x main write
 *          + the hand-off's own main round trip (context x read) + digest tokens x read x later main requests.
 * Undefined when the main model is unknown.
 */
export function savingsOf(s: TierSavingsInputs, helperCostUsd: number | undefined, helperOutputTokens: number): TierSavings | undefined {
  const p = mainPrices(s.mainModel, s.ttl, s.mainContextTokens)
  if (!p) return undefined
  const normal = s.roundTripUsd + s.resultTokens * p.write + helperOutputTokens * p.output + s.resultTokens * p.read * s.laterMainRequests
  const actual =
    (helperCostUsd ?? 0) + s.briefTokens * p.output + s.digestTokens * p.write + (s.handoffRoundTripUsd ?? 0) + s.digestTokens * p.read * s.laterMainRequests
  return {
    normalUsd: round6(normal),
    actualUsd: round6(actual),
    savedUsd: round6(normal - actual),
    tokensKeptOut: Math.max(0, s.resultTokens - s.digestTokens),
  }
}

/** A refusal's cost: one main request re-reading the context. Undefined when unknown. */
export function refusalCostUsd(contextTokens: number | undefined, model: string | undefined, ttl: '1h' | '5m' = '1h'): number | undefined {
  const p = mainPrices(model, ttl, contextTokens)
  if (!p || contextTokens === undefined) return undefined
  return round6(contextTokens * p.read)
}

export function emptyTotals(): TierTotals {
  return { handoffs: 0, running: 0, spentUsd: 0, savedUsd: 0, tokensKeptOut: 0, blocks: 0, blocksUsd: 0, escalations: 0, checkFailed: 0 }
}

export function addTotals(a: TierTotals, b: TierTotals): TierTotals {
  const out = emptyTotals()
  for (const k of Object.keys(out) as (keyof TierTotals)[]) out[k] = round6(a[k] + b[k])
  return out
}

/** Only a finished hand-off with a known cost earns a saving; spent counts every hand-off's cost. */
export function countsSaving(r: Pick<TierHandoff, 'outcome' | 'costUsd'>): boolean {
  return r.outcome === 'done' && r.costUsd !== undefined
}

export function totalsOf(records: readonly TierRecord[]): TierTotals {
  const t = emptyTotals()
  for (const r of records) {
    if (r.kind === 'block') {
      if (r.action === 'would-refuse') continue
      t.blocks++
      t.blocksUsd += r.costUsd ?? 0
      t.savedUsd -= r.costUsd ?? 0
      continue
    }
    t.handoffs++
    if (r.outcome === 'running') t.running++
    if (r.outcome === 'escalated') t.escalations++
    if (r.outcome === 'check failed') t.checkFailed++
    t.spentUsd += r.costUsd ?? 0
    if (countsSaving(r)) {
      t.savedUsd += r.saved?.savedUsd ?? 0
      t.tokensKeptOut += r.saved?.tokensKeptOut ?? 0
    }
  }
  for (const k of ['spentUsd', 'savedUsd', 'blocksUsd'] as const) t[k] = round6(t[k])
  return t
}

// ---------------------------------------------------------------- the hand-off gate

export const BUILTIN_AGENT_TYPES = new Set([
  'general-purpose',
  'Explore',
  'Plan',
  'statusline-setup',
  'claude-code-guide',
  'output-style-setup',
])

/** What an agent definition file pins, as read from its frontmatter. */
export type AgentPins = { model?: string; effort?: string }

/** Reads `model:` and `effort:` from an agent file's frontmatter; `inherit` is no pin. */
export function readAgentPins(fileText: string): AgentPins {
  const m = fileText.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const pins: AgentPins = {}
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = line.match(/^(model|effort)\s*:\s*['"]?([^'"#\s]+)['"]?/)
    if (!kv) continue
    const value = kv[2] ?? ''
    if (!value || value === 'inherit') continue
    if (kv[1] === 'model') pins.model = value
    else pins.effort = value
  }
  return pins
}

export type GateVerdict = { kind: 'pass'; unverifiable?: boolean } | { kind: 'refuse'; reason: string }

/** The example call every refusal names. */
export function exampleCall(helper: 'reader' | 'editor'): string {
  return `Agent(subagent_type "tier-mod:${helper}", model "sonnet", effort "medium", description "[t=<task>] ...")`
}

/** True when model or effort is one the unlock holds back (max effort, the Fable model). */
export function isTopRung(model: string | undefined | null, effort: string | undefined | null): boolean {
  return modelFamily(model) === 'fable' || (effort ?? '').toLowerCase() === 'max'
}

export type UnlockContext = {
  /** This session's hand-offs. */
  handoffs: readonly (Pick<TierHandoff, 'tag' | 'model' | 'outcome'> & { effort?: string })[]
  userAskedMaxOrFable: boolean
  /** Task tags the person allowed max/Fable for, by a press on the screen ("Allow max"); never set by the model. */
  allowedTags?: readonly string[]
}

/** max / Fable: only after an opus/xhigh or opus/max hand-off of the same tag escalated or failed its check this session, or the user asked. */
export function unlockDecide(model: string | undefined | null, effort: string | undefined | null, tag: string | null, ctx: UnlockContext, where = 'this call'): GateVerdict {
  if (!isTopRung(model, effort)) return { kind: 'pass' }
  if (ctx.userAskedMaxOrFable) return { kind: 'pass' }
  if (tag && ctx.allowedTags?.includes(tag)) return { kind: 'pass' }
  const what = modelFamily(model) === 'fable' ? 'the fable model' : 'max effort'
  if (!tag) {
    return { kind: 'refuse', reason: `Tier: ${what} is for escalation only and ${where} has no [t=<task>] tag - tag it, or use opus/low (the user can ask for max/fable).` }
  }
  const failed = ctx.handoffs.some(h => h.tag === tag && modelFamily(h.model) === 'opus' && ['xhigh', 'max'].includes((h.effort ?? '').toLowerCase()) && (h.outcome === 'escalated' || h.outcome === 'check failed'))
  if (failed) return { kind: 'pass' }
  return {
    kind: 'refuse',
    reason: `Tier: ${what} for [t=${tag}] needs an ESCALATE: or failed check from an opus/xhigh or opus/max hand-off of that task this session (none recorded) - climb the ladder first (opus/low -> rewrite the brief -> opus/xhigh); the user can ask for max/fable.`,
  }
}

export type AgentCallFacts = {
  model?: string
  effort?: string
  subagentType?: string
  /** Pins of the agent type's file, when it was found; null when it was looked for and not found. */
  filePins?: AgentPins | null
}

/** The Agent call's gate: model AND effort (call or file pins), then the max/Fable unlock. Fork passes. */
export function gateAgent(c: AgentCallFacts, tag: string | null, ctx: UnlockContext): GateVerdict {
  const type = c.subagentType ?? 'general-purpose'
  if (type === 'fork') return { kind: 'pass' }
  const model = c.model ?? c.filePins?.model
  const effort = c.effort ?? c.filePins?.effort
  let unverifiable = false
  if (!(model && effort)) {
    if (c.filePins === null && !BUILTIN_AGENT_TYPES.has(type)) {
      // A type whose file the mod could not find (another plugin's): fail open, recorded.
      unverifiable = true
    } else {
      const missing = [model ? '' : 'model', effort ? '' : 'effort'].filter(Boolean).join(' and ')
      return {
        kind: 'refuse',
        reason: `Tier: this Agent call names no ${missing} - name both on every call, e.g. ${exampleCall('reader')} (tier-mod:editor for edits).`,
      }
    }
  }
  const unlock = unlockDecide(model, effort, tag, ctx)
  if (unlock.kind === 'refuse') return unlock
  return unverifiable ? { kind: 'pass', unverifiable: true } : { kind: 'pass' }
}

// ---------------------------------------------------------------- workflow scan

/** Index just past the string, template or comment that starts at `i`, or -1 when `i` starts none. */
function skipNonCode(s: string, i: number): number {
  const c = s[i]
  if (c === '/' && s[i + 1] === '/') {
    const nl = s.indexOf('\n', i)
    return nl < 0 ? s.length : nl + 1
  }
  if (c === '/' && s[i + 1] === '*') {
    const e = s.indexOf('*/', i + 2)
    return e < 0 ? s.length : e + 2
  }
  if (c === "'" || c === '"') {
    let j = i + 1
    while (j < s.length && s[j] !== c) {
      if (s[j] === '\\') j++
      else if (s[j] === '\n') break
      j++
    }
    return j + 1
  }
  if (c === '`') {
    let j = i + 1
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\') j += 2
      else if (s[j] === '$' && s[j + 1] === '{') j = scanTo(s, j + 2, '}') + 1
      else j++
    }
    return j + 1
  }
  return -1
}

/** From `i`, the index of `close` at depth 0, skipping strings, comments and nested brackets. */
function scanTo(s: string, i: number, close: string): number {
  const stack: string[] = []
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  let j = i
  while (j < s.length) {
    const skipped = skipNonCode(s, j)
    if (skipped >= 0) {
      j = skipped
      continue
    }
    const c = s[j] as string
    if (stack.length === 0 && c === close) return j
    if (pairs[c]) stack.push(pairs[c] as string)
    else if (c === stack[stack.length - 1]) stack.pop()
    j++
  }
  return s.length
}

/** Splits `s` at top-level commas (strings, comments and brackets respected). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = []
  let from = 0
  let j = 0
  while (j <= s.length) {
    const end = scanTo(s, j, ',')
    parts.push(s.slice(from, end))
    if (end >= s.length) break
    from = j = end + 1
  }
  return parts.map(p => p.trim())
}

/** The value of a literal string ('', "" or a template with no ${}), else null. */
export function literalString(expr: string): string | null {
  const t = expr.trim()
  const m = t.match(/^'((?:[^'\\\n]|\\.)*)'$/) ?? t.match(/^"((?:[^"\\\n]|\\.)*)"$/) ?? t.match(/^`((?:[^`\\$]|\\.|\$(?!\{))*)`$/)
  if (!m) return null
  return (m[1] ?? '').replace(/\\(.)/g, '$1')
}

const SCAN_KEYS = ['model', 'effort', 'agentType'] as const

/**
 * Scans a workflow script's text for every `agent(` call and reads the
 * options object (its second argument) for literal `model`, `effort`,
 * `agentType` and `label`. Missing options or a missing key: 'missing'. A
 * non-literal value, a spread or options that are not an object literal:
 * 'unverifiable'.
 */
export function scanWorkflowScript(script: string): TierScanEntry[] {
  const out: TierScanEntry[] = []
  let j = 0
  while (j < script.length) {
    const skipped = skipNonCode(script, j)
    if (skipped >= 0) {
      j = skipped
      continue
    }
    if (script.startsWith('agent', j) && !/[\w$.]/.test(script[j - 1] ?? '') && !/[\w$]/.test(script[j + 5] ?? '')) {
      let k = j + 5
      while (/\s/.test(script[k] ?? '')) k++
      const before = script.slice(Math.max(0, j - 9), j)
      if (script[k] === '(' && !/function\s*$/.test(before)) {
        const close = scanTo(script, k + 1, ')')
        out.push(readAgentCall(script.slice(k + 1, close), out.length + 1))
        j = k + 1 // keep scanning inside: nested agent() calls in the args count too
        continue
      }
    }
    j++
  }
  return out
}

function readAgentCall(argsText: string, index: number): TierScanEntry {
  const args = splitTopLevel(argsText)
  const opts = args[1]
  const entry: TierScanEntry = { index, label: null, model: null, effort: null, agentType: null, status: 'ok', missing: [] }
  if (opts === undefined || opts === '') {
    entry.status = 'missing'
    entry.missing = [...SCAN_KEYS]
    return entry
  }
  if (!(opts.startsWith('{') && opts.endsWith('}'))) {
    entry.status = 'unverifiable'
    return entry
  }
  let hasSpread = false
  let nonLiteral = false
  const seen: Record<string, string | null> = {}
  for (const prop of splitTopLevel(opts.slice(1, -1))) {
    if (!prop) continue
    if (prop.startsWith('...')) {
      hasSpread = true
      continue
    }
    const colon = scanTo(prop, 0, ':')
    const rawKey = (colon >= prop.length ? prop : prop.slice(0, colon)).trim()
    const key = literalString(rawKey) ?? rawKey
    if (key !== 'label' && !(SCAN_KEYS as readonly string[]).includes(key)) continue
    if (colon >= prop.length) {
      seen[key] = null // shorthand `{ model }`: a variable
      if (key !== 'label') nonLiteral = true
      continue
    }
    const value = literalString(prop.slice(colon + 1))
    seen[key] = value
    if (value === null && key !== 'label') nonLiteral = true
  }
  entry.label = seen.label ?? null
  entry.model = seen.model ?? null
  entry.effort = seen.effort ?? null
  entry.agentType = seen.agentType ?? null
  entry.missing = SCAN_KEYS.filter(k => !(k in seen))
  if (nonLiteral || (entry.missing.length > 0 && hasSpread)) entry.status = 'unverifiable'
  else if (entry.missing.length > 0) entry.status = 'missing'
  return entry
}

/** The gate over a workflow scan: the first refusal, or pass (unverifiable when any entry is). */
export function gateWorkflow(entries: readonly TierScanEntry[], ctx: UnlockContext): GateVerdict {
  let unverifiable = false
  for (const e of entries) {
    const where = `workflow agent() #${e.index}${e.label ? ` (${e.label.slice(0, 40)})` : ''}`
    if (e.status === 'missing') {
      return {
        kind: 'refuse',
        reason: `Tier: ${where} names no ${e.missing.join(', ')} - give every agent() literal options, e.g. agent(prompt, { label: "[t=<task>] ...", model: "sonnet", effort: "medium", agentType: "tier-mod:reader" }).`,
      }
    }
    if (e.status === 'unverifiable') {
      unverifiable = true
      continue
    }
    const unlock = unlockDecide(e.model, e.effort, parseTag(e.label), ctx, where)
    if (unlock.kind === 'refuse') return unlock
  }
  return unverifiable ? { kind: 'pass', unverifiable: true } : { kind: 'pass' }
}

// ---------------------------------------------------------------- the work gate (main loop only)

export type ToolClass = 'exempt' | 'browser' | 'web' | 'bash' | 'read' | 'edit' | 'other'

/**
 * How the work gate treats a tool. PowerShell is a shell like Bash; Monitor is a shell call with a `command`
 * and a web call with a `ws` socket (`args` = the call's input, when known).
 */
export function classifyTool(tool: string, args?: unknown): ToolClass {
  if (tool === 'Monitor' && typeof args === 'object' && args !== null) {
    const a = args as { command?: unknown; ws?: unknown }
    if (a.ws !== undefined && a.ws !== null) return 'web'
    if (typeof a.command === 'string') return 'bash'
  }
  if (
    ['Agent', 'Workflow', 'AskUserQuestion', 'ToolSearch', 'Skill', 'SendMessage'].includes(tool) ||
    tool.startsWith('Task') ||
    tool.startsWith('Artifact') ||
    tool.startsWith('mcp__ccd_') ||
    tool.startsWith('mcp__tier-mod__')
  ) {
    return 'exempt'
  }
  if (tool.startsWith('mcp__Claude_Browser__') || tool.startsWith('mcp__claude-in-chrome__')) return 'browser'
  if (tool === 'WebSearch' || tool === 'WebFetch' || tool.startsWith('mcp__exa__')) return 'web'
  if (tool === 'Bash' || tool === 'PowerShell') return 'bash'
  if (tool === 'Read') return 'read'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'edit'
  if (isWebToolName(tool)) return 'web'
  return 'other'
}

/** The MCP servers known to reach the web (prefixes of their tool names, lower case). */
export const WEB_MCP_PREFIXES = [
  'mcp__exa__',
  'mcp__claude_ai_exa__',
  'mcp__firecrawl__',
  'mcp__fetch__',
  'mcp__brave__',
  'mcp__brave-search__',
  'mcp__tavily__',
  'mcp__perplexity__',
] as const

/**
 * Another tool that reaches the web: a known web MCP server's, or one named web_search / web_fetch.
 * Narrow on purpose: a local search (a connector registry, search_files) is not a web call.
 */
export function isWebToolName(tool: string): boolean {
  const t = tool.toLowerCase()
  return WEB_MCP_PREFIXES.some(p => t.startsWith(p)) || /web_search|web_fetch/.test(t)
}

/** Where one shell command starts inside another (the fallback when a quote never closes). */
const COMMAND_SPLIT = /&&|\|\||[;&|\n\r`(){}]|\$\(/

/** A heredoc or here-string body, and the index of the command segment that feeds it. */
export type ShellBody = { segment: number; text: string }

/**
 * Splits a shell command at its command boundaries (; && || | & newline ` $( ( ) { }) outside quotes,
 * heredoc bodies and PowerShell here-strings; a `$(...)` or backtick inside double quotes is its own segment.
 * Null when a quote or here-string never closes (the caller falls back to a plain split, failing closed).
 */
export function splitShell(c: string, depth = 0): { segments: string[]; bodies: ShellBody[] } | null {
  const segments: string[] = []
  const bodies: ShellBody[] = []
  const inner: string[] = []
  const pending: { term: string; strip: boolean }[] = []
  let cur = ''
  const push = () => {
    segments.push(cur)
    cur = ''
  }
  let i = 0
  while (i < c.length) {
    const ch = c[i] as string
    if (ch === '\\' && i + 1 < c.length && c[i + 1] !== '\n') {
      cur += ch + c[i + 1]
      i += 2
      continue
    }
    if (ch === "'") {
      const j = c.indexOf("'", i + 1)
      if (j < 0) return null
      cur += c.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < c.length && c[j] !== '"') {
        if (c[j] === '\\') j += 2
        else if (c.startsWith('$(', j)) {
          let d = 1
          let k = j + 2
          while (k < c.length && d > 0) {
            if (c[k] === '(') d++
            else if (c[k] === ')') d--
            k++
          }
          inner.push(c.slice(j + 2, k - 1))
          j = k
        } else if (c[j] === '`') {
          const k = c.indexOf('`', j + 1)
          const close = c.indexOf('"', j + 1)
          if (k > 0 && (close < 0 || k < close)) {
            inner.push(c.slice(j + 1, k))
            j = k + 1
          } else j++
        } else j++
      }
      if (j >= c.length) return null
      cur += c.slice(i, j + 1)
      i = j + 1
      continue
    }
    // PowerShell here-string: @' or @" at a line end, closed by '@ or "@ at a line start.
    const here = /^@(['"])\r?\n/.exec(c.slice(i, i + 4))
    if (here) {
      const q = here[1] as string
      const open = i + here[0].length
      const m = new RegExp(`\\r?\\n${q}@`).exec(c.slice(open))
      if (!m) return null
      bodies.push({ segment: segments.length, text: c.slice(open, open + m.index) })
      cur += '@here'
      i = open + m.index + m[0].length
      continue
    }
    const doc = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/.exec(c.slice(i))
    if (doc) {
      pending.push({ term: doc[3] as string, strip: doc[1] === '-' })
      cur += doc[0]
      i += doc[0].length
      continue
    }
    if (ch === '\n' || ch === '\r') {
      push()
      i++
      if (ch === '\r' && c[i] === '\n') i++
      if (ch === '\n' || c[i - 1] === '\n') {
        // heredoc bodies start on the next line
        for (const p of pending) {
          const owner = segments.length - 1
          const lines: string[] = []
          for (;;) {
            if (i >= c.length) break
            const nl = c.indexOf('\n', i)
            const line = (nl < 0 ? c.slice(i) : c.slice(i, nl)).replace(/\r$/, '')
            i = nl < 0 ? c.length : nl + 1
            if ((p.strip ? line.replace(/^\t+/, '') : line) === p.term) break
            lines.push(line)
          }
          bodies.push({ segment: owner, text: lines.join('\n') })
        }
        pending.length = 0
      }
      continue
    }
    const two = c.slice(i, i + 2)
    if (two === '&&' || two === '||' || two === '$(') {
      push()
      i += 2
      continue
    }
    if (ch === '&' && (c[i - 1] === '>' || c[i - 1] === '<' || c[i + 1] === '>')) {
      cur += ch // 2>&1, &> file: a redirection, not a boundary
      i++
      continue
    }
    if (';&|`(){}'.includes(ch)) {
      push()
      i++
      continue
    }
    cur += ch
    i++
  }
  push()
  for (const p of pending) bodies.push({ segment: segments.length - 1, text: '' })
  if (depth < 3) {
    for (const t of inner) {
      const sub = splitShell(t, depth + 1)
      for (const s of sub?.segments ?? t.split(COMMAND_SPLIT)) segments.push(s)
    }
  }
  return { segments, bodies }
}

/** The first word of a command with any directory in front of it stripped: /usr/bin/curl -> curl. */
function stripCommandPath(s: string): string {
  return s.replace(/^(?:[A-Za-z]:)?[^\s"']*[\\/](?=[^\s\\/]+(\s|$))/, '')
}

/**
 * One command, with what may lead it stripped: quotes, PowerShell's `&`, env and PowerShell assignments,
 * control keywords, sudo/exec/command/time/env/xargs/wsl/Start-Process/Invoke-Command/ForEach-Object/%,
 * and a directory in front of the command.
 */
function commandHead(segment: string): string {
  let s = segment.replace(/^[\s"'{}()!&]+/, '')
  for (;;) {
    const next = stripCommandPath(
      s
        .replace(/^(\$env:)?[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, '')
        .replace(/^\$[\w:]+\s*=\s*/, '')
        .replace(/^(if|elif|then|else|do|while|until|try|finally|foreach|for|in)(\s+|$)/i, '')
        .replace(/^(sudo|exec|command|time|nohup|env|xargs|wsl|start-process|start|invoke-command|foreach-object|%)(\.exe)?((\s+-{1,2}\S+)*)(\s+|$)/i, '')
        .replace(/^[\s"'{}()!&]+/, ''),
    )
    if (next === s) return s
    s = next
  }
}

const WEB_HEAD = [
  /^(curl|wget|iwr|irm|http|https|xh|aria2c)(\.exe)?(\s|$)/i,
  /^(Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)(\s|$)/i,
  /^((npx|bunx|pnpx)(\.cmd)?|pnpm\s+dlx|yarn\s+dlx)\s+(-{1,2}\S+\s+)*ctx7(@\S*)?(\s|$)/i,
  /^ctx7(\.cmd)?(\s|$)/i,
  /^gh(\.exe)?\s+api(\s|$)/i,
]

/** A shell that runs a string: powershell -c / -Command (after flags that may take a value), pwsh, cmd /c, bash/sh -c or -lc. */
const SHELL_WRAP = /^(powershell|pwsh|cmd|bash|sh|zsh)(\.exe)?\s+((-{1,2}|\/)\S+(\s+[^-/\s]\S*)?\s+)*?(-[a-z]*c|-command|\/c|\/k)\s+/i

/** A shell's name at the head of a command (a heredoc fed to it is a script it runs). */
const SHELL_HEAD = /^(powershell|pwsh|cmd|bash|sh|zsh)(\.exe)?(\s|$)/i

/** The string a wrapper shell runs: the quoted argument's content, or the rest as is. */
function unwrapArg(rest: string): string {
  const r = rest.trim()
  const q = r[0]
  if (q !== '"' && q !== "'") return r
  let j = 1
  while (j < r.length && r[j] !== q) j += q === '"' && r[j] === '\\' ? 2 : 1
  return r.slice(1, j)
}

/** A one-liner that fetches through an interpreter: node/deno/bun -e, python -c. */
function isFetchOneLiner(c: string): boolean {
  const js =
    /\b(node|deno|bun)(\.exe)?\s+(\S+\s+)*?(-e|--eval|-p|--print)\b/i.test(c) &&
    /\bfetch\s*\(|\bhttps?\.(get|request)\s*\(|require\(\s*['"](node:)?https?['"]\s*\)|axios|XMLHttpRequest/i.test(c)
  const py = /\b(python3?|py)(\.exe)?\s+(\S+\s+)*?-c\b/i.test(c) && /urllib|urlopen|\brequests\b|http\.client|httpx|aiohttp/i.test(c)
  return js || py
}

/**
 * A shell command that fetches from the web: curl, wget, Invoke-WebRequest, Invoke-RestMethod, iwr, irm,
 * npx ctx7, gh api - at any command boundary outside quotes and heredoc bodies, after env/PowerShell
 * assignments, control keywords, passthroughs (xargs, wsl, Start-Process...) and a directory prefix,
 * inside powershell/pwsh/cmd/bash -c (or a heredoc fed to a shell); and node/python fetch one-liners.
 */
export function isWebCommand(command: string | undefined | null, depth = 0): boolean {
  const c = command ?? ''
  if (!c.trim()) return false
  if (isFetchOneLiner(c)) return true
  const split = splitShell(c)
  const segments = split?.segments ?? c.split(COMMAND_SPLIT)
  for (const segment of segments) {
    const head = commandHead(segment)
    if (WEB_HEAD.some(re => re.test(head))) return true
    const wrapped = head.match(SHELL_WRAP)
    if (wrapped && depth < 3 && isWebCommand(unwrapArg(head.slice(wrapped[0].length)), depth + 1)) return true
  }
  for (const b of split?.bodies ?? []) {
    if (depth < 3 && SHELL_HEAD.test(commandHead(segments[b.segment] ?? '')) && isWebCommand(b.text, depth + 1)) return true
  }
  return false
}

// ---------------------------------------------------------------- shell writes (count toward the files-edited limit)

type ShellWord = { w: string; op?: boolean; unclear?: boolean }

/** A command segment's words, quotes removed; redirection operators (> >> 2> &>) are words of their own. */
function shellWords(seg: string): ShellWord[] {
  const out: ShellWord[] = []
  let i = 0
  while (i < seg.length) {
    while (i < seg.length && /\s/.test(seg[i] as string)) i++
    if (i >= seg.length) break
    const op = /^(\d|&)?>>?\|?/.exec(seg.slice(i))
    if (op && seg[i + op[0].length] !== '(') {
      out.push({ w: op[0], op: true })
      i += op[0].length
      continue
    }
    let w = ''
    let unclear = false
    while (i < seg.length && !/\s/.test(seg[i] as string)) {
      const ch = seg[i] as string
      if (ch === '>' ) break
      if (ch === "'") {
        const j = seg.indexOf("'", i + 1)
        const end = j < 0 ? seg.length : j
        w += seg.slice(i + 1, end)
        i = end + 1
        continue
      }
      if (ch === '"') {
        let j = i + 1
        while (j < seg.length && seg[j] !== '"') {
          if (seg[j] === '$' || seg[j] === '`') unclear = true
          j++
        }
        w += seg.slice(i + 1, j)
        i = j + 1
        continue
      }
      if (ch === '$' || ch === '`' || ch === '*' || ch === '?' || ch === '%' || ch === '@') unclear = true
      w += ch
      i++
    }
    out.push(unclear ? { w, unclear } : { w })
  }
  return out
}

const NULL_DEVICES = new Set(['/dev/null', 'nul', 'nul:', '$null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'con'])

/** PowerShell switches that take no value (others do), for finding a cmdlet's positional arguments. */
const PS_SWITCH = /^-(force|nonewline|append|noclobber|passthru|whatif|confirm|asbytestream|recurse|container|verbose|debug)$/i

/** A cmdlet's named argument (`-Path x`) or its nth positional one. */
function psArg(words: ShellWord[], names: RegExp, nth: number): ShellWord | undefined {
  let pos = 0
  for (let k = 0; k < words.length; k++) {
    const x = words[k] as ShellWord
    if (x.op) {
      k++
      continue
    }
    if (x.w.startsWith('-')) {
      const [name, inline] = x.w.split(':', 2) as [string, string | undefined]
      if (names.test(name)) return inline !== undefined ? { w: inline } : words[k + 1]
      if (inline === undefined && !PS_SWITCH.test(name)) k++
      continue
    }
    if (pos++ === nth) return x
  }
  return undefined
}

/** Positional (non-flag, non-redirection) words; `valued` flags consume the word after them. */
function positionals(words: ShellWord[], valued: RegExp = /^$/): ShellWord[] {
  const out: ShellWord[] = []
  for (let k = 0; k < words.length; k++) {
    const x = words[k] as ShellWord
    if (x.op) {
      k++
      continue
    }
    if (x.w.startsWith('-') && x.w.length > 1) {
      if (valued.test(x.w)) k++
      continue
    }
    out.push(x)
  }
  return out
}

/**
 * Files a shell command writes, where the target is clear: > and >> (not the null device or an fd), tee,
 * sed -i, perl -pi, Set-Content/Add-Content/Out-File, cp/mv/Copy-Item/Move-Item destinations (a heredoc to a
 * file is a redirection). `bodyLines` = the longest heredoc/here-string or Set-Content body when it writes one.
 * Paths come back as written (callers normalize); an unclear target ($VAR, a glob) is left out.
 */
export function shellWrites(command: string | undefined | null): { files: string[]; bodyLines: number } {
  const c = command ?? ''
  const split = splitShell(c)
  if (!c.trim() || !split) return { files: [], bodyLines: 0 }
  const files: string[] = []
  let bodyLines = 0
  const add = (x: ShellWord | undefined) => {
    if (!x || x.unclear || !x.w || x.w.startsWith('&') || x.w.startsWith('-')) return
    if (NULL_DEVICES.has(x.w.toLowerCase())) return
    files.push(x.w)
  }
  split.segments.forEach((seg, idx) => {
    const all = shellWords(seg)
    const before = files.length
    for (let k = 0; k < all.length; k++) if (all[k]?.op) add(all[k + 1])
    // the command: skip assignments and passthroughs
    let h = 0
    while (h < all.length && !all[h]?.op && /^([A-Za-z_]\w*=|\$[\w:]+$|=$|sudo$|env$|command$|exec$|nohup$|time$|&$)/i.test(all[h]?.w ?? '')) h++
    const name = stripCommandPath(all[h]?.w ?? '').toLowerCase().replace(/\.exe$/, '')
    const args = all.slice(h + 1)
    if (name === 'tee' || name === 'tee-object') {
      if (name === 'tee') positionals(args).forEach(add)
      else add(psArg(args, /^-(filepath|path|literalpath)$/i, 0))
    } else if (name === 'sed' && args.some(x => !x.op && (/^-[a-hj-zA-Z]*i/.test(x.w) || x.w.startsWith('--in-place')))) {
      const hasScript = args.some(x => /^(-e|-f|--expression|--file)/.test(x.w))
      const pos = positionals(args, /^(-e|-f|--expression|--file)$/)
      ;(hasScript ? pos : pos.slice(1)).forEach(add)
    } else if (name === 'perl' && args.some(x => !x.op && /^-[a-zA-Z]*i/.test(x.w))) {
      const pos = positionals(args, /^-[a-zA-Z.]*[eE]$/)
      const hasScript = args.some(x => /^-[a-zA-Z.]*[eE]$/.test(x.w))
      ;(hasScript ? pos : pos.slice(1)).forEach(add)
    } else if (name === 'set-content' || name === 'add-content' || name === 'out-file') {
      add(psArg(args, /^-(path|filepath|literalpath|pspath|lp)$/i, 0))
      if (files.length > before) bodyLines = Math.max(bodyLines, countLines(seg))
    } else if (name === 'copy-item' || name === 'move-item' || name === 'cpi' || name === 'mi') {
      add(psArg(args, /^-(destination|dest)$/i, 1))
    } else if (name === 'cp' || name === 'mv' || name === 'copy' || name === 'move') {
      const t = args.find(x => /^--target-directory=/.test(x.w))
      const ti = args.findIndex(x => x.w === '-t')
      if (t) add({ w: t.w.slice('--target-directory='.length) })
      else if (ti >= 0) add(args[ti + 1])
      else {
        const pos = positionals(args)
        if (pos.length >= 2) add(pos[pos.length - 1])
      }
    }
    if (files.length > before) for (const b of split.bodies) if (b.segment === idx || b.segment === idx - 1) bodyLines = Math.max(bodyLines, countLines(b.text))
  })
  return { files, bodyLines }
}

/** A scratch path: an OS temp folder or the session scratchpad (which lives under one). */
export function isScratchPath(p: string): boolean {
  const f = normPath(p)
  return f.includes('/appdata/local/temp/') || f.startsWith('/tmp/') || f.includes('/tmp/')
}

/** A write (shell, Write, Edit or NotebookEdit) the files-edited limit skips: Claude's own memory/plan files, the session scratchpad, OS temp folders. */
export function isExemptShellTarget(p: string): boolean {
  return isClaudeOwnFile(p) || isScratchPath(p)
}

/** The files a call edits that count toward the limit (normalized): an Edit/Write's file, or a shell command's clear write targets. */
export function editTargets(call: WorkCall): string[] {
  const cls = classifyTool(call.tool, call.ws ? { ws: true } : call.command !== undefined ? { command: call.command } : undefined)
  if (cls === 'edit') {
    const file = normPath(call.filePath ?? '')
    return file && !isExemptShellTarget(file) ? [file] : []
  }
  if (cls === 'bash') return [...new Set(shellWrites(call.command).files.filter(f => !isExemptShellTarget(f)).map(normPath))]
  return []
}

// ---------------------------------------------------------------- the person's own words

/**
 * The words the person typed themself: pasted blocks (<pasted_content> tags, [Pasted text ...] placeholders),
 * fenced code, quoted lines starting with >, and double-quoted spans are dropped.
 */
export function ownWords(text: string): string {
  return text
    .replace(/<pasted_content\b[^>]*>[\s\S]*?(<\/pasted_content>|$)/gi, ' ')
    .replace(/\[Pasted text[^\]]*\]/gi, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
}

/** A negation (don't, do not, never, not, no) within the 3 words before `index`. */
function negatedAt(text: string, index: number): boolean {
  const words = text.slice(0, index).split(/\s+/).filter(Boolean).slice(-3).join(' ')
  return /\b(don['’]?t|do\s+not|never|not|no)\b/i.test(words)
}

/** A match of `re` (global) in the person's own words that no negation precedes. */
function ownAsk(text: string, re: RegExp): boolean {
  const t = ownWords(text)
  for (const m of t.matchAll(re)) if (!negatedAt(t, m.index ?? 0)) return true
  return false
}

/** The user's own words lifting the work gate for this message. */
export function asksOverride(text: string): boolean {
  return ownAsk(text, /do it yourself/gi)
}

/** True when the person's own message asks for max effort or the Fable model. */
export function userAsksMaxOrFable(text: string): boolean {
  return ownAsk(text, /\bfable\b|\b(max(imum)?[\s-]+effort|effort[\s:=]+max|(opus|sonnet|haiku)\s*\/\s*max)\b/gi)
}

/**
 * The counters of a new user message. `folded` (typed into a running turn) keeps the running message's lifts.
 * The person's own presses carry over: `carryOverride` ("Do it myself" pressed while no turn ran) lifts the work
 * gate for this message and is spent; `allowMaxTags` ("Allow max") stand for the session.
 */
export function freshGate(text = '', previous?: TierGate, folded = false): TierGate {
  const override = asksOverride(text) || previous?.carryOverride === true
  const asks = userAsksMaxOrFable(text)
  const gate: TierGate = {
    readTokens: 0,
    editFiles: [],
    override: folded ? (previous?.override ?? false) || override : override,
    userAskedMaxOrFable: folded ? (previous?.userAskedMaxOrFable ?? false) || asks : asks,
  }
  if (previous?.allowMaxTags && previous.allowMaxTags.length > 0) gate.allowMaxTags = [...previous.allowMaxTags]
  return gate
}

/** `8K` for 8000. */
export function kTokens(n: number): string {
  return n >= 1000 && n % 1000 === 0 ? `${n / 1000}K` : String(n)
}

export function limitsText(s: Pick<TierSettings, 'readTokens' | 'editFiles'>): string {
  return `Limits: web always, ${kTokens(s.readTokens)} tokens reading, ${s.editFiles} files editing per message. The user can say "do it yourself".`
}

export type WorkVerdict =
  | { kind: 'pass' }
  | { kind: 'refuse'; gate: 'web' | 'read' | 'edit'; reason: string; toast: string; newFile?: string }

export type WorkCall = {
  tool: string
  command?: string
  filePath?: string
  hasRange?: boolean
  content?: string
  /** A Monitor call that opens a WebSocket. */
  ws?: boolean
}

/**
 * The work gate before the tool runs. `fileLines` is the line count of a Read's file
 * (undefined when unknown or not a Read). `gate.override` lifts it.
 */
export function workBefore(call: WorkCall, gate: TierGate, settings: Pick<TierSettings, 'readTokens' | 'readLines' | 'editFiles'>, fileLines?: number): WorkVerdict {
  if (gate.override) return { kind: 'pass' }
  const cls = classifyTool(call.tool, call.ws ? { ws: true } : call.command !== undefined ? { command: call.command } : undefined)
  const limits = limitsText(settings)
  const handReader = `hand this to a helper - ${exampleCall('reader')}. ${limits}`
  const handEditor = `hand this to a helper - ${exampleCall('editor')}. ${limits}`
  if (cls === 'web' || (cls === 'bash' && isWebCommand(call.command))) {
    const what = cls === 'web' ? (call.tool === 'WebFetch' ? 'a web fetch' : call.tool === 'Monitor' ? 'a web socket' : 'a web search') : 'a web command'
    return { kind: 'refuse', gate: 'web', reason: `Tier: ${handReader}`, toast: `Tier handed off ${what} - say "do it yourself" to skip` }
  }
  if (cls === 'read' && !call.hasRange && fileLines !== undefined && fileLines >= settings.readLines) {
    return {
      kind: 'refuse',
      gate: 'read',
      reason: `Tier: that file has ${fileLines} lines (limit ${settings.readLines}) - read a range (offset/limit), or ${handReader}`,
      toast: `Tier handed off a ${fileLines}-line read - say "do it yourself" to skip`,
    }
  }
  if (cls === 'bash') {
    const w = shellWrites(call.command)
    const targets = editTargets(call)
    if (targets.length > 0 && w.bodyLines > WRITE_MAX_LINES) {
      return {
        kind: 'refuse',
        gate: 'edit',
        reason: `Tier: a shell write of ${w.bodyLines} lines (over ${WRITE_MAX_LINES}) - ${handEditor}`,
        toast: `Tier handed off a ${w.bodyLines}-line write - say "do it yourself" to skip`,
      }
    }
    const fresh = targets.filter(f => !gate.editFiles.includes(f))
    if (fresh.length > 0 && gate.editFiles.length + fresh.length > settings.editFiles) {
      const n = gate.editFiles.length + fresh.length
      return {
        kind: 'refuse',
        gate: 'edit',
        reason: `Tier: file ${n} to edit this message (limit ${settings.editFiles}) - ${handEditor}`,
        toast: `Tier handed off edits to a ${ordinal(n)} file - say "do it yourself" to skip`,
      }
    }
    return { kind: 'pass' }
  }
  if (cls === 'edit') {
    if (call.tool === 'Write' && call.content !== undefined && !isScratchPath(call.filePath ?? '')) {
      const lines = countLines(call.content)
      if (lines > WRITE_MAX_LINES) {
        return {
          kind: 'refuse',
          gate: 'edit',
          reason: `Tier: a Write of ${lines} lines (over ${WRITE_MAX_LINES}) - ${handEditor}`,
          toast: `Tier handed off a ${lines}-line write - say "do it yourself" to skip`,
        }
      }
    }
    const file = normPath(call.filePath ?? '')
    if (file && !isExemptShellTarget(file) && !gate.editFiles.includes(file)) {
      if (gate.editFiles.length >= settings.editFiles) {
        return {
          kind: 'refuse',
          gate: 'edit',
          reason: `Tier: file ${gate.editFiles.length + 1} to edit this message (limit ${settings.editFiles}) - ${handEditor}`,
          toast: `Tier handed off edits to a ${ordinal(gate.editFiles.length + 1)} file - say "do it yourself" to skip`,
        }
      }
      return { kind: 'pass' }
    }
  }
  return { kind: 'pass' }
}

/** After the tool ran: does this result count, and is it withheld? */
export function workAfter(
  tool: string,
  isReadOnly: boolean,
  resultTokens: number,
  gate: TierGate,
  settings: Pick<TierSettings, 'readTokens' | 'editFiles'>,
): { counts: boolean; withhold?: { reason: string; toast: string } } {
  const cls = classifyTool(tool)
  if (cls === 'exempt') return { counts: false }
  // Only output the gate can withhold counts toward the allowance: not a command's (side effects), not a browser's.
  if (cls === 'browser' || !isReadOnly) return { counts: false }
  if (gate.override) return { counts: true }
  if (gate.readTokens + resultTokens <= settings.readTokens) return { counts: true }
  return {
    counts: false,
    withhold: {
      reason: `Tier: this message's reading allowance (${kTokens(settings.readTokens)} tokens) is used up - hand this to a helper - ${exampleCall('reader')}. ${limitsText(settings)}`,
      toast: `Tier held back a ${kTokens(resultTokens)}-token result (reading allowance used) - say "do it yourself" to skip`,
    },
  }
}

function ordinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`
}

/**
 * Claude's own memory and plan files (~/.claude/projects/<project>/memory/..., ~/.claude/plans/...):
 * the session keeps them itself, so they never count against the files-edited allowance.
 */
export function isClaudeOwnFile(p: string): boolean {
  const f = normPath(p)
  return /\/\.claude\/projects\/[^/]+\/memory\//.test(f) || /\/\.claude\/plans\//.test(f)
}

export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

export function countLines(text: string): number {
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

/** Files Read may show as images/documents: the line rule does not apply. */
export function isLineFile(path: string): boolean {
  return !/\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb)$/i.test(path)
}

// ---------------------------------------------------------------- checks inside the hand-off

const CHECK_HEAD = [
  /^(npm|pnpm|yarn|bun)(\.cmd)?\s+(-{1,2}\S+\s+)*(run\s+)?(test|build|lint|typecheck|type-check|check|tsc)(:\S*)?(\s|$)/i,
  /^(npx|pnpx|bunx)(\.cmd)?\s+(-{1,2}\S+\s+)*(tsc|eslint|vitest|jest|pytest)(\s|$)/i,
  /^(pytest|tsc|eslint|ruff|mypy|vitest|jest)(\.exe|\.cmd)?(\s|$)/i,
  /^(python3?|py)(\.exe)?\s+-m\s+(pytest|mypy|unittest)(\s|$)/i,
  /^node(\.exe)?\s+\S*tsc(\.js)?["']?(\s|$)/i,
  /^cargo(\.exe)?\s+(test|build|check|clippy)(\s|$)/i,
  /^go(\.exe)?\s+(test|build|vet)(\s|$)/i,
  /^make\s+(test|check)(\s|$)/i,
  /^dotnet(\.exe)?\s+(test|build)(\s|$)/i,
  /^(claude(\.exe|\.cmd)?|\$\{?CLAUDE_CODE_EXECPATH\}?|\$env:CLAUDE_CODE_EXECPATH)["']?\s+plugin\s+test(\s|$)/i,
  /^(gradle|gradlew|mvn|mvnw)(\.bat|\.cmd)?\s+(\S+\s+)*?(test|build|check|verify)(\s|$)/i,
]

/**
 * A real check - tests, a build, a linter, a type check (npm/pnpm/yarn/bun test|run build|lint, pytest, cargo,
 * go, tsc, make test, `plugin test`, dotnet, gradle/mvn) - anywhere in the command. A grep is never one.
 */
export function isCheckCommand(command: string | undefined | null): boolean {
  const c = command ?? ''
  const segments = splitShell(c)?.segments ?? c.split(COMMAND_SPLIT)
  return segments.some(s => CHECK_HEAD.some(re => re.test(commandHead(s))))
}

/** Exit code of a Bash result: 0 unless errored; the "Exit code N" header gives N. */
export function exitCodeOf(r: { isError?: boolean; text?: string; result?: unknown }): number {
  const m = (r.text ?? '').match(/Exit code (\d+)/)
  if (m) return Number(m[1])
  if (r.isError) return 1
  if ((r.result as { interrupted?: boolean } | undefined)?.interrupted === true) return 1
  return 0
}

// ---------------------------------------------------------------- escalation (ladder)

export function isEscalate(answer: string | undefined | null): boolean {
  return (answer ?? '').trimStart().startsWith('ESCALATE:')
}

/** The failure's signature for "same failure on two rungs": the ESCALATE: first line, or `<command> exit <n>`. */
export function failureSignature(kind: 'escalated' | 'check failed', answer: string, lastCommand?: string, lastExit?: number): string {
  if (kind === 'escalated') return (answer.trimStart().split('\n')[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return `${lastCommand ?? '?'} exit ${lastExit ?? '?'}`
}

/**
 * The next rung after a failure at model/effort:
 * haiku -> sonnet/high -> opus/low -> rewrite the brief -> opus/xhigh -> opus/max (fable/high on plans with Fable) -> stop.
 * `earlier` = this tag's earlier failed hand-offs this session.
 */
export function nextRung(
  model: string | undefined | null,
  effort: string | undefined | null,
  signature: string,
  earlier: readonly { model: string; effort: string; failure?: string }[],
): string {
  const fam = modelFamily(model)
  const eff = (effort ?? '').toLowerCase()
  const sameFailureBelow = earlier.some(e => e.failure === signature && !(modelFamily(e.model) === fam && e.effort === effort))
  if ((fam === 'haiku' || fam === 'sonnet' || fam === null) && sameFailureBelow) return 'opus/low (the same failure on two rungs)'
  if (fam === 'haiku') return 'sonnet/high'
  if (fam === 'sonnet') return 'opus/low'
  if (fam === 'opus') {
    if (eff === 'max') return 'stop and report to the user'
    if (eff === 'xhigh') return 'opus/max (fable/high on plans with Fable)'
    const opusFailedBefore = earlier.some(e => modelFamily(e.model) === 'opus' && !['xhigh', 'max'].includes(e.effort))
    return opusFailedBefore ? 'opus/xhigh' : 'rewrite the brief, then opus/low again'
  }
  if (fam === 'fable') return 'stop and report to the user'
  return 'opus/low'
}

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}...` : t
}

/** The `[tier]` note on the Agent/Workflow result after an ESCALATE: answer or a failed check. */
export function escalationNote(h: Pick<TierHandoff, 'tag' | 'try' | 'model' | 'effort' | 'lastCommand' | 'lastExit'>, kind: 'escalated' | 'check failed', next: string, output: string): string {
  const at = `${modelFamily(h.model) ?? h.model}/${h.effort}`
  const who = h.tag ? `[t=${h.tag}] try ${h.try}` : 'this untagged hand-off'
  const what = kind === 'escalated' ? 'replied ESCALATE:' : `failed its check (${h.lastCommand ?? '?'} - exit ${h.lastExit ?? '?'})`
  const keep = h.tag ? ` Keep the tag [t=${h.tag}].` : ' Tag the retry [t=<task>].'
  return (
    `[tier] ${who} on ${at} ${what}. Next rung: ${next}.${keep}` +
    (output ? ` Give it this failure output: "${clip(output, 400)}".` : '') +
    ' A rate limit or tool error is no escalation: retry the same rung.'
  )
}

// ---------------------------------------------------------------- facts (spec 1)

/** Finds the `<!-- tier-rule vX.Y.Z -->` tag in a CLAUDE.md text. */
export function findRuleTag(text: string): string | null {
  const m = text.match(/<!--\s*tier-rule\s+v([0-9][0-9.]*)\s*-->/)
  return m ? (m[1] ?? null) : null
}

/** Compares dotted versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// ---------------------------------------------------------------- ledger storage

export function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

/** One $.store key per record: `rec:<day>:<sessionId>:<id>` (append-only, no shared array). */
export const RECORD_PREFIX = 'rec:'
/** All rolled-up days in one key: Record<day, TierDaySummary>. */
export const SUMMARY_KEY = 'ledger:summary'
export const KEEP_DETAIL_DAYS = 30
/** Detail is rolled up past this many bytes of JSON in all, oldest day first. 3 MiB leaves headroom under the store's 4 MiB cap. */
export const STORE_BUDGET_BYTES = 3 * 1024 * 1024

export function recordKey(r: Pick<TierRecord, 'day' | 'sessionId' | 'id'>): string {
  return `${RECORD_PREFIX}${r.day}:${r.sessionId}:${r.id}`
}

/** The day of a record key, or null for another key. */
export function dayOfKey(key: string): string | null {
  if (!key.startsWith(RECORD_PREFIX)) return null
  const day = key.slice(RECORD_PREFIX.length, RECORD_PREFIX.length + 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

export function summarizeDay(day: string, records: readonly TierRecord[], into?: TierDaySummary): TierDaySummary {
  const t = addTotals(into ?? emptyTotals(), totalsOf(records))
  const s: TierDaySummary = { ...t, day, byModel: { ...(into?.byModel ?? {}) }, byTag: { ...(into?.byTag ?? {}) } }
  for (const r of records) {
    if (r.kind !== 'handoff') continue
    const key = `${modelFamily(r.model) ?? r.model}/${r.effort}`
    const m = (s.byModel[key] = { ...(s.byModel[key] ?? { count: 0, usd: 0 }) })
    m.count++
    m.usd = round6(m.usd + (r.costUsd ?? 0))
    const tag = r.tag ?? '(untagged)'
    const g = (s.byTag[tag] = { ...(s.byTag[tag] ?? { count: 0, usd: 0 }) })
    g.count++
    g.usd = round6(g.usd + (r.costUsd ?? 0))
  }
  return s
}

/** Which detail days to roll: older than 30 days, then oldest first while over the byte budget. */
export function daysToRoll(dayKeys: readonly string[], today: string, sizes: Readonly<Record<string, number>>, budget = STORE_BUDGET_BYTES): string[] {
  const cutoff = shiftDay(today, -KEEP_DETAIL_DAYS)
  const sorted = [...new Set(dayKeys)].sort()
  const roll = new Set(sorted.filter(d => d < cutoff))
  let total = Object.values(sizes).reduce((a, b) => a + b, 0)
  for (const d of roll) total -= sizes[d] ?? 0
  for (const d of sorted) {
    if (total <= budget) break
    if (roll.has(d) || d === today) continue
    roll.add(d)
    total -= sizes[d] ?? 0
  }
  return [...roll].sort()
}

// ---------------------------------------------------------------- install

/**
 * Finds the older Tier shell hooks in one settings object (read only, never written): pin-enforcer /
 * statusline-cache commands under `hooks`. The statusLine is never flagged (it may wrap another line).
 */
export function findOldTierHooks(settings: unknown): string[] {
  const found: string[] = []
  if (!settings || typeof settings !== 'object') return found
  const hooks = (settings as Record<string, unknown>).hooks
  if (!hooks || typeof hooks !== 'object') return found
  const scriptIn = (command: unknown): string | undefined =>
    typeof command === 'string' ? ['pin-enforcer', 'statusline-cache'].find(name => command.includes(name)) : undefined
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    const names = new Set<string>()
    for (const group of groups) {
      const list = group && typeof group === 'object' ? (group as { hooks?: unknown }).hooks : undefined
      if (!Array.isArray(list)) continue
      for (const h of list) {
        const name = h && typeof h === 'object' ? scriptIn((h as { command?: unknown }).command) : undefined
        if (name) names.add(name)
      }
    }
    for (const name of names) found.push(`hooks.${event} (${name})`)
  }
  return found
}

/** The one-time notice text for older Tier hooks found in settings files (never edited by the mod). */
export function oldHooksNotice(bySource: readonly { source: string; entries: readonly string[] }[]): string | null {
  const parts = bySource.filter(b => b.entries.length > 0).map(b => `${b.source} settings: ${b.entries.join(', ')}`)
  if (parts.length === 0) return null
  return (
    `Older Tier shell hooks are still installed (${parts.join('; ')}). They double up with this mod's gates. ` +
    'The mod never edits settings: remove those entries from settings.json yourself, or ask Claude to remove them.'
  )
}

