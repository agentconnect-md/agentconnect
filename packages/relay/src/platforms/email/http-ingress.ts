// The route the ingress Worker posts each inbound mail to (email-integration.md §5.5, §7): the signature is checked before anything else is read, and the answer is the message's verdict.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  EMAIL_INBOUND_PATH,
  EMAIL_INGRESS_BODY_MAX_BYTES,
  EMAIL_INGRESS_DEADLINE_MS,
  EMAIL_INGRESS_HEADERS,
  EMAIL_INGRESS_SIGNATURE_VERSION,
  EMAIL_INGRESS_WINDOW_MS,
  EMAIL_PLATFORM,
  emailIngressSigningPrefix,
  type EmailIngressAnswer,
  type RcEmailDeployment
} from '@agentconnect.md/protocol'
import { emailAgentAddress } from '@agentconnect.md/message'
import type { RelayIngressRouteDeps } from '../contract.js'
import { settleWithin } from '../settle-within.js'

/** What the relay tells the sender's mail server when it rejects a message: short, fixed, and the same whatever the cause within one line (§4). */
export const EMAIL_REJECT_REASONS = {
  unknownAddress: 'This address does not exist.',
  unreadable: 'This message could not be read.',
  unauthenticated: 'This message could not be verified as coming from its sender.',
  sender: 'This message does not name a single sender address.',
  messageId: 'This message has no usable Message-ID.',
  recipients: 'This message names too many recipients.',
  notMember: 'This address accepts mail from members of its organization.',
  rateLimited: 'Too many messages were sent to this address. Try again later.'
} as const

export const emailAccepted: EmailIngressAnswer = { result: 'accepted' }
export const emailReject = (reason: string): EmailIngressAnswer => ({ result: 'reject', reason })

/** One post whose signature held: only this module makes one, so the plugin can tell a verified post from anything else handed to it. */
export class VerifiedEmailPost {
  private constructor(
    readonly raw: Buffer,
    /** The SMTP envelope sender; empty on a bounce. */
    readonly envelopeFrom: string,
    readonly envelopeTo: string,
    /** The canonical agent address the envelope recipient names, its `+tag` dropped. */
    readonly agentAddress: string | undefined,
    /** The Worker posted less than the whole message. */
    readonly truncated: boolean
  ) {}

  /** Check one post against the deployment's ingress secret; undefined for a missing, stale or wrong signature, and for a header the signed text could not have carried. */
  static verify(
    config: Pick<RcEmailDeployment, 'ingressSecret' | 'mailDomain'>,
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>,
    now: number
  ): VerifiedEmailPost | undefined {
    const one = (name: string) => (typeof headers[name] === 'string' ? headers[name] : undefined)
    const timestamp = one(EMAIL_INGRESS_HEADERS.timestamp)
    const size = one(EMAIL_INGRESS_HEADERS.size)
    const from = one(EMAIL_INGRESS_HEADERS.from)
    const to = one(EMAIL_INGRESS_HEADERS.to)
    const signature = one(EMAIL_INGRESS_HEADERS.signature)
    if (timestamp === undefined || size === undefined || from === undefined || !to || !signature) return undefined
    const expected = createHmac('sha256', config.ingressSecret)
      .update(emailIngressSigningPrefix({ timestamp, size, from, to }))
      .update(raw)
      .digest()
    const [version, hex, ...rest] = signature.split('=')
    const given = Buffer.from(/^[0-9a-f]{64}$/.test(hex ?? '') ? hex! : '', 'hex')
    // Compared in constant time and before the timestamp is read, so a wrong signature learns nothing from the answer.
    const holds = given.length === expected.length && timingSafeEqual(given, expected)
    if (!holds || version !== EMAIL_INGRESS_SIGNATURE_VERSION || rest.length > 0) return undefined
    if (!/^[0-9]{1,15}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > EMAIL_INGRESS_WINDOW_MS)
      return undefined
    if (!/^[0-9]{1,15}$/.test(size)) return undefined
    let envelopeFrom: string
    let envelopeTo: string
    try {
      envelopeFrom = decodeURIComponent(from)
      envelopeTo = decodeURIComponent(to)
    } catch {
      return undefined
    }
    return new VerifiedEmailPost(
      raw,
      envelopeFrom,
      envelopeTo,
      emailAgentAddress(envelopeTo, config.mailDomain),
      Number(size) > raw.length
    )
  }
}

export interface EmailHttpIngressOptions {
  /** The deployment's Email configuration from the latest snapshot; undefined while the relay serves no mail. */
  config(): RcEmailDeployment | undefined
  /** Whether bot assignments may still be arriving after a registration, so an address no bot holds yet is not refused for good. */
  settling?(now: number): boolean
  now?(): number
  /** Overridden only by tests that exercise the expiry. */
  deadlineMs?: number
}

export function registerEmailHttpIngress(
  app: FastifyInstance,
  deps: RelayIngressRouteDeps,
  options: EmailHttpIngressOptions
): void {
  const deadlineMs = options.deadlineMs ?? EMAIL_INGRESS_DEADLINE_MS
  void app.register(async (scope) => {
    // Whatever the content type says, the body is the raw message's bytes: the signature covers exactly these.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: EMAIL_INGRESS_BODY_MAX_BYTES },
      (_req, body, done) => done(null, body)
    )

    scope.post(EMAIL_INBOUND_PATH, { bodyLimit: EMAIL_INGRESS_BODY_MAX_BYTES }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const config = options.config()
      const now = (options.now ?? Date.now)()
      const post = config && VerifiedEmailPost.verify(config, raw, req.headers, now)
      // A bad or missing signature, and a relay that serves no mail, answer alike and say nothing more.
      if (!post) return reply.code(401).send()
      // A recipient on another domain, or one no bot holds, is rejected as an unknown address (§7).
      if (!post.agentAddress) return reply.code(200).send(emailReject(EMAIL_REJECT_REASONS.unknownAddress))
      const manager = deps.manager()
      const outcome = await settleWithin(
        manager
          ? manager.handleInbound(EMAIL_PLATFORM, raw, post, req.headers)
          : Promise.reject(new Error('no manager')),
        deadlineMs
      )
      if (outcome.kind !== 'handled') {
        deps.log.warn(`email ingress: handling ${outcome.kind} before an answer`)
        // The Worker fails the event on this, and the sender's server delivers the message again (§5.5).
        return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503 })
      }
      // No bot holds the address: an unknown one (§7), unless this relay's assignments are still arriving.
      if (!outcome.handled && !options.settling?.(now))
        return reply.code(200).send(emailReject(EMAIL_REJECT_REASONS.unknownAddress))
      if (!outcome.handled || outcome.handled.admission?.disposition === 'retry')
        return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503 })
      return reply.code(200).send(outcome.handled.syncResponse ?? emailAccepted)
    })
  })
}
