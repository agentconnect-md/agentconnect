// Assistant mode's place rules on the bridge (assistant-mode.md §5.5): reads pass the place rule, writes stay here.
import {
  checkPlaceRead,
  placeRefusalMessage,
  samePlace,
  type PlaceKind,
  type PlaceReadTool,
  type PlaceRef,
  type SourcePlace
} from '../../assistant/place-access.js'
import type { InterceptedPost, PostInterception } from '../../assistant/drafts.js'
import type { SessionRecord, TranscriptRow, TranscriptSessionScope } from '../../store/local-store.js'
import type { SessionContext } from './context.js'
import { knownIntegrations, type GatewayDeps } from './gateway.js'

/** The slice of the daemon store the place rules read: session rows and this agent's own transcript. */
export interface PlaceStore {
  listSessions(agentId: string): Promise<SessionRecord[]>
  latestSession(agentId: string, channel: string): Promise<SessionRecord | undefined>
  transcriptPageForAgent(
    scope: TranscriptSessionScope,
    beforeSeq: number | null,
    limit: number
  ): Promise<{ rows: TranscriptRow[]; hasMore: boolean }>
  getDisplayNames(ids: string[]): Promise<Map<string, string>>
}

/** One conversation in an integration's snapshot (membership listing and observed chats): its kind and `isPrivate`. */
export interface PlaceSnapshotRow {
  kind?: 'channel' | 'im' | 'mpim'
  isPrivate?: boolean
}

export interface PlaceAccessDeps extends GatewayDeps {
  /** Whether the agent is in assistant mode now, read per call so a switch applies to open sessions. */
  assistantModeFor?: (agentId: string) => boolean
  /** The agent's integration behind a session's transport scope, for a place it reached through that bot. */
  placeIntegrationFor?: (agentId: string, platform: string, transportScope?: string | null) => string | undefined
  /** The integration's snapshot row for a conversation, so privacy needs no platform call when it is known. */
  placeSnapshot?: (integrationId: string, channel: string) => PlaceSnapshotRow | undefined
  placeStore?: PlaceStore
  /** Whether the session's own conversation is an external place (assistant-mode.md §5.3). */
  placeExternal?: (ctx: SessionContext) => boolean
  /** Drafts a post to another place for approval, or lets a granted one through; absent ⇒ such a post is refused. */
  assistantDraftPost?: (ctx: SessionContext, post: InterceptedPost) => Promise<PostInterception>
}

/** The gate's word on a call it lets through: `draft` sends the post through approval (§5.5). */
export type PlaceVerdict = { draft: true } | undefined

const KIND_STRICTNESS: Record<PlaceKind, number> = { channel: 1, group_dm: 2, dm: 3, webchat: 3 }
const SNAPSHOT_KINDS: Record<NonNullable<PlaceSnapshotRow['kind']>, PlaceKind> = {
  channel: 'channel',
  im: 'dm',
  mpim: 'group_dm'
}

function stricter(a: PlaceKind | undefined, b: PlaceKind | undefined): PlaceKind | undefined {
  if (!a || !b) return a ?? b
  return KIND_STRICTNESS[b] > KIND_STRICTNESS[a] ? b : a
}

/** A place's kind from the conversation kinds its session rows recorded; the strictest one wins. */
export function kindFromRows(platform: string, kinds: Iterable<string | null | undefined>): PlaceKind | undefined {
  if (platform === 'webchat') return 'webchat'
  let kind: PlaceKind | undefined
  for (const recorded of kinds) {
    if (recorded === 'dm' || recorded === 'group_dm' || recorded === 'channel') kind = stricter(kind, recorded)
  }
  return kind
}

const shared = (kind: PlaceKind | undefined): boolean => kind === 'channel' || kind === 'group_dm'

/** Describe a place from its session rows and the snapshot; `getChannelInfo` fills only what they leave open. */
export async function describePlace(
  place: PlaceRef,
  rowKind: PlaceKind | undefined,
  integrationId: string | undefined,
  deps: Pick<PlaceAccessDeps, 'gatewayFor' | 'placeSnapshot'>
): Promise<SourcePlace> {
  const snapshot = integrationId ? deps.placeSnapshot?.(integrationId, place.channel) : undefined
  let kind = stricter(rowKind, snapshot?.kind ? SNAPSHOT_KINDS[snapshot.kind] : undefined)
  let isPrivate = snapshot?.isPrivate
  if (kind === undefined || (shared(kind) && isPrivate === undefined)) {
    const gw = integrationId ? deps.gatewayFor(integrationId) : undefined
    const info = gw ? await gw.getChannelInfo(place.channel).catch(() => undefined) : undefined
    if (info) {
      kind = stricter(kind, info.isIm ? 'dm' : info.isMpim ? 'group_dm' : 'channel')
      if (isPrivate === undefined && typeof info.isPrivate === 'boolean') isPrivate = info.isPrivate
    }
  }
  return {
    platform: place.platform,
    channel: place.channel,
    ...(kind ? { kind } : {}),
    ...(shared(kind) && isPrivate !== undefined ? { private: isPrivate } : {})
  }
}

/** The channel-addressed platform reads that pass the place rule. */
const PLACE_READS: ReadonlyMap<string, PlaceReadTool> = new Map<string, PlaceReadTool>([
  ['getChannelHistory', 'getChannelHistory'],
  ['getThreadHistory', 'getThreadHistory'],
  ['getReactions', 'getReactions'],
  ['listBookmarks', 'listBookmarks']
])

const absent = (value: unknown): boolean => value === undefined || value === null

/** Does a platform write land in the current place: this session's bot, platform and conversation? */
function targetsHere(ctx: SessionContext, platform: unknown, integrationId: unknown, channel: unknown): boolean {
  if (ctx.integrationId === undefined) return false
  return (
    (absent(platform) ? ctx.platform : platform) === ctx.platform &&
    (absent(integrationId) ? ctx.integrationId : integrationId) === ctx.integrationId &&
    channel === ctx.channel
  )
}

const ANOTHER_CONVERSATION = 'another conversation'

/** The platform writes; the agent-to-agent forms and the parent-session reply of sendMessage are not among them. */
const PLATFORM_WRITES = new Set([
  'sendMessage',
  'shareFile',
  'scheduleMessage',
  'addReaction',
  'deleteMessage',
  'addBookmark',
  'removeBookmark',
  'createCanvas',
  'createConversation',
  'updateCanvas',
  'addListItem',
  'updateListItem'
])

function isPlatformWrite(name: string, args: Record<string, unknown>): boolean {
  if (name === 'sendMessage') return absent(args.sessionId) && absent(args.toAgent)
  return PLATFORM_WRITES.has(name)
}

/** What a platform write targets outside the current place; undefined when it stays here or is no platform write. */
export function writeElsewhere(ctx: SessionContext, name: string, args: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'sendMessage':
      // A parent-session reply posts nothing, and the agent-to-agent forms are out of this rule for now.
      if (!absent(args.sessionId) || !absent(args.toAgent)) return undefined
      if (absent(args.channel)) return absent(args.toUser) ? undefined : 'a direct message'
      return targetsHere(ctx, args.platform, args.integrationId, args.channel) ? undefined : ANOTHER_CONVERSATION
    case 'scheduleMessage':
    case 'addReaction':
    case 'deleteMessage':
    case 'addBookmark':
    case 'removeBookmark':
      return targetsHere(ctx, undefined, args.integrationId, absent(args.channel) ? ctx.channel : args.channel)
        ? undefined
        : ANOTHER_CONVERSATION
    case 'createCanvas':
      return !absent(args.channel) && targetsHere(ctx, undefined, args.integrationId, args.channel)
        ? undefined
        : 'a canvas outside this conversation (pass this conversation as `channel`)'
    case 'createConversation':
      return 'a new conversation'
    case 'updateCanvas':
    case 'addListItem':
    case 'updateListItem':
      return 'a document whose conversation cannot be confirmed'
    default:
      return undefined
  }
}

/** A channel-addressed read must pass the place rule; the session's own conversation always does. */
async function assertReadableHere(
  ctx: SessionContext,
  tool: PlaceReadTool,
  args: Record<string, unknown>,
  deps: PlaceAccessDeps
): Promise<void> {
  // A malformed channel never reaches the platform: the handler's own argument check refuses it.
  if (!absent(args.channel) && typeof args.channel !== 'string') return
  const current: PlaceRef = { platform: ctx.platform, channel: ctx.channel }
  const source: PlaceRef = {
    platform: ctx.platform,
    channel: typeof args.channel === 'string' ? args.channel : ctx.channel
  }
  if (samePlace(current, source)) return
  const named = typeof args.integrationId === 'string' ? args.integrationId : ctx.integrationId
  const own = knownIntegrations(ctx).some((i) => i.id === named && i.platform === ctx.platform)
  const row = await deps.placeStore?.latestSession(ctx.agentId, source.channel)
  const rowKind = row?.platform === ctx.platform ? kindFromRows(ctx.platform, [row.conversationKind]) : undefined
  const refusal = checkPlaceRead(tool, current, await describePlace(source, rowKind, own ? named : undefined, deps))
  if (refusal) throw new Error(`${tool}: ${placeRefusalMessage(refusal)}`)
}

/** The assistant-mode gate before every bridge tool: a post elsewhere is drafted, other writes stay here, reads pass the rule. */
export async function assertAssistantPlaceAccess(
  ctx: SessionContext,
  name: string,
  args: Record<string, unknown>,
  deps: PlaceAccessDeps
): Promise<PlaceVerdict> {
  if (!deps.assistantModeFor?.(ctx.agentId)) return undefined
  const elsewhere = writeElsewhere(ctx, name, args)
  // Whether a post needs approval follows from its target, never from the model's judgment (§5.5).
  if (elsewhere && name === 'sendMessage' && deps.assistantDraftPost) return { draft: true }
  if (elsewhere) {
    throw new Error(
      `${name}: in assistant mode you write only to the conversation you are in, and this targets ${elsewhere}. ` +
        'Nothing was changed. Say it in your reply here instead.'
    )
  }
  if (isPlatformWrite(name, args) && deps.placeExternal?.(ctx)) {
    throw new Error(
      `${name}: this conversation is shared with another organization, so your reply here goes to an internal ` +
        'member for approval and other writes here are refused. Nothing was changed. Put it in your reply instead.'
    )
  }
  const read = PLACE_READS.get(name)
  if (read) await assertReadableHere(ctx, read, args, deps)
  return undefined
}
