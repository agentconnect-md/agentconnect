import type { McpContentResult, MessageGateway, SessionContext } from './context.js'
import {
  integrationsOnPlatform,
  MULTI_INTEGRATION_NOTE,
  resolveGatewayForPlatform,
  type GatewayDeps
} from './gateway.js'
import { optionalString, requireString } from './validate.js'

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** The platform-neutral read deps: live gateways plus the history-backed fallbacks for
 *  platforms whose bot API cannot enumerate chats or users. */
export interface PlatformReadDeps extends GatewayDeps {
  /** Conversation targets this agent has been triggered in on a platform, from local
   *  session history. Backs the `listChannels` fallback for platforms whose bot API
   *  can't enumerate chats (Telegram). Absent ⇒ no fallback (empty live list stands). */
  observedChannels?: (agentId: string, platform: string) => Promise<{ id: string; name?: string }[]>
  /** Users this agent has been triggered by on a platform, from local session history.
   *  Backs `listKnownUsers` so an agent can find a user id to DM where there is no
   *  user directory to search. */
  observedUsers?: (agentId: string, platform: string) => Promise<{ id: string; name?: string }[]>
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

// Known-users discovery is history-backed (no live gateway needed) — a memory of who
// has messaged this agent on a platform, for platforms with no user directory to search
// (Telegram/Discord). Handled before gateway resolution so it works even if that
// platform's connection is momentarily down. The local session store is keyed by
// agent+platform, NOT by integration, so when the agent has MORE THAN ONE bot on the
// platform the pooled history can't be attributed to a specific bot (and a Telegram/
// Discord chat reached via bot A is not reachable by bot B). Suppress the ambiguous
// result rather than return ids that may belong to another bot; a specific target is
// still reachable via getUserProfile(integrationId) once known.
// ponytail: single-integration attribution; add a per-integration `sessions.integrationId`
// column if multi-bot-per-platform discovery ever needs the observed history scoped.
export async function listKnownUsers(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const platform = optionalString(args, 'platform') ?? ctx.platform
  if (integrationsOnPlatform(ctx, platform).length === 0) throw new Error(`this agent has no ${platform} integration`)
  if (integrationsOnPlatform(ctx, platform).length > 1) return { platform, users: [], note: MULTI_INTEGRATION_NOTE }
  return { platform, users: (await deps.observedUsers?.(ctx.agentId, platform)) ?? [] }
}

// Platform-neutral READ tools. Like the send path, they route by a `platform`
// argument (defaulting to the current session's platform) to ANY platform the agent
// is connected to — so an agent handling a Telegram chat can discover Slack channel /
// user ids to cross-post. Resolved BEFORE the session-gateway gate so the target need
// not be the integration that triggered this session. SECURITY: the candidate set comes
// from the trusted session snapshot, never tool input.
export async function listChannels(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const platform = optionalString(args, 'platform') ?? ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, optionalString(args, 'integrationId'))
  const live = await gw.listChannels()
  // A platform whose bot API can't enumerate chats (Telegram) returns []; fall back to
  // the chats this agent has actually been active in, from local session history.
  if (live.length > 0) return { platform, channels: live, source: 'live' }
  // The observed fallback is agent+platform-scoped, not per-integration: suppress it
  // when the agent has multiple bots on this platform (see listKnownUsers note).
  if (integrationsOnPlatform(ctx, platform).length > 1)
    return { platform, channels: [], source: 'observed', note: MULTI_INTEGRATION_NOTE }
  const observed = (await deps.observedChannels?.(ctx.agentId, platform)) ?? []
  return { platform, channels: observed, source: observed.length > 0 ? 'observed' : 'live' }
}

export async function listChannelMembers(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const platform = optionalString(args, 'platform') ?? ctx.platform
  const { gw, sameConvo } = resolveGatewayForPlatform(ctx, deps, platform, optionalString(args, 'integrationId'))
  // The current channel only defaults in for a same-platform read; a different
  // platform has no meaningful "current channel", so `channel` is required there.
  const channel = optionalString(args, 'channel') ?? (sameConvo ? ctx.channel : undefined)
  if (!channel)
    throw new Error(`channel is required to list members on ${platform} (a different platform than this session)`)
  return { platform, channel, members: await gw.listMembers(channel) }
}

export async function getUserProfile(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformReadDeps
): Promise<unknown> {
  const platform = optionalString(args, 'platform') ?? ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, optionalString(args, 'integrationId'))
  const user = requireString(args, 'user')
  return { platform, ...(await gw.getUserProfile(user)) }
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
  const url = requireString(args, 'url')
  const max = deps.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
  const bytes = await gw.downloadFile(url, max)
  if (!bytes) {
    throw new Error(
      `could not download the file at ${url} — it may be inaccessible, larger than ${max} bytes, or the bot ` +
        `may lack permission to read it (e.g. the Slack files:read scope)`
    )
  }
  const mimeType = optionalString(args, 'mimeType') ?? guessMimeFromUrl(url) ?? 'application/octet-stream'
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
