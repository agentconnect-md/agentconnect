import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMAIL_INBOUND_PATH,
  EMAIL_INGRESS_WINDOW_MS,
  WireEmailAdapterExt,
  type RcDeploymentConfig,
  type WireNormalizedMessage
} from '@agentconnect.md/protocol'
import { EMAIL_INBOUND_PER_HOUR } from './counters.js'
import { EMAIL_REJECT_REASONS } from './http-ingress.js'
import { EMAIL_ASSIGNMENT_SETTLE_MS, createEmailIngressPlugin, type EmailIngest } from './ingress-plugin.js'
import { openEmailTicket } from './ticket.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import type { RelayAdmission, RelayInboundSeam, RelayIngressHost } from '../contract.js'
import {
  AGENT_ADDRESS,
  COLLEAGUE,
  EMAIL_CONFIG,
  MAIL_DOMAIN,
  MEMBER,
  NOW,
  rawMail,
  signedHeaders,
  type SignedPostOptions
} from '../../../test/fixtures/email-messages.js'

const BOT = '22222222-2222-4222-8222-222222222222'
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const SNAPSHOT = { revision: 1, email: EMAIL_CONFIG } as unknown as RcDeploymentConfig
const ASSIGNMENT: BotAssignment = {
  botId: BOT,
  orgSlug: 'org-a',
  platform: 'email',
  secrets: {},
  apiAppId: AGENT_ADDRESS
} as BotAssignment

interface Harness {
  app: FastifyInstance
  forwarded: WireNormalizedMessage[]
  /** The verdict each forward gets; a test reassigns it. */
  verdict: () => Promise<RelayAdmission>
  clock: { at: number }
}

// The manager is faked: it demuxes by the plugin's hints and verifies as core does, with core's dedup table reduced to a set.
async function harness(
  options: { assign?: boolean; snapshot?: RcDeploymentConfig | undefined; deadlineMs?: number } = {}
): Promise<Harness> {
  const clock = { at: NOW }
  const plugin = createEmailIngressPlugin({
    now: () => clock.at,
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {})
  })
  const forwarded: WireNormalizedMessage[] = []
  const seen = new Set<string>()
  const h: Harness = { app: Fastify(), forwarded, verdict: async () => ({ disposition: 'admitted' }), clock }
  const host = {
    forwardStrict: async (_botId: string, message: WireNormalizedMessage) => {
      forwarded.push(message)
      return await h.verdict()
    },
    dedupPeek: (id: string | undefined) => id !== undefined && seen.has(id),
    dedupMark: (id: string | undefined) => void (id !== undefined && seen.add(id)),
    reportBotUserId: () => {},
    clock: { now: () => clock.at },
    log
  } as unknown as RelayIngressHost
  plugin.deploymentAssignments!('snapshot' in options ? options.snapshot : SNAPSHOT)
  const ingests = new Map<string, EmailIngest>()
  if (options.assign !== false) {
    const ingest = plugin.buildIngest(ASSIGNMENT, host)!
    ingests.set(ingest.address, ingest)
  }
  const seam: RelayInboundSeam = {
    handleInbound: async (_platformId, rawBody, body, headers) => {
      const appId = plugin.extractDemuxHints(rawBody, body, headers).appId
      const ingest = appId ? ingests.get(appId) : undefined
      const verified = ingest && (await plugin.verify(ingest, rawBody, body, headers, clock.at))
      return ingest && verified ? await plugin.handle(ingest, verified, host) : undefined
    }
  }
  plugin.installRoutes(h.app, { manager: () => seam, log })
  return h
}

const post = (h: Harness, raw: Buffer, signed: SignedPostOptions = {}, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: 'POST',
    url: EMAIL_INBOUND_PATH,
    headers: { ...signedHeaders(raw, signed), ...headers },
    payload: raw
  })

describe('email inbound route and relay plugin', () => {
  let h: Harness | undefined

  afterEach(async () => {
    await h?.app.close()
    h = undefined
  })

  it('admits a member mail, forwards it with a ticket for its thread and people, and answers accepted', async () => {
    h = await harness()
    const response = await post(h, rawMail({ cc: COLLEAGUE }))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ result: 'accepted' })
    expect(h.forwarded).toHaveLength(1)
    const message = h.forwarded[0]!
    expect(message).toMatchObject({ platform: 'email', isGroupDm: true, trigger: 'mention' })
    const ext = WireEmailAdapterExt.parse(message.adapterExt?.email)
    const key = Buffer.from(EMAIL_CONFIG.ticketKey, 'base64url')
    expect(openEmailTicket(key, BOT, ext.ticket!, [MEMBER, COLLEAGUE])).toEqual({
      threadKey: 'm1@corp.example.test',
      issuedAtMs: NOW
    })
    expect(openEmailTicket(key, BOT, ext.ticket!, [MEMBER])).toBeUndefined()
    expect(ext.tag).toBeUndefined()
  })

  it('passes the envelope recipient’s tag to the daemon only in a started thread’s shape (§5.1)', async () => {
    h = await harness()
    const tag = 'abcdefghijklmnopqrst'
    const tagged = await post(h, rawMail({ messageId: 'm-tag@corp.example.test' }), {
      envelopeTo: `helper+${tag}@${MAIL_DOMAIN}`
    })
    expect(tagged.json()).toEqual({ result: 'accepted' })
    expect(WireEmailAdapterExt.parse(h.forwarded[0]!.adapterExt?.email).tag).toBe(tag)
    // Any other tag still reaches the address, and names no thread.
    await post(h, rawMail({ messageId: 'm-list@corp.example.test' }), { envelopeTo: `helper+billing@${MAIL_DOMAIN}` })
    expect(h.forwarded).toHaveLength(2)
    expect(WireEmailAdapterExt.parse(h.forwarded[1]!.adapterExt?.email).tag).toBeUndefined()
  })

  it('answers 401 with an empty body for a missing, wrong or stale signature, and while no mail is configured', async () => {
    h = await harness()
    const raw = rawMail()
    const bad = [
      await h.app.inject({ method: 'POST', url: EMAIL_INBOUND_PATH, payload: raw }),
      await post(h, raw, { secret: 'another-secret-0123456789abcdef0123' }),
      await post(h, raw, { timestamp: NOW - EMAIL_INGRESS_WINDOW_MS - 1 }),
      await post(h, raw, { timestamp: NOW + EMAIL_INGRESS_WINDOW_MS + 1 }),
      // A signed header changed after signing.
      await post(h, raw, {}, { 'x-ac-email-to': encodeURIComponent(`other@${MAIL_DOMAIN}`) })
    ]
    for (const response of bad) {
      expect(response.statusCode).toBe(401)
      expect(response.body).toBe('')
    }
    expect((await post(h, raw, { timestamp: NOW - EMAIL_INGRESS_WINDOW_MS + 1_000 })).statusCode).toBe(200)
    await h.app.close()
    h = await harness({ snapshot: undefined })
    expect((await post(h, raw)).statusCode).toBe(401)
    expect(h.forwarded).toHaveLength(0)
  })

  it('rejects an envelope recipient off the mail domain or held by no bot, and finds the bot under a +tag', async () => {
    h = await harness()
    for (const envelopeTo of [`helper@other.example.test`, `nobody@${MAIL_DOMAIN}`]) {
      h.clock.at = NOW + EMAIL_ASSIGNMENT_SETTLE_MS
      const response = await post(h, rawMail(), { envelopeTo, timestamp: h.clock.at })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ result: 'reject', reason: EMAIL_REJECT_REASONS.unknownAddress })
    }
    expect(h.forwarded).toHaveLength(0)
    const tagged = await post(h, rawMail(), { envelopeTo: `Helper+invoices@${MAIL_DOMAIN}`, timestamp: h.clock.at })
    expect(tagged.json()).toEqual({ result: 'accepted' })
    expect(h.forwarded).toHaveLength(1)
  })

  it('answers an address no bot holds yet for a retry while assignments may still be arriving', async () => {
    h = await harness({ assign: false })
    expect((await post(h, rawMail())).statusCode).toBe(503)
    h.clock.at = NOW + EMAIL_ASSIGNMENT_SETTLE_MS
    const settled = await post(h, rawMail(), { timestamp: h.clock.at })
    expect(settled.json()).toEqual({ result: 'reject', reason: EMAIL_REJECT_REASONS.unknownAddress })
  })

  it('accepts and discards automatic mail without forwarding it', async () => {
    h = await harness()
    for (const raw of [
      rawMail({ headers: ['Auto-Submitted: auto-replied'] }),
      rawMail({ headers: ['Precedence: bulk'] }),
      rawMail({ headers: ['List-Id: <news.corp.example.test>'] })
    ])
      expect((await post(h, raw)).json()).toEqual({ result: 'accepted' })
    expect((await post(h, rawMail(), { envelopeFrom: '' })).json()).toEqual({ result: 'accepted' })
    expect(h.forwarded).toHaveLength(0)
  })

  it('rejects an unauthenticated sender, believing only the topmost Authentication-Results', async () => {
    h = await harness()
    const forgedBelow = rawMail({
      authentication: `${EMAIL_CONFIG.authservId}; dmarc=fail header.from=corp.example.test`,
      headers: [`Authentication-Results: ${EMAIL_CONFIG.authservId}; dmarc=pass header.from=corp.example.test`]
    })
    const forgedAbove = rawMail({
      authentication: `${EMAIL_CONFIG.authservId}; dmarc=pass header.from=corp.example.test`,
      headers: [`Authentication-Results: ${EMAIL_CONFIG.authservId}; dmarc=fail header.from=corp.example.test`]
    })
    for (const raw of [forgedBelow, rawMail({ authentication: null })])
      expect((await post(h, raw)).json()).toEqual({ result: 'reject', reason: EMAIL_REJECT_REASONS.unauthenticated })
    // Order decides: whatever is topmost is believed, which is why the provider prepending its own is listed in §9 to confirm live.
    expect((await post(h, forgedAbove)).json()).toEqual({ result: 'accepted' })
    expect(h.forwarded).toHaveLength(1)
  })

  it('rejects mail nothing could key or reply to', async () => {
    h = await harness()
    expect((await post(h, rawMail({ messageId: null }))).json()).toEqual({
      result: 'reject',
      reason: EMAIL_REJECT_REASONS.messageId
    })
    expect((await post(h, rawMail({ from: `${MEMBER}, eve@corp.example.test` }))).json()).toEqual({
      result: 'reject',
      reason: EMAIL_REJECT_REASONS.sender
    })
    expect(h.forwarded).toHaveLength(0)
  })

  it("rejects the daemon's refusal with the one step-3 sentence, and no agent behind the address as unknown", async () => {
    h = await harness()
    for (const reason of ['not_member', 'rejected', 'off'] as const) {
      h.verdict = async () => ({ disposition: 'rejected', reason })
      expect((await post(h, rawMail({ messageId: `${reason}@corp.example.test` }))).json()).toEqual({
        result: 'reject',
        reason: 'This address accepts mail from members of its organization'
      })
    }
    h.verdict = async () => ({ disposition: 'rejected', reason: 'no_agent' })
    expect((await post(h, rawMail({ messageId: 'none@corp.example.test' }))).json()).toEqual({
      result: 'reject',
      reason: EMAIL_REJECT_REASONS.unknownAddress
    })
  })

  it('answers 503 for a retryable refusal, a failure and a verdict that does not arrive in time', async () => {
    h = await harness({ deadlineMs: 50 })
    h.verdict = async () => ({ disposition: 'retry', reason: 'offline' })
    expect((await post(h, rawMail())).statusCode).toBe(503)
    h.verdict = async () => {
      throw new Error('link lost')
    }
    expect((await post(h, rawMail())).statusCode).toBe(503)
    h.verdict = () => new Promise(() => {})
    expect((await post(h, rawMail())).statusCode).toBe(503)
  })

  it('forwards a redelivery of a refused or timed-out attempt again, and settles one of an admitted message', async () => {
    h = await harness()
    h.verdict = async () => ({ disposition: 'retry', reason: 'offline' })
    expect((await post(h, rawMail())).statusCode).toBe(503)
    h.verdict = async () => ({ disposition: 'admitted' })
    expect((await post(h, rawMail())).json()).toEqual({ result: 'accepted' })
    expect(h.forwarded).toHaveLength(2)
    // The sender's server delivers it again; nothing is forwarded, and the answer is still accepted.
    expect((await post(h, rawMail())).json()).toEqual({ result: 'accepted' })
    expect(h.forwarded).toHaveLength(2)
    expect(h.forwarded[1]!.msgId).toBe(h.forwarded[0]!.msgId)
  })

  it('rejects a sender over the hourly limit, counting settled messages only', async () => {
    h = await harness()
    h.verdict = async () => ({ disposition: 'retry', reason: 'offline' })
    for (let i = 0; i < EMAIL_INBOUND_PER_HOUR + 5; i += 1)
      expect((await post(h, rawMail({ messageId: `r${i}@corp.example.test` }))).statusCode).toBe(503)
    h.verdict = async () => ({ disposition: 'admitted' })
    for (let i = 0; i < EMAIL_INBOUND_PER_HOUR; i += 1)
      expect((await post(h, rawMail({ messageId: `a${i}@corp.example.test` }))).json()).toEqual({
        result: 'accepted'
      })
    expect((await post(h, rawMail({ messageId: 'over@corp.example.test' }))).json()).toEqual({
      result: 'reject',
      reason: EMAIL_REJECT_REASONS.rateLimited
    })
  })
})
