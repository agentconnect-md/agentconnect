import {
  GOOGLE_CHAT_ACTION_PARAMETER,
  GOOGLE_CHAT_PLATFORM,
  type NormalizedPlatformMessage
} from '@agentconnect.md/protocol'

// Plain-object views of the Chat interaction `Event` JSON; every field is optional because the body is only structurally trusted.
export interface GoogleChatUser {
  name?: string
  displayName?: string
  type?: string
  /** The user's Google Workspace domain id; a DM's tenant key derives from it (design §10.4). */
  domainId?: string
}

export interface GoogleChatSpace {
  name?: string
  spaceType?: string
  displayName?: string
  singleUserBotDm?: boolean
  spaceThreadingState?: string
  /** `customers/…`, the Workspace customer that owns a named Space; a DM carries none. */
  customer?: string
}

/** A card click's invoked function and its `{ key, value }` parameters, in the Chat-app shape. */
export interface GoogleChatFormAction {
  actionMethodName?: string
  parameters?: { key?: string; value?: string }[]
}

/** The add-on shaped twin of {@link GoogleChatFormAction} that Chat fills beside it, and an add-on request's `commonEventObject`. */
export interface GoogleChatCommonEventObject {
  invokedFunction?: string
  parameters?: Record<string, string>
  /** A card's input widgets by `name`; text and selection inputs answer in `stringInputs.value`. */
  formInputs?: Record<string, { stringInputs?: { value?: string[] } }>
  userLocale?: string
  hostApp?: string
  timeZone?: { id?: string; offset?: number }
}

export interface GoogleChatAnnotation {
  type?: string
  startIndex?: number
  length?: number
  userMention?: { user?: GoogleChatUser; type?: string }
}

export interface GoogleChatMessage {
  name?: string
  sender?: GoogleChatUser
  createTime?: string
  text?: string
  argumentText?: string
  annotations?: GoogleChatAnnotation[]
  thread?: { name?: string }
  threadReply?: boolean
  space?: GoogleChatSpace
  slashCommand?: unknown
  attachment?: unknown[]
}

export interface GoogleChatEvent {
  type?: string
  eventTime?: string
  space?: GoogleChatSpace
  message?: GoogleChatMessage
  user?: GoogleChatUser
  thread?: { name?: string }
  isDialogEvent?: boolean
  action?: GoogleChatFormAction
  common?: GoogleChatCommonEventObject
  /** Where a configuration flow started by `REQUEST_CONFIG` must send the browser back to. */
  configCompleteRedirectUrl?: string
}

/** One `chat.*Payload` of a Workspace add-on request (design §11); each carries only some of these. */
export interface GoogleChatAddOnPayload {
  space?: GoogleChatSpace
  message?: GoogleChatMessage
  configCompleteRedirectUri?: string
  isDialogEvent?: boolean
  dialogEventType?: string
}

/** A Workspace add-on request (`EventObject`, design §11); its `authorizationEventObject` holds user tokens and is never read. */
export interface GoogleChatAddOnEvent {
  commonEventObject?: GoogleChatCommonEventObject
  authorizationEventObject?: unknown
  chat?: {
    user?: GoogleChatUser
    space?: GoogleChatSpace
    eventTime?: string
    messagePayload?: GoogleChatAddOnPayload
    addedToSpacePayload?: GoogleChatAddOnPayload & { interactionAdd?: boolean }
    removedFromSpacePayload?: GoogleChatAddOnPayload
    buttonClickedPayload?: GoogleChatAddOnPayload
    appCommandPayload?: GoogleChatAddOnPayload
    widgetUpdatedPayload?: GoogleChatAddOnPayload
  }
}

/** Which of Google's two request forms a body is: a Chat API interaction `Event`, or a Workspace add-on `EventObject` (design §11). */
export type GoogleChatEventForm = 'chat' | 'addon'

/** The caller's verified installation facts; the app identity is never derived from the payload. */
export interface GoogleChatNormalizeContext {
  /** The receiving Chat app's own `users/…` resource name. */
  appUserName: string
  traceId: string
}

/** A membership observation; idempotent on (change, channel, actor, eventTimeMs) when no message exists. */
export interface GoogleChatMembershipChange {
  change: 'added' | 'removed'
  /** Full `spaces/…` resource name. */
  channel: string
  isDm: boolean
  /** The acting user's `users/…` name, when the event carries one. */
  actor?: string
  eventTimeMs?: number
}

export type GoogleChatUnsupportedReason =
  'event_type' | 'space_type' | 'group_dm' | 'dialog' | 'slash_command' | 'sender_type' | 'thread_missing'

export type GoogleChatInvalidReason = 'malformed' | 'cross_space' | 'thread_mismatch'

/** A card click (`CARD_CLICKED`): the function the button named, its parameters, and the coordinates it happened at. */
export interface GoogleChatInteraction {
  function: string
  parameters: Record<string, string>
  /** The card's input widgets by `name`, each as its list of string values. */
  formInputs: Record<string, string[]>
  /** The card message's `spaces/…/messages/…` name, when the event names one. */
  message?: string
  /** The clicking user's `users/…` name. */
  user: string
  /** Full `spaces/…` resource name. */
  space: string
  /** The `spaces/…/threads/…` resource the card sits in, when the event names one. */
  thread?: string
  isDm: boolean
}

/** Facts every classified event carries beside its payload: its tenant key (design §10.4) and the configuration return URL. */
export interface GoogleChatEventContext {
  /** `customers/…` for a Space event, `domains/…` for a DM event; absent for an event without a Workspace tenant. */
  tenant?: string
  configCompleteRedirectUrl?: string
}

/** `invalid` is a malformed request; `ignored`, `unsupported` and `interaction` are completed decisions that start no turn. */
export type GoogleChatEventResult =
  | ({
      kind: 'message'
      message: NormalizedPlatformMessage
      membership?: GoogleChatMembershipChange
    } & GoogleChatEventContext)
  | ({ kind: 'membership'; membership: GoogleChatMembershipChange } & GoogleChatEventContext)
  | ({ kind: 'interaction'; interaction: GoogleChatInteraction } & GoogleChatEventContext)
  | { kind: 'ignored'; reason: 'app_authored' }
  | { kind: 'unsupported'; reason: GoogleChatUnsupportedReason }
  | { kind: 'invalid'; reason: GoogleChatInvalidReason }

type Obj = Record<string, unknown>
type Invalid = { invalid: GoogleChatInvalidReason }
type MessageOutcome = { message: NormalizedPlatformMessage } | { skip: GoogleChatEventResult } | Invalid
type InteractionOutcome = { interaction: GoogleChatInteraction } | { skip: GoogleChatEventResult } | Invalid

// Colon-free segments keep `platform:channel:native` msgIds splittable (wire-coordinates.ts).
const SEGMENT = '[A-Za-z0-9._-]+'
const SPACE_NAME = new RegExp(`^spaces/(${SEGMENT})$`)
const USER_NAME = new RegExp(`^users/${SEGMENT}$`)
const CUSTOMER_NAME = new RegExp(`^customers/${SEGMENT}$`)
const DOMAIN_ID = new RegExp(`^${SEGMENT}$`)
const EVENT_TYPES = new Set(['MESSAGE', 'ADDED_TO_SPACE', 'REMOVED_FROM_SPACE', 'CARD_CLICKED'])
const CHILD_NAME = {
  messages: new RegExp(`^spaces/(${SEGMENT})/messages/${SEGMENT}$`),
  threads: new RegExp(`^spaces/(${SEGMENT})/threads/${SEGMENT}$`)
}
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/i
const MENTION_TYPES = new Set(['MENTION', 'ADD'])
const ATTACHMENT_NOTE = '[Attachment not read: Google Chat attachments are not supported.]'
// Where a converted add-on names the function of a card posted before its conversion.
const ACTION_METHOD_PARAMETER = '__action_method_name__'
// Each add-on payload and the Chat API event type it stands for; commands and widget updates keep types nothing serves.
const ADD_ON_PAYLOAD_TYPES = {
  messagePayload: 'MESSAGE',
  addedToSpacePayload: 'ADDED_TO_SPACE',
  removedFromSpacePayload: 'REMOVED_FROM_SPACE',
  buttonClickedPayload: 'CARD_CLICKED',
  appCommandPayload: 'APP_COMMAND',
  widgetUpdatedPayload: 'WIDGET_UPDATED'
} as const

function obj(value: unknown): Obj | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isInvalid(value: object): value is Invalid {
  return 'invalid' in value
}

// Epoch ms of an RFC 3339 timestamp, or undefined for anything that does not round-trip.
function rfc3339Ms(value: unknown): number | undefined {
  const m = typeof value === 'string' ? RFC3339.exec(value) : null
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  const local = Date.UTC(y, mo - 1, d, h, mi, s, Number((m[7] ?? '').slice(0, 3).padEnd(3, '0')))
  const at = new Date(local)
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return undefined
  if (at.getUTCHours() !== h || at.getUTCMinutes() !== mi || at.getUTCSeconds() !== s) return undefined
  const [oh, om] = [Number(m[9] ?? 0), Number(m[10] ?? 0)]
  if (oh > 23 || om > 59) return undefined
  const ms = local - (m[8] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined
}

// A child resource name of `space`, or why it cannot be one.
function childOf(space: string, collection: keyof typeof CHILD_NAME, value: unknown): string | Invalid {
  const name = str(obj(value)?.name) ?? (typeof value === 'string' ? value : undefined)
  const m = name ? CHILD_NAME[collection].exec(name) : null
  if (!name || !m) return { invalid: 'malformed' }
  return `spaces/${m[1]}` === space ? name : { invalid: 'cross_space' }
}

/** The form a request body takes: a string `type` is a Chat API event, a `chat` object an add-on's; anything else is neither. */
export function googleChatEventForm(body: unknown): GoogleChatEventForm | undefined {
  const b = obj(body)
  if (typeof b?.type === 'string') return 'chat'
  return obj(b?.chat) ? 'addon' : undefined
}

/** An add-on request as the Chat API `Event` the normalizer reads (design §11); without exactly one payload it has no type, which is malformed. */
export function googleChatEventFromAddOn(body: unknown): GoogleChatEvent {
  const b = obj(body)
  const chat = obj(b?.chat)
  const present = chat ? Object.entries(ADD_ON_PAYLOAD_TYPES).filter(([key]) => obj(chat[key])) : []
  if (!chat || present.length !== 1) return {}
  const [key, type] = present[0]!
  const payload = obj(chat[key])!
  const payloadSpace = obj(payload.space)
  const chatSpace = obj(chat.space)
  // The payload names the event's Space; a top-level Space naming another one is a contradiction, not a fallback.
  if (payloadSpace && chatSpace && payloadSpace.name !== chatSpace.name) return {}
  const space = payloadSpace ?? chatSpace
  const common = obj(b?.commonEventObject)
  const event: Obj = {
    type,
    ...(chat.eventTime !== undefined ? { eventTime: chat.eventTime } : {}),
    ...(space ? { space } : {}),
    ...(payload.message !== undefined ? { message: payload.message } : {}),
    ...(chat.user !== undefined ? { user: chat.user } : {}),
    ...(payload.isDialogEvent !== undefined ? { isDialogEvent: payload.isDialogEvent } : {}),
    ...(common ? { common } : {}),
    ...(payload.configCompleteRedirectUri !== undefined
      ? { configCompleteRedirectUrl: payload.configCompleteRedirectUri }
      : {})
  }
  return event as GoogleChatEvent
}

/** The Chat API `Event` a request body carries in either form, with its form; undefined for a body that is neither. */
export function googleChatEventOf(body: unknown): { form: GoogleChatEventForm; event: GoogleChatEvent } | undefined {
  const form = googleChatEventForm(body)
  if (!form) return undefined
  return { form, event: form === 'addon' ? googleChatEventFromAddOn(body) : (body as GoogleChatEvent) }
}

/** The event's tenant key (design §10.4): a Space's `space.customer`, a DM sender's `user.domainId` as `domains/…`, never a Space sender's domain. */
export function googleChatTenantKey(event: unknown): string | undefined {
  const e = obj(event)
  const space = obj(e?.space)
  if (space?.spaceType === 'SPACE') {
    const customer = str(space.customer)
    return customer && CUSTOMER_NAME.test(customer) ? customer : undefined
  }
  if (space?.spaceType !== 'DIRECT_MESSAGE') return undefined
  const domainId = str(obj(e?.user)?.domainId)
  return domainId && DOMAIN_ID.test(domainId) ? `domains/${domainId}` : undefined
}

function eventContextOf(event: Obj): GoogleChatEventContext {
  const tenant = googleChatTenantKey(event)
  const redirect = str(event.configCompleteRedirectUrl)
  return { ...(tenant ? { tenant } : {}), ...(redirect ? { configCompleteRedirectUrl: redirect } : {}) }
}

// `common.parameters` is a map and `action.parameters` a `{ key, value }` list; the Chat-app list wins, non-strings are dropped.
function interactionParameters(event: Obj): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj(obj(event.common)?.parameters) ?? {})) {
    if (typeof value === 'string') out[key] = value
  }
  const list = obj(event.action)?.parameters
  for (const entry of Array.isArray(list) ? list : []) {
    const p = obj(entry)
    const key = str(p?.key)
    if (key && typeof p?.value === 'string') out[key] = p.value
  }
  return out
}

// `common.formInputs` carries each text or selection widget as `stringInputs.value`; any other shape is dropped.
function interactionFormInputs(event: Obj): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [name, input] of Object.entries(obj(obj(event.common)?.formInputs) ?? {})) {
    const values = obj(obj(input)?.stringInputs)?.value
    if (Array.isArray(values)) out[name] = values.filter((v): v is string => typeof v === 'string')
  }
  return out
}

// A card click: the card's message and thread pass the Space checks a message does, the clicker the sender checks.
function normalizeInteraction(
  event: Obj,
  space: string,
  isDm: boolean,
  eventThread: string | undefined,
  context: GoogleChatNormalizeContext
): InteractionOutcome {
  const message = obj(event.message)
  let messageThread: string | undefined
  let messageName: string | undefined
  if (message) {
    const name = message.name === undefined ? undefined : childOf(space, 'messages', message.name)
    if (name !== undefined && typeof name !== 'string') return name
    messageName = name
    const ownSpace = obj(message.space)?.name
    if (ownSpace !== undefined && ownSpace !== space) return { invalid: 'cross_space' }
    const thread = message.thread === undefined ? undefined : childOf(space, 'threads', message.thread)
    if (thread !== undefined && typeof thread !== 'string') return thread
    messageThread = thread
  }
  if (messageThread && eventThread && messageThread !== eventThread) return { invalid: 'thread_mismatch' }
  const user = obj(event.user) ?? {}
  const userName = str(user.name)
  if (!userName || !USER_NAME.test(userName)) return { invalid: 'malformed' }
  if (user.type === 'BOT' || userName === context.appUserName)
    return { skip: { kind: 'ignored', reason: 'app_authored' } }
  if (user.type !== 'HUMAN') return { skip: { kind: 'unsupported', reason: 'sender_type' } }
  const parameters = interactionParameters(event)
  // Our own parameter first, since an add-on's function is a URL (§11); then a pre-conversion card's name, then Chat's.
  const fn =
    str(parameters[GOOGLE_CHAT_ACTION_PARAMETER]) ??
    str(parameters[ACTION_METHOD_PARAMETER]) ??
    str(obj(event.action)?.actionMethodName) ??
    str(obj(event.common)?.invokedFunction)
  if (!fn) return { invalid: 'malformed' }
  const thread = messageThread ?? eventThread
  return {
    interaction: {
      function: fn,
      parameters,
      formInputs: interactionFormInputs(event),
      ...(messageName ? { message: messageName } : {}),
      user: userName,
      space,
      ...(thread ? { thread } : {}),
      isDm
    }
  }
}

// Removes the receiving app's own mention spans, verified against the text so a misaligned index never erases user content.
function stripAppMentions(
  text: string,
  annotations: unknown,
  appUserName: string
): { text: string; mentioned: boolean } {
  let mentioned = false
  const spans: [number, number][] = []
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    const a = obj(annotation)
    const mention = obj(a?.userMention)
    if (a?.type !== 'USER_MENTION' || !MENTION_TYPES.has(String(mention?.type))) continue
    if (obj(mention?.user)?.name !== appUserName) continue
    mentioned = true
    // Proto3 JSON omits zero values, so an absent startIndex means 0.
    const start = a.startIndex ?? 0
    const length = a.length
    if (!Number.isInteger(start) || !Number.isInteger(length)) continue
    const [s, e] = [start as number, (start as number) + (length as number)]
    if (s >= 0 && e > s && e <= text.length && text[s] === '@') spans.push([s, e])
  }
  let out = text
  let limit = Infinity
  for (const [s, e] of spans.sort((x, y) => y[0] - x[0])) {
    if (e > limit) continue
    const joinsWords = (s === 0 || /\s/.test(out[s - 1]!)) && /[ \t]/.test(out[e] ?? '')
    out = out.slice(0, s) + out.slice(joinsWords ? e + 1 : e)
    limit = s
  }
  return { text: spans.length ? out.trim() : out, mentioned }
}

function normalizeMessage(
  event: Obj,
  space: string,
  isDm: boolean,
  eventThread: string | undefined,
  context: GoogleChatNormalizeContext
): MessageOutcome {
  const message = obj(event.message)
  if (!message) return { invalid: 'malformed' }
  const name = childOf(space, 'messages', message.name)
  if (typeof name !== 'string') return name
  const ownSpace = obj(message.space)?.name
  if (ownSpace !== undefined && ownSpace !== space) return { invalid: 'cross_space' }
  const messageThread = message.thread === undefined ? undefined : childOf(space, 'threads', message.thread)
  if (messageThread !== undefined && typeof messageThread !== 'string') return messageThread
  if (messageThread && eventThread && messageThread !== eventThread) return { invalid: 'thread_mismatch' }
  const sender = obj(message.sender) ?? {}
  const senderName = str(sender.name)
  if (!senderName || !USER_NAME.test(senderName)) return { invalid: 'malformed' }
  if (message.text !== undefined && typeof message.text !== 'string') return { invalid: 'malformed' }
  if (sender.type === 'BOT' || senderName === context.appUserName)
    return { skip: { kind: 'ignored', reason: 'app_authored' } }
  if (sender.type !== 'HUMAN') return { skip: { kind: 'unsupported', reason: 'sender_type' } }
  if (message.slashCommand !== undefined) return { skip: { kind: 'unsupported', reason: 'slash_command' } }
  // A named Space reply must land in its thread (design §5), so a thread-less Space message cannot be served.
  const thread = isDm ? space : (messageThread ?? eventThread)
  if (!thread) return { skip: { kind: 'unsupported', reason: 'thread_missing' } }
  const stripped = stripAppMentions(message.text ?? '', message.annotations, context.appUserName)
  const text =
    Array.isArray(message.attachment) && message.attachment.length
      ? [stripped.text, ATTACHMENT_NOTE].filter(Boolean).join('\n')
      : stripped.text
  const platformTimeMs = rfc3339Ms(message.createTime) ?? rfc3339Ms(event.eventTime)
  const displayName = str(sender.displayName)
  return {
    message: {
      msgId: `${GOOGLE_CHAT_PLATFORM}:${space}:${name}`,
      traceId: context.traceId,
      source: 'user',
      platform: GOOGLE_CHAT_PLATFORM,
      channel: space,
      thread,
      sender: { id: senderName, isBot: false, ...(displayName ? { name: displayName } : {}) },
      text,
      mentionedBots: stripped.mentioned ? [context.appUserName] : [],
      isDm,
      ...(platformTimeMs !== undefined ? { platformTimeMs } : {})
    }
  }
}

/** Normalize one verified Chat interaction event; pure, and fail-closed on anything it cannot classify. */
export function normalizeGoogleChatEvent(event: unknown, context: GoogleChatNormalizeContext): GoogleChatEventResult {
  if (!USER_NAME.test(context.appUserName))
    throw new TypeError('Google Chat app identity must be a users/… resource name')
  const e = obj(event)
  const type = str(e?.type)
  if (!e || !type) return { kind: 'invalid', reason: 'malformed' }
  if (!EVENT_TYPES.has(type)) return { kind: 'unsupported', reason: 'event_type' }
  const spaceObj = obj(e.space)
  const space = str(spaceObj?.name)
  if (!space || !SPACE_NAME.test(space)) return { kind: 'invalid', reason: 'malformed' }
  const eventThread = e.thread === undefined ? undefined : childOf(space, 'threads', e.thread)
  if (eventThread !== undefined && typeof eventThread !== 'string')
    return { kind: 'invalid', reason: eventThread.invalid }
  const spaceType = spaceObj?.spaceType
  if (spaceType === 'GROUP_CHAT') return { kind: 'unsupported', reason: 'group_dm' }
  if (spaceType !== 'DIRECT_MESSAGE' && spaceType !== 'SPACE') return { kind: 'unsupported', reason: 'space_type' }
  const isDm = spaceType === 'DIRECT_MESSAGE'
  if ((type === 'MESSAGE' || type === 'CARD_CLICKED') && e.isDialogEvent === true)
    return { kind: 'unsupported', reason: 'dialog' }
  const ctx = eventContextOf(e)
  if (type === 'CARD_CLICKED') {
    const outcome = normalizeInteraction(e, space, isDm, eventThread, context)
    if (isInvalid(outcome)) return { kind: 'invalid', reason: outcome.invalid }
    return 'interaction' in outcome ? { kind: 'interaction', interaction: outcome.interaction, ...ctx } : outcome.skip
  }
  if (type !== 'MESSAGE') {
    const actor = str(obj(e.user)?.name)
    const eventTimeMs = rfc3339Ms(e.eventTime)
    const membership: GoogleChatMembershipChange = {
      change: type === 'ADDED_TO_SPACE' ? 'added' : 'removed',
      channel: space,
      isDm,
      ...(actor && USER_NAME.test(actor) ? { actor } : {}),
      ...(eventTimeMs !== undefined ? { eventTimeMs } : {})
    }
    if (type === 'REMOVED_FROM_SPACE' || e.message == null) return { kind: 'membership', membership, ...ctx }
    // An @mention that adds the app carries the triggering message; only an ignorable message leaves the membership alone.
    const outcome = normalizeMessage(e, space, isDm, eventThread, context)
    if (isInvalid(outcome)) return { kind: 'invalid', reason: outcome.invalid }
    return 'message' in outcome
      ? { kind: 'message', message: outcome.message, membership, ...ctx }
      : { kind: 'membership', membership, ...ctx }
  }
  const outcome = normalizeMessage(e, space, isDm, eventThread, context)
  if (isInvalid(outcome)) return { kind: 'invalid', reason: outcome.invalid }
  return 'message' in outcome ? { kind: 'message', message: outcome.message, ...ctx } : outcome.skip
}
