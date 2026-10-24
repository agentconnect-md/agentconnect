import { afterEach, describe, expect, it, vi } from 'vitest'
import { WireMsTeamsCardAction, type RdMsgPlatformAction, type WireNormalizedMessage } from '@agentconnect.md/protocol'
import {
  MSTEAMS_CARD_ACTION_FORWARD_TIMEOUT_MS,
  MSTEAMS_CLICK_NOTES,
  createMsTeamsIngressPlugin,
  type MsTeamsIngressPlugin
} from './ingress-plugin.js'
import type { MsTeamsHttpIngest } from './http-ingest.js'
import { BOT_FRAMEWORK_OPENID_CONFIG_URL, MSTEAMS_KEYS_REFETCH_MS } from './token.js'
import type { RelayAdmission, RelayIngressHost } from '../contract.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import { JWK, KEYS_URL, NOW, OTHER_KEYS, bearer, fakeBotFramework } from '../../../test/fixtures/msteams-token.js'
import {
  AAD_USER,
  BOT_ID,
  APP_ID,
  CARD_ACTIVITY,
  CHANNEL,
  GROUP_CHAT,
  OTHER_APP_ID,
  PERSONAL,
  ROOT,
  SERVICE_URL,
  TEAM,
  TENANT,
  USER,
  cardClick,
  channelMention,
  channelReply,
  conversationUpdate,
  edit,
  groupText,
  personalText
} from '../../../test/fixtures/msteams-activities.js'

const BOT_ROW = '11111111-1111-4111-8111-111111111111'
const OTHER_CHAT = '19:example-other-chat@thread.v2'
const TARGET = {
  agentId: '22222222-2222-4222-8222-222222222222',
  integrationId: '33333333-3333-4333-8333-333333333333',
  daemonId: '44444444-4444-4444-8444-444444444444'
}

const host = (over: Partial<RelayIngressHost> = {}): RelayIngressHost => ({
  forward: vi.fn(async () => 'accepted' as const),
  forwardStrict: vi.fn(async (): Promise<RelayAdmission> => ({ disposition: 'admitted' })),
  forwardAction: vi.fn(async (msg) => ({ msgId: msg.msgId, accepted: true })),
  reportChannels: vi.fn(),
  reportRevoked: vi.fn(),
  reportCredentialCheck: vi.fn(),
  reportTenant: vi.fn(),
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
    soleTarget: () => TARGET
  },
  canDeliver: () => true,
  dedupSeen: vi.fn(() => false),
  dedupPeek: vi.fn(() => false),
  dedupMark: vi.fn(),
  setChannelAgent: () => {},
  selectThreadAgent: () => {},
  reportBotUserId: vi.fn(),
  publicRelayUrl: () => 'https://relay.example.test',
  webAppUrl: () => undefined,
  clock: { now: () => NOW },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...over
})

// The shape the CP's assignment produces for a Teams bot: no secret, the app ID and the tenant as the composite identity.
const assignment = (over: Partial<BotAssignment> = {}): BotAssignment => ({
  botId: BOT_ROW,
  platform: 'msteams',
  secrets: {},
  apiAppId: APP_ID,
  teamId: TENANT,
  credentialRevision: 2,
  members: [],
  agents: [],
  routes: [],
  ...over
})

interface Setup {
  plugin: MsTeamsIngressPlugin
  h: RelayIngressHost
  ingest: MsTeamsHttpIngest
  bf: ReturnType<typeof fakeBotFramework>
}

function setup(
  over: Partial<BotAssignment> = {},
  opts: { bf?: ReturnType<typeof fakeBotFramework>; host?: Partial<RelayIngressHost> } = {}
): Setup {
  const bf = opts.bf ?? fakeBotFramework()
  const plugin = createMsTeamsIngressPlugin({ fetch: bf.fetchImpl })
  const h = host(opts.host)
  const ingest = plugin.buildIngest(assignment(over), h)!
  return { plugin, h, ingest, bf }
}

/** Verify, then handle, one request as core does; the header defaults to a valid token, and `null` sends none. */
async function deliver(s: Setup, activity: unknown, over: { authorization?: string | null; now?: number } = {}) {
  const authorization = over.authorization === undefined ? await bearer() : over.authorization
  const raw = Buffer.from(JSON.stringify(activity))
  const headers = authorization === null ? {} : { authorization }
  const verified = await s.plugin.verify(s.ingest, raw, activity, headers, over.now ?? NOW)
  if (!verified) return { verified, handled: undefined }
  return { verified, handled: await s.plugin.handle(s.ingest, verified, s.h) }
}

const forwarded = (h: RelayIngressHost, call = 0): WireNormalizedMessage | undefined =>
  vi.mocked(h.forwardStrict).mock.calls[call]?.[1]

const forwardedAction = (h: RelayIngressHost): RdMsgPlatformAction | undefined =>
  vi.mocked(h.forwardAction).mock.calls[0]?.[0]

describe('msteams ingress plugin — Bot Framework token verification (§3)', () => {
  it('accepts a Bot Framework token for the app and the activity’s serviceUrl and forwards the message', async () => {
    const s = setup()
    const { verified, handled } = await deliver(s, personalText)
    expect(verified?.activity).toBe(personalText)
    expect(handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(forwarded(s.h)).toMatchObject({
      platform: 'msteams',
      msgId: `msteams:${PERSONAL}:${personalText.id}`,
      channel: PERSONAL,
      isDm: true,
      trigger: 'dm',
      text: 'hello there',
      sender: { id: AAD_USER },
      adapterExt: { msteams: { serviceUrl: SERVICE_URL, conversationId: PERSONAL, userId: USER } }
    })
    // The metadata names the keys; both are fetched once.
    expect(s.bf.calls).toEqual([BOT_FRAMEWORK_OPENID_CONFIG_URL, KEYS_URL])
  })

  it('refuses an Entra or other issuer, another audience, an expired or future token, a serviceurl mismatch, a non-RS256 token, and a forged signature', async () => {
    const s = setup()
    const nowSec = Math.floor(NOW / 1000)
    const refused: Parameters<typeof bearer>[0][] = [
      { iss: `https://sts.windows.net/${TENANT}/` },
      { iss: `https://login.microsoftonline.com/${TENANT}/v2.0` },
      { iss: 'https://api.botframework.com/' },
      { aud: OTHER_APP_ID },
      { aud: `api://${APP_ID}` },
      { nbf: nowSec - 7200, exp: nowSec - 301 },
      { nbf: nowSec + 301 },
      { serviceurl: 'https://smba.trafficmanager.net/emea/00000000-0000-4000-8000-000000000002/' },
      { serviceurl: SERVICE_URL.slice(0, -1) },
      { serviceurl: undefined },
      { alg: 'RS512' },
      { key: OTHER_KEYS.privateKey }
    ]
    for (const over of refused) {
      const result = await deliver(s, personalText, { authorization: await bearer(over) })
      expect(result.verified, JSON.stringify(over)).toBeUndefined()
    }
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })

  it('verifies nothing without a bearer token or an activity serviceUrl, and lets five minutes of skew pass', async () => {
    const s = setup()
    for (const authorization of [null, 'Basic abc', 'Bearer not.a.jwt']) {
      expect((await deliver(s, personalText, { authorization })).verified).toBeUndefined()
    }
    const noServiceUrl = edit(personalText, (a) => delete a.serviceUrl)
    expect((await deliver(s, noServiceUrl)).verified).toBeUndefined()
    const nowSec = Math.floor(NOW / 1000)
    const justExpired = await bearer({ nbf: nowSec - 3840, exp: nowSec - 240 })
    expect((await deliver(s, personalText, { authorization: justExpired })).verified).toBeDefined()
    const earlyClock = await bearer({ nbf: nowSec + 240 })
    expect((await deliver(s, personalText, { authorization: earlyClock })).verified).toBeDefined()
  })

  it('compares the app ID case-insensitively, since an admin may paste a GUID in upper case', async () => {
    const s = setup({ apiAppId: APP_ID.toUpperCase(), teamId: TENANT.toUpperCase() })
    expect((await deliver(s, personalText)).verified).toBeDefined()
    expect(
      (await deliver(s, personalText, { authorization: await bearer({ aud: APP_ID.toUpperCase() }) })).verified
    ).toBeDefined()
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(2)
  })

  it('refetches the keys once for an unknown kid, and not again within the spacing', async () => {
    const s = setup()
    expect((await deliver(s, personalText)).verified).toBeDefined()
    expect(s.bf.keyFetches()).toBe(1)

    // The Bot Framework rotated: the new kid is served after exactly one refetch.
    s.bf.rotate({ keys: [{ ...JWK, kid: 'kid-next' }] })
    const rotated = await bearer({ kid: 'kid-next' })
    expect((await deliver(s, personalText, { authorization: rotated })).verified).toBeDefined()
    expect(s.bf.keyFetches()).toBe(2)

    // A forged kid inside the spacing cannot make the relay fetch again.
    const forged = await bearer({ kid: 'kid-forged' })
    expect((await deliver(s, personalText, { authorization: forged })).verified).toBeUndefined()
    expect(s.bf.keyFetches()).toBe(2)
    const later = NOW + MSTEAMS_KEYS_REFETCH_MS
    expect((await deliver(s, personalText, { authorization: forged, now: later })).verified).toBeUndefined()
    expect(s.bf.keyFetches()).toBe(3)
  })

  it('shares one in-flight fetch between concurrent requests', async () => {
    const s = setup()
    const results = await Promise.all([deliver(s, personalText), deliver(s, personalText), deliver(s, personalText)])
    expect(results.every((r) => r.verified)).toBe(true)
    expect(s.bf.keyFetches()).toBe(1)
  })

  it('keeps the last good keys when a refresh fails', async () => {
    const s = setup({}, { bf: fakeBotFramework(undefined, { 'cache-control': 'max-age=120' }) })
    expect((await deliver(s, personalText)).verified).toBeDefined()
    s.bf.rotate({ keys: [] })
    const later = await bearer({ nbf: Math.floor(NOW / 1000) + 100 })
    expect((await deliver(s, personalText, { authorization: later, now: NOW + 121_000 })).verified).toBeDefined()
    expect(s.bf.keyFetches()).toBe(2)
    expect(s.h.log.warn).toHaveBeenCalledWith(expect.stringContaining('signing key refresh failed'))
  })

  it('imports only RSA signing keys endorsed for Teams', async () => {
    for (const key of [
      { ...JWK, use: 'enc' },
      { ...JWK, endorsements: ['webchat'] },
      { ...JWK, endorsements: 'msteams' }
    ]) {
      const s = setup({}, { bf: fakeBotFramework({ keys: [key] }) })
      expect((await deliver(s, personalText)).verified, JSON.stringify(key.endorsements)).toBeUndefined()
    }
    const { endorsements: _endorsements, ...unlisted } = JWK
    const s = setup({}, { bf: fakeBotFramework({ keys: [unlisted] }) })
    expect((await deliver(s, personalText)).verified).toBeDefined()
  })

  it('keeps every published key, so a token signed by a key deep in a large document verifies', async () => {
    // The live document publishes a few hundred keys; one past any small prefix must still verify.
    const decoy = OTHER_KEYS.publicKey.export({ format: 'jwk' })
    const decoys = Array.from({ length: 299 }, (_, i) => ({
      ...decoy,
      kid: `kid-decoy-${i}`,
      use: 'sig',
      endorsements: ['msteams']
    }))
    const s = setup({}, { bf: fakeBotFramework({ keys: [...decoys.slice(0, 266), JWK, ...decoys.slice(266)] }) })
    expect((await deliver(s, personalText)).verified).toBeDefined()
    expect(s.bf.keyFetches()).toBe(1)
  })

  it("honors the keys response's max-age and falls back to the fixed TTL without one", async () => {
    const capped = setup({}, { bf: fakeBotFramework(undefined, { 'cache-control': 'public, max-age=120' }) })
    await deliver(capped, personalText)
    const later = await bearer({ nbf: Math.floor(NOW / 1000) + 100 })
    await deliver(capped, personalText, { authorization: later, now: NOW + 121_000 })
    expect(capped.bf.keyFetches()).toBe(2)

    const fixed = setup()
    await deliver(fixed, personalText)
    await deliver(fixed, personalText, { authorization: later, now: NOW + 121_000 })
    expect(fixed.bf.keyFetches()).toBe(1)
  })

  it('demuxes on the token’s unverified audience and the activity’s tenant, both lower-cased', async () => {
    const { plugin } = setup()
    const raw = Buffer.from('{}')
    const hints = (body: unknown, authorization?: string) =>
      plugin.extractDemuxHints(raw, body, authorization === undefined ? {} : { authorization })
    expect(hints(personalText, await bearer())).toEqual({ appId: APP_ID, tenantId: TENANT })
    expect(hints(personalText, await bearer({ aud: APP_ID.toUpperCase() }))).toEqual({
      appId: APP_ID,
      tenantId: TENANT
    })
    const upperTenant = edit(personalText, (a) => (a.channelData.tenant.id = TENANT.toUpperCase()))
    expect(hints(upperTenant)).toEqual({ tenantId: TENANT })
    expect(hints({})).toEqual({})
    expect(hints({}, 'Bearer not.a.jwt')).toEqual({})
    expect(hints({}, await bearer({ iss: `https://sts.windows.net/${TENANT}/` }))).toEqual({})
  })

  it('refuses an assignment without the app ID or the tenant, or one that carries a secret', () => {
    const { plugin } = setup()
    const h = host()
    expect(plugin.buildIngest(assignment({ apiAppId: undefined }), h)).toBeUndefined()
    expect(plugin.buildIngest(assignment({ teamId: undefined }), h)).toBeUndefined()
    expect(plugin.buildIngest(assignment({ secrets: { signingSecret: 'x' } }), h)).toBeUndefined()
    expect(h.log.warn).toHaveBeenCalledTimes(3)
  })
})

describe('msteams ingress plugin — admission, dedup and triggers (§4.1, §4.2)', () => {
  const DEDUP_KEY = `${BOT_ROW}\0${PERSONAL}\0${personalText.id}`

  it('marks the activity after an admitted or rejected verdict, never after a retry', async () => {
    for (const admission of [
      { disposition: 'admitted' },
      { disposition: 'rejected', reason: 'muted' },
      { disposition: 'retry', reason: 'draining' }
    ] as RelayAdmission[]) {
      const s = setup()
      vi.mocked(s.h.forwardStrict).mockResolvedValue(admission)
      expect((await deliver(s, personalText)).handled).toEqual({ admission })
      if (admission.disposition === 'retry') expect(s.h.dedupMark).not.toHaveBeenCalled()
      else expect(s.h.dedupMark).toHaveBeenCalledWith(DEDUP_KEY)
    }
  })

  it('answers a redelivery with the same activity ID without forwarding it, but not the same ID in another conversation', async () => {
    const seen = new Set<string>()
    const s = setup(
      {},
      {
        host: {
          dedupPeek: vi.fn((key?: string) => key !== undefined && seen.has(key)),
          dedupMark: vi.fn((key?: string) => void (key && seen.add(key)))
        }
      }
    )
    expect((await deliver(s, groupText)).handled).toEqual({ admission: { disposition: 'admitted' } })
    // Teams redelivers a 503 once, with the same activity ID: settled, so it is answered without a second turn.
    expect((await deliver(s, groupText)).handled).toEqual({})
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(1)
    // Message IDs are unique only within a conversation: the same ID elsewhere is a different message.
    const elsewhere = edit(groupText, (a) => (a.conversation.id = OTHER_CHAT))
    expect((await deliver(s, elsewhere)).handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(2)
    expect([...seen]).toEqual([
      `${BOT_ROW}\0${GROUP_CHAT}\0${groupText.id}`,
      `${BOT_ROW}\u0000${OTHER_CHAT}\u0000${groupText.id}`
    ])
  })

  it('forwards a retried attempt again, since only a settled verdict is marked', async () => {
    const s = setup()
    vi.mocked(s.h.forwardStrict).mockResolvedValueOnce({ disposition: 'retry', reason: 'offline' })
    expect((await deliver(s, personalText)).handled).toEqual({ admission: { disposition: 'retry', reason: 'offline' } })
    expect((await deliver(s, personalText)).handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(2)
  })

  it('stamps a 1:1 chat as dm and a mention of this bot as mention, and leaves an unmentioned message to the activation policy', async () => {
    const s = setup()
    await deliver(s, personalText)
    await deliver(s, channelMention)
    await deliver(s, channelReply)
    await deliver(s, groupText)
    const mentionOther = edit(channelMention, (a) => (a.entities[0].mentioned.id = `28:${OTHER_APP_ID}`))
    await deliver(s, mentionOther)
    expect(forwarded(s.h, 0)?.trigger).toBe('dm')
    expect(forwarded(s.h, 1)).toMatchObject({ trigger: 'mention', channel: CHANNEL, thread: ROOT, isDm: false })
    for (const call of [2, 3, 4]) expect(forwarded(s.h, call)).not.toHaveProperty('trigger')
    expect(forwarded(s.h, 2)).toMatchObject({ channel: CHANNEL, thread: ROOT, text: 'and the breaking changes?' })
  })

  it('answers an authenticated but malformed or misaddressed activity with 200 and a log line, forwarding nothing', async () => {
    const s = setup()
    for (const activity of [
      edit(personalText, (a) => delete a.conversation.id),
      edit(personalText, (a) => (a.recipient.id = `28:${OTHER_APP_ID}`)),
      edit(personalText, (a) => (a.conversation.tenantId = '00000000-0000-4000-8000-000000000009'))
    ]) {
      expect((await deliver(s, activity)).handled).toEqual({})
    }
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect(s.h.log.warn).toHaveBeenCalledTimes(3)
    expect(s.h.log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed Teams activity (malformed)'))
    expect(s.h.log.warn).toHaveBeenCalledWith(expect.stringContaining('(wrong_bot)'))
    expect(s.h.log.warn).toHaveBeenCalledWith(expect.stringContaining('(cross_tenant)'))
  })

  it('settles the bot’s own message and an empty one with a mark and no forward', async () => {
    const s = setup()
    const own = edit(personalText, (a) => (a.from = { id: `28:${APP_ID}`, name: 'Example Bot' }))
    expect((await deliver(s, own)).handled).toEqual({})
    expect(s.h.dedupMark).toHaveBeenCalledWith(DEDUP_KEY)
    expect(
      (
        await deliver(
          s,
          edit(personalText, (a) => (a.text = '  '))
        )
      ).handled
    ).toEqual({})
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })

  it('answers every activity type it does not act on with 200 and forwards nothing', async () => {
    const s = setup()
    const others = ['installationUpdate', 'typing', 'messageReaction', 'messageUpdate', 'messageDelete', 'event']
    for (const activity of [conversationUpdate, ...others.map((type) => edit(personalText, (a) => (a.type = type)))]) {
      expect((await deliver(s, activity)).handled, activity.type).toEqual({})
    }
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect(s.h.forwardAction).not.toHaveBeenCalled()
  })

  it('forwards the people a roster change added, the bot left out, for the daemon to look up', async () => {
    const s = setup()
    const added = edit(conversationUpdate, (a) => {
      a.membersAdded = [{ id: BOT_ID }, { id: USER, aadObjectId: AAD_USER }]
    })
    expect((await deliver(s, added)).handled).toEqual({})
    expect(s.h.forwardAction).toHaveBeenCalledOnce()
    const [rd] = vi.mocked(s.h.forwardAction).mock.calls[0]!
    expect(rd).toMatchObject({
      source: 'platform_action',
      platformId: 'msteams',
      integrationId: TARGET.integrationId,
      payload: {
        kind: 'members-added',
        conversationId: CHANNEL,
        serviceUrl: SERVICE_URL,
        teamId: TEAM,
        teamWide: true,
        members: [{ id: USER, aadObjectId: AAD_USER }]
      }
    })
    const botOnly = edit(conversationUpdate, (a) => {
      a.membersAdded = [{ id: BOT_ID }]
    })
    expect((await deliver(s, botOnly)).handled).toEqual({})
    // A 1:1 chat's install names its person beside the bot, and a 1:1 chat is never external.
    const personalInstall = edit(conversationUpdate, (a) => {
      a.conversation = { id: PERSONAL, conversationType: 'personal', tenantId: TENANT }
      a.membersAdded = [{ id: BOT_ID }, { id: USER, aadObjectId: AAD_USER }]
    })
    expect((await deliver(s, personalInstall)).handled).toEqual({})
    expect(s.h.forwardAction).toHaveBeenCalledOnce()
  })
})

describe('msteams ingress plugin — card clicks (§4.4)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const note = (value: string) => ({
    syncResponse: { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value }
  })

  it('forwards a verified click as a platform_action to the bot’s integration and answers with a note', async () => {
    const s = setup()
    expect((await deliver(s, cardClick)).handled).toEqual(note(MSTEAMS_CLICK_NOTES.received))
    const rd = forwardedAction(s.h)!
    expect(rd).toMatchObject({
      source: 'platform_action',
      platformId: 'msteams',
      agentId: TARGET.agentId,
      integrationId: TARGET.integrationId,
      botId: BOT_ROW,
      sessionKey: `msteams-action:${PERSONAL}/${CARD_ACTIVITY}`,
      userId: AAD_USER
    })
    expect(rd.msgId).toMatch(/^msteams-action:[0-9a-f]{64}$/)
    expect(WireMsTeamsCardAction.parse(rd.payload)).toEqual({
      verb: 'agentconnect.elicit',
      data: { requestId: 'req-1', option: 0, token: 't' },
      cardActivityId: CARD_ACTIVITY,
      conversationId: PERSONAL,
      serviceUrl: SERVICE_URL,
      aadObjectId: AAD_USER,
      userId: USER,
      userName: 'Example User'
    })
    expect(vi.mocked(s.h.forwardAction).mock.calls[0]?.[1]).toBe(TARGET)
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })

  it('gives a client retry of the same click the same identity, and a different choice a new one', async () => {
    const s = setup()
    await deliver(s, cardClick)
    await deliver(
      s,
      edit(cardClick, (a) => (a.id = 'f:example-invoke-0002'))
    )
    await deliver(
      s,
      edit(cardClick, (a) => (a.value.action.data.option = 1))
    )
    const ids = vi.mocked(s.h.forwardAction).mock.calls.map(([rd]) => rd.msgId)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('tells the clicker when the click reaches no integration, the daemon refuses it, or the forward fails', async () => {
    const noTarget = setup({}, { host: { directory: { ...host().directory, soleTarget: () => undefined } } })
    expect((await deliver(noTarget, cardClick)).handled).toEqual(note(MSTEAMS_CLICK_NOTES.undelivered))
    expect(noTarget.h.forwardAction).not.toHaveBeenCalled()

    const refused = setup({}, { host: { forwardAction: vi.fn(async () => ({ msgId: 'm', accepted: false })) } })
    expect((await deliver(refused, cardClick)).handled).toEqual(note(MSTEAMS_CLICK_NOTES.undelivered))

    const failed = setup({}, { host: { forwardAction: vi.fn(async () => Promise.reject(new Error('gone'))) } })
    expect((await deliver(failed, cardClick)).handled).toEqual(note(MSTEAMS_CLICK_NOTES.undelivered))
  })

  it('shows the clicker the refusal the daemon’s ack carries in place of the generic note', async () => {
    const refusal = 'Only an Agent editor can answer this request.'
    const told = setup(
      {},
      { host: { forwardAction: vi.fn(async () => ({ msgId: 'm', accepted: true, response: { note: refusal } })) } }
    )
    expect((await deliver(told, cardClick)).handled).toEqual(note(refusal))
    // A response that is not a bounded note leaves the generic one.
    for (const response of [{ note: '' }, { note: 'x'.repeat(501) }, 'text', { toast: refusal }]) {
      const odd = setup({}, { host: { forwardAction: vi.fn(async () => ({ msgId: 'm', accepted: true, response })) } })
      expect((await deliver(odd, cardClick)).handled).toEqual(note(MSTEAMS_CLICK_NOTES.received))
    }
  })

  it('answers within the bounded race while the daemon has not acked', async () => {
    const s = setup({}, { host: { forwardAction: vi.fn(() => new Promise<never>(() => {})) } })
    // Verified without timers, then handled on a fake clock so the race is observed rather than waited for.
    const verified = await s.plugin.verify(
      s.ingest,
      Buffer.from('{}'),
      cardClick,
      { authorization: await bearer() },
      NOW
    )
    vi.useFakeTimers()
    const pending = s.plugin.handle(s.ingest, verified!, s.h)
    await vi.advanceTimersByTimeAsync(MSTEAMS_CARD_ACTION_FORWARD_TIMEOUT_MS)
    expect(await pending).toEqual(note(MSTEAMS_CLICK_NOTES.received))
    expect(MSTEAMS_CARD_ACTION_FORWARD_TIMEOUT_MS).toBe(2_000)
  })

  it('answers an unknown invoke with an empty 200 and a malformed click with a note, forwarding neither', async () => {
    const s = setup()
    const unknown = edit(cardClick, (a) => (a.name = 'composeExtension/query'))
    expect((await deliver(s, unknown)).handled).toEqual({})
    for (const malformed of [
      edit(cardClick, (a) => (a.value.action.type = 'Action.Submit')),
      edit(cardClick, (a) => delete a.value.action.verb),
      edit(cardClick, (a) => delete a.replyToId),
      edit(cardClick, (a) => (a.value.action.data = 'text'))
    ]) {
      expect((await deliver(s, malformed)).handled).toEqual(note(MSTEAMS_CLICK_NOTES.unsupported))
    }
    expect(s.h.forwardAction).not.toHaveBeenCalled()
  })

  it('verifies a click like any activity: no token, no forward', async () => {
    const s = setup()
    expect((await deliver(s, cardClick, { authorization: null })).verified).toBeUndefined()
    expect(
      (await deliver(s, cardClick, { authorization: await bearer({ aud: OTHER_APP_ID }) })).verified
    ).toBeUndefined()
    expect(s.h.forwardAction).not.toHaveBeenCalled()
  })
})
