// Where a place opens on its platform: every console surface that names a conversation resolves its link here.
import { channelListSemantics, platformThreadShape } from '@/components/console/platforms/registry'
import { isAppendCoordinate } from '@agentconnect.md/protocol/append-coordinate'
import { isSubsessionCoordinate } from '@agentconnect.md/protocol/subsession-coordinate'
import type { BotDto } from '@/lib/api'
import type { IntegrationChannelRow, IntegrationRow } from '@/lib/data'

/** The bot fields a conversation link can depend on. */
export type ConversationLinkBot = { workspaceId?: string | null; feishuRegion?: 'feishu' | 'lark' | null }

/** The conversation directory a place is looked up in: the org's integrations and the bots behind them. */
export interface PlaceDirectory {
  integrations: readonly Pick<IntegrationRow, 'id' | 'agentId' | 'botId' | 'platform' | 'region' | 'channels'>[]
  bots: readonly Pick<BotDto, 'id' | 'workspaceId' | 'feishuRegion'>[]
}

/** A conversation as a session or a schedule names it: its platform ids, plus what narrows the directory lookup. */
export interface PlaceRef {
  platform: string
  channelId: string
  /** The workspace the conversation lives in (Slack's "T…" team id), where the caller holds one. */
  workspaceId?: string | null
  feishuRegion?: 'feishu' | 'lark' | null
  /** The integration that reaches the conversation, where the caller holds one; else the agent's is preferred. */
  integrationId?: string | null
  agentId?: string | null
}

/** The page the row opens on the platform: the one its daemon reported, else the one its module builds from the row's ids. */
export const rowUrl = (
  c: IntegrationChannelRow,
  platform: string | undefined,
  bot: ConversationLinkBot | undefined
): string | undefined =>
  c.url ??
  channelListSemantics(platform).conversationUrl?.({
    channelId: c.channelId,
    ...(c.spaceId ? { spaceId: c.spaceId } : {}),
    ...(c.kind ? { kind: c.kind } : {}),
    workspaceId: bot?.workspaceId ?? null,
    feishuRegion: bot?.feishuRegion ?? null
  })

/** A conversation's page on its platform: its directory row's, else the one its module builds from the ids alone. */
export function conversationUrl(place: PlaceRef, directory: PlaceDirectory): string | undefined {
  const holders = directory.integrations.filter(
    (i) =>
      i.platform === place.platform &&
      (!place.integrationId || i.id === place.integrationId) &&
      i.channels.some((c) => c.channelId === place.channelId)
  )
  const holder = holders.find((i) => place.agentId && i.agentId === place.agentId) ?? holders[0]
  const row = holder?.channels.find((c) => c.channelId === place.channelId)
  if (holder && row) {
    const bot = directory.bots.find((b) => b.id === holder.botId)
    return rowUrl(row, place.platform, {
      workspaceId: bot?.workspaceId ?? place.workspaceId ?? null,
      feishuRegion: bot?.feishuRegion ?? holder.region ?? place.feishuRegion ?? null
    })
  }
  // No row says what kind of conversation this is, so a module links it only where the ids alone settle the page.
  return channelListSemantics(place.platform).conversationUrl?.({
    channelId: place.channelId,
    kind: 'unknown',
    workspaceId: place.workspaceId ?? null,
    feishuRegion: place.feishuRegion ?? null
  })
}

/** A session's place as its page knows it: the conversation, the thread it runs in and any link its daemon reported. */
export interface SessionPlaceRef extends Omit<PlaceRef, 'channelId'> {
  channelId?: string | null
  thread?: string | null
  threadUrl?: string | null
}

/** What a session's place opens: its own thread, else the conversation it runs in. */
export interface PlaceLink {
  url: string
  opens: 'thread' | 'conversation'
}

const isSyntheticCoordinate = (thread: string): boolean => isAppendCoordinate(thread) || isSubsessionCoordinate(thread)

/** Where a session's place opens: the link its daemon reported, else its thread's page, else its conversation's. */
export function sessionPlaceLink(session: SessionPlaceRef, directory: PlaceDirectory): PlaceLink | undefined {
  if (session.threadUrl) return { url: session.threadUrl, opens: 'thread' }
  const { channelId, thread } = session
  if (!channelId) return undefined
  // A session on a synthetic coordinate (a whole conversation's, a coordinator's, a task's) runs in no platform thread.
  const shape = platformThreadShape(session.platform)
  const root = thread && thread !== channelId && !isSyntheticCoordinate(thread) ? thread : undefined
  const input = root ? { channelId, workspaceId: session.workspaceId ?? null, rootId: root } : undefined
  const threadUrl = !input
    ? undefined
    : shape
      ? shape.isThreadId(input.rootId)
        ? shape.threadUrl?.(input)
        : undefined
      : channelListSemantics(session.platform).threadUrl?.(input)
  if (threadUrl) return { url: threadUrl, opens: 'thread' }
  const url = conversationUrl({ ...session, channelId }, directory)
  return url ? { url, opens: 'conversation' } : undefined
}
