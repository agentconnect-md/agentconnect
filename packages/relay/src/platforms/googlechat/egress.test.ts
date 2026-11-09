// The deployment Google Chat app's relay egress (google-chat-integration.md §10.10): tokens, the fixed operations, the customer fence, the row's share and the one budget.
import { generateKeyPairSync } from 'node:crypto'
import { decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'
import {
  WireGoogleChatCall,
  type RcGoogleChatDeploymentApp,
  type RdPlatformReply,
  type WireGoogleChatCallResult
} from '@agentconnect.md/protocol'
import {
  GOOGLE_CHAT_BOT_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleChatRelayEgress,
  type GoogleChatEgressRow
} from './egress.js'
import { createGoogleChatIngressPlugin } from './ingress-plugin.js'
import type { BotAssignment } from '../../bot-arbitration.js'

const PROJECT_NUMBER = '100000000000'
const BOT_ID = '11111111-1111-4111-8111-111111111111'
const OWN_CUSTOMER = 'customers/C0000000001'
const OTHER_CUSTOMER = 'customers/C0000000002'
const OWN_DOMAIN = '0000000001'
const SPACE = 'spaces/OWN_SPACE'
const OTHER_SPACE = 'spaces/OTHER_SPACE'
const DM = 'spaces/OWN_DM'
const OTHER_DM = 'spaces/OTHER_DM'
const CHAT = 'https://chat.googleapis.com/v1'
const ROW: GoogleChatEgressRow = { botId: BOT_ID, tenantIds: [OWN_CUSTOMER, `domains/${OWN_DOMAIN}`] }

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyJson = (id = 'kid-1') =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: id,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'chat-app@example.test'
  })
const APP: RcGoogleChatDeploymentApp = { projectNumber: PROJECT_NUMBER, serviceAccountKey: keyJson() }

interface Sent {
  method: string
  url: URL
  auth?: string
  body?: Record<string, unknown>
}

const human = (domainId?: string) => ({
  member: { name: 'users/1', type: 'HUMAN', ...(domainId ? { domainId } : {}) }
})

// A fake Google: named Spaces, DMs and their one human, with per-call overrides.
function google(overrides: (sent: Sent) => Response | undefined | Promise<Response | undefined> = () => undefined) {
  const sent: Sent[] = []
  let minted = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.href === GOOGLE_TOKEN_ENDPOINT) {
      minted += 1
      return Response.json({ access_token: `token-${minted}`, expires_in: 3600 })
    }
    const entry: Sent = {
      method: init?.method ?? 'GET',
      url,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {})
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    if (auth) entry.auth = auth
    sent.push(entry)
    const override = await overrides(entry)
    if (override) return override
    const path = url.pathname
    if (path === `/v1/${SPACE}`) return Response.json({ name: SPACE, spaceType: 'SPACE', customer: OWN_CUSTOMER })
    if (path === `/v1/${OTHER_SPACE}`)
      return Response.json({ name: OTHER_SPACE, spaceType: 'SPACE', customer: OTHER_CUSTOMER })
    if (path === `/v1/${DM}`) return Response.json({ name: DM, spaceType: 'DIRECT_MESSAGE' })
    if (path === `/v1/${OTHER_DM}`) return Response.json({ name: OTHER_DM, spaceType: 'DIRECT_MESSAGE' })
    if (path === `/v1/${DM}/members`) return Response.json({ memberships: [human(OWN_DOMAIN)] })
    if (path === `/v1/${OTHER_DM}/members`) return Response.json({ memberships: [human('0000000002')] })
    if (entry.method === 'POST') return Response.json({ name: `${path.slice(4)}/m1` })
    return Response.json({})
  }) as typeof fetch
  return { fetchImpl, sent, minted: () => minted }
}

const writes = (sent: Sent[]) => sent.filter((call) => call.method !== 'GET')
const resultOf = (reply: RdPlatformReply) => {
  expect(reply.outcome).toBe('ok')
  return reply.payload as WireGoogleChatCallResult
}

const egress = (fetchImpl: typeof fetch, options: ConstructorParameters<typeof GoogleChatRelayEgress>[2] = {}) =>
  new GoogleChatRelayEgress(APP, fetchImpl, options)

const create = (over: Partial<Extract<WireGoogleChatCall, { op: 'create-message' }>> = {}): WireGoogleChatCall => ({
  op: 'create-message',
  space: SPACE,
  requestId: 'client-1',
  text: 'hello',
  ...over
})

describe('the wire call', () => {
  it('takes Google’s own names and refuses a dot segment or anything else in a path', () => {
    const parse = (call: unknown) => WireGoogleChatCall.safeParse(call).success
    expect(parse({ op: 'get-message', message: `${SPACE}/messages/ABC.DEF_-1` })).toBe(true)
    expect(parse({ op: 'get-message', message: `${SPACE}/messages/..` })).toBe(false)
    expect(parse({ op: 'get-message', message: 'spaces/../messages/x' })).toBe(false)
    expect(parse({ op: 'get-message', message: `${SPACE}/messages/a/b` })).toBe(false)
    expect(parse({ op: 'get-message', message: `${SPACE}/messages/a%2Fb` })).toBe(false)
    expect(parse({ op: 'get-space', space: 'spaces/.' })).toBe(false)
    expect(parse({ op: 'get-space', space: 'spaces/' })).toBe(false)
    expect(parse({ op: 'get-space', space: 'projects/x' })).toBe(false)
    expect(parse({ op: 'find-direct-message', user: 'users/..' })).toBe(false)
    expect(parse({ op: 'list-members', space: SPACE, pageToken: '' })).toBe(false)
    expect(parse({ op: 'list-members', space: 'spaces/..' })).toBe(false)
    expect(parse({ op: 'delete-space', space: SPACE })).toBe(false)
    expect(parse({ ...create(), thread: `${SPACE}/threads/..` })).toBe(false)
  })
})

describe('GoogleChatRelayEgress', () => {
  it('mints a chat.bot token as the service account, caches it, and never impersonates anyone', async () => {
    const assertions: string[] = []
    const inner = google()
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === GOOGLE_TOKEN_ENDPOINT)
        assertions.push(new URLSearchParams(init?.body as string).get('assertion')!)
      return inner.fetchImpl(input, init)
    }) as typeof fetch
    const e = egress(fetchImpl)
    await e.call(ROW, { op: 'get-space', space: SPACE })
    await e.call(ROW, { op: 'get-space', space: SPACE })
    expect(assertions).toHaveLength(1)
    const claims = decodeJwt(assertions[0]!)
    expect(claims).toMatchObject({
      iss: 'chat-app@example.test',
      aud: GOOGLE_TOKEN_ENDPOINT,
      scope: GOOGLE_CHAT_BOT_SCOPE
    })
    expect(claims).not.toHaveProperty('sub')
    expect(inner.sent[0]?.auth).toBe('Bearer token-1')
  })

  it('builds each operation’s fixed request itself', async () => {
    const g = google()
    const e = egress(g.fetchImpl)
    const message = `${SPACE}/messages/client-1`
    const calls: [WireGoogleChatCall, string, string][] = [
      [
        create({ messageId: 'client-1', thread: `${SPACE}/threads/t1` }),
        'POST',
        `${CHAT}/${SPACE}/messages?messageId=client-1&requestId=client-1&messageReplyOption=REPLY_MESSAGE_OR_FAIL`
      ],
      [{ op: 'patch-text', message, text: 'edit' }, 'PATCH', `${CHAT}/${message}?updateMask=text`],
      [{ op: 'patch-cards', message, cardsV2: [{ cardId: 'c' }] }, 'PATCH', `${CHAT}/${message}?updateMask=cardsV2`],
      [{ op: 'delete-message', message }, 'DELETE', `${CHAT}/${message}`],
      [{ op: 'get-message', message }, 'GET', `${CHAT}/${message}`],
      [{ op: 'get-space', space: SPACE }, 'GET', `${CHAT}/${SPACE}`]
    ]
    for (const [call, method, url] of calls) {
      g.sent.length = 0
      resultOf(await e.call(ROW, call))
      expect(g.sent.at(-1)?.method).toBe(method)
      expect(g.sent.at(-1)?.url.href).toBe(url)
    }
    g.sent.length = 0
    resultOf(await e.call(ROW, create({ cardsV2: [{ cardId: 'c' }], privateViewer: 'users/2' })))
    expect(g.sent.at(-1)?.body).toEqual({
      text: 'hello',
      markupSyntax: 'MARKUP_SYNTAX_MARKDOWN',
      cardsV2: [{ cardId: 'c' }],
      privateMessageViewer: { name: 'users/2' }
    })
    resultOf(await e.call(ROW, { op: 'list-dm-humans', space: DM }))
    expect(g.sent.at(-1)?.url.searchParams.get('filter')).toBe('member.type = "HUMAN"')
    expect(g.sent.at(-1)?.url.searchParams.get('pageSize')).toBe('2')
    resultOf(await e.call(ROW, { op: 'list-members', space: SPACE, pageToken: 'next/page' }))
    expect(g.sent.at(-1)?.url.pathname).toBe(`/v1/${SPACE}/members`)
    expect(g.sent.at(-1)?.url.searchParams.get('filter')).toBe('member.type = "HUMAN"')
    expect(g.sent.at(-1)?.url.searchParams.get('pageToken')).toBe('next/page')
    expect(g.sent.at(-1)?.url.searchParams.get('pageSize')).toBe('100')
  })

  it('refuses a thread of another Space before any Google call', async () => {
    const g = google()
    const reply = await egress(g.fetchImpl).call(ROW, create({ thread: `${OTHER_SPACE}/threads/t1` }))
    expect(reply).toEqual({ outcome: 'refused', reason: 'invalid' })
    expect(g.sent).toEqual([])
  })

  it('refuses a path a dot segment would rewrite, even past the schema', async () => {
    const g = google()
    const e = egress(g.fetchImpl)
    expect(await e.call(ROW, { op: 'get-space', space: 'spaces/..' })).toEqual({
      outcome: 'refused',
      reason: 'invalid'
    })
    expect(g.sent).toEqual([])
    // Past a fence that passed, the operation itself still stays on its fixed path.
    const reply = await e.call(ROW, { op: 'delete-message', message: `${SPACE}/messages/../../b` })
    expect(reply).toEqual({ outcome: 'refused', reason: 'invalid' })
    expect(writes(g.sent)).toEqual([])
  })

  describe('the customer fence', () => {
    it('refuses every operation on another customer’s Space, and writes nothing there', async () => {
      const g = google()
      const e = egress(g.fetchImpl)
      const message = `${OTHER_SPACE}/messages/m1`
      for (const call of [
        create({ space: OTHER_SPACE }),
        { op: 'patch-text', message, text: 'x' },
        { op: 'patch-cards', message, cardsV2: [] },
        { op: 'delete-message', message },
        { op: 'get-message', message },
        { op: 'get-space', space: OTHER_SPACE },
        { op: 'list-dm-humans', space: OTHER_SPACE },
        { op: 'list-members', space: OTHER_SPACE, pageToken: 'next/page' }
      ] as WireGoogleChatCall[])
        expect(await e.call(ROW, call)).toEqual({ outcome: 'refused', reason: 'tenant_refused' })
      expect(writes(g.sent)).toEqual([])
      // Only the Space read the fence itself needed, and once: its customer is immutable.
      expect(g.sent.map((call) => call.url.pathname)).toEqual([`/v1/${OTHER_SPACE}`])
    })

    it('admits a DM by its one human’s domain and refuses another’s', async () => {
      const g = google()
      const e = egress(g.fetchImpl)
      resultOf(await e.call(ROW, create({ space: DM })))
      expect(await e.call(ROW, create({ space: OTHER_DM }))).toEqual({ outcome: 'refused', reason: 'tenant_refused' })
      expect(writes(g.sent).map((call) => call.url.pathname)).toEqual([`/v1/${DM}/messages`])
    })

    it('refuses a Space with no customer and a DM with no or several humans', async () => {
      const g = google((sent) => {
        if (sent.url.pathname === `/v1/${SPACE}`) return Response.json({ name: SPACE, spaceType: 'GROUP_CHAT' })
        if (sent.url.pathname === `/v1/${DM}/members`)
          return Response.json({ memberships: [human(OWN_DOMAIN), human(OWN_DOMAIN)] })
        if (sent.url.pathname === `/v1/${OTHER_DM}/members`) return Response.json({ memberships: [human()] })
        return undefined
      })
      const e = egress(g.fetchImpl)
      for (const space of [SPACE, DM, OTHER_DM])
        expect(await e.call(ROW, create({ space }))).toEqual({ outcome: 'refused', reason: 'tenant_refused' })
      expect(writes(g.sent)).toEqual([])
    })

    it('fails closed when the lookup fails, and does not cache the failure', async () => {
      let answer: Response | undefined = new Response(null, { status: 503 })
      const g = google((sent) => (sent.url.pathname === `/v1/${SPACE}` ? answer : undefined))
      const e = egress(g.fetchImpl)
      expect(await e.call(ROW, create())).toEqual({ outcome: 'unavailable', reason: 'fence' })
      expect(writes(g.sent)).toEqual([])
      answer = new Response(null, { status: 403 })
      expect(resultOf(await e.call(ROW, create())).status).toBe(403)
      expect(writes(g.sent)).toEqual([])
      answer = undefined
      expect(resultOf(await e.call(ROW, create())).status).toBe(200)
      expect(writes(g.sent)).toHaveLength(1)
    })

    it('answers a lookup that got no answer as unsent, with nothing written', async () => {
      const g = google((sent) => {
        if (sent.url.pathname === `/v1/${SPACE}`) throw new Error('reset')
        return undefined
      })
      expect(await egress(g.fetchImpl).call(ROW, create())).toEqual({ outcome: 'unavailable', reason: 'fence' })
      expect(writes(g.sent)).toEqual([])
    })

    it('remembers a Space’s customer for its TTL and within its bound', async () => {
      let now = 1_000_000
      const g = google()
      const e = egress(g.fetchImpl, { now: () => now })
      await e.call(ROW, create())
      await e.call(ROW, create())
      expect(g.sent.filter((call) => call.method === 'GET')).toHaveLength(1)
      now += 2 * 60 * 60_000
      await e.call(ROW, create())
      expect(g.sent.filter((call) => call.method === 'GET')).toHaveLength(2)
    })

    it('fences a found DM before naming it to the daemon', async () => {
      const found = (space: string) => (sent: Sent) =>
        sent.url.pathname === '/v1/spaces:findDirectMessage'
          ? Response.json({ name: space, spaceType: 'DIRECT_MESSAGE' })
          : undefined
      const own = google(found(DM))
      expect(
        resultOf(await egress(own.fetchImpl).call(ROW, { op: 'find-direct-message', user: 'users/1' })).body
      ).toMatchObject({ name: DM })
      expect(own.sent[0]?.url.href).toBe(`${CHAT}/spaces:findDirectMessage?name=users%2F1`)
      const other = google(found(OTHER_DM))
      expect(await egress(other.fetchImpl).call(ROW, { op: 'find-direct-message', user: 'users/1' })).toEqual({
        outcome: 'refused',
        reason: 'tenant_refused'
      })
    })

    it('filters spaces.list to the row’s customer', async () => {
      const g = google((sent) =>
        sent.url.pathname === '/v1/spaces'
          ? Response.json({
              spaces: [
                { name: SPACE, spaceType: 'SPACE', customer: OWN_CUSTOMER },
                { name: OTHER_SPACE, spaceType: 'SPACE', customer: OTHER_CUSTOMER },
                { name: OTHER_DM, spaceType: 'DIRECT_MESSAGE' }
              ],
              nextPageToken: 'more'
            })
          : undefined
      )
      const result = resultOf(await egress(g.fetchImpl).call(ROW, { op: 'list-spaces', pageToken: 'page' }))
      expect(result.body).toEqual({
        spaces: [{ name: SPACE, spaceType: 'SPACE', customer: OWN_CUSTOMER }],
        nextPageToken: 'more'
      })
      expect(g.sent[0]?.url.searchParams.get('pageToken')).toBe('page')
    })
  })

  describe('the row’s share of the project', () => {
    it('answers a 429 past the share, before any Google call, and refills with time', async () => {
      let now = 1_000_000
      const g = google()
      const e = egress(g.fetchImpl, { now: () => now, rowCallsPerMinute: 2 })
      resultOf(await e.call(ROW, create()))
      resultOf(await e.call(ROW, create()))
      const before = g.sent.length
      const limited = resultOf(await e.call(ROW, create()))
      expect(limited.status).toBe(429)
      expect(limited.retryAfterMs).toBeGreaterThan(0)
      expect(g.sent).toHaveLength(before)
      now += 30_000
      expect(resultOf(await e.call(ROW, create())).status).toBe(200)
    })

    it('holds one row’s writes apart from another’s and from its own reads', async () => {
      const g = google()
      const e = egress(g.fetchImpl, { now: () => 1_000_000, rowCallsPerMinute: 1 })
      resultOf(await e.call(ROW, create()))
      expect(resultOf(await e.call(ROW, create())).status).toBe(429)
      expect(resultOf(await e.call(ROW, { op: 'get-space', space: SPACE })).status).toBe(200)
      const other = { ...ROW, botId: '22222222-2222-4222-8222-222222222222' }
      expect(resultOf(await e.call(other, create())).status).toBe(200)
    })
  })

  describe('one budget, and what may have reached Google', () => {
    it('sends a create exactly once when Google does not answer, and reports the gateway timeout', async () => {
      const g = google((sent) => {
        if (sent.method === 'POST') throw new Error('reset after the write')
        return undefined
      })
      const reply = await egress(g.fetchImpl).call(ROW, create())
      expect(resultOf(reply).status).toBe(504)
      expect(writes(g.sent)).toHaveLength(1)
    })

    it('retries a 401 once with a fresh token, since Google answering it means nothing landed', async () => {
      let refusals = 1
      const g = google((sent) => {
        if (sent.method === 'POST' && refusals-- > 0) return new Response(null, { status: 401 })
        return undefined
      })
      expect(resultOf(await egress(g.fetchImpl).call(ROW, create())).status).toBe(200)
      expect(writes(g.sent).map((call) => call.auth)).toEqual(['Bearer token-1', 'Bearer token-2'])
    })

    it('answers a second 401 as Google’s, with no third send', async () => {
      const g = google((sent) => (sent.method === 'POST' ? new Response(null, { status: 401 }) : undefined))
      expect(resultOf(await egress(g.fetchImpl).call(ROW, create())).status).toBe(401)
      expect(writes(g.sent)).toHaveLength(2)
    })

    it('stops before the send, as unavailable, when the budget is gone', async () => {
      let elapsed = 0
      const g = google((sent) => {
        // The fence read spends the whole budget, so the operation never goes out.
        if (sent.method === 'GET') elapsed = 12_000
        return undefined
      })
      const reply = await egress(g.fetchImpl, { clock: () => elapsed }).call(ROW, create())
      expect(reply).toEqual({ outcome: 'unavailable', reason: 'deadline' })
      expect(writes(g.sent)).toEqual([])
    })

    it('reads a refused key as the credential’s and an unreachable token endpoint as unsent', async () => {
      const refused = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch
      expect(resultOf(await egress(refused).call(ROW, create())).status).toBe(401)
      const unreachable = (async () => {
        throw new Error('reset')
      }) as typeof fetch
      expect(await egress(unreachable).call(ROW, create())).toEqual({ outcome: 'unavailable', reason: 'token' })
    })

    it('does not ask Google again for a token it just refused', async () => {
      let mints = 0
      const fetchImpl = (async () => {
        mints += 1
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }) as typeof fetch
      const e = egress(fetchImpl)
      await e.call(ROW, create())
      await e.call(ROW, create())
      expect(mints).toBe(1)
    })

    it('never signs with a key it cannot read', async () => {
      const g = google()
      const e = new GoogleChatRelayEgress({ ...APP, serviceAccountKey: '{not json' }, g.fetchImpl)
      expect(resultOf(await e.call(ROW, create())).status).toBe(401)
      expect(g.minted()).toBe(0)
    })
  })

  it('takes a new key in place and forgets another project’s Spaces', async () => {
    const g = google()
    const e = egress(g.fetchImpl)
    await e.call(ROW, create())
    expect(g.minted()).toBe(1)
    e.update({ ...APP, serviceAccountKey: keyJson('kid-2') })
    await e.call(ROW, create())
    expect(g.minted()).toBe(2)
    const spaceReads = () => g.sent.filter((call) => call.method === 'GET').length
    expect(spaceReads()).toBe(1)
    e.update({ projectNumber: '200000000000', serviceAccountKey: APP.serviceAccountKey })
    await e.call(ROW, create())
    expect(spaceReads()).toBe(2)
  })
})

describe('the Google Chat plugin’s daemon requests', () => {
  const assignment = (over: Partial<BotAssignment> = {}): BotAssignment =>
    ({
      botId: BOT_ID,
      platform: 'googlechat',
      secrets: {},
      apiAppId: PROJECT_NUMBER,
      tenantIds: [OWN_CUSTOMER],
      members: [{ daemonId: 'd1' }],
      agents: [],
      routes: [],
      ...over
    }) as unknown as BotAssignment

  function plugin() {
    const g = google()
    const created = createGoogleChatIngressPlugin({ fetch: g.fetchImpl })
    return { plugin: created, g }
  }

  it('refuses, for another relay to answer, while its snapshot names no matching app', async () => {
    const { plugin: p, g } = plugin()
    const retryable = { outcome: 'refused', reason: 'not_deployment_app', retryable: true }
    const ask = () => p.daemonRequest!(assignment(), { op: 'get-space', space: SPACE })
    expect(await ask()).toEqual(retryable)
    p.deploymentAssignments!({ revision: 0, googleChatApp: { ...APP, projectNumber: '200000000000' } })
    expect(await ask()).toEqual(retryable)
    expect(g.sent).toEqual([])
  })

  it('refuses an organization’s own app, whose assignment names no customer keys', async () => {
    const { plugin: p, g } = plugin()
    p.deploymentAssignments!({ revision: 0, googleChatApp: APP })
    const own = assignment({ ownTenantIds: [OWN_CUSTOMER] } as Partial<BotAssignment>)
    delete (own as { tenantIds?: unknown }).tenantIds
    expect(await p.daemonRequest!(own, { op: 'get-space', space: SPACE })).toMatchObject({ outcome: 'refused' })
    expect(g.sent).toEqual([])
  })

  it('refuses a malformed call for good, and answers a well-formed one', async () => {
    const { plugin: p, g } = plugin()
    p.deploymentAssignments!({ revision: 0, googleChatApp: APP })
    expect(await p.daemonRequest!(assignment(), { op: 'get-message', message: 'spaces/x/messages/..' })).toEqual({
      outcome: 'refused',
      reason: 'invalid'
    })
    expect(await p.daemonRequest!(assignment(), { url: 'https://attacker.example.test/' })).toEqual({
      outcome: 'refused',
      reason: 'invalid'
    })
    expect(g.sent).toEqual([])
    const reply = await p.daemonRequest!(assignment(), { op: 'get-space', space: SPACE })
    expect(resultOf(reply).status).toBe(200)
  })

  it('fences by the assignment’s customer, whatever the payload carries', async () => {
    const { plugin: p, g } = plugin()
    p.deploymentAssignments!({ revision: 0, googleChatApp: APP })
    const reply = await p.daemonRequest!(assignment(), {
      op: 'get-space',
      space: OTHER_SPACE,
      tenantIds: [OTHER_CUSTOMER]
    })
    expect(reply).toEqual({ outcome: 'refused', reason: 'tenant_refused' })
    expect(writes(g.sent)).toEqual([])
  })

  it('drops the egress when a new snapshot carries no app', async () => {
    const { plugin: p } = plugin()
    p.deploymentAssignments!({ revision: 0, googleChatApp: APP })
    p.deploymentAssignments!({ revision: 1 })
    expect(await p.daemonRequest!(assignment(), { op: 'get-space', space: SPACE })).toMatchObject({
      outcome: 'refused',
      retryable: true
    })
  })
})
