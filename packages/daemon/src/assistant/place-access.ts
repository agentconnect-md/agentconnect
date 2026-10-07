// Assistant mode's read rule (assistant-mode.md §5.5): which place may read another place's content.
import { metrics } from '@opentelemetry/api'

/** What a conversation is to the rule; `webchat` is the console's own conversation. */
export type PlaceKind = 'dm' | 'group_dm' | 'channel' | 'webchat'

/** A place by its conversation: one platform conversation, whichever of the agent's bots reached it. */
export interface PlaceRef {
  platform: string
  channel: string
}

/** A source place as far as it could be described; an undescribed kind or channel privacy is refused. */
export interface SourcePlace extends PlaceRef {
  kind?: PlaceKind
  /** A channel only its members can read; undefined on a channel means the platform could not say. */
  private?: boolean
}

/** Why a read was refused: a direct conversation, a private channel, or a place that could not be described. */
export type PlaceRefusal = 'direct' | 'private_channel' | 'undetermined'

/** The tools whose cross-place reads pass the rule; a closed set, so it can label a metric. */
export type PlaceReadTool = 'recall' | 'getChannelHistory' | 'getThreadHistory' | 'getReactions' | 'listBookmarks'

export function samePlace(a: PlaceRef, b: PlaceRef): boolean {
  return a.platform === b.platform && a.channel === b.channel
}

/** May `current` read `source`? Undefined when it may; P0a reads a DM, webchat or private channel only from itself. */
export function placeReadRefusal(current: PlaceRef, source: SourcePlace): PlaceRefusal | undefined {
  if (samePlace(current, source)) return undefined
  switch (source.kind) {
    case 'group_dm':
      return undefined
    case 'channel':
      return source.private === false ? undefined : source.private ? 'private_channel' : 'undetermined'
    case 'dm':
    case 'webchat':
      return 'direct'
    default:
      return 'undetermined'
  }
}

/** What the model is told instead of the content, worded so it can relay it. */
export function placeRefusalMessage(reason: PlaceRefusal): string {
  switch (reason) {
    case 'direct':
      return (
        'That was said in a direct conversation, and its content stays there. Do not repeat, summarize or hint at ' +
        'it here; answer: "Ask me in a DM."'
      )
    case 'private_channel':
      return (
        'That was said in a private channel, and its content is read only there. Do not repeat, summarize or hint ' +
        'at it here; say it is in a private channel and can be asked there.'
      )
    case 'undetermined':
      return (
        'Whether that conversation may be read from here could not be determined, so it was not read. Do not guess ' +
        'at its content; suggest asking in that conversation.'
      )
  }
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

/** The one choke point every assistant-mode cross-place read passes; a refusal is counted. */
export function checkPlaceRead(
  tool: PlaceReadTool,
  current: PlaceRef,
  source: SourcePlace,
  recorder: PlaceReadMetrics = placeReadMetrics
): PlaceRefusal | undefined {
  const refusal = placeReadRefusal(current, source)
  if (refusal) recorder.refused(tool, refusal)
  return refusal
}
