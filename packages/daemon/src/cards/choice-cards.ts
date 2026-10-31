import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ChoiceCardLedger, ChoiceCardRow } from '../store/choice-cards.js'
import type { LocalApiReply, LocalApiRoute } from '../local-api/server.js'

/** A platform that can show a card and redraw it; only Slack implements one today. */
export interface ChoiceCardSurface {
  post(card: ChoiceCardRow): Promise<string | undefined>
  redraw(card: ChoiceCardRow): Promise<boolean>
}

export const CreateChoiceCardSchema = z.object({
  agent: z.string().min(1),
  channel: z.string().min(1),
  thread: z.string().min(1),
  title: z.string().min(1).max(150),
  body: z.string().max(2900).default(''),
  options: z
    .array(z.object({ id: z.string().min(1).max(60), label: z.string().min(1).max(75) }))
    .min(1)
    .max(5),
  /** Show an editable text field holding this value, with a "Send edited" button. */
  editText: z.string().min(1).max(2900).optional(),
  expiresAt: z.number().int().positive().optional(),
  integrationId: z.string().min(1).optional()
})
export type CreateChoiceCard = z.infer<typeof CreateChoiceCardSchema>

export const UpdateChoiceCardSchema = z
  .object({ state: z.string().min(1).max(40).optional(), label: z.string().max(300).nullable().optional() })
  .refine((p) => p.state !== undefined || p.label !== undefined, 'state or label is required')

/** The edit choice's id, distinct from any option id a caller may pick. */
export const EDIT_CHOICE = '__edit__'

export interface CardClick {
  cardId: string
  choice: string
  editedText?: string
  actor?: { userId: string; name?: string }
}

export interface ChoiceCardDeps {
  ledger: ChoiceCardLedger
  /** Resolve an agent by id or name to its id and the integration a card posts through. */
  resolveAgent(
    agent: string,
    integrationId?: string
  ): { agentId: string; integrationId: string; platform: string } | undefined
  surfaceFor(integrationId: string): ChoiceCardSurface | undefined
  /** Start the turn a winning click asks for, in the card's thread, with the clicker as sender. */
  startTurn(card: ChoiceCardRow, text: string): Promise<void>
  now(): number
  log?: { warn(msg: string): void }
}

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

/** The words a winning click hands the agent; the card id lets it read the card back. */
export function clickTurnText(card: ChoiceCardRow): string {
  const who = card.clickedByName ?? card.clickedBy ?? 'someone'
  if (card.choice === EDIT_CHOICE)
    return `[card ${card.cardId}] ${who} edited "${card.title}" and chose Send edited:\n${card.editedText ?? ''}`
  const label = card.options.find((o) => o.id === card.choice)?.label ?? card.choice
  return `[card ${card.cardId}] ${who} chose "${label}" (option ${card.choice}) on "${card.title}".`
}

export class ChoiceCards {
  constructor(private readonly deps: ChoiceCardDeps) {}

  async create(req: CreateChoiceCard): Promise<LocalApiReply> {
    const ids = new Set(req.options.map((o) => o.id))
    if (ids.size !== req.options.length || ids.has(EDIT_CHOICE))
      return { status: 400, body: { error: 'option ids must be unique' } }
    const agent = this.deps.resolveAgent(req.agent, req.integrationId)
    if (!agent) return { status: 404, body: { error: `unknown agent "${req.agent}" or integration` } }
    const surface = this.deps.surfaceFor(agent.integrationId)
    if (!surface) return { status: 409, body: { error: 'this integration cannot show cards' } }
    const card: ChoiceCardRow = {
      cardId: randomUUID(),
      agentId: agent.agentId,
      integrationId: agent.integrationId,
      platform: agent.platform,
      channel: req.channel,
      thread: req.thread,
      ts: '',
      title: req.title,
      body: req.body,
      options: req.options,
      editText: req.editText ?? null,
      state: 'open',
      label: null,
      choice: null,
      clickedBy: null,
      clickedByName: null,
      editedText: null,
      createdAt: this.deps.now(),
      expiresAt: req.expiresAt ?? null,
      decidedAt: null
    }
    const ts = await surface.post(card)
    if (!ts) return { status: 502, body: { error: 'the card could not be posted' } }
    card.ts = ts
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

  async update(cardId: string, patch: { state?: string; label?: string | null }): Promise<LocalApiReply> {
    if (!(await this.deps.ledger.update(cardId, patch))) return { status: 404, body: { error: 'unknown card' } }
    const card = (await this.deps.ledger.get(cardId))!
    await this.deps.surfaceFor(card.integrationId)?.redraw(card)
    return { status: 200, body: view(card) }
  }

  /** A button press: the first one on an open card wins, settles it, and starts a turn. */
  async click(click: CardClick): Promise<boolean> {
    const card = await this.deps.ledger.get(click.cardId)
    if (!card || !click.actor) return false
    const valid =
      click.choice === EDIT_CHOICE ? card.editText !== null : card.options.some((o) => o.id === click.choice)
    if (!valid) return false
    const won = await this.deps.ledger.claim(
      card.cardId,
      {
        choice: click.choice,
        clickedBy: click.actor.userId,
        ...(click.actor.name ? { clickedByName: click.actor.name } : {}),
        ...(click.choice === EDIT_CHOICE ? { editedText: click.editedText?.trim() || card.editText! } : {})
      },
      this.deps.now()
    )
    const settled = (await this.deps.ledger.get(card.cardId))!
    if (!won) {
      if (settled.state === 'open' && settled.expiresAt !== null && settled.expiresAt <= this.deps.now()) {
        await this.deps.ledger.update(card.cardId, { state: 'expired' })
        await this.deps.surfaceFor(card.integrationId)?.redraw({ ...settled, state: 'expired' })
      }
      return false
    }
    await this.deps.surfaceFor(card.integrationId)?.redraw(settled)
    await this.deps.startTurn(settled, clickTurnText(settled))
    return true
  }

  routes(): LocalApiRoute[] {
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
          return parsed.success ? this.create(parsed.data) : invalid(parsed.error)
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
