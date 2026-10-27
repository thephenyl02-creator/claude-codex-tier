// Pure functions of the cache meter (spec 5) and the keep-warm decision (back in 0.11.0, off by default).
// No `$`, no state: unit-tested in cache.test.ts.
import type { TierCacheDay, TierMeter, TierTtl } from '../types'
import { PRICES, longPromptFactor, modelFamily } from './core'

export const MINUTE_MS = 60_000
export const TTL_MS: Readonly<Record<TierTtl, number>> = { '1h': 60 * MINUTE_MS, '5m': 5 * MINUTE_MS }
/** A keep-warm ping goes this long after the last request (or ping) started. */
export const PING_EVERY_MS = 55 * MINUTE_MS
/** "Cold within 5 min" for the band. */
export const COOLING_MS = 5 * MINUTE_MS
/** Keep-warm skips a context this small: a rebuild is cheap. */
export const KEEP_WARM_MIN_CONTEXT = 20_000
/** Keep-warm skips while the five-hour usage window is this full (percent) or more. */
export const RATE_LIMIT_STOP_PERCENT = 90
export const KEEP_WARM_PROMPT = 'Keep-warm ping from the Tier mod. Reply with OK only.'

type RateLimitLike = { kind: string; percentUsed: number }

/** 1h when the session reports subscription rate-limit windows (five_hour / seven_day), else 5m. */
export function ttlFor(rateLimits: readonly RateLimitLike[] | undefined): TierTtl {
  return (rateLimits ?? []).some(r => r.kind === 'five_hour' || r.kind === 'seven_day') ? '1h' : '5m'
}

/** USD per token to write the main model's cache: 1h 2x input, 5m 1.25x input. */
export function writePricePerToken(model: string | undefined, ttl: TierTtl, contextTokens?: number): number | undefined {
  const fam = modelFamily(model)
  if (!fam) return undefined
  return (longPromptFactor(model, contextTokens) * PRICES[fam].input * (ttl === '1h' ? 2 : 1.25)) / 1_000_000
}

/** USD per token to read the main model's cache. */
export function readPricePerToken(model: string | undefined, contextTokens?: number): number | undefined {
  const fam = modelFamily(model)
  if (!fam) return undefined
  return (longPromptFactor(model, contextTokens) * PRICES[fam].input * PRICES[fam].readFactor) / 1_000_000
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** What rebuilding `contextTokens` of context costs: context x the cache-write price. */
export function rebuildCostUsd(contextTokens: number | undefined, model: string | undefined, ttl: TierTtl): number | undefined {
  const w = writePricePerToken(model, ttl, contextTokens)
  if (w === undefined || contextTokens === undefined) return undefined
  return round6(contextTokens * w)
}

/** Keep-warm pings that fit a gap: one per 55 minutes, never more than `maxPings`. */
export function pingCount(gapMs: number, maxPings: number): number {
  return Math.min(Math.floor(Math.max(0, gapMs) / PING_EVERY_MS), Math.max(0, maxPings))
}

/**
 * The keep-warm budget: pings run until together they would cost one rebuild of the context. `maxPings` is how many
 * pings of the current context fit that budget (Opus: 40, the write price over the read price).
 */
export function pingBudget(args: { contextTokens: number | undefined; model: string | undefined; ttl: TierTtl }):
  | { rebuildUsd: number; pingUsd: number; maxPings: number }
  | undefined {
  const { contextTokens, model, ttl } = args
  const rebuildUsd = rebuildCostUsd(contextTokens, model, ttl)
  const read = readPricePerToken(model, contextTokens)
  if (rebuildUsd === undefined || read === undefined || contextTokens === undefined) return undefined
  const pingUsd = contextTokens * read
  if (!(pingUsd > 0)) return undefined
  // A float-safe floor: 737,425 tokens on Opus is exactly 40 pings.
  return { rebuildUsd, pingUsd, maxPings: Math.floor(rebuildUsd / pingUsd + 1e-9) }
}

/** When the cache was last touched: the later of the last real request's start and the last ping's. */
export function lastTouchMs(meter: Pick<TierMeter, 'lastMainRequestStartMs' | 'lastPingStartMs'>): number | undefined {
  const a = meter.lastMainRequestStartMs
  const b = meter.lastPingStartMs
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

export type ColdGap = {
  gapMs: number
  rebuildUsd: number
  pings: number
  pingsUsd: number
  /** Whether keep-warm (pings until they add up to one rebuild) would have kept the cache warm across this gap. */
  isCovered: boolean
  /** Rebuild avoided (when covered) less what the pings cost; may be negative. */
  savedUsd: number
}

/**
 * The "would have saved" of one main request that starts after a gap longer
 * than the TTL. Null when the gap is within the TTL or the cost cannot be
 * priced. On the 5m TTL keep-warm does not run, so pings and savings are 0.
 */
export function coldGapAccount(args: {
  gapMs: number
  ttl: TierTtl
  contextTokens: number | undefined
  model: string | undefined
}): ColdGap | null {
  const { gapMs, ttl, contextTokens, model } = args
  if (!(gapMs > TTL_MS[ttl])) return null
  const budget = pingBudget({ contextTokens, model, ttl })
  if (budget === undefined || contextTokens === undefined) return null
  const { rebuildUsd, pingUsd, maxPings } = budget
  if (ttl === '5m') return { gapMs, rebuildUsd, pings: 0, pingsUsd: 0, isCovered: false, savedUsd: 0 }
  const pings = pingCount(gapMs, maxPings)
  const pingsUsd = round6(pings * pingUsd)
  const isCovered = pings > 0 && gapMs <= pings * PING_EVERY_MS + TTL_MS[ttl]
  return { gapMs, rebuildUsd, pings, pingsUsd, isCovered, savedUsd: round6((isCovered ? rebuildUsd : 0) - pingsUsd) }
}

export function emptyCacheDay(day: string): TierCacheDay {
  return { day, coldStarts: 0, rebuildUsd: 0, pingsUsd: 0, savedUsd: 0, pingsSent: 0, pingsSentUsd: 0 }
}

export function addColdGap(day: TierCacheDay, gap: ColdGap): TierCacheDay {
  return {
    ...day,
    coldStarts: day.coldStarts + 1,
    rebuildUsd: round6(day.rebuildUsd + gap.rebuildUsd),
    pingsUsd: round6(day.pingsUsd + gap.pingsUsd),
    savedUsd: round6(day.savedUsd + gap.savedUsd),
  }
}

export type CachePhase = TierMeter['phase']

/** Where the cache stands at `now`: minutes left until cold counted from the last touch. */
export function cachePhase(meter: Pick<TierMeter, 'lastMainRequestStartMs' | 'lastPingStartMs' | 'ttl'>, now: number): { phase: CachePhase; msLeft: number } {
  const touch = lastTouchMs(meter)
  if (touch === undefined || meter.lastMainRequestStartMs === undefined) return { phase: 'none', msLeft: 0 }
  const msLeft = touch + TTL_MS[meter.ttl ?? '5m'] - now
  if (msLeft <= 0) return { phase: 'cold', msLeft: 0 }
  if (msLeft <= COOLING_MS) return { phase: 'cooling', msLeft }
  return { phase: 'warm', msLeft }
}

// ---------------------------------------------------------------- keep-warm

export type KeepWarmDecision = { kind: 'ping' } | { kind: 'skip'; reason: string }

/**
 * Whether a keep-warm timer that fired should ping. Off unless the person switched it on; a skip ends the round
 * (the next real request arms it again): on the 5m TTL, under 20K of context, while a turn runs, with the five-hour
 * window 90% used or more, and once the pings since the last real request plus the next one would cost more than one
 * rebuild of the context (spentUsd = what those pings cost).
 */
export function keepWarmDecision(args: {
  on: boolean
  lastRealStartMs: number | undefined
  ttl: TierTtl
  contextTokens: number | undefined
  rateLimits: readonly RateLimitLike[]
  turnRunning: boolean
  /** The main model (prices the rebuild and the ping). */
  model: string | undefined
  /** USD the pings since the last real main request cost. */
  spentUsd: number
  /** When the timer fired and the last ping's start: with `now` given, a cache already cold is not pinged. */
  now?: number
  lastPingStartMs?: number
}): KeepWarmDecision {
  const { on, lastRealStartMs, ttl, contextTokens, rateLimits, turnRunning, model, spentUsd } = args
  if (!on) return { kind: 'skip', reason: 'keep-warm is off' }
  if (lastRealStartMs === undefined) return { kind: 'skip', reason: 'no request yet' }
  if (ttl !== '1h') return { kind: 'skip', reason: '5m TTL' }
  if (turnRunning) return { kind: 'skip', reason: 'a turn is running' }
  // A timer that fired late (the machine slept): a ping would pay a full rebuild for nothing.
  if (args.now !== undefined) {
    const meter = { lastMainRequestStartMs: lastRealStartMs, ttl, ...(args.lastPingStartMs !== undefined ? { lastPingStartMs: args.lastPingStartMs } : {}) }
    if (cachePhase(meter, args.now).phase === 'cold') return { kind: 'skip', reason: 'cache already cold' }
  }
  if ((contextTokens ?? 0) < KEEP_WARM_MIN_CONTEXT) return { kind: 'skip', reason: 'context under 20K' }
  const fiveHour = rateLimits.find(r => r.kind === 'five_hour')
  if (fiveHour && fiveHour.percentUsed >= RATE_LIMIT_STOP_PERCENT) return { kind: 'skip', reason: `five-hour window ${Math.round(fiveHour.percentUsed)}% used` }
  return pingBudgetDecision({ contextTokens, model, ttl, spentUsd })
}

/** The stop rule alone: ping while spent + the expected next ping stays within one rebuild. */
export function pingBudgetDecision(args: { contextTokens: number | undefined; model: string | undefined; ttl: TierTtl; spentUsd: number }): KeepWarmDecision {
  const budget = pingBudget(args)
  if (budget === undefined) return { kind: 'skip', reason: 'cannot price the rebuild' }
  // round6: the sums are compared in micro-dollars so 40 Opus pings fit exactly and the 41st does not.
  if (round6(args.spentUsd + budget.pingUsd) > round6(budget.rebuildUsd) + 1e-9) return { kind: 'skip', reason: `pings reached one rebuild (${formatUsd(budget.rebuildUsd)})` }
  return { kind: 'ping' }
}

/** When the next ping is due: 55 minutes after the later of the last real request's start and the last ping's. */
export function nextPingDueMs(meter: Pick<TierMeter, 'lastMainRequestStartMs' | 'lastPingStartMs'>): number | undefined {
  const touch = lastTouchMs(meter)
  return touch === undefined ? undefined : touch + PING_EVERY_MS
}

/** A ping's figures added to the day. */
export function addPing(day: TierCacheDay, usd: number | undefined): TierCacheDay {
  return { ...day, pingsSent: day.pingsSent + 1, pingsSentUsd: round6(day.pingsSentUsd + (usd ?? 0)) }
}

// ---------------------------------------------------------------- formatting

export function formatUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '$?'
  const sign = usd < 0 ? '-' : ''
  return `${sign}$${Math.abs(usd).toFixed(2)}`
}

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return '?'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

export function formatMinutes(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / MINUTE_MS))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`
}

/** `Tier · warm 42m · 312K · 6 agents $0.84 · saved $1.20` */
export function statusLine(args: {
  meter: Pick<TierMeter, 'lastMainRequestStartMs' | 'lastPingStartMs' | 'ttl' | 'contextTokens' | 'rebuildUsd'>
  now: number
  agents: number
  agentsUsd: number
  savedUsd?: number | undefined
}): string {
  const parts = ['Tier']
  const { phase, msLeft } = cachePhase(args.meter, args.now)
  if (phase === 'warm' || phase === 'cooling') parts.push(`warm ${formatMinutes(msLeft)}`)
  else if (phase === 'cold') parts.push(args.meter.rebuildUsd !== undefined ? `cold (rebuild ${formatUsd(args.meter.rebuildUsd)})` : 'cold')
  if (args.meter.contextTokens !== undefined) parts.push(formatTokens(args.meter.contextTokens))
  parts.push(`${args.agents} agent${args.agents === 1 ? '' : 's'} ${formatUsd(args.agentsUsd)}`)
  if (args.savedUsd !== undefined && args.savedUsd !== 0) parts.push(`saved ${formatUsd(args.savedUsd)}`)
  return parts.join(' · ')
}
