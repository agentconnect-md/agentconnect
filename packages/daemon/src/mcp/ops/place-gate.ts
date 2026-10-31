// The place rules on the bridge (assistant-mode.md §5.5): every agent's cross-place reads and platform writes are judged by who is asking.
import {
  askerMayRead,
  askerUnlinked,
  checkPlaceRead,
  CLOSED_LOOKUPS,
  isPrivateSource,
  NOBODY,
  NOT_POSTED_HERE,
  NOT_POSTED_UNLINKED,
  NOT_SHARED_HERE,
  NOT_SHARED_UNLINKED,
  placeReadMetrics,
  privateSourceNote,
  readRefusal,
  samePlace,
  type PlaceKind,
  type PlaceReadMetrics,
  type PlaceReadTool,
  type PlaceRef,
  type PlaceRefusal,
  type ReadAsker,
  type ReadLookups,
  type SourcePlace,
  type TurnAskers
} from '../../assistant/place-access.js'
import type { InterceptedPost, PostInterception } from '../../assistant/drafts.js'
import { tellsWorkspaceMembers } from '../../platforms/read-ports.js'
import type { SessionRecord, TranscriptRow, TranscriptSessionScope } from '../../store/local-store.js'
import { isSyntheticA2aChannel } from '../../cp/cp-collab-routes.js'
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
  /** The listing's word on a share with another organization; null when it found none. */
  externalReason?: string | null
}

export interface PlaceAccessDeps extends GatewayDeps {
  /** Whether the agent is in assistant mode now, read per call so a switch applies to open sessions. */
  assistantModeFor?: (agentId: string) => boolean
  /** The agent's integration behind a session's transport scope, for a place it reached through that bot. */
  placeIntegrationFor?: (agentId: string, platform: string, transportScope?: string | null) => string | undefined
  /** The integration's snapshot row for a conversation, so privacy needs no platform call when it is known. */
  placeSnapshot?: (integrationId: string, channel: string) => PlaceSnapshotRow | undefined
  placeStore?: PlaceStore
  /** Whether a write's target is shared with another organization; in assistant mode the platform is asked first (§5.3). */
  targetExternal?: (agentId: string, integrationId: string, channel: string, dm: boolean) => Promise<boolean>
  /** Drafts a post for an internal member's approval; absent ⇒ a post that needs one is refused. */
  draftPost?: (ctx: SessionContext, post: InterceptedPost) => Promise<PostInterception>
  /** Who is asking on the session's live turn; absent ⇒ nobody, so only public sources are read. */
  readAskers?: (ctx: SessionContext) => Promise<TurnAskers>
  /** The live lookups the read rule asks for one agent; absent ⇒ none confirms anything. */
  readLookups?: (agentId: string) => ReadLookups
}

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
  let external = snapshot?.externalReason === undefined ? undefined : snapshot.externalReason !== null
  if (kind === undefined || (shared(kind) && isPrivate === undefined)) {
    const gw = integrationId ? deps.gatewayFor(integrationId) : undefined
    const info = gw ? await gw.getChannelInfo(place.channel).catch(() => undefined) : undefined
    if (info) {
      kind = stricter(kind, info.isIm ? 'dm' : info.isMpim ? 'group_dm' : 'channel')
      if (isPrivate === undefined && typeof info.isPrivate === 'boolean') isPrivate = info.isPrivate
      name ??= info.name
      // The same answer says whether the conversation is shared with another organization.
      if (info.externalReason !== undefined) external = external === true || info.externalReason !== null
    }
  }
  return {
    platform: place.platform,
    channel: place.channel,
    ...(kind ? { kind } : {}),
    ...(shared(kind) && isPrivate !== undefined ? { private: isPrivate } : {}),
    ...(name ? { name } : {}),
    ...(external !== undefined ? { external } : {})
  }
}

/** Another conversation as the rules judge it: described, with the agent's newest session there, which a read off the asker's own bot is judged by. */
export async function describeConversation(
  ctx: SessionContext,
  place: PlaceRef,
  bot: string | undefined,
  deps: PlaceAccessDeps
): Promise<SourcePlace> {
  const row = await deps.placeStore?.latestSession(ctx.agentId, place.channel)
  const own = row?.platform === place.platform ? row : undefined
  const rowKind = own ? kindFromRows(place.platform, [own.conversationKind]) : undefined
  return { ...(await describePlace(place, rowKind, bot, deps)), sessions: own?.sessionId ? [own.sessionId] : [] }
}

/** One of the agent's own bots on that platform, from the trusted session snapshot; undefined for any other id. */
function ownBot(ctx: SessionContext, platform: string, integrationId: unknown): string | undefined {
  return knownIntegrations(ctx).some((i) => i.id === integrationId && i.platform === platform)
    ? (integrationId as string)
    : undefined
}

/** The channel-addressed platform reads that pass the place rule. */
const PLACE_READS: ReadonlyMap<string, PlaceReadTool> = new Map<string, PlaceReadTool>([
  ['getChannelHistory', 'getChannelHistory'],
  ['getThreadHistory', 'getThreadHistory'],
  ['getReactions', 'getReactions'],
  ['listBookmarks', 'listBookmarks']
])

const absent = (value: unknown): boolean => value === undefined || value === null

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
  const current: PlaceRef = { platform: ctx.platform, channel: ctx.channel }
  if (samePlace(current, source)) return {}
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
  return isPrivateSource(source) ? { privateSource: privateSourceNote(source) } : {}
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
  const bot = ownBot(ctx, ctx.platform, named)
  const here = samePlace({ platform: ctx.platform, channel: ctx.channel }, source)
  // A read off the asker's own bot is judged by the console's view of the agent's newest session there.
  const described = here ? source : await describeConversation(ctx, source, bot, deps)
  const verdict = await judgePlaceRead(ctx, tool, described, bot, deps)
  if (verdict.refused) throw new Error(`${tool}: ${verdict.unlinked ? NOT_SHARED_UNLINKED : NOT_SHARED_HERE}`)
  return verdict.privateSource
}

/** send-message-guide.md §9.2: whether a calling turn's people may join an existing session, judged as a read of its conversation. */
export async function judgeSessionParticipation(input: {
  /** The caller's current conversation, which the read rule always lets read itself. */
  callerPlace: PlaceRef
  /** The target session, as its owning daemon recorded it. */
  target: Pick<SessionRecord, 'platform' | 'channel' | 'conversationKind' | 'sessionId'>
  askers: TurnAskers
  /** The target agent's bot behind the session, which a same-bot asker is judged on. */
  bot: string | undefined
  /** The target agent's lookups: the console answers only for that agent's sessions. */
  lookups: ReadLookups
  deps: Pick<PlaceAccessDeps, 'gatewayFor' | 'placeSnapshot'>
  recorder?: PlaceReadMetrics
}): Promise<boolean> {
  const { target, bot, lookups } = input
  const place: PlaceRef = { platform: target.platform, channel: target.channel }
  const described = await describePlace(
    place,
    kindFromRows(target.platform, [target.conversationKind]),
    bot,
    input.deps
  )
  const source: SourcePlace = { ...described, sessions: target.sessionId ? [target.sessionId] : [] }
  const mayRead = (asker: ReadAsker) => askerMayRead(asker, source, bot, lookups)
  // Every peer one agent woke without a channel shares its `a2a:` coordinate, so that is never the caller's own place.
  if (isSyntheticA2aChannel(input.callerPlace.channel) || isSyntheticA2aChannel(target.channel)) {
    const refusal = await readRefusal(source, input.askers, mayRead, false)
    if (refusal) (input.recorder ?? placeReadMetrics).refused('callAgent', refusal)
    return refusal === undefined
  }
  const refusal = await checkPlaceRead(
    'callAgent',
    input.callerPlace,
    source,
    input.askers,
    mayRead,
    false,
    input.recorder
  )
  return refusal === undefined
}

/** Where a platform write lands: a conversation (a direct message by its recipient), something new with these people, or a hosted document. */
export type WriteTarget =
  | { kind: 'conversation'; platform: string; integrationId?: string; channel: string; recipient?: string }
  | { kind: 'new'; platform: string; integrationId?: string; users: readonly string[] }
  | { kind: 'document'; platform: string; integrationId?: string; documentId: string }

/** What the write rule lets through: `post` goes out now, `draft` waits for an internal member's approval. */
export type WriteVerdict = 'post' | 'draft'

const NOBODY_WRITES =
  'no person started this run, so it writes only to its own conversation. Nothing was sent or changed.'
const DM_OUTSIDE =
  'a direct message goes only to a member of your organization, and this person could not be confirmed as one. ' +
  'Nothing was sent.'
const NEW_OUTSIDE =
  'a new conversation is opened only with members of your organization, and someone named could not be confirmed ' +
  'as one. Nothing was created.'
const EXTERNAL_TARGET =
  'that conversation is shared with another organization, so only a post can go there, and only once an internal ' +
  'member approves it. Nothing was changed.'
const NEW_NOT_MEMBER =
  'something new is made only for full members of this workspace, and not everyone asking could be confirmed as ' +
  'one. Nothing was created or changed.'
const DOCUMENT_UNKNOWN =
  'the conversations this document is in could not be confirmed, so it was not changed. Nothing was changed.'

const refused = (tool: string, why: string): Error => new Error(`${tool}: ${why}`)

/** A person the platform counts in the organization: a full member of the bot's workspace where it can tell; fails closed. */
async function inOrganization(
  platform: string,
  bot: string | undefined,
  user: string,
  lookups: ReadLookups
): Promise<boolean> {
  if (!tellsWorkspaceMembers(platform)) return true
  const id = /^<@([^>]+)>$/.exec(user)?.[1] ?? user
  return bot !== undefined && (await lookups.fullMember(bot, id).catch(() => false))
}

/** Whether an asker could make something new in that bot's workspace: its own full member, or a person linked as one, where the platform can tell. */
async function workspaceMember(
  asker: ReadAsker,
  platform: string,
  bot: string | undefined,
  lookups: ReadLookups
): Promise<boolean> {
  if (bot === undefined) return false
  const userId =
    asker.kind === 'member' && asker.platform === platform && asker.integrationId === bot
      ? asker.userId
      : await lookups.linked(bot, asker).catch(() => null)
  if (userId === null) return false
  return await memberMakesNew(platform, bot, userId, lookups)
}

/** Whether a chat member of that bot may have it make something new: a full member of its workspace, where the platform can tell. */
export async function memberMakesNew(
  platform: string,
  bot: string,
  userId: string,
  lookups: ReadLookups
): Promise<boolean> {
  return !tellsWorkspaceMembers(platform) || (await lookups.fullMember(bot, userId).catch(() => false))
}

/**
 * The one choke point every platform write passes, for every agent: the current conversation always, anything else
 * only where every person asking may go; a post that needs approval comes back `draft`, and any other refusal throws.
 */
export async function judgePlaceWrite(
  ctx: SessionContext,
  tool: string,
  target: WriteTarget,
  deps: PlaceAccessDeps,
  post = false
): Promise<WriteVerdict> {
  // The current conversation takes every write, shared with another organization or not (#2979, B4).
  if (target.kind === 'conversation' && samePlace({ platform: ctx.platform, channel: ctx.channel }, target))
    return 'post'
  const lookups = deps.readLookups?.(ctx.agentId) ?? CLOSED_LOOKUPS
  const bot = ownBot(ctx, target.platform, target.integrationId)
  if (target.kind === 'document') return await judgeDocument(ctx, tool, target, bot, lookups, deps)
  const people = target.kind === 'new' ? target.users : target.recipient !== undefined ? [target.recipient] : []
  for (const user of people) {
    if (!(await inOrganization(target.platform, bot, user, lookups)))
      throw refused(tool, target.kind === 'new' ? NEW_OUTSIDE : DM_OUTSIDE)
  }
  const askers = deps.readAskers ? await deps.readAskers(ctx).catch(() => NOBODY) : NOBODY
  // A run no person started writes only to its own conversation, which is an anchored hook's or schedule's target.
  if (askers.nobody || askers.people.length === 0) {
    if (post && deps.assistantModeFor?.(ctx.agentId) === true && deps.draftPost) return 'draft'
    throw refused(tool, NOBODY_WRITES)
  }
  if (target.kind === 'new') {
    for (const asker of askers.people)
      if (!(await workspaceMember(asker, target.platform, bot, lookups))) throw refused(tool, NEW_NOT_MEMBER)
    return 'post'
  }
  // A direct message reaches anyone in the organization; any other conversation, those every asker may see.
  if (target.recipient === undefined) {
    const place = await describeConversation(ctx, target, bot, deps)
    for (const asker of askers.people)
      if (!(await askerMayRead(asker, place, bot, lookups).catch(() => false)))
        throw await closed(tool, askers, lookups)
  }
  const external =
    bot !== undefined &&
    (await (
      deps.targetExternal?.(ctx.agentId, bot, target.channel, target.recipient !== undefined) ?? Promise.resolve(false)
    ).catch(() => true))
  if (!external) return 'post'
  if (post && deps.draftPost) return 'draft'
  throw refused(tool, EXTERNAL_TARGET)
}

/** The opaque refusal, with the sign-in hint for an asker who linked no console account. */
async function closed(tool: string, askers: TurnAskers, lookups: ReadLookups): Promise<Error> {
  return refused(tool, (await askerUnlinked(askers, lookups)) ? NOT_POSTED_UNLINKED : NOT_POSTED_HERE)
}

/** A canvas or a list is written for every conversation it is in, and for the whole workspace where it is open to it. */
async function judgeDocument(
  ctx: SessionContext,
  tool: string,
  target: Extract<WriteTarget, { kind: 'document' }>,
  bot: string | undefined,
  lookups: ReadLookups,
  deps: PlaceAccessDeps
): Promise<WriteVerdict> {
  const gw = bot ? deps.gatewayFor(bot) : undefined
  const reach = gw?.documentReach ? await gw.documentReach(target.documentId).catch(() => undefined) : undefined
  if (!reach?.complete) throw refused(tool, DOCUMENT_UNKNOWN)
  for (const channel of reach.conversations)
    await judgePlaceWrite(
      ctx,
      tool,
      { kind: 'conversation', platform: target.platform, integrationId: bot, channel },
      deps
    )
  // A document in no conversation is new to everyone but its maker, so it is judged as making something new.
  if (reach.workspace || reach.conversations.length === 0)
    await judgePlaceWrite(ctx, tool, { kind: 'new', platform: target.platform, integrationId: bot, users: [] }, deps)
  return 'post'
}

/** Whether `sendMessage` is a platform post: only `postMessage`, never an agent call, a sub-session, or an origin reply. */
export function isPlatformPost(args: Record<string, unknown>): boolean {
  return args.action === 'postMessage' && absent(args.sessionId) && absent(args.toAgent)
}
