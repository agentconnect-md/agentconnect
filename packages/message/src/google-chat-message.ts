import {
  GOOGLE_CHAT_ACTION_PARAMETER,
  GOOGLE_CHAT_PLATFORM,
  type NormalizedPlatformMessage
} from '@agentconnect.md/protocol'

// Plain-object views of a Workspace add-on's `EventObject` and the Chat resources it embeds; every field is optional because the body is only structurally trusted.
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

/** An add-on request's `commonEventObject`: a clicked button's parameters and the card's input widgets. */
export interface GoogleChatCommonEventObject {
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
  /** A `SLASH_COMMAND` annotation's `SlashCommandMetadata`: the invoked command by name and id. */
  slashCommand?: { bot?: GoogleChatUser; type?: string; commandName?: string; commandId?: string }
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

/** One `chat.*Payload` of an add-on request (design §11); each kind carries only some of these. */
export interface GoogleChatPayload {
  space?: GoogleChatSpace
  message?: GoogleChatMessage
  /** Where a configuration flow started by the authorization prompt must send the browser back to. */
  configCompleteRedirectUri?: string
  isDialogEvent?: boolean
  dialogEventType?: string
  /** An `appCommandPayload`'s command: `appCommandType` is `SLASH_COMMAND` or `QUICK_COMMAND`. */
  appCommandMetadata?: { appCommandId?: string | number; appCommandType?: string }
}

/** The one slash command the app registers (design §3), matched by name; the relay answers it. */
export const GOOGLE_CHAT_HELP_COMMAND = '/help'

/** Every payload Google sends a Chat app, exactly one per request; only `/help` of the commands and no widget update is answered. */
export const GOOGLE_CHAT_PAYLOAD_KEYS = [
  'messagePayload',
  'addedToSpacePayload',
  'removedFromSpacePayload',
  'buttonClickedPayload',
  'appCommandPayload',
  'widgetUpdatedPayload'
] as const

export type GoogleChatPayloadKey = (typeof GOOGLE_CHAT_PAYLOAD_KEYS)[number]

/** A Workspace add-on's Chat request (`EventObject`, design §11); its `authorizationEventObject` holds user tokens and is never read. */
export interface GoogleChatEventObject {
  commonEventObject?: GoogleChatCommonEventObject
  authorizationEventObject?: unknown
  chat?: {
    user?: GoogleChatUser
    space?: GoogleChatSpace
    eventTime?: string
    messagePayload?: GoogleChatPayload
    addedToSpacePayload?: GoogleChatPayload & { interactionAdd?: boolean }
    removedFromSpacePayload?: GoogleChatPayload
    buttonClickedPayload?: GoogleChatPayload
    appCommandPayload?: GoogleChatPayload
    widgetUpdatedPayload?: GoogleChatPayload
  }
}

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

export type GoogleChatInvalidReason = 'malformed' | 'cross_space'

/** A button click: the action our `agentconnect.action` parameter named, its parameters, and the coordinates it happened at. */
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

/** A `/help` slash command: who asked and where; the relay answers it in the HTTP body. */
export interface GoogleChatHelpRequest {
  /** The asking user's `users/…` name. */
  user: string
  /** Full `spaces/…` resource name. */
  space: string
  isDm: boolean
}

/** Facts every classified event carries beside its payload: its tenant key (design §10.4) and the configuration return URL. */
export interface GoogleChatEventContext {
  /** `customers/…` for a Space event, `domains/…` for a DM event; absent for an event without a Workspace tenant. */
  tenant?: string
  configCompleteRedirectUri?: string
}

/** `invalid` is a malformed request; `ignored`, `unsupported`, `interaction` and `help` are completed decisions that start no turn. */
export type GoogleChatEventResult =
  | ({ kind: 'message'; message: NormalizedPlatformMessage } & GoogleChatEventContext)
  | ({ kind: 'membership'; membership: GoogleChatMembershipChange } & GoogleChatEventContext)
  | ({ kind: 'interaction'; interaction: GoogleChatInteraction } & GoogleChatEventContext)
  | ({ kind: 'help'; help: GoogleChatHelpRequest } & GoogleChatEventContext)
  | { kind: 'ignored'; reason: 'app_authored' }
  | { kind: 'unsupported'; reason: GoogleChatUnsupportedReason }
  | { kind: 'invalid'; reason: GoogleChatInvalidReason }

type Obj = Record<string, unknown>
type Invalid = { invalid: GoogleChatInvalidReason }
type Skip = { skip: GoogleChatEventResult }
type MessageOutcome = { message: NormalizedPlatformMessage } | Skip | Invalid
type InteractionOutcome = { interaction: GoogleChatInteraction } | Skip | Invalid
type HelpOutcome = { help: GoogleChatHelpRequest } | Skip | Invalid
// The request's parts as untrusted objects: `chat`, its one payload, the event's Space, and `commonEventObject`.
type Parts = { key: GoogleChatPayloadKey; chat: Obj; payload: Obj; space?: Obj; common?: Obj }

// Colon-free segments keep `platform:channel:native` msgIds splittable (wire-coordinates.ts).
const SEGMENT = '[A-Za-z0-9._-]+'
const SPACE_NAME = new RegExp(`^spaces/(${SEGMENT})$`)
const USER_NAME = new RegExp(`^users/${SEGMENT}$`)
const CUSTOMER_NAME = new RegExp(`^customers/${SEGMENT}$`)
const DOMAIN_ID = new RegExp(`^${SEGMENT}$`)
const CHILD_NAME = {
  messages: new RegExp(`^spaces/(${SEGMENT})/messages/${SEGMENT}$`),
  threads: new RegExp(`^spaces/(${SEGMENT})/threads/${SEGMENT}$`)
}
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/i
const MENTION_TYPES = new Set(['MENTION', 'ADD'])
const ATTACHMENT_NOTE = '[Attachment not read: Google Chat attachments are not supported.]'

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

// The one payload present, as Google's samples dispatch; a top-level Space naming another one than the payload's is a contradiction, not a fallback.
function partsOf(event: unknown): Parts | undefined {
  const e = obj(event)
  const chat = obj(e?.chat)
  const present = chat ? GOOGLE_CHAT_PAYLOAD_KEYS.filter((key) => obj(chat[key])) : []
  if (!chat || present.length !== 1) return undefined
  const key = present[0]!
  const payload = obj(chat[key])!
  const payloadSpace = obj(payload.space)
  const chatSpace = obj(chat.space)
  if (payloadSpace && chatSpace && payloadSpace.name !== chatSpace.name) return undefined
  const space = payloadSpace ?? chatSpace
  const common = obj(e?.commonEventObject)
  return { key, chat, payload, ...(space ? { space } : {}), ...(common ? { common } : {}) }
}

/** The body as an add-on `EventObject`: an object with its `chat` object; anything else is not a Google Chat request. */
export function googleChatEventObjectOf(body: unknown): GoogleChatEventObject | undefined {
  const b = obj(body)
  return b && obj(b.chat) ? (b as GoogleChatEventObject) : undefined
}

/** The request's one payload and the Space it happened in (the payload's, else `chat.space`); undefined without exactly one payload or when those Spaces disagree. */
export function googleChatPayloadOf(
  event: unknown
): { key: GoogleChatPayloadKey; payload: GoogleChatPayload; space?: GoogleChatSpace } | undefined {
  const parts = partsOf(event)
  if (!parts) return undefined
  const { key, payload, space } = parts as Parts & { payload: GoogleChatPayload; space?: GoogleChatSpace }
  return { key, payload, ...(space ? { space } : {}) }
}

function tenantKeyOf(space: Obj | undefined, user: Obj | undefined): string | undefined {
  if (space?.spaceType === 'SPACE') {
    const customer = str(space.customer)
    return customer && CUSTOMER_NAME.test(customer) ? customer : undefined
  }
  if (space?.spaceType !== 'DIRECT_MESSAGE') return undefined
  const domainId = str(user?.domainId)
  return domainId && DOMAIN_ID.test(domainId) ? `domains/${domainId}` : undefined
}

/** The event's tenant key (design §10.4): a Space's `space.customer`, a DM sender's `user.domainId` as `domains/…`, never a Space sender's domain. */
export function googleChatTenantKey(event: unknown): string | undefined {
  const parts = partsOf(event)
  return parts && tenantKeyOf(parts.space, obj(parts.chat.user))
}

function eventContextOf(parts: Parts): GoogleChatEventContext {
  const tenant = tenantKeyOf(parts.space, obj(parts.chat.user))
  const redirect = str(parts.payload.configCompleteRedirectUri)
  return { ...(tenant ? { tenant } : {}), ...(redirect ? { configCompleteRedirectUri: redirect } : {}) }
}

// `commonEventObject.parameters` is a string map; non-strings are dropped.
function interactionParameters(common: Obj | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj(common?.parameters) ?? {})) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

// `commonEventObject.formInputs` carries each text or selection widget as `stringInputs.value`; any other shape is dropped.
function interactionFormInputs(common: Obj | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [name, input] of Object.entries(obj(common?.formInputs) ?? {})) {
    const values = obj(obj(input)?.stringInputs)?.value
    if (Array.isArray(values)) out[name] = values.filter((v): v is string => typeof v === 'string')
  }
  return out
}

// A click's or a command's message and thread: optional, but a named one must belong to `space`.
function eventCoordinates(parts: Parts, space: string): { message?: string; thread?: string } | Invalid {
  const message = obj(parts.payload.message)
  if (!message) return {}
  const name = message.name === undefined ? undefined : childOf(space, 'messages', message.name)
  if (name !== undefined && typeof name !== 'string') return name
  const ownSpace = obj(message.space)?.name
  if (ownSpace !== undefined && ownSpace !== space) return { invalid: 'cross_space' }
  const thread = message.thread === undefined ? undefined : childOf(space, 'threads', message.thread)
  if (thread !== undefined && typeof thread !== 'string') return thread
  return { ...(name ? { message: name } : {}), ...(thread ? { thread } : {}) }
}

// The acting `chat.user` of a click or a command, under the sender checks a message gets.
function humanActor(parts: Parts, context: GoogleChatNormalizeContext): { user: string } | Skip | Invalid {
  const user = obj(parts.chat.user) ?? {}
  const userName = str(user.name)
  if (!userName || !USER_NAME.test(userName)) return { invalid: 'malformed' }
  if (user.type === 'BOT' || userName === context.appUserName)
    return { skip: { kind: 'ignored', reason: 'app_authored' } }
  if (user.type !== 'HUMAN') return { skip: { kind: 'unsupported', reason: 'sender_type' } }
  return { user: userName }
}

// A button click: the card's message and thread pass the Space checks a message does, the clicker the sender checks.
function normalizeInteraction(
  parts: Parts,
  space: string,
  isDm: boolean,
  context: GoogleChatNormalizeContext
): InteractionOutcome {
  const coordinates = eventCoordinates(parts, space)
  if (isInvalid(coordinates)) return coordinates
  const actor = humanActor(parts, context)
  if (!('user' in actor)) return actor
  const parameters = interactionParameters(parts.common)
  // A button's `function` is the events URL, so the action rides our own parameter.
  const fn = str(parameters[GOOGLE_CHAT_ACTION_PARAMETER])
  if (!fn) return { invalid: 'malformed' }
  return {
    interaction: {
      function: fn,
      parameters,
      formInputs: interactionFormInputs(parts.common),
      ...(coordinates.message ? { message: coordinates.message } : {}),
      user: actor.user,
      space,
      ...(coordinates.thread ? { thread: coordinates.thread } : {}),
      isDm
    }
  }
}

// The invoked slash command's name: the message's `SLASH_COMMAND` annotation, `slashCommand.commandName`.
function slashCommandName(payload: Obj): string | undefined {
  const annotations = obj(payload.message)?.annotations
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    const a = obj(annotation)
    if (a?.type === 'SLASH_COMMAND') return str(obj(a.slashCommand)?.commandName)
  }
  return undefined
}

// A `/help` slash command, under the checks a click gets.
function normalizeHelp(parts: Parts, space: string, isDm: boolean, context: GoogleChatNormalizeContext): HelpOutcome {
  const coordinates = eventCoordinates(parts, space)
  if (isInvalid(coordinates)) return coordinates
  const actor = humanActor(parts, context)
  if (!('user' in actor)) return actor
  return { help: { user: actor.user, space, isDm } }
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
  parts: Parts,
  space: string,
  isDm: boolean,
  context: GoogleChatNormalizeContext
): MessageOutcome {
  const message = obj(parts.payload.message)
  if (!message) return { invalid: 'malformed' }
  const name = childOf(space, 'messages', message.name)
  if (typeof name !== 'string') return name
  const ownSpace = obj(message.space)?.name
  if (ownSpace !== undefined && ownSpace !== space) return { invalid: 'cross_space' }
  const messageThread = message.thread === undefined ? undefined : childOf(space, 'threads', message.thread)
  if (messageThread !== undefined && typeof messageThread !== 'string') return messageThread
  const sender = obj(message.sender) ?? {}
  const senderName = str(sender.name)
  if (!senderName || !USER_NAME.test(senderName)) return { invalid: 'malformed' }
  if (message.text !== undefined && typeof message.text !== 'string') return { invalid: 'malformed' }
  if (sender.type === 'BOT' || senderName === context.appUserName)
    return { skip: { kind: 'ignored', reason: 'app_authored' } }
  if (sender.type !== 'HUMAN') return { skip: { kind: 'unsupported', reason: 'sender_type' } }
  if (message.slashCommand !== undefined) return { skip: { kind: 'unsupported', reason: 'slash_command' } }
  // A named Space reply must land in its thread (design §5), so a thread-less Space message cannot be served.
  const thread = isDm ? space : messageThread
  if (!thread) return { skip: { kind: 'unsupported', reason: 'thread_missing' } }
  const stripped = stripAppMentions(message.text ?? '', message.annotations, context.appUserName)
  const text =
    Array.isArray(message.attachment) && message.attachment.length
      ? [stripped.text, ATTACHMENT_NOTE].filter(Boolean).join('\n')
      : stripped.text
  const platformTimeMs = rfc3339Ms(message.createTime) ?? rfc3339Ms(parts.chat.eventTime)
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

/** Normalize one verified add-on request by the payload it carries; pure, and fail-closed on anything it cannot classify. */
export function normalizeGoogleChatEvent(event: unknown, context: GoogleChatNormalizeContext): GoogleChatEventResult {
  if (!USER_NAME.test(context.appUserName))
    throw new TypeError('Google Chat app identity must be a users/… resource name')
  const parts = partsOf(event)
  if (!parts) return { kind: 'invalid', reason: 'malformed' }
  if (parts.key === 'widgetUpdatedPayload') return { kind: 'unsupported', reason: 'event_type' }
  // Of the app commands only the `/help` slash command is answered; a quick command or another name starts nothing.
  if (parts.key === 'appCommandPayload') {
    if (obj(parts.payload.appCommandMetadata)?.appCommandType !== 'SLASH_COMMAND')
      return { kind: 'unsupported', reason: 'event_type' }
    if (slashCommandName(parts.payload) !== GOOGLE_CHAT_HELP_COMMAND)
      return { kind: 'unsupported', reason: 'slash_command' }
  }
  const space = str(parts.space?.name)
  if (!space || !SPACE_NAME.test(space)) return { kind: 'invalid', reason: 'malformed' }
  const spaceType = parts.space?.spaceType
  if (spaceType === 'GROUP_CHAT') return { kind: 'unsupported', reason: 'group_dm' }
  if (spaceType !== 'DIRECT_MESSAGE' && spaceType !== 'SPACE') return { kind: 'unsupported', reason: 'space_type' }
  const isDm = spaceType === 'DIRECT_MESSAGE'
  const ctx = eventContextOf(parts)
  switch (parts.key) {
    case 'buttonClickedPayload': {
      if (parts.payload.isDialogEvent === true) return { kind: 'unsupported', reason: 'dialog' }
      const outcome = normalizeInteraction(parts, space, isDm, context)
      if (isInvalid(outcome)) return { kind: 'invalid', reason: outcome.invalid }
      return 'interaction' in outcome ? { kind: 'interaction', interaction: outcome.interaction, ...ctx } : outcome.skip
    }
    case 'appCommandPayload': {
      if (parts.payload.isDialogEvent === true) return { kind: 'unsupported', reason: 'dialog' }
      const outcome = normalizeHelp(parts, space, isDm, context)
      if (isInvalid(outcome)) return { kind: 'invalid', reason: outcome.invalid }
      return 'help' in outcome ? { kind: 'help', help: outcome.help, ...ctx } : outcome.skip
    }
    case 'addedToSpacePayload':
    case 'removedFromSpacePayload': {
      // An add carries no message: the @mention that added the app arrives as its own request.
      const actor = str(obj(parts.chat.user)?.name)
      const eventTimeMs = rfc3339Ms(parts.chat.eventTime)
      const membership: GoogleChatMembershipChange = {
        change: parts.key === 'addedToSpacePayload' ? 'added' : 'removed',
        channel: space,
        isDm,
        ...(actor && USER_NAME.test(actor) ? { actor } : {}),
        ...(eventTimeMs !== undefined ? { eventTimeMs } : {})
      }
      return { kind: 'membership', membership, ...ctx }
    }
    case 'messagePayload': {
      if (parts.payload.isDialogEvent === true) return { kind: 'unsupported', reason: 'dialog' }
      const outcome = normalizeMessage(parts, space, isDm, context)
      if (isInvalid(outcome)) return { kind: 'invalid', reason: outcome.invalid }
      return 'message' in outcome ? { kind: 'message', message: outcome.message, ...ctx } : outcome.skip
    }
  }
}
