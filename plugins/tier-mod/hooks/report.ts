// tier-mod: the one error path. A part that breaks fails open and says so three ways: a red chip (the health atom),
// one toast per part, an entry in ~/.claude/tier-mod-status.json. register.tsx (the core) and part2.tsx (the screen)
// both report through here; the file also holds the boot diagnostics and writes one section per session.
import { update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { currentLoad, liveErrors } from './state'
import { TIER_MOD_VERSION } from './version'

type $ = EngineInterface

const HEALTH = { plugin: 'tier-mod', key: 'health' } as const

export type BootVia = 'session.start' | 'prompt.submit' | 'turn.step' | 'tool.call' | 'agent.spawn'

export type TierStatus = {
  version: string
  sessionId: string
  bootedVia: BootVia | null
  at: string | null
  updatedAt: string | null
  sessionStartSeen: boolean
  registrations: Record<string, string>
  facts: string | null
  errors: string[]
}

/** Most sessions kept in the status file's per-session section (the newest by last write). */
const MAX_STATUS_SESSIONS = 10

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function toast($: $, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // no surface: the ledger and the status file still have it
  }
}

export async function homeDir($: $): Promise<string | undefined> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
}

export function join(dir: string, ...parts: string[]): string {
  return [dir.replace(/[\\/]+$/, ''), ...parts].join('/')
}

export async function readText($: $, path: string): Promise<string | null> {
  try {
    const v = await $.fs.read(path)
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

let statusChain: Promise<unknown> = Promise.resolve()
const toastedParts = new Set<string>()
const reportedHookFailures = new Set<string>()
let statusSessionId = 'unknown'

function freshStatus(): TierStatus {
  return { version: TIER_MOD_VERSION, sessionId: 'unknown', bootedVia: null, at: null, updatedAt: null, sessionStartSeen: false, registrations: {}, facts: null, errors: [] }
}

/** This load's status (the boot steps fill it in; writeStatus saves it). */
export const status: TierStatus = freshStatus()

/** plugin.json's version (beside the hooks, or in .claude-plugin/); the one constant when neither can be read. */
export async function pluginVersion($: $): Promise<string> {
  for (const dir of [join($.plugin.root, '.claude-plugin'), $.plugin.root]) {
    const text = await readText($, join(dir, 'plugin.json'))
    if (text === null) continue
    try {
      const v = (JSON.parse(text) as { version?: unknown }).version
      if (typeof v === 'string' && v) return v
    } catch {
      // unreadable: the next place, then the constant
    }
  }
  return TIER_MOD_VERSION
}

/** A new load: an empty status, no toasts shown yet, nothing queued. */
export function resetReport(): void {
  Object.assign(status, freshStatus())
  statusChain = Promise.resolve()
  toastedParts.clear()
  reportedHookFailures.clear()
  statusSessionId = 'unknown'
}

/** What the file's other sessions' sections hold; a file that is missing or unreadable holds none. */
function priorSessions(text: string | null): Record<string, TierStatus> {
  if (text === null) return {}
  try {
    const sessions = (JSON.parse(text) as { sessions?: unknown }).sessions
    return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? { ...(sessions as Record<string, TierStatus>) } : {}
  } catch {
    return {}
  }
}

async function sessionOf($: $): Promise<string> {
  if (statusSessionId !== 'unknown') return statusSessionId
  try {
    const id = await $.session.id()
    if (id) statusSessionId = id
  } catch {
    // stays 'unknown'
  }
  return statusSessionId
}

/**
 * Writes <home>/.claude/tier-mod-status.json (serialized; no write when the home directory is unknown). Each session
 * owns a section under `sessions` keyed by its id (the other sessions' sections are read back and kept); the top-level
 * fields are those of the most recent boot. A failed write is noted (chip, toast) but never throws.
 */
export function writeStatus($: $): Promise<void> {
  const run = statusChain.then(async () => {
    let now: number
    try {
      now = await $.clock.now()
    } catch {
      now = Date.now()
    }
    status.updatedAt = new Date(now).toISOString()
    const home = await homeDir($)
    if (!home) return
    const path = join(home, '.claude', 'tier-mod-status.json')
    const sid = await sessionOf($)
    status.sessionId = sid
    const others = priorSessions(await readText($, path))
    delete others[sid]
    const mine: TierStatus = { ...status, registrations: { ...status.registrations }, errors: [...status.errors] }
    const kept = Object.entries(others)
      .sort((a, b) => String(b[1]?.updatedAt ?? '').localeCompare(String(a[1]?.updatedAt ?? '')))
      .slice(0, MAX_STATUS_SESSIONS - 1)
    const sessions: Record<string, TierStatus> = { [sid]: mine, ...Object.fromEntries(kept) }
    // The most recent boot leads; on a tie this session does (it is first and the sort is stable).
    const newest = Object.values(sessions).sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))[0] ?? mine
    await $.fs.write(path, JSON.stringify({ ...newest, sessions }, null, 2))
  })
  statusChain = run.catch(() => undefined)
  return run.catch(err => noteError($, 'status file', err))
}

/** A part broke: it fails open. Red chip (health atom), a toast once per part, the status file. Never throws. */
export async function reportError($: $, part: string, err: unknown): Promise<void> {
  await noteError($, part, err)
  await writeStatus($)
}

/** The chip, the toast and the in-memory error list of reportError (the status file write is left to the caller). */
async function noteError($: $, part: string, err: unknown): Promise<void> {
  const message = errorMessage(err)
  status.errors = [...status.errors, `${part}: ${message}`].slice(-50)
  let at: number
  try {
    at = await $.clock.now()
  } catch {
    at = Date.now()
  }
  try {
    // Only this load's errors are kept: $.state survives a reload, an older load's are stale.
    await update($, HEALTH, h => ({ errors: [...liveErrors(h?.errors), { part, message, at, load: currentLoad() }].slice(-20) }))
  } catch {
    // the status file still has it
  }
  if (!toastedParts.has(part)) {
    toastedParts.add(part)
    // The status file itself failed: pointing at it would lead nowhere, so the toast carries the message.
    toast($, part === 'status file'
      ? `Tier: could not write ~/.claude/tier-mod-status.json: ${message}`
      : `Tier: the ${part} broke and lets calls through - details in ~/.claude/tier-mod-status.json`)
  }
}

/**
 * What a `.catch(($, e, next) => ...)` handler does with `next.error` (a hook that threw or ran out of time): it is
 * reported once per distinct message, then the handler passes the call on. Never throws.
 */
export async function hookFailed($: $, hook: string, error: { readonly kind: string; readonly message?: string } | undefined): Promise<void> {
  try {
    const message = error ? `${error.kind === 'timeout' ? 'timed out' : 'threw'}${error.message ? `: ${error.message}` : ''}` : 'failed'
    const key = `${hook}|${message}`
    if (reportedHookFailures.has(key)) return
    if (reportedHookFailures.size >= 200) reportedHookFailures.clear()
    reportedHookFailures.add(key)
    await reportError($, `${hook} hook`, new Error(message))
  } catch {
    // reportError never throws; nothing is left to say it with
  }
}
