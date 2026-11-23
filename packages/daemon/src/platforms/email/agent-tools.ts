// Mail the agent starts (email-integration.md §6.4): the `sendEmail` tool every agent with an address gets in every session, its recipient and who-may-cause rules, and the started thread's record.
import { randomBytes } from 'node:crypto'
import { z, type ZodType } from 'zod'
import { canonicalEmailAddress } from '@agentconnect.md/message'
import {
  EMAIL_PLATFORM,
  EMAIL_RECIPIENTS_MAX,
  EMAIL_SEND_ATTACHMENT_BYTES_MAX,
  EMAIL_SEND_ATTACHMENTS_MAX,
  EMAIL_STARTED_OWNER_PREFIX,
  type WireEmailAttachment,
  type WireEmailCall
} from '@agentconnect.md/protocol'
import type { Integration } from '../../agents/agent-schema.js'
import { parseArgs, requiredString } from '../../mcp/ops/args.js'
import type { SessionContext } from '../../mcp/ops/context.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { platformIntegrationConfig } from '../integration-config.js'
import type { PlatformAgentToolEnv, PlatformAgentTools, PlatformConversationSeed } from '../read-ports.js'
import type { EmailConnection, EmailStoredSent } from './connection.js'
import type { EmailMemberVerdict } from './members.js'
import { emailFromName, emailReplyBodies, emailWithFooter } from './render.js'
import { emailStartedReplyConversation, emailStartedReplyThread } from './threading.js'

const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** A new started thread's tag: 20 base32 characters, 100 random bits (§6.4). */
export function mintEmailStartedTag(): string {
  return [...randomBytes(20)].map((byte) => TAG_ALPHABET[byte & 31]).join('')
}

const addresses = (key: string) =>
  z.array(requiredString(key), `argument ${key} must be an array of email addresses`).min(1, `${key} names nobody`)

/** The longest note on why a mail was started. */
const EMAIL_PURPOSE_MAX = 1000

export const SEND_EMAIL_ARGS = z.object({
  to: addresses('to'),
  cc: addresses('cc')
    .nullish()
    .transform((value) => value ?? undefined),
  subject: requiredString('subject'),
  body: requiredString('body'),
  attachments: z
    .array(requiredString('attachments'), 'argument attachments must be an array of file paths')
    .max(EMAIL_SEND_ATTACHMENTS_MAX, `at most ${EMAIL_SEND_ATTACHMENTS_MAX} attachments`)
    .nullish()
    .transform((value) => (value?.length ? value : undefined)),
  purpose: z
    .string()
    .max(EMAIL_PURPOSE_MAX, `purpose is at most ${EMAIL_PURPOSE_MAX} characters`)
    .nullish()
    .transform((value) => value?.trim() || undefined)
})

export const SEND_EMAIL_TOOL: ToolDescriptor = {
  name: 'sendEmail',
  description:
    'Start a new mail from your own email address. Replies come back to you in threads of their own, which the ' +
    'result names so you can recall them from here; to ' +
    'answer a mail you received, write your ordinary reply instead. At most 50 addresses in to and cc together, ' +
    'none on your own mail domain. Only a turn started by a member’s own message may mail people outside your ' +
    'organization.',
  inputSchema: obj(
    {
      to: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Email addresses to send to.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Email addresses to copy.' },
      subject: { type: 'string', minLength: 1, description: 'The subject line.' },
      body: { type: 'string', minLength: 1, description: 'The mail body in Markdown.' },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        maxItems: EMAIL_SEND_ATTACHMENTS_MAX,
        description: `Files to attach: workspace-relative paths or \`files:\` names, as shareFile takes them; at most ${EMAIL_SEND_ATTACHMENTS_MAX}, ${EMAIL_SEND_ATTACHMENT_BYTES_MAX / (1024 * 1024)} MiB together.`
      },
      purpose: {
        type: 'string',
        description:
          'Why you are sending this and what to do when someone answers. Kept with the thread for you, never mailed.'
      }
    },
    ['to', 'subject', 'body']
  )
}

/** The started mail's recipients, each once and canonical, or why the tool refuses them. */
export function startedRecipients(
  args: { to: readonly string[]; cc?: readonly string[] | undefined },
  agentAddress: string
): { to: string[]; cc: string[] } | { refused: string } {
  const read = (list: readonly string[]) => list.map((entry) => [entry, canonicalEmailAddress(entry)] as const)
  const given = [...read(args.to), ...read(args.cc ?? [])]
  const unreadable = given.filter(([, address]) => !address).map(([entry]) => entry)
  if (unreadable.length) return { refused: `these are not email addresses: ${unreadable.join(', ')}` }
  const to = [...new Set(read(args.to).map(([, address]) => address!))]
  const cc = [...new Set(read(args.cc ?? []).map(([, address]) => address!))].filter((address) => !to.includes(address))
  if (to.length + cc.length > EMAIL_RECIPIENTS_MAX)
    return { refused: `a mail goes to at most ${EMAIL_RECIPIENTS_MAX} addresses in to and cc together` }
  // Mail between agents stays excluded, as it is on the way in (§4 step 1).
  const domain = agentAddress.slice(agentAddress.lastIndexOf('@') + 1)
  const own = [...to, ...cc].filter((address) => {
    const at = address.slice(address.lastIndexOf('@') + 1)
    return at === domain || at.endsWith(`.${domain}`)
  })
  if (own.length) return { refused: `mail is never sent to your own mail domain (${own.join(', ')})` }
  return { to, cc }
}

/** The unmailed note kept under a started mail: the conversation that asked for it and the agent's own purpose; undefined when there is neither. */
export function emailOriginNote(purpose: string | undefined, sessionUrl: string | undefined): string | undefined {
  if (!purpose && !sessionUrl) return undefined
  const where = sessionUrl ? `Sent from [this conversation](${sessionUrl}).` : undefined
  return ['---', ['Not mailed.', where, purpose ? `Purpose: ${purpose}` : undefined].filter(Boolean).join(' ')].join(
    '\n\n'
  )
}

/** Where a started thread lives and whose its session is, fixed at the send (§5.2, §5.3). */
export function startedThreadPlace(
  recipients: readonly string[],
  tag: string,
  verdicts: ReadonlyMap<string, EmailMemberVerdict>,
  turnMembers: readonly string[] | undefined
): Pick<PlatformConversationSeed, 'channel' | 'kind' | 'owner'> {
  const single = recipients.length === 1 ? recipients[0] : undefined
  const place = single
    ? { channel: `dm:${single}`, kind: 'dm' as const }
    : { channel: `group:${tag}`, kind: 'group_dm' as const }
  // One member recipient: the thread is that member's own direct conversation.
  if (single && verdicts.get(single)?.allowed) return { ...place, owner: single }
  // A group, or a non-member recipient: the member whose turn sent it, who asked for the mail.
  if (turnMembers?.[0]) return { ...place, owner: `${EMAIL_STARTED_OWNER_PREFIX}${turnMembers[0]}` }
  // No member behind the turn mails members only, so its group thread goes to the first of them.
  return { ...place, owner: recipients[0]! }
}

/** Where the answers to a mail a member asked for land, as `recall` place ids: the started thread, and each recipient's own thread (§5.2). */
export function startedReplyPlaces(
  tag: string,
  channel: string,
  recipients: readonly string[]
): { toEveryone: string; toYouAlone?: Record<string, string>; note: string } {
  const placeOf = (conversation: string) => `${EMAIL_PLATFORM}:${conversation}`
  const alone =
    recipients.length > 1
      ? Object.fromEntries(
          recipients.map((address) => [
            address,
            placeOf(emailStartedReplyConversation(emailStartedReplyThread(tag, address)).channel)
          ])
        )
      : undefined
  return {
    toEveryone: placeOf(channel),
    ...(alone ? { toYouAlone: alone } : {}),
    note:
      'Answers come back in these conversations, not here: a reply to everyone in toEveryone, and a reply to you ' +
      'alone in that recipient’s own. To see them, call recall with one of these places. A place nobody has ' +
      'answered in yet does not exist, so recall refuses it. When the member who asked for this mail is the one ' +
      'asking, a refusal of one of these places means no answer has arrived there yet: say they have not answered, ' +
      'not that you cannot share it. For anyone else, give recall’s answer as it is.'
  }
}

const refused = (why: string): Error => new Error(`sendEmail: ${why}. Nothing was sent.`)

const MEMBERS_ONLY =
  'this turn was not started by a member’s own message, so it may mail members of your organization only, and ' +
  'these could not be confirmed as members'

/** What the tool acts through: the address's connection, and the daemon facts of the call. */
export interface EmailStartDeps {
  conn: Pick<EmailConnection, 'address' | 'agentId' | 'members' | 'send' | 'recordSent'>
  env: Pick<
    PlatformAgentToolEnv,
    'memberTurn' | 'startConversation' | 'attribution' | 'callingSessionUrl' | 'readWorkspaceFile'
  >
  agentName?: string
  mintTag?: () => string
  now(): number
}

/** Start one mail (§6.4): check its recipients and who may cause it, send it through the relay, then open its thread with the mail as its first message. */
export async function startEmail(
  deps: EmailStartDeps,
  args: {
    to: readonly string[]
    cc?: readonly string[] | undefined
    subject: string
    body: string
    attachments?: readonly string[] | undefined
    purpose?: string | undefined
  }
): Promise<unknown> {
  const { conn } = deps
  const recipients = startedRecipients(args, conn.address)
  if ('refused' in recipients) throw refused(recipients.refused)
  const attachments = args.attachments ? await readAttachments(deps.env, args.attachments) : undefined
  const all = [...recipients.to, ...recipients.cc]
  const members = conn.members
  if (!members) throw refused('this daemon cannot check recipients')
  // Who is asking, from the place rules' own derivation; anything it cannot tell mails members only.
  const turnMembers = await deps.env.memberTurn().catch(() => undefined)
  const verdicts = await members.judge(conn.agentId, all)
  if (!verdicts) throw refused('whether the recipients are members of your organization could not be checked now')
  const outside = all.filter((address) => !verdicts.get(address)?.allowed)
  if (!turnMembers && outside.length) throw refused(`${MEMBERS_ONLY}: ${outside.join(', ')}`)
  const tag = (deps.mintTag ?? mintEmailStartedTag)()
  const place = startedThreadPlace(all, tag, verdicts, turnMembers)
  // The agent's footer goes under a mail to members only; the session keeps the body alone.
  const attribution = await deps.env.attribution().catch(() => undefined)
  const bodies = emailReplyBodies(emailWithFooter(args.body, attribution, outside.length > 0))
  const fromName = emailFromName(deps.agentName)
  const subject = args.subject.replace(/[\r\n]+/g, ' ').trim()
  if (!subject) throw refused('the subject is empty')
  const call: WireEmailCall = {
    op: 'start',
    tag,
    to: recipients.to,
    cc: recipients.cc,
    ...(fromName ? { fromName } : {}),
    subject: subject.slice(0, 998),
    text: bodies.text,
    html: bodies.html,
    ...(attachments ? { attachments } : {})
  }
  const result = await conn.send(call)
  if (result.outcome === 'unsent') throw refused(`the mail was not sent: ${result.reason}`)
  // Sent, or perhaps sent: the thread exists either way, so a reply that does arrive finds it.
  const sent: EmailStoredSent = {
    from: { address: conn.address, ...(fromName ? { name: fromName } : {}) },
    to: recipients.to.map((address) => ({ address })),
    cc: recipients.cc.map((address) => ({ address })),
    subject: call.subject,
    started: true,
    owner: place.owner
  }
  let recorded = true
  try {
    // The index row first, so a reply that arrives while the session opens already finds its thread.
    await conn.recordSent({
      ...(result.outcome === 'sent' && result.messageId ? { messageId: result.messageId } : {}),
      thread: tag,
      conversation: place.channel,
      mail: JSON.stringify(sent),
      ts: tag,
      outcome: result.outcome,
      ...(result.outcome !== 'sent' ? { reason: result.reason } : {}),
      createdAt: deps.now()
    })
    // The thread's first record is the mail and, unmailed, where and why it was sent, so a reply finds the agent knowing.
    const origin = emailOriginNote(args.purpose, await deps.env.callingSessionUrl().catch(() => undefined))
    const record = [args.body, ...(attachments ? [attachedNotes(attachments)] : []), ...(origin ? [origin] : [])]
    await deps.env.startConversation({ ...place, thread: tag, text: record.join('\n\n') })
  } catch {
    recorded = false
  }
  return {
    sent: result.outcome === 'sent',
    to: recipients.to,
    cc: recipients.cc,
    ...(result.outcome === 'unknown'
      ? { note: `The mail may not have been delivered (${result.reason}); do not send it again unasked.` }
      : {}),
    ...(recorded
      ? {}
      : { warning: 'The mail went out, but its thread was not recorded, so replies start new threads.' }),
    // Only the member who asked owns the answers' threads, so only their turn is told where to recall them.
    ...(recorded && place.owner.startsWith(EMAIL_STARTED_OWNER_PREFIX)
      ? { replies: startedReplyPlaces(tag, place.channel, all) }
      : {})
  }
}

// Each named file read as shareFile reads it, within the started mail's count and size limits.
async function readAttachments(
  env: Pick<PlatformAgentToolEnv, 'readWorkspaceFile'>,
  paths: readonly string[]
): Promise<WireEmailAttachment[]> {
  const files: WireEmailAttachment[] = []
  let total = 0
  for (const path of paths) {
    const read = await env.readWorkspaceFile(path)
    if (!read.ok)
      throw refused(`the attachment "${path}" cannot be read (${read.reason}${read.detail ? `: ${read.detail}` : ''})`)
    total += read.bytes.byteLength
    if (total > EMAIL_SEND_ATTACHMENT_BYTES_MAX)
      throw refused(`the attachments exceed ${EMAIL_SEND_ATTACHMENT_BYTES_MAX / (1024 * 1024)} MiB together`)
    files.push({ name: read.name, type: read.mimeType, content: read.bytes.toString('base64') })
  }
  return files
}

const attachedNotes = (files: readonly WireEmailAttachment[]): string =>
  files.map((file) => `[Attached: ${file.name} (${file.type})]`).join('\n')

const isEmailConnection = (value: unknown): value is EmailConnection =>
  typeof value === 'object' && value !== null && 'address' in value && 'startedThread' in value

/** Email's agent tools: `sendEmail` and the line naming the address, for every agent that holds one (§6.4). */
export const EMAIL_AGENT_TOOLS: PlatformAgentTools = {
  descriptors: [SEND_EMAIL_TOOL],
  argSchemas: new Map<string, ZodType>([[SEND_EMAIL_TOOL.name, SEND_EMAIL_ARGS]]),
  instructions(integration: Integration): readonly string[] {
    const address = platformIntegrationConfig('email', integration)?.address
    return address
      ? [
          `Your email address is ${address}. People can write to you there, and sendEmail starts a new mail from it; ` +
            'replies to that mail come back to you in threads of their own, which recall reads from where you sent it.'
        ]
      : []
  },
  async execute(name: string, ctx: SessionContext, args: Record<string, unknown>, env: PlatformAgentToolEnv) {
    if (name !== SEND_EMAIL_TOOL.name) throw new Error(`unknown tool: ${name}`)
    const conn = env.connection
    if (!isEmailConnection(conn)) throw new Error(`no live email connection for integration ${env.integrationId}`)
    return await startEmail(
      {
        conn,
        env,
        ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
        now: () => Date.now()
      },
      parseArgs(SEND_EMAIL_ARGS, args)
    )
  }
}
