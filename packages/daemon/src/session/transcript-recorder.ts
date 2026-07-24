import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { ToolBody } from '@agentconnect.md/protocol'

/**
 * A transcript event to persist. Reasoning is a flat coalesced block; tool events
 * carry the full merged ToolBody (as a serialized JSON string, already capped at the
 * single-body write ceiling) plus an `op` telling the daemon whether this is the
 * first sight of the call (INSERT a row) or a later update (UPDATE the same row).
 */
export type TranscriptEvent =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; op: 'insert' | 'update'; toolCallId: string; text: string; body: string }

/** Single-body write ceiling (protects the daemon DB from a huge rawOutput/content);
 *  separate from the read-side 32 KiB inline preview cap. */
const MAX_TOOL_BODY_BYTES = 1024 * 1024

/**
 * Turns the raw ACP `session/update` stream into the *full* activity log — tool calls
 * and reasoning — independent of the agent's Slack `output.mode`. (Output mode only
 * decides what reaches the platform; the transcript records everything.)
 *
 * It deliberately does NOT emit `text`: conversational rows are recorded at the
 * platform-send boundary instead, where the real message `ts` is known (so they sort
 * against the §8.5 replay marker). Reasoning chunks are coalesced into one block per
 * run; each tool invocation is merged per `toolCallId` across its `tool_call` +
 * `tool_call_update` burst — emitting an `insert` on first sight and an `update` on
 * each later change, so the row's full body fills in as the call streams to completion.
 */
export class TranscriptRecorder {
  private thought = ''
  private readonly tools = new Map<string, ToolBody>()
  // Last non-null title seen per toolCallId — updates that omit `title` keep the prior one.
  private readonly titles = new Map<string, string>()

  onUpdate(update: SessionUpdate): TranscriptEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        const content = (update as { content?: { text?: string } }).content
        this.thought += content?.text ?? ''
        return []
      }
      case 'tool_call':
      case 'tool_call_update': {
        // Flush any reasoning that led up to this tool first, so order reads naturally.
        const flushed = this.flushThought()
        const u = update as {
          toolCallId?: string
          title?: string
          kind?: string
          status?: string
          rawInput?: unknown
          rawOutput?: unknown
          content?: unknown[]
          locations?: { path: string; line?: number }[]
        }
        const id = u.toolCallId ?? ''
        if (!id) return flushed
        const first = !this.tools.has(id)
        const body = this.merge(id, u)
        const title = u.title ?? this.titles.get(id) ?? id
        if (u.title !== undefined && u.title !== null) this.titles.set(id, u.title)
        return [
          ...flushed,
          { kind: 'tool', op: first ? 'insert' : 'update', toolCallId: id, text: title, body: serializeBody(body) }
        ]
      }
      // A reply starting means the preceding thinking run is over — close the block.
      case 'agent_message_chunk':
        return this.flushThought()
      default:
        return []
    }
  }

  /** Flush any trailing reasoning when the turn ends. */
  onFinal(): TranscriptEvent[] {
    return this.flushThought()
  }

  /**
   * Merge one `tool_call`/`tool_call_update` into the accumulated ToolBody per ACP
   * semantics: present-and-non-null scalar fields (kind/status/rawInput/rawOutput)
   * overlay the prior value; `content`/`locations` are wholesale replacements when
   * present. Returns the updated body (also cached in `tools`).
   */
  private merge(
    id: string,
    u: {
      kind?: string
      status?: string
      rawInput?: unknown
      rawOutput?: unknown
      content?: unknown[]
      locations?: { path: string; line?: number }[]
    }
  ): ToolBody {
    const body: ToolBody = this.tools.get(id) ?? { toolCallId: id }
    if (u.kind !== undefined && u.kind !== null) body.kind = u.kind
    if (u.status !== undefined && u.status !== null) body.status = u.status
    if (u.rawInput !== undefined && u.rawInput !== null) body.rawInput = u.rawInput
    if (u.rawOutput !== undefined && u.rawOutput !== null) body.rawOutput = u.rawOutput
    if (u.content !== undefined && u.content !== null) body.content = u.content
    if (u.locations !== undefined && u.locations !== null) body.locations = u.locations
    this.tools.set(id, body)
    return body
  }

  private flushThought(): TranscriptEvent[] {
    const text = this.thought.trim()
    this.thought = ''
    return text ? [{ kind: 'reasoning', text }] : []
  }
}

/** Serialize a ToolBody, capping the encoded size at MAX_TOOL_BODY_BYTES. When over
 *  cap, drop the biggest free-form tails (rawOutput first, then content) and flag
 *  `truncated` so the read side / UI can show it was capped at write time. */
function serializeBody(body: ToolBody): string {
  let json = JSON.stringify(body)
  if (Buffer.byteLength(json) <= MAX_TOOL_BODY_BYTES) return json
  const capped: ToolBody = { ...body, truncated: true }
  // rawOutput is usually the heaviest field; shed it, then content, until we fit.
  capped.rawOutput = undefined
  json = JSON.stringify(capped)
  if (Buffer.byteLength(json) <= MAX_TOOL_BODY_BYTES) return json
  capped.content = undefined
  json = JSON.stringify(capped)
  if (Buffer.byteLength(json) <= MAX_TOOL_BODY_BYTES) return json
  // Last resort: also shed rawInput (a pathological giant input) so the row still fits.
  capped.rawInput = undefined
  return JSON.stringify(capped)
}
