/** Connecting a Microsoft 365 tenant to the deployment's Teams app (teams-integration.md §8.3), against fakes. */
import Fastify, { type FastifyInstance } from 'fastify'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MSTEAMS_RELAY_EGRESS_V1_FEATURE } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import { installZod } from '../../http/plugins/zod.js'
import type { BotRecord, MsTeamsBindingMutations } from '../../persistence/ports.js'
import { AgentId, BotId, OrgId } from '../../domain/ids.js'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { memoryMsTeamsAgentBotRequestStore } from '../../../test/fakes/msteams-agent-bot-request-store.js'
import { MsTeamsAgentBotRequests } from './agent-bot-requests.js'
import { mintMsTeamsConnectState, msTeamsConnectKeys } from './connect.js'
import { msTeamsConnectRoutes } from './connect-routes.js'
import { msTeamsAgentBotKey } from './agent-bots.js'
import { msTeamsPackageId } from './app-package.js'
import { MSTEAMS_DEPLOYMENT_SECRET_MARKER, type MsTeamsAgentBots, type MsTeamsPlatformApp } from './deployment-app.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const OTHER_ORG = OrgId('22222222-2222-4222-8222-222222222222')
const AGENT = AgentId('77777777-7777-4777-8777-777777777777')
const OTHER_AGENT = AgentId('66666666-6666-4666-8666-666666666666')
const BOT = BotId('88888888-8888-4888-8888-888888888888')
const DAEMON = '99999999-9999-4999-8999-999999999999'
const APP: MsTeamsPlatformApp = {
  appId: '33333333-3333-4333-8333-333333333333',
  tenantId: '44444444-4444-4444-8444-444444444444',
  clientSecret: 'synthetic-secret'
}
const CUSTOMER = '55555555-5555-4555-8555-555555555555'
const AGENT_BOTS: MsTeamsAgentBots = {
  blueprintId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clientSecret: 'synthetic-blueprint-secret',
  subscriptionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceGroup: 'example-bots'
}
const IDENTITY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SPONSOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const NOW = Date.parse('2026-12-01T00:00:00Z')
const clock = new FakeClock(NOW)
const keys = msTeamsConnectKeys('p'.repeat(40))

const idToken = (tid: string, oid?: string) =>
  ['e30', Buffer.from(JSON.stringify({ tid, ...(oid ? { oid } : {}) })).toString('base64url'), 'sig'].join('.')

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
    installedIn?: string[]
    upgrade?: number
    /** The agent's serving daemon and the features it registered; absent ⇒ the agent is unplaced. */
    daemonFeatures?: string[]
    /** The deployment makes agent bots (§8.6); Microsoft's answers to their steps are scripted below. */
    agentBots?: boolean
    /** The blueprint has no principal in the tenant until one is created. */
    noPrincipal?: boolean
    principal?: number
    /** The tenant already holds this key's identity. */
    identityExists?: boolean
    identity?: number
    /** Other Teams rows, of any organization. */
    rows?: Partial<BotRecord>[]
    /** The row an agent identity already has. */
    agentBotRow?: Partial<BotRecord>
    agentNames?: Record<string, string>
    oid?: string | null
    /** The signed-in person's object ID as Graph answers it; absent ⇒ Graph refuses. */
    me?: string
    /** The submitted package's definitions as its submitter reads them. */
    packageStates?: string[]
    /** Graph's status for adding the app for the person who connects it. */
    personal?: number
    /** The signed-in person may not publish: Graph refuses the publish and takes a submission for review. */
    notAdmin?: boolean
    /** The account name Entra puts in the ID token. */
    username?: string
  } = {}
) {
  const graph: { method: string; url: string; body?: unknown }[] = []
  let principalCreated = false
  // Every write in the order it ran, Graph and repository alike.
  const order: string[] = []
  const packageStates = opts.packageStates ?? ['submitted']
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth2/v2.0/token')) {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('grant_type') === 'authorization_code')
        return Response.json({
          access_token: 'delegated',
          id_token: idToken(opts.tid ?? CUSTOMER, opts.oid === null ? undefined : (opts.oid ?? SPONSOR)),
          // Entra issues a refresh token only where the sign-in asked offline access.
          ...(form.get('scope')?.includes('offline_access') ? { refresh_token: 'member-refresh' } : {})
        })
      if (form.get('grant_type') === 'refresh_token')
        return Response.json({ access_token: 'delegated-again', refresh_token: 'member-refresh-2' })
      // The blueprint's and the identity's own tokens; a tenant with no principal refuses the blueprint.
      order.push(`token ${form.get('client_id')}`)
      if (form.get('client_id') === AGENT_BOTS.blueprintId && opts.noPrincipal && !principalCreated)
        return Response.json({ error: 'invalid_client', error_codes: [7000229] }, { status: 400 })
      return Response.json({ access_token: `own-${form.get('client_id')}`, expires_in: 3600 })
    }
    graph.push({ method: init?.method ?? 'GET', url, body: init?.body })
    if (url.endsWith('agentIdentityBlueprintPrincipal')) {
      order.push('principal')
      if (opts.principal)
        return Response.json({ error: { code: 'Authorization_RequestDenied' } }, { status: opts.principal })
      principalCreated = true
      return Response.json({ id: 'principal-1' }, { status: 201 })
    }
    if (url.includes('/servicePrincipals?$filter='))
      return Response.json({ value: opts.identityExists ? [{ id: IDENTITY }] : [] })
    if (url.endsWith('microsoft.graph.agentIdentity')) {
      order.push('identity')
      return opts.identity
        ? Response.json({ error: { code: 'Authorization_RequestDenied' } }, { status: opts.identity })
        : Response.json({ id: IDENTITY }, { status: 201 })
    }
    if (url.startsWith('https://management.azure.com/')) {
      if (init?.method === 'DELETE') {
        order.push('delete registration')
        return new Response(null, { status: 204 })
      }
      order.push(url.includes('/channels/') ? 'channel' : 'registration')
      return Response.json({}, { status: 201 })
    }
    if (init?.method === 'DELETE' && url.includes('/servicePrincipals/')) {
      order.push('delete identity')
      return new Response(null, { status: 204 })
    }
    const team = /\/teams\/([^/]+)\/installedApps/.exec(url)?.[1]
    if (team && url.endsWith('/upgrade')) {
      order.push(`upgrade ${team}`)
      return new Response(null, { status: opts.upgrade ?? 204 })
    }
    if (team && url.includes('$filter'))
      return Response.json({ value: opts.installedIn?.includes(team) ? [{ id: `install-${team}` }] : [] })
    if (url.includes('$filter')) return Response.json({ value: [] })
    if (url.includes('/appDefinitions/')) {
      order.push('withdraw')
      return new Response(null, { status: 204 })
    }
    if (url.includes('$expand=appDefinitions'))
      return Response.json({
        appDefinitions: packageStates.map((publishingState, i) => ({
          id: `def-${i}`,
          publishingState,
          '@odata.etag': `etag-${i}`
        }))
      })
    if (url.includes('/appCatalogs/teamsApps')) {
      if (opts.notAdmin && init?.method === 'POST' && url.includes('requiresReview=false')) {
        order.push('publish refused')
        return new Response(null, { status: 403 })
      }
      order.push('publish')
      return opts.publish
        ? new Response(null, { status: opts.publish })
        : Response.json({ id: 'catalog-1' }, { status: 201 })
    }
    // The sign-in name is Graph's to tell: the ID token of these scopes carries none.
    if (url.includes('/me?$select=userPrincipalName'))
      return opts.username ? Response.json({ userPrincipalName: opts.username }) : new Response(null, { status: 403 })
    if (url.includes('/me?$select=id'))
      return opts.me ? Response.json({ id: opts.me }) : new Response(null, { status: 403 })
    if (url.includes('/me/joinedTeams'))
      return Response.json({
        value: [
          { id: 'team-1', displayName: 'Engineering' },
          { id: 'team-2', displayName: 'Support' }
        ]
      })
    if (url.includes('/organization'))
      return opts.organization === null
        ? new Response(null, { status: 403 })
        : Response.json({ value: [{ displayName: opts.organization ?? 'Example Org' }] })
    if (url.includes('/teamwork/installedApps')) {
      order.push('personal')
      return new Response(null, { status: opts.personal ?? 201 })
    }
    if (url.includes('/installedApps')) return new Response(null, { status: 201 })
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  const held = opts.held
    ? ({
        id: BOT,
        orgId: ORG,
        name: 'Microsoft Teams',
        platform: 'msteams',
        externalAppId: APP.appId,
        externalTenantId: CUSTOMER,
        agentIds: [],
        platformConfig: { appOwner: 'deployment' },
        ...opts.held
      } as BotRecord)
    : null
  const rows = [
    ...(held ? [held] : []),
    ...(opts.rows ?? []).map((row) => ({ platform: 'msteams', agentIds: [], ...row }) as BotRecord)
  ]
  if (held) Object.assign(held, { platform: 'msteams', externalTenantId: held.externalTenantId ?? CUSTOMER })
  const agentBotRow = opts.agentBotRow
    ? ({ orgId: ORG, name: 'Microsoft Teams', agentIds: [], ...opts.agentBotRow } as BotRecord)
    : null
  const requestStore = memoryMsTeamsAgentBotRequestStore(() => clock.now())
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
  const recorded: Record<string, string>[] = []
  const mergeBotIdentity = vi.fn(
    async (_org: OrgId, _id: BotId, merge: (current: unknown) => { platformConfig?: Record<string, string> }) => {
      order.push('record')
      recorded.push(merge({ platformConfig: {}, externalTenantId: null }).platformConfig ?? {})
      return true
    }
  )
  const deps = {
    config: { PUBLIC_RELAY_URL: 'https://relay.example.test' },
    clock,
    httpBot: { hasConnectedRelay: () => true, syncBot },
    placementResolver: { servingDaemon: async () => (opts.daemonFeatures ? DAEMON : null) },
    registry: {
      getAvailable: async () => ({
        id: DAEMON,
        orgId: ORG,
        visibility: 'org',
        capabilities: { platforms: ['msteams'], features: opts.daemonFeatures ?? [] }
      })
    },
    repos: {
      agent: {
        get: async (_org: OrgId, id: AgentId) => ({
          id,
          orgId: ORG,
          name: 'helper',
          displayName: opts.agentNames?.[id] ?? 'Helper',
          icon: null,
          runtime: 'claude',
          visibility: 'org'
        })
      },
      bot: {
        getByExternalIdentity: async (_platform: string, appId: string) => (appId === APP.appId ? held : agentBotRow),
        listForPlatform: async () => rows,
        listForOrg: async (org: OrgId) => rows.filter((row) => row.orgId === org),
        create,
        mergeBotIdentity
      },
      botSecret: { put },
      botCredential: { install: credentialInstall },
      integration: {
        create: integrationCreate,
        addBotMembership,
        listForBot: async () => [],
        get: async () => ({ agentId: AGENT })
      },
      msTeamsAgentBotRequest: requestStore.store
    }
  } as unknown as HttpDeps
  const log = { info: vi.fn(), warn: vi.fn() }
  const requests =
    opts.agentBots && opts.app !== null
      ? new MsTeamsAgentBotRequests({
          http: deps,
          app: opts.app ?? APP,
          agentBots: AGENT_BOTS,
          bindingMutations: { runExclusive: async (_tenant, action) => action() } as MsTeamsBindingMutations,
          fetch: fetchImpl,
          wait: async () => {},
          personalInstallWait: async () => {},
          log
        })
      : undefined
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
      ...(opts.agentBots ? { agentBots: AGENT_BOTS, agentBotWait: async () => {} } : {}),
      personalInstallWait: async () => {},
      ...(requests ? { requests } : {}),
      keys,
      bindingMutations: { runExclusive: async (_tenant, action) => action() } as MsTeamsBindingMutations,
      webAppUrl: 'https://console.example.test',
      fetch: fetchImpl
    })
  )
  running = app
  const state = (
    over: Partial<{
      orgId: string
      agentId: string
      userId: string
      tenant: string
      agentBots: boolean
      consent: boolean
      consented: boolean
      member: boolean
      approve: string
    }> = {}
  ) => mintMsTeamsConnectState(keys, { orgId: ORG, agentId: AGENT, userId: 'user-1', ...over }, clock)
  const post = (path: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/integrations/msteams/connect${path}`, payload: payload as object })
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
    recorded,
    callback,
    state,
    post,
    requestRows: requestStore.rows
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

  it('connects an agent only on a daemon that sends through the relay (§8.5)', async () => {
    const start = (h: Awaited<ReturnType<typeof harness>>) =>
      h.app.inject({ method: 'POST', url: '/integrations/msteams/connect', payload: { agentId: AGENT } })
    const older = await start(await harness({ daemonFeatures: [] }))
    expect(older.statusCode).toBe(409)
    expect(older.json()).toMatchObject({ code: 'MSTEAMS_CONNECT_NO_AGENT' })
    expect((await start(await harness({ daemonFeatures: [MSTEAMS_RELAY_EGRESS_V1_FEATURE] }))).statusCode).toBe(200)
  })

  it('connects a new tenant: a prebuilt row with the home tenant as its token tenant, the catalog app, and the teams', async () => {
    const h = await harness()
    const res = await h.callback()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      agentId: AGENT,
      teams: [
        { id: 'team-1', name: 'Engineering', app: 'none' },
        { id: 'team-2', name: 'Support', app: 'none' }
      ]
    })
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        platform: 'msteams',
        transport: 'http',
        prebuilt: true,
        name: 'Microsoft Teams · Example Org',
        externalAppId: APP.appId,
        platformConfig: { tenantId: CUSTOMER, tokenTenantId: APP.tenantId, appOwner: 'deployment' }
      })
    )
    // The row stores a marker, never the deployment app's secret (§8.5).
    expect(h.put).toHaveBeenCalledWith(ORG, expect.anything(), {
      botToken: MSTEAMS_DEPLOYMENT_SECRET_MARKER,
      appToken: null,
      signingSecret: null
    })
    expect(JSON.stringify(h.put.mock.calls)).not.toContain(APP.clientSecret)
    expect(h.graph.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
      'GET https://graph.microsoft.com/v1.0/appCatalogs/teamsApps',
      'POST https://graph.microsoft.com/v1.0/appCatalogs/teamsApps',
      'GET https://graph.microsoft.com/v1.0/organization',
      'GET https://graph.microsoft.com/v1.0/me/joinedTeams',
      'GET https://graph.microsoft.com/v1.0/teams/team-1/installedApps',
      'GET https://graph.microsoft.com/v1.0/teams/team-2/installedApps'
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

  // teams-integration.md §8.4: a Teams Store install only proves its tenant; nothing is published or installed.
  it('pins a Store install’s sign-in to its tenant and asks only to read the profile', async () => {
    const h = await harness()
    const res = await h.app.inject({
      method: 'POST',
      url: '/integrations/msteams/connect',
      payload: { agentId: AGENT, tenantId: CUSTOMER.toUpperCase() }
    })
    const url = new URL(res.json<{ authorizeUrl: string }>().authorizeUrl)
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${CUSTOMER}/oauth2/v2.0/authorize`)
    expect(url.searchParams.get('scope')).toBe('https://graph.microsoft.com/User.Read openid')
  })

  it('connects a Store install’s tenant without publishing or listing teams, and keeps Update in Teams off it', async () => {
    const h = await harness()
    const res = await h.callback(h.state({ tenant: CUSTOMER }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ integrationId: expect.any(String), agentId: AGENT, teams: [], store: true })
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prebuilt: true,
        platformConfig: { tenantId: CUSTOMER, tokenTenantId: APP.tenantId, appOwner: 'deployment', source: 'store' }
      })
    )
    expect(h.graph.map((call) => call.url.split('?')[0])).toEqual(['https://graph.microsoft.com/v1.0/organization'])
    expect(h.order).toEqual(['create', 'record'])
    expect(h.recorded).toEqual([{ source: 'store' }])
  })

  it('refuses a Store connect signed in to another tenant, and writes nothing', async () => {
    const h = await harness({ tid: '99999999-9999-4999-8999-999999999999' })
    const res = await h.callback(h.state({ tenant: CUSTOMER }))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MSTEAMS_TENANT_MISMATCH' })
    expect(h.create).not.toHaveBeenCalled()
    expect(h.graph).toEqual([])
  })

  it('claims the tenant only after the administrator-only catalog publish succeeds', async () => {
    const ok = await harness()
    await ok.callback()
    expect(ok.order).toEqual(['publish', 'create', 'record'])
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

  it('puts a freed row of this organization back on the agent, with the marker rather than a secret', async () => {
    // A row an older build wrote carries no owner entry until this connect records it.
    const h = await harness({ held: { platformConfig: { tokenTenantId: APP.tenantId } } })
    expect((await h.callback()).statusCode).toBe(200)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.addBotMembership).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT, botId: BOT }))
    expect(h.credentialInstall).toHaveBeenCalledWith(
      ORG,
      BOT,
      { botToken: MSTEAMS_DEPLOYMENT_SECRET_MARKER, appToken: null, signingSecret: null },
      expect.any(Date)
    )
    expect(h.recorded[0]).toEqual({ appOwner: 'deployment' })
    expect(h.syncBot).toHaveBeenCalledWith(BOT)
  })

  it('updates a connected tenant: publishes, records the package, and upgrades each team that has the app with re-consent', async () => {
    const h = await harness({ held: { agentIds: [AGENT] }, installedIn: ['team-2'] })
    const res = await h.callback()
    expect(res.statusCode).toBe(200)
    expect(res.json<{ teams: unknown[] }>().teams).toEqual([
      { id: 'team-1', name: 'Engineering', app: 'none' },
      { id: 'team-2', name: 'Support', app: 'updated' }
    ])
    expect(h.order).toEqual(['publish', 'membership', 'upgrade team-2', 'record'])
    expect(h.recorded).toEqual([{ appPackage: expect.stringMatching(/^[\w-]{22}$/) }])
    const upgrade = h.graph.find((call) => call.url.endsWith('/upgrade'))
    expect(upgrade?.url).toBe('https://graph.microsoft.com/v1.0/teams/team-2/installedApps/install-team-2/upgrade')
    const consented = JSON.parse(String(upgrade?.body)) as {
      consentedPermissionSet: { resourceSpecificPermissions: { permissionValue: string; permissionType: string }[] }
    }
    expect(consented.consentedPermissionSet.resourceSpecificPermissions).toContainEqual({
      permissionValue: 'TeamSettings.Read.Group',
      permissionType: 'application'
    })
  })

  it('keeps the connect when Microsoft refuses or fails a team’s upgrade, reports it, and leaves the package pending', async () => {
    for (const upgrade of [403, 500]) {
      const h = await harness({ held: { agentIds: [AGENT] }, installedIn: ['team-1'], upgrade })
      const res = await h.callback()
      expect(res.statusCode).toBe(200)
      expect(res.json<{ teams: { app: string }[] }>().teams.map((team) => team.app)).toEqual(['failed', 'none'])
      expect(h.recorded).toEqual([])
    }
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

describe('a deployment that makes agent bots (§8.6)', () => {
  const HELD = { agentIds: [OTHER_AGENT], externalAppId: APP.appId } as Partial<BotRecord>
  // The agent already on the app's bot has a name of its own unless a test says otherwise.
  const further = (over: Parameters<typeof harness>[0] = {}) =>
    harness({ agentBots: true, held: HELD, agentNames: { [OTHER_AGENT]: 'Reviewer' }, ...over })

  it('skips the consent page for an organization whose tenant recorded it, and sends another tenant back through it', async () => {
    const CONSENTED = { ...HELD, platformConfig: { appOwner: 'deployment', tenantConsent: '3' } } as Partial<BotRecord>
    const h = await further({ held: CONSENTED })
    const direct = new URL((await h.post('', { agentId: AGENT })).json<{ authorizeUrl: string }>().authorizeUrl)
    expect(direct.pathname).toBe('/organizations/oauth2/v2.0/authorize')
    expect(direct.searchParams.get('scope')).toContain('AppCatalog.Submit')
    expect(direct.searchParams.get('prompt')).toBe('select_account')
    expect((await h.callback(direct.searchParams.get('state')!)).json()).toMatchObject({ agentBot: true })
    // Nothing more is recorded for a tenant that already has it.
    expect(h.recorded).toEqual([])
    const forced = new URL(
      (await h.post('', { agentId: AGENT, consent: true })).json<{ authorizeUrl: string }>().authorizeUrl
    )
    expect(forced.pathname).toBe('/organizations/v2.0/adminconsent')

    // The administrator signed in to a tenant with no record: the page starts again with the consent.
    const other = await further()
    const refused = await other.callback(other.state({ agentBots: true }))
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'MSTEAMS_CONSENT_NEEDED' })
    expect(other.recorded).toEqual([])
  })

  it('asks the tenant-wide consent first, then the sign-in with the agent bots’ scopes', async () => {
    const h = await harness({ agentBots: true })
    const consent = new URL((await h.post('', { agentId: AGENT })).json<{ authorizeUrl: string }>().authorizeUrl)
    expect(`${consent.origin}${consent.pathname}`).toBe(
      'https://login.microsoftonline.com/organizations/v2.0/adminconsent'
    )
    const asked = consent.searchParams.get('scope')!.split(' ')
    expect(asked).toContain('https://graph.microsoft.com/AppCatalog.Submit')
    expect(asked).toContain('https://graph.microsoft.com/AgentIdentityBlueprintPrincipal.Create')
    expect(asked).not.toContain('openid')
    expect(consent.searchParams.get('redirect_uri')).toBe('https://console.example.test/msteams/connect')

    const consentState = consent.searchParams.get('state')!
    const next = await h.post('/consented', { state: consentState })
    expect(next.statusCode).toBe(200)
    const signIn = new URL(next.json<{ authorizeUrl: string }>().authorizeUrl)
    expect(signIn.pathname).toBe('/organizations/oauth2/v2.0/authorize')
    expect(asked).toContain('offline_access')
    expect(signIn.searchParams.get('scope')!.split(' ')).toEqual(
      expect.arrayContaining([...asked.filter((scope) => scope !== 'offline_access'), 'openid'])
    )
    expect(signIn.searchParams.has('prompt')).toBe(false)
    // The consent's state redeems no code, and a sign-in's state continues no consent.
    expect((await h.callback(consentState)).statusCode).toBe(400)
    expect((await h.post('/consented', { state: signIn.searchParams.get('state')! })).statusCode).toBe(400)
    expect((await h.post('/consented', { state: h.state({ consent: true, userId: 'user-2' }) })).statusCode).toBe(400)

    // A Store install only proves its tenant, and a deployment without agent bots signs in at once.
    const store = new URL(
      (await h.post('', { agentId: AGENT, tenantId: CUSTOMER })).json<{ authorizeUrl: string }>().authorizeUrl
    )
    expect(store.pathname).toBe(`/${CUSTOMER}/oauth2/v2.0/authorize`)
    const plain = await harness()
    expect(
      new URL((await plain.post('', { agentId: AGENT })).json<{ authorizeUrl: string }>().authorizeUrl).pathname
    ).toBe('/organizations/oauth2/v2.0/authorize')
  })

  it('creates the blueprint’s principal at a tenant’s first connect, which stands without it', async () => {
    const h = await harness({ agentBots: true, noPrincipal: true })
    expect((await h.callback(h.state({ agentBots: true, consented: true }))).statusCode).toBe(200)
    expect(h.order).toContain('principal')
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ externalAppId: APP.appId }))

    const refused = await harness({ agentBots: true, noPrincipal: true, principal: 403 })
    expect((await refused.callback(refused.state({ agentBots: true, consented: true }))).statusCode).toBe(200)
    expect(refused.create).toHaveBeenCalledTimes(1)
  })

  it('gives a further agent a bot of its own: the teams first, then the bot, its package and its row', async () => {
    const h = await further({ noPrincipal: true })
    const first = await h.callback(h.state({ agentBots: true, consented: true }))
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({
      agentId: AGENT,
      agentBot: true,
      store: false,
      // No team is offered: the agent joins a team when someone mentions it there (§8.6.5).
      teams: []
    })
    expect(first.json()).not.toHaveProperty('integrationId')
    expect(JSON.stringify(first.json())).not.toContain('delegated')
    // Nothing is made before the agent-bot step; the tenant's row only records the consent just accepted.
    expect(h.order).toEqual(['record'])
    expect(h.recorded).toEqual([{ tenantConsent: '3' }])
    expect(h.create).not.toHaveBeenCalled()

    const made = await h.post('/agent-bot', { ticket: first.json<{ ticket: string }>().ticket })
    expect(made.statusCode).toBe(200)
    expect(made.json()).toMatchObject({ agentId: AGENT, store: false, teams: [] })
    expect(made.json()).not.toHaveProperty('ticket')
    expect(typeof made.json<{ integrationId: string }>().integrationId).toBe('string')
    // The principal, the identity, the registration and its channel, the proof, then the catalog, the row, its package, and the app for the person who connected it.
    expect(h.order.slice(1)).toEqual([
      `token ${AGENT_BOTS.blueprintId}`,
      'principal',
      `token ${AGENT_BOTS.blueprintId}`,
      'identity',
      `token ${APP.appId}`,
      'registration',
      'channel',
      `token ${AGENT_BOTS.blueprintId}`,
      `token ${IDENTITY}`,
      'publish',
      'create',
      'record',
      'personal'
    ])
    expect(h.graph.at(-1)).toMatchObject({
      method: 'POST',
      url: `https://graph.microsoft.com/v1.0/users/${SPONSOR}/teamwork/installedApps`
    })
    // A refused personal install leaves the connect as it is.
    const refused = await further({ personal: 403 })
    const again = await refused.callback(refused.state({ agentBots: true, consented: true }))
    expect((await refused.post('/agent-bot', { ticket: again.json<{ ticket: string }>().ticket })).statusCode).toBe(200)
    const key = msTeamsAgentBotKey(AGENT, CUSTOMER)
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        prebuilt: true,
        externalAppId: IDENTITY,
        platformConfig: {
          tenantId: CUSTOMER,
          tokenTenantId: CUSTOMER,
          appOwner: 'deployment',
          agentBotBlueprintId: AGENT_BOTS.blueprintId,
          agentBotResourceName: `acbot-${key}`
        }
      })
    )
    expect(h.put).toHaveBeenCalledWith(ORG, expect.anything(), {
      botToken: MSTEAMS_DEPLOYMENT_SECRET_MARKER,
      appToken: null,
      signingSecret: null
    })
    // The identity is created with the signed-in administrator as its sponsor, and the package is named by the identity.
    const identity = h.graph.find((call) => call.url.endsWith('microsoft.graph.agentIdentity'))!
    expect(JSON.parse(String(identity.body))['sponsors@odata.bind']).toEqual([
      `https://graph.microsoft.com/v1.0/users/${SPONSOR}`
    ])
    expect(
      h.graph.some((call) => decodeURIComponent(call.url).includes(`externalId eq '${msTeamsPackageId(IDENTITY)}'`))
    ).toBe(true)
    // The published package names the identity as its bot and the blueprint as its consent app (§8.6.1).
    const published = h.graph.find(
      (call) => call.method === 'POST' && call.url.split('?')[0]!.endsWith('/appCatalogs/teamsApps')
    )!
    const manifest = JSON.parse(strFromU8(unzipSync(published.body as Uint8Array)['manifest.json']!)) as {
      bots: { botId: string }[]
      webApplicationInfo: { id: string }
    }
    expect(manifest.bots[0]!.botId).toBe(IDENTITY)
    expect(manifest.webApplicationInfo.id).toBe(AGENT_BOTS.blueprintId)
    // Nothing is installed into a team through Graph.
    expect(h.graph.some((call) => call.url.includes('/teams/') && call.url.includes('/installedApps'))).toBe(false)
  })

  it('finds what an earlier attempt made, and updates an agent bot that is already connected', async () => {
    const h = await further({
      identityExists: true,
      agentBotRow: { id: BOT, externalAppId: IDENTITY },
      installedIn: ['team-1']
    })
    const first = await h.callback(h.state({ agentBots: true, consented: true }))
    const again = await h.post('/agent-bot', { ticket: first.json<{ ticket: string }>().ticket })
    expect(again.statusCode).toBe(200)
    expect(h.order).not.toContain('principal')
    expect(h.order).not.toContain('identity')
    expect(h.create).not.toHaveBeenCalled()
    expect(h.addBotMembership).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT, botId: BOT }))
    expect(again.json<{ teams: unknown[] }>().teams).toEqual([])
    expect(h.order.some((step) => step.startsWith('upgrade'))).toBe(false)
  })

  it('keeps an agent on its own bot when the tenant’s first agent is gone', async () => {
    const own = {
      orgId: ORG,
      externalTenantId: CUSTOMER,
      agentIds: [AGENT],
      platformConfig: { appOwner: 'deployment', agentBotBlueprintId: AGENT_BOTS.blueprintId, agentBotResourceName: 'x' }
    } as Partial<BotRecord>
    const h = await harness({ agentBots: true, rows: [own] })
    const res = await h.callback(h.state({ agentBots: true, consented: true }))
    expect(res.json()).toMatchObject({ agentBot: true })
    expect(h.create).not.toHaveBeenCalled()
    // Another agent of the same tenant takes the app's bot, which is free.
    const other = await harness({ agentBots: true, rows: [{ ...own, agentIds: [OTHER_AGENT] }] })
    expect((await other.callback(other.state({ agentBots: true, consented: true }))).json()).not.toHaveProperty(
      'agentBot'
    )
    expect(other.create).toHaveBeenCalledWith(expect.objectContaining({ externalAppId: APP.appId }))
  })

  it('keeps one agent per tenant where the sign-in did not ask the agent bots’ scopes, or named no sponsor', async () => {
    const unasked = await further()
    expect((await unasked.callback()).json()).toMatchObject({ code: 'MSTEAMS_TENANT_IN_USE' })
    const unnamed = await further({ oid: null })
    expect((await unnamed.callback(unnamed.state({ agentBots: true, consented: true }))).json()).toMatchObject({
      code: 'MSTEAMS_TENANT_IN_USE'
    })
    // Entra leaves the object ID out of an ID token that did not ask the profile scope; Graph names the sponsor then.
    const asked = await further({ oid: null, me: SPONSOR })
    expect((await asked.callback(asked.state({ agentBots: true, consented: true }))).json()).toMatchObject({
      agentBot: true
    })
  })

  it('refuses a further agent whose name another agent already has in the tenant, naming it', async () => {
    const h = await further({ agentNames: { [AGENT]: 'Helper', [OTHER_AGENT]: ' helper ' } })
    const res = await h.callback(h.state({ agentBots: true, consented: true }))
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'MSTEAMS_AGENT_NAME_TAKEN' })
    expect(res.json<{ message: string }>().message).toContain('helper')
    const distinct = await further({ agentNames: { [AGENT]: 'Helper', [OTHER_AGENT]: 'Reviewer' } })
    expect((await distinct.callback(distinct.state({ agentBots: true, consented: true }))).statusCode).toBe(200)
  })

  it('keeps a tenant with one organization, whichever of its rows another organization holds', async () => {
    const h = await harness({
      agentBots: true,
      rows: [{ orgId: OTHER_ORG, externalTenantId: CUSTOMER, platformConfig: { appOwner: 'deployment' } }]
    })
    expect((await h.callback(h.state({ agentBots: true, consented: true }))).json()).toMatchObject({
      code: 'MSTEAMS_TENANT_TAKEN'
    })
    expect(h.create).not.toHaveBeenCalled()
    // Another organization's own bot in the tenant claims nothing.
    const own = await harness({ rows: [{ orgId: OTHER_ORG, externalTenantId: CUSTOMER, platformConfig: {} }] })
    expect((await own.callback()).statusCode).toBe(200)
  })

  it('answers Microsoft’s reason when the bot cannot be created, and writes nothing', async () => {
    const h = await further({ identity: 403 })
    const first = await h.callback(h.state({ agentBots: true, consented: true }))
    const refused = await h.post('/agent-bot', { ticket: first.json<{ ticket: string }>().ticket })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'MSTEAMS_AGENT_BOTS_UNAVAILABLE' })
    expect(refused.json<{ message: string }>().message).toContain('identity: Authorization_RequestDenied')
    expect(h.order).not.toContain('publish')
    expect(h.create).not.toHaveBeenCalled()

    const down = await further({ identity: 503 })
    const pending = await down.callback(down.state({ agentBots: true, consented: true }))
    expect((await down.post('/agent-bot', { ticket: pending.json<{ ticket: string }>().ticket })).statusCode).toBe(502)
  })

  it('takes each ticket only at its own step, from the person it was sealed for', async () => {
    const h = await further()
    const provision = (await h.callback(h.state({ agentBots: true, consented: true }))).json<{ ticket: string }>()
      .ticket
    expect((await h.post('/install', { ticket: provision, teamIds: ['team-1'] })).statusCode).toBe(400)
    const made = (await h.post('/agent-bot', { ticket: provision })).json<{ ticket: string }>().ticket
    expect((await h.post('/agent-bot', { ticket: made })).statusCode).toBe(400)
    // Without agent bots the step does not exist.
    const plain = await harness()
    expect((await plain.post('/agent-bot', { ticket: provision })).statusCode).toBe(404)
  })
})

describe('a person who may not publish (§8.6.6)', () => {
  // The tenant is connected and consented: the app's bot serves another agent of this organization.
  const HELD = {
    agentIds: [OTHER_AGENT],
    externalAppId: APP.appId,
    platformConfig: { appOwner: 'deployment', tenantConsent: '3' }
  } as Partial<BotRecord>
  const connected = (over: Parameters<typeof harness>[0] = {}) =>
    harness({ agentBots: true, notAdmin: true, held: HELD, agentNames: { [OTHER_AGENT]: 'Reviewer' }, ...over })
  const signIn = async (h: Awaited<ReturnType<typeof harness>>) => h.callback(h.state({ agentBots: true }))
  const ask = async (h: Awaited<ReturnType<typeof harness>>) =>
    h.post('/agent-bot', { ticket: (await signIn(h)).json<{ ticket: string }>().ticket })
  const requestsOf = (h: Awaited<ReturnType<typeof harness>>) =>
    h.app.inject({ method: 'GET', url: `/integrations/msteams/requests?agentId=${AGENT}` })

  it('signs in as an administrator does, with the one set of scopes and a refresh token', async () => {
    const h = await connected()
    const url = new URL((await h.post('', { agentId: AGENT })).json<{ authorizeUrl: string }>().authorizeUrl)
    expect(url.pathname).toBe('/organizations/oauth2/v2.0/authorize')
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(
      expect.arrayContaining([
        'https://graph.microsoft.com/AppCatalog.ReadWrite.All',
        'https://graph.microsoft.com/AppCatalog.Submit',
        'openid',
        'offline_access'
      ])
    )
    const first = await signIn(h)
    expect(first.json()).toMatchObject({ agentId: AGENT, agentBot: true, store: false, teams: [] })
    expect(first.body).not.toContain('member-refresh')
  })

  it('submits the package when Microsoft refuses the publish, and stores the request with the sign-in sealed away from every answer', async () => {
    const h = await connected()
    const made = await ask(h)
    expect(made.statusCode, made.body).toBe(200)
    expect(made.json()).toMatchObject({
      agentId: AGENT,
      agentBot: true,
      teams: [],
      request: {
        agentId: AGENT,
        tenantId: CUSTOMER,
        status: 'pending',
        reason: null,
        // The link opens the package's own page, where an administrator publishes it.
        adminCenterUrl: 'https://admin.teams.microsoft.com/policies/manage-apps/catalog-1'
      }
    })
    expect(made.json()).not.toHaveProperty('integrationId')
    // The identity and its registration are made, the publish is refused, the package is submitted for review, and no row is written.
    expect(h.order).toContain('identity')
    expect(h.order).toContain('registration')
    expect(h.order).toContain('publish refused')
    expect(h.graph.some((call) => call.method === 'POST' && call.url.endsWith('teamsApps?requiresReview=true'))).toBe(
      true
    )
    expect(h.create).not.toHaveBeenCalled()
    const [row] = [...h.requestRows.values()]
    expect(row).toMatchObject({
      agentId: AGENT,
      tenantId: CUSTOMER,
      identity: IDENTITY,
      catalogAppId: 'catalog-1',
      teamIds: [],
      refreshToken: 'member-refresh',
      sponsorId: SPONSOR,
      botName: 'Microsoft Teams · Example Org'
    })
    for (const body of [made.body, (await requestsOf(h)).body]) expect(body).not.toContain('member-refresh')
    expect((await requestsOf(h)).json<{ requests: unknown[] }>().requests).toHaveLength(1)
  })

  it('says an administrator has to connect first, and refuses a tenant another organization holds', async () => {
    // A tenant nobody connected: the first connect publishes the deployment's own app, which Microsoft refuses.
    const unconnected = await harness({ agentBots: true, notAdmin: true })
    const first = await unconnected.callback(unconnected.state({ agentBots: true, consented: true }))
    expect(first.json()).toMatchObject({ code: 'MSTEAMS_CONNECT_NOT_ADMIN' })
    expect(unconnected.create).not.toHaveBeenCalled()
    const elsewhere = await harness({
      agentBots: true,
      notAdmin: true,
      rows: [{ orgId: OTHER_ORG, externalTenantId: CUSTOMER, platformConfig: { appOwner: 'deployment' } }]
    })
    expect((await signIn(elsewhere)).json()).toMatchObject({ code: 'MSTEAMS_TENANT_TAKEN' })
  })

  it('refuses a name another agent has, an agent that already has its bot, and a tenant without the blueprint’s principal', async () => {
    const named = await connected({ agentNames: { [AGENT]: 'Helper', [OTHER_AGENT]: 'Helper' } })
    expect((await signIn(named)).json()).toMatchObject({ code: 'MSTEAMS_AGENT_NAME_TAKEN' })

    const already = await connected({ identityExists: true, agentBotRow: { id: BOT, externalAppId: IDENTITY } })
    expect((await ask(already)).json()).toMatchObject({ code: 'MSTEAMS_AGENT_ALREADY_CONNECTED' })
    expect(already.requestRows.size).toBe(0)

    const bare = await connected({ noPrincipal: true, principal: 403 })
    expect((await ask(bare)).json()).toMatchObject({ code: 'MSTEAMS_AGENT_BOTS_UNAVAILABLE' })
    expect(bare.order).not.toContain('identity')
    expect(bare.requestRows.size).toBe(0)
  })

  it('finishes on a check once the package is approved, and answers the integration', async () => {
    const h = await connected({ packageStates: ['published'] })
    const id = (await ask(h)).json<{ request: { id: string } }>().request.id
    const checked = await h.app.inject({ method: 'POST', url: `/integrations/msteams/requests/${id}/check` })
    expect(checked.statusCode).toBe(200)
    expect(typeof checked.json<{ integrationId: string }>().integrationId).toBe('string')
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ externalAppId: IDENTITY, prebuilt: true }))
    expect(h.requestRows.size).toBe(0)
    expect((await requestsOf(h)).json()).toEqual({ requests: [] })
  })

  it('answers the request as it stands while it waits, and removes everything on a cancel', async () => {
    const h = await connected()
    const id = (await ask(h)).json<{ request: { id: string } }>().request.id
    const waiting = await h.app.inject({ method: 'POST', url: `/integrations/msteams/requests/${id}/check` })
    expect(waiting.json()).toMatchObject({ request: { id, status: 'pending' } })
    expect([...h.requestRows.values()][0]!.refreshToken).toBe('member-refresh-2')

    const cancelled = await h.app.inject({ method: 'DELETE', url: `/integrations/msteams/requests/${id}` })
    expect(cancelled.statusCode).toBe(204)
    expect(h.order.filter((step) => step === 'withdraw' || step.startsWith('delete'))).toEqual([
      'withdraw',
      'delete identity',
      'delete registration'
    ])
    expect(h.requestRows.size).toBe(0)
    expect((await h.app.inject({ method: 'DELETE', url: `/integrations/msteams/requests/${id}` })).statusCode).toBe(404)
  })

  it('renews a waiting request with a new sign-in instead of starting another', async () => {
    const h = await connected()
    const id = (await ask(h)).json<{ request: { id: string } }>().request.id
    Object.assign(h.requestRows.get(id)!, { status: 'needs_sign_in', reason: 'sign_in_expired', refreshToken: null })
    const again = await signIn(h)
    expect(again.json()).toMatchObject({ agentBot: true, request: { id, status: 'pending', reason: null } })
    expect(again.json()).not.toHaveProperty('ticket')
    // The renewed sign-in is checked at once, which stores the token Entra issued in exchange.
    expect(h.requestRows.get(id)).toMatchObject({ status: 'pending' })
    expect(h.requestRows.get(id)!.refreshToken).toBeTruthy()
    expect(h.requestRows.size).toBe(1)
  })

  it('finishes a request approved while its sign-in was stopped, on the next sign-in', async () => {
    const h = await connected({ packageStates: ['published'] })
    const id = (await ask(h)).json<{ request: { id: string } }>().request.id
    Object.assign(h.requestRows.get(id)!, { status: 'needs_sign_in', reason: 'sign_in_expired', refreshToken: null })
    const again = await signIn(h)
    expect(again.statusCode, again.body).toBe(200)
    expect(typeof again.json<{ integrationId: string }>().integrationId).toBe('string')
    expect(again.json()).not.toHaveProperty('request')
    expect(again.json()).not.toHaveProperty('ticket')
    expect(h.requestRows.size).toBe(0)
  })

  it('signs a person of another tenant in at the organization’s one tenant, silently, once', async () => {
    // The organization connected CUSTOMER; the person's account is of another tenant, as a guest's is.
    const ELSEWHERE = '99999999-9999-4999-8999-999999999999'
    const h = await connected({
      tid: ELSEWHERE,
      username: 'guest@partner.example.test',
      held: undefined,
      rows: [{ ...HELD, orgId: ORG, externalTenantId: CUSTOMER }]
    })
    const first = await signIn(h)
    expect(first.statusCode, first.body).toBe(200)
    const silent = new URL(first.json<{ authorizeUrl: string }>().authorizeUrl)
    expect(silent.pathname).toBe(`/${CUSTOMER}/oauth2/v2.0/authorize`)
    expect(silent.searchParams.get('prompt')).toBe('none')
    expect(silent.searchParams.get('login_hint')).toBe('guest@partner.example.test')
    expect(first.json()).not.toHaveProperty('ticket')
    // The silent sign-in's own state does not ask for another one, and neither does a sign-in that follows a consent.
    const again = await h.callback(silent.searchParams.get('state')!)
    expect(again.json()).not.toHaveProperty('authorizeUrl')
    const consented = await h.callback(h.state({ agentBots: true, consented: true }))
    expect(consented.json()).not.toHaveProperty('authorizeUrl')
  })
})
