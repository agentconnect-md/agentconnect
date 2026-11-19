// Synthetic parsed mail in the shape the relay's MIME reader hands over; every address, domain and ID is a placeholder on a reserved name.
import type { EmailHeader, EmailInboundMessage, EmailParsedMailbox } from '../../src/email-message.js'

export const MAIL_DOMAIN = 'mail.example.test'
export const AGENT = `helper@${MAIL_DOMAIN}`
export const AUTHSERV = 'mx.example.net'
export const ALICE = 'alice@corp.example.test'
export const BOB = 'bob@corp.example.test'
export const CAROL = 'carol@partner.example.test'

export const header = (name: string, value: string): EmailHeader => ({ name, value })

/** The provider's verdict header, which it prepends to every message. */
export const authResults = (results: string, authserv = AUTHSERV): EmailHeader =>
  header('Authentication-Results', `${authserv}; ${results}`)

export const DKIM_PASS = 'dkim=pass header.d=corp.example.test header.s=sel1 header.b=AbCd/+12'
export const SPF_PASS = 'spf=pass (sender is authorized) smtp.mailfrom=bounce@corp.example.test'
export const DMARC_PASS = `${DKIM_PASS}; dmarc=pass (p=reject) header.from=corp.example.test; ${SPF_PASS}`

interface MailParts {
  from?: EmailParsedMailbox[]
  to?: EmailParsedMailbox[]
  cc?: EmailParsedMailbox[]
  /** The `Cc` field's text as written, where the reader's list does not account for it. */
  ccHeader?: string
  messageId?: string
  inReplyTo?: string
  references?: string
  subject?: string
  text?: string
  /** Header fields placed above the message's own, as a mail server adds them. */
  prepend?: EmailHeader[]
  attachments?: EmailInboundMessage['attachments']
  truncated?: boolean
}

const mailboxHeader = (list: EmailParsedMailbox[]) =>
  list.map(({ address = '', name }) => (name ? `${name} <${address}>` : address)).join(', ')

export function mail(parts: MailParts = {}): EmailInboundMessage {
  const from = parts.from ?? [{ address: ALICE, name: 'Alice Example' }]
  const to = parts.to ?? [{ address: AGENT }]
  const cc = parts.cc ?? []
  const ccHeader = parts.ccHeader ?? (cc.length ? mailboxHeader(cc) : undefined)
  return {
    headers: [
      ...(parts.prepend ?? [authResults(DMARC_PASS)]),
      header('From', mailboxHeader(from)),
      header('To', mailboxHeader(to)),
      ...(ccHeader !== undefined ? [header('Cc', ccHeader)] : []),
      header('Subject', parts.subject ?? 'Quarterly report'),
      header('Date', 'Mon, 02 Nov 2026 09:30:00 +0000'),
      header('Message-ID', parts.messageId ?? '<m1@corp.example.test>'),
      ...(parts.inReplyTo ? [header('In-Reply-To', parts.inReplyTo)] : []),
      ...(parts.references ? [header('References', parts.references)] : [])
    ],
    from,
    to,
    ...(cc.length ? { cc } : {}),
    text: parts.text ?? 'Please summarize the attached numbers.',
    ...(parts.attachments ? { attachments: parts.attachments } : {}),
    ...(parts.truncated ? { truncated: true } : {})
  }
}

/** A member's first message to the agent, alone. */
export const dmNew = mail()

/** The member's reply to the agent's answer in the same thread. */
export const dmReply = mail({
  messageId: '<m2@corp.example.test>',
  inReplyTo: '<a1@mail.example.test>',
  references: '<m1@corp.example.test> <a1@mail.example.test>',
  subject: 'Re: Quarterly report',
  text: 'Thanks, one more question.'
})

/** A message that names a second person, which makes the thread a group. */
export const groupNew = mail({
  messageId: '<g1@corp.example.test>',
  cc: [{ address: BOB, name: 'Bob Example' }],
  subject: 'Launch plan'
})
