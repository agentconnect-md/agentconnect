// Asking before the bot joins a channel (#2979): a call refused because the bot is not in a public channel waits for a person behind the turn, after the tool call returned.
import { askerMayRead, CLOSED_LOOKUPS, NOBODY, sourceClass } from '../../assistant/place-access.js'
import type { ReadAsker } from '../../assistant/place-access.js'
import {
  JOIN_ASK_WAIT_TEXT,
  type JoinAnswer,
  type JoinAsk,
  type JoinOffered,
  type JoinOutcome
} from '../../permissions/join-confirmation.js'
import { notJoinedChannel } from '../../platforms/not-joined.js'
import type { MessageGateway, SessionContext, UploadOutcome } from './context.js'
import { knownIntegrations } from './gateway.js'
import { describeConversation, type PlaceAccessDeps } from './place-gate.js'

/** What a join confirmation asks, on the bot it would join through. */
export interface JoinRequest extends JoinAsk {
  integrationId: string
}

/** A call waiting on a join confirmation, as its tool result names it. */
export interface JoinParked {
  tool: string
  /** The person behind the turn who answered Join, whom the call's result then speaks for. */
  by?: ReadAsker
  name: string
  purpose: JoinRequest['purpose']
  /** Who was asked, when known. */
  to: string | null
  /** The thread the asking turn replied in, where the turn its outcome starts replies too. */
  thread?: string
}

/** A parked call's late outcome: what it returned, or why it did nothing. */
export type JoinDelivery = JoinParked & ({ result: unknown } | { error: string })

export interface JoinAskDeps {
  /** Ask a person behind the turn whether the bot may join, calling `offered` once a card is up; absent ⇒ the bot never joins. */
  confirmJoin?: (ctx: SessionContext, ask: JoinRequest, offered: JoinOffered) => Promise<JoinAnswer>
  /** Hand a parked call's outcome to its session as a message; absent ⇒ the call waits for the answer instead. */
  deliverJoinOutcome?: (ctx: SessionContext, outcome: JoinDelivery) => void
}

/** The reads that ask to read a channel; every other tool asks to post there. */
const READ_TOOLS: ReadonlySet<string> = new Set(['getChannelHistory', 'getThreadHistory'])

const nothing = (purpose: JoinRequest['purpose']): string =>
  purpose === 'read' ? 'Nothing was read' : 'Nothing was sent'

/** The refusal for a turn no person is behind, or one whose people no card could reach. */
export function notInChannelText(name: string, purpose: JoinRequest['purpose']): string {
  return `the bot is not in #${name}; invite it, or ask from a conversation. ${nothing(purpose)}.`
}

const ANSWERED: Record<Exclude<JoinOutcome, 'join'>, (name: string, purpose: JoinRequest['purpose']) => string> = {
  declined: (name, purpose) =>
    `the bot did not join #${name}: the person asked chose not to let it. ${nothing(purpose)}; say so, and do not ask ` +
    'again unless they ask you to.',
  expired: (name, purpose) =>
    `the bot did not join #${name}: nobody answered whether it may within ${JOIN_ASK_WAIT_TEXT}. ${nothing(purpose)}; say so.`,
  unavailable: notInChannelText
}

/** What the session of a call whose card a restart expired is told: the timeout's own words. */
export function joinExpiredText(tool: string, name: string, purpose: JoinRequest['purpose']): string {
  return `${tool}: ${ANSWERED.expired(name, purpose)}`
}

/** A tool call that did not join a channel, as the call fails with it; a caller that tolerates other read failures rethrows it. */
export class JoinRefused extends Error {}

const refused = (tool: string, why: string): Error => new JoinRefused(`${tool}: ${why}`)

/** Ask before the bot joins `channel`, then join it: false where joining cannot help (not a public channel), else throws the refusal. */
async function joinAfterAsking(
  ctx: SessionContext,
  tool: string,
  integrationId: string,
  channel: string,
  join: (channel: string) => Promise<void>,
  deps: PlaceAccessDeps & JoinAskDeps,
  parked?: (call: JoinParked) => void
): Promise<boolean> {
  const purpose = READ_TOOLS.has(tool) ? 'read' : 'post'
  const platform = knownIntegrations(ctx).find((i) => i.id === integrationId)?.platform ?? ctx.platform
  const place = await describeConversation(ctx, { platform, channel }, integrationId, deps)
  if (sourceClass(place) !== 'public') return false
  const name = place.name ?? channel
  const askers = deps.readAskers ? await deps.readAskers(ctx).catch(() => NOBODY) : NOBODY
  if (askers.nobody || askers.people.length === 0 || !deps.confirmJoin)
    throw refused(tool, notInChannelText(name, purpose))
  // Every person behind the turn may access the channel, the rule its reads and posts already passed.
  const lookups = deps.readLookups?.(ctx.agentId) ?? CLOSED_LOOKUPS
  for (const asker of askers.people)
    if (!(await askerMayRead(asker, place, integrationId, lookups).catch(() => false)))
      throw refused(tool, notInChannelText(name, purpose))
  const call: JoinParked = { tool, name, purpose, to: null }
  const answer = await deps
    .confirmJoin(ctx, { integrationId, channel, name, purpose, tool, askers: askers.people }, (to, thread) =>
      parked?.(Object.assign(call, { to }, thread !== undefined ? { thread } : {}))
    )
    .catch((): JoinAnswer => ({ outcome: 'unavailable' }))
  if (answer.outcome !== 'join') throw refused(tool, ANSWERED[answer.outcome](name, purpose))
  if (answer.by) call.by = answer.by
  await join(channel).catch(() => {
    throw refused(tool, `the bot could not join #${name}. ${nothing(purpose)}.`)
  })
  return true
}

/** The gateway a tool acts through: a call refused because the bot is not in a public channel asks first, joins, and runs once more. */
export function askingToJoin(
  ctx: SessionContext,
  tool: string,
  integrationId: string,
  gw: MessageGateway,
  deps: PlaceAccessDeps & JoinAskDeps,
  parked?: (call: JoinParked) => void
): MessageGateway {
  const join = gw.joinChannel?.bind(gw)
  if (!join) return gw
  const retried = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call()
    } catch (err) {
      const channel = notJoinedChannel(err)
      if (channel === undefined || !(await joinAfterAsking(ctx, tool, integrationId, channel, join, deps, parked)))
        throw err
      return await call()
    }
  }
  const wrapped: Partial<MessageGateway> = {
    postMessage: (channel, ...rest) => retried(() => gw.postMessage(channel, ...rest)),
    ...(gw.getChannelHistory
      ? { getChannelHistory: (channel, ...rest) => retried(() => gw.getChannelHistory!(channel, ...rest)) }
      : {}),
    ...(gw.getThreadReplies
      ? { getThreadReplies: (channel, ...rest) => retried(() => gw.getThreadReplies!(channel, ...rest)) }
      : {}),
    ...(gw.uploadFile
      ? {
          uploadFile: async (channel, ...rest): Promise<UploadOutcome> => {
            const first = await gw.uploadFile!(channel, ...rest)
            if (first.ok || first.notJoined !== true) return first
            if (!(await joinAfterAsking(ctx, tool, integrationId, channel, join, deps, parked))) return first
            return await gw.uploadFile!(channel, ...rest)
          }
        }
      : {})
  }
  return new Proxy(gw, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(wrapped, prop)) return wrapped[prop as keyof MessageGateway]
      const value: unknown = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** One join confirmation in flight for a session's channel: its later answer, whom it was offered to and in which thread, and calls waiting to hear that. */
export interface JoinFlight {
  answer: Promise<JoinAnswer>
  offered?: { to: string | null; thread?: string }
  waiters: JoinOffered[]
}

/** The most of a late result handed back in one message. */
const DELIVERED_RESULT_MAX = 40_000

/** The message a parked call's session reads once the call finished. */
export function joinOutcomeText(outcome: JoinDelivery): string {
  const head = `[join confirmation] Your ${outcome.tool} call that waited on #${outcome.name}`
  const tail = 'This is a daemon notification, not a message from anyone.'
  if ('error' in outcome) return `${head} did nothing. ${outcome.error}\n\n${tail}`
  const result = JSON.stringify(outcome.result ?? null, null, 2)
  const shown =
    result.length > DELIVERED_RESULT_MAX ? `${result.slice(0, DELIVERED_RESULT_MAX)}\n… (truncated)` : result
  return (
    `${head} ran once the bot joined. Its result:\n\n${shown}\n\n${tail} Finish what you needed it for; ` +
    'if nothing is left to do, stay silent.'
  )
}

/** What the runtime reads at once: who was asked, and that the outcome follows as a message. */
function parkedResult(call: JoinParked): Record<string, unknown> {
  const who = call.to ?? 'the person who asked'
  const done = call.purpose === 'read' ? 'read' : 'sent'
  return {
    joinRequested: true,
    channel: `#${call.name}`,
    note:
      `Asked ${who} to let the bot join #${call.name}; nothing was ${done} yet. The result follows in this ` +
      `conversation as a message once they answer, or after ${JOIN_ASK_WAIT_TEXT} with no answer. Do not repeat ` +
      'this call: say you asked, and end your turn if nothing else is left.'
  }
}

/** Run a handler, returning at once when a join confirmation is offered; the call then finishes in the background and its outcome reaches the session. */
export async function parkingOnJoin(
  ctx: SessionContext,
  deps: JoinAskDeps,
  run: (parked?: (call: JoinParked) => void) => Promise<unknown>
): Promise<unknown> {
  const deliver = deps.deliverJoinOutcome
  if (!deliver) return await run()
  let park!: (call: JoinParked) => void
  const parkedAt = new Promise<JoinParked>((resolve) => (park = resolve))
  const running = run(park)
  const first = await Promise.race([
    running.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    ),
    parkedAt.then((call) => ({ call }))
  ])
  if ('call' in first) {
    const call = first.call
    void running.then(
      (result) => deliver(ctx, { ...call, result }),
      (err: unknown) => deliver(ctx, { ...call, error: (err as Error).message })
    )
    return parkedResult(call)
  }
  if ('error' in first) throw first.error
  return first.value
}
