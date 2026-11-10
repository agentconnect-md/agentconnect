// Pending Fill cards (computer-form-fill-and-vault.md §6): in memory only, so a restart never resurrects a person's input.
import {
  COMPUTER_FORM_FIELDS_MAX,
  ComputerFormValue,
  type ComputerFillCard
} from '@agentconnect.md/protocol/computer-form-fill'
import { z } from 'zod'

/** AHP's `agentconnect/fillSubmit` params; the user and conversation come from the attachment, never from here. */
export const AhpFillSubmit = z
  .object({
    channel: z.string().min(1).max(1024),
    requestId: z.string().uuid(),
    values: z.array(ComputerFormValue).max(COMPUTER_FORM_FIELDS_MAX).optional(),
    cancel: z.literal(true).optional()
  })
  .strict()

/** How a card ended for the fill that waits on it; only `submit` carries values, and only to that caller. */
export type FillCardAnswer =
  | { kind: 'submit'; values: ComputerFormValue[]; responder: string }
  | { kind: 'cancel' }
  | { kind: 'expired' }
  | { kind: 'stopped' }

/** Who asked: a console user (webchat), or a member of the session's own chat tenant (`platform:tenant:member`). */
export type FillCardRequester = { userId: string } | { identity: string }

/** Where a card may be answered and by whom: its conversation or its session, and only the person who asked. */
export interface FillCardScope {
  agentId: string
  // The conversation the card was shown in; absent for a card asked on a chat platform.
  conversationId?: string
  // The asking session, by its outward id: the console answers a chat-asked card through a continuation of it.
  sessionId: string
  requester: FillCardRequester | undefined
}

export interface FillCardSubmit {
  requestId: string
  conversationId?: string
  // The session a console continuation is attached to.
  targetSessionId?: string
  userId: string | undefined
  // The answering person's linked chat identities, as the relay verified them.
  userIdentities?: readonly string[]
  values?: ComputerFormValue[]
  cancel?: boolean
}

interface Entry {
  card: ComputerFillCard
  scope: FillCardScope
  settle: (answer: FillCardAnswer) => void
}

const ALIVE_POLL_MS = 1000

export class PendingFillCards {
  private readonly pending = new Map<string, Entry>()

  constructor(private readonly deps: { now?: () => number } = {}) {}

  /** Waits for the card's person, its expiry, or the turn ending (`alive` false); holds nothing else meanwhile. */
  wait(card: ComputerFillCard, scope: FillCardScope, alive: () => boolean): Promise<FillCardAnswer> {
    const now = this.deps.now ?? Date.now
    return new Promise<FillCardAnswer>((resolve) => {
      const settle = (answer: FillCardAnswer) => {
        if (this.pending.get(card.requestId)?.settle !== settle) return
        this.pending.delete(card.requestId)
        clearTimeout(timer)
        clearInterval(poll)
        resolve(answer)
      }
      this.pending.set(card.requestId, { card, scope, settle })
      const timer = setTimeout(() => settle({ kind: 'expired' }), Math.max(0, Date.parse(card.expiresAt) - now()))
      const poll = setInterval(() => {
        if (!alive()) settle({ kind: 'stopped' })
      }, ALIVE_POLL_MS)
      timer.unref?.()
      poll.unref?.()
    })
  }

  /** The card for its person, as the console opens a chat-asked one; never another person's card or its fields. */
  open(submit: Omit<FillCardSubmit, 'values' | 'cancel'>): { card: ComputerFillCard } | { refused: string } {
    const entry = this.pending.get(submit.requestId)
    const refusal = entry ? this.refusal(entry, submit) : 'this Fill card is no longer waiting'
    return refusal || !entry ? { refused: refusal ?? 'this Fill card is no longer waiting' } : { card: entry.card }
  }

  /** A person's answer from a browser; accepted only from the card's own place and person, with its own fields. */
  answer(submit: FillCardSubmit): { accepted: true } | { accepted: false; reason: string } {
    const entry = this.pending.get(submit.requestId)
    const refusal = entry ? this.refusal(entry, submit) : 'this Fill card is no longer waiting'
    if (!entry || refusal) return { accepted: false, reason: refusal ?? 'this Fill card is no longer waiting' }
    if (submit.cancel) {
      entry.settle({ kind: 'cancel' })
      return { accepted: true }
    }
    const values = submit.values ?? []
    const fields = new Set(entry.card.fields.map((field) => field.id))
    const seen = new Set<string>()
    for (const value of values) {
      if (!fields.has(value.field) || seen.has(value.field))
        return { accepted: false, reason: 'the answer names a field this card did not show' }
      seen.add(value.field)
    }
    if (values.length === 0) return { accepted: false, reason: 'the answer fills no field' }
    entry.settle({ kind: 'submit', values, responder: submit.userId ?? '' })
    return { accepted: true }
  }

  private refusal(entry: Entry, submit: Omit<FillCardSubmit, 'values' | 'cancel'>): string | undefined {
    const { scope } = entry
    const place =
      (scope.conversationId !== undefined && submit.conversationId === scope.conversationId) ||
      (submit.targetSessionId !== undefined && submit.targetSessionId === scope.sessionId)
    if (!place) return 'this Fill card is no longer waiting'
    const requester = scope.requester
    const person =
      requester !== undefined &&
      submit.userId !== undefined &&
      ('userId' in requester
        ? requester.userId === submit.userId
        : (submit.userIdentities ?? []).includes(requester.identity))
    return person ? undefined : 'only the person who asked can answer this Fill card'
  }

  /** Settles every card of a conversation as stopped, as when its page closes for good. */
  stopConversation(conversationId: string): void {
    for (const entry of [...this.pending.values()])
      if (entry.scope.conversationId !== undefined && entry.scope.conversationId === conversationId)
        entry.settle({ kind: 'stopped' })
  }

  size(): number {
    return this.pending.size
  }
}
