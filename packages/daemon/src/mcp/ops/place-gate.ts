// The place rules on the bridge (assistant-mode.md §5.5): every agent's cross-place reads pass the read rule; assistant mode's writes stay here.
import {
  askerMayRead,
  askerUnlinked,
  checkPlaceRead,
  CLOSED_LOOKUPS,
  isPrivateSource,
  NOBODY,
  NOT_SHARED_HERE,
  NOT_SHARED_UNLINKED,
  placeReadMetrics,
  privateSourceNote,
  samePlace,
  sourceClass,
  type PlaceKind,
  type PlaceReadMetrics,
  type PlaceReadTool,
  type PlaceRef,
  type PlaceRefusal,
  type ReadLookups,
  type SourcePlace,
  type TurnAskers
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

/** One conversation in an integration's snapshot (membership listing and observed chats): its kind, `isPrivate` and name. */
export interface PlaceSnapshotRow {
  kind?: 'channel' | 'im' | 'mpim'
  isPrivate?: boolean
  name?: string
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
  /** Who is asking on the session's live turn; absent ⇒ nobody, so only public sources are read. */
  readAskers?: (ctx: SessionContext) => Promise<TurnAskers>
  /** The live lookups the read rule asks for one agent; absent ⇒ none confirms anything. */
  readLookups?: (agentId: string) => ReadLookups
  /** The session's durable mark for a private channel or group DM an assistant-mode 1:1 conversation read (§5.5); it ends when the session is retired. */
  widenedSession?: {
    mark(ctx: SessionContext): Promise<boolean>
    marked(ctx: SessionContext): Promise<boolean>
    /** Whether any session of the agent in this session's place was ever marked, retired ones included. */
    placeMarked(ctx: SessionContext): Promise<boolean>
  }
}

/** Whether this session carries the widened-read mark; a mark that cannot be read counts as set. */
async function widenedHere(ctx: SessionContext, deps: PlaceAccessDeps): Promise<boolean> {
  return deps.widenedSession ? await deps.widenedSession.marked(ctx).catch(() => true) : false
}

/** A read of the session's own place takes on the place's mark first (§5.5), so earlier history cannot leave it unmarked; fails closed. */
export async function carryPlaceMark(ctx: SessionContext, tool: string, deps: PlaceAccessDeps): Promise<void> {
  const widened = deps.widenedSession
  if (!widened) return
  const marked = await widened.placeMarked(ctx).catch(() => undefined)
  if (marked === false) return
  if (marked === true && (await widened.mark(ctx).catch(() => false))) return
  throw new Error(`${tool}: this conversation's history could not be read right now. Nothing was read; retry.`)
}

/** The gate's word on a call it lets through: `draft` sends the post through approval (§5.5). */
export type PlaceVerdict = { draft?: true } | undefined

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
  let name = snapshot?.name
  if (kind === undefined || (shared(kind) && isPrivate === undefined)) {
    const gw = integrationId ? deps.gatewayFor(integrationId) : undefined
    const info = gw ? await gw.getChannelInfo(place.channel).catch(() => undefined) : undefined
    if (info) {
      kind = stricter(kind, info.isIm ? 'dm' : info.isMpim ? 'group_dm' : 'channel')
      if (isPrivate === undefined && typeof info.isPrivate === 'boolean') isPrivate = info.isPrivate
      name ??= info.name
    }
  }
  return {
    platform: place.platform,
    channel: place.channel,
    ...(kind ? { kind } : {}),
    ...(shared(kind) && isPrivate !== undefined ? { private: isPrivate } : {}),
    ...(name ? { name } : {})
  }
}

/** The ledger writes a widened session may not make. */
const LEDGER_WRITES = new Set(['takeItem', 'updateItem', 'followItem'])

/** What a session that made a widened read may no longer do (§5.5): change the ledger, send to any agent, or write elsewhere. */
function barredAfterWidenedRead(ctx: SessionContext, name: string, args: Record<string, unknown>): boolean {
  if (LEDGER_WRITES.has(name)) return true
  // Every agent-to-agent form: a direct call (self-delegation among them), a channel-root post with `toAgent`, a session reply.
  if (name === 'sendMessage' && (!absent(args.toAgent) || !absent(args.sessionId))) return true
  return writeElsewhere(ctx, name, args) !== undefined
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

/** A refused read, `unlinked` when an asker may be told how cross-platform reads open; or one let through with a private source's note. */
export type ReadVerdict =
  { refused: PlaceRefusal; unlinked?: true } | { refused?: undefined; unlinked?: undefined; privateSource?: string }

/** The one choke point every cross-place read passes, for every agent: refused, or let through with a private source's note. */
export async function judgePlaceRead(
  ctx: SessionContext,
  tool: PlaceReadTool,
  source: SourcePlace,
  bot: string | undefined,
  deps: PlaceAccessDeps,
  recorder: PlaceReadMetrics = placeReadMetrics
): Promise<ReadVerdict> {
  const assistant = deps.assistantModeFor?.(ctx.agentId) === true
  const current: PlaceRef = { platform: ctx.platform, channel: ctx.channel }
  if (samePlace(current, source)) {
    if (assistant) await carryPlaceMark(ctx, tool, deps)
    return {}
  }
  const askers = deps.readAskers ? await deps.readAskers(ctx).catch(() => NOBODY) : NOBODY
  const lookups = deps.readLookups?.(ctx.agentId) ?? CLOSED_LOOKUPS
  const ownBot = source.platform === ctx.platform && bot !== undefined && bot === ctx.integrationId
  const refusal = await checkPlaceRead(
    tool,
    current,
    source,
    askers,
    (asker) => askerMayRead(asker, source, bot, lookups),
    ownBot,
    recorder
  )
  if (refusal)
    return { refused: refusal, ...((await askerUnlinked(askers, lookups)) ? { unlinked: true as const } : {}) }
  if (!isPrivateSource(source)) return {}
  // An assistant-mode 1:1 conversation that reads a private channel or group DM writes only there until `!new` (§5.5); no mark, no read.
  if (assistant && ctx.isDm && sourceClass(source) === 'members') {
    if (!(await deps.widenedSession?.mark(ctx).catch(() => false))) {
      recorder.refused(tool, 'private')
      return { refused: 'private' }
    }
  }
  return { privateSource: privateSourceNote(source) }
}

/** A channel-addressed platform read passes the read rule; returns the private-source note for its result. */
export async function assertPlaceRead(
  ctx: SessionContext,
  name: string,
  args: Record<string, unknown>,
  deps: PlaceAccessDeps
): Promise<string | undefined> {
  const tool = PLACE_READS.get(name)
  // A malformed channel never reaches the platform: the handler's own argument check refuses it.
  if (!tool || (!absent(args.channel) && typeof args.channel !== 'string')) return undefined
  const source: PlaceRef = {
    platform: ctx.platform,
    channel: typeof args.channel === 'string' ? args.channel : ctx.channel
  }
  const named = typeof args.integrationId === 'string' ? args.integrationId : ctx.integrationId
  const bot = knownIntegrations(ctx).some((i) => i.id === named && i.platform === ctx.platform) ? named : undefined
  let described: SourcePlace = source
  if (!samePlace({ platform: ctx.platform, channel: ctx.channel }, source)) {
    const row = await deps.placeStore?.latestSession(ctx.agentId, source.channel)
    const own = row?.platform === ctx.platform ? row : undefined
    const rowKind = own ? kindFromRows(ctx.platform, [own.conversationKind]) : undefined
    // A read off the asker's own bot is judged by the console's view of the agent's newest session there.
    described = {
      ...(await describePlace(source, rowKind, bot, deps)),
      sessions: own?.sessionId ? [own.sessionId] : []
    }
  }
  const verdict = await judgePlaceRead(ctx, tool, described, bot, deps)
  if (verdict.refused) throw new Error(`${tool}: ${verdict.unlinked ? NOT_SHARED_UNLINKED : NOT_SHARED_HERE}`)
  return verdict.privateSource
}

/** The assistant-mode gate before every bridge tool: a post elsewhere is drafted and other writes stay here. */
export async function assertAssistantPlaceAccess(
  ctx: SessionContext,
  name: string,
  args: Record<string, unknown>,
  deps: PlaceAccessDeps
): Promise<PlaceVerdict> {
  if (!deps.assistantModeFor?.(ctx.agentId)) return undefined
  // Every turn of a marked session, whoever started it.
  if (barredAfterWidenedRead(ctx, name, args) && (await widenedHere(ctx, deps))) {
    throw new Error(
      `${name}: this conversation has read a conversation that only the person here may see, so it now writes only ` +
        'here: no item changes, nothing sent to an agent, and nothing posted or drafted elsewhere. Nothing was changed. ' +
        'Answer here instead, and tell the person that starting a new conversation with `!new` lifts this.'
    )
  }
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
  return undefined
}
