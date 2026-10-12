// Who is asking on a turn, and the live lookups behind the read rule (assistant-mode.md §5.5): a short cache over the platform and the Control Plane.
import type { MessageGateway } from '../mcp/ops/context.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { ConsoleVerdict, ReadAsker, ReadLookups, TurnAskers } from './place-access.js'

/** How long a member listing, a workspace standing or a console verdict is trusted before it is asked again. */
export const PLACE_MEMBERS_TTL_MS = 60_000
const MAX_ENTRIES = 512

export interface PlaceMembersHost {
  now(): number
  gatewayFor(
    integrationId: string
  ): Pick<MessageGateway, 'getChannelInfo' | 'listMemberIds' | 'isFullMember'> | undefined
  /** The console's session visibility for whoever is behind the asker, from the Control Plane; rejects when it cannot be asked. */
  readAccess?(
    agentId: string,
    asker: ReadAsker,
    sessionIds: readonly string[],
    ownerOnly: boolean
  ): Promise<ConsoleVerdict>
}

interface Entry<T> {
  at: number
  value: Promise<T>
}

export class PlaceMembers {
  private readonly members = new Map<string, Entry<ReadonlySet<string>>>()
  private readonly standing = new Map<string, Entry<boolean>>()
  private readonly verdicts = new Map<string, Entry<ConsoleVerdict>>()

  constructor(private readonly host: PlaceMembersHost) {}

  /** Whether `user` is a current member of `channel` on that bot; false whenever it cannot be confirmed. */
  async isMember(integrationId: string, channel: string, user: string): Promise<boolean> {
    const members = await this.cached(this.members, `${integrationId}\u001f${channel}`, async () => {
      const gw = this.host.gatewayFor(integrationId)
      if (!gw?.listMemberIds) throw new Error('no member listing on this connection')
      return new Set(await gw.listMemberIds(channel))
    }).catch(() => undefined)
    return members?.has(user) === true
  }

  /** Whether `user` is a full member of that bot's workspace; false whenever it cannot be confirmed. */
  async isFullMember(integrationId: string, user: string): Promise<boolean> {
    return await this.cached(this.standing, `${integrationId}\u001f${user}`, async () => {
      const gw = this.host.gatewayFor(integrationId)
      if (!gw?.isFullMember) throw new Error('no workspace standing on this connection')
      return await gw.isFullMember(user)
    }).catch(() => false)
  }

  /** Who the console says is behind the asker and which of these sessions they could see; rejects when it cannot be asked. */
  async consoleVerdict(
    agentId: string,
    asker: ReadAsker,
    sessionIds: readonly string[],
    ownerOnly = false
  ): Promise<ConsoleVerdict> {
    const ask = this.host.readAccess
    if (!ask) throw new Error('no console verdict on this daemon')
    const key = [agentId, askerKey(asker), String(ownerOnly), ...[...sessionIds].sort()].join('\u001f')
    return await this.cached(this.verdicts, key, () => ask(agentId, asker, sessionIds, ownerOnly))
  }

  /** The read rule's lookups for one agent. */
  lookupsFor(agentId: string): ReadLookups {
    return {
      member: (integrationId, channel, userId) => this.isMember(integrationId, channel, userId),
      fullMember: (integrationId, userId) => this.isFullMember(integrationId, userId),
      console: (asker, sessionIds, ownerOnly) => this.consoleVerdict(agentId, asker, sessionIds, ownerOnly)
    }
  }

  /** One lookup per key within the TTL; a failed one is dropped so the next read asks again. */
  private cached<T>(map: Map<string, Entry<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const now = this.host.now()
    const hit = map.get(key)
    if (hit && now - hit.at < PLACE_MEMBERS_TTL_MS) return hit.value
    const value = load()
    map.delete(key)
    map.set(key, { at: now, value })
    value.catch(() => {
      if (map.get(key)?.value === value) map.delete(key)
    })
    if (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    return value
  }
}

/** One message a turn answers, as far as the read rule needs it. */
export interface TurnMessage {
  msg: Pick<NormalizedMessage, 'source' | 'sender' | 'platform' | 'headless'>
  /** The bot it arrived on. */
  integrationId?: string
  /** It came from the console: webchat, or a console continuation of a chat session. */
  console?: boolean
  /** The person a message no one typed runs for: a schedule's recorded console user. */
  person?: ReadAsker
}

/** The person behind one message, or null for one no person sent. */
export function askerOf(m: TurnMessage, bot: string | undefined): ReadAsker | null {
  const { msg } = m
  if (m.person) return m.person
  if (msg.headless || msg.source !== 'user' || msg.sender.isBot || !msg.sender.id) return null
  if (m.console) return { kind: 'console', userId: msg.sender.id }
  const integrationId = m.integrationId ?? bot
  return integrationId ? { kind: 'member', platform: msg.platform, integrationId, userId: msg.sender.id } : null
}

const askerKey = (a: ReadAsker): string =>
  a.kind === 'console' ? `console\u001f${a.userId}` : `${a.platform}\u001f${a.integrationId}\u001f${a.userId}`

/** Everyone a turn's messages speak for; in a sub-session, a message no person sent speaks for whoever opened it. */
export function turnAskers(messages: readonly TurnMessage[], bot: string | undefined, opener?: TurnAskers): TurnAskers {
  const people = new Map<string, ReadAsker>()
  let nobody = messages.length === 0
  for (const m of messages) {
    const asker = askerOf(m, bot)
    if (asker) people.set(askerKey(asker), asker)
    else if (!opener) nobody = true
    else {
      for (const p of opener.people) people.set(askerKey(p), p)
      nobody ||= opener.nobody
    }
  }
  return { people: [...people.values()], nobody: nobody || people.size === 0 }
}

/** An item's follower as a person: `user:<id>` a console user, `<platform>:<tenant>:<uid>` a chat member on the bot the item came through. */
export function askerOfFollower(
  identity: string,
  platform: string,
  integrationId: string | undefined
): ReadAsker | undefined {
  if (identity.startsWith('user:'))
    return identity.length > 5 ? { kind: 'console', userId: identity.slice(5) } : undefined
  const userId = identity.slice(identity.lastIndexOf(':') + 1)
  if (!integrationId || !identity.startsWith(`${platform}:`) || !userId) return undefined
  return { kind: 'member', platform, integrationId, userId }
}
