import {
  EMAIL_ADDRESS_PATTERN,
  EMAIL_ATTACHMENTS_MAX,
  EMAIL_MESSAGE_ID_MAX,
  EMAIL_PLATFORM,
  EMAIL_RECIPIENTS_MAX,
  EMAIL_REFERENCES_MAX
} from '@agentconnect.md/protocol'
import type { NormalizedPlatformMessage, WireEmailAdapterExt, WireEmailMailbox } from '@agentconnect.md/protocol'
import { safeAttachmentName } from './file-name.js'

// Pure checks and normalization for mail (email-integration.md); MIME parsing, the envelope and every verdict's answer belong to the relay.

/** One header field of a message, unfolded; a list keeps the order they arrived in, top first. */
export interface EmailHeader {
  name: string
  value: string
}

/** Every value of one header field, top first; names match without case. */
export function emailHeaderValues(headers: readonly EmailHeader[], name: string): string[] {
  const wanted = name.toLowerCase()
  return headers.filter((header) => header.name.toLowerCase() === wanted).map((header) => header.value)
}

// ── §3 the address ──

// Role names a correspondent would trust, compared with `.` and `-` removed so `no-reply` and `post.master` are covered too.
const RESERVED_NAMES = new Set([
  'abuse',
  'admin',
  'administrator',
  'billing',
  'compliance',
  'help',
  'hostmaster',
  'info',
  'legal',
  'mailerdaemon',
  'noreply',
  'postmaster',
  'privacy',
  'root',
  'sales',
  'security',
  'support',
  'webmaster'
])
// Letters, digits, `.` and `-`, starting and ending with a letter or digit; two dots in a row are not a valid local part.
const NAME = /^[a-z0-9](?:[a-z0-9-]|\.(?!\.))*[a-z0-9]$/

export type EmailNameRefusal = 'length' | 'characters' | 'reserved'

/** Whether a name is one no agent may take (§3). */
export function isReservedEmailName(name: string): boolean {
  return RESERVED_NAMES.has(name.toLowerCase().replace(/[.-]/g, ''))
}

/** An address name as it is stored, lower-cased, or why it cannot be taken (§3). */
export function validateEmailName(input: string): { ok: true; name: string } | { ok: false; reason: EmailNameRefusal } {
  const name = input.toLowerCase()
  if (name.length < 3 || name.length > 40) return { ok: false, reason: 'length' }
  if (!NAME.test(name)) return { ok: false, reason: 'characters' }
  return isReservedEmailName(name) ? { ok: false, reason: 'reserved' } : { ok: true, name }
}

/** An address lower-cased into the wire's canonical form; undefined for anything else, a quoted or non-ASCII local part included. */
export function canonicalEmailAddress(address: string): string | undefined {
  const canonical = address.trim().toLowerCase()
  return canonical.length <= 320 && EMAIL_ADDRESS_PATTERN.test(canonical) ? canonical : undefined
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1)
}

/** The agent address a recipient names: on the mail domain a `+tag` is ignored (§3); undefined for an address on any other domain. */
export function emailAgentAddress(recipient: string, mailDomain: string): string | undefined {
  const canonical = canonicalEmailAddress(recipient)
  const domain = mailDomain.toLowerCase()
  if (!canonical || domainOf(canonical) !== domain) return undefined
  const name = canonical.slice(0, canonical.lastIndexOf('@')).split('+')[0]
  return name ? `${name}@${domain}` : undefined
}

// ── §4 step 1: automatic mail ──

export type EmailAutomaticReason = 'auto_submitted' | 'precedence' | 'list' | 'null_sender' | 'own_domain'

export interface EmailAutomaticInput {
  headers: readonly EmailHeader[]
  /** The SMTP envelope sender; empty or `<>` on a bounce. */
  envelopeFrom: string
  /** The `From` address. */
  from: string
  /** The deployment's mail domain. */
  mailDomain: string
}

/** Why a message is automatic and is discarded without an answer, or undefined for one a person sent (§4 step 1). */
export function emailAutomaticReason(input: EmailAutomaticInput): EmailAutomaticReason | undefined {
  const { headers } = input
  const envelope = input.envelopeFrom.trim().replace(/^<|>$/g, '')
  if (!envelope) return 'null_sender'
  const domain = input.mailDomain.toLowerCase()
  if ([envelope, input.from.trim()].some((address) => domainOf(address).toLowerCase() === domain)) return 'own_domain'
  // RFC 3834: the keyword precedes any parameter, and only `no` marks a message a person sent.
  if (emailHeaderValues(headers, 'auto-submitted').some((value) => value.split(';')[0]!.trim().toLowerCase() !== 'no'))
    return 'auto_submitted'
  if (emailHeaderValues(headers, 'precedence').some((value) => /^(?:bulk|list|junk)$/i.test(value.trim())))
    return 'precedence'
  if (headers.some((header) => /^list-(?:id|unsubscribe)$/i.test(header.name))) return 'list'
  return undefined
}

// ── §4 step 2: the sender's authentication ──

export type EmailAuthRefusal = 'missing' | 'unparsable' | 'authserv' | 'sender' | 'dmarc' | 'dkim'
export type EmailAuthVerdict = { ok: true; via: 'dmarc' | 'dkim' } | { ok: false; reason: EmailAuthRefusal }

export interface EmailAuthInput {
  headers: readonly EmailHeader[]
  /** The authserv-id the deployment's mail provider signs its results with. */
  authservId: string
  /** The `From` address the verdict is about. */
  from: string
}

interface AuthResult {
  method: string
  result: string
  props: Map<string, string>
}

// The words of one header value, with `;` and `=` as their own tokens, comments dropped and quoted strings read whole; undefined when a comment or a quote never closes.
function authTokens(value: string): string[][] | undefined {
  const segments: string[][] = [[]]
  let i = 0
  while (i < value.length) {
    const ch = value[i]!
    if (/\s/.test(ch)) i++
    else if (ch === '(') {
      let depth = 0
      for (; i < value.length; i++) {
        if (value[i] === '\\') i++
        else if (value[i] === '(') depth++
        else if (value[i] === ')' && --depth === 0) break
      }
      if (i >= value.length) return undefined
      i++
    } else if (ch === ')') return undefined
    else if (ch === ';') {
      segments.push([])
      i++
    } else if (ch === '=') {
      segments.at(-1)!.push('=')
      i++
    } else if (ch === '"') {
      let text = ''
      for (i++; i < value.length && value[i] !== '"'; i++) {
        if (value[i] === '\\') i++
        text += value[i] ?? ''
      }
      if (i >= value.length) return undefined
      i++
      // A quoted `=` is a value, never the separator.
      segments.at(-1)!.push(text === '=' ? '"="' : text)
    } else {
      let end = i
      while (end < value.length && !/[\s;=()"]/.test(value[end]!)) end++
      segments.at(-1)!.push(value.slice(i, end))
      i = end
    }
  }
  return segments
}

// One `Authentication-Results` value per RFC 8601: `authserv-id [version]; method=result [property=value]…; …`; undefined for anything else.
function parseAuthenticationResults(value: string): { authservId: string; results: AuthResult[] } | undefined {
  const segments = authTokens(value)
  if (!segments) return undefined
  const [head, ...rest] = segments as [string[], ...string[][]]
  if (head.length < 1 || head.length > 2 || head.includes('=') || (head.length === 2 && head[1] !== '1'))
    return undefined
  const results: AuthResult[] = []
  for (const [index, segment] of rest.entries()) {
    // A trailing `;` and the `none` of a header with no result carry nothing.
    if (!segment.length && index === rest.length - 1) continue
    if (segment.length === 1 && segment[0]!.toLowerCase() === 'none') continue
    if (!segment.length || segment.length % 3 !== 0) return undefined
    const pairs: [string, string][] = []
    for (let at = 0; at < segment.length; at += 3) {
      const [key, equals, word] = [segment[at]!, segment[at + 1]!, segment[at + 2]!]
      if (key === '=' || equals !== '=' || word === '=') return undefined
      pairs.push([key.toLowerCase(), word])
    }
    const [[method, result], ...props] = pairs as [[string, string], ...[string, string][]]
    const byName = new Map(props)
    if (byName.size !== props.length) return undefined
    results.push({ method: method.replace(/\/\d+$/, ''), result: result.toLowerCase(), props: byName })
  }
  return { authservId: head[0]!, results }
}

// A signing domain vouches for the `From` domain when it is that domain or a parent of it, and is more than a single label.
function signsFor(signer: string | undefined, fromDomain: string): boolean {
  const domain = signer?.toLowerCase().replace(/\.$/, '')
  return !!domain && domain.includes('.') && (fromDomain === domain || fromDomain.endsWith(`.${domain}`))
}

/** Whether the mail provider authenticated the `From` domain (§4 step 2): only the topmost `Authentication-Results` is read, and anything it cannot be read as is a refusal. */
export function evaluateEmailAuthentication(input: EmailAuthInput): EmailAuthVerdict {
  const refuse = (reason: EmailAuthRefusal): EmailAuthVerdict => ({ ok: false, reason })
  // The provider prepends its header, so one further down is whatever the sender wrote.
  const [topmost] = emailHeaderValues(input.headers, 'authentication-results')
  if (topmost === undefined) return refuse('missing')
  const parsed = parseAuthenticationResults(topmost)
  if (!parsed) return refuse('unparsable')
  if (parsed.authservId.toLowerCase() !== input.authservId.toLowerCase()) return refuse('authserv')
  const from = canonicalEmailAddress(input.from)
  if (!from) return refuse('sender')
  const fromDomain = domainOf(from)
  const dmarc = parsed.results.filter((entry) => entry.method === 'dmarc')
  if (dmarc.length > 1) return refuse('dmarc')
  const verdict = dmarc[0]
  if (verdict && verdict.result !== 'none') {
    // A pass that names another `From` domain is about a different header than the one read here.
    const headerFrom = verdict.props.get('header.from')?.toLowerCase()
    const aligned = headerFrom === undefined || headerFrom === fromDomain
    return verdict.result === 'pass' && aligned ? { ok: true, via: 'dmarc' } : refuse('dmarc')
  }
  // No DMARC record (`dmarc=none`, or no DMARC result at all): an aligned DKIM signature stands in.
  const signed = parsed.results.some(
    (entry) => entry.method === 'dkim' && entry.result === 'pass' && signsFor(entry.props.get('header.d'), fromDomain)
  )
  return signed ? { ok: true, via: 'dkim' } : refuse('dkim')
}

// ── §5.1 threads ──

/** The message IDs a `Message-ID`, `In-Reply-To` or `References` value names, in order, each once and without its angle brackets; an oversized one is dropped. */
export function parseEmailMessageIds(value: string | undefined): string[] {
  const ids = new Set<string>()
  for (const match of (value ?? '').matchAll(/<([^<>\s]+)>/g)) {
    if (match[1]!.length <= EMAIL_MESSAGE_ID_MAX) ids.add(match[1]!)
  }
  return [...ids]
}

type EmailThreadHeaders = Pick<WireEmailAdapterExt, 'messageId' | 'inReplyTo' | 'references'>

/** The IDs a message's thread may be found by, nearest first: `References` newest to oldest, then `In-Reply-To` (§5.1); the daemon takes the first one it knows. */
export function emailThreadCandidates(mail: Omit<EmailThreadHeaders, 'messageId'>): string[] {
  const candidates = [...mail.references].reverse()
  if (mail.inReplyTo && !candidates.includes(mail.inReplyTo)) candidates.push(mail.inReplyTo)
  return candidates
}

/** The thread key when no candidate is known: the first `References` ID, else `In-Reply-To`, else the message's own ID, which starts a thread (§5.1). */
export function emailFallbackThreadKey(mail: EmailThreadHeaders): string {
  return mail.references[0] ?? mail.inReplyTo ?? mail.messageId
}

// ── §5.2 conversations ──

/** A message's participants: its sender, then every `To` and `Cc` address other than the agent's own, each once (§5.2); only the agent's own address loses its `+tag`. */
export function emailParticipants(
  mail: Pick<WireEmailAdapterExt, 'from' | 'to' | 'cc'>,
  agentAddress: string
): [string, ...string[]] {
  const participants: [string, ...string[]] = [mail.from.address]
  const mailDomain = domainOf(agentAddress)
  for (const { address } of [...mail.to, ...mail.cc]) {
    if (emailAgentAddress(address, mailDomain) === agentAddress || participants.includes(address)) continue
    participants.push(address)
  }
  return participants
}

export interface EmailConversation {
  kind: 'dm' | 'group'
  channel: string
}

/** The conversation a message belongs to (§5.2): the sender alone is that member's direct conversation, and anyone else makes the thread a group of its own. */
export function emailConversation(participants: readonly [string, ...string[]], threadKey: string): EmailConversation {
  return participants.length > 1
    ? { kind: 'group', channel: `group:${threadKey}` }
    : { kind: 'dm', channel: `dm:${participants[0]}` }
}

// ── §5.4 what the agent reads ──

/** The most UTF-8 bytes of a body the agent reads, which keeps a normalized message inside one relay frame. */
export const EMAIL_BODY_MAX_BYTES = 64 * 1024
export const EMAIL_CUT_MARKER = '[Message cut: the rest was not delivered.]'

/** A body cut at 64 KiB on a character boundary, with a visible marker when it, or the message before it was parsed, was cut (§5.4, §7). */
export function cutEmailBody(body: string, alreadyCut = false): { text: string; truncated: boolean } {
  let bytes = 0
  let end = 0
  for (const char of body) {
    const code = char.codePointAt(0)!
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (bytes + size > EMAIL_BODY_MAX_BYTES) break
    bytes += size
    end += char.length
  }
  const truncated = alreadyCut || end < body.length
  const kept = body.slice(0, end)
  return { text: truncated ? [kept.trimEnd(), EMAIL_CUT_MARKER].filter(Boolean).join('\n\n') : kept, truncated }
}

// One line of the agent's view of a header: line breaks and control characters collapse, so a value never starts a line of its own.
function oneLine(value: string, max: number): string {
  const line = value.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function mailboxLine({ address, name }: WireEmailMailbox): string {
  // A display name cannot pose as an address of its own.
  const label = name ? oneLine(name.replace(/[<>]/g, ''), 256) : ''
  return label ? `${label} <${address}>` : address
}

/** The header block the agent reads above a mail's body: `From`, `To`, `Cc`, `Subject` and `Date`, one line each (§5.4). */
export function renderEmailHeaderBlock(
  mail: Pick<WireEmailAdapterExt, 'from' | 'to' | 'cc' | 'subject' | 'date'>
): string {
  return [
    `From: ${mailboxLine(mail.from)}`,
    ...(mail.to.length ? [`To: ${mail.to.map(mailboxLine).join(', ')}`] : []),
    ...(mail.cc.length ? [`Cc: ${mail.cc.map(mailboxLine).join(', ')}`] : []),
    `Subject: ${oneLine(mail.subject, 998)}`,
    ...(mail.date ? [`Date: ${oneLine(mail.date, 128)}`] : [])
  ].join('\n')
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One line for each attachment, which is named and not delivered (§5.4). */
export function emailAttachmentNotes(attachments: WireEmailAdapterExt['attachments']): string {
  return attachments
    .map(({ name, type, size }) => `[Attachment not delivered: ${name} (${type}, ${sizeLabel(size)})]`)
    .join('\n')
}

// ── normalization ──

/** An address as the relay's MIME reader read it from a header. */
export interface EmailParsedMailbox {
  address?: string
  name?: string
}

/** A parsed mail as the relay hands it over; every field is only structurally trusted. */
export interface EmailInboundMessage {
  /** Every header field, top first. */
  headers: readonly EmailHeader[]
  from?: readonly EmailParsedMailbox[]
  to?: readonly EmailParsedMailbox[]
  cc?: readonly EmailParsedMailbox[]
  /** The text part, or an HTML-only body already converted to text. */
  text?: string
  attachments?: readonly { name?: string; type?: string; size?: number }[]
  /** The message was cut before it was parsed (§7). */
  truncated?: boolean
}

/** The receiving agent's verified identity; it is never taken from a header. */
export interface EmailNormalizeContext {
  /** The canonical agent address the envelope recipient resolved to. */
  agentAddress: string
  traceId: string
  /** When the relay received the message; the `Date` header is the sender's clock. */
  receivedAtMs?: number
}

export type EmailInvalidReason = 'sender' | 'message_id' | 'recipients'

/** `invalid` is a message nothing could be keyed by or reply to: no single `From` address, no single `Message-ID`, or more recipients than a reply can carry. */
export type EmailNormalizeResult =
  { kind: 'message'; message: NormalizedPlatformMessage } | { kind: 'invalid'; reason: EmailInvalidReason }

function mailboxes(parsed: readonly EmailParsedMailbox[] | undefined): WireEmailMailbox[] {
  const byAddress = new Map<string, WireEmailMailbox>()
  for (const entry of parsed ?? []) {
    const address = typeof entry?.address === 'string' ? canonicalEmailAddress(entry.address) : undefined
    if (!address || byAddress.has(address)) continue
    const name = typeof entry.name === 'string' ? oneLine(entry.name, 256) : ''
    byAddress.set(address, { address, ...(name ? { name } : {}) })
  }
  return [...byAddress.values()]
}

// A bare `type/subtype`; anything else is named as opaque bytes.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

// A message ID as the colon-free native segment of the `platform:channel:native` msgId grammar.
function nativeId(messageId: string): string {
  return messageId.replace(/[%:]/g, encodeURIComponent)
}

/** Normalize one parsed mail addressed to an agent; the conversation and thread are the header-only ones, which the daemon resolves again against the messages it knows (§5.1, §5.2). */
export function normalizeEmailMessage(
  payload: EmailInboundMessage,
  context: EmailNormalizeContext
): EmailNormalizeResult {
  const { headers } = payload
  // Two `From` fields, or two addresses in one, leave no single sender for the authentication verdict to be about.
  const from = mailboxes(payload.from)[0]
  if (!from || payload.from?.length !== 1 || emailHeaderValues(headers, 'from').length !== 1)
    return { kind: 'invalid', reason: 'sender' }
  const ownIds = emailHeaderValues(headers, 'message-id')
  const [messageId, ...otherIds] = parseEmailMessageIds(ownIds[0])
  if (!messageId || otherIds.length || ownIds.length !== 1) return { kind: 'invalid', reason: 'message_id' }
  const to = mailboxes(payload.to)
  const cc = mailboxes(payload.cc).filter((entry) => !to.some((other) => other.address === entry.address))
  if (to.length + cc.length > EMAIL_RECIPIENTS_MAX) return { kind: 'invalid', reason: 'recipients' }

  const chain = parseEmailMessageIds(emailHeaderValues(headers, 'references').join(' '))
  // An over-long chain keeps its root, which the fallback key reads, and its newest IDs, which the daemon walks first.
  const references = chain.length > EMAIL_REFERENCES_MAX ? [chain[0]!, ...chain.slice(1 - EMAIL_REFERENCES_MAX)] : chain
  const inReplyTo = parseEmailMessageIds(emailHeaderValues(headers, 'in-reply-to')[0])[0]
  const date = oneLine(emailHeaderValues(headers, 'date')[0] ?? '', 128)
  const attachments = (payload.attachments ?? []).slice(0, EMAIL_ATTACHMENTS_MAX).map((entry, index) => {
    const name = typeof entry?.name === 'string' ? oneLine(safeAttachmentName(entry.name) ?? '', 160) : ''
    const type = typeof entry?.type === 'string' ? entry.type.trim().toLowerCase() : ''
    return {
      name: name || `attachment-${index + 1}`,
      type: type.length <= 128 && MEDIA_TYPE.test(type) ? type : 'application/octet-stream',
      size: typeof entry?.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : 0
    }
  })
  const body = cutEmailBody(typeof payload.text === 'string' ? payload.text : '', payload.truncated === true)
  const ext: WireEmailAdapterExt = {
    from,
    to,
    cc,
    subject: oneLine(emailHeaderValues(headers, 'subject')[0] ?? '', 998),
    ...(date ? { date } : {}),
    messageId,
    ...(inReplyTo ? { inReplyTo } : {}),
    references,
    ...(body.truncated ? { truncated: true } : {}),
    attachments
  }
  const thread = emailFallbackThreadKey(ext)
  const conversation = emailConversation(emailParticipants(ext, context.agentAddress), thread)
  const group = conversation.kind === 'group'
  const { receivedAtMs } = context
  return {
    kind: 'message',
    message: {
      msgId: `${EMAIL_PLATFORM}:${context.agentAddress}:${nativeId(messageId)}`,
      traceId: context.traceId,
      source: 'user',
      platform: EMAIL_PLATFORM,
      channel: conversation.channel,
      thread,
      sender: { id: from.address, isBot: false, ...(from.name ? { name: from.name } : {}) },
      text: [body.text, emailAttachmentNotes(attachments)].filter(Boolean).join('\n\n'),
      // A message that reached the address is addressed to the agent wherever the address appears (§5.2).
      mentionedBots: group ? [context.agentAddress] : [],
      isDm: !group,
      ...(group ? { isGroupDm: true } : {}),
      ...(receivedAtMs !== undefined && Number.isSafeInteger(receivedAtMs) && receivedAtMs > 0
        ? { platformTimeMs: receivedAtMs }
        : {}),
      adapterExt: { [EMAIL_PLATFORM]: ext }
    }
  }
}
