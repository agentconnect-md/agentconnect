// Live membership behind assistant mode's per-asker reads (assistant-mode.md §5.5): a short cache over the platform's member listing.
import type { MessageGateway, SessionContext } from '../mcp/ops/context.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { isSubsessionCoordinate } from '../session/subsession-coordinate.js'
import type { PlaceAsker } from './place-access.js'

/** How long a member listing or a DM's counterpart is trusted before the platform is asked again. */
export const PLACE_MEMBERS_TTL_MS = 60_000
const MAX_ENTRIES = 512

export interface PlaceMembersHost {
  now(): number
  gatewayFor(integrationId: string): Pick<MessageGateway, 'getChannelInfo' | 'listMemberIds'> | undefined
}

type Gateway = NonNullable<ReturnType<PlaceMembersHost['gatewayFor']>>

interface Entry<T> {
  at: number
  value: Promise<T>
}

export class PlaceMembers {
  private readonly members = new Map<string, Entry<ReadonlySet<string>>>()
  private readonly counterparts = new Map<string, Entry<string | undefined>>()

  constructor(private readonly host: PlaceMembersHost) {}

  /** Whether `user` is a current member of `channel` on that bot; false whenever it cannot be confirmed. */
  async isMember(integrationId: string, channel: string, user: string): Promise<boolean> {
    const members = await this.cached(this.members, integrationId, channel, async (gw) => {
      if (!gw.listMemberIds) throw new Error('no member listing on this connection')
      return new Set(await gw.listMemberIds(channel))
    }).catch(() => undefined)
    return members?.has(user) === true
  }

  /** The asker in their own 1:1 DM: its counterpart, when their own platform message started the live turn there. */
  async askerIn(ctx: SessionContext, msg: NormalizedMessage | undefined): Promise<PlaceAsker | undefined> {
    const integrationId = ctx.integrationId
    // A sub-session or patrol session never has an asker, whoever its parent was.
    if (!ctx.isDm || integrationId === undefined || !msg || isSubsessionCoordinate(ctx.thread)) return undefined
    // A report round, an agent's wake, a scheduled run or a console continuation is not the counterpart asking.
    if (msg.source !== 'user' || msg.sender.isBot || msg.adoptedSession || msg.headless || !msg.isDm) return undefined
    if (!msg.sender.id || msg.platform !== ctx.platform || msg.channel !== ctx.channel) return undefined
    const counterpart = await this.cached(this.counterparts, integrationId, ctx.channel, async (gw) => {
      const info = await gw.getChannelInfo(ctx.channel)
      return info.isIm === true ? info.user : undefined
    }).catch(() => undefined)
    return counterpart !== undefined && counterpart === msg.sender.id
      ? { integrationId, userId: counterpart }
      : undefined
  }

  /** One lookup per bot and conversation within the TTL; a failed one is dropped so the next read asks again. */
  private cached<T>(
    map: Map<string, Entry<T>>,
    integrationId: string,
    channel: string,
    load: (gw: Gateway) => Promise<T>
  ): Promise<T> {
    const key = `${integrationId}\u001f${channel}`
    const now = this.host.now()
    const hit = map.get(key)
    if (hit && now - hit.at < PLACE_MEMBERS_TTL_MS) return hit.value
    const gw = this.host.gatewayFor(integrationId)
    if (!gw) return Promise.reject(new Error('no live connection for this bot'))
    const value = load(gw)
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
