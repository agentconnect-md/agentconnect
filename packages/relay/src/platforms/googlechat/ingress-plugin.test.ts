import { describe, expect, it, vi } from 'vitest'
import type { WireNormalizedMessage } from '@agentconnect.md/protocol'
import { createGoogleChatIngressPlugin, type GoogleChatIngressPlugin } from './ingress-plugin.js'
import { GOOGLE_CHAT_WELCOME_CARD, type GoogleChatHttpIngest } from './http-ingest.js'
import { GOOGLE_CHAT_CERTIFICATE_REFETCH_MS, GOOGLE_CHAT_CERTIFICATE_URL } from './token.js'
import type { RelayAdmission, RelayIngressHost } from '../contract.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import { CERTIFICATE, KID, NOW, OTHER_KEYS, fakeCertificates, token } from '../../../test/fixtures/google-chat-token.js'
import {
  APP,
  AUDIENCE,
  CUSTOMER,
  DM,
  DOMAIN,
  OTHER_APP,
  PERSON,
  SPACE,
  cardClicked,
  dmAdded,
  dmMessage,
  spaceAddedByMention,
  spaceMention,
  spaceRemoved
} from '../../../test/fixtures/google-chat-events.js'

const BOT_ID = '11111111-1111-4111-8111-111111111111'

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

  it('demuxes on the unverified audience; a body naming no tenant adds no second hint', async () => {
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
  // The relay's key carries the bot; the forwarded message's own `msgId` stays the bare Google identity.
  const DEDUP_KEY = `${BOT_ID}\0${MSG_ID}`

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
      else expect(h.dedupMark).toHaveBeenCalledWith(DEDUP_KEY)
      expect(h.dedupSeen).not.toHaveBeenCalled()
    }
  })

  it('answers a settled repeat without forwarding it', async () => {
    const { plugin, h, ingest } = setup()
    vi.mocked(h.dedupPeek).mockReturnValue(true)
    const { handled } = await deliver(plugin, ingest, h, dmMessage, `Bearer ${await token()}`)
    expect(handled).toEqual({})
    expect(h.dedupPeek).toHaveBeenCalledWith(DEDUP_KEY)
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
    expect(h.dedupMark).toHaveBeenCalledWith(DEDUP_KEY)
    const groupDm = { ...dmMessage, space: { ...dmMessage.space, spaceType: 'GROUP_CHAT' } }
    expect((await deliver(plugin, ingest, h, groupDm, `Bearer ${await token()}`)).handled).toEqual({})
    expect(h.forwardStrict).not.toHaveBeenCalled()
  })

  it('forwards a message to each of two apps it mentions, since the shared table is keyed by bot', async () => {
    // One Space message mentioning two installed apps reaches the relay once per app, each with its own audience.
    const OTHER_BOT = '22222222-2222-4222-8222-222222222222'
    const settled = new Set<string>()
    const h = host({
      dedupPeek: vi.fn((id?: string) => id !== undefined && settled.has(id)),
      dedupMark: vi.fn((id?: string) => {
        if (id !== undefined) settled.add(id)
      })
    })
    const certificates = fakeCertificates()
    const plugin = createGoogleChatIngressPlugin({ fetch: certificates.fetchImpl })
    const first = plugin.buildIngest(assignment(), h)!
    const second = plugin.buildIngest(assignment({ botId: OTHER_BOT, apiAppId: '200000000002' }), h)!
    expect((await deliver(plugin, first, h, dmMessage, `Bearer ${await token()}`)).handled).toEqual({
      admission: { disposition: 'admitted' }
    })
    expect(
      (await deliver(plugin, second, h, dmMessage, `Bearer ${await token({ aud: '200000000002' })}`)).handled
    ).toEqual({
      admission: { disposition: 'admitted' }
    })
    expect(h.forwardStrict).toHaveBeenCalledTimes(2)
    expect(vi.mocked(h.forwardStrict).mock.calls.map(([botId, msg]) => [botId, msg.msgId])).toEqual([
      [BOT_ID, MSG_ID],
      [OTHER_BOT, MSG_ID]
    ])
    expect([...settled]).toEqual([DEDUP_KEY, `${OTHER_BOT}\0${MSG_ID}`])
    // The same app's repeat is still settled.
    expect((await deliver(plugin, first, h, dmMessage, `Bearer ${await token()}`)).handled).toEqual({})
    expect(h.forwardStrict).toHaveBeenCalledTimes(2)
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

describe('googlechat ingress plugin — a multi-tenant app’s anchor and customer rows (§10.4)', () => {
  const CLAIM_URL = 'https://console.example.test/googlechat/claim'
  const REDIRECT = 'https://chat.example.test/config-complete?token=REDACTED'
  const prompt = (syncResponse: unknown) => {
    const body = syncResponse as { actionResponse?: { type?: string; url?: string } } | undefined
    expect(body?.actionResponse?.type).toBe('REQUEST_CONFIG')
    const url = new URL(body!.actionResponse!.url!)
    return {
      base: `${url.origin}${url.pathname}`,
      state: JSON.parse(Buffer.from(url.searchParams.get('state')!, 'base64url').toString('utf8')) as unknown
    }
  }
  const anchor = () => setup({ claimUrl: CLAIM_URL })

  it('answers an unclaimed tenant in the body and forwards, reports, peeks, and marks nothing', async () => {
    const { plugin, h, ingest } = anchor()
    const bearer = `Bearer ${await token()}`
    // An add, with or without its triggering message, gets the welcome card.
    expect((await deliver(plugin, ingest, h, dmAdded, bearer)).handled).toEqual({
      syncResponse: GOOGLE_CHAT_WELCOME_CARD
    })
    expect((await deliver(plugin, ingest, h, spaceAddedByMention, bearer)).handled).toEqual({
      syncResponse: GOOGLE_CHAT_WELCOME_CARD
    })
    // A message gets the claim prompt, whose state carries the contract's fields and nothing else.
    const dm = await deliver(plugin, ingest, h, dmMessage, bearer)
    expect(dm.handled?.admission).toBeUndefined()
    const decoded = prompt(dm.handled?.syncResponse)
    expect(decoded.base).toBe(CLAIM_URL)
    expect(decoded.state).toEqual({
      v: 1,
      app: AUDIENCE,
      space: DM,
      user: PERSON,
      kind: 'dm',
      tenant: DOMAIN,
      redirect: REDIRECT,
      iat: Math.floor(NOW / 1000)
    })
    const space = prompt((await deliver(plugin, ingest, h, spaceMention, bearer)).handled?.syncResponse)
    expect(space.state).toMatchObject({ space: SPACE, user: PERSON, kind: 'space', tenant: CUSTOMER })
    // The welcome card's own button gets the prompt too; any other card function gets nothing.
    const click = prompt((await deliver(plugin, ingest, h, cardClicked, bearer)).handled?.syncResponse)
    expect(click.state).toMatchObject({ space: SPACE, user: PERSON, kind: 'space', tenant: CUSTOMER })
    const otherClick = { ...cardClicked, action: { actionMethodName: 'other.function' }, common: undefined }
    expect((await deliver(plugin, ingest, h, otherClick, bearer)).handled).toEqual({})
    // A removal is nothing to answer; an event without a return URL omits `redirect`.
    expect((await deliver(plugin, ingest, h, spaceRemoved, bearer)).handled).toEqual({})
    const noRedirect = { ...dmMessage, configCompleteRedirectUrl: undefined }
    expect(
      prompt((await deliver(plugin, ingest, h, noRedirect, bearer)).handled?.syncResponse).state
    ).not.toHaveProperty('redirect')
    // Nothing left the relay and nothing was settled: no forward, no membership report, no dedup read or mark.
    expect(h.forwardStrict).not.toHaveBeenCalled()
    expect(h.forward).not.toHaveBeenCalled()
    expect(h.reportChannels).not.toHaveBeenCalled()
    expect(h.dedupPeek).not.toHaveBeenCalled()
    expect(h.dedupMark).not.toHaveBeenCalled()
  })

  it('answers nothing for an unclaimed event without a Workspace tenant, and still drops what it cannot classify', async () => {
    const { plugin, h, ingest } = anchor()
    const bearer = `Bearer ${await token()}`
    const personal = { ...dmMessage, user: { ...dmMessage.user, domainId: undefined } }
    expect((await deliver(plugin, ingest, h, personal, bearer)).handled).toEqual({})
    const noCustomer = { ...spaceMention, space: { ...spaceMention.space, customer: undefined } }
    expect((await deliver(plugin, ingest, h, noCustomer, bearer)).handled).toEqual({})
    const appAuthored = { ...dmMessage, message: { ...dmMessage.message, sender: { name: APP, type: 'BOT' } } }
    expect((await deliver(plugin, ingest, h, appAuthored, bearer)).handled).toEqual({})
    const crossSpace = { ...dmMessage, message: { ...dmMessage.message, name: `${SPACE}/messages/ELSEWHERE` } }
    expect((await deliver(plugin, ingest, h, crossSpace, bearer)).handled).toEqual({})
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('cross_space'))
    expect(h.forwardStrict).not.toHaveBeenCalled()
    expect(h.dedupMark).not.toHaveBeenCalled()
    expect(h.log.info).not.toHaveBeenCalled()
  })

  it('notes an unclaimed tenant once a minute however chatty it is, and always answers the prompt', async () => {
    let now = NOW
    const certificates = fakeCertificates()
    const plugin = createGoogleChatIngressPlugin({ fetch: certificates.fetchImpl })
    const h = host({ clock: { now: () => now } })
    const ingest = plugin.buildIngest(assignment({ claimUrl: CLAIM_URL }), h)!
    const bearer = `Bearer ${await token()}`
    const noted = () => vi.mocked(h.log.info).mock.calls.filter(([m]) => m.includes('unclaimed')).length
    for (let i = 0; i < 3; i++) {
      expect((await deliver(plugin, ingest, h, dmMessage, bearer)).handled?.syncResponse).toBeDefined()
    }
    expect(noted()).toBe(1)
    // Another tenant is its own line; the first one is noted again once the window has passed.
    await deliver(plugin, ingest, h, spaceMention, bearer)
    expect(noted()).toBe(2)
    now = NOW + 59_000
    await deliver(plugin, ingest, h, dmMessage, bearer, now)
    expect(noted()).toBe(2)
    now = NOW + 60_000
    const later = await deliver(plugin, ingest, h, dmMessage, bearer, now)
    expect(noted()).toBe(3)
    expect(prompt(later.handled?.syncResponse).state).toMatchObject({ iat: Math.floor(now / 1000) })
  })

  it('routes a customer row exactly as a single-tenant row, where the welcome card’s click has nothing left to do', async () => {
    const { plugin, h, ingest } = setup({ tenantIds: [DOMAIN, CUSTOMER] })
    const bearer = `Bearer ${await token()}`
    expect((await deliver(plugin, ingest, h, dmMessage, bearer)).handled).toEqual({
      admission: { disposition: 'admitted' }
    })
    expect(forwarded(h)).toMatchObject({ channel: DM, text: 'hi', trigger: 'dm' })
    expect(h.dedupMark).toHaveBeenCalledWith(
      `${BOT_ID}\0googlechat:${DM}:${DM}/messages/EXAMPLE_THREAD_1.EXAMPLE_MSG_ROOT`
    )
    expect((await deliver(plugin, ingest, h, cardClicked, bearer)).handled).toEqual({})
    expect(h.forwardStrict).toHaveBeenCalledTimes(1)
    expect(h.dedupMark).toHaveBeenCalledTimes(1)
    // The row keeps what it was assigned, for core's composite index and fence.
    expect(ingest.tenantIds).toEqual([DOMAIN, CUSTOMER])
    expect(ingest.claimUrl).toBeUndefined()
  })

  it('a single-tenant anchor, with no claim page, still routes every event, including one naming no tenant', async () => {
    const { plugin, h, ingest } = setup()
    const bearer = `Bearer ${await token()}`
    const personal = { ...dmMessage, user: { ...dmMessage.user, domainId: undefined } }
    expect((await deliver(plugin, ingest, h, personal, bearer)).handled).toEqual({
      admission: { disposition: 'admitted' }
    })
    expect((await deliver(plugin, ingest, h, spaceMention, bearer)).handled).toEqual({
      admission: { disposition: 'admitted' }
    })
    expect(h.forwardStrict).toHaveBeenCalledTimes(2)
    expect((await deliver(plugin, ingest, h, cardClicked, bearer)).handled).toEqual({})
  })

  it("supplies the event's tenant key as the demux hint: the Space's customer, the DM sender's domain, never a Space sender's domain", async () => {
    const plugin = createGoogleChatIngressPlugin({ fetch: fakeCertificates().fetchImpl })
    const headers = { authorization: `Bearer ${await token()}` }
    const raw = Buffer.from('{}')
    expect(plugin.extractDemuxHints(raw, dmMessage, headers)).toEqual({ appId: AUDIENCE, tenantId: DOMAIN })
    expect(plugin.extractDemuxHints(raw, spaceMention, headers)).toEqual({ appId: AUDIENCE, tenantId: CUSTOMER })
    expect(plugin.extractDemuxHints(raw, cardClicked, headers)).toEqual({ appId: AUDIENCE, tenantId: CUSTOMER })
    const noCustomer = { ...spaceMention, space: { ...spaceMention.space, customer: undefined } }
    expect(plugin.extractDemuxHints(raw, noCustomer, headers)).toEqual({ appId: AUDIENCE })
    expect(plugin.extractDemuxHints(raw, dmMessage, {})).toEqual({ tenantId: DOMAIN })
  })

  it('refuses a row that is both a customer and the anchor', () => {
    const plugin = createGoogleChatIngressPlugin({ fetch: fakeCertificates().fetchImpl })
    const h = host()
    expect(plugin.buildIngest(assignment({ tenantIds: [CUSTOMER], claimUrl: CLAIM_URL }), h)).toBeUndefined()
    expect(h.log.warn).toHaveBeenCalledTimes(1)
    expect(plugin.buildIngest(assignment({ claimUrl: CLAIM_URL }), h)?.claimUrl).toBe(CLAIM_URL)
    expect(plugin.buildIngest(assignment({ tenantIds: [CUSTOMER] }), h)?.tenantIds).toEqual([CUSTOMER])
  })
})
