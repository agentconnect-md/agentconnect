// Connect with Microsoft and Manage project access (azure-devops-integration.md §3.2 steps 1-4, §8) against a fake Entra and Azure DevOps.
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeClock } from '../fakes/fake-clock.js'
import {
  ADMIN_TOKEN,
  AUTH_CODE,
  CLIENT_ID,
  DEPLOYMENT_CLIENT_ID,
  ENTITLEMENTS_BASE,
  FakeAzureDevOps,
  GRAPH_BASE,
  IDENTITY_ID,
  ORGANIZATION,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  SP_OBJECT_ID,
  TENANT_ID
} from '../fakes/azure-devops-api.js'
import { AzureDevOpsConnectionService } from '../../src/azure-devops/connection.service.js'
import { AzureDevOpsBindingService } from '../../src/azure-devops/binding.service.js'
import { AzureDevOpsConnectFlowService } from '../../src/azure-devops/connect-flow.service.js'
import { AzureDevOpsTokenCache } from '../../src/azure-devops/token-cache.js'
import { CONSUMER_TENANT, azureDevOpsConnectKeys } from '../../src/azure-devops/connect.js'
import {
  PgAzureDevOpsConnectionRepo,
  PgAzureDevOpsConnectionSecretStore,
  PgAzureDevOpsRepositoryBindingRepo
} from '../../src/persistence/repositories/azure-devops.repo.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const CONSOLE = 'https://console.example.test'
const DEPLOYMENT_SECRET = 'deployment-secret'
const TICKET = 'x-azure-devops-flow-ticket'
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

function harness(opts: { deploymentApplication?: boolean } = {}) {
  const clock = new FakeClock(Date.now())
  const fake = new FakeAzureDevOps({
    secrets: { [DEPLOYMENT_CLIENT_ID]: DEPLOYMENT_SECRET, [CLIENT_ID]: 'example-secret' }
  })
  const connectionRepo = new PgAzureDevOpsConnectionRepo(prisma)
  const bindings = new PgAzureDevOpsRepositoryBindingRepo(prisma)
  const app =
    opts.deploymentApplication === false
      ? undefined
      : { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET }
  const service = new AzureDevOpsConnectionService({
    connections: connectionRepo,
    secrets: new PgAzureDevOpsConnectionSecretStore(prisma, cipher),
    bindings,
    cipher,
    clock,
    api: fake.api,
    tokens: new AzureDevOpsTokenCache(() => clock.now()),
    ...(app ? { deploymentApplication: app } : {})
  })
  const connect = new AzureDevOpsConnectFlowService({
    api: fake.api,
    keys: azureDevOpsConnectKeys('example-pepper-example-pepper-example-pepper'),
    clock,
    connections: service,
    connectionRepo,
    ...(app ? { deploymentApplication: app } : {}),
    webAppUrl: CONSOLE
  })
  running = buildHttpApp(prisma, {}, undefined, undefined, {
    azureDevOps: {
      connections: service,
      bindings: new AzureDevOpsBindingService({ connections: connectionRepo, bindings, service, api: fake.api }),
      connect
    }
  })
  const a = running
  const post = (url: string, payload: object, ticket?: string) =>
    a.app.inject({ method: 'POST', url: `${ORG}${url}`, payload, headers: ticket ? { [TICKET]: ticket } : {} })
  const get = (url: string, ticket?: string) =>
    a.app.inject({ method: 'GET', url: `${ORG}${url}`, headers: ticket ? { [TICKET]: ticket } : {} })
  /** Steps 1 and 2: the authorize URL, then the callback with the code Microsoft returned. */
  const signIn = async (connectionId?: string) => {
    const started = await post('/azure-devops/connect', connectionId ? { connectionId } : {})
    expect(started.statusCode).toBe(200)
    const authorize = new URL(started.json().authorizeUrl as string)
    const state = authorize.searchParams.get('state')!
    const callback = await post('/azure-devops/connect/callback', { state, code: AUTH_CODE })
    return { authorize, state, callback }
  }
  /** Through step 3, with the organization chosen. */
  const toProjects = async (connectionId?: string) => {
    const { callback } = await signIn(connectionId)
    expect(callback.statusCode).toBe(200)
    const { flowId, ticket } = callback.json() as { flowId: string; ticket: string }
    const chosen = await post(`/azure-devops/connect/${flowId}/organization`, { organization: ORGANIZATION }, ticket)
    expect(chosen.statusCode).toBe(200)
    return { flowId, ticket: chosen.json().ticket as string, projects: chosen.json().projects }
  }
  const calls = (method: string, prefix: string) =>
    fake.requests.filter((r) => r.method === method && r.url.startsWith(prefix))
  return { a, fake, clock, service, connectionRepo, post, get, signIn, toProjects, calls }
}

const contributors = (projectId: string) => `vssgp.contributors.${projectId}`
const readers = (projectId: string) => `vssgp.readers.${projectId}`

describe('the sign-in (§3.2 steps 1-2)', () => {
  it('signs a state and asks for the delegated scope with PKCE at the organizations authority, redirecting to the Console', async () => {
    const h = harness()
    const { authorize, callback } = await h.signIn()
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize'
    )
    const q = authorize.searchParams
    expect(q.get('client_id')).toBe(DEPLOYMENT_CLIENT_ID)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('redirect_uri')).toBe(`${CONSOLE}/azure-devops/connect`)
    expect(q.get('scope')).toBe('openid User.Read 499b84ac-1321-427f-aa17-267ca6975798/user_impersonation')
    expect(q.get('code_challenge_method')).toBe('S256')
    // Only the Control Plane holds the verifier that matches the challenge.
    expect(callback.statusCode).toBe(200)
    const verifier = h.fake.redeemed!.get('code_verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(q.get('code_challenge'))
    expect(h.fake.redeemed!.get('redirect_uri')).toBe(`${CONSOLE}/azure-devops/connect`)
    expect(h.fake.redeemed!.get('client_secret')).toBe(DEPLOYMENT_SECRET)
    const body = callback.json()
    expect(body).toMatchObject({ tenantId: TENANT_ID, connectionId: null, organization: null })
    // The ticket is opaque: the delegated token is sealed, never readable in it.
    expect(body.ticket).not.toContain(ADMIN_TOKEN)
    expect(Buffer.from(String(body.ticket).split('.')[2]!, 'base64url').toString('latin1')).not.toContain(ADMIN_TOKEN)
  })

  it('refuses without a deployment application, and a second connection', async () => {
    const none = harness({ deploymentApplication: false })
    const refused = await none.post('/azure-devops/connect', {})
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'deployment_application_missing' })
    await running!.close()
    running = undefined

    const h = harness()
    await h.post('/azure-devops/connections', {
      organization: ORGANIZATION,
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: 'example-secret'
    })
    const second = await h.post('/azure-devops/connect', {})
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'connection_exists' })
  })

  it('refuses a tampered or expired state', async () => {
    const h = harness()
    const started = await h.post('/azure-devops/connect', {})
    const state = new URL(started.json().authorizeUrl as string).searchParams.get('state')!
    const [payload, sig] = state.split('.')
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))
    forged.o = '00000000-0000-4000-8000-0000000000ff'
    const tampered = await h.post('/azure-devops/connect/callback', {
      state: `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`,
      code: AUTH_CODE
    })
    expect(tampered.statusCode).toBe(400)
    expect(tampered.json()).toMatchObject({ code: 'connect_state_invalid' })
    h.clock.advance(11 * 60_000)
    const expired = await h.post('/azure-devops/connect/callback', { state, code: AUTH_CODE })
    expect(expired.statusCode).toBe(400)
    expect(expired.json()).toMatchObject({ code: 'connect_state_invalid' })
    expect(h.fake.redeemed).toBeUndefined()
  })

  it('refuses a personal Microsoft account', async () => {
    const h = harness()
    h.fake.admin.signInTenant = CONSUMER_TENANT
    const { callback } = await h.signIn()
    expect(callback.statusCode).toBe(400)
    expect(callback.json()).toMatchObject({ code: 'personal_account' })
    expect(callback.json().ticket).toBeUndefined()
  })

  it('tells the person an Entra administrator must consent, with the admin-consent URL once the tenant is known', async () => {
    const h = harness()
    const started = await h.post('/azure-devops/connect', {})
    const state = new URL(started.json().authorizeUrl as string).searchParams.get('state')!
    const pageError = await h.post('/azure-devops/connect/callback', {
      state,
      error: 'access_denied',
      error_description: 'AADSTS90094: admin approval required'
    })
    expect(pageError.statusCode).toBe(403)
    expect(pageError.json()).toMatchObject({ code: 'consent_required' })
    expect(pageError.json().message).toMatch(/administrator/)
    expect(pageError.json().adminConsentUrl).toBeUndefined()

    // Manage project access knows the tenant, so the refusal carries the link.
    const connection = await h.service.connectDeploymentApplication(DEFAULT_ORG_ID, {
      organization: ORGANIZATION,
      tenantId: TENANT_ID
    })
    h.fake.admin.consentRequired = true
    const { callback } = await h.signIn(connection.id)
    expect(callback.statusCode).toBe(403)
    expect(callback.json()).toMatchObject({
      code: 'consent_required',
      adminConsentUrl: `https://login.microsoftonline.com/${TENANT_ID}/adminconsent?client_id=${DEPLOYMENT_CLIENT_ID}`
    })
  })
})

describe('organizations and projects (§3.2 steps 3-4)', () => {
  it('lists the administrator’s organizations and the chosen organization’s projects', async () => {
    const h = harness()
    const { callback } = await h.signIn()
    const { flowId, ticket } = callback.json() as { flowId: string; ticket: string }
    const organizations = await h.get(`/azure-devops/connect/${flowId}/organizations`, ticket)
    expect(organizations.statusCode).toBe(200)
    expect(organizations.json()).toEqual({ organizations: [{ id: expect.any(String), name: ORGANIZATION }] })
    const chosen = await h.post(`/azure-devops/connect/${flowId}/organization`, { organization: ORGANIZATION }, ticket)
    expect(chosen.statusCode).toBe(200)
    expect(chosen.json()).toMatchObject({
      organization: ORGANIZATION,
      projects: [
        { id: PROJECT_ID, name: 'Example Project' },
        { id: SECOND_PROJECT_ID, name: 'Second Project' }
      ]
    })
    expect(chosen.json().ticket).not.toBe(ticket)
  })

  it('adds the service principal with Basic, makes one membership per project by principal name, and connects', async () => {
    const h = harness()
    h.fake.admin.spInOrganization = false
    const { flowId, ticket } = await h.toProjects()
    const res = await h.post(
      `/azure-devops/connect/${flowId}/projects`,
      {
        projects: [
          { projectId: PROJECT_ID, group: 'contributors' },
          { projectId: SECOND_PROJECT_ID, group: 'readers' }
        ]
      },
      ticket
    )
    expect(res.statusCode).toBe(200)
    const [entitlement] = h.calls('POST', ENTITLEMENTS_BASE)
    expect(entitlement!.url).toBe(
      `${ENTITLEMENTS_BASE}/${ORGANIZATION}/_apis/serviceprincipalentitlements?api-version=7.1-preview.1`
    )
    expect(JSON.parse(entitlement!.body!)).toEqual({
      accessLevel: { accountLicenseType: 'express' },
      servicePrincipal: { origin: 'aad', originId: SP_OBJECT_ID, subjectKind: 'servicePrincipal' }
    })
    // Contributors already reads; the decoy whose display text reads Contributors is never chosen.
    expect([...h.fake.admin.memberships].sort()).toEqual(
      [`aadsp.${IDENTITY_ID}|${contributors(PROJECT_ID)}`, `aadsp.${IDENTITY_ID}|${readers(SECOND_PROJECT_ID)}`].sort()
    )
    expect(res.json()).toMatchObject({
      connection: {
        organization: ORGANIZATION,
        tenantId: TENANT_ID,
        credentialSource: 'deployment',
        state: 'connected'
      },
      memberships: [
        { projectId: PROJECT_ID, group: 'contributors', outcome: 'added' },
        { projectId: SECOND_PROJECT_ID, group: 'readers', outcome: 'added' }
      ]
    })
  })

  it('skips the entitlement for a service principal already in the organization, and counts an existing membership as made', async () => {
    const h = harness()
    h.fake.admin.memberships.add(`aadsp.${IDENTITY_ID}|${contributors(PROJECT_ID)}`)
    const { flowId, ticket } = await h.toProjects()
    const res = await h.post(
      `/azure-devops/connect/${flowId}/projects`,
      { projects: [{ projectId: PROJECT_ID, group: 'contributors' }] },
      ticket
    )
    expect(res.statusCode).toBe(200)
    expect(h.calls('POST', ENTITLEMENTS_BASE)).toHaveLength(0)
    expect(res.json().memberships).toEqual([
      { projectId: PROJECT_ID, projectName: 'Example Project', group: 'contributors', outcome: 'already_member' }
    ])
  })

  it('refuses a project the organization does not have', async () => {
    const h = harness()
    const { flowId, ticket } = await h.toProjects()
    const res = await h.post(
      `/azure-devops/connect/${flowId}/projects`,
      { projects: [{ projectId: '00000000-0000-4000-8000-0000000000ee', group: 'readers' }] },
      ticket
    )
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'project_not_found' })
  })
})

describe('below Project Collection Administrator (§3.2 step 4)', () => {
  it('reads 200 with isSuccess false and 5032 as a refusal naming the role, still makes the memberships, and resumes at verify', async () => {
    const h = harness()
    h.fake.admin.spInOrganization = false
    h.fake.admin.entitlement = 'refuse5032'
    const { flowId, ticket } = await h.toProjects()
    const refused = await h.post(
      `/azure-devops/connect/${flowId}/projects`,
      {
        projects: [
          { projectId: PROJECT_ID, group: 'contributors' },
          { projectId: SECOND_PROJECT_ID, group: 'readers' }
        ]
      },
      ticket
    )
    expect(refused.statusCode).toBe(403)
    const body = refused.json()
    expect(body.code).toBe('project_collection_administrator_required')
    expect(body.message).toContain('Project Collection Administrator')
    expect(body.memberships.map((m: { outcome: string }) => m.outcome)).toEqual(['added', 'added'])
    expect(body.inOrganization).toBe(true)
    expect(body.checklist.join('\n')).toContain('Basic')
    expect(h.calls('POST', `${GRAPH_BASE}/${ORGANIZATION}/_apis/graph/serviceprincipals`)).toHaveLength(1)
    expect(await h.connectionRepo.listForOrg(DEFAULT_ORG_ID)).toHaveLength(0)

    // At Stakeholder nothing is reachable yet; the ticket survives the refusal.
    const early = await h.post(`/azure-devops/connect/${flowId}/verify`, {}, body.ticket)
    expect(early.statusCode).toBe(409)
    expect(early.json()).toMatchObject({ code: 'no_repository_access' })
    expect(early.json().ticket).toBeTruthy()

    // A Project Collection Administrator raises the level by hand; verify connects.
    h.fake.admin.spBasic = true
    const verified = await h.post(`/azure-devops/connect/${flowId}/verify`, {}, body.ticket)
    expect(verified.statusCode).toBe(200)
    expect(verified.json().connection).toMatchObject({ credentialSource: 'deployment', state: 'connected' })
    expect(verified.json().memberships.map((m: { outcome: string }) => m.outcome)).toEqual([
      'already_member',
      'already_member'
    ])
  })

  it('returns a checklist naming the client ID when nothing could be made, and verify resumes after the manual add', async () => {
    const h = harness()
    h.fake.admin.spInOrganization = false
    h.fake.admin.entitlement = 'refuse5032'
    h.fake.admin.membershipsAllowed = false
    const { flowId, ticket } = await h.toProjects()
    const refused = await h.post(
      `/azure-devops/connect/${flowId}/projects`,
      { projects: [{ projectId: PROJECT_ID, group: 'contributors' }] },
      ticket
    )
    expect(refused.statusCode).toBe(403)
    const body = refused.json()
    expect(body).toMatchObject({ code: 'project_collection_administrator_required', inOrganization: false })
    expect(body.memberships).toEqual([expect.objectContaining({ outcome: 'refused' })])
    const checklist = body.checklist.join('\n')
    expect(checklist).toContain(DEPLOYMENT_CLIENT_ID)
    expect(checklist).toContain('Contributors group of Example Project')

    const notYet = await h.post(`/azure-devops/connect/${flowId}/verify`, {}, body.ticket)
    expect(notYet.statusCode).toBe(409)
    expect(notYet.json()).toMatchObject({ code: 'not_in_organization' })
    expect(notYet.json().checklist.join('\n')).toContain(DEPLOYMENT_CLIENT_ID)

    // The administrator adds it by hand, with Basic and the group.
    h.fake.admin.spInOrganization = true
    h.fake.admin.spBasic = true
    const verified = await h.post(`/azure-devops/connect/${flowId}/verify`, {}, body.ticket)
    expect(verified.statusCode).toBe(200)
    expect(verified.json().connection).toMatchObject({ organization: ORGANIZATION, state: 'connected' })
    expect(h.calls('POST', ENTITLEMENTS_BASE)).toHaveLength(1)
  })
})

describe('Manage project access (§3.2)', () => {
  it('signs in at the connection’s tenant, keeps its organization, applies memberships, and recovers its state', async () => {
    const h = harness()
    const connection = await h.service.connectDeploymentApplication(DEFAULT_ORG_ID, {
      organization: ORGANIZATION,
      tenantId: TENANT_ID
    })
    await h.connectionRepo.setState(connection.id, 'degraded', 'access_revoked')
    const { authorize, callback } = await h.signIn(connection.id)
    expect(authorize.pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/authorize`)
    expect(callback.json()).toMatchObject({ connectionId: connection.id, organization: ORGANIZATION })
    const { flowId, ticket } = callback.json() as { flowId: string; ticket: string }
    const other = await h.post(`/azure-devops/connect/${flowId}/organization`, { organization: 'other-org' }, ticket)
    expect(other.statusCode).toBe(409)
    expect(other.json()).toMatchObject({ code: 'organization_fixed' })
    const chosen = await h.post(`/azure-devops/connect/${flowId}/organization`, { organization: ORGANIZATION }, ticket)
    const res = await h.post(
      `/azure-devops/connect/${flowId}/projects`,
      { projects: [{ projectId: SECOND_PROJECT_ID, group: 'contributors' }] },
      chosen.json().ticket
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().connection).toMatchObject({ id: connection.id, state: 'connected', stateReason: null })
    expect(h.fake.admin.memberships.has(`aadsp.${IDENTITY_ID}|${contributors(SECOND_PROJECT_ID)}`)).toBe(true)
    expect(h.calls('POST', ENTITLEMENTS_BASE)).toHaveLength(0)
    expect(await h.connectionRepo.listForOrg(DEFAULT_ORG_ID)).toHaveLength(1)
  })

  it('refuses a connection made with an own application', async () => {
    const h = harness()
    const own = await h.post('/azure-devops/connections', {
      organization: ORGANIZATION,
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      clientSecret: 'example-secret'
    })
    const res = await h.post('/azure-devops/connect', { connectionId: own.json().id })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'connection_not_deployment' })
  })
})

describe('the flow ticket', () => {
  it('is never persisted, and an expired, foreign or missing ticket is refused', async () => {
    const h = harness()
    const { flowId, ticket } = await h.toProjects()
    const done = await h.post(
      `/azure-devops/connect/${flowId}/projects`,
      { projects: [{ projectId: PROJECT_ID, group: 'readers' }] },
      ticket
    )
    expect(done.statusCode).toBe(200)
    expect(done.json().ticket).toBeUndefined()
    // No text column anywhere holds the delegated token.
    const columns = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND data_type IN ('text', 'character varying', 'jsonb', 'json')`
    )
    for (const { table_name, column_name } of columns) {
      const hits = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "${table_name}" WHERE "${column_name}"::text LIKE $1`,
        `%${ADMIN_TOKEN}%`
      )
      expect(Number(hits[0]!.n), `${table_name}.${column_name}`).toBe(0)
    }

    const missing = await h.get(`/azure-devops/connect/${flowId}/organizations`)
    expect(missing.statusCode).toBe(400)
    const foreign = await h.get('/azure-devops/connect/00000000-0000-4000-8000-0000000000dd/organizations', ticket)
    expect(foreign.statusCode).toBe(400)
    h.clock.advance(31 * 60_000)
    const expired = await h.get(`/azure-devops/connect/${flowId}/organizations`, ticket)
    expect(expired.statusCode).toBe(400)
    expect(expired.json()).toMatchObject({ code: 'connect_flow_invalid' })
  })
})
