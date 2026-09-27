import { GOOGLE_CHAT_PLATFORM, type NormalizedPlatformMessage } from '@agentconnect.md/protocol'

// Plain-object views of the Chat interaction `Event` JSON; every field is optional because the body is only structurally trusted.
export interface GoogleChatUser {
  name?: string
  displayName?: string
  type?: string
}

export interface GoogleChatSpace {
  name?: string
  spaceType?: string
  displayName?: string
  singleUserBotDm?: boolean
  spaceThreadingState?: string
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

export type GoogleChatInvalidReason = 'malformed' | 'cross_space' | 'thread_mismatch'

/** `invalid` is a malformed request; `ignored` and `unsupported` are completed decisions that start no turn. */
export type GoogleChatEventResult =
  | { kind: 'message'; message: NormalizedPlatformMessage; membership?: GoogleChatMembershipChange }
  | { kind: 'membership'; membership: GoogleChatMembershipChange }
  | { kind: 'ignored'; reason: 'app_authored' }
  | { kind: 'unsupported'; reason: GoogleChatUnsupportedReason }
  | { kind: 'invalid'; reason: GoogleChatInvalidReason }

type Obj = Record<string, unknown>
type Invalid = { invalid: GoogleChatInvalidReason }
type MessageOutcome = { message: NormalizedPlatformMessage } | { skip: GoogleChatEventResult } | Invalid

// Colon-free segments keep `platform:channel:native` msgIds splittable (wire-coordinates.ts).
const SEGMENT = '[A-Za-z0-9._-]+'
const SPACE_NAME = new RegExp(`^spaces/(${SEGMENT})$`)
const USER_NAME = new RegExp(`^users/${SEGMENT}$`)
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
  if (type !== 'MESSAGE' && type !== 'ADDED_TO_SPACE' && type !== 'REMOVED_FROM_SPACE')
    return { kind: 'unsupported', reason: 'event_type' }
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
  if (type === 'MESSAGE' && e.isDialogEvent === true) return { kind: 'unsupported', reason: 'dialog' }
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
    if (type === 'REMOVED_FROM_SPACE' || e.message == null) return { kind: 'membership', membership }
    // An @mention that adds the app carries the triggering message; only an ignorable message leaves the membership alone.
    const outcome = normalizeMessage(e, space, isDm, eventThread, context)
    if (isInvalid(outcome)) return { kind: 'invalid', reason: outcome.invalid }
    return 'message' in outcome
      ? { kind: 'message', message: outcome.message, membership }
      : { kind: 'membership', membership }
  }
  const outcome = normalizeMessage(e, space, isDm, eventThread, context)
  if (isInvalid(outcome)) return { kind: 'invalid', reason: outcome.invalid }
  return 'message' in outcome ? { kind: 'message', message: outcome.message } : outcome.skip
}
