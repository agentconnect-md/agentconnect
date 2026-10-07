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
import { reportsConversationPrivacy } from '../../platforms/read-ports.js'
import type { SessionRecord, TranscriptRow, TranscriptSessionScope } from '../../store/local-store.js'
import type { MessageGateway, SessionContext } from './context.js'
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

export interface PlaceAccessDeps extends GatewayDeps {
  /** Whether the agent is in assistant mode now, read per call so a switch applies to open sessions. */
  assistantModeFor?: (agentId: string) => boolean
  /** The live connection of the agent's bot behind a session's transport scope, to describe a place it reached. */
  placeGatewayFor?: (agentId: string, platform: string, transportScope?: string | null) => MessageGateway | undefined
  placeStore?: PlaceStore
}

const KIND_STRICTNESS: Record<PlaceKind, number> = { channel: 1, group_dm: 2, dm: 3, webchat: 3 }

/** A place's kind from the conversation kinds its session rows recorded; the strictest one wins. */
export function kindFromRows(platform: string, kinds: Iterable<string | null | undefined>): PlaceKind | undefined {
  if (platform === 'webchat') return 'webchat'
  let kind: PlaceKind | undefined
  for (const recorded of kinds) {
    if (recorded !== 'dm' && recorded !== 'group_dm' && recorded !== 'channel') continue
    if (!kind || KIND_STRICTNESS[recorded] > KIND_STRICTNESS[kind]) kind = recorded
  }
  return kind
}

/** Whether only a channel's members read it: false where the platform never says, undefined when it cannot now. */
async function channelPrivacy(
  platform: string,
  channel: string,
  gw: MessageGateway | undefined
): Promise<boolean | undefined> {
  if (!reportsConversationPrivacy(platform)) return false
  if (!gw?.isPrivateConversation) return undefined
  return await gw.isPrivateConversation(channel).catch(() => undefined)
}

/** Describe a place: the kind its session rows recorded, else the platform's own word, plus a channel's privacy. */
export async function describePlace(
  place: PlaceRef,
  rowKind: PlaceKind | undefined,
  gw: MessageGateway | undefined
): Promise<SourcePlace> {
  let kind = rowKind
  if (!kind && gw) {
    const info = await gw.getChannelInfo(place.channel).catch(() => undefined)
    if (info) kind = info.isIm ? 'dm' : info.isMpim ? 'group_dm' : 'channel'
  }
  const source: SourcePlace = { platform: place.platform, channel: place.channel, ...(kind ? { kind } : {}) }
  if (kind !== 'channel') return source
  const isPrivate = await channelPrivacy(place.platform, place.channel, gw)
  return isPrivate === undefined ? source : { ...source, private: isPrivate }
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
  const integrationId = typeof args.integrationId === 'string' ? args.integrationId : ctx.integrationId
  const own = knownIntegrations(ctx).some((i) => i.id === integrationId && i.platform === ctx.platform)
  const gw = own && integrationId ? deps.gatewayFor(integrationId) : undefined
  const row = await deps.placeStore?.latestSession(ctx.agentId, source.channel)
  const rowKind = row?.platform === ctx.platform ? kindFromRows(ctx.platform, [row.conversationKind]) : undefined
  const refusal = checkPlaceRead(tool, current, await describePlace(source, rowKind, gw))
  if (refusal) throw new Error(`${tool}: ${placeRefusalMessage(refusal)}`)
}

/** The assistant-mode gate before every bridge tool: platform writes stay here, channel reads pass the rule. */
export async function assertAssistantPlaceAccess(
  ctx: SessionContext,
  name: string,
  args: Record<string, unknown>,
  deps: PlaceAccessDeps
): Promise<void> {
  if (!deps.assistantModeFor?.(ctx.agentId)) return
  const elsewhere = writeElsewhere(ctx, name, args)
  if (elsewhere) {
    throw new Error(
      `${name}: in assistant mode you write only to the conversation you are in, and this targets ${elsewhere}. ` +
        'Nothing was changed. Say it in your reply here instead.'
    )
  }
  const read = PLACE_READS.get(name)
  if (read) await assertReadableHere(ctx, read, args, deps)
}
