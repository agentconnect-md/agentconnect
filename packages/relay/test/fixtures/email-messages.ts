// Synthetic mail for the relay's Email suites: raw messages, the deployment's configuration, and posts signed as the ingress Worker signs them.
import { createHmac } from 'node:crypto'
import {
  EMAIL_INGRESS_HEADERS,
  EMAIL_INGRESS_SIGNATURE_VERSION,
  emailIngressSigningPrefix,
  type RcEmailDeployment
} from '@agentconnect.md/protocol'

export const MAIL_DOMAIN = 'mail.example.test'
export const AGENT_ADDRESS = `helper@${MAIL_DOMAIN}`
export const MEMBER = 'alice@corp.example.test'
export const COLLEAGUE = 'bob@corp.example.test'
export const AUTHSERV_ID = 'mx.example.test'
export const NOW = 1_800_000_000_000

export const EMAIL_CONFIG: RcEmailDeployment = {
  mailDomain: MAIL_DOMAIN,
  accountId: '0123456789abcdef0123456789abcdef',
  apiToken: 'synthetic-sending-token',
  ingressSecret: 'synthetic-ingress-secret-0123456789abcdef',
  authservId: AUTHSERV_ID,
  ticketKey: Buffer.alloc(32, 7).toString('base64url')
}

export interface RawMailOptions {
  from?: string
  to?: string
  cc?: string
  subject?: string
  messageId?: string | null
  /** The provider's `Authentication-Results`, topmost; `null` leaves it out. */
  authentication?: string | null
  /** Header lines placed under the provider's, as the sender wrote them. */
  headers?: string[]
  body?: string
  contentType?: string
}

/** One raw message as the provider hands it over: its own `Authentication-Results` first, then what the sender wrote. */
export function rawMail(options: RawMailOptions = {}): Buffer {
  const authentication =
    options.authentication === undefined
      ? `${AUTHSERV_ID}; dkim=pass header.d=corp.example.test header.s=s1 header.b=abcd; dmarc=pass header.from=corp.example.test policy.dmarc=reject; spf=pass smtp.mailfrom=${MEMBER}`
      : options.authentication
  const lines = [
    ...(authentication === null ? [] : [`Authentication-Results: ${authentication}`]),
    'Received: from mail.corp.example.test by mx.example.test',
    ...(options.headers ?? []),
    `From: ${options.from ?? `Alice Example <${MEMBER}>`}`,
    `To: ${options.to ?? AGENT_ADDRESS}`,
    ...(options.cc ? [`Cc: ${options.cc}`] : []),
    `Subject: ${options.subject ?? 'Quarterly numbers'}`,
    ...(options.messageId === null ? [] : [`Message-ID: <${options.messageId ?? 'm1@corp.example.test'}>`]),
    'Date: Thu, 19 Nov 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: ${options.contentType ?? 'text/plain; charset=utf-8'}`,
    '',
    options.body ?? 'Please summarize the attached numbers.'
  ]
  return Buffer.from(lines.join('\r\n'), 'utf8')
}

export interface SignedPostOptions {
  secret?: string
  timestamp?: number
  envelopeFrom?: string
  envelopeTo?: string
  /** The message's full size; defaults to the body's. */
  size?: number
}

/** The headers the ingress Worker sends with `raw`, signed over exactly what they carry. */
export function signedHeaders(raw: Buffer, options: SignedPostOptions = {}): Record<string, string> {
  const sent = {
    timestamp: String(options.timestamp ?? NOW),
    size: String(options.size ?? raw.length),
    from: encodeURIComponent(options.envelopeFrom ?? MEMBER),
    to: encodeURIComponent(options.envelopeTo ?? AGENT_ADDRESS)
  }
  const mac = createHmac('sha256', options.secret ?? EMAIL_CONFIG.ingressSecret)
    .update(emailIngressSigningPrefix(sent))
    .update(raw)
    .digest('hex')
  return {
    'content-type': 'message/rfc822',
    [EMAIL_INGRESS_HEADERS.timestamp]: sent.timestamp,
    [EMAIL_INGRESS_HEADERS.size]: sent.size,
    [EMAIL_INGRESS_HEADERS.from]: sent.from,
    [EMAIL_INGRESS_HEADERS.to]: sent.to,
    [EMAIL_INGRESS_HEADERS.signature]: `${EMAIL_INGRESS_SIGNATURE_VERSION}=${mac}`
  }
}
