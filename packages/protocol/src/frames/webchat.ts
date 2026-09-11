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
  detail: z.string().max(240).optional(),
  // The turn was delivered INTO the running turn over `_session/steering` (#1847); its own
  // stream ends at once with `stopReason: 'steered_into_turn'` and the live reply continues.
  steered: z.boolean().optional()
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

/** The most fields one elicitation card renders. A card is a question standing in a
 *  transcript, not a settings page: past ten controls the reader cannot take the ask in, and
 *  the daemon must hold and re-validate every field of the record that answers it. A longer
 *  form is declined, which is honest — the agent can ask again in smaller pieces. */
export const ELICIT_FORM_FIELD_CAP = 10

/** The most FIELDS one card's wire payload carries. The cap above counts QUESTIONS, and an
 *  AskUserQuestion bridge gives every question its own free-text companion (`customAnswerFor`),
 *  so a form at the cap arrives as twice that many properties — and answers with them too. */
export const ELICIT_FORM_WIRE_FIELD_CAP = ELICIT_FORM_FIELD_CAP * 2

/** The per-kind field descriptors of an elicitation card. Shared by the single-field card and
 *  by each entry of a multi-field form, so the two can never describe one field differently. */
const ElicitOptions = z.array(z.object({ value: z.string(), label: z.string() }))
const ElicitMulti = z.object({
  minItems: z.number().int().min(0).optional(),
  maxItems: z.number().int().min(0).optional()
})
const ElicitText = z.object({
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  pattern: z.string().max(200).optional(),
  format: z.enum(['email', 'uri', 'date', 'date-time']).optional()
})
const ElicitNumber = z.object({
  integer: z.boolean().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional()
})
const ElicitDefault = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])

/** One field of a multi-field form card: the descriptors above plus what only a form needs —
 *  the schema key the answer is returned under, a label to render it beside, its kind (a
 *  boolean's two options are indistinguishable from an enum's otherwise), and whether the
 *  schema requires it, since an optional field may be left out of the answer entirely. */
export const ElicitField = z.object({
  propName: z.string().min(1).max(200),
  label: z.string(),
  kind: z.enum(['enum', 'boolean', 'multi-enum', 'text', 'number']),
  required: z.boolean().optional(),
  /** The schema's own `description` — the question text, where the title is only its header. */
  description: z.string().max(300).optional(),
  /** Set on a select question's free-text companion: the property whose question this box types
   *  an answer for. The card renders it INSIDE that question rather than as a question of its
   *  own, and never numbers or counts it. What said so — an ACP `_askUserQuestionCustomAnswer`
   *  marker, Codex's `_meta.codex.isOtherAnswer`, or, for a bridge that marks nothing, the pair's
   *  own property names — is the daemon's to read: the raw schema never crosses this wire, so a
   *  reader has only this field. */
  customAnswerFor: z.string().min(1).max(200).optional(),
  options: ElicitOptions,
  multi: ElicitMulti.optional(),
  text: ElicitText.optional(),
  number: ElicitNumber.optional(),
  defaultValue: ElicitDefault.optional()
})
export type ElicitField = z.infer<typeof ElicitField>

/** ONE elicitation card, as the daemon reduced it. Both the live event below and the
 *  transcript row that persists the card (`ElicitBody`) are this shape, so a reader who
 *  loads the conversation later is shown the very card the reader in the moment answered.
 *
 *  The agent asked for a choice (ACP `elicitation/create`, form or url mode) — webchat's own
 *  in-band card, the peer of the Slack Block Kit one. Deliberately NOT the raw
 *  `requestedSchema`: the daemon has already reduced the form to its renderable field(s), and
 *  its options are the only answers the browser may send back (as the `elicitation_choice` op
 *  keyed by this `requestId`). `message` is agent-authored text, masked before it reaches here.
 *  Options are UNCAPPED — the Slack button cap is a Slack surface limit and does not follow the
 *  choice onto this surface. They are also EMPTY for a typed field (`text`/`number`), whose
 *  card offers nothing to pick. */
export const ElicitCard = z.object({
  requestId: z.string().min(1).max(200),
  message: z.string(),
  options: ElicitOptions,
  // Absent ⇒ pick exactly ONE option, the original card. Present ⇒ pick several of the same
  // options and confirm, and the answer is a list. An added OPTIONAL field rather than a new
  // event kind on purpose: a relay or browser predating it decodes the event unchanged
  // (zod strips what it does not know) instead of dropping the frame the way an unknown
  // kind would, and a daemon predating it simply never sets it.
  multi: ElicitMulti.optional(),
  // Present ⇒ the card is a free-text input carrying the schema's own constraints, which the
  // daemon re-checks on the way back in. Same optional-field reasoning as `multi`, with one
  // added skew note: an old reader keeps `options` (now empty) and shows a card with nothing
  // but Dismiss — unanswerable, never wrongly answered. `pattern` reaches here only once the
  // daemon has cleared it as safe to run.
  text: ElicitText.optional(),
  // Present ⇒ a numeric input; `integer` is the schema's `integer` type, not just a bound.
  number: ElicitNumber.optional(),
  // The schema's `default`, already checked against the constraints above: the card
  // pre-populates its control with it (MCP `2025-11-25`), and the reader may answer otherwise.
  defaultValue: ElicitDefault.optional(),
  // Present ⇒ the card is a multi-field FORM: one control per field, one submit, and the
  // answer is a record of value-per-field. The single-field descriptors above are then all
  // absent — deliberately, and the same closed-failure trade `text` records: an old reader
  // sees an optionless card it can only Dismiss, rather than a card it could half-fill with
  // one field's answer that the daemon would then refuse.
  fields: z.array(ElicitField).min(2).max(ELICIT_FORM_WIRE_FIELD_CAP).optional(),
  // Present ⇒ the card is a URL-mode CONSENT card (ACP `ElicitationUrlMode`): the reader is
  // shown this exact URL and opens it in their own browser, and nothing about the page ever
  // returns here. `options` is then empty and every field descriptor above is absent, so the
  // same closed skew `text` records holds — an old reader sees a card it can only Dismiss,
  // which the daemon reads as the spec's `decline`, never as consent. Only http/https reach
  // here; the daemon declines any other scheme rather than hand a browser an unopenable href.
  url: z.string().min(1).max(2048).optional()
})
export type ElicitCard = z.infer<typeof ElicitCard>

/**
 * The most HTML one MCP App template may carry.
 *
 * The number comes from the wire, not from taste. The template is INLINED on the event rather
 * than linked, because the CP stores no bodies (webchat-mcp-apps.md §8), so it rides the same
 * `rd/chat` frame every reply chunk does — and that frame is capped at {@link MAX_FRAME_BYTES}
 * (256 KiB). A template is then JSON-escaped into it, and HTML is quote-dense enough that the
 * escape can approach 2×, so the cap is set at 96 KiB: under half the frame budget even before
 * the card's other fields and the envelope, which leaves a quote-heavy document room to fit
 * rather than encoding to something the relay would refuse.
 *
 * A larger template is DECLINED with a notice rather than truncated — half a document renders as
 * a broken page, which is the one outcome worse than saying the interface could not be shown.
 */
export const MCP_APP_HTML_MAX_BYTES = 96 * 1024

/** The most one card's whole encoded payload may take, including the tool result it carries
 *  through. Checked where the card is assembled, because the template cap alone does not bound a
 *  tool that answered with a megabyte of `structuredContent` — and a card that cannot encode is a
 *  frame the reader never sees, for a reason nothing in the stream would explain. */
export const MCP_APP_CARD_MAX_BYTES = 160 * 1024

/** The most live app cards one conversation holds. A fifth settles the oldest as `superseded`:
 *  every live card is an armed iframe with a tool-calling bridge, and an unbounded stack of
 *  them is an unbounded stack of those. */
export const MCP_APP_LIVE_CAP = 4

/** The domain allowlists an MCP App resource declared, each widening exactly its own CSP
 *  directive (SEP-1865). The host builds the policy FROM this and never from the page, and may
 *  restrict further but must not admit an undeclared domain — so an absent list is the
 *  restrictive default, not "anything". */
export const McpAppCsp = z.object({
  /** `connect-src` — fetch / XHR / WebSocket. */
  connect: z.array(z.string().min(1).max(253)).max(32).optional(),
  /** `script-src` / `style-src` / `img-src` / `font-src` — static assets. */
  resource: z.array(z.string().min(1).max(253)).max(32).optional(),
  /** `frame-src` — nested iframes. */
  frame: z.array(z.string().min(1).max(253)).max(32).optional(),
  /** `base-uri`. */
  baseUri: z.array(z.string().min(1).max(253)).max(32).optional()
})
export type McpAppCsp = z.infer<typeof McpAppCsp>

/** `containerDimensions` — what the view negotiated. An axis marked flexible is the one the
 *  view may grow along by reporting `ui/notifications/size-changed`; a fixed axis is the
 *  host's to decide, so the view's report on it is ignored rather than obeyed. */
export const McpAppDimensions = z.object({
  width: z.number().int().min(1).max(4096).optional(),
  height: z.number().int().min(1).max(4096).optional(),
  flexibleWidth: z.boolean().optional(),
  flexibleHeight: z.boolean().optional()
})
export type McpAppDimensions = z.infer<typeof McpAppDimensions>

/**
 * ONE MCP App card, as the daemon's Apps host assembled it — the peer of {@link ElicitCard},
 * and webchat's ONLY rich-UI surface by construction (webchat-mcp-apps.md §2).
 *
 * A UI-capable MCP server predeclares an interface as a `ui://` resource and links it to a tool
 * with `_meta.ui.resourceUri`; the daemon — which is the MCP Apps host, because no ACP runtime
 * is (§3) — reads the template, calls the tool, and streams both here. The browser renders the
 * template in an OPAQUE-origin sandboxed frame and speaks MCP's own JSON-RPC to it over
 * `postMessage`, forwarding the four host methods that need the daemon back as the `app_rpc` op.
 *
 * This card is NOT an elicitation: the tool's own result returns to the model the moment the
 * call completes, so an app that is never opened, never answered, or shown on a surface with no
 * renderer never blocks the turn. What the reader does in the frame reaches the agent through
 * ordinary tool calls and `ui/message`, not through a parked resolver.
 */
export const McpAppCard = z.object({
  /** The unguessable id every RPC from this view carries back — the card's identity, exactly as
   *  `requestId` is an elicitation card's. A view may only reach the server that opened it, and
   *  only while this id is live in its own conversation. */
  appId: z.string().min(1).max(200),
  /** The words above the frame, and the words the decline uses on a surface that has none. */
  title: z.string().max(200),
  /** The tool that opened the frame, namespaced `<server>__<tool>` as the bridge exposes it. */
  toolName: z.string().min(1).max(200),
  /** The `ui://` template's own text (`text/html;profile=mcp-app`). The BYTE cap
   *  ({@link MCP_APP_HTML_MAX_BYTES}) is enforced where the bytes are — the daemon reads the
   *  resource and declines an oversized one before a card exists. What rides here is the cheap
   *  guard a decoder can afford on every frame: the same number counted in characters, which
   *  cannot admit anything the byte cap rejects for ASCII and stays a hard ceiling regardless. */
  html: z.string().min(1).max(MCP_APP_HTML_MAX_BYTES),
  /** The call's arguments, handed to the view as `ui/notifications/tool-input`. */
  toolInput: z.record(z.string(), z.unknown()).optional(),
  /** The call's result, handed to the view as `ui/notifications/tool-result`. `structuredContent`
   *  is the UI-optimized half the spec keeps out of model context; `content` is the text the
   *  model already received, carried again so a view may render exactly what the agent read. */
  toolResult: z
    .object({
      content: z.array(z.unknown()).max(64).optional(),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
      isError: z.boolean().optional()
    })
    .optional(),
  csp: McpAppCsp.optional(),
  dimensions: McpAppDimensions.optional()
})
export type McpAppCard = z.infer<typeof McpAppCard>

/** How a live app card stopped being one. `closed` is the reader dismissing the frame,
 *  `superseded` the same conversation opening past {@link MCP_APP_LIVE_CAP}, `expired` the
 *  session ending under it. Every one of them renders the card inert and keeps its header and
 *  final result — a persisted app is the record of a decision, never a page re-armed against a
 *  session that no longer exists (§8). */
export const McpAppOutcome = z.enum(['closed', 'superseded', 'expired'])
export type McpAppOutcome = z.infer<typeof McpAppOutcome>

/** The most model context one app may hold (`ui/update-model-context`). An app's context is a
 *  note for the next turn, not a store: the session carries it, and the reader who opened the
 *  frame is the one it speaks for. */
export const MCP_APP_CONTEXT_MAX_CHARS = 4000

/**
 * What a view may ASK THE DAEMON for — the four host methods of SEP-1865 that cannot be served
 * in the browser, reduced to a checked union rather than forwarded as raw JSON-RPC.
 *
 * The reduction is the point. Everything else the spec gives a view (`ui/initialize`, the size
 * and logging notifications, `ui/open-link`) is browser-local and never reaches a wire, so what
 * remains here is exactly the surface with an authorization question attached — and a union the
 * daemon can validate before it acts beats a passthrough it has to sanitize after. The candidate
 * set for every one of them comes from the trusted session snapshot, never from this payload:
 * `appId` names a live card in the sender's OWN conversation, and that card names the one server
 * whose tools and resources the view may reach.
 */
export const McpAppRpc = z.discriminatedUnion('method', [
  // `tools/call` — a real tool call on this app's own server, recorded in the transcript like any
  // other. An app cannot act invisibly.
  z.object({
    method: z.literal('tools/call'),
    name: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).optional()
  }),
  // `resources/read` — this app's own server only, which is what makes a bare uri safe to take.
  z.object({ method: z.literal('resources/read'), uri: z.string().min(1).max(2048) }),
  // `ui/message` — the frame speaking into the conversation. Delivered as an ordinary user turn
  // attributed to the reader, and charged the same hop budget an agent-call activation is: a page
  // that can post is a loop source, and `hopCount` exists for exactly that.
  z.object({ method: z.literal('ui/message'), text: z.string().min(1).max(4000) }),
  // `ui/update-model-context` — what the app wants the next turn to know. Held on the session.
  z.object({ method: z.literal('ui/update-model-context'), context: z.string().max(MCP_APP_CONTEXT_MAX_CHARS) })
])
export type McpAppRpc = z.infer<typeof McpAppRpc>

/** One view RPC's answer, as the daemon hands it back for the browser to complete the view's
 *  JSON-RPC call with. `ok:false` carries a message the frame may show; it is never a transport
 *  failure dressed as a result — an undeliverable RPC never reaches here at all. */
export const McpAppRpcResult = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().max(500) })
])
export type McpAppRpcResult = z.infer<typeof McpAppRpcResult>

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
  // `standing` ⇒ the line is not a wait but something the reader has to keep: an ask this surface
  // could not show, or an answer it would not take (#1794). A wait notice retires the moment
  // output resumes, which would delete exactly those lines; a standing one stays put. An added
  // OPTIONAL field rather than a new kind, for the reason `elicitation.multi` records: a relay or
  // browser predating it decodes the event unchanged and merely retires the line early, where an
  // unknown kind would drop the frame and leave the silence this field exists to end.
  z.object({ kind: z.literal('notice'), text: z.string(), standing: z.boolean().optional() }),
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
  ElicitCard.extend({ kind: z.literal('elicitation') }),
  // The same card, settled. Slack rewrites its message in place; this stream is
  // append-only, so the collapse is a second event keyed by the same `requestId`.
  // `label` is the chosen option's label — the chosen labels joined, for a multi-select —
  // and is present only on 'accepted'.
  // 'completed' is URL mode's second settlement (ACP `elicitation/complete`): the card is
  // already 'accepted' at consent, and this only re-labels it once the agent says the flow
  // finished. An old reader fails THIS frame's decode and keeps showing the consented card —
  // the losing direction is a missing "Completed" label, never a wrong verdict.
  z.object({
    kind: z.literal('elicitation_resolved'),
    requestId: z.string().min(1).max(200),
    outcome: z.enum(['accepted', 'dismissed', 'cancelled', 'completed']),
    label: z.string().optional()
  }),
  // An MCP App opened (webchat-mcp-apps.md §5). A new KIND rather than a field on something
  // existing, and the skew that follows is the closed one: a relay or browser predating it fails
  // exactly this frame's decode and shows the turn without the frame, while the tool's own text
  // result has already reached the model — so the agent still answered in words and nothing
  // waits on a reader who was never shown anything. An elicitation could not take that trade,
  // which is why `multi`/`text`/`url` went on the card as optional fields instead.
  McpAppCard.extend({ kind: z.literal('app') }),
  // The same card, settled — append-only, keyed by `appId`, exactly as `elicitation_resolved` is.
  z.object({ kind: z.literal('app_resolved'), appId: z.string().min(1).max(200), outcome: McpAppOutcome }),
  // One view RPC's answer, correlated by the `callId` the browser minted on the `app_rpc` op.
  // It rides the reply STREAM rather than a request/reply frame of its own, because the stream is
  // the only channel webchat has that already survives what an app's RPC has to survive: the
  // relay bridging a browser onto a daemon, a reconnect mid-call, and a turn ending underneath it.
  // The browser completes the view's JSON-RPC call from this; an answer with no live call is
  // dropped, which is what makes a replayed stream harmless.
  z.object({
    kind: z.literal('app_rpc_result'),
    appId: z.string().min(1).max(200),
    callId: z.string().min(1).max(64),
    outcome: McpAppRpcResult
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
  // Whether a message sent while this turn runs can be steered into it over the runtime's
  // `_session/steering` (#1847): the composer then sends at once instead of queueing locally.
  steerable: z.boolean().optional(),
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
