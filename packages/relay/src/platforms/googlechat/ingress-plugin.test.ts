import { describe, expect, it, vi } from 'vitest'
import type { WireNormalizedMessage } from '@agentconnect.md/protocol'
import {
  GOOGLE_CHAT_ANCHOR_BOT_ID,
  createGoogleChatIngressPlugin,
  googleChatAnchorAssignment,
  type GoogleChatIngressPlugin
} from './ingress-plugin.js'
import type { GoogleChatHttpIngest } from './http-ingest.js'
import { googleChatHelpText, googleChatWelcomeText } from './help.js'
import { GOOGLE_CHAT_KEYS_REFETCH_MS, GOOGLE_OIDC_JWKS_URL } from './token.js'
import type { RelayAdmission, RelayIngressHost } from '../contract.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import {
  JWK,
  NOW,
  OTHER_KEYS,
  addOnServiceAccount,
  bearer,
  fakeJwks
} from '../../../test/fixtures/google-chat-token.js'
import {
  APP,
  CUSTOMER,
  DM,
  DOMAIN,
  OTHER_APP,
  PERSON,
  PROJECT_NUMBER,
  PUBLIC_RELAY_URL,
  REDIRECT,
  SPACE,
  buttonClicked,
  cardClicked,
  dmAdded,
  dmHelp,
  dmMessage,
  slashCommand,
  spaceAdded,
  spaceAddingMention,
  spaceHelp,
  spaceMention,
  spaceRemoved
} from '../../../test/fixtures/google-chat-events.js'

const BOT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_CUSTOMER = 'customers/C0000000002'
const CLAIM_URL = 'https://console.example.test/googlechat/claim'
const TARGET = {
  agentId: '22222222-2222-4222-8222-222222222222',
  integrationId: '33333333-3333-4333-8333-333333333333'
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
    soleTarget: () => undefined
  },
  canDeliver: () => true,
  dedupSeen: vi.fn(() => false),
  dedupPeek: vi.fn(() => false),
  dedupMark: vi.fn(),
  setChannelAgent: () => {},
  selectThreadAgent: () => {},
  reportBotUserId: vi.fn(),
  publicRelayUrl: () => PUBLIC_RELAY_URL,
  webAppUrl: () => undefined,
  clock: { now: () => NOW },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...over
})

// The shape `toBotAssignment` produces for a Google Chat bot: no secret, the project number as the app id.
const assignment = (over: Partial<BotAssignment> = {}): BotAssignment => ({
  botId: BOT_ID,
  platform: 'googlechat',
  secrets: {},
  apiAppId: PROJECT_NUMBER,
  credentialRevision: 3,
  members: [],
  agents: [],
  routes: [],
  ...over
})

interface Setup {
  plugin: GoogleChatIngressPlugin
  h: RelayIngressHost
  ingest: GoogleChatHttpIngest
  jwks: ReturnType<typeof fakeJwks>
}

function setup(
  over: Partial<BotAssignment> = {},
  opts: { jwks?: ReturnType<typeof fakeJwks>; host?: Partial<RelayIngressHost> } = {}
): Setup {
  const jwks = opts.jwks ?? fakeJwks()
  const plugin = createGoogleChatIngressPlugin({ fetch: jwks.fetchImpl })
  const h = host(opts.host)
  const ingest = plugin.buildIngest(assignment(over), h)!
  return { plugin, h, ingest, jwks }
}

/** Verify, then handle, one request as the route does; the header defaults to a valid token, and `null` sends none. */
async function deliver(s: Setup, event: unknown, over: { authorization?: string | null; now?: number } = {}) {
  const authorization = over.authorization === undefined ? await bearer() : over.authorization
  const raw = Buffer.from(JSON.stringify(event))
  const headers = authorization === null ? {} : { authorization }
  const verified = await s.plugin.verify(s.ingest, raw, event, headers, over.now ?? NOW)
  if (!verified) return { verified, handled: undefined }
  return { verified, handled: await s.plugin.handle(s.ingest, verified, s.h) }
}

/** A deep copy of a fixture with one change, so each case states only what it changes. */
function edit(event: unknown, mutate: (e: any) => void): unknown {
  const e = JSON.parse(JSON.stringify(event))
  mutate(e)
  return e
}

const forwarded = (h: RelayIngressHost): WireNormalizedMessage | undefined =>
  vi.mocked(h.forwardStrict).mock.calls[0]?.[1]

// The text of a plain created-message answer (§11.4), the only member of its body.
function createdText(syncResponse: unknown): string {
  const body = syncResponse as { hostAppDataAction: { chatDataAction: { createMessageAction: { message: any } } } }
  expect(Object.keys(body)).toEqual(['hostAppDataAction'])
  const message = body.hostAppDataAction.chatDataAction.createMessageAction.message
  expect(Object.keys(message)).toEqual(['text'])
  return message.text as string
}

// A Space message naming two apps: Google's data cannot say which one is this app.
const twoAppMention = edit(spaceMention, (e) => {
  const message = e.chat.messagePayload.message
  message.text = '@AgentConnect Probe @Other 第二条'
  message.annotations.push({
    type: 'USER_MENTION',
    startIndex: 20,
    length: 6,
    userMention: { user: { name: OTHER_APP, displayName: 'Other', type: 'BOT' }, type: 'MENTION' }
  })
})
const personal = edit(dmMessage, (e) => delete e.chat.user.domainId)
const noCustomer = edit(spaceMention, (e) => delete e.chat.messagePayload.space.customer)
const otherCustomerMention = edit(spaceMention, (e) => (e.chat.messagePayload.space.customer = OTHER_CUSTOMER))
// A click on a button whose action is not an elicitation's.
const otherClick = buttonClicked({ 'agentconnect.action': 'agentconnect.other' })

describe('googlechat ingress plugin — bearer-token verification (§11.2)', () => {
  it('accepts a Google ID token for the events URL from the add-on’s service account and forwards the message', async () => {
    const s = setup()
    const { verified, handled } = await deliver(s, dmMessage)
    expect(verified?.event).toBe(dmMessage)
    expect(handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(forwarded(s.h)).toMatchObject({
      platform: 'googlechat',
      msgId: `googlechat:${DM}:${DM}/messages/EXAMPLE_THREAD_1.EXAMPLE_MSG_ROOT`,
      channel: DM,
      isDm: true,
      text: 'hi'
    })
    expect(forwarded(s.h)).not.toHaveProperty('adapterExt')
    expect(s.jwks.calls).toEqual([GOOGLE_OIDC_JWKS_URL])
    // Either issuer spelling Google uses passes.
    const shortIssuer = await bearer({ iss: 'accounts.google.com' })
    expect((await deliver(s, dmMessage, { authorization: shortIssuer })).verified).toBeDefined()
  })

  it('refuses another audience, service account, or issuer, an unverified email, an expired token, a non-RS256 token, and a forged signature', async () => {
    const s = setup()
    const nowSec = Math.floor(NOW / 1000)
    const refused: Parameters<typeof bearer>[0][] = [
      { aud: PROJECT_NUMBER },
      { aud: `${PUBLIC_RELAY_URL}/googlechat/events/` },
      { aud: 'https://relay-2.example.test/googlechat/events' },
      { email: addOnServiceAccount('200000000000') },
      { email: `${addOnServiceAccount(PROJECT_NUMBER)}.example.test` },
      { email: `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com` },
      { email: `service-${PROJECT_NUMBER}@example.test` },
      { email: undefined },
      { emailVerified: false },
      { emailVerified: 'true' },
      { emailVerified: undefined },
      { iss: 'https://issuer.example.test' },
      { iat: nowSec - 7200, exp: nowSec - 120 },
      { alg: 'RS512' },
      { key: OTHER_KEYS.privateKey }
    ]
    for (const over of refused) {
      const result = await deliver(s, dmMessage, { authorization: await bearer(over) })
      expect(result.verified, JSON.stringify(over)).toBeUndefined()
    }
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })

  it('verifies nothing without a bearer token, and lets a minute of skew pass', async () => {
    const s = setup()
    for (const authorization of [null, 'Basic abc', 'Bearer not.a.jwt']) {
      expect((await deliver(s, dmMessage, { authorization })).verified).toBeUndefined()
    }
    const nowSec = Math.floor(NOW / 1000)
    const justExpired = await bearer({ iat: nowSec - 3630, exp: nowSec - 30 })
    expect((await deliver(s, dmMessage, { authorization: justExpired })).verified).toBeDefined()
  })

  it('refuses every token, fetching nothing, while the CP has not named the relay’s public origin', async () => {
    const s = setup({}, { host: { publicRelayUrl: () => undefined } })
    expect((await deliver(s, dmMessage)).verified).toBeUndefined()
    expect(s.jwks.calls).toEqual([])
  })

  it('refetches the JWKS once for an unknown kid, and not again within the spacing', async () => {
    const s = setup()
    expect((await deliver(s, dmMessage)).verified).toBeDefined()
    expect(s.jwks.calls).toHaveLength(1)

    // Google rotated: the new kid is served after exactly one refetch.
    s.jwks.rotate({ keys: [{ ...JWK, kid: 'kid-next' }] })
    const rotated = await bearer({ kid: 'kid-next' })
    expect((await deliver(s, dmMessage, { authorization: rotated })).verified).toBeDefined()
    expect(s.jwks.calls).toHaveLength(2)

    // A forged kid inside the spacing cannot make the relay fetch again.
    const forged = await bearer({ kid: 'kid-forged' })
    expect((await deliver(s, dmMessage, { authorization: forged })).verified).toBeUndefined()
    expect(s.jwks.calls).toHaveLength(2)
    const later = NOW + GOOGLE_CHAT_KEYS_REFETCH_MS
    expect((await deliver(s, dmMessage, { authorization: forged, now: later })).verified).toBeUndefined()
    expect(s.jwks.calls).toHaveLength(3)
  })

  it('imports only RSA signing keys', async () => {
    const s = setup({}, { jwks: fakeJwks({ keys: [{ ...JWK, use: 'enc' }] }) })
    expect((await deliver(s, dmMessage)).verified).toBeUndefined()
  })

  it("honors the response's max-age and falls back to the fixed TTL without one", async () => {
    const capped = setup({}, { jwks: fakeJwks(undefined, { 'cache-control': 'public, max-age=120' }) })
    await deliver(capped, dmMessage)
    const later = await bearer({ iat: Math.floor(NOW / 1000) + 100 })
    await deliver(capped, dmMessage, { authorization: later, now: NOW + 121_000 })
    expect(capped.jwks.calls).toHaveLength(2)

    const fixed = setup()
    await deliver(fixed, dmMessage)
    await deliver(fixed, dmMessage, { authorization: later, now: NOW + 121_000 })
    expect(fixed.jwks.calls).toHaveLength(1)
  })

  it('demuxes on the project number of the token’s service account; a body naming no tenant adds no second hint', async () => {
    const { plugin } = setup()
    const raw = Buffer.from('{}')
    const hints = async (authorization?: string) =>
      plugin.extractDemuxHints(raw, {}, authorization === undefined ? {} : { authorization })
    expect(await hints(await bearer())).toEqual({ appId: PROJECT_NUMBER })
    expect(await hints()).toEqual({})
    expect(await hints('Bearer not.a.jwt')).toEqual({})
    expect(await hints(await bearer({ email: 'someone@example.test' }))).toEqual({})
    expect(await hints(await bearer({ iss: 'https://issuer.example.test' }))).toEqual({})
  })

  it('refuses an assignment without the project number, or one that carries a secret', () => {
    const { plugin } = setup()
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
      const s = setup()
      vi.mocked(s.h.forwardStrict).mockResolvedValue(admission)
      expect((await deliver(s, dmMessage)).handled).toEqual({ admission })
      if (admission.disposition === 'retry') expect(s.h.dedupMark).not.toHaveBeenCalled()
      else expect(s.h.dedupMark).toHaveBeenCalledWith(DEDUP_KEY)
      expect(s.h.dedupSeen).not.toHaveBeenCalled()
    }
  })

  it('answers a settled repeat without forwarding it', async () => {
    const s = setup()
    vi.mocked(s.h.dedupPeek).mockReturnValue(true)
    expect((await deliver(s, dmMessage)).handled).toEqual({})
    expect(s.h.dedupPeek).toHaveBeenCalledWith(DEDUP_KEY)
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect(s.h.dedupMark).not.toHaveBeenCalled()
  })

  it('settles an ignored or unsupported event with a mark and no forward', async () => {
    const s = setup()
    const appAuthored = edit(
      dmMessage,
      (e) => (e.chat.messagePayload.message.sender = { name: APP, displayName: 'Probe', type: 'BOT' })
    )
    expect((await deliver(s, appAuthored)).handled).toEqual({})
    expect(s.h.dedupMark).toHaveBeenCalledWith(DEDUP_KEY)
    const groupDm = edit(dmMessage, (e) => (e.chat.messagePayload.space.spaceType = 'GROUP_CHAT'))
    expect((await deliver(s, groupDm)).handled).toEqual({})
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })

  it('forwards a message to each of two apps it mentions, since the shared table is keyed by bot', async () => {
    // One Space message mentioning two installed apps reaches the relay once per app, each signed for its own project.
    const OTHER_BOT = '22222222-2222-4222-8222-222222222222'
    const settled = new Set<string>()
    const first = setup(
      {},
      {
        host: {
          dedupPeek: vi.fn((id?: string) => id !== undefined && settled.has(id)),
          dedupMark: vi.fn((id?: string) => {
            if (id !== undefined) settled.add(id)
          })
        }
      }
    )
    const second = {
      ...first,
      ingest: first.plugin.buildIngest(assignment({ botId: OTHER_BOT, apiAppId: '200000000002' }), first.h)!
    }
    expect((await deliver(first, dmMessage)).handled).toEqual({ admission: { disposition: 'admitted' } })
    const secondToken = await bearer({ email: addOnServiceAccount('200000000002') })
    expect((await deliver(second, dmMessage, { authorization: secondToken })).handled).toEqual({
      admission: { disposition: 'admitted' }
    })
    expect(vi.mocked(first.h.forwardStrict).mock.calls.map(([botId, msg]) => [botId, msg.msgId])).toEqual([
      [BOT_ID, MSG_ID],
      [OTHER_BOT, MSG_ID]
    ])
    expect([...settled]).toEqual([DEDUP_KEY, `${OTHER_BOT}\0${MSG_ID}`])
    // The same app's repeat is still settled.
    expect((await deliver(first, dmMessage)).handled).toEqual({})
    expect(first.h.forwardStrict).toHaveBeenCalledTimes(2)
  })

  it('drops a permanently malformed event with a 200 and a log line, forwarding and marking nothing', async () => {
    const s = setup()
    const crossSpace = edit(
      dmMessage,
      (e) => (e.chat.messagePayload.message.name = `${SPACE}/messages/EXAMPLE_ELSEWHERE`)
    )
    expect((await deliver(s, crossSpace)).handled).toEqual({})
    // A body without exactly one payload is malformed the same way.
    expect((await deliver(s, { chat: { user: { name: PERSON, type: 'HUMAN' } } })).handled).toEqual({})
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect(s.h.dedupMark).not.toHaveBeenCalled()
    expect(s.h.log.warn).toHaveBeenCalledWith(expect.stringContaining('cross_space'))
    expect(s.h.log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'))
  })
})

describe('googlechat ingress plugin — observed membership (§4)', () => {
  it('reports a DM add as an im row, welcomes the person, and starts no turn', async () => {
    const s = setup()
    expect(createdText((await deliver(s, dmAdded)).handled?.syncResponse)).toBe(googleChatWelcomeText(true))
    expect(s.h.reportChannels).toHaveBeenCalledWith({ botId: BOT_ID, channels: [{ id: DM, kind: 'im' }] })
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })

  it('reports a Space add with its display name, forwards the adding message from its own request, and drops the row on removal', async () => {
    const s = setup()
    expect(createdText((await deliver(s, spaceAdded)).handled?.syncResponse)).toBe(googleChatWelcomeText(false))
    expect(s.h.reportChannels).toHaveBeenLastCalledWith({
      botId: BOT_ID,
      channels: [{ id: SPACE, name: 'Example Space', kind: 'channel' }]
    })
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect((await deliver(s, spaceAddingMention)).handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(forwarded(s.h)).toMatchObject({ channel: SPACE, thread: `${SPACE}/threads/EXAMPLE_THREAD_2`, text: 'hello' })

    expect((await deliver(s, spaceRemoved)).handled).toEqual({})
    expect(s.h.reportChannels).toHaveBeenLastCalledWith({ botId: BOT_ID, channels: [] })
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(1)
  })
})

describe('googlechat ingress plugin — the welcome and /help answers (§10.7, §11.4)', () => {
  it('answers /help in the body for an own app’s row and a customer row, forwarding, reporting, and marking nothing', async () => {
    for (const s of [setup(), setup({ tenantIds: [CUSTOMER, DOMAIN] })]) {
      expect(createdText((await deliver(s, spaceHelp)).handled?.syncResponse)).toBe(googleChatHelpText())
      expect(createdText((await deliver(s, dmHelp)).handled?.syncResponse)).toBe(googleChatHelpText())
      expect(s.h.forwardStrict).not.toHaveBeenCalled()
      expect(s.h.forwardAction).not.toHaveBeenCalled()
      expect(s.h.reportChannels).not.toHaveBeenCalled()
      expect(s.h.dedupMark).not.toHaveBeenCalled()
    }
  })

  it('welcomes an add on a customer row in the DM or the space it happened in, and answers a removal with nothing', async () => {
    const s = setup({ tenantIds: [CUSTOMER, DOMAIN] })
    expect(createdText((await deliver(s, dmAdded)).handled?.syncResponse)).toBe(googleChatWelcomeText(true))
    expect(createdText((await deliver(s, spaceAdded)).handled?.syncResponse)).toBe(googleChatWelcomeText(false))
    expect((await deliver(s, spaceRemoved)).handled).toEqual({})
    expect(s.h.reportChannels).toHaveBeenCalledTimes(3)
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })

  it('settles another slash command like any unsupported event, answering nothing', async () => {
    const s = setup()
    expect((await deliver(s, slashCommand('/status'))).handled).toEqual({})
    expect(s.h.dedupMark).toHaveBeenCalledTimes(1)
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })

  it('tells an unclaimed tenant’s /help to connect the app first, and answers nothing without a tenant', async () => {
    const s = setup({ claimUrl: CLAIM_URL })
    const text = createdText((await deliver(s, dmHelp)).handled?.syncResponse)
    expect(text).toBe(googleChatHelpText({ unclaimed: true }))
    expect(text).toContain('your organization needs to connect this app')
    expect(createdText((await deliver(s, spaceHelp)).handled?.syncResponse)).toBe(text)
    expect(
      (
        await deliver(
          s,
          edit(dmHelp, (e) => delete e.chat.user.domainId)
        )
      ).handled
    ).toEqual({})
    expect((await deliver(s, slashCommand('/status', true))).handled).toEqual({})
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect(s.h.dedupMark).not.toHaveBeenCalled()
  })

  it('refuses a foreign customer’s /help and add on a single-tenant row', async () => {
    const s = setup({ ownTenantIds: [CUSTOMER] })
    const foreignHelp = edit(spaceHelp, (e) => (e.chat.appCommandPayload.space.customer = OTHER_CUSTOMER))
    expect((await deliver(s, foreignHelp)).handled).toEqual({})
    const foreignAdd = edit(spaceAdded, (e) => (e.chat.addedToSpacePayload.space.customer = OTHER_CUSTOMER))
    expect((await deliver(s, foreignAdd)).handled).toEqual({})
    expect(createdText((await deliver(s, spaceHelp)).handled?.syncResponse)).toBe(googleChatHelpText())
  })
})

describe('googlechat ingress plugin — the app identity (§3)', () => {
  it('learns the identity from the message that added the app, not from the add, and keeps using it', async () => {
    const s = setup()
    await deliver(s, spaceAdded)
    expect(s.h.reportBotUserId).not.toHaveBeenCalled()
    await deliver(s, spaceAddingMention)
    expect(s.h.reportBotUserId).toHaveBeenCalledWith(BOT_ID, APP)
    expect(forwarded(s.h)).toMatchObject({ text: 'hello', mentionedBots: [APP] })

    await deliver(s, spaceMention)
    expect(vi.mocked(s.h.forwardStrict).mock.calls[1]?.[1]).toMatchObject({ text: '第二条', mentionedBots: [APP] })
    expect(s.h.reportBotUserId).toHaveBeenCalledTimes(1)
    expect(s.h.log.warn).not.toHaveBeenCalled()
  })

  it('learns the identity from a Space message that mentions exactly one app', async () => {
    const s = setup()
    await deliver(s, spaceMention)
    expect(s.h.reportBotUserId).toHaveBeenCalledWith(BOT_ID, APP)
    expect(forwarded(s.h)).toMatchObject({ text: '第二条', mentionedBots: [APP] })
  })

  it("prefers the assignment's identity over what an annotation names", async () => {
    const s = setup({ botUserId: OTHER_APP })
    await deliver(s, spaceMention)
    expect(s.h.reportBotUserId).not.toHaveBeenCalled()
    expect(forwarded(s.h)).toMatchObject({ text: '@AgentConnect Probe  第二条', mentionedBots: [] })
  })

  it('forwards unstripped, warning once, while the identity cannot be known', async () => {
    const s = setup()
    await deliver(s, twoAppMention)
    await deliver(s, dmMessage)
    expect(s.h.reportBotUserId).not.toHaveBeenCalled()
    expect(forwarded(s.h)).toMatchObject({ text: '@AgentConnect Probe @Other 第二条', mentionedBots: [] })
    expect(vi.mocked(s.h.forwardStrict).mock.calls[1]?.[1]).toMatchObject({ text: 'hi', isDm: true })
    expect(vi.mocked(s.h.log.warn).mock.calls.filter(([m]) => m.includes('identity'))).toHaveLength(1)
  })
})

describe('googlechat ingress plugin — the trusted activation cause', () => {
  it('stamps a DM as a DM and every Space delivery as a mention, before and after the identity is known', async () => {
    const s = setup()
    for (const event of [dmMessage, twoAppMention, spaceAddingMention, spaceMention]) await deliver(s, event)
    const forwardedMessages = vi.mocked(s.h.forwardStrict).mock.calls.map(([, message]) => message)
    expect(forwardedMessages.map((message) => message.trigger)).toEqual(['dm', 'mention', 'mention', 'mention'])
    // The second Space delivery was stamped although nothing named this app yet.
    expect(forwardedMessages[1]).toMatchObject({ isDm: false, mentionedBots: [] })
  })
})

describe('googlechat ingress plugin — the deployment app’s anchor and customer rows (§10.4)', () => {
  const claimLink = (link: string) => {
    const url = new URL(link)
    return {
      base: `${url.origin}${url.pathname}`,
      state: JSON.parse(Buffer.from(url.searchParams.get('state')!, 'base64url').toString('utf8')) as unknown
    }
  }
  // The authorization prompt, the only member of its body.
  const prompt = (syncResponse: unknown) => {
    const body = syncResponse as { basic_authorization_prompt: { authorization_url: string; resource: string } }
    expect(Object.keys(body)).toEqual(['basic_authorization_prompt'])
    expect(body.basic_authorization_prompt.resource).toBe('AgentConnect')
    return claimLink(body.basic_authorization_prompt.authorization_url)
  }
  // The welcome card as a created message, whose one button opens the claim page.
  const welcome = (syncResponse: unknown) => {
    const body = syncResponse as { hostAppDataAction: { chatDataAction: { createMessageAction: { message: any } } } }
    const card = body.hostAppDataAction.chatDataAction.createMessageAction.message.cardsV2[0].card
    return claimLink(card.sections[0].widgets[1].buttonList.buttons[0].onClick.openLink.url)
  }
  const anchor = () => setup({ claimUrl: CLAIM_URL })

  it('answers an unclaimed tenant in the body and forwards, reports, peeks, and marks nothing', async () => {
    const s = anchor()
    const iat = Math.floor(NOW / 1000)
    // An add gets the welcome card, whose button opens the claim page naming nobody.
    const dmWelcome = welcome((await deliver(s, dmAdded)).handled?.syncResponse)
    expect(dmWelcome.base).toBe(CLAIM_URL)
    expect(dmWelcome.state).toEqual({ v: 1, app: PROJECT_NUMBER, space: DM, kind: 'dm', tenant: DOMAIN, iat })
    const spaceWelcome = welcome((await deliver(s, spaceAdded)).handled?.syncResponse)
    expect(spaceWelcome.state).toEqual({
      v: 1,
      app: PROJECT_NUMBER,
      space: SPACE,
      kind: 'space',
      tenant: CUSTOMER,
      iat
    })
    // A message gets the authorization prompt, whose state carries the contract's fields and nothing else.
    const dm = await deliver(s, dmMessage)
    expect(dm.handled?.admission).toBeUndefined()
    const decoded = prompt(dm.handled?.syncResponse)
    expect(decoded.base).toBe(CLAIM_URL)
    expect(decoded.state).toEqual({
      v: 1,
      app: PROJECT_NUMBER,
      space: DM,
      user: PERSON,
      kind: 'dm',
      tenant: DOMAIN,
      redirect: REDIRECT,
      iat
    })
    const space = prompt((await deliver(s, spaceMention)).handled?.syncResponse)
    expect(space.state).toMatchObject({ space: SPACE, user: PERSON, kind: 'space', tenant: CUSTOMER })
    // Chat refuses a prompt for a click, so a click is nothing to answer; nor is a removal.
    expect((await deliver(s, cardClicked)).handled).toEqual({})
    expect((await deliver(s, spaceRemoved)).handled).toEqual({})
    // A payload without a return URL omits `redirect`.
    const noRedirect = edit(dmMessage, (e) => delete e.chat.messagePayload.configCompleteRedirectUri)
    expect(prompt((await deliver(s, noRedirect)).handled?.syncResponse).state).not.toHaveProperty('redirect')
    // Nothing left the relay and nothing was settled: no forward, no membership report, no dedup read or mark.
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect(s.h.forward).not.toHaveBeenCalled()
    expect(s.h.forwardAction).not.toHaveBeenCalled()
    expect(s.h.reportChannels).not.toHaveBeenCalled()
    expect(s.h.dedupPeek).not.toHaveBeenCalled()
    expect(s.h.dedupMark).not.toHaveBeenCalled()
  })

  it('answers nothing for an unclaimed event without a Workspace tenant, and still drops what it cannot classify', async () => {
    const s = anchor()
    expect((await deliver(s, personal)).handled).toEqual({})
    expect((await deliver(s, noCustomer)).handled).toEqual({})
    const appAuthored = edit(dmMessage, (e) => (e.chat.messagePayload.message.sender = { name: APP, type: 'BOT' }))
    expect((await deliver(s, appAuthored)).handled).toEqual({})
    const crossSpace = edit(dmMessage, (e) => (e.chat.messagePayload.message.name = `${SPACE}/messages/ELSEWHERE`))
    expect((await deliver(s, crossSpace)).handled).toEqual({})
    expect(s.h.log.warn).toHaveBeenCalledWith(expect.stringContaining('cross_space'))
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect(s.h.dedupMark).not.toHaveBeenCalled()
    expect(s.h.log.info).not.toHaveBeenCalled()
  })

  it('notes an unclaimed tenant once a minute however chatty it is, and always answers the prompt', async () => {
    let now = NOW
    const s = setup({ claimUrl: CLAIM_URL }, { host: { clock: { now: () => now } } })
    const noted = () => vi.mocked(s.h.log.info).mock.calls.filter(([m]) => m.includes('unclaimed')).length
    for (let i = 0; i < 3; i++) {
      expect((await deliver(s, dmMessage)).handled?.syncResponse).toBeDefined()
    }
    expect(noted()).toBe(1)
    // Another tenant is its own line; the first one is noted again once the window has passed.
    await deliver(s, spaceMention)
    expect(noted()).toBe(2)
    now = NOW + 59_000
    await deliver(s, dmMessage, { now })
    expect(noted()).toBe(2)
    now = NOW + 60_000
    const later = await deliver(s, dmMessage, { now })
    expect(noted()).toBe(3)
    expect(prompt(later.handled?.syncResponse).state).toMatchObject({ iat: Math.floor(now / 1000) })
  })

  it('routes a customer row exactly as a single-tenant row, where a click that is not an elicitation does nothing', async () => {
    const s = setup({ tenantIds: [DOMAIN, CUSTOMER] })
    expect((await deliver(s, dmMessage)).handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(forwarded(s.h)).toMatchObject({ channel: DM, text: 'hi', trigger: 'dm' })
    expect(s.h.dedupMark).toHaveBeenCalledWith(
      `${BOT_ID}\0googlechat:${DM}:${DM}/messages/EXAMPLE_THREAD_1.EXAMPLE_MSG_ROOT`
    )
    expect((await deliver(s, otherClick)).handled).toEqual({})
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(1)
    expect(s.h.forwardAction).not.toHaveBeenCalled()
    expect(s.h.dedupMark).toHaveBeenCalledTimes(1)
    // The row keeps what it was assigned, for core's composite index and fence.
    expect(s.ingest.tenantIds).toEqual([DOMAIN, CUSTOMER])
    expect(s.ingest.claimUrl).toBeUndefined()
  })

  it('an own app’s row, with no claim page, still routes every event, including one naming no tenant', async () => {
    const s = setup()
    expect((await deliver(s, personal)).handled).toEqual({ admission: { disposition: 'admitted' } })
    expect((await deliver(s, spaceMention)).handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(2)
    expect((await deliver(s, otherClick)).handled).toEqual({})
  })

  it('forwards an elicitation-card click to the sole integration and answers Google with an empty body', async () => {
    const s = setup({}, { host: { directory: { ...host().directory, soleTarget: () => TARGET as never } } })
    const parameters = { 'agentconnect.action': 'agentconnect.elicit', request: 'req-1', token: 'ok' }
    const click = buttonClicked(parameters, { f0: { stringInputs: { value: ['typed'] } } })
    expect((await deliver(s, click)).handled).toEqual({})
    expect(s.h.forwardAction).toHaveBeenCalledTimes(1)
    const [rd, route] = vi.mocked(s.h.forwardAction).mock.calls[0]!
    expect(route).toBe(TARGET)
    expect(rd).toMatchObject({
      source: 'platform_action',
      platformId: 'googlechat',
      ...TARGET,
      botId: BOT_ID,
      userId: PERSON,
      sessionKey: `googlechat-action:${SPACE}/messages/EXAMPLE_CARD.EXAMPLE_CARD`,
      payload: {
        function: 'agentconnect.elicit',
        parameters,
        formInputs: { f0: ['typed'] },
        message: `${SPACE}/messages/EXAMPLE_CARD.EXAMPLE_CARD`
      }
    })
    // A redelivered click mints the same id, so the daemon replays its first ack.
    await deliver(s, click)
    expect(vi.mocked(s.h.forwardAction).mock.calls[1]![0].msgId).toBe(rd.msgId)
    // A click that is not an elicitation is never forwarded.
    await deliver(s, otherClick)
    expect(s.h.forwardAction).toHaveBeenCalledTimes(2)
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
  })

  it('answers an elicitation click with no current target without forwarding it', async () => {
    const s = setup()
    expect((await deliver(s, cardClicked)).handled).toEqual({})
    expect(s.h.forwardAction).not.toHaveBeenCalled()
    expect(s.h.log.warn).toHaveBeenCalledWith(expect.stringContaining('no current integration target'))
  })

  it("supplies the event's tenant key as the demux hint: the Space's customer, the DM sender's domain, never a Space sender's domain", async () => {
    const { plugin } = setup()
    const headers = { authorization: await bearer() }
    const raw = Buffer.from('{}')
    expect(plugin.extractDemuxHints(raw, dmMessage, headers)).toEqual({ appId: PROJECT_NUMBER, tenantId: DOMAIN })
    expect(plugin.extractDemuxHints(raw, spaceMention, headers)).toEqual({ appId: PROJECT_NUMBER, tenantId: CUSTOMER })
    expect(plugin.extractDemuxHints(raw, cardClicked, headers)).toEqual({ appId: PROJECT_NUMBER, tenantId: CUSTOMER })
    expect(plugin.extractDemuxHints(raw, noCustomer, headers)).toEqual({ appId: PROJECT_NUMBER })
    expect(plugin.extractDemuxHints(raw, dmMessage, {})).toEqual({ tenantId: DOMAIN })
  })

  it('derives the anchor from the CP’s snapshot alone: the project number and the claim page, no secret, no member', () => {
    const { plugin } = setup()
    expect(plugin.deploymentAssignments).toBe(googleChatAnchorAssignment)
    const [anchored] = googleChatAnchorAssignment({
      revision: 4,
      googleChatAnchor: { projectNumber: PROJECT_NUMBER, claimUrl: CLAIM_URL }
    })
    expect(anchored).toEqual({
      botId: GOOGLE_CHAT_ANCHOR_BOT_ID,
      platform: 'googlechat',
      secrets: {},
      apiAppId: PROJECT_NUMBER,
      claimUrl: CLAIM_URL,
      members: [],
      agents: [],
      routes: []
    })
    expect(plugin.buildIngest(anchored!, host())?.claimUrl).toBe(CLAIM_URL)
    expect(googleChatAnchorAssignment({ revision: 4 })).toEqual([])
    expect(googleChatAnchorAssignment(undefined)).toEqual([])
  })

  it('refuses a row that is both a customer and the anchor', () => {
    const { plugin } = setup()
    const h = host()
    expect(plugin.buildIngest(assignment({ tenantIds: [CUSTOMER], claimUrl: CLAIM_URL }), h)).toBeUndefined()
    expect(h.log.warn).toHaveBeenCalledTimes(1)
    expect(plugin.buildIngest(assignment({ claimUrl: CLAIM_URL }), h)?.claimUrl).toBe(CLAIM_URL)
    expect(plugin.buildIngest(assignment({ tenantIds: [CUSTOMER] }), h)?.tenantIds).toEqual([CUSTOMER])
  })
})

describe('googlechat ingress plugin — the own-tenant fence of a single-tenant row (§10.3)', () => {
  const otherDomainMessage = edit(dmMessage, (e) => (e.chat.user.domainId = '0000000009'))
  const refusals = (h: RelayIngressHost) =>
    vi.mocked(h.log.warn).mock.calls.filter(([line]) => String(line).includes('another Workspace customer')).length

  it('learns its customer from the first Space, reports it once, and refuses another customer’s Spaces', async () => {
    const s = setup()
    expect((await deliver(s, spaceMention)).handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(s.h.reportTenant).toHaveBeenCalledWith(BOT_ID, CUSTOMER)
    await deliver(s, spaceMention)
    expect(s.h.reportTenant).toHaveBeenCalledTimes(1)
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(2)
    const marks = vi.mocked(s.h.dedupMark).mock.calls.length
    // Another customer's Space: nothing forwarded, reported, or marked, a 200 Google never retries, one log line a minute.
    expect((await deliver(s, otherCustomerMention)).handled).toEqual({})
    expect((await deliver(s, otherCustomerMention)).handled).toEqual({})
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(2)
    expect(s.h.reportTenant).toHaveBeenCalledTimes(1)
    expect(vi.mocked(s.h.dedupMark).mock.calls.length).toBe(marks)
    expect(refusals(s.h)).toBe(1)
  })

  it('passes every DM and records each domain once, whether or not the customer is known yet', async () => {
    const s = setup()
    for (const event of [dmMessage, dmMessage, spaceMention, otherDomainMessage, otherDomainMessage]) {
      expect((await deliver(s, event)).handled).toEqual({ admission: { disposition: 'admitted' } })
    }
    expect(s.h.forwardStrict).toHaveBeenCalledTimes(5)
    expect(vi.mocked(s.h.reportTenant).mock.calls).toEqual([
      [BOT_ID, DOMAIN],
      [BOT_ID, CUSTOMER],
      [BOT_ID, 'domains/0000000009']
    ])
  })

  it('is seeded from the assignment’s recorded keys, so the fence survives a rebuild and reports nothing it knows', async () => {
    const s = setup({ ownTenantIds: [OTHER_CUSTOMER, DOMAIN] })
    expect((await deliver(s, spaceMention)).handled).toEqual({})
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect((await deliver(s, dmMessage)).handled).toEqual({ admission: { disposition: 'admitted' } })
    expect(s.h.reportTenant).not.toHaveBeenCalled()
  })

  it('refuses a foreign customer’s add event before any membership is reported', async () => {
    const s = setup({ ownTenantIds: [CUSTOMER] })
    const foreignAdd = edit(spaceAdded, (e) => (e.chat.addedToSpacePayload.space.customer = OTHER_CUSTOMER))
    expect((await deliver(s, foreignAdd)).handled).toEqual({})
    expect(s.h.reportChannels).not.toHaveBeenCalled()
    expect(s.h.forwardStrict).not.toHaveBeenCalled()
    expect(refusals(s.h)).toBe(1)
  })

  it('never reports for a customer row or the anchor: core fences the one and the claim serves the other', async () => {
    const customer = setup({ tenantIds: [CUSTOMER, DOMAIN] })
    await deliver(customer, spaceMention)
    expect(customer.h.forwardStrict).toHaveBeenCalledTimes(1)
    expect(customer.h.reportTenant).not.toHaveBeenCalled()
    const anchored = setup({ claimUrl: CLAIM_URL })
    await deliver(anchored, spaceMention)
    expect(anchored.h.reportTenant).not.toHaveBeenCalled()
  })

  it('refuses an assignment that records own keys on a customer row or the anchor', () => {
    const { plugin } = setup()
    const h = host()
    expect(plugin.buildIngest(assignment({ ownTenantIds: [CUSTOMER], tenantIds: [CUSTOMER] }), h)).toBeUndefined()
    expect(plugin.buildIngest(assignment({ ownTenantIds: [CUSTOMER], claimUrl: CLAIM_URL }), h)).toBeUndefined()
    expect(plugin.buildIngest(assignment({ ownTenantIds: [CUSTOMER] }), h)?.singleTenant).toBe(true)
    expect(plugin.buildIngest(assignment({ tenantIds: [CUSTOMER] }), h)?.singleTenant).toBe(false)
  })
})
