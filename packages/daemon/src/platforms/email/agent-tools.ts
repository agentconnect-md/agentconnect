// Mail the agent starts (email-integration.md §6.4): the `sendEmail` tool every agent with an address gets in every session, its recipient and who-may-cause rules, and the started thread's record.
import { randomBytes } from 'node:crypto'
import { z, type ZodType } from 'zod'
import { canonicalEmailAddress } from '@agentconnect.md/message'
import { EMAIL_RECIPIENTS_MAX, EMAIL_STARTED_OWNER_PREFIX, type WireEmailCall } from '@agentconnect.md/protocol'
import type { Integration } from '../../agents/agent-schema.js'
import { parseArgs, requiredString } from '../../mcp/ops/args.js'
import type { SessionContext } from '../../mcp/ops/context.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { platformIntegrationConfig } from '../integration-config.js'
import type { PlatformAgentToolEnv, PlatformAgentTools, PlatformConversationSeed } from '../read-ports.js'
import type { EmailConnection, EmailStoredSent } from './connection.js'
import type { EmailMemberVerdict } from './members.js'
import { emailFromName, emailReplyBodies } from './render.js'

const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** A new started thread's tag: 20 base32 characters, 100 random bits (§6.4). */
export function mintEmailStartedTag(): string {
  return [...randomBytes(20)].map((byte) => TAG_ALPHABET[byte & 31]).join('')
}

const addresses = (key: string) =>
  z.array(requiredString(key), `argument ${key} must be an array of email addresses`).min(1, `${key} names nobody`)

export const SEND_EMAIL_ARGS = z.object({
  to: addresses('to'),
  cc: addresses('cc')
    .nullish()
    .transform((value) => value ?? undefined),
  subject: requiredString('subject'),
  body: requiredString('body')
})

export const SEND_EMAIL_TOOL: ToolDescriptor = {
  name: 'sendEmail',
  description:
    'Start a new mail from your own email address. A reply to it comes back to you as a thread of its own; to ' +
    'answer a mail you received, write your ordinary reply instead. At most 50 addresses in to and cc together, ' +
    'none on your own mail domain. Only a turn started by a member’s own message may mail people outside your ' +
    'organization.',
  inputSchema: obj(
    {
      to: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Email addresses to send to.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Email addresses to copy.' },
      subject: { type: 'string', minLength: 1, description: 'The subject line.' },
      body: { type: 'string', minLength: 1, description: 'The mail body in Markdown.' }
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

const refused = (why: string): Error => new Error(`sendEmail: ${why}. Nothing was sent.`)

const MEMBERS_ONLY =
  'this turn was not started by a member’s own message, so it may mail members of your organization only, and ' +
  'these could not be confirmed as members'

/** What the tool acts through: the address's connection, and the daemon facts of the call. */
export interface EmailStartDeps {
  conn: Pick<EmailConnection, 'address' | 'agentId' | 'members' | 'send' | 'recordSent'>
  env: Pick<PlatformAgentToolEnv, 'memberTurn' | 'startConversation'>
  agentName?: string
  mintTag?: () => string
  now(): number
}

/** Start one mail (§6.4): check its recipients and who may cause it, send it through the relay, then open its thread with the mail as its first message. */
export async function startEmail(
  deps: EmailStartDeps,
  args: { to: readonly string[]; cc?: readonly string[] | undefined; subject: string; body: string }
): Promise<unknown> {
  const { conn } = deps
  const recipients = startedRecipients(args, conn.address)
  if ('refused' in recipients) throw refused(recipients.refused)
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
  const bodies = emailReplyBodies(args.body)
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
    html: bodies.html
  }
  const result = await conn.send(call)
  if (result.outcome === 'unsent') throw refused(`the mail was not sent: ${result.reason}`)
  // Sent, or perhaps sent: the thread exists either way, so a reply that does arrive finds it.
  const sent: EmailStoredSent = {
    from: { address: conn.address, ...(fromName ? { name: fromName } : {}) },
    to: recipients.to.map((address) => ({ address })),
    cc: recipients.cc.map((address) => ({ address })),
    subject: call.subject,
    started: true
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
    await deps.env.startConversation({ ...place, thread: tag, text: args.body })
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
      : { warning: 'The mail went out, but its thread was not recorded, so replies start new threads.' })
  }
}

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
            'a reply to that mail comes back to you as a thread of its own.'
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
