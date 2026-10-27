// The $.state atoms of tier-mod (types/index.d.ts) and the helpers the screen uses.
// The core hooks (register.tsx) write the atoms; the screen (part2.tsx) reads them
// and calls setEnforce / readLedger. Nothing here throws to its caller.
import { update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { TierDaySummary, TierHealthError, TierNotice, TierRecord } from '../types'
import { RECORD_PREFIX, SUMMARY_KEY, dayOfKey } from './core'

type $ = EngineInterface

// The atoms (types/index.d.ts PluginState['tier-mod']). The engine reads $.state refs only from
// consts of the file that uses them, so each file declares its own: { plugin: 'tier-mod', key: '<key>' }.
// handoffs, blocks, totals, enforce, health, gate, main, notices, facts, settings, runtime, meter.
const ENFORCE = { plugin: 'tier-mod', key: 'enforce' } as const

/** The per-user on/off switch in $.store (shared by every session of this plugin). */
export const ENFORCE_STORE_KEY = 'enforce'

/**
 * This module load's id. $.state survives a reload, so a health error carries the load that recorded it and
 * the screen shows only this load's (an older load's errors are stale: the part may work now).
 */
let loadId = mintLoad()
function mintLoad(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
export function currentLoad(): string {
  return loadId
}
/** A fresh load (register ran again). */
export function newLoad(): void {
  loadId = mintLoad()
}

/** The health errors recorded since this load (older ones, and unstamped ones from before 0.10.0, are stale). */
export function liveErrors(errors: readonly TierHealthError[] | undefined, load = loadId): TierHealthError[] {
  return (errors ?? []).filter(e => e.load === load)
}

/**
 * The notices worth showing: a statusLine is never flagged, so a notice an older version left in $.state that
 * names one (0.2.0's "Older Tier shell hooks ... statusLine (statusline-cache)") is dropped.
 */
export function visibleNotices(notices: readonly TierNotice[] | undefined): TierNotice[] {
  return (notices ?? []).filter(n => !/statusLine/.test(n.text))
}

/** Module-level copy of the switch: the gates read this, never the store. */
let enforceNow: boolean | undefined
export function enforceValue(fallback: boolean): boolean {
  return enforceNow ?? fallback
}
export function setEnforceLocal(on: boolean | undefined): void {
  enforceNow = on
}

/** The screen's "Enforcement on/off" Button: this session at once, every session via the store. */
export async function setEnforce($: $, on: boolean): Promise<void> {
  enforceNow = on
  try {
    await update($, ENFORCE, () => on)
  } catch {
    // the module copy already holds it
  }
  try {
    await $.store.set(ENFORCE_STORE_KEY, on)
  } catch {
    // this session keeps the choice; the next one starts from the default
  }
}

/** Reads the stored switch with a safe default (the setting) when the store has none or fails. */
export async function readStoredEnforce($: $, fallback: boolean): Promise<boolean> {
  try {
    const v = await $.store.get(ENFORCE_STORE_KEY)
    return typeof v === 'boolean' ? v : fallback
  } catch {
    return fallback
  }
}

export type LedgerDays = {
  /** Detail records of the asked days (every session's), oldest first. */
  records: TierRecord[]
  /** Rolled-up days (older than 30) inside the range. */
  summaries: TierDaySummary[]
}

/** The ledger between two local days (inclusive), for the pane's Today / 7 days. Empty on error. */
export async function readLedger($: $, fromDay: string, toDay: string): Promise<LedgerDays> {
  const out: LedgerDays = { records: [], summaries: [] }
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith(RECORD_PREFIX)) continue
      const day = dayOfKey(key)
      if (!day || day < fromDay || day > toDay) continue
      const r = (await $.store.get(key)) as TierRecord | undefined
      if (r) out.records.push(r)
    }
    out.records.sort((a, b) => a.at - b.at)
    const sums = ((await $.store.get(SUMMARY_KEY)) as Record<string, TierDaySummary> | undefined) ?? {}
    out.summaries = Object.values(sums).filter(s => s.day >= fromDay && s.day <= toDay)
  } catch {
    // what was read so far
  }
  return out
}
