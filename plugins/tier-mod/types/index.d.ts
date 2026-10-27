// tier-mod's contract: the $.state values it keeps for the session.
// The core hooks (register.tsx) write them; the screen (part2.tsx) reads them.
// Every atom lives under the plugin 'tier-mod' with the key named below
// (hooks/state.ts exports the keys and the screen's helpers).

/** How a hand-off ended (so far). */
export type TierOutcome = 'running' | 'done' | 'check failed' | 'escalated' | 'cut off'

/** The savings meter's inputs for one hand-off (spec 2.5), gathered live. */
export type TierSavingsInputs = {
  /** The main model at the hand-off (prices the counterfactual); undefined when unknown. */
  mainModel?: string
  /** The main session's cache TTL at the hand-off ('1h' when absent): prices the main cache write. */
  ttl?: '1h' | '5m'
  /** The main context tokens at the hand-off (long-prompt pricing); absent on older records. */
  mainContextTokens?: number
  /** The helper's tool calls seen (tool.call with its agentId). */
  helperCalls: number
  /** Sum over those calls of (main context tokens at that moment x main cache-read price), USD. */
  roundTripUsd: number
  /** The main round trip the hand-off result itself causes (main context x read price), USD. Absent on older records: read as 0. */
  handoffRoundTripUsd?: number
  /** Tokens of the helper's tool results (text length / 4). */
  resultTokens: number
  /** Tokens of the brief the main wrote (Agent prompt + description, length / 4). */
  briefTokens: number
  /** Tokens of the digest the main read back (the Agent result, length / 4). */
  digestTokens: number
  /** Main requests since the hand-off ended (until compaction or session end). */
  laterMainRequests: number
  /** True once a compaction dropped the counterfactual results from the main context. */
  frozen?: boolean
}

/** What the savings meter answers for one hand-off: an estimate ("est."). */
export type TierSavings = {
  /** What the same work would have cost inline in the main session, USD. */
  normalUsd: number
  /** What it cost handed off: helper + brief + digest, USD. */
  actualUsd: number
  /** normal - actual, USD (may be negative). */
  savedUsd: number
  /** Helper tool-result tokens that never entered the main context (results - digest, >= 0). */
  tokensKeptOut: number
}

/** One hand-off: an Agent call, a workflow agent(), a fork, a resumed (SendMessage) run. */
export type TierHandoff = {
  kind: 'handoff'
  /** Agent: the call's tool_use_id. Workflow: `<runId>#<agentIndex>`. Resume: `resume:<agentId>:<n>`. Other: `spawn:<agentId>`. */
  id: string
  at: number
  /** Local day `YYYY-MM-DD`. */
  day: string
  sessionId: string
  /** The task tag `[t=<word>]`, inherited by a continuation; null when untagged. */
  tag: string | null
  /** This tag's try number in this session (1 = first); 0 when untagged. */
  try: number
  via: 'agent' | 'workflow' | 'fork' | 'resume' | 'other'
  /** subagent type (`tier-mod:reader`, `Explore`, `fork`, ...). */
  helperType: string
  /** Short description (Agent description or workflow label), max 80 chars. */
  title: string
  model: string
  /** The effort it really ran at (turn.step of its agentId); the call's value until a step is seen; 'unknown'. */
  effort: string
  effortSource: 'turn.step' | 'call' | 'unknown'
  background?: boolean
  agentId?: string
  /** Set when the gate could not read model/effort literally (workflow non-literal, an unknown plugin agent file). */
  unverifiable?: boolean
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Helper cost, USD (sub-agent cache writes at 1.25x input). */
  costUsd?: number
  outcome: TierOutcome
  /** The last Bash command the helper ran, and its exit code (0 = ok). */
  lastCommand?: string
  lastExit?: number
  /** The first line of an ESCALATE: answer, or `<command> exit <n>` of a failed check. */
  failure?: string
  savingsInputs: TierSavingsInputs
  /** The savings estimate as of the last update; undefined when the main model is unknown. */
  saved?: TierSavings
}

/** A gate's refusal (or, enforcement off, what it would have refused). */
export type TierBlock = {
  kind: 'block'
  id: string
  at: number
  day: string
  sessionId: string
  gate: 'handoff' | 'web' | 'read' | 'edit'
  /** The tool the gate stopped (`Agent`, `WebSearch`, `Read`, `Bash`, ...). */
  tool: string
  /** refused before running; withheld = ran, result held back; would-refuse = enforcement off (recorded only). */
  action: 'refused' | 'withheld' | 'would-refuse'
  /** The one-line text the model read. */
  reason: string
  /** The short text the user saw in the toast. */
  toast: string
  tag?: string
  /** The main turn's cost share: one main request re-reading the context, USD; undefined when unknown. */
  costUsd?: number
}

export type TierRecord = TierHandoff | TierBlock

/** Totals over a set of records (this session, or today across sessions). */
export type TierTotals = {
  handoffs: number
  /** Hand-offs still running. */
  running: number
  spentUsd: number
  /** Sum of the hand-offs' savedUsd less the blocks' cost (est.). */
  savedUsd: number
  tokensKeptOut: number
  blocks: number
  blocksUsd: number
  escalations: number
  checkFailed: number
}

/** A rolled-up day (older than 30 days) in the store's summary key. */
export type TierDaySummary = TierTotals & {
  day: string
  byModel: Record<string, { count: number; usd: number }>
  byTag: Record<string, { count: number; usd: number }>
}

export type TierNotice = {
  /** Stable id: the UI shows each once and may dismiss it by id. */
  id: 'outdated-rule' | 'effort-env' | 'old-hooks' | string
  at: number
  text: string
}

export type TierFacts = {
  /** What is injected via prompt.compose for this whole session. */
  mode: 'off' | 'addendum' | 'addendum+rule' | 'skipped'
  reason?: string
  foundVersion?: string
  foundIn?: string
  /** The exact text injected (empty when off). Decided once per session. */
  text: string
}

/** The mod's settings as loaded (userConfig, validated). */
export type TierSettings = {
  /** Default of the on/off switch (the switch itself is stored per user). */
  enforce: boolean
  /** Reading allowance per user message, tokens of tool output. */
  readTokens: number
  /** A Read with no offset/limit of a file over this many lines is refused. */
  readLines: number
  /** Distinct files Edit/Write/NotebookEdit may touch per user message. */
  editFiles: number
  facts: 'auto' | 'off'
}

/** A workflow agent() as the pre-launch scan read it. */
export type TierScanEntry = {
  /** Order in the script text, from 1. */
  index: number
  /** Literal label text, or null when absent / not literal. */
  label: string | null
  model: string | null
  effort: string | null
  agentType: string | null
  /** 'ok', or why the options could not be read literally. */
  status: 'ok' | 'missing' | 'unverifiable'
  missing: Array<'model' | 'effort' | 'agentType'>
}

/** The work gate's per-user-message counters (reset at every user message). */
export type TierGate = {
  /** Tokens of main-loop tool output read this message. */
  readTokens: number
  /** Distinct files edited this message. */
  editFiles: string[]
  /** The user's own words this message said "do it yourself" / "no delegation". */
  override: boolean
  /** The user's own words this message asked for max effort / Fable. */
  userAskedMaxOrFable: boolean
  /**
   * The person pressed "Do it myself" while no turn ran: the next user message starts with the work gate lifted
   * (freshGate spends it). Set only by that press, never by the model.
   */
  carryOverride?: boolean
  /** Task tags the person allowed max/Fable for ("Allow max"), for the rest of the session. Set only by that press. */
  allowMaxTags?: string[]
}

/** A note to the model about the person's own press, waiting for a channel the model reads. */
export type TierOverrideNote = {
  kind: 'work' | 'max'
  /** A "Do it myself" pressed while no turn ran: it holds for the next user message, so it waits for it. */
  next?: boolean
  text: string
  at: number
}

/** The main session as last seen (turn.step + $.session.usage). */
export type TierMain = {
  model?: string
  contextTokens?: number
  /** Main requests so far this session. */
  requests: number
}

/** A part of the mod that broke (it failed open). */
export type TierHealthError = {
  part: string
  message: string
  at: number
  /** The module load that recorded it ($.state survives a reload): only this load's errors are shown. */
  load?: string
}

/** Bookkeeping of the core hooks (not for drawing). */
export type TierRuntime = {
  sessionId: string
  /** Agent tool_use_id -> hand-off id, until agent.spawn ties it to an agentId. */
  pendingSpawn: Record<string, string>
  /** agentId -> hand-off id. */
  agentRecord: Record<string, string>
  /** Workflow tool_use_id -> the pre-launch scan. */
  scans: Record<string, TierScanEntry[]>
  /** Tries per task tag this session. */
  tagTries: Record<string, number>
  /** Tool_use_id -> notes waiting for the Agent/Workflow tool result. */
  pendingNotes: Record<string, string[]>
  /** Tool_use_ids whose result already went back to the model. */
  returned: Record<string, true>
  /** Resumes per agentId (for resume record ids). */
  resumes: Record<string, number>
}

// ---------------------------------------------------------------- part 2: cache meter

export type TierTtl = '1h' | '5m'

/** The cache meter (spec 5): timed by the mod from the start of each main request. */
export type TierMeter = {
  lastMainRequestStartMs?: number
  /** When the last keep-warm ping started (a ping is not a real request). */
  lastPingStartMs?: number
  mainModel?: string
  ttl?: TierTtl
  contextTokens?: number
  rebuildUsd?: number
  phase: 'none' | 'warm' | 'cooling' | 'cold'
  tickMs?: number
  today?: TierCacheDay
  /** Keep-warm's round (the switch itself is the `keepWarm` atom). */
  keepWarm?: TierKeepWarm
}

/** Keep-warm's state this session. Off by default in a new session; only the person's press switches it. */
export type TierKeepWarm = {
  /** off: the switch is off; scheduled: a ping is armed for dueMs; stopped: this round ended (reason). */
  status: 'off' | 'scheduled' | 'stopped'
  dueMs?: number
  reason?: string
  /** Pings sent this session. */
  pings: number
  /** Set by a ping: the next real request's cache read vs write is recorded (the live check), then cleared. */
  checkAfterPingMs?: number
  /** The live check: the context (tokens) at the start of the first real request after the ping. */
  checkContextTokens?: number
  /** The live check: the first real request's own usage (turn.step), when the engine reported it. */
  checkFirstRequest?: { read: number; write: number }
  /** Pings sent, and USD they cost, since the last real main request (the stop rule: pings until they add up to one rebuild). */
  pingsSinceReal?: number
  pingsSinceRealUsd?: number
}

/** One local day of cache figures, kept in $.store under `cache:<day>`. */
export type TierCacheDay = {
  day: string
  coldStarts: number
  rebuildUsd: number
  pingsUsd: number
  savedUsd: number
  pingsSent: number
  pingsSentUsd: number
}

declare module 'claude-code' {
  interface PluginState {
    'tier-mod': {
      /** This session's hand-offs, oldest first (max 300); outcome 'running' = the live helpers. */
      handoffs: TierHandoff[]
      /** This session's blocks, oldest first (max 100). */
      blocks: TierBlock[]
      /** This session's totals and today's (this session + other sessions' records today). */
      totals: { day: string; session: TierTotals; today: TierTotals }
      /** Enforcement on (refuse) or off (record only). Mirrors the per-user store value; default from settings. */
      enforce: boolean
      /** Parts that broke and failed open; non-empty = red chip. */
      health: { errors: TierHealthError[] }
      /** The work gate's counters for the current user message. */
      gate: TierGate
      main: TierMain
      notices: TierNotice[]
      facts: TierFacts
      settings: TierSettings
      runtime: TierRuntime
      meter: TierMeter
      /** Keep-warm on/off. Mirrors the per-user store value `keepWarm`; default off; set only by the person's press. */
      keepWarm: boolean
      /** Notes about the person's presses ("Do it myself", "Allow max") waiting to reach the model. */
      overrideNotes: TierOverrideNote[]
    }
  }
}
