/**
 * The platform tools that CHANGE something without posting a message: reactions,
 * conversation creation, scheduled sends, and canvases.
 *
 * They act on THIS session's platform only — `integrationId` may pick another of the agent's
 * bots there, resolved against the trusted session snapshot, never tool input — and are
 * gated by a port the platform DECLARES rather than by its name: injected for a session on
 * a declaring platform, absent everywhere else. What is different is the failure mode: a read
 * that finds nothing is an empty list, while these either did the thing or did not, so each one
 * lets the platform's own refusal (`missing_scope`, `name_taken`, `not_in_channel`) reach the agent verbatim.
 *
 * NONE of them is a delivery path for the agent's own voice. `sendMessage` and `shareFile`
 * remain the only two, and `scheduleMessage` is deliberately channel-root only for the same
 * reason `sendMessage` is (send-message-routing-rework.md §2.2).
 */
import { z } from 'zod'
import type { PlatformCanvasEdit } from '../../platforms/contract.js'
import { platformLabel } from '../../platforms/read-ports.js'
import type { SessionContext } from './context.js'
import { resolveGatewayForPlatform, type GatewayDeps } from './gateway.js'
import { optionalBoolean, optionalBoundedInt, optionalString, parseArgs, requiredEnum, requiredString } from './args.js'

/** Slack's own bounds on a scheduled send, and the only ones any platform states. */
const MIN_SCHEDULE_LEAD_MS = 2 * 60 * 1000
const MAX_SCHEDULE_HORIZON_MS = 120 * 24 * 60 * 60 * 1000

const botSelector = { integrationId: optionalString('integrationId') }

export const ADD_REACTION_ARGS = z.object({
  ...botSelector,
  channel: optionalString('channel'),
  messageTs: requiredString('messageTs'),
  emoji: requiredString('emoji')
})

export const GET_REACTIONS_ARGS = z.object({
  ...botSelector,
  channel: optionalString('channel'),
  messageTs: requiredString('messageTs')
})

export const CREATE_CONVERSATION_ARGS = z.object({
  ...botSelector,
  name: optionalString('name'),
  isPrivate: optionalBoolean('isPrivate'),
  users: z.array(requiredString('users')).max(100, 'users accepts at most 100 ids').optional()
})

export const SCHEDULE_MESSAGE_ARGS = z.object({
  ...botSelector,
  channel: optionalString('channel'),
  message: requiredString('message'),
  postAt: requiredString('postAt')
})

export const LIST_BOOKMARKS_ARGS = z.object({ ...botSelector, channel: optionalString('channel') })

export const ADD_BOOKMARK_ARGS = z.object({
  ...botSelector,
  channel: optionalString('channel'),
  title: requiredString('title'),
  link: requiredString('link'),
  emoji: optionalString('emoji')
})

export const REMOVE_BOOKMARK_ARGS = z.object({
  ...botSelector,
  channel: optionalString('channel'),
  bookmarkId: requiredString('bookmarkId')
})

export const READ_LIST_ARGS = z.object({
  ...botSelector,
  listId: requiredString('listId'),
  cursor: optionalString('cursor'),
  limit: optionalBoundedInt('limit', 1, 200)
})

const listFields = z
  .array(
    z.object({
      columnId: requiredString('columnId'),
      type: requiredString('type'),
      value: z.unknown()
    }),
    'fields must be an array of { columnId, type, value }'
  )
  .min(1, 'fields must name at least one column')

export const ADD_LIST_ITEM_ARGS = z.object({
  ...botSelector,
  listId: requiredString('listId'),
  fields: listFields
})

export const UPDATE_LIST_ITEM_ARGS = z.object({
  ...botSelector,
  listId: requiredString('listId'),
  itemId: requiredString('itemId'),
  fields: listFields
})

export const CREATE_CANVAS_ARGS = z.object({
  ...botSelector,
  title: requiredString('title').max(255, 'title must be at most 255 characters'),
  markdown: requiredString('markdown'),
  channel: optionalString('channel')
})

export const READ_CANVAS_ARGS = z.object({ ...botSelector, canvasId: requiredString('canvasId') })

export const UPDATE_CANVAS_ARGS = z.object({
  ...botSelector,
  canvasId: requiredString('canvasId'),
  edits: z
    .array(
      z.object({
        operation: requiredEnum('operation', [
          'replace',
          'insert_at_start',
          'insert_at_end',
          'insert_before',
          'insert_after',
          'delete'
        ]),
        sectionId: optionalString('sectionId'),
        markdown: optionalString('markdown')
      })
    )
    .min(1, 'edits must contain at least one change')
    .max(20, 'edits accepts at most 20 changes')
})

/** These tools need only the live gateway; the reads' history fallbacks do not apply. */
export type PlatformActionDeps = GatewayDeps

/** Resolve the target gateway plus the channel the call acts on, with the current
 *  conversation's channel defaulting in only for this session's own bot — another bot has no
 *  meaningful "current channel", exactly as `listChannelMembers` has it. */
function resolveTarget(
  ctx: SessionContext,
  deps: PlatformActionDeps,
  parsed: { integrationId?: string; channel?: string },
  what: string
) {
  const platform = ctx.platform
  const { gw, sameConvo } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  const channel = parsed.channel ?? (sameConvo ? ctx.channel : undefined)
  if (!channel) throw new Error(`channel is required to ${what} on ${platform} (another bot than this session's)`)
  return { platform, gw, channel }
}

/** The refusal every handler here gives when the resolved connection lacks the facet the
 *  registry promised — a bot that is up but on a build or transport without it. */
function unsupported(platform: string, what: string): Error {
  return new Error(`${what} is unavailable on this ${platformLabel(platform)} connection`)
}

export async function addReaction(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(ADD_REACTION_ARGS, args)
  const { platform, gw, channel } = resolveTarget(ctx, deps, parsed, 'react to a message')
  if (!gw.addReaction) throw unsupported(platform, 'reactions')
  // Slack takes the shortcode bare; a model that wrapped it in colons meant the same thing.
  const emoji = parsed.emoji.replace(/^:|:$/g, '')
  await gw.addReaction(channel, parsed.messageTs, emoji)
  return { platform, channel, messageTs: parsed.messageTs, emoji, added: true }
}

export async function getReactions(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(GET_REACTIONS_ARGS, args)
  const { platform, gw, channel } = resolveTarget(ctx, deps, parsed, 'read reactions')
  if (!gw.getReactions) throw unsupported(platform, 'reactions')
  return { platform, channel, messageTs: parsed.messageTs, reactions: await gw.getReactions(channel, parsed.messageTs) }
}

/**
 * The conversation a bookmark tool acts on.
 *
 * `ctx.channel` is a default ONLY for this session's own integration. A call that picks another
 * bot by `integrationId` may not be in this channel at all, and handing it the id just fails
 * with `channel_not_found` — the shared selector contract already says another bot must name
 * its channel, and `sameConvo` is how the resolver reports it.
 */
function bookmarkChannel(ctx: SessionContext, named: string | undefined, sameConvo: boolean): string {
  if (named) return named
  if (!sameConvo) throw new Error('channel is required when the bookmark is on another bot')
  return ctx.channel
}

export async function listBookmarks(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(LIST_BOOKMARKS_ARGS, args)
  const platform = ctx.platform
  const { gw, sameConvo } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.listBookmarks) throw unsupported(platform, 'bookmarks')
  const channel = bookmarkChannel(ctx, parsed.channel, sameConvo)
  return { platform, channel, bookmarks: await gw.listBookmarks(channel) }
}

export async function addBookmark(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(ADD_BOOKMARK_ARGS, args)
  const platform = ctx.platform
  const { gw, sameConvo } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.addBookmark) throw unsupported(platform, 'bookmarks')
  const channel = bookmarkChannel(ctx, parsed.channel, sameConvo)
  const bookmark = await gw.addBookmark(channel, {
    title: parsed.title,
    link: parsed.link,
    ...(parsed.emoji ? { emoji: parsed.emoji } : {})
  })
  return { platform, channel, bookmark }
}

export async function removeBookmark(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(REMOVE_BOOKMARK_ARGS, args)
  const platform = ctx.platform
  const { gw, sameConvo } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.removeBookmark) throw unsupported(platform, 'bookmarks')
  const channel = bookmarkChannel(ctx, parsed.channel, sameConvo)
  await gw.removeBookmark(channel, parsed.bookmarkId)
  return { platform, channel, removed: parsed.bookmarkId }
}

export async function readList(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(READ_LIST_ARGS, args)
  const platform = ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.readList) throw unsupported(platform, 'lists')
  const page = await gw.readList(parsed.listId, {
    ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {})
  })
  return { platform, listId: parsed.listId, ...page }
}

export async function addListItem(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(ADD_LIST_ITEM_ARGS, args)
  const platform = ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.addListItem) throw unsupported(platform, 'lists')
  return { platform, listId: parsed.listId, item: await gw.addListItem(parsed.listId, parsed.fields) }
}

export async function updateListItem(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(UPDATE_LIST_ITEM_ARGS, args)
  const platform = ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.updateListItem) throw unsupported(platform, 'lists')
  await gw.updateListItem(parsed.listId, parsed.itemId, parsed.fields)
  return { platform, listId: parsed.listId, itemId: parsed.itemId, updated: true }
}

export async function createConversation(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(CREATE_CONVERSATION_ARGS, args)
  const platform = ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.createConversation) throw unsupported(platform, 'creating conversations')
  const users = parsed.users ?? []
  if (!parsed.name && users.length === 0) throw new Error('pass `name` to create a channel, or `users` to open a DM')
  if (!parsed.name && parsed.isPrivate !== undefined)
    throw new Error('`isPrivate` describes a channel; drop it, or pass `name` to create one')
  const conversation = await gw.createConversation({
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.isPrivate !== undefined ? { isPrivate: parsed.isPrivate } : {}),
    ...(users.length > 0 ? { users } : {})
  })
  return { platform, conversation }
}

export async function scheduleMessage(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(SCHEDULE_MESSAGE_ARGS, args)
  const { platform, gw, channel } = resolveTarget(ctx, deps, parsed, 'schedule a message')
  if (!gw.scheduleMessage) throw unsupported(platform, 'scheduled messages')
  const at = Date.parse(parsed.postAt)
  if (Number.isNaN(at)) throw new Error(`postAt is not an ISO-8601 instant: ${parsed.postAt}`)
  // Both bounds are the platform's, checked here so the agent gets a repairable message
  // instead of a bare `time_in_past` / `time_too_far` from the provider.
  const lead = at - Date.now()
  if (lead < MIN_SCHEDULE_LEAD_MS) throw new Error('postAt must be at least 2 minutes in the future')
  if (lead > MAX_SCHEDULE_HORIZON_MS) throw new Error('postAt must be at most 120 days in the future')
  const postAt = Math.floor(at / 1000)
  const scheduled = await gw.scheduleMessage(channel, parsed.message, postAt)
  return { platform, ...scheduled, postAtIso: new Date(postAt * 1000).toISOString() }
}

export async function createCanvas(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(CREATE_CANVAS_ARGS, args)
  const platform = ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.createCanvas) throw unsupported(platform, 'canvases')
  return { platform, canvas: await gw.createCanvas(parsed.title, parsed.markdown, parsed.channel) }
}

export async function readCanvas(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(READ_CANVAS_ARGS, args)
  const platform = ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.readCanvas) throw unsupported(platform, 'canvases')
  return { platform, canvas: await gw.readCanvas(parsed.canvasId) }
}

export async function updateCanvas(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: PlatformActionDeps
): Promise<unknown> {
  const parsed = parseArgs(UPDATE_CANVAS_ARGS, args)
  const platform = ctx.platform
  const { gw } = resolveGatewayForPlatform(ctx, deps, platform, parsed.integrationId)
  if (!gw.updateCanvas) throw unsupported(platform, 'canvases')
  // Reject here rather than at the provider: an anchored edit with no section, or a
  // content edit with no body, is a mistake the agent can fix from the message.
  const edits: PlatformCanvasEdit[] = parsed.edits.map((edit) => {
    const anchored = edit.operation === 'insert_before' || edit.operation === 'insert_after'
    if ((anchored || edit.operation === 'delete') && !edit.sectionId)
      throw new Error(`${edit.operation} needs a sectionId from readCanvas`)
    if (edit.operation !== 'delete' && !edit.markdown) throw new Error(`${edit.operation} needs markdown`)
    return {
      operation: edit.operation,
      ...(edit.sectionId ? { sectionId: edit.sectionId } : {}),
      ...(edit.markdown ? { markdown: edit.markdown } : {})
    }
  })
  await gw.updateCanvas(parsed.canvasId, edits)
  return { platform, canvasId: parsed.canvasId, applied: edits.length }
}
