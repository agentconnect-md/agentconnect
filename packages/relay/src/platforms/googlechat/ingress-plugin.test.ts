import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SignJWT } from 'jose'
import type { WireNormalizedMessage } from '@agentconnect.md/protocol'
import { createGoogleChatIngressPlugin, type GoogleChatIngressPlugin } from './ingress-plugin.js'
import type { GoogleChatHttpIngest } from './http-ingest.js'
import { GOOGLE_CHAT_CERTIFICATE_REFETCH_MS, GOOGLE_CHAT_CERTIFICATE_URL, GOOGLE_CHAT_TOKEN_ISSUER } from './token.js'
import type { RelayAdmission, RelayIngressHost } from '../contract.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import { selfSignedCertificatePem } from '../../../test/fixtures/google-chat-certificate.js'
import {
  APP,
  AUDIENCE,
  DM,
  OTHER_APP,
  SPACE,
  dmAdded,
  dmMessage,
  spaceAddedByMention,
  spaceMention,
  spaceRemoved
} from '../../../test/fixtures/google-chat-events.js'

const NOW = Date.UTC(2026, 8, 27, 4, 30, 0)
const BOT_ID = '11111111-1111-4111-8111-111111111111'
const KID = 'kid-2026-09'
const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
const OTHER_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
const CERTIFICATE = selfSignedCertificatePem(KEYS.privateKey)

/** Google's certificate endpoint: one JSON map, recorded per fetch, rotatable between fetches. */
function fakeCertificates(map: Record<string, string> = { [KID]: CERTIFICATE }, headers: Record<string, string> = {}) {
  const calls: string[] = []
  let current = map
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url !== GOOGLE_CHAT_CERTIFICATE_URL) throw new Error(`unexpected request to ${url}`)
    return Response.json(current, { headers })
  }) as typeof fetch
  return {
    fetchImpl,
    calls,
    rotate(next: Record<string, string>) {
      current = next
    }
  }
}

interface TokenOver {
  aud?: string
  iss?: string
  iat?: number
  exp?: number
  kid?: string
  alg?: 'RS256' | 'RS512'
  key?: KeyObject
}

// A token shaped like Google's: RS256, `kid`, the Chat issuer, the project number, one hour of life.
async function token(over: TokenOver = {}): Promise<string> {
  const iat = over.iat ?? Math.floor(NOW / 1000) - 5
  return new SignJWT({})
    .setProtectedHeader({ alg: over.alg ?? 'RS256', typ: 'JWT', kid: over.kid ?? KID })
    .setIssuer(over.iss ?? GOOGLE_CHAT_TOKEN_ISSUER)
    .setAudience(over.aud ?? AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(over.exp ?? iat + 3600)
    .sign(over.key ?? KEYS.privateKey)
}

const host = (over: Partial<RelayIngressHost> = {}): RelayIngressHost => ({
  forward: vi.fn(async () => 'accepted' as const),
  forwardStrict: vi.fn(async (): Promise<RelayAdmission> => ({ disposition: 'admitted' })),
  forwardAction: vi.fn(async (msg) => ({ msgId: msg.msgId, accepted: true })),
  reportChannels: vi.fn(),
  reportRevoked: vi.fn(),
  reportCredentialCheck: vi.fn(),
  credentialCheckSupported: () => true,
  directory: {
    agents: () => [],
    channelOwner: () => undefined,
    targetForAgentId: () => undefined,
    resolveTarget: () => undefined,
    resolveBoundTarget: async () => undefined,
    conversationParticipants: () => [],
    targetForAgent: () => undefined,
    integrationTarget: () => undefined,
    soleTarget: () => undefined
  },
  canDeliver: () => true,
  dedupSeen: vi.fn(() => false),
  dedupPeek: vi.fn(() => false),
  dedupMark: vi.fn(),
  setChannelAgent: () => {},
  selectThreadAgent: () => {},
  reportBotUserId: vi.fn(),
  clock: { now: () => NOW },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...over
})

// The shape `toBotAssignment` produces for a Google Chat bot: no secret, the project number as the audience.
const assignment = (over: Partial<BotAssignment> = {}): BotAssignment => ({
  botId: BOT_ID,
  platform: 'googlechat',
  secrets: {},
  apiAppId: AUDIENCE,
  credentialRevision: 3,
  members: [],
  agents: [],
  routes: [],
  ...over
})

function setup(over: Partial<BotAssignment> = {}, certificates = fakeCertificates()) {
  const plugin = createGoogleChatIngressPlugin({ fetch: certificates.fetchImpl })
  const h = host()
  const ingest = plugin.buildIngest(assignment(over), h)!
  return { plugin, h, ingest, certificates }
}

async function deliver(
  plugin: GoogleChatIngressPlugin,
  ingest: GoogleChatHttpIngest,
  h: RelayIngressHost,
  event: unknown,
  authorization: string | undefined,
  now = NOW
) {
  const raw = Buffer.from(JSON.stringify(event))
  const headers = authorization === undefined ? {} : { authorization }
  const verified = await plugin.verify(ingest, raw, event, headers, now)
  if (!verified) return { verified, handled: undefined }
  return { verified, handled: await plugin.handle(ingest, verified, h) }
}

const forwarded = (h: RelayIngressHost): WireNormalizedMessage | undefined =>
  vi.mocked(h.forwardStrict).mock.calls[0]?.[1]

// A Space message naming two apps: Google's data cannot say which one is this app.
const twoAppMention = {
  ...spaceMention,
  message: {
    ...spaceMention.message,
    text: '@AgentConnect Probe @Other 第二条',
    annotations: [
      ...(spaceMention.message?.annotations ?? []),
      {
        type: 'USER_MENTION',
        startIndex: 20,
        length: 6,
        userMention: { user: { name: OTHER_APP, displayName: 'Other', type: 'BOT' }, type: 'MENTION' }
      }
    ]
  }
}

describe('googlechat ingress plugin — bearer-token verification (§2)', () => {
  it('accepts a token Google signed for this project number and forwards the message', async () => {
    const { plugin, h, ingest, certificates } = setup()
    const { verified, handled } = await deliver(plugin, ingest, h, dmMessage, `Bearer ${await token()}`)
    expect(verified).toMatchObject({ event: { type: 'MESSAGE' } })
    expect(handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(forwarded(h)).toMatchObject({
      platform: 'googlechat',
      msgId: `googlechat:${DM}:${DM}/messages/EXAMPLE_THREAD_1.EXAMPLE_MSG_ROOT`,
      channel: DM,
      isDm: true,
      text: 'hi'
    })
    expect(certificates.calls).toEqual([GOOGLE_CHAT_CERTIFICATE_URL])
  })

  it('refuses another audience, another issuer, an expired token, a non-RS256 token, and an unpublished key', async () => {
    const { plugin, h, ingest } = setup()
    const nowSec = Math.floor(NOW / 1000)
    const forged = [
      token({ aud: '200000000000' }),
      token({ iss: 'someone-else@example.test' }),
      token({ iat: nowSec - 7200, exp: nowSec - 120 }),
      token({ alg: 'RS512' }),
      token({ key: OTHER_KEYS.privateKey })
    ]
    for (const t of forged) {
      expect((await deliver(plugin, ingest, h, dmMessage, `Bearer ${await t}`)).verified).toBeUndefined()
    }
    expect(h.forwardStrict).not.toHaveBeenCalled()
  })

  it('verifies nothing without a bearer token, and lets a minute of skew pass', async () => {
    const { plugin, h, ingest } = setup()
    expect((await deliver(plugin, ingest, h, dmMessage, undefined)).verified).toBeUndefined()
    expect((await deliver(plugin, ingest, h, dmMessage, 'Basic abc')).verified).toBeUndefined()
    expect((await deliver(plugin, ingest, h, dmMessage, 'Bearer not.a.jwt')).verified).toBeUndefined()
    const nowSec = Math.floor(NOW / 1000)
    const justExpired = await token({ iat: nowSec - 3630, exp: nowSec - 30 })
    expect((await deliver(plugin, ingest, h, dmMessage, `Bearer ${justExpired}`)).verified).toBeDefined()
  })

  it('refetches the certificate map once for an unknown kid, and not again within the spacing', async () => {
    const { plugin, h, ingest, certificates } = setup()
    expect((await deliver(plugin, ingest, h, dmMessage, `Bearer ${await token()}`)).verified).toBeDefined()
    expect(certificates.calls).toHaveLength(1)

    // Google rotated: the new kid is served after exactly one refetch.
    certificates.rotate({ 'kid-next': CERTIFICATE })
    const rotated = await token({ kid: 'kid-next' })
    expect((await deliver(plugin, ingest, h, dmMessage, `Bearer ${rotated}`)).verified).toBeDefined()
    expect(certificates.calls).toHaveLength(2)

    // A forged kid inside the spacing cannot make the relay fetch again.
    const forged = await token({ kid: 'kid-forged' })
    expect((await deliver(plugin, ingest, h, dmMessage, `Bearer ${forged}`)).verified).toBeUndefined()
    expect(certificates.calls).toHaveLength(2)
    const later = NOW + GOOGLE_CHAT_CERTIFICATE_REFETCH_MS
    expect((await deliver(plugin, ingest, h, dmMessage, `Bearer ${forged}`, later)).verified).toBeUndefined()
    expect(certificates.calls).toHaveLength(3)
  })

  it("honors the response's max-age and falls back to the fixed TTL without one", async () => {
    const capped = setup({}, fakeCertificates({ [KID]: CERTIFICATE }, { 'cache-control': 'public, max-age=120' }))
    await deliver(capped.plugin, capped.ingest, capped.h, dmMessage, `Bearer ${await token()}`)
    const t = await token({ iat: Math.floor(NOW / 1000) + 100 })
    await deliver(capped.plugin, capped.ingest, capped.h, dmMessage, `Bearer ${t}`, NOW + 121_000)
    expect(capped.certificates.calls).toHaveLength(2)

    const fixed = setup()
    await deliver(fixed.plugin, fixed.ingest, fixed.h, dmMessage, `Bearer ${await token()}`)
    await deliver(fixed.plugin, fixed.ingest, fixed.h, dmMessage, `Bearer ${t}`, NOW + 121_000)
    expect(fixed.certificates.calls).toHaveLength(1)
  })

  it('demuxes on the unverified audience alone', async () => {
    const plugin = createGoogleChatIngressPlugin({ fetch: fakeCertificates().fetchImpl })
    const raw = Buffer.from('{}')
    expect(plugin.extractDemuxHints(raw, {}, { authorization: `Bearer ${await token()}` })).toEqual({ appId: AUDIENCE })
    expect(plugin.extractDemuxHints(raw, {}, {})).toEqual({})
    expect(plugin.extractDemuxHints(raw, {}, { authorization: 'Bearer not.a.jwt' })).toEqual({})
  })

  it('refuses an assignment without the project number, or one that carries a secret', () => {
    const plugin = createGoogleChatIngressPlugin({ fetch: fakeCertificates().fetchImpl })
    const h = host()
    expect(plugin.buildIngest(assignment({ apiAppId: undefined }), h)).toBeUndefined()
    expect(plugin.buildIngest(assignment({ secrets: { signingSecret: 'x' } }), h)).toBeUndefined()
    expect(h.log.warn).toHaveBeenCalledTimes(2)
  })
})

describe('googlechat ingress plugin — dispositions and dedup (§4)', () => {
  const MSG_ID = `googlechat:${DM}:${DM}/messages/EXAMPLE_THREAD_1.EXAMPLE_MSG_ROOT`

  it('marks the identity after an admitted or rejected verdict, never after a retry', async () => {
    for (const admission of [
      { disposition: 'admitted' },
      { disposition: 'rejected', reason: 'muted' },
      { disposition: 'retry', reason: 'draining' }
    ] as RelayAdmission[]) {
      const { plugin, h, ingest } = setup()
      vi.mocked(h.forwardStrict).mockResolvedValue(admission)
      const { handled } = await deliver(plugin, ingest, h, dmMessage, `Bearer ${await token()}`)
      expect(handled).toEqual({ admission })
      if (admission.disposition === 'retry') expect(h.dedupMark).not.toHaveBeenCalled()
      else expect(h.dedupMark).toHaveBeenCalledWith(MSG_ID)
      expect(h.dedupSeen).not.toHaveBeenCalled()
    }
  })

  it('answers a settled repeat without forwarding it', async () => {
    const { plugin, h, ingest } = setup()
    vi.mocked(h.dedupPeek).mockReturnValue(true)
    const { handled } = await deliver(plugin, ingest, h, dmMessage, `Bearer ${await token()}`)
    expect(handled).toEqual({})
    expect(h.dedupPeek).toHaveBeenCalledWith(MSG_ID)
    expect(h.forwardStrict).not.toHaveBeenCalled()
    expect(h.dedupMark).not.toHaveBeenCalled()
  })

  it('settles an ignored or unsupported event with a mark and no forward', async () => {
    const { plugin, h, ingest } = setup()
    const appAuthored = {
      ...dmMessage,
      message: { ...dmMessage.message, sender: { name: APP, displayName: 'Probe', type: 'BOT' } }
    }
    expect((await deliver(plugin, ingest, h, appAuthored, `Bearer ${await token()}`)).handled).toEqual({})
    expect(h.dedupMark).toHaveBeenCalledWith(MSG_ID)
    const groupDm = { ...dmMessage, space: { ...dmMessage.space, spaceType: 'GROUP_CHAT' } }
    expect((await deliver(plugin, ingest, h, groupDm, `Bearer ${await token()}`)).handled).toEqual({})
    expect(h.forwardStrict).not.toHaveBeenCalled()
  })

  it('drops a permanently malformed event with a 200 and a log line, forwarding and marking nothing', async () => {
    const { plugin, h, ingest } = setup()
    const crossSpace = {
      ...dmMessage,
      message: { ...dmMessage.message, name: `${SPACE}/messages/EXAMPLE_ELSEWHERE` }
    }
    expect((await deliver(plugin, ingest, h, crossSpace, `Bearer ${await token()}`)).handled).toEqual({})
    expect(h.forwardStrict).not.toHaveBeenCalled()
    expect(h.dedupMark).not.toHaveBeenCalled()
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('cross_space'))
  })
})

describe('googlechat ingress plugin — observed membership (§4)', () => {
  it('reports a DM add as an im row and starts no turn', async () => {
    const { plugin, h, ingest } = setup()
    expect((await deliver(plugin, ingest, h, dmAdded, `Bearer ${await token()}`)).handled).toEqual({})
    expect(h.reportChannels).toHaveBeenCalledWith({ botId: BOT_ID, channels: [{ id: DM, kind: 'im' }] })
    expect(h.forwardStrict).not.toHaveBeenCalled()
  })

  it('reports a Space add with its display name, forwards the message that added the app, then drops the row on removal', async () => {
    const { plugin, h, ingest } = setup()
    const { handled } = await deliver(plugin, ingest, h, spaceAddedByMention, `Bearer ${await token()}`)
    expect(handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(h.reportChannels).toHaveBeenLastCalledWith({
      botId: BOT_ID,
      channels: [{ id: SPACE, name: 'Example Space', kind: 'channel' }]
    })
    expect(forwarded(h)).toMatchObject({ channel: SPACE, thread: `${SPACE}/threads/EXAMPLE_THREAD_2`, text: 'hello' })

    expect((await deliver(plugin, ingest, h, spaceRemoved, `Bearer ${await token()}`)).handled).toEqual({})
    expect(h.reportChannels).toHaveBeenLastCalledWith({ botId: BOT_ID, channels: [] })
    expect(h.forwardStrict).toHaveBeenCalledTimes(1)
  })
})

describe('googlechat ingress plugin — the app identity (§3)', () => {
  it('learns the identity from the ADD annotation and keeps using it', async () => {
    const { plugin, h, ingest } = setup()
    await deliver(plugin, ingest, h, spaceAddedByMention, `Bearer ${await token()}`)
    expect(h.reportBotUserId).toHaveBeenCalledWith(BOT_ID, APP)
    expect(forwarded(h)).toMatchObject({ text: 'hello', mentionedBots: [APP] })

    await deliver(plugin, ingest, h, spaceMention, `Bearer ${await token()}`)
    expect(vi.mocked(h.forwardStrict).mock.calls[1]?.[1]).toMatchObject({ text: '第二条', mentionedBots: [APP] })
    expect(h.reportBotUserId).toHaveBeenCalledTimes(1)
    expect(h.log.warn).not.toHaveBeenCalled()
  })

  it('learns the identity from a Space message that mentions exactly one app', async () => {
    const { plugin, h, ingest } = setup()
    await deliver(plugin, ingest, h, spaceMention, `Bearer ${await token()}`)
    expect(h.reportBotUserId).toHaveBeenCalledWith(BOT_ID, APP)
    expect(forwarded(h)).toMatchObject({ text: '第二条', mentionedBots: [APP] })
  })

  it("prefers the assignment's identity over what an annotation names", async () => {
    const { plugin, h, ingest } = setup({ botUserId: OTHER_APP })
    await deliver(plugin, ingest, h, spaceMention, `Bearer ${await token()}`)
    expect(h.reportBotUserId).not.toHaveBeenCalled()
    expect(forwarded(h)).toMatchObject({ text: '@AgentConnect Probe  第二条', mentionedBots: [] })
  })

  it('forwards unstripped, warning once, while the identity cannot be known', async () => {
    const { plugin, h, ingest } = setup()
    await deliver(plugin, ingest, h, twoAppMention, `Bearer ${await token()}`)
    await deliver(plugin, ingest, h, dmMessage, `Bearer ${await token()}`)
    expect(h.reportBotUserId).not.toHaveBeenCalled()
    expect(forwarded(h)).toMatchObject({ text: '@AgentConnect Probe @Other 第二条', mentionedBots: [] })
    expect(vi.mocked(h.forwardStrict).mock.calls[1]?.[1]).toMatchObject({ text: 'hi', isDm: true })
    expect(vi.mocked(h.log.warn).mock.calls.filter(([m]) => m.includes('identity'))).toHaveLength(1)
  })
})

describe('googlechat ingress plugin — the trusted activation cause', () => {
  it('stamps a DM as a DM and every Space delivery as a mention, before and after the identity is known', async () => {
    const { plugin, h, ingest } = setup()
    const bearer = `Bearer ${await token()}`
    await deliver(plugin, ingest, h, dmMessage, bearer)
    await deliver(plugin, ingest, h, twoAppMention, bearer)
    await deliver(plugin, ingest, h, spaceAddedByMention, bearer)
    await deliver(plugin, ingest, h, spaceMention, bearer)
    const forwardedMessages = vi.mocked(h.forwardStrict).mock.calls.map(([, message]) => message)
    expect(forwardedMessages.map((message) => message.trigger)).toEqual(['dm', 'mention', 'mention', 'mention'])
    // The second Space delivery was stamped although nothing named this app yet.
    expect(forwardedMessages[1]).toMatchObject({ isDm: false, mentionedBots: [] })
  })
})
