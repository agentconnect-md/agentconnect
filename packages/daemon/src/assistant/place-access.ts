// Assistant mode's read rule (assistant-mode.md §5.5): which place may read another place's content.
import { metrics } from '@opentelemetry/api'

/** What a conversation is to the rule; `webchat` is the console's own conversation. */
export type PlaceKind = 'dm' | 'group_dm' | 'channel' | 'webchat'

/** A place by its conversation: one platform conversation, whichever of the agent's bots reached it. */
export interface PlaceRef {
  platform: string
  channel: string
}

/** A source place as far as it could be described; an undescribed kind or privacy is refused. */
export interface SourcePlace extends PlaceRef {
  kind?: PlaceKind
  /** The platform's `isPrivate` for a channel or group DM; undefined when it could not be read. */
  private?: boolean
}

/** The person asking in their own 1:1 DM, on the bot that DM belongs to (per-asker scoping, §5.5). */
export interface PlaceAsker {
  integrationId: string
  userId: string
}

/** Why a read was refused: a direct conversation, a private place, or a place that could not be described. */
export type PlaceRefusal = 'direct' | 'private' | 'undetermined'

/** The tools whose cross-place reads pass the rule; a closed set, so it can label a metric. */
export type PlaceReadTool = 'recall' | 'getChannelHistory' | 'getThreadHistory' | 'getReactions' | 'listBookmarks'

export function samePlace(a: PlaceRef, b: PlaceRef): boolean {
  return a.platform === b.platform && a.channel === b.channel
}

/** May `current` read `source`? Undefined when it may; a DM, webchat or private place is read only from itself (before per-asker scoping). */
export function placeReadRefusal(current: PlaceRef, source: SourcePlace): PlaceRefusal | undefined {
  if (samePlace(current, source)) return undefined
  switch (source.kind) {
    case 'channel':
    case 'group_dm':
      return source.private === false ? undefined : source.private ? 'private' : 'undetermined'
    case 'dm':
    case 'webchat':
      return 'direct'
    default:
      return 'undetermined'
  }
}

/** The opaque answer for anything that cannot be shared here; it never says that a place exists or where. */
export const NOT_SHARED_HERE =
  'That cannot be shared here. Do not repeat, summarize, hint at or guess the content, and do not say where it ' +
  'might be or whether it exists; answer: "I can\'t share that here."'

/** What the model is told instead of the content: a DM refusal says "ask me in a DM", every other one is opaque. */
export function placeRefusalMessage(reason: PlaceRefusal): string {
  if (reason !== 'direct') return NOT_SHARED_HERE
  return (
    'That was said in a direct conversation, and it stays there. Do not repeat, summarize or hint at it here; ' +
    'answer: "Ask me in a DM."'
  )
}

const meter = metrics.getMeter('@agentconnect.md/daemon-assistant', '1.0.0')
const refusedReads = meter.createCounter('agentconnect.assistant.place_reads_refused', {
  unit: '{read}',
  description: 'Cross-place reads refused under assistant mode, by tool and reason'
})

/** Where refused reads are counted; labels are the closed tool and reason sets, never a place or an agent. */
export interface PlaceReadMetrics {
  refused(tool: PlaceReadTool, reason: PlaceRefusal): void
}

export const placeReadMetrics: PlaceReadMetrics = {
  refused: (tool, reason) => refusedReads.add(1, { tool, reason })
}

/** The one choke point every assistant-mode cross-place read passes; `askerMember` may open a private place, and a refusal is counted. */
export async function checkPlaceRead(
  tool: PlaceReadTool,
  current: PlaceRef,
  source: SourcePlace,
  askerMember?: () => Promise<boolean>,
  recorder: PlaceReadMetrics = placeReadMetrics
): Promise<PlaceRefusal | undefined> {
  const refusal = placeReadRefusal(current, source)
  // Per-asker scoping only widens a private place; a DM or an undescribed place stays refused.
  if (refusal === 'private' && askerMember && (await askerMember().catch(() => false))) return undefined
  if (refusal) recorder.refused(tool, refusal)
  return refusal
}
