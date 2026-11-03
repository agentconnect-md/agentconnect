import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ChoiceCardLedger, ChoiceCardRow } from '../store/choice-cards.js'
import type { LocalApiReply, LocalApiRoute } from '../local-api/server.js'
import { EDIT_CHOICE } from '../platforms/choice-card.js'
import type { InteractionActor } from '../platforms/contract.js'

/** A card's surface, bound by core to the platform facet and connection that posted it. */
export interface ChoiceCardSurface {
  post(card: ChoiceCardRow): Promise<string | undefined>
  redraw(card: ChoiceCardRow): Promise<boolean>
  /** Absent ⇒ the refusal goes back to the ingress. */
  tellPrivately?(card: ChoiceCardRow, userId: string, text: string): Promise<void>
}

/** What a card shows, as a REST caller or an agent's tool sends it. */
export const ChoiceCardContentSchema = z.object({
  title: z.string().min(1).max(150),
  body: z.string().max(2900).default(''),
  options: z
    .array(z.object({ id: z.string().min(1).max(60), label: z.string().min(1).max(75) }))
    .min(1)
    .max(5),
  /** Show an editable text field holding this value, with a "Send edited" button. */
  editText: z.string().min(1).max(2900).optional(),
  expiresAt: z.number().int().positive().optional()
})
export type ChoiceCardContent = z.infer<typeof ChoiceCardContentSchema>

/** `POST /v1/cards`: the place is a doorbell target the agent declares, never a free-form channel. */
export const CreateChoiceCardSchema = ChoiceCardContentSchema.extend({
  /** The agent's id. */
  agent: z.string().min(1),
  /** The id of a doorbell the agent's config declares. */
  target: z.string().min(1),
  /** An existing thread inside the target's channel; absent ⇒ the card posts at top level and its presses run in its own thread. */
  thread: z.string().min(1).optional()
}).strict()
export type CreateChoiceCard = z.infer<typeof CreateChoiceCardSchema>

/** The states a caller may set: settled or display states only; re-arming a card means creating a new one. */
export const CHOICE_CARD_SETTABLE_STATES = ['decided', 'sending', 'sent', 'skipped', 'stale', 'expired'] as const

export const UpdateChoiceCardSchema = z
  .object({ state: z.enum(CHOICE_CARD_SETTABLE_STATES).optional(), label: z.string().max(300).nullable().optional() })
  .strict()
  .refine((p) => p.state !== undefined || p.label !== undefined, 'state or label is required')
export type UpdateChoiceCard = z.infer<typeof UpdateChoiceCardSchema>

/** Where a card goes, resolved by core: the agent, the integration it posts through and the conversation. */
export interface ChoiceCardPlace {
  agentId: string
  integrationId: string
  platform: string
  channel: string
  /** Absent ⇒ top level; presses then run in the card's own thread. */
  thread?: string
  isDm: boolean
}

export interface CardClick {
  cardId: string
  choice: string
  editedText?: string
  actor?: InteractionActor
}

export interface ChoiceCardDeps {
  ledger: ChoiceCardLedger
  /** The card's bound surface; undefined when its platform has no facet or the connection declines (send-only). */
  surfaceFor(card: Pick<ChoiceCardRow, 'integrationId' | 'platform'>): ChoiceCardSurface | undefined
  /** Judge a press as a message from that person there: undefined when allowed, else what only they are told ('' ⇒ nothing). */
  judge(card: ChoiceCardRow, actor: InteractionActor): Promise<string | undefined>
  /** Start the press's turn under `deliveryId`; `admitted` runs inside the admission fence; true once admitted. */
  startTurn(card: ChoiceCardRow, text: string, deliveryId: string, admitted: () => Promise<void>): Promise<boolean>
  /** Whether a durable inbox row (or its receipt) exists for this delivery. */
  hasDelivery(deliveryId: string): Promise<boolean>
  now(): number
  log?: { warn(msg: string): void }
}

/** The press's deterministic delivery id, so a retry after a reopen never meets the earlier one's inbox row. */
export const choiceCardDeliveryId = (card: Pick<ChoiceCardRow, 'cardId' | 'generation'>): string =>
  `card:${card.cardId}:${card.generation}`

export const CARD_PRESS_FAILED_TEXT =
  "Your choice couldn't start a turn just now. The card is open again: press it again."

const view = (card: ChoiceCardRow) => ({
  id: card.cardId,
  channel: card.channel,
  thread: card.thread,
  ts: card.ts,
  state: card.state,
  ...(card.label !== null ? { label: card.label } : {}),
  ...(card.choice !== null ? { choice: card.choice } : {}),
  ...(card.clickedBy !== null ? { clickedBy: card.clickedBy } : {}),
  ...(card.clickedByName !== null ? { clickedByName: card.clickedByName } : {}),
  ...(card.editedText !== null ? { editedText: card.editedText } : {}),
  ...(card.decidedAt !== null ? { decidedAt: card.decidedAt } : {})
})

/** The words a winning press hands the agent; the card id lets it read the card back. */
export function clickTurnText(card: ChoiceCardRow): string {
  const who = card.clickedByName ?? card.clickedBy ?? 'someone'
  if (card.choice === EDIT_CHOICE)
    return `[card ${card.cardId}] ${who} edited "${card.title}" and chose Send edited:\n${card.editedText ?? ''}`
  const label = card.options.find((o) => o.id === card.choice)?.label ?? card.choice
  return `[card ${card.cardId}] ${who} chose "${label}" (option ${card.choice}) on "${card.title}".`
}

export class ChoiceCards {
  constructor(private readonly deps: ChoiceCardDeps) {}

  async create(place: ChoiceCardPlace, content: ChoiceCardContent): Promise<LocalApiReply> {
    const ids = new Set(content.options.map((o) => o.id))
    if (ids.size !== content.options.length || ids.has(EDIT_CHOICE))
      return { status: 400, body: { error: 'option ids must be unique' } }
    const surface = this.deps.surfaceFor(place)
    if (!surface) return { status: 409, body: { error: 'this integration cannot show cards' } }
    const card: ChoiceCardRow = {
      cardId: randomUUID(),
      agentId: place.agentId,
      integrationId: place.integrationId,
      platform: place.platform,
      channel: place.channel,
      thread: place.thread ?? '',
      isDm: place.isDm,
      ts: '',
      title: content.title,
      body: content.body,
      options: content.options,
      editText: content.editText ?? null,
      state: 'open',
      generation: 0,
      label: null,
      choice: null,
      clickedBy: null,
      clickedByName: null,
      editedText: null,
      createdAt: this.deps.now(),
      expiresAt: content.expiresAt ?? null,
      decidedAt: null
    }
    const ts = await surface.post(card)
    if (!ts) return { status: 502, body: { error: 'the card could not be posted' } }
    card.ts = ts
    // A top-level card is its own thread: a press runs there, as a reply to the card would.
    card.thread ||= ts
    await this.deps.ledger.record(card)
    return { status: 201, body: view(card) }
  }

  /** Whether `agentId` posted the card; an agent's tools reach only its own cards. */
  async ownedBy(cardId: string, agentId: string): Promise<boolean> {
    return (await this.deps.ledger.get(cardId))?.agentId === agentId
  }

  async read(cardId: string): Promise<LocalApiReply> {
    const card = await this.deps.ledger.get(cardId)
    return card ? { status: 200, body: view(card) } : { status: 404, body: { error: 'unknown card' } }
  }

  async update(cardId: string, patch: UpdateChoiceCard): Promise<LocalApiReply> {
    const before = await this.deps.ledger.get(cardId)
    if (!before) return { status: 404, body: { error: 'unknown card' } }
    if (before.state === 'deciding' || !(await this.deps.ledger.update(cardId, patch)))
      return { status: 409, body: { error: 'a press on this card is being handed to the agent; retry shortly' } }
    const card = (await this.deps.ledger.get(cardId))!
    await this.redraw(card)
    return { status: 200, body: view(card) }
  }

  /** A button press, judged like a message from that person: the first permitted press on an open card starts a turn. Returns what only the presser is told when the surface cannot tell them itself. */
  async click(click: CardClick): Promise<string | undefined> {
    const card = await this.deps.ledger.get(click.cardId)
    const actor = click.actor
    if (!card || !actor || card.state !== 'open') return
    const valid =
      click.choice === EDIT_CHOICE ? card.editText !== null : card.options.some((o) => o.id === click.choice)
    if (!valid) return
    if (card.expiresAt !== null && card.expiresAt <= this.deps.now()) {
      if (await this.deps.ledger.update(card.cardId, { state: 'expired' }))
        await this.redraw({ ...card, state: 'expired' })
      return
    }
    // Refused before any claim, so the card stays exactly as everyone else sees it.
    const refusal = await this.deps.judge(card, actor)
    if (refusal !== undefined) return refusal ? this.tell(card, actor.userId, refusal) : undefined
    const won = await this.deps.ledger.claim(
      card.cardId,
      card.generation,
      {
        choice: click.choice,
        clickedBy: actor.userId,
        ...(actor.name ? { clickedByName: actor.name } : {}),
        ...(click.choice === EDIT_CHOICE ? { editedText: click.editedText?.trim() || card.editText! } : {})
      },
      this.deps.now()
    )
    if (!won) return
    const pressed = (await this.deps.ledger.get(card.cardId))!
    await this.redraw(pressed)
    const admitted = await this.deps
      .startTurn(pressed, clickTurnText(pressed), choiceCardDeliveryId(pressed), async () => {
        // A failed write leaves the card deciding; the startup sweep settles it from the inbox row.
        if (!(await this.deps.ledger.decide(pressed.cardId, pressed.generation, this.deps.now()).catch(() => false)))
          this.deps.log?.warn(`choice card ${pressed.cardId}: admitted, but not marked decided`)
      })
      .catch((err: unknown) => {
        this.deps.log?.warn(`choice card ${pressed.cardId}: turn did not start: ${String(err)}`)
        return false
      })
    if (admitted) {
      await this.redraw((await this.deps.ledger.get(card.cardId))!)
      return
    }
    await this.reopen(pressed)
    return this.tell(card, actor.userId, CARD_PRESS_FAILED_TEXT)
  }

  /** Startup: a card a restart caught `deciding` is decided when its turn was admitted, else reopened. */
  async sweep(serves: (agentId: string) => boolean): Promise<void> {
    for (const card of await this.deps.ledger.deciding()) {
      if (!serves(card.agentId)) continue
      if (await this.deps.hasDelivery(choiceCardDeliveryId(card))) {
        if (await this.deps.ledger.decide(card.cardId, card.generation, this.deps.now()))
          await this.redraw((await this.deps.ledger.get(card.cardId))!)
      } else await this.reopen(card)
    }
  }

  private async reopen(card: ChoiceCardRow): Promise<void> {
    if (await this.deps.ledger.reopen(card.cardId, card.generation))
      await this.redraw((await this.deps.ledger.get(card.cardId))!)
  }

  private async redraw(card: ChoiceCardRow): Promise<void> {
    await this.deps
      .surfaceFor(card)
      ?.redraw(card)
      .catch(() => false)
  }

  private async tell(card: ChoiceCardRow, userId: string, text: string): Promise<string | undefined> {
    const surface = this.deps.surfaceFor(card)
    if (!surface?.tellPrivately) return text
    await surface.tellPrivately(card, userId, text).catch(() => undefined)
    return undefined
  }

  /** The card routes on the local socket; `place` resolves a REST caller's agent + target as the doorbell does. */
  routes(place: (req: CreateChoiceCard) => Promise<ChoiceCardPlace | LocalApiReply>): LocalApiRoute[] {
    const invalid = (error: z.ZodError): LocalApiReply => ({
      status: 400,
      body: { error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
    })
    return [
      {
        method: 'POST',
        path: '/v1/cards',
        handle: async ({ body }) => {
          const parsed = CreateChoiceCardSchema.safeParse(body)
          if (!parsed.success) return invalid(parsed.error)
          const resolved = await place(parsed.data)
          return 'status' in resolved ? resolved : this.create(resolved, parsed.data)
        }
      },
      { method: 'GET', path: '/v1/cards/:id', handle: async ({ params }) => this.read(params.id!) },
      {
        method: 'PATCH',
        path: '/v1/cards/:id',
        handle: async ({ params, body }) => {
          const parsed = UpdateChoiceCardSchema.safeParse(body)
          return parsed.success ? this.update(params.id!, parsed.data) : invalid(parsed.error)
        }
      }
    ]
  }
}
