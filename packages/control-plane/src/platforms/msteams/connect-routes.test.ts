/** Connecting a Microsoft 365 tenant to the deployment's Teams app (teams-integration.md §8.3), against fakes. */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from '../../http/deps.js'
import { installZod } from '../../http/plugins/zod.js'
import type { BotRecord } from '../../persistence/ports.js'
import { AgentId, BotId, OrgId } from '../../domain/ids.js'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { mintMsTeamsConnectState, msTeamsConnectKeys } from './connect.js'
import { msTeamsConnectRoutes } from './connect-routes.js'
import type { MsTeamsPlatformApp } from './deployment-app.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const OTHER_ORG = OrgId('22222222-2222-4222-8222-222222222222')
const AGENT = AgentId('77777777-7777-4777-8777-777777777777')
const OTHER_AGENT = AgentId('66666666-6666-4666-8666-666666666666')
const BOT = BotId('88888888-8888-4888-8888-888888888888')
const APP: MsTeamsPlatformApp = {
  appId: '33333333-3333-4333-8333-333333333333',
  tenantId: '44444444-4444-4444-8444-444444444444',
  clientSecret: 'synthetic-secret'
}
const CUSTOMER = '55555555-5555-4555-8555-555555555555'
const NOW = Date.parse('2026-12-01T00:00:00Z')
const clock = new FakeClock(NOW)
const keys = msTeamsConnectKeys('p'.repeat(40))

const idToken = (tid: string) => ['e30', Buffer.from(JSON.stringify({ tid })).toString('base64url'), 'sig'].join('.')

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function harness(
  opts: {
    held?: Partial<BotRecord>
    app?: MsTeamsPlatformApp | null
    tid?: string
    publish?: number
    organization?: string | null
  } = {}
) {
  const graph: { method: string; url: string; body?: unknown }[] = []
  // Every write in the order it ran, Graph and repository alike.
  const order: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth2/v2.0/token'))
      return Response.json({ access_token: 'delegated', id_token: idToken(opts.tid ?? CUSTOMER) })
    graph.push({ method: init?.method ?? 'GET', url, body: init?.body })
    if (url.includes('$filter')) return Response.json({ value: [] })
    if (url.includes('/appCatalogs/teamsApps')) {
      order.push('publish')
      return opts.publish
        ? new Response(null, { status: opts.publish })
        : Response.json({ id: 'catalog-1' }, { status: 201 })
    }
    if (url.includes('/me/joinedTeams')) return Response.json({ value: [{ id: 'team-1', displayName: 'Engineering' }] })
    if (url.includes('/organization'))
      return opts.organization === null
        ? new Response(null, { status: 403 })
        : Response.json({ value: [{ displayName: opts.organization ?? 'Example Org' }] })
    if (url.includes('/installedApps')) return new Response(null, { status: 201 })
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  const held = opts.held
    ? ({ id: BOT, orgId: ORG, name: 'Microsoft Teams', agentIds: [], ...opts.held } as BotRecord)
    : null
  const create = vi.fn(async (input: Record<string, unknown>) => {
    order.push('create')
    return { ...input, agentIds: [] } as unknown as BotRecord
  })
  const put = vi.fn(async () => {})
  const integrationCreate = vi.fn(async (input: Record<string, unknown>) => ({ ...input, status: 'active' }))
  const addBotMembership = vi.fn(async (input: Record<string, unknown>) => {
    order.push('membership')
    return { outcome: 'added', integration: input }
  })
  const credentialInstall = vi.fn(async () => 2)
  const syncBot = vi.fn(async () => {})
  const deps = {
    config: { PUBLIC_RELAY_URL: 'https://relay.example.test' },
    clock,
    httpBot: { hasConnectedRelay: () => true, syncBot },
    placementResolver: { servingDaemon: async () => null },
    repos: {
      agent: {
        get: async (_org: OrgId, id: AgentId) => ({
          id,
          orgId: ORG,
          name: 'helper',
          displayName: 'Helper',
          icon: null,
          runtime: 'claude',
          visibility: 'org'
        })
      },
      bot: { getByExternalIdentity: async () => held, create },
      botSecret: { put },
      botCredential: { install: credentialInstall },
      integration: { create: integrationCreate, addBotMembership }
    }
  } as unknown as HttpDeps
  const app = Fastify()
  installZod(app)
  app.addHook('onRequest', async (req) => {
    req.principal = { userId: 'user-1' } as never
    req.orgCtx = { orgId: ORG, role: 'collaborator', userId: 'user-1' } as never
  })
  const deploymentApp = opts.app === null ? undefined : (opts.app ?? APP)
  await app.register(
    msTeamsConnectRoutes(deps, {
      ...(deploymentApp ? { app: deploymentApp } : {}),
      keys,
      webAppUrl: 'https://console.example.test',
      fetch: fetchImpl
    })
  )
  running = app
  const state = (over: Partial<{ orgId: string; agentId: string; userId: string }> = {}) =>
    mintMsTeamsConnectState(keys, { orgId: ORG, agentId: AGENT, userId: 'user-1', ...over }, clock)
  const callback = (raw = state()) =>
    app.inject({ method: 'POST', url: '/integrations/msteams/connect/callback', payload: { code: 'c', state: raw } })
  return {
    app,
    graph,
    order,
    create,
    put,
    integrationCreate,
    addBotMembership,
    credentialInstall,
    syncBot,
    callback,
    state
  }
}

describe('the deployment Teams app routes', () => {
  it('reads the app’s public identity, or none', async () => {
    const h = await harness()
    expect((await h.app.inject({ method: 'GET', url: '/integrations/msteams/app' })).json()).toEqual({
      appId: APP.appId
    })
    const none = await harness({ app: null })
    expect((await none.app.inject({ method: 'GET', url: '/integrations/msteams/app' })).json()).toEqual({ appId: null })
  })

  it('answers Microsoft’s sign-in for the deployment app with the Console’s connect page', async () => {
    const h = await harness()
    const res = await h.app.inject({
      method: 'POST',
      url: '/integrations/msteams/connect',
      payload: { agentId: AGENT }
    })
    expect(res.statusCode).toBe(200)
    const url = new URL(res.json<{ authorizeUrl: string }>().authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe(APP.appId)
    expect(url.searchParams.get('redirect_uri')).toBe('https://console.example.test/msteams/connect')
  })

  it('connects a new tenant: a prebuilt row with the home tenant as its token tenant, the catalog app, and the teams', async () => {
    const h = await harness()
    const res = await h.callback()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ agentId: AGENT, teams: [{ id: 'team-1', name: 'Engineering' }] })
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        platform: 'msteams',
        transport: 'http',
        prebuilt: true,
        name: 'Microsoft Teams · Example Org',
        externalAppId: APP.appId,
        platformConfig: { tenantId: CUSTOMER, tokenTenantId: APP.tenantId }
      })
    )
    expect(h.put).toHaveBeenCalledWith(ORG, expect.anything(), {
      botToken: APP.clientSecret,
      appToken: null,
      signingSecret: null
    })
    expect(h.graph.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
      'GET https://graph.microsoft.com/v1.0/appCatalogs/teamsApps',
      'POST https://graph.microsoft.com/v1.0/appCatalogs/teamsApps',
      'GET https://graph.microsoft.com/v1.0/organization',
      'GET https://graph.microsoft.com/v1.0/me/joinedTeams'
    ])
    expect(JSON.stringify(res.json())).not.toContain('delegated')

    const install = await h.app.inject({
      method: 'POST',
      url: '/integrations/msteams/connect/install',
      payload: { ticket: res.json<{ ticket: string }>().ticket, teamIds: ['team-1'] }
    })
    expect(install.json()).toEqual({ installed: 1 })
    expect(h.graph.at(-1)?.url).toBe('https://graph.microsoft.com/v1.0/teams/team-1/installedApps')
  })

  it('claims the tenant only after the administrator-only catalog publish succeeds', async () => {
    const ok = await harness()
    await ok.callback()
    expect(ok.order).toEqual(['publish', 'create'])
    for (const held of [undefined, {}]) {
      const refused = await harness({ publish: 403, ...(held ? { held } : {}) })
      expect((await refused.callback()).json()).toMatchObject({ code: 'MSTEAMS_CONNECT_NOT_ADMIN' })
      expect(refused.order).toEqual(['publish'])
      expect(refused.syncBot).not.toHaveBeenCalled()
      expect(refused.credentialInstall).not.toHaveBeenCalled()
    }
  })

  it('refuses a state for another organization or caller, or a forged one', async () => {
    const h = await harness()
    expect((await h.callback(h.state({ orgId: OTHER_ORG }))).json()).toMatchObject({
      code: 'MSTEAMS_CONNECT_STATE_INVALID'
    })
    expect((await h.callback(h.state({ userId: 'user-2' }))).json()).toMatchObject({
      code: 'MSTEAMS_CONNECT_STATE_INVALID'
    })
    expect((await h.callback('forged.state')).statusCode).toBe(400)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('refuses a tenant another organization holds, or this one connects to another agent', async () => {
    const taken = await harness({ held: { orgId: OTHER_ORG, agentIds: [OTHER_AGENT] } })
    expect((await taken.callback()).json()).toMatchObject({ code: 'MSTEAMS_TENANT_TAKEN' })
    const inUse = await harness({ held: { agentIds: [OTHER_AGENT] } })
    expect((await inUse.callback()).json()).toMatchObject({ code: 'MSTEAMS_TENANT_IN_USE' })
    expect(taken.graph).toEqual([])
    expect(inUse.graph).toEqual([])
  })

  it('puts a freed row of this organization back on the agent with the current secret', async () => {
    const h = await harness({ held: {} })
    expect((await h.callback()).statusCode).toBe(200)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.addBotMembership).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT, botId: BOT }))
    expect(h.credentialInstall).toHaveBeenCalled()
    expect(h.syncBot).toHaveBeenCalledWith(BOT)
  })

  it('names the row after the tenant when Graph answers no organization name', async () => {
    const h = await harness({ organization: null })
    expect((await h.callback()).statusCode).toBe(200)
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ name: `Microsoft Teams · ${CUSTOMER}` }))
  })

  it('refuses a personal Microsoft account', async () => {
    const h = await harness({ tid: '9188040d-6c67-4c5b-b112-36a304b66dad' })
    expect((await h.callback()).json()).toMatchObject({ code: 'MSTEAMS_CONNECT_PERSONAL_ACCOUNT' })
  })
})
