import { z } from 'zod'

// webchat's content plane is the RELAY, not the daemon↔CP control WS:
// a browser dials the relay pool with a CP-minted token and the relay bridges the
// conversation onto the target daemon's rd/* socket. These payloads describe the reply
// stream + the turn verdict; the relay's `rd/chat` / `rd/ack` frames REUSE them verbatim
// (packages/protocol/src/frames/relay-daemon.ts). Live content never touches the CP;
// an authorized session-history read may later proxy a daemon-local image for display.

// The browser rasterizes/compresses one selected image below this cap. It fits the
// relay ingress frame and, later, one daemon→CP history frame with base64 expansion.
export const WEBCHAT_IMAGE_MAX_BYTES = 160 * 1024
export const WEBCHAT_IMAGE_MAX_BASE64_CHARS = Math.ceil(WEBCHAT_IMAGE_MAX_BYTES / 3) * 4

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

export const WebchatImageAttachment = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^\u0000-\u001f\u007f]+$/, 'webchat image name must not contain control characters'),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z
    .string()
    .min(4)
    .max(WEBCHAT_IMAGE_MAX_BASE64_CHARS)
    .refine((value) => CANONICAL_BASE64.test(value) && decodedBase64Bytes(value) <= WEBCHAT_IMAGE_MAX_BYTES, {
      message: `webchat image must be canonical base64 encoding at most ${WEBCHAT_IMAGE_MAX_BYTES} bytes`
    })
})
export type WebchatImageAttachment = z.infer<typeof WebchatImageAttachment>

// The webchat turn verdict — `dispatchWebchatTurn` returns this and the relay path folds
// it into `rd/ack` (accepted + the turnId that correlates the reply stream; `reason`
// explains a rejection). Not a wire frame of its own anymore.
// `agentId` attributes the verdict in a multi-agent conversation: a multi-target turn
// produces one ack per targeted agent. Absent ⇒ the conversation's sole agent.
export const WebchatAck = z.object({
  accepted: z.boolean(),
  turnId: z.string().uuid(), // correlates the streamed output to this turn
  agentId: z.string().uuid().optional(),
  // The last three are session-continuation refusals
  // (webchat-cross-integration-continuation.md §5.2/§6.4).
  reason: z
    .enum([
      'queued',
      'no_agent',
      'busy',
      'paused',
      'draining',
      'not_participant',
      'not_found',
      'integration_offline',
      'integration_delivery_failed',
      // The daemon owns this agent but its runtime would not start — distinct from `no_agent`,
      // which says no daemon serves it at all. Only this one carries `detail`.
      'start_failed'
    ])
    .optional(),
  // One bounded, path-free line naming the fault, so the client can state the cause instead of
  // guessing at it. The daemon redacts it; nothing here reveals its filesystem layout.
  detail: z.string().max(240).optional()
})
export type WebchatAck = z.infer<typeof WebchatAck>

// One canonical conversation post — the unit every participant daemon records and
// the browser merges by `(at, postId)`. Identity (`postId`, `at`) is minted exactly
// ONCE at the origin (the relay for a user turn, the owning daemon for an agent
// reply) and carried on every frame that transports the post, so all copies agree
// on ordering and the shared transcript dedupes across co-hosted participants.
export const WebchatPost = z.object({
  postId: z.string().uuid(),
  conversationId: z.string().uuid(),
  author: z.discriminatedUnion('kind', [
    // `userId` is the stable CP principal and is what a recipient records as the
    // transcript sender; `user` is the mutable display handle for the author line.
    z.object({ kind: z.literal('user'), user: z.string().optional(), userId: z.string().optional() }),
    z.object({
      kind: z.literal('agent'),
      agentId: z.string().uuid(),
      // The authoring TURN's depth in the agent-call chain (send-message-routing-
      // rework.md §4.1), stamped by the origin daemon at the commit boundary. A
      // receiving participant's daemon charges ONE +1 transition on it — against the
      // same MAX_AGENT_CALL_HOPS budget an internal agent call spends — before the
      // post may continue the conversation as an activation (webchat-multi-agents.md
      // §5.2a, the #549 parity). Absent (a pre-parity daemon), the post stays
      // transcript-only: a missing depth must never coerce to zero.
      hopCount: z.number().int().min(0).optional()
    })
  ]),
  text: z.string(),
  at: z.number().int(), // canonical epoch-ms timestamp, minted once at origin
  attachments: z.array(WebchatImageAttachment).max(1).optional()
})
export type WebchatPost = z.infer<typeof WebchatPost>

// One structured chunk of the agent's reply stream. Ordered per-connection (TCP);
// 'index' is a per-turn monotonic counter for client-side assembly (NOT a global fence).
/**
 * One entry of an agent's task list, as ACP `plan` sends it. Defined HERE rather than
 * beside `PlanBody` in session.ts because both the live stream and the persisted row carry
 * it and session.ts already imports this module — the other direction would be a cycle.
 */
export const PlanEntry = z.object({
  content: z.string(),
  status: z.string(), // ACP PlanEntryStatus: pending|in_progress|completed
  priority: z.string().optional() // ACP PlanEntryPriority: high|medium|low
})
export type PlanEntry = z.infer<typeof PlanEntry>

export const WebchatEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), text: z.string() }), // from agent_message_chunk
  z.object({ kind: z.literal('thinking'), text: z.string() }), // from agent_thought_chunk
  z.object({ kind: z.literal('tool_call'), toolCallId: z.string(), title: z.string(), status: z.string() }),
  // `title` is set only when this update refines the initial `tool_call` title (e.g.
  // Codex web_search names itself generically first, then retitles with the actual
  // query once known) — mirrors the ACP field so the live view can retitle in place
  // the same way the persisted transcript already does (TranscriptRecorder.titles).
  z.object({
    kind: z.literal('tool_update'),
    toolCallId: z.string(),
    status: z.string(),
    title: z.string().optional()
  }),
  // The runtime's auto-generated session title (from ACP session_info_update). The
  // daemon persists it (session/list surfaces it on the persisted row); this streams
  // the same value so the LIVE playground session renames itself in place, matching
  // what a Slack session shows once its title lands.
  z.object({ kind: z.literal('session_info'), title: z.string() }),
  // A turn-final context refresh discarded the streamed candidate
  // (webchat-multi-agents.md §5.4): the conversation changed while the agent was
  // answering, so the browser collapses this lane's streamed text in place and
  // the replacement generation streams next under the SAME turnId. `generation`
  // is the replacement's ordinal (1 = first retry). An event rather than a
  // terminal frame: the turn still ends with exactly one `done`, so replay,
  // busy-state, and older browsers (which ignore unknown kinds) stay coherent.
  z.object({ kind: z.literal('superseded'), generation: z.number().int() }),
  // Live-only chrome for a wait the user cannot otherwise see (a cluster sandbox pod coming up).
  // Never persisted — a refresh rebuilds from the transcript, which does not record it.
  z.object({ kind: z.literal('notice'), text: z.string() }),
  // The turn's task list (ACP `plan`). Unlike every other kind here it is a SNAPSHOT: ACP
  // resends the whole list on each revision, so the client keeps the latest and never
  // appends. Streamed because the same block already lands in the persisted transcript
  // (transcript-full-tool-body.md §8) — without it a live turn hides its plan until the
  // page is re-read from history, which is exactly the gap this closes.
  // COMPAT: a relay predating this kind fails that ONE frame's decode and drops the chunk.
  // Non-fatal by construction — the relay answers with an error frame and keeps the
  // connection, so every other chunk still flows and the turn degrades to showing its plan
  // only after the fact. There is no relay capability echo to gate on (`rd/hello/ok` carries
  // only `relayId`), so this is the tradeoff rather than an oversight.
  z.object({ kind: z.literal('plan'), entries: z.array(PlanEntry) }),
  // The agent asked for a choice (ACP `elicitation/create`, form mode) — webchat's own
  // in-band card, the peer of the Slack Block Kit one. Deliberately NOT the raw
  // `requestedSchema`: the daemon has already reduced the form to the one renderable
  // field, and its options are the only answers the browser may send back (as the
  // `elicitation_choice` op keyed by this `requestId`). `message` is agent-authored text,
  // masked before it reaches here. Options are UNCAPPED — the Slack 5-button cap is a
  // Slack surface limit and does not follow the choice onto this surface. They are also
  // EMPTY for a typed field (`text`/`number`), whose card offers nothing to pick.
  z.object({
    kind: z.literal('elicitation'),
    requestId: z.string().min(1).max(200),
    message: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
    // Absent ⇒ pick exactly ONE option, the original card. Present ⇒ pick several of the same
    // options and confirm, and the answer is a list. An added OPTIONAL field rather than a new
    // event kind on purpose: a relay or browser predating it decodes the event unchanged
    // (zod strips what it does not know) instead of dropping the frame the way an unknown
    // kind would, and a daemon predating it simply never sets it.
    multi: z
      .object({ minItems: z.number().int().min(0).optional(), maxItems: z.number().int().min(0).optional() })
      .optional(),
    // Present ⇒ the card is a free-text input carrying the schema's own constraints, which the
    // daemon re-checks on the way back in. Same optional-field reasoning as `multi`, with one
    // added skew note: an old reader keeps `options` (now empty) and shows a card with nothing
    // but Dismiss — unanswerable, never wrongly answered. `pattern` reaches here only once the
    // daemon has cleared it as safe to run.
    text: z
      .object({
        minLength: z.number().int().min(0).optional(),
        maxLength: z.number().int().min(0).optional(),
        pattern: z.string().max(200).optional(),
        format: z.enum(['email', 'uri', 'date', 'date-time']).optional()
      })
      .optional(),
    // Present ⇒ a numeric input; `integer` is the schema's `integer` type, not just a bound.
    number: z
      .object({
        integer: z.boolean().optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional()
      })
      .optional(),
    // The schema's `default`, already checked against the constraints above: the card
    // pre-populates its control with it (MCP `2025-11-25`), and the reader may answer otherwise.
    defaultValue: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional()
  }),
  // The same card, settled. Slack rewrites its message in place; this stream is
  // append-only, so the collapse is a second event keyed by the same `requestId`.
  // `label` is the chosen option's label — the chosen labels joined, for a multi-select —
  // and is present only on 'accepted'.
  z.object({
    kind: z.literal('elicitation_resolved'),
    requestId: z.string().min(1).max(200),
    outcome: z.enum(['accepted', 'dismissed', 'cancelled']),
    label: z.string().optional()
  })
])
export type WebchatEvent = z.infer<typeof WebchatEvent>

// The session status-bar snapshot (model / context / tokens / cost), rebuilt from
// the daemon's model selector + folded ACP usage. All fields optional so a partial
// snapshot is valid: context/cost stream live via ACP `usage_update`, while token
// totals only refresh at each turn's end. Carried as an extra field on the output
// payload (see below) rather than a reply-stream event — a status update is not part
// of the transcript and can arrive with no text chunk of its own.
export const WebchatStatus = z.object({
  model: z.string().optional(),
  effort: z.string().optional(),
  // Effective session permission preset; Codex Auto is composite rather than a raw mode.
  permissionMode: z.string().optional(),
  fastMode: z.boolean().optional(),
  contextUsed: z.number().int().optional(),
  contextSize: z.number().int().optional(),
  totalTokens: z.number().int().optional(),
  costAmount: z.number().optional(),
  costCurrency: z.string().optional(),
  // The models this session's runtime advertises as selectable (from the ACP model
  // config option) — populates the console's model dropdown. Absent ⇒ no selector.
  models: z.array(z.string()).optional(),
  // The reasoning-effort levels this session's runtime offers (from the ACP
  // `thought_level` config option, plus the synthetic `ultracode`/`max` entries on
  // Claude runtimes) — populates the console's effort dropdown. Absent ⇒ no selector.
  efforts: z.array(z.string()).optional(),
  // Selectable session permission modes, from the runtime's ACP `mode` select.
  // Omitted when the Agent disables chat-side changes.
  permissionModes: z.array(z.string()).optional(),
  // Whether the selected model advertises a fast-mode toggle (the ACP `model_config`
  // config option only appears once a fast-capable model is selected). Absent/false ⇒
  // no fast toggle shown.
  fastModeAvailable: z.boolean().optional(),
  // This conversation's session, by its outward id (session-concept.md §1.1), so the console can
  // deep-link to the session detail page. Absent until the session is created.
  sessionId: z.string().optional()
})
export type WebchatStatus = z.infer<typeof WebchatStatus>

// Daemon→browser reply payload, carried as an `output` item inside relay `rd/chat`:
// one chunk of a turn's reply and/or a status snapshot. `event` is optional so a
// status-only payload (no reply chunk) is valid; every payload still carries a
// monotonic `index` for client-side ordering.
export const WebchatOutput = z
  .object({
    conversationId: z.string().uuid(),
    turnId: z.string().uuid(),
    // Which participant is streaming — a multi-agent conversation renders one
    // stream lane per (turnId, agentId). Absent ⇒ the conversation's sole agent.
    agentId: z.string().uuid().optional(),
    index: z.number().int(),
    event: WebchatEvent.optional(),
    status: WebchatStatus.optional()
  })
  // A payload must carry at least one of event/status — an empty payload is meaningless.
  .refine((o) => o.event !== undefined || o.status !== undefined, {
    message: 'WebchatOutput must carry event and/or status'
  })
export type WebchatOutput = z.infer<typeof WebchatOutput>

// Daemon→browser terminal payload, carried as a `done` item inside relay `rd/chat`.
// `error` is set when the turn ended in FAILURE (agent failed to start, ACP
// handshake/prompt rejected) rather than completing — a human-readable reason the
// client renders instead of a normal reply. When present, `stopReason`/`usage` are
// absent (the turn produced no clean result).
export const WebchatDone = z.object({
  conversationId: z.string().uuid(),
  turnId: z.string().uuid(),
  // Which participant's turn ended (multi-agent attribution, as on WebchatOutput).
  agentId: z.string().uuid().optional(),
  // Last output index emitted before this terminal marker. A reconnecting browser
  // holds `done` until it has assembled every output through this index, so an
  // early terminal frame cannot hide a gap. Optional for rolling compatibility.
  lastIndex: z.number().int().min(-1).optional(),
  stopReason: z.string().optional(),
  usage: z.object({ used: z.number().int().optional(), cost: z.number().optional() }).optional(),
  error: z.string().optional()
})
export type WebchatDone = z.infer<typeof WebchatDone>

// Browser operations ride relay `rd/msg` as RelayWebchatOp. No webchat content
// frame is registered on the daemon↔CP control WS, so the CP stays off the
// webchat hot path.
