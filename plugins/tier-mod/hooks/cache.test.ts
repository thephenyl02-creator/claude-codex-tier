// Unit tests of the cache meter math (cache.ts).
import { expect, test } from 'claude-code/testing'

import { MINUTE_MS, coldGapAccount, cachePhase, keepWarmDecision, pingBudget, pingCount, rebuildCostUsd, statusLine, ttlFor } from './cache'

const OPUS = 'claude-opus-5-5'
const H = 60 * MINUTE_MS
const sub = [{ kind: 'five_hour', percentUsed: 10 }]

test('TTL: 1h with subscription rate-limit windows, else 5m', () => {
  expect(ttlFor([])).toBe('5m')
  expect(ttlFor(undefined)).toBe('5m')
  expect(ttlFor(sub)).toBe('1h')
  expect(ttlFor([{ kind: 'seven_day', percentUsed: 1 }])).toBe('1h')
  expect(ttlFor([{ kind: 'spend_limit', percentUsed: 1 }])).toBe('5m')
})

test('rebuild = context x cache-write price (1h 2x input, 5m 1.25x input)', () => {
  expect(rebuildCostUsd(300_000, OPUS, '1h')).toBe(2.4)
  expect(rebuildCostUsd(300_000, OPUS, '5m')).toBe(1.5)
  expect(rebuildCostUsd(100_000, 'claude-sonnet-5-5', '1h')).toBe(0.4)
  expect(rebuildCostUsd(100_000, 'mystery-model', '1h')).toBeUndefined()
  expect(rebuildCostUsd(undefined, OPUS, '1h')).toBeUndefined()
})

test('pings: one per 55 min, never more than the budget allows', () => {
  expect(pingCount(54 * MINUTE_MS, 40)).toBe(0)
  expect(pingCount(2 * H, 40)).toBe(2)
  expect(pingCount(100 * H, 40)).toBe(40)
  expect(pingCount(2 * H, 1)).toBe(1)
})

test('ping budget: pings until they add up to one rebuild (Opus: the write price over the read price = 40)', () => {
  expect(pingBudget({ contextTokens: 737_425, model: OPUS, ttl: '1h' })).toMatchObject({ rebuildUsd: 5.8994, maxPings: 40 })
  expect(pingBudget({ contextTokens: 300_000, model: OPUS, ttl: '1h' })).toMatchObject({ rebuildUsd: 2.4, maxPings: 40 })
  expect(pingBudget({ contextTokens: 300_000, model: 'claude-sonnet-5-5', ttl: '1h' })?.maxPings).toBe(20)
  expect(pingBudget({ contextTokens: 300_000, model: 'x', ttl: '1h' })).toBeUndefined()
  expect(pingBudget({ contextTokens: undefined, model: OPUS, ttl: '1h' })).toBeUndefined()
})

test('would have saved: a 2h gap on 1h TTL is covered; pings priced at the cache-read rate', () => {
  const gap = coldGapAccount({ gapMs: 2 * H, ttl: '1h', contextTokens: 300_000, model: OPUS })
  // read price opus = 4 x 0.05 = $0.20/MTok -> $0.06 per ping of 300K
  expect(gap).toEqual({ gapMs: 2 * H, rebuildUsd: 2.4, pings: 2, pingsUsd: 0.12, isCovered: true, savedUsd: 2.28 })
})

test('would have saved: within the TTL is no cold start; Opus 23h gap is covered, 40h is not (40 pings reach one rebuild)', () => {
  expect(coldGapAccount({ gapMs: 30 * MINUTE_MS, ttl: '1h', contextTokens: 300_000, model: OPUS })).toBeNull()
  const day = coldGapAccount({ gapMs: 23 * H, ttl: '1h', contextTokens: 300_000, model: OPUS })
  expect(day?.pings).toBe(25)
  expect(day?.isCovered).toBe(true)
  expect(day?.savedUsd).toBe(0.9)
  const long = coldGapAccount({ gapMs: 40 * H, ttl: '1h', contextTokens: 300_000, model: OPUS })
  expect(long?.pings).toBe(40)
  expect(long?.isCovered).toBe(false)
  expect(long?.savedUsd).toBe(-2.4)
})

test('would have saved: 5m TTL records the rebuild but no pings; unknown model is not priced', () => {
  expect(coldGapAccount({ gapMs: 10 * MINUTE_MS, ttl: '5m', contextTokens: 300_000, model: OPUS })).toEqual({
    gapMs: 10 * MINUTE_MS,
    rebuildUsd: 1.5,
    pings: 0,
    pingsUsd: 0,
    isCovered: false,
    savedUsd: 0,
  })
  expect(coldGapAccount({ gapMs: 2 * H, ttl: '1h', contextTokens: 300_000, model: 'x' })).toBeNull()
})

test('cache phase counts from the start of the last request (or ping)', () => {
  expect(cachePhase({ ttl: '1h' }, 0).phase).toBe('none')
  expect(cachePhase({ lastMainRequestStartMs: 0, ttl: '1h' }, 18 * MINUTE_MS)).toEqual({ phase: 'warm', msLeft: 42 * MINUTE_MS })
  expect(cachePhase({ lastMainRequestStartMs: 0, ttl: '1h' }, 57 * MINUTE_MS).phase).toBe('cooling')
  expect(cachePhase({ lastMainRequestStartMs: 0, ttl: '1h' }, 61 * MINUTE_MS).phase).toBe('cold')
  expect(cachePhase({ lastMainRequestStartMs: 0, lastPingStartMs: 55 * MINUTE_MS, ttl: '1h' }, 70 * MINUTE_MS).phase).toBe('warm')
})

test('status line', () => {
  const meter = { lastMainRequestStartMs: 0, ttl: '1h' as const, contextTokens: 312_000, rebuildUsd: 2.5 }
  expect(statusLine({ meter, now: 18 * MINUTE_MS, agents: 6, agentsUsd: 0.84 })).toBe('Tier · warm 42m · 312K · 6 agents $0.84')
  expect(statusLine({ meter, now: 2 * H, agents: 1, agentsUsd: 0 })).toBe('Tier · cold (rebuild $2.50) · 312K · 1 agent $0.00')
  expect(statusLine({ meter: {}, now: 0, agents: 0, agentsUsd: 0 })).toBe('Tier · 0 agents $0.00')
  expect(statusLine({ meter: {}, now: 0, agents: 2, agentsUsd: 0.12, savedUsd: 0.41 })).toBe('Tier · 2 agents $0.12 · saved $0.41')
})

test('#15 rebuild and ping prices use the long-prompt rate for Haiku only', () => {
  expect(rebuildCostUsd(100_000, 'claude-haiku-5-5', '1h')).toBe(0.02)
  expect(rebuildCostUsd(101_000, 'claude-haiku-5-5', '1h')).toBe(0.101)
  expect(rebuildCostUsd(312_000, OPUS, '1h')).toBe(2.496)
  const b = pingBudget({ contextTokens: 312_000, model: 'claude-haiku-5-5', ttl: '1h' })!
  expect(Math.abs((b.rebuildUsd) - (0.312)) < 1e-6).toBe(true)
  expect(Math.abs((b.pingUsd) - (0.0156)) < 1e-6).toBe(true)
})

test('#11 keep-warm: a timer that fires after the cache went cold does not ping', () => {
  const args = {
    on: true,
    lastRealStartMs: 0,
    ttl: '1h' as const,
    contextTokens: 300_000,
    rateLimits: sub,
    turnRunning: false,
    model: OPUS,
    spentUsd: 0,
  }
  // fired on time (55 min): a ping; fired after the machine slept (3 h later): the cache is cold, no ping
  expect(keepWarmDecision({ ...args, now: 55 * MINUTE_MS })).toEqual({ kind: 'ping' })
  expect(keepWarmDecision({ ...args, now: 3 * H })).toEqual({ kind: 'skip', reason: 'cache already cold' })
  // a ping at 55 min keeps it warm until 55 + 60 min
  expect(keepWarmDecision({ ...args, now: 100 * MINUTE_MS, lastPingStartMs: 55 * MINUTE_MS })).toEqual({ kind: 'ping' })
  expect(keepWarmDecision({ ...args, now: 116 * MINUTE_MS, lastPingStartMs: 55 * MINUTE_MS })).toEqual({ kind: 'skip', reason: 'cache already cold' })
  // without `now` the check is off (older callers)
  expect(keepWarmDecision({ ...args })).toEqual({ kind: 'ping' })
})
