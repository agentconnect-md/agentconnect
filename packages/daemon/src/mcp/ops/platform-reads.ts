import { z } from 'zod'
import type { PlatformThreadMessage } from '../../platforms/contract.js'
import { platformLabel } from '../../platforms/read-ports.js'
import type { McpContentResult, MessageGateway, SessionContext } from './context.js'
import {
  ambiguousIntegrations,
  askOnlyWithChannel,
  askWhichIntegration,
  integrationsOnPlatform,
  MULTI_INTEGRATION_NOTE,
  resolveGatewayForPlatform,
  type GatewayDeps
} from './gateway.js'
import type { AskDeps } from '../ask.js'
import { optionalBoundedInt, optionalString, parseArgs, requiredString } from './args.js'

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** `listKnownUsers` arguments — history-backed, so the bot comes from the session or the ask below, never from tool input. */
export const LIST_KNOWN_USERS_ARGS = z.object({ platform: optionalString('platform') })

/** `listChannels` arguments. */
export const LIST_CHANNELS_ARGS = z.object({
  platform: optionalString('platform'),
  integrationId: optionalString('integrationId')
})

/** `listChannelMembers` arguments; `channel` defaults to the current one on the same platform. */
export const LIST_CHANNEL_MEMBERS_ARGS = z.object({
  platform: optionalString('platform'),
  integrationId: optionalString('integrationId'),
  channel: optionalString('channel')
})

/** `getUserProfile` arguments. */
export const GET_USER_PROFILE_ARGS = z.object({
  platform: optionalString('platform'),
  integrationId: optionalString('integrationId'),
  user: requiredString('user')
})

/** `getChannelHistory` arguments; the channel is always the current context channel. */
export const GET_CHANNEL_HISTORY_ARGS = z.object({
  cursor: optionalString('cursor'),
  limit: optionalBoundedInt('limit', 1, 200),
  oldest: optionalString('oldest'),
  latest: optionalString('latest')
})

/** `getThreadHistory` arguments; `channel` defaults to the current one on the same platform. */
export const GET_THREAD_HISTORY_ARGS = z.object({
  integrationId: optionalString('integrationId'),
  channel: optionalString('channel'),
  thread: requiredString('thread'),
  limit: optionalBoundedInt('limit', 1, 200),
  oldest: optionalString('oldest'),
  latest: optionalString('latest')
})

const DEFAULT_THREAD_HISTORY_LIMIT = 100

/** Every platform's credentialed attachment read (`readSlackFile`, `readTelegramFile`, …). */
export const READ_ATTACHMENT_ARGS = z.object({
  url: requiredString('url'),
  mimeType: optionalString('mimeType')
})

/** The platform-neutral read deps: live gateways plus the history-backed fallbacks for platforms whose bot API cannot enumerate chats or users. `AskDeps` is restated rather than inherited by accident: these reads ask on their OWN (`historyBot`), not only through the resolver. */
export interface PlatformReadDeps extends GatewayDeps, AskDeps {
  /** Conversation targets this agent has been triggered in on a platform, from local session history; backs the `listChannels` fallback for platforms whose bot API can't enumerate chats (Telegram), and absent ⇒ no fallback (the empty live list stands). `integrationId` scopes the answer to ONE physical bot's history; omitted ⇒ the agent's only bot on the platform, and nothing at all when it has several. */
  observedChannels?: (
    agentId: string,
    platform: string,
    integrationId?: string
  ) => Promise<{ id: string; name?: string }[]>
  /** Users this agent has been triggered by on a platform, from local session history; backs `listKnownUsers` so an agent can find a user id to DM where there is no user directory to search. `integrationId` scopes it to one bot, as above. */
  observedUsers?: (
    agentId: string,
    platform: string,
    integrationId?: string
  ) => Promise<{ id: string; name?: string }[]>
  /** Byte cap for `read*File` downloads (defaults to 8 MiB). */
  maxAttachmentBytes?: number
}

/** Best-effort MIME guess from a Slack file URL's extension (used when the caller
 *  doesn't pass a mimeType hint). */
function guessMimeFromUrl(url: string): string | undefined {
  const ext = url.split('?')[0]?.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv'
  }
  return ext ? map[ext] : undefined
}

/** Whose observed history a read may see. */
interface HistoryBot {
  /** The bot to read; undefined ⇒ the agent's only bot on the platform, which the daemon resolves. */
  integrationId?: string
  /** Set only when a HUMAN named it, so an empty result can say whose history was empty instead of inviting the same card again. */
  chosen?: string
}

/** #1965 Gap A: which bot's history a history-backed read sees. The guard is {@link ambiguousIntegrations}: this session's own bot answers "whose history", and it is the bot an unqualified `sendMessage` resolves to, so the ids this read returns stay reachable. Genuinely ambiguous (several bots on the target platform, none of them this session's) ⇒ ask the agent's own host over that trusted enum, under the SAME key `resolveGatewayForPlatform` asks with, so a read that resolved a gateway first reuses that answer instead of asking twice. Undefined ⇒ the ask cannot be made, was declined, or named an id we never offered, and the caller falls through to the suppressed result. */
function historyBot(
  ctx: SessionContext,
  deps: PlatformReadDeps,
  platform: string,
  purpose: string
): HistoryBot | undefined {
  const ambiguous = ambiguousIntegrations(ctx, platform)
  // Nothing to guess: this session's own bot on the platform, else the agent's only one there.
  if (ambiguous.length === 0) {
    const own = integrationsOnPlatform(ctx, platform).find((i) => i.id === ctx.integrationId)
    return { ...(own ? { integrationId: own.id } : {}) }
  }
  const chosen = askWhichIntegration(
    deps,
    platform,
    ambiguous.map((i) => i.id),
    purpose
  )
  return chosen ? { integrationId: chosen, chosen } : undefined
}

/** A read a human disambiguated came back empty: name whose history was empty, so the model reports that instead of re-calling the tool and putting the same question in front of the same human again (answers live in the SDK's per-call state, so a fresh call always asks afresh). */
function emptyHistoryNote(platform: string, integrationId: string): string {
  return (
    `The \`${integrationId}\` ${platformLabel(platform)} bot has no observed history. That is this bot's answer ` +
    'and not a platform-wide one, and re-calling this tool asks the human the same question again.'
  )
}

// Known-users discovery is history-backed (no live gateway needed, so it works even if that platform's connection is momentarily down) — a memory of who has messaged this agent, for platforms with no user directory to search (Telegram/Discord). What a caller gets is ONE physical bot's history: a chat reached via bot A is not reachable by bot B, so the bot is this session's own where that is one of them, and otherwise the read asks its own host (#1965 Gap A) instead of returning ids that may belong to another. Replay-safe by POSITION: nothing above the ask but argument parsing.
export async function listKnownUsers(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const platform = parseArgs(LIST_KNOWN_USERS_ARGS, args).platform ?? ctx.platform
  if (integrationsOnPlatform(ctx, platform).length === 0) throw new Error(`this agent has no ${platform} integration`)
  const bot = historyBot(ctx, deps, platform, 'list the users it has seen')
  // No answer to be had: today's exact result, note included.
  if (!bot) return { platform, users: [], note: MULTI_INTEGRATION_NOTE }
  const users = (await deps.observedUsers?.(ctx.agentId, platform, bot.integrationId)) ?? []
  const note = bot.chosen !== undefined && users.length === 0 ? emptyHistoryNote(platform, bot.chosen) : undefined
  return { platform, users, ...(note ? { note } : {}) }
}

// Platform-neutral READ tools: like the send path they route by a `platform` argument (defaulting to the current session's) to ANY platform the agent is connected to, so an agent handling a Telegram chat can discover Slack channel/user ids to cross-post — resolved BEFORE the session-gateway gate so the target need not be the integration that triggered this session. SECURITY: the candidate set comes from the trusted session snapshot, never tool input.
export async function listChannels(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const parsed = parseArgs(LIST_CHANNELS_ARGS, args)
  const platform = parsed.platform ?? ctx.platform
  const suppressed = { platform, channels: [], source: 'observed', note: MULTI_INTEGRATION_NOTE }
  const observedResult = async (bot: HistoryBot) => {
    const channels = (await deps.observedChannels?.(ctx.agentId, platform, bot.integrationId)) ?? []
    const note = bot.chosen !== undefined && channels.length === 0 ? emptyHistoryNote(platform, bot.chosen) : undefined
    // Where the returned list came from: an empty fallback leaves the (equally empty) live answer standing.
    return { platform, channels, source: channels.length > 0 ? 'observed' : 'live', ...(note ? { note } : {}) }
  }
  // THE REPLAY RULE, positionally: the ask is now inside `resolveGatewayForPlatform`, BEFORE this live enumeration — so the asking round spends no platform call, the answering round spends exactly one, and it spends it on the bot the human named rather than on whichever candidate came first.
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId, {
    ask: true,
    purpose: 'list channels'
  })
  const live = await gw.listChannels()
  // A platform whose bot API can't enumerate chats (Telegram) returns []; fall back to the chats this agent has actually been active in, from local session history.
  if (live.length > 0) return { platform, channels: live, source: 'live' }
  // The fallback is ONE physical bot's history: a named integration IS that bot (what the suppression note asks for), otherwise this session's own bot, otherwise the host's answer.
  if (parsed.integrationId) return await observedResult({ integrationId: parsed.integrationId })
  const bot = historyBot(ctx, deps, platform, 'list the chats it has been active in')
  return bot ? await observedResult(bot) : suppressed
}

export async function listChannelMembers(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const parsed = parseArgs(LIST_CHANNEL_MEMBERS_ARGS, args)
  const platform = parsed.platform ?? ctx.platform
  const { gw, sameConvo } = resolveGatewayForPlatform(
    ctx,
    deps,
    platform,
    parsed.integrationId,
    askOnlyWithChannel(parsed.channel, 'list the members of this channel')
  )
  // The current channel only defaults in for a same-platform read; a different platform has no meaningful "current channel", so `channel` is required there.
  const channel = parsed.channel ?? (sameConvo ? ctx.channel : undefined)
  if (!channel)
    throw new Error(`channel is required to list members on ${platform} (a different platform than this session)`)
  return { platform, channel, members: await gw.listMembers(channel) }
}

export async function getUserProfile(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const parsed = parseArgs(GET_USER_PROFILE_ARGS, args)
  const platform = parsed.platform ?? ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId, {
    ask: true,
    purpose: 'read this user profile'
  })
  return { platform, ...(await gw.getUserProfile(parsed.user)) }
}

/** Read one bounded page from the current session's channel only. */
export async function getChannelHistory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const parsed = parseArgs(GET_CHANNEL_HISTORY_ARGS, args)
  const gw = ctx.integrationId ? deps.gatewayFor(ctx.integrationId) : undefined
  if (!gw) throw new Error(`no live platform connection for integration ${ctx.integrationId ?? '(none)'}`)
  if (!gw.getChannelHistory) throw new Error('channel history is unavailable on this connection')
  const page = await gw.getChannelHistory(ctx.channel, {
    ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    ...(parsed.oldest ? { oldest: parsed.oldest } : {}),
    ...(parsed.latest ? { latest: parsed.latest } : {})
  })
  return {
    platform: ctx.platform,
    channel: ctx.channel,
    messages: page.messages,
    hasMore: page.hasMore,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
  }
}

/** One thread message, projected for the agent. The provider row carries daemon-internal
 *  attribution (`chromeOwnerAgentId`, `appId`) that means nothing to a reader. */
function projectThreadMessage(m: PlatformThreadMessage): unknown {
  const attachments = m.attachments.flatMap((a) => {
    const file = a as { name?: string; mimeType?: string; sourceUrl?: string }
    return file?.name ? [{ name: file.name, mimeType: file.mimeType, url: file.sourceUrl }] : []
  })
  return {
    sender: m.sender,
    ts: m.ts,
    text: m.text,
    isBot: m.isBot,
    ...(m.agentAuthorId ? { agentId: m.agentAuthorId } : {}),
    ...(attachments.length > 0 ? { attachments } : {})
  }
}

/**
 * Read one thread's root + replies — the provider read the daemon already uses to rebuild
 * mid-thread context, handed to the agent for a thread it is NOT answering.
 *
 * Status chrome is dropped: it is this daemon's own streaming placeholders, and a reader
 * asking what a thread says has no use for them. That happens AFTER the provider applied
 * `limit`, so a chrome-heavy thread returns fewer messages than asked for — `truncated`
 * still reports whether the provider had more.
 */
export async function getThreadHistory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const parsed = parseArgs(GET_THREAD_HISTORY_ARGS, args)
  const platform = ctx.platform
  const { gw, sameConvo } = resolveGatewayForPlatform(
    ctx,
    deps,
    platform,
    parsed.integrationId,
    askOnlyWithChannel(parsed.channel, 'read this thread')
  )
  const channel = parsed.channel ?? (sameConvo ? ctx.channel : undefined)
  if (!channel) throw new Error(`channel is required to read a thread on ${platform} (another bot than this session's)`)
  if (!gw.getThreadReplies)
    throw new Error(`thread history is unavailable on this ${platformLabel(platform)} connection`)
  const readState = { truncated: false }
  const messages = await gw.getThreadReplies(channel, parsed.thread, parsed.limit ?? DEFAULT_THREAD_HISTORY_LIMIT, {
    ...(parsed.oldest ? { oldest: parsed.oldest } : {}),
    ...(parsed.latest ? { latest: parsed.latest } : {}),
    // A tool call reports the platform's own refusal (not_in_channel, thread_not_found)
    // rather than the empty list the daemon's own best-effort backfill settles for.
    throwOnError: true,
    readState
  })
  return {
    platform,
    channel,
    thread: parsed.thread,
    truncated: readState.truncated,
    messages: messages.filter((m) => !m.chrome).map(projectThreadMessage)
  }
}

// Any platform's CREDENTIALED attachment read (`readSlackFile`, `readTelegramFile`, …).
// ONE body for all of them: a platform contributes only the descriptor by declaring the
// read port, and the fetch itself is the Layer-1 `downloadFile` every connection has, on
// the gateway this session is already bound to.
export async function readAttachment(
  args: Record<string, unknown>,
  deps: PlatformReadDeps,
  gw: MessageGateway
): Promise<unknown> {
  const { url, mimeType: mimeTypeHint } = parseArgs(READ_ATTACHMENT_ARGS, args)
  const max = deps.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
  const bytes = await gw.downloadFile(url, max)
  if (!bytes) {
    throw new Error(
      `could not download the file at ${url} — it may be inaccessible, larger than ${max} bytes, or the bot ` +
        `may lack permission to read it (e.g. the Slack files:read scope)`
    )
  }
  const mimeType = mimeTypeHint ?? guessMimeFromUrl(url) ?? 'application/octet-stream'
  if (mimeType.startsWith('image/')) {
    const result: McpContentResult = {
      mcpContent: [{ type: 'image', data: bytes.toString('base64'), mimeType }]
    }
    return result
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'text/csv') {
    const result: McpContentResult = { mcpContent: [{ type: 'text', text: bytes.toString('utf8') }] }
    return result
  }
  // Non-image binary: don't inline a base64 blob as text; report what we got.
  const result: McpContentResult = {
    mcpContent: [
      { type: 'text', text: `Downloaded ${bytes.byteLength} bytes of ${mimeType} (binary — not shown inline).` }
    ]
  }
  return result
}

/** The session's own conversation, read through the gateway it is already bound to. */
export async function getCurrentChannel(ctx: SessionContext, gw: MessageGateway): Promise<unknown> {
  const info = await gw.getChannelInfo(ctx.channel).catch(() => undefined)
  return { channel: ctx.channel, thread: ctx.thread, name: info?.name ?? null, isIm: info?.isIm ?? null }
}
