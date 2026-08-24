import { z } from 'zod'
import type { SendIdentity, SessionContext, UploadFailReason } from './context.js'
import type { GatewayDeps } from './gateway.js'
import { parseArgs, requiredString } from './args.js'
import { platformLabel } from '../../platforms/read-ports.js'

/**
 * `shareFile` — a produced file into the CURRENT conversation
 * (docs/designs/agent-authored-attachments.md §3).
 *
 * This is the surface `sendMessage` cannot be: every visible `sendMessage` lands at a
 * channel ROOT, while "find me some images" wants the image in the thread that asked. So
 * this tool takes NO coordinates at all — the daemon posts into the active turn's own
 * conversation from trusted context (the postless-wake precedent), and no new
 * authorization question exists because the model cannot name a destination.
 *
 * It carries no routing semantics: no wake, no reply correlation, no session seeding —
 * the thread already HAS the session this turn runs in, which is why the result's
 * message id is a transcript detail here and never an anchor.
 */

/** Caption bound, refused up front: under Telegram's 1024-char native caption so every
 *  platform carries it as ONE message, and plain text by contract. */
export const SHARE_CAPTION_MAX = 1000

const pathField = requiredString('path')
const captionField = z
  .string('shareFile: `caption` must be a string')
  .max(
    SHARE_CAPTION_MAX,
    `shareFile: caption is limited to ${SHARE_CAPTION_MAX} characters (plain text, one message) — put the rest in your ordinary reply.`
  )
  .nullish()
  .transform((value) => (value?.trim() ? value.trim() : undefined))

/** Where the active turn posts: the trusted coordinates plus the per-platform anchor
 *  ingredients (docs §3.1 — one rule, four platform shapes). */
export interface ShareTurnTarget {
  platform: string
  integrationId?: string
  channel: string
  /** The platform thread coordinate, when the conversation has one. */
  thread?: string
  /** Reply-target message id on platforms that place by reply (Telegram groups). */
  replyTo?: number
}

export type ShareTargetRefusal = 'no-turn' | 'no-conversation' | 'headless'
export type ShareTargetResult = ({ ok: true } & ShareTurnTarget) | { ok: false; reason: ShareTargetRefusal }

/** The resolved, fenced, sniffed workspace image — or why it cannot be shared. */
export type ShareReadResult =
  | { ok: true; bytes: Buffer; name: string; mimeType: string; sha256: string }
  | {
      ok: false
      reason: 'sandboxed' | 'not-found' | 'escape' | 'not-image' | 'gif' | 'too-large'
      /** Bound or detail the refusal names (e.g. the per-file cap). */
      detail?: string
    }

export interface ShareFileDeps extends GatewayDeps {
  /** The active turn's trusted post target — absent outside a live daemon. */
  shareTarget?: (ctx: SessionContext) => ShareTargetResult
  /** Resolve + fence + read + sniff a workspace-relative path (docs §4): single-shot read,
   *  images only by magic bytes, name and MIME from the sniffed type. */
  readWorkspaceImage?: (ctx: SessionContext, path: string) => Promise<ShareReadResult>
  /** Synchronous per-turn byte reservation (docs §5) — charge before the upload, release on
   *  failure. Synchronous so concurrent tool calls cannot race past the budget. */
  chargeShareBudget?: (ctx: SessionContext, bytes: number) => { ok: true; release: () => void } | { ok: false }
  /** Persist the share as the agent's own transcript row, with provenance and — when the
   *  bytes fit the transcript cap — the bytes themselves for console replay. */
  recordShare?: (
    ctx: SessionContext,
    row: { ts: string; text: string; image?: { name: string; mimeType: string; data: Buffer } }
  ) => Promise<void>
  now: () => number
}

/** Neutralize mention syntax in a model-authored caption (docs §3): Slack/Discord control
 *  tokens, Feishu's `<at …>` tag (which pages `user_id="all"` from plain text), and the two
 *  broadcast words. A caption labels a file; escaping costs nothing. Discord additionally
 *  suppresses pings natively (allowedMentions). The one form with no inert spelling is a
 *  bare Telegram `@username` — the tool description says so instead of promising it away. */
export function escapeCaptionMentions(caption: string): string {
  return caption.replace(/<(?=[@#!]|at[\s>])/gi, '<\u200b').replace(/@(everyone|here)\b/gi, '@\u200b$1')
}

const READ_REFUSALS: Record<Exclude<ShareReadResult, { ok: true }>['reason'], (path: string, d?: string) => string> = {
  sandboxed: () =>
    "shareFile: this agent's sandbox is not reachable right now, so its workspace cannot be read — try again shortly.",
  'not-found': (path) => `shareFile: no file at "${path}" in this workspace.`,
  escape: (path) =>
    `shareFile: "${path}" is not a workspace-relative path — only files inside the workspace can be shared.`,
  'not-image': (path) => `shareFile: "${path}" is not a PNG, JPEG, or WEBP image — only those can be shared.`,
  gif: () =>
    'shareFile: GIF is not supported yet — only PNG, JPEG, or WEBP. Convert it first; an animated GIF would lose its animation anyway.',
  'too-large': (path, detail) => `shareFile: "${path}" is over the per-file limit${detail ? ` (${detail})` : ''}.`
}

const UPLOAD_REFUSALS: Record<Exclude<UploadFailReason, 'indeterminate'>, (platform: string) => string> = {
  missing_scope: (p) =>
    `shareFile: the ${p} integration lacks the file-upload permission — an operator has to update the app's scopes.`,
  too_large: (p) => `shareFile: ${p} rejected the file as too large.`,
  not_found: (p) => `shareFile: ${p} could not place the file in this conversation.`,
  forbidden: (p) => `shareFile: the bot may not post files in this ${p} conversation.`,
  platform_error: (p) => `shareFile: ${p} rejected the file — nothing was sent.`
}

/** The tool handler. SECURITY: every coordinate comes from the trusted session/turn context;
 *  the model supplies only a workspace-relative path and a caption. */
export async function shareFile(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: ShareFileDeps
): Promise<unknown> {
  const path = parseArgs(pathField, args.path)
  const caption = parseArgs(captionField, args.caption)

  const target = deps.shareTarget?.(ctx)
  if (!target) throw new Error('shareFile is not available in this environment.')
  if (!target.ok) {
    if (target.reason === 'headless') {
      throw new Error('shareFile: this turn is headless — it must not post anything visible.')
    }
    if (target.reason === 'no-conversation') {
      throw new Error(
        'shareFile: this session has no platform conversation to share into (it was opened by a direct agent call).'
      )
    }
    throw new Error('shareFile: no active conversation turn to share into.')
  }

  // Port-probe the platform BEFORE reading the file, so a webchat/fileless session costs no I/O.
  const integrationId = target.integrationId ?? ctx.integrationId
  const gw = integrationId ? deps.gatewayFor(integrationId) : undefined
  if (!gw) throw new Error(`no live platform connection for integration ${integrationId ?? '(none)'}`)
  if (!gw.uploadFile) {
    throw new Error(
      `shareFile: this conversation's platform (${platformLabel(target.platform)}) cannot host files yet.`
    )
  }

  if (!deps.readWorkspaceImage) throw new Error('shareFile is not available in this environment.')
  const read = await deps.readWorkspaceImage(ctx, path)
  if (!read.ok) throw new Error(READ_REFUSALS[read.reason](path, read.detail))

  const charge = deps.chargeShareBudget?.(ctx, read.bytes.byteLength) ?? { ok: true as const, release: () => {} }
  if (!charge.ok) {
    throw new Error("shareFile: this turn's upload budget is exhausted — stop sharing files this turn.")
  }

  const identity: SendIdentity = {
    ...(ctx.agentName ? { username: ctx.agentName } : {}),
    ...(ctx.iconUrl ? { icon_url: ctx.iconUrl } : {}),
    agentAuthorId: ctx.agentId
  }
  const escaped = caption ? escapeCaptionMentions(caption) : undefined
  const outcome = await gw.uploadFile(
    target.channel,
    { bytes: read.bytes, name: read.name, mimeType: read.mimeType },
    escaped,
    {
      ...(target.thread !== undefined ? { thread: target.thread } : {}),
      ...(target.replyTo !== undefined ? { replyTo: target.replyTo } : {})
    },
    identity
  )
  if (!outcome.ok) {
    charge.release()
    if (outcome.reason === 'indeterminate') {
      throw new Error(
        'shareFile: the upload timed out and MAY still have been delivered — do NOT retry; say the image may have gone through instead.'
      )
    }
    const refusal = UPLOAD_REFUSALS[outcome.reason](platformLabel(target.platform))
    throw new Error(outcome.detail ? `${refusal} (${outcome.detail})` : refusal)
  }

  // Provenance (docs §4): the model-chosen path plus what was ACTUALLY published — sniffed
  // type, size, digest — and the bytes for console replay when they fit the transcript cap.
  const marker = `[shared: ${path} (${read.mimeType}, ${read.bytes.byteLength} bytes, sha256:${read.sha256.slice(0, 16)})]`
  const ts = outcome.messageId ?? `local-${deps.now()}`
  // The image is already in the conversation past this point, so a store failure must NOT
  // read as a failed share — a thrown error here would invite the double-posting retry the
  // whole outcome vocabulary exists to prevent. Degrade to a notice instead.
  const recorded = await (
    deps.recordShare?.(ctx, {
      ts,
      text: escaped ? `${escaped}\n${marker}` : marker,
      image: { name: read.name, mimeType: read.mimeType, data: read.bytes }
    }) ?? Promise.resolve()
  )
    .then(() => true)
    .catch(() => false)

  const notices = [
    ...(outcome.warning ? [`This send partly failed: ${outcome.warning}.`] : []),
    ...(recorded
      ? []
      : ['The image was posted, but recording it in the transcript failed — the console may not show it.'])
  ]
  return {
    ok: true,
    shared: { path, mimeType: read.mimeType, bytes: read.bytes.byteLength, sha256: read.sha256 },
    post: { platform: target.platform, channel: target.channel, ts },
    ...(notices.length ? { notice: notices.join(' ') } : {})
  }
}
