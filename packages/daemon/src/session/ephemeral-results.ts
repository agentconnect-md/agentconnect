/**
 * Tool results the model may READ but this daemon may not KEEP.
 *
 * Slack's Real-time Search API states it plainly: "You must not store or copy any of the data
 * retrieved from this API." Everything else an agent-callable tool returns is ordinary
 * transcript material, so the transcript recorder persists the merged ToolBody — which for a
 * search would be the retrieved message text, authors, timestamps, and permalinks, on disk and
 * readable through the console's tool-body reads. That is exactly what the policy forbids.
 *
 * So a producing tool stamps {@link EPHEMERAL_RESULT_MARKER} into its own result, and the
 * recorder redacts any body carrying it. The result still reaches the model intact — the live
 * answer is the permitted use.
 *
 * WHAT THIS DOES NOT REACH. The result is delivered through the ACP runtime, and a runtime
 * keeps its OWN conversation history: `session/load` replays that whole historical tool stream
 * (`acp/acp-host.ts`), so a copy outlives the turn there, on a store this daemon does not own
 * and ACP gives no way to mark a result unpersistable. This module is therefore the boundary
 * for AgentConnect's own durable state, and nothing here should be read as a claim about the
 * runtime's. Say "AgentConnect keeps no copy", never "no copy is kept".
 *
 * DETECTION IS A SUBSTRING SCAN of the serialized body, deliberately. The marker's position
 * depends on how a runtime echoes a tool result: one puts the JSON in `rawOutput`, another
 * wraps the text in `content` blocks, and both nest differently. Scanning the serialized body
 * covers every shape at once, including shapes no runtime has yet — where a check against one
 * field path would silently stop redacting the day a runtime moved it.
 */
import type { ToolBody } from '@agentconnect.md/protocol'

/** The stamp a non-storable result carries. Distinctive enough that a scan cannot false-positive
 *  on ordinary content, and stable because it is matched as text, never parsed. */
export const EPHEMERAL_RESULT_MARKER = 'x-agentconnect-ephemeral-do-not-store'

/** What the model is told alongside its results — the constraint applies to the AGENT too: it
 *  must not copy these hits into memory, a canvas, or a file. Guidance, not a fence, and the
 *  first field of the result so a runtime that truncates a long echo keeps the marker. */
export const EPHEMERAL_RESULT_NOTE =
  `${EPHEMERAL_RESULT_MARKER}: the provider does not permit these results to be stored or copied. ` +
  'AgentConnect keeps none of them in its own transcript. Use them to answer now; do not copy them ' +
  'into memory, a canvas, a file, or anywhere else they would outlive this answer.'

/** What replaces a redacted payload, so the transcript still shows the call happened. */
const REDACTED = 'omitted: this tool returns data the provider does not permit storing'

/** Does this serialized body carry a result its provider forbids storing? */
export function isEphemeralBody(serialized: string): boolean {
  return serialized.includes(EPHEMERAL_RESULT_MARKER)
}

/** The body to persist for an ephemeral result: the call, its arguments, and its outcome —
 *  never what it retrieved. `rawInput` stays because it is the agent's OWN query, which is not
 *  provider data, and dropping it would leave a transcript row nobody can interpret. */
export function redactEphemeralBody(body: ToolBody): ToolBody {
  return {
    ...body,
    ...(body.rawOutput !== undefined ? { rawOutput: REDACTED } : {}),
    ...(body.content !== undefined ? { content: [REDACTED] } : {})
  }
}
