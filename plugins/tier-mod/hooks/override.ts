// tier-mod: the person's overrides from the screen ("Do it myself", "Allow max") and the notes that tell the model.
//
// Only the person sets these: the two press handlers below are called from Buttons' onPress closures, which run
// for a `ui.press` a surface raises (the person's click or hotkey). No model-facing tool, prompt text the model
// writes, or hook input reaches them. The user's own words keep their own path (freshGate on prompt.submit).
//
// The note reaches the model on the first channel it reads after the press:
//   1. `context` on the next main-loop tool result (register's tool.call hook, wrapped: a withheld result keeps
//      the notes queued), while a turn runs;
//   2. `context` on the person's next message (prompt.submit), otherwise.
// `$.session.append` was the alternative: a user-role row mid-turn has no stated ordering against the running
// tool loop, and `prompt.context` is computed once per conversation (a change rebuilds the cache) - so neither.
import { update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { TierGate, TierOverrideNote } from '../types'
import { freshGate } from './core'

type $ = EngineInterface

const GATE = { plugin: 'tier-mod', key: 'gate' } as const
const NOTES = { plugin: 'tier-mod', key: 'overrideNotes' } as const

/** A main-loop turn is running (turn.step seen, turn.complete not yet). */
let mainTurnRunning = false
export function setMainTurnRunning(running: boolean): void {
  mainTurnRunning = running
}
export function isMainTurnRunning(): boolean {
  return mainTurnRunning
}

export function doItMyselfNote(next: boolean): string {
  return (
    `[tier] The user pressed "Do it myself" on Tier's hand-off card: the work gate (web, reading and editing limits) ` +
    `is off for ${next ? 'this' : 'the current'} message - do that work yourself, no hand-off needed.`
  )
}

export function allowMaxNote(tag: string): string {
  return (
    `[tier] The user pressed "Allow max" for [t=${tag}]: max effort and the Fable model are allowed for that task ` +
    `for the rest of this session - retry the hand-off as planned, keeping the tag [t=${tag}].`
  )
}

async function queue($: $, note: Omit<TierOverrideNote, 'at'>): Promise<void> {
  const at = await $.clock.now()
  await update($, NOTES, list => [...(list ?? []).filter(n => n.text !== note.text), { ...note, at }].slice(-10))
}

/**
 * Which notes a channel delivers, and which stay queued.
 * - `tool`: a main-loop tool result in the running turn: this message's notes; a "next message" one waits.
 * - `message`: the person's new message: everything; a "Do it myself" for the message that just ended expired.
 * - `folded`: a message typed into the running turn (the lift carries over): everything.
 */
export function splitNotes(list: readonly TierOverrideNote[], channel: 'tool' | 'message' | 'folded'): { deliver: TierOverrideNote[]; keep: TierOverrideNote[] } {
  const deliver: TierOverrideNote[] = []
  const keep: TierOverrideNote[] = []
  for (const n of list) {
    if (channel === 'tool' && n.kind === 'work' && n.next) keep.push(n)
    else if (channel === 'message' && n.kind === 'work' && !n.next) continue
    else deliver.push(n)
  }
  return { deliver, keep }
}

async function takeNotes($: $, channel: 'tool' | 'message' | 'folded'): Promise<string[]> {
  const list = (await $.state.get(NOTES)).value ?? []
  if (list.length === 0) return []
  const { deliver, keep } = splitNotes(list, channel)
  await update($, NOTES, () => keep)
  return deliver.map(n => n.text)
}

/**
 * "Do it myself": the work gate lifted for the CURRENT request (until the next user message); with no turn
 * running, for the next one. Called only from a Button's onPress.
 */
export async function pressDoItMyself($: $): Promise<'current' | 'next'> {
  const next = !mainTurnRunning
  await update($, GATE, g => {
    const base: TierGate = g ?? freshGate()
    return next ? { ...base, carryOverride: true } : { ...base, override: true }
  })
  await queue($, { kind: 'work', next, text: doItMyselfNote(next) })
  return next ? 'next' : 'current'
}

/** "Allow max": max/Fable allowed for that task tag for the rest of the session. Called only from a Button's onPress. */
export async function pressAllowMax($: $, tag: string): Promise<void> {
  await update($, GATE, g => {
    const base: TierGate = g ?? freshGate()
    const tags = base.allowMaxTags ?? []
    return tags.includes(tag) ? base : { ...base, allowMaxTags: [...tags, tag] }
  })
  await queue($, { kind: 'max', text: allowMaxNote(tag) })
}

/**
 * register.tsx's main tool.call hook (the one with no matcher, which every call passes through, Agent and Workflow
 * included) hands its result here: a main-loop result that is not refused carries the waiting notes as `context`.
 * A refused or withheld result keeps them queued. Fails open.
 */
export async function withOverrideNotes<R extends { deny?: unknown; context?: readonly string[] }>($: $, agentId: string | undefined, r: R): Promise<R> {
  if (agentId !== undefined || r.deny !== undefined) return r
  try {
    const notes = await takeNotes($, 'tool')
    return notes.length > 0 ? { ...r, context: [...(r.context ?? []), ...notes] } : r
  } catch {
    return r
  }
}

/** register.tsx's prompt.submit: the person's own message carries the waiting notes as `context`. Fails open. */
export async function withPromptNotes<E extends { isMeta?: true; command?: unknown; origin: { kind: string }; turnId?: string; context?: readonly string[] }>($: $, e: E): Promise<E> {
  const kind = e.origin.kind
  if (e.isMeta || e.command || (kind !== 'composer' && kind !== 'bridge')) return e
  try {
    const notes = await takeNotes($, e.turnId !== undefined ? 'folded' : 'message')
    return notes.length > 0 ? { ...e, context: [...(e.context ?? []), ...notes] } : e
  } catch {
    return e
  }
}
