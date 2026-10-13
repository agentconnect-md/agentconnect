// Asking before the bot joins a channel (#2979): a call refused because the bot is not in a public channel waits for a person behind the turn.
import { askerMayRead, CLOSED_LOOKUPS, NOBODY, sourceClass } from '../../assistant/place-access.js'
import { JOIN_ASK_WAIT_TEXT, type JoinAsk, type JoinOutcome } from '../../permissions/join-confirmation.js'
import { notJoinedChannel } from '../../platforms/not-joined.js'
import type { MessageGateway, SessionContext, UploadOutcome } from './context.js'
import { knownIntegrations } from './gateway.js'
import { describeConversation, type PlaceAccessDeps } from './place-gate.js'

/** What a join confirmation asks, on the bot it would join through. */
export interface JoinRequest extends JoinAsk {
  integrationId: string
}

export interface JoinAskDeps {
  /** Ask a person behind the turn whether the bot may join; absent ⇒ the bot never joins. */
  confirmJoin?: (ctx: SessionContext, ask: JoinRequest) => Promise<JoinOutcome>
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
  deps: PlaceAccessDeps & JoinAskDeps
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
  const answer = await deps
    .confirmJoin(ctx, { integrationId, channel, name, purpose, askers: askers.people })
    .catch((): JoinOutcome => 'unavailable')
  if (answer !== 'join') throw refused(tool, ANSWERED[answer](name, purpose))
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
  deps: PlaceAccessDeps & JoinAskDeps
): MessageGateway {
  const join = gw.joinChannel?.bind(gw)
  if (!join) return gw
  const retried = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call()
    } catch (err) {
      const channel = notJoinedChannel(err)
      if (channel === undefined || !(await joinAfterAsking(ctx, tool, integrationId, channel, join, deps))) throw err
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
            if (!(await joinAfterAsking(ctx, tool, integrationId, channel, join, deps))) return first
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
