// Computer form filling (computer-form-fill-and-vault.md): field descriptors, fill requests and results, and the extension wire.
import { z } from 'zod'

/** The extension wire and the desktop's internal form tools; both sides refuse any other version. */
export const COMPUTER_FORM_FILL_PROTOCOL = 1

/** The model-facing tool (§5.1); the desktop's internal tools below are never offered to a model. */
export const COMPUTER_FILL_FORM_TOOL = 'computer_fill_form'
/** Desktop-internal MCP tools an agent daemon calls over the data plane; values ride only the fill call. */
export const COMPUTER_FORM_DISCOVER_TOOL = 'computer_form_discover'
export const COMPUTER_FORM_FILL_TOOL = 'computer_form_fill'
export const COMPUTER_FORM_STATUS_TOOL = 'computer_form_status'
export const COMPUTER_FORM_INTERNAL_TOOLS = [
  COMPUTER_FORM_DISCOVER_TOOL,
  COMPUTER_FORM_FILL_TOOL,
  COMPUTER_FORM_STATUS_TOOL
] as const

/** The WebSocket subprotocol the extension offers the desktop daemon's loopback endpoint. */
export const COMPUTER_FORM_FILL_SUBPROTOCOL = 'agentconnect.form-fill.v1'
/** The `chrome.storage.managed` key (3rdparty policy) that names the endpoint, e.g. `ws://127.0.0.1:7682/`. */
export const COMPUTER_FORM_FILL_ENDPOINT_KEY = 'endpoint'

export const COMPUTER_FORM_FIELDS_MAX = 100
export const COMPUTER_FORM_FORMS_MAX = 20
export const COMPUTER_FORM_OPTIONS_MAX = 200
export const COMPUTER_FORM_VALUE_MAX_CHARS = 4096
export const COMPUTER_FORM_TEXT_MAX_CHARS = 200
/** How long a fill may run in the page before its outcome is `uncertain` (§8). */
export const COMPUTER_FORM_FILL_TIMEOUT_MS = 15_000

const Text = z.string().max(COMPUTER_FORM_TEXT_MAX_CHARS)
const OpaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
/** A serialized origin (`https://host[:port]`), never a URL with a path, query or fragment. */
export const ComputerFormOrigin = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.origin === value && (url.protocol === 'https:' || url.protocol === 'http:')
    } catch {
      return false
    }
  }, 'expected a serialized http(s) origin')

/** The element kinds a descriptor reports; anything else is not offered for filling. */
export const COMPUTER_FORM_CONTROLS = [
  'text',
  'email',
  'password',
  'tel',
  'number',
  'url',
  'search',
  'date',
  'textarea',
  'select',
  'checkbox',
  'radio'
] as const
export type ComputerFormControl = (typeof COMPUTER_FORM_CONTROLS)[number]

/** What a field asks for, mapped deterministically from autocomplete, then type, name and label (§5). */
export const COMPUTER_FORM_PURPOSES = [
  'username',
  'email',
  'current-password',
  'new-password',
  'one-time-code',
  'name',
  'given-name',
  'family-name',
  'tel',
  'organization',
  'street-address',
  'address-line1',
  'address-line2',
  'address-level2',
  'address-level1',
  'postal-code',
  'country',
  'unknown'
] as const
export type ComputerFormPurpose = (typeof COMPUTER_FORM_PURPOSES)[number]

/** Purposes that are always secret, whatever the input type (§4.3). */
export const COMPUTER_FORM_SECRET_PURPOSES: ReadonlySet<ComputerFormPurpose> = new Set([
  'current-password',
  'new-password',
  'one-time-code'
])

export const COMPUTER_FORM_KINDS = ['login', 'registration', 'personal_info', 'other'] as const
export type ComputerFormKind = (typeof COMPUTER_FORM_KINDS)[number]

/** One editable field, without its current value (§5). */
export const ComputerFormField = z
  .object({
    id: OpaqueId,
    control: z.enum(COMPUTER_FORM_CONTROLS),
    purpose: z.enum(COMPUTER_FORM_PURPOSES),
    // Several heuristics disagreed; the card asks a person instead of guessing.
    ambiguous: z.boolean().optional(),
    label: Text.optional(),
    name: Text.optional(),
    placeholder: Text.optional(),
    autocomplete: z.string().max(100).optional(),
    required: z.boolean(),
    // Rendered masked or always secret by purpose: never echoed to a model, a transcript or a log.
    secret: z.boolean(),
    // Whether it holds a value now; the value itself is never read.
    empty: z.boolean(),
    maxLength: z.number().int().min(1).max(1_000_000).optional(),
    // A select's or radio group's choices: page content, not a person's input.
    options: z
      .array(z.object({ value: z.string().max(512), label: Text }).strict())
      .max(COMPUTER_FORM_OPTIONS_MAX)
      .optional()
  })
  .strict()
export type ComputerFormField = z.infer<typeof ComputerFormField>

/** One form in the frame that holds it; a frame's loose fields form one form too. */
export const ComputerForm = z
  .object({
    id: OpaqueId,
    kind: z.enum(COMPUTER_FORM_KINDS),
    // A field of this form has focus.
    focused: z.boolean(),
    frameOrigin: ComputerFormOrigin,
    fields: z.array(ComputerFormField).max(COMPUTER_FORM_FIELDS_MAX)
  })
  .strict()
export type ComputerForm = z.infer<typeof ComputerForm>

/** Which document a fill writes to; rechecked before any field is written (§5). */
export const ComputerFormTarget = z
  .object({
    tabId: z.number().int().min(0),
    frameId: z.number().int().min(0),
    // Chromium's per-document id: a reload or navigation changes it.
    documentId: z.string().min(1).max(128),
    topOrigin: ComputerFormOrigin,
    frameOrigin: ComputerFormOrigin,
    formId: OpaqueId
  })
  .strict()
export type ComputerFormTarget = z.infer<typeof ComputerFormTarget>

/** `found`: one form selected; `ambiguous`: several, the agent picks one by id; `none`/`unsupported`: nothing to fill. */
export const COMPUTER_FORM_DISCOVERY_STATUSES = ['found', 'ambiguous', 'none', 'unsupported'] as const

export const ComputerFormDiscovery = z
  .object({
    v: z.literal(COMPUTER_FORM_FILL_PROTOCOL),
    status: z.enum(COMPUTER_FORM_DISCOVERY_STATUSES),
    // The active tab: what a card shows as the website, never its full URL.
    tab: z
      .object({ tabId: z.number().int().min(0), topOrigin: ComputerFormOrigin, title: Text.optional() })
      .strict()
      .optional(),
    // Set when `found`: the form a fill would write to.
    target: ComputerFormTarget.optional(),
    forms: z
      .array(ComputerForm.extend({ frameId: z.number().int().min(0), documentId: z.string().min(1).max(128) }))
      .max(COMPUTER_FORM_FORMS_MAX),
    reason: z.string().max(500).optional()
  })
  .strict()
export type ComputerFormDiscovery = z.infer<typeof ComputerFormDiscovery>

/** One value to write: text for inputs and selects, `checked` for checkboxes and radios. */
export const ComputerFormValue = z
  .object({
    field: OpaqueId,
    value: z.string().max(COMPUTER_FORM_VALUE_MAX_CHARS).optional(),
    checked: z.boolean().optional()
  })
  .strict()
  .refine((entry) => (entry.value === undefined) !== (entry.checked === undefined), 'set exactly one of value, checked')
export type ComputerFormValue = z.infer<typeof ComputerFormValue>

/** A field's outcome; `unverified`: written, but the page changed it back or rejected the events. */
export const COMPUTER_FORM_FIELD_STATUSES = [
  'filled',
  'unverified',
  'not_found',
  'disabled',
  'invalid_value',
  'skipped'
] as const
export type ComputerFormFieldStatus = (typeof COMPUTER_FORM_FIELD_STATUSES)[number]

// `target_changed`: the document, origin or form is no longer the discovered one, nothing written; `uncertain`: unknown, not retried.
export const COMPUTER_FORM_FILL_STATUSES = [
  'filled',
  'partial',
  'failed',
  'target_changed',
  'uncertain',
  'cancelled',
  'unsupported'
] as const
export type ComputerFormFillStatus = (typeof COMPUTER_FORM_FILL_STATUSES)[number]

export const ComputerFormFillResult = z
  .object({
    v: z.literal(COMPUTER_FORM_FILL_PROTOCOL),
    requestId: z.string().uuid(),
    status: z.enum(COMPUTER_FORM_FILL_STATUSES),
    fields: z
      .array(z.object({ field: OpaqueId, status: z.enum(COMPUTER_FORM_FIELD_STATUSES) }).strict())
      .max(COMPUTER_FORM_FIELDS_MAX),
    // The page navigated or reloaded during or right after the fill, e.g. a site that submits on input.
    navigated: z.boolean(),
    reason: z.string().max(500).optional()
  })
  .strict()
export type ComputerFormFillResult = z.infer<typeof ComputerFormFillResult>

// ---- the desktop's internal MCP tools (agent daemon → desktop over the data plane) ----

export const ComputerFormDiscoverArgs = z
  .object({
    v: z.literal(COMPUTER_FORM_FILL_PROTOCOL),
    // A form id from an earlier discovery; absent: the focused form, else the only eligible one.
    form: OpaqueId.optional()
  })
  .strict()
export type ComputerFormDiscoverArgs = z.infer<typeof ComputerFormDiscoverArgs>

export const ComputerFormFillArgs = z
  .object({
    v: z.literal(COMPUTER_FORM_FILL_PROTOCOL),
    // Chosen by the caller and never reused: a status query names it, and a repeated id is refused, never replayed.
    requestId: z.string().uuid(),
    target: ComputerFormTarget,
    values: z.array(ComputerFormValue).min(1).max(COMPUTER_FORM_FIELDS_MAX)
  })
  .strict()
export type ComputerFormFillArgs = z.infer<typeof ComputerFormFillArgs>

export const ComputerFormStatusArgs = z
  .object({ v: z.literal(COMPUTER_FORM_FILL_PROTOCOL), requestId: z.string().uuid() })
  .strict()
export type ComputerFormStatusArgs = z.infer<typeof ComputerFormStatusArgs>

/** A status query's answer: the stored result, still running, or unknown to this desktop (never ran, or expired). */
export const ComputerFormStatus = z
  .object({
    v: z.literal(COMPUTER_FORM_FILL_PROTOCOL),
    requestId: z.string().uuid(),
    state: z.enum(['done', 'running', 'unknown']),
    result: ComputerFormFillResult.optional()
  })
  .strict()
export type ComputerFormStatus = z.infer<typeof ComputerFormStatus>

// ---- the extension wire (extension service worker ⇄ desktop daemon loopback WebSocket) ----

/** The first frame: a build id compiled into the worker script, since Chromium may keep running a cached worker (§10). */
export const FormFillHello = z
  .object({
    type: z.literal('hello'),
    protocol: z.number().int().min(1),
    buildId: z.string().min(1).max(128),
    version: z.string().min(1).max(64)
  })
  .strict()
export type FormFillHello = z.infer<typeof FormFillHello>

/** The daemon accepts the extension; a refusal closes the socket with a {@link FORM_FILL_CLOSE} code instead. */
export const FormFillWelcome = z
  .object({ type: z.literal('welcome'), protocol: z.literal(COMPUTER_FORM_FILL_PROTOCOL) })
  .strict()
export type FormFillWelcome = z.infer<typeof FormFillWelcome>

export const FORM_FILL_CLOSE = {
  /** The socket is not attributed to a known desktop browser profile. */
  unattributed: 4401,
  /** The extension speaks another protocol or carries another build than the one installed with this daemon. */
  unsupported: 4426,
  /** A newer connection from the same desktop took over. */
  superseded: 4409
} as const

/** Daemon → extension requests; every one gets exactly one {@link FormFillReply} with its id. */
export const FormFillRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('discover'), id: z.number().int().min(1), form: OpaqueId.optional() }).strict(),
  z
    .object({
      type: z.literal('fill'),
      id: z.number().int().min(1),
      requestId: z.string().uuid(),
      target: ComputerFormTarget,
      values: z.array(ComputerFormValue).min(1).max(COMPUTER_FORM_FIELDS_MAX)
    })
    .strict(),
  z.object({ type: z.literal('ping'), id: z.number().int().min(1) }).strict()
])
export type FormFillRequest = z.infer<typeof FormFillRequest>

export const FormFillReply = z
  .object({
    type: z.literal('reply'),
    id: z.number().int().min(1),
    discovery: ComputerFormDiscovery.optional(),
    fill: ComputerFormFillResult.optional(),
    error: z.string().max(500).optional()
  })
  .strict()
export type FormFillReply = z.infer<typeof FormFillReply>

// ---- the Fill card (computer-form-fill-and-vault.md §6): what a person sees, and how it settles ----

/** How long a Fill card waits for its person before it expires unanswered. */
export const COMPUTER_FILL_CARD_TTL_MS = 10 * 60_000

/** The card the agent daemon shows for one pending fill: the website and its field descriptors, never a value. */
export const ComputerFillCard = z
  .object({
    requestId: z.string().uuid(),
    computerName: Text,
    // The site as the browser reports it: a person decides by this, never by the agent's claim.
    website: z.object({ origin: ComputerFormOrigin, title: Text.optional() }).strict(),
    // Set when the form lives in a frame from another origin than the page.
    frameOrigin: ComputerFormOrigin.optional(),
    kind: z.enum(COMPUTER_FORM_KINDS),
    fields: z.array(ComputerFormField).min(1).max(COMPUTER_FORM_FIELDS_MAX),
    // The agent's one line on why it asks.
    reason: Text.optional(),
    expiresAt: z.string().datetime()
  })
  .strict()
export type ComputerFillCard = z.infer<typeof ComputerFillCard>

/** How a card ended; never a value, so it can be streamed and kept like any settled card. */
export const COMPUTER_FILL_CARD_OUTCOMES = [
  'filled',
  'partial',
  'failed',
  'uncertain',
  'target_changed',
  'unsupported',
  'cancelled',
  'expired'
] as const
export type ComputerFillCardOutcome = (typeof COMPUTER_FILL_CARD_OUTCOMES)[number]
