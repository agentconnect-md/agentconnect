import type { ChoiceCards } from '../../cards/choice-cards.js'
import type { LocalApiReply } from '../../local-api/server.js'
import type { SessionContext } from './context.js'

export interface ChoiceCardOpsDeps {
  /** Sticky choice cards; absent ⇒ the card tools refuse. */
  choiceCards?: () => ChoiceCards
}

function cards(deps: ChoiceCardOpsDeps): ChoiceCards {
  const service = deps.choiceCards?.()
  if (!service) throw new Error('choice cards are not available in this environment.')
  return service
}

function settle(reply: LocalApiReply): unknown {
  if (reply.status >= 400)
    throw new Error(String((reply.body as { error?: unknown })?.error ?? `failed (${reply.status})`))
  return reply.body
}

/** Post a card into THIS conversation; every coordinate comes from the trusted session, never the model. */
export async function postChoiceCard(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: ChoiceCardOpsDeps
): Promise<unknown> {
  if (!ctx.integrationId) throw new Error('postChoiceCard: this session has no platform conversation.')
  return settle(
    await cards(deps).create({
      agent: ctx.agentId,
      integrationId: ctx.integrationId,
      channel: ctx.channel,
      thread: ctx.deliveryThread,
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
      options: (Array.isArray(args.options) ? args.options : []) as { id: string; label: string }[],
      ...(typeof args.editText === 'string' ? { editText: args.editText } : {})
    })
  )
}

/** Only this agent's own cards can be read or changed by it. */
async function ownCard(ctx: SessionContext, deps: ChoiceCardOpsDeps, cardId: unknown): Promise<{ id: string }> {
  const id = String(cardId ?? '')
  if (!(await cards(deps).ownedBy(id, ctx.agentId))) throw new Error('unknown card')
  return settle(await cards(deps).read(id)) as { id: string }
}

export async function readChoiceCard(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: ChoiceCardOpsDeps
): Promise<unknown> {
  return ownCard(ctx, deps, args.cardId)
}

export async function updateChoiceCard(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: ChoiceCardOpsDeps
): Promise<unknown> {
  const card = await ownCard(ctx, deps, args.cardId)
  return settle(
    await cards(deps).update(card.id, {
      ...(typeof args.state === 'string' ? { state: args.state } : {}),
      ...(typeof args.label === 'string' || args.label === null ? { label: args.label as string | null } : {})
    })
  )
}
