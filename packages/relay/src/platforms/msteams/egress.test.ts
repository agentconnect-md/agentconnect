// The deployment Teams app's relay egress (teams-integration.md §8.5): tickets, the host fence, the fixed operations, and Graph tokens for one tenant.
import { describe, expect, it, vi } from 'vitest'
import { WireMsTeamsCall, type RcMsTeamsDeploymentApp, type WireMsTeamsCallResult } from '@agentconnect.md/protocol'
import { MSTEAMS_BOT_SCOPE, MSTEAMS_GRAPH_SCOPE, MsTeamsRelayEgress } from './egress.js'
import { allowedMsTeamsServiceUrl, mintMsTeamsTicket, openMsTeamsTicket } from './ticket.js'
import { createMsTeamsIngressPlugin } from './ingress-plugin.js'
import type { RelayAdmission, RelayIngressHost } from '../contract.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import { NOW, bearer, fakeBotFramework } from '../../../test/fixtures/msteams-token.js'
import {
  APP_ID,
  CHANNEL,
  OTHER_APP_ID,
  OTHER_TENANT,
  SERVICE_URL,
  TEAM,
  TENANT,
  cardClick,
  channelMention
} from '../../../test/fixtures/msteams-activities.js'

const HOME = '00000000-0000-4000-8000-0000000000ff'
const BOT_ROW = '11111111-1111-4111-8111-111111111111'
const OTHER_ROW = '55555555-5555-4555-8555-555555555555'
const KEY_TEXT = Buffer.alloc(32, 7).toString('base64url')
const KEY = Buffer.from(KEY_TEXT, 'base64url')
const APP: RcMsTeamsDeploymentApp = {
  appId: APP_ID,
  tenantId: HOME,
  clientSecret: 'deployment-secret-example',
  ticketKey: KEY_TEXT
}
const BINDING = { botId: BOT_ROW, tenantId: TENANT }
const THREAD = `${CHANNEL};messageid=1767225600000`

describe('conversation tickets', () => {
  const ticket = mintMsTeamsTicket(KEY, BINDING, { conversationId: THREAD, serviceUrl: SERVICE_URL })!

  it('vouch for the conversation, its threads included, and the service URL its activity came from', () => {
    expect(openMsTeamsTicket(KEY, BINDING, ticket)).toEqual({ conversationId: CHANNEL, serviceUrl: SERVICE_URL })
    expect(ticket.startsWith('t1.')).toBe(true)
  })

  it('hold for no other bot row, tenant or key', () => {
    expect(openMsTeamsTicket(KEY, { ...BINDING, botId: OTHER_ROW }, ticket)).toBeUndefined()
    expect(openMsTeamsTicket(KEY, { ...BINDING, tenantId: OTHER_TENANT }, ticket)).toBeUndefined()
    expect(openMsTeamsTicket(Buffer.alloc(32, 8), BINDING, ticket)).toBeUndefined()
  })

  it('refuse a tampered conversation, service URL or MAC', () => {
    const [version, , mac] = ticket.split('.')
    const forged = Buffer.from(JSON.stringify(['19:other@thread.tacv2', SERVICE_URL])).toString('base64url')
    expect(openMsTeamsTicket(KEY, BINDING, `${version}.${forged}.${mac}`)).toBeUndefined()
    const elsewhere = Buffer.from(JSON.stringify([CHANNEL, 'https://attacker.example.test/'])).toString('base64url')
    expect(openMsTeamsTicket(KEY, BINDING, `${version}.${elsewhere}.${mac}`)).toBeUndefined()
    expect(openMsTeamsTicket(KEY, BINDING, `${ticket}x`)).toBeUndefined()
    expect(openMsTeamsTicket(KEY, BINDING, ticket.replace(/^t1\./, 't2.'))).toBeUndefined()
  })

  it('are never minted for a host outside the Bot Connector allowlist', () => {
    expect(mintMsTeamsTicket(KEY, BINDING, { conversationId: CHANNEL, serviceUrl: 'https://example.test/' })).toBe(
      undefined
    )
    expect(allowedMsTeamsServiceUrl('https://smba.trafficmanager.net/teams/')).toBe(true)
    expect(allowedMsTeamsServiceUrl('https://smba.infra.gcc.teams.microsoft.com/teams')).toBe(true)
    expect(allowedMsTeamsServiceUrl('https://smba.infra.gov.teams.microsoft.us/teams')).toBe(true)
    expect(allowedMsTeamsServiceUrl('https://smba.infra.dod.teams.microsoft.us/teams')).toBe(true)
    expect(allowedMsTeamsServiceUrl('http://smba.trafficmanager.net/teams/')).toBe(false)
    expect(allowedMsTeamsServiceUrl('https://smba.trafficmanager.net:8443/teams/')).toBe(false)
    expect(allowedMsTeamsServiceUrl('https://user@smba.trafficmanager.net/teams/')).toBe(false)
    expect(allowedMsTeamsServiceUrl('https://smba.trafficmanager.net.example.test/teams/')).toBe(false)
  })
})

interface Sent {
  url: string
  method: string
  authorization?: string
  body?: Record<string, unknown>
}

/** Entra and the Bot Connector, scripted: tokens by tenant and scope, connector answers in order. */
function microsoft(answers: { status: number; body?: unknown }[] = [], tokenStatus = 200) {
  const sent: Sent[] = []
  const tokens: { tenant: string; scope: string }[] = []
  let minted = 0
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    const token = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(target)
    if (token) {
      const scope = new URLSearchParams(String(init?.body)).get('scope')!
      tokens.push({ tenant: decodeURIComponent(token[1]!), scope })
      minted += 1
      return Response.json(
        tokenStatus === 200 ? { access_token: `tok-${minted}`, expires_in: 3600 } : { error: 'invalid_client' },
        { status: tokenStatus }
      )
    }
    const headers = (init?.headers ?? {}) as Record<string, string>
    sent.push({
      url: target,
      method: init?.method ?? 'GET',
      ...(headers.authorization ? { authorization: headers.authorization } : {}),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {})
    })
    const next = answers.shift() ?? { status: 200, body: {} }
    return Response.json(next.body ?? {}, { status: next.status })
  }) as typeof fetch
  return { fetchImpl, sent, tokens }
}

const resultOf = (reply: Awaited<ReturnType<MsTeamsRelayEgress['call']>>) => {
  expect(reply.outcome).toBe('ok')
  return reply.payload as WireMsTeamsCallResult
}

describe('MsTeamsRelayEgress', () => {
  const ticket = mintMsTeamsTicket(KEY, BINDING, { conversationId: THREAD, serviceUrl: SERVICE_URL })!
  const teamTicket = mintMsTeamsTicket(KEY, BINDING, { conversationId: TEAM, serviceUrl: SERVICE_URL })!

  it('posts at the ticket’s service URL with a home-tenant Bot Connector token', async () => {
    const ms = microsoft([{ status: 201, body: { id: 'act-1' } }])
    const egress = new MsTeamsRelayEgress(APP, ms.fetchImpl, () => NOW)
    const result = resultOf(
      await egress.call(BINDING, { op: 'post-activity', ticket, conversationId: THREAD, activity: { text: 'hi' } })
    )
    expect(result).toEqual({ status: 201, body: { id: 'act-1' } })
    expect(ms.tokens).toEqual([{ tenant: HOME, scope: MSTEAMS_BOT_SCOPE }])
    expect(ms.sent).toEqual([
      {
        url: `${SERVICE_URL}v3/conversations/${encodeURIComponent(THREAD)}/activities`,
        method: 'POST',
        authorization: 'Bearer tok-1',
        body: { text: 'hi' }
      }
    ])
  })

  it('refuses a call for another conversation, bot row or tenant than its ticket, sending nothing', async () => {
    const ms = microsoft()
    const egress = new MsTeamsRelayEgress(APP, ms.fetchImpl, () => NOW)
    const other: WireMsTeamsCall = { op: 'delete-activity', ticket, conversationId: '19:x@thread.v2', activityId: '1' }
    expect(await egress.call(BINDING, other)).toEqual({ outcome: 'refused', reason: 'ticket_mismatch' })
    const call: WireMsTeamsCall = { op: 'delete-activity', ticket, conversationId: CHANNEL, activityId: '1' }
    expect(await egress.call({ ...BINDING, botId: OTHER_ROW }, call)).toEqual({ outcome: 'refused', reason: 'ticket' })
    expect(await egress.call({ ...BINDING, tenantId: OTHER_TENANT }, call)).toEqual({
      outcome: 'refused',
      reason: 'ticket'
    })
    expect(await egress.call(BINDING, { op: 'get-team', ticket, teamId: TEAM })).toEqual({
      outcome: 'refused',
      reason: 'ticket_mismatch'
    })
    expect(ms.sent).toEqual([])
    expect(ms.tokens).toEqual([])
  })

  it('opens a 1:1 chat in the row’s own tenant whatever the daemon wanted, and tickets the new chat', async () => {
    const ms = microsoft([{ status: 201, body: { id: 'a:new-chat' } }])
    const egress = new MsTeamsRelayEgress(APP, ms.fetchImpl, () => NOW)
    const result = resultOf(await egress.call(BINDING, { op: 'create-conversation', ticket, memberId: '29:member' }))
    expect(ms.sent[0]!.url).toBe(`${SERVICE_URL}v3/conversations`)
    expect(ms.sent[0]!.body).toEqual({
      isGroup: false,
      bot: { id: `28:${APP_ID}` },
      members: [{ id: '29:member' }],
      tenantId: TENANT,
      channelData: { tenant: { id: TENANT } }
    })
    expect(openMsTeamsTicket(KEY, BINDING, result.tickets!['a:new-chat']!)).toEqual({
      conversationId: 'a:new-chat',
      serviceUrl: SERVICE_URL
    })
  })

  it('tickets each channel a ticketed team lists', async () => {
    const ms = microsoft([{ status: 200, body: { conversations: [{ id: TEAM }, { id: CHANNEL, name: 'Design' }] } }])
    const egress = new MsTeamsRelayEgress(APP, ms.fetchImpl, () => NOW)
    const result = resultOf(
      await egress.call(BINDING, { op: 'get-team-conversations', ticket: teamTicket, teamId: TEAM })
    )
    expect(ms.sent[0]!.url).toBe(`${SERVICE_URL}v3/teams/${encodeURIComponent(TEAM)}/conversations`)
    expect(Object.keys(result.tickets!)).toEqual([TEAM, CHANNEL])
    expect(openMsTeamsTicket(KEY, BINDING, result.tickets![CHANNEL]!)?.conversationId).toBe(CHANNEL)
  })

  it('pages members with the fixed page size and the continuation the daemon passed', async () => {
    const ms = microsoft()
    const egress = new MsTeamsRelayEgress(APP, ms.fetchImpl, () => NOW)
    await egress.call(BINDING, { op: 'get-paged-members', ticket, conversationId: CHANNEL, continuationToken: 'c1' })
    expect(ms.sent[0]!.url).toBe(
      `${SERVICE_URL}v3/conversations/${encodeURIComponent(CHANNEL)}/pagedmembers?pageSize=100&continuationToken=c1`
    )
  })

  it('mints a Graph token for the row’s own tenant only', async () => {
    const ms = microsoft()
    const egress = new MsTeamsRelayEgress(APP, ms.fetchImpl, () => NOW)
    const result = resultOf(await egress.call(BINDING, { op: 'graph-token' }))
    expect(result.status).toBe(200)
    expect(result.body?.access_token).toBe('tok-1')
    expect(ms.tokens).toEqual([{ tenant: TENANT, scope: MSTEAMS_GRAPH_SCOPE }])
  })

  it('retries a 401 once with a fresh token, and reads an Entra refusal as the credential’s', async () => {
    const ms = microsoft([{ status: 401 }, { status: 200, body: { id: 'x' } }])
    const egress = new MsTeamsRelayEgress(APP, ms.fetchImpl, () => NOW)
    const result = resultOf(
      await egress.call(BINDING, { op: 'get-member', ticket, conversationId: CHANNEL, memberId: 'm' })
    )
    expect(result.status).toBe(200)
    expect(ms.sent.map((s) => s.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2'])

    const refused = microsoft([], 400)
    const denied = new MsTeamsRelayEgress(APP, refused.fetchImpl, () => NOW)
    expect(resultOf(await denied.call(BINDING, { op: 'get-team', ticket: teamTicket, teamId: TEAM })).status).toBe(401)
    expect(refused.sent).toEqual([])
  })

  it('refuses a dot segment that would leave the operation’s path, sending nothing', async () => {
    const ms = microsoft()
    const egress = new MsTeamsRelayEgress(APP, ms.fetchImpl, () => NOW)
    for (const id of ['..', '.'])
      for (const call of [
        { op: 'delete-activity', ticket, conversationId: CHANNEL, activityId: id },
        { op: 'get-member', ticket, conversationId: CHANNEL, memberId: id },
        { op: 'update-activity', ticket, conversationId: CHANNEL, activityId: id, activity: {} }
      ] as WireMsTeamsCall[])
        expect(await egress.call(BINDING, call)).toEqual({ outcome: 'refused', reason: 'invalid' })
    expect(ms.sent).toEqual([])
    expect(ms.tokens).toEqual([])
    expect(
      WireMsTeamsCall.safeParse({ op: 'delete-activity', ticket, conversationId: CHANNEL, activityId: '..' }).success
    ).toBe(false)
    expect(WireMsTeamsCall.safeParse({ op: 'get-team', ticket, teamId: '.' }).success).toBe(false)
  })

  it('answers within its budget: a slow token sends nothing, and a slow send reads as one that may have landed', async () => {
    const BUDGET = 150
    const hang = new Promise<Response>(() => {})
    // Entra never answers: nothing reached Microsoft, and the relay says so before the daemon stops waiting.
    const silentEntra = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('login.microsoftonline.com')) return hang
      return Response.json({}, { status: init?.method === 'POST' ? 201 : 200 })
    }) as typeof fetch
    const slowToken = new MsTeamsRelayEgress(APP, silentEntra, () => NOW, BUDGET)
    const started = Date.now()
    const call: WireMsTeamsCall = { op: 'post-activity', ticket, conversationId: CHANNEL, activity: {} }
    expect(await slowToken.call(BINDING, call)).toEqual({ outcome: 'unavailable', reason: 'deadline' })
    expect(await slowToken.call(BINDING, { op: 'graph-token' })).toEqual({ outcome: 'unavailable', reason: 'deadline' })

    // The Bot Connector never answers: the send is cut off inside the budget and answered as a gateway timeout.
    const silentConnector = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('login.microsoftonline.com'))
        return Response.json({ access_token: 'tok', expires_in: 3600 })
      return await new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      )
    }) as typeof fetch
    const slowSend = new MsTeamsRelayEgress(APP, silentConnector, () => NOW, 1_200)
    expect(resultOf(await slowSend.call(BINDING, call)).status).toBe(504)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('the Teams plugin for a deployment app’s rows', () => {
  const TARGET = {
    agentId: '22222222-2222-4222-8222-222222222222',
    integrationId: '33333333-3333-4333-8333-333333333333',
    daemonId: '44444444-4444-4444-8444-444444444444'
  }
  const host = (): RelayIngressHost =>
    ({
      forwardStrict: vi.fn(async (): Promise<RelayAdmission> => ({ disposition: 'admitted' })),
      forwardAction: vi.fn(async (msg: { msgId: string }) => ({ msgId: msg.msgId, accepted: true })),
      directory: { soleTarget: () => TARGET },
      dedupPeek: () => false,
      dedupMark: () => {},
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    }) as unknown as RelayIngressHost
  const assignment = (over: Partial<BotAssignment> = {}): BotAssignment => ({
    botId: BOT_ROW,
    platform: 'msteams',
    secrets: {},
    apiAppId: APP_ID,
    teamId: TENANT,
    members: [{ daemonId: TARGET.daemonId, agentIds: [TARGET.agentId] }],
    agents: [],
    routes: [],
    ...over
  })

  async function deliver(over: Partial<BotAssignment>, activity: unknown) {
    const bf = fakeBotFramework()
    const plugin = createMsTeamsIngressPlugin({ fetch: bf.fetchImpl })
    plugin.deploymentAssignments!({ revision: 0, msTeamsApp: APP })
    const h = host()
    const ingest = plugin.buildIngest(assignment(over), h)!
    const verified = await plugin.verify(ingest, Buffer.from(''), activity, { authorization: await bearer() }, NOW)
    await plugin.handle(ingest, verified!, h)
    return h
  }

  it('tickets a forwarded message’s conversation and team for the row', async () => {
    const h = await deliver({}, channelMention)
    const message = vi.mocked(h.forwardStrict).mock.calls[0]![1]
    const ext = message.adapterExt!.msteams as { ticket: string; teamTicket: string }
    expect(openMsTeamsTicket(KEY, BINDING, ext.ticket)?.conversationId).toBe(CHANNEL)
    expect(openMsTeamsTicket(KEY, BINDING, ext.teamTicket)?.conversationId).toBe(TEAM)
  })

  it('tickets a card click', async () => {
    const h = await deliver({}, cardClick)
    const action = vi.mocked(h.forwardAction).mock.calls[0]![0]
    expect(typeof (action.payload as { ticket?: unknown }).ticket).toBe('string')
  })

  it('tickets nothing for an organization’s own bot', async () => {
    const bf = fakeBotFramework()
    const plugin = createMsTeamsIngressPlugin({ fetch: bf.fetchImpl })
    plugin.deploymentAssignments!({ revision: 0, msTeamsApp: { ...APP, appId: OTHER_APP_ID } })
    const h = host()
    const ingest = plugin.buildIngest(assignment(), h)!
    const verified = await plugin.verify(
      ingest,
      Buffer.from(''),
      channelMention,
      { authorization: await bearer() },
      NOW
    )
    await plugin.handle(ingest, verified!, h)
    const ext = vi.mocked(h.forwardStrict).mock.calls[0]![1].adapterExt!.msteams as Record<string, unknown>
    expect(ext.ticket).toBeUndefined()
    expect(ext.teamTicket).toBeUndefined()
  })

  it('answers a daemon’s call only for a deployment app’s row, and only a known operation', async () => {
    const ms = microsoft([{ status: 201, body: { id: 'act-1' } }])
    const plugin = createMsTeamsIngressPlugin({ fetch: ms.fetchImpl })
    plugin.deploymentAssignments!({ revision: 0, msTeamsApp: APP })
    const ticket = mintMsTeamsTicket(KEY, BINDING, { conversationId: CHANNEL, serviceUrl: SERVICE_URL })!
    const post = { op: 'post-activity', ticket, conversationId: CHANNEL, activity: {} }
    expect(await plugin.daemonRequest!(assignment({ apiAppId: OTHER_APP_ID }), post)).toEqual({
      outcome: 'refused',
      reason: 'not_deployment_app',
      retryable: false
    })
    expect(await plugin.daemonRequest!(assignment(), { op: 'get-anything', path: '/v3/x' })).toEqual({
      outcome: 'refused',
      reason: 'invalid'
    })
    expect((await plugin.daemonRequest!(assignment(), post)).outcome).toBe('ok')

    plugin.deploymentAssignments!({ revision: 0 })
    expect(await plugin.daemonRequest!(assignment(), post)).toEqual({
      outcome: 'refused',
      reason: 'not_deployment_app',
      retryable: true
    })
  })
})
