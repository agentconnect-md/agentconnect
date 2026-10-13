// The confirmation asked before the bot joins a public channel (#2979): its card's request, its answers and how it reads settled.
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { ReadAsker } from '../assistant/place-access.js'

/** How long a join confirmation waits: an API caller's answer window, the one fixed wait a live turn gives a person it asked. */
export const JOIN_ASK_TIMEOUT_MS = 10 * 60_000

/** The wait as a card and a tool result say it. */
export const JOIN_ASK_WAIT_TEXT = `${JOIN_ASK_TIMEOUT_MS / 60_000} minutes`

/** A console asker's chat account on the bot a card goes through, so they answer it there as themselves. */
export interface JoinLinkedAsker {
  readonly integrationId: string
  readonly userId: string
  readonly consoleUserId: string
}

/** What the bot would join, what for, and who may answer: the people behind the turn. */
export interface JoinAsk {
  readonly channel: string
  /** The channel's display name, without `#`. */
  readonly name: string
  readonly purpose: 'read' | 'post'
  readonly askers: readonly ReadAsker[]
  /** The tool call that asked, which a restart's notice names. */
  readonly tool?: string
  readonly linked?: readonly JoinLinkedAsker[]
}

/** How the ask ended: join, a person declined, nobody answered in time, or no card could reach anyone behind the turn. */
export type JoinOutcome = 'join' | 'declined' | 'expired' | 'unavailable'

/** The ask's end, with the person behind the turn who answered it. */
export interface JoinAnswer {
  outcome: JoinOutcome
  by?: ReadAsker
}

/** What a join card's row keeps, so a restart's sweep can tell the session the call did nothing. */
export interface StoredJoinAsk {
  tool?: string
  name: string
  purpose: JoinAsk['purpose']
}

/** A stored join ask, or undefined for any other row or an unreadable one. */
export function parseStoredJoinAsk(raw: string | null | undefined): StoredJoinAsk | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<StoredJoinAsk>
    if (typeof value.name !== 'string' || (value.purpose !== 'read' && value.purpose !== 'post')) return undefined
    return { name: value.name, purpose: value.purpose, ...(typeof value.tool === 'string' ? { tool: value.tool } : {}) }
  } catch {
    return undefined
  }
}

export const JOIN_OPTION = 'join'
export const DONT_JOIN_OPTION = 'dont-join'

/** The card's request, in the permission card's shape every surface already renders: its question and two answers. */
export function joinRequestParams(sessionId: string, agentName: string, ask: JoinAsk): RequestPermissionRequest {
  const what = ask.purpose === 'read' ? 'read it' : 'post there'
  return {
    sessionId,
    toolCall: { toolCallId: `join:${ask.channel}`, title: `Let ${agentName} join #${ask.name} to ${what}?` },
    options: [
      { optionId: JOIN_OPTION, name: 'Join', kind: 'allow_once' },
      { optionId: DONT_JOIN_OPTION, name: 'Don’t join', kind: 'reject_once' }
    ]
  }
}

/** How a decided card reads before the decider's name. */
export function joinDecidedText(ask: JoinAsk, joined: boolean): string {
  return joined ? `Joined #${ask.name}` : 'Not joined'
}

/** How a card reads once nobody answered in time. */
export const JOIN_EXPIRED_TEXT = `Not joined — nobody answered within ${JOIN_ASK_WAIT_TEXT}`

/** What a click from anyone but a person behind the turn is told, only them. */
export const JOIN_ANSWER_REFUSED = 'Only the person who asked the agent can answer this.'

/** Whether a console decision comes from a person behind the turn. */
export function joinDecidedByAsker(ask: JoinAsk, decidedBy: string | undefined): boolean {
  return ask.askers.some((asker) => asker.kind === 'console' && decidedBy === `user:${asker.userId}`)
}
