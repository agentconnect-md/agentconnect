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
import {
  AzureDevOpsConnectionService,
  azureDevOpsSecretFingerprint
} from '../../src/azure-devops/connection.service.js'
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
    secretFingerprint: azureDevOpsSecretFingerprint('example-pepper-example-pepper-example-pepper'),
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
      userAuthz: fake.userAuthz(service),
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
    return {
      flowId,
      ticket: chosen.json().ticket as string,
      projects: chosen.json().projects,
      allProjects: chosen.json().allProjects
    }
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

    // Added through a group at Stakeholder: verify tries the raise, which the same caller is refused again.
    const early = await h.post(`/azure-devops/connect/${flowId}/verify`, {}, body.ticket)
    expect(early.statusCode).toBe(403)
    expect(early.json()).toMatchObject({ code: 'project_collection_administrator_required', inOrganization: true })
    expect(early.json().ticket).toBeTruthy()

    // A caller who may grant Basic verifies: the raise goes through and the flow connects.
    h.fake.admin.entitlement = 'success'
    const verified = await h.post(`/azure-devops/connect/${flowId}/verify`, {}, body.ticket)
    expect(verified.statusCode).toBe(200)
    expect(h.calls('PATCH', ENTITLEMENTS_BASE)).toHaveLength(2)
    expect(h.fake.admin.spAccessLevel).toBe('express')
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

    // A Project Collection Administrator adds it by hand, with Basic and the group.
    h.fake.admin.spInOrganization = true
    h.fake.admin.spAccessLevel = 'express'
    h.fake.admin.memberships.add(`aadsp.${IDENTITY_ID}|${contributors(PROJECT_ID)}`)
    // The caller still cannot make or confirm any membership, so nothing proves they administer it there.
    const unproven = await h.post(`/azure-devops/connect/${flowId}/verify`, {}, body.ticket)
    expect(unproven.statusCode).toBe(403)
    expect(unproven.json()).toMatchObject({ code: 'insufficient_rights' })
    expect(await h.connectionRepo.listForOrg(DEFAULT_ORG_ID)).toHaveLength(0)
    // As a Project Administrator of the project, the caller confirms the membership and connects.
    h.fake.admin.membershipsAllowed = true
    const verified = await h.post(`/azure-devops/connect/${flowId}/verify`, {}, body.ticket)
    expect(verified.statusCode).toBe(200)
    expect(verified.json().memberships).toEqual([expect.objectContaining({ outcome: 'already_member' })])
    expect(verified.json().connection).toMatchObject({ organization: ORGANIZATION, state: 'connected' })
    expect(h.calls('POST', ENTITLEMENTS_BASE)).toHaveLength(1)
    expect(h.calls('PATCH', ENTITLEMENTS_BASE)).toHaveLength(0)
  })
})

describe('a member below Basic (§3.2 step 4)', () => {
  const apply = async (h: ReturnType<typeof harness>) => {
    const { flowId, ticket } = await h.toProjects()
    return h.post(
      `/azure-devops/connect/${flowId}/projects`,
      { projects: [{ projectId: PROJECT_ID, group: 'contributors' }] },
      ticket
    )
  }

  it('raises a Stakeholder member to Basic with the entitlement patch and connects', async () => {
    const h = harness()
    h.fake.admin.spAccessLevel = 'stakeholder'
    const res = await apply(h)
    expect(res.statusCode).toBe(200)
    expect(h.calls('POST', ENTITLEMENTS_BASE)).toHaveLength(0)
    const [patch] = h.calls('PATCH', ENTITLEMENTS_BASE)
    expect(patch!.url).toBe(
      `${ENTITLEMENTS_BASE}/${ORGANIZATION}/_apis/serviceprincipalentitlements/${IDENTITY_ID}?api-version=7.1-preview.1`
    )
    expect(JSON.parse(patch!.body!)).toEqual([
      {
        from: '',
        op: 'replace',
        path: '/accessLevel',
        value: { accountLicenseType: 'express', licensingSource: 'account' }
      }
    ])
    expect(res.json().connection).toMatchObject({ state: 'connected' })
  })

  it('answers a refused raise (5032) with the Project Collection Administrator checklist and a ticket', async () => {
    const h = harness()
    h.fake.admin.spAccessLevel = 'stakeholder'
    h.fake.admin.entitlement = 'refuse5032'
    const res = await apply(h)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      code: 'project_collection_administrator_required',
      inOrganization: true,
      memberships: [expect.objectContaining({ outcome: 'added' })]
    })
    expect(res.json().checklist.join('\n')).toContain('Basic')
    expect(res.json().ticket).toBeTruthy()
    expect(await h.connectionRepo.listForOrg(DEFAULT_ORG_ID)).toHaveLength(0)
  })

  it('leaves a member above Basic alone', async () => {
    const h = harness()
    h.fake.admin.spAccessLevel = 'advanced'
    const res = await apply(h)
    expect(res.statusCode).toBe(200)
    expect(h.calls('PATCH', ENTITLEMENTS_BASE)).toHaveLength(0)
    expect(h.fake.admin.spAccessLevel).toBe('advanced')
  })
})

describe('authority and tenant (§3.2)', () => {
  it('refuses to connect a service principal already in the organization when the caller can make no membership', async () => {
    const h = harness()
    h.fake.admin.membershipsAllowed = false
    const { flowId, ticket } = await h.toProjects()
    const res = await h.post(
      `/azure-devops/connect/${flowId}/projects`,
      {
        projects: [
          { projectId: PROJECT_ID, group: 'readers' },
          { projectId: SECOND_PROJECT_ID, group: 'contributors' }
        ]
      },
      ticket
    )
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'insufficient_rights', inOrganization: true })
    expect(res.json().ticket).toBeUndefined()
    const checklist = res.json().checklist.join('\n')
    expect(checklist).toContain('Project Administrator')
    expect(checklist).toContain('Project Collection Administrator')
    expect(await h.connectionRepo.listForOrg(DEFAULT_ORG_ID)).toHaveLength(0)
  })

  it('sends a guest who signed in at another tenant back to the organization’s own tenant', async () => {
    const h = harness()
    const resourceTenant = '00000000-0000-4000-8000-0000000000a2'
    h.fake.resourceTenant = resourceTenant
    const { callback } = await h.signIn()
    const { flowId, ticket } = callback.json() as { flowId: string; ticket: string }
    const refused = await h.post(`/azure-devops/connect/${flowId}/organization`, { organization: ORGANIZATION }, ticket)
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'tenant_mismatch' })
    const again = new URL(refused.json().authorizeUrl as string)
    expect(again.pathname).toBe(`/${resourceTenant}/oauth2/v2.0/authorize`)
    expect(again.searchParams.get('code_challenge_method')).toBe('S256')
    // The unauthenticated read carried no token.
    const probe = h.fake.requests.find((r) => r.url === `https://dev.azure.com/${ORGANIZATION}/_apis/connectionData`)
    expect(probe).toBeDefined()
    // Signing in again at that tenant is a new connect pinned to it.
    h.fake.admin.signInTenant = resourceTenant
    const pinned = await h.post('/azure-devops/connect/callback', {
      state: again.searchParams.get('state')!,
      code: AUTH_CODE
    })
    expect(pinned.statusCode).toBe(200)
    expect(pinned.json()).toMatchObject({ tenantId: resourceTenant, connectionId: null })
    expect(h.fake.redeemed!.get('client_id')).toBe(DEPLOYMENT_CLIENT_ID)
  })

  it('falls back to the signed-in tenant when Azure DevOps names none', async () => {
    const h = harness()
    h.fake.resourceTenant = null
    await h.toProjects()
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

describe('Allow triggers (§11.1)', () => {
  const SP_DESCRIPTOR = `Microsoft.VisualStudio.Services.Claims.AadServicePrincipal;${TENANT_ID}\\${SP_OBJECT_ID}`

  it('grants View and Edit subscriptions by default with Contributors, on request with Readers, and not otherwise', async () => {
    const h = harness()
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
    expect(h.fake.aceWrites).toEqual([
      { token: `PublisherSecurity/${PROJECT_ID}`, descriptor: SP_DESCRIPTOR, allow: 3 }
    ])
    const [write] = h.calls('POST', `https://dev.azure.com/${ORGANIZATION}/_apis/accesscontrolentries/`)
    expect(write!.url).toBe(
      `https://dev.azure.com/${ORGANIZATION}/_apis/accesscontrolentries/cb594ebe-87dd-4fc9-ac2c-6a10a4c92046?api-version=7.1`
    )
    expect(JSON.parse(write!.body!)).toMatchObject({ merge: true, accessControlEntries: [{ allow: 3, deny: 0 }] })
    expect(res.json()).toMatchObject({
      triggers: [{ projectId: PROJECT_ID, outcome: 'granted' }]
    })
    expect(res.json().checklist).toBeUndefined()

    // Manage project access opens on what the application holds, and Apply makes Azure DevOps match the page.
    const managed = await h.toProjects(res.json().connection.id)
    expect(managed.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: PROJECT_ID, access: { group: 'contributors', allowTriggers: true } }),
        expect.objectContaining({ id: SECOND_PROJECT_ID, access: { group: 'readers', allowTriggers: false } })
      ])
    )
    const again = await h.post(
      `/azure-devops/connect/${managed.flowId}/projects`,
      {
        projects: [
          { projectId: PROJECT_ID, group: 'readers', allowTriggers: false },
          { projectId: SECOND_PROJECT_ID, group: 'readers', allowTriggers: true }
        ]
      },
      managed.ticket
    )
    expect(again.statusCode).toBe(200)
    expect(again.json().triggers).toEqual([
      { projectId: SECOND_PROJECT_ID, projectName: 'Second Project', outcome: 'granted' }
    ])
    expect(again.json().checklist).toBeUndefined()
    expect(h.fake.serviceHookGrants).toEqual(new Set([SECOND_PROJECT_ID]))
    const held = [...h.fake.admin.memberships].map((key) => key.split('|')[1])
    expect(held).toEqual(expect.arrayContaining([readers(PROJECT_ID), readers(SECOND_PROJECT_ID)]))
    expect(held).not.toContain(contributors(PROJECT_ID))

    // A project left unchecked loses its group.
    const last = await h.toProjects(res.json().connection.id)
    const dropped = await h.post(
      `/azure-devops/connect/${last.flowId}/projects`,
      { projects: [{ projectId: SECOND_PROJECT_ID, group: 'readers', allowTriggers: true }] },
      last.ticket
    )
    expect(dropped.statusCode).toBe(200)
    expect([...h.fake.admin.memberships].map((key) => key.split('|')[1])).not.toContain(readers(PROJECT_ID))
  })

  it('removes nothing when the page could not show the access already held', async () => {
    const h = harness()
    const first = await h.toProjects()
    const made = await h.post(
      `/azure-devops/connect/${first.flowId}/projects`,
      { projects: [{ projectId: PROJECT_ID, group: 'contributors' }] },
      first.ticket
    )
    expect(made.statusCode).toBe(200)
    h.fake.failMembershipReadOnce = true
    const managed = await h.toProjects(made.json().connection.id)
    expect(managed.projects.every((project: { access?: unknown }) => project.access === undefined)).toBe(true)
    const res = await h.post(
      `/azure-devops/connect/${managed.flowId}/projects`,
      { projects: [{ projectId: SECOND_PROJECT_ID, group: 'readers' }] },
      managed.ticket
    )
    expect(res.statusCode).toBe(200)
    expect([...h.fake.admin.memberships].map((key) => key.split('|')[1])).toContain(contributors(PROJECT_ID))
    expect(h.fake.serviceHookGrants).toContain(PROJECT_ID)
  })

  it('grants all projects at the organization roots, opens on it, and takes it back', async () => {
    const h = harness()
    const PROJECT_ROOT = '52d39943-cb85-4d7f-8fa8-c6baac873819'
    const GIT_ROOT = '2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87'
    const HOOKS_ROOT = 'cb594ebe-87dd-4fc9-ac2c-6a10a4c92046'
    const first = await h.toProjects()
    const made = await h.post(
      `/azure-devops/connect/${first.flowId}/projects`,
      { projects: [], allProjects: { group: 'contributors', allowTriggers: true } },
      first.ticket
    )
    expect(made.statusCode).toBe(200)
    expect(made.json().checklist).toBeUndefined()
    expect(Object.fromEntries(h.fake.rootAces)).toEqual({ [PROJECT_ROOT]: 1, [GIT_ROOT]: 16502, [HOOKS_ROOT]: 3 })

    // Lowered to Read without triggers: the Git entry is replaced and the hooks entry deleted.
    const managed = await h.toProjects(made.json().connection.id)
    expect(managed.allProjects).toEqual({ group: 'contributors', allowTriggers: true })
    const lowered = await h.post(
      `/azure-devops/connect/${managed.flowId}/projects`,
      { projects: [], allProjects: { group: 'readers', allowTriggers: false } },
      managed.ticket
    )
    expect(lowered.statusCode).toBe(200)
    expect(Object.fromEntries(h.fake.rootAces)).toEqual({ [PROJECT_ROOT]: 1, [GIT_ROOT]: 2 })

    // Unchecked: the roots are cleared, and the project picked instead is granted on its own.
    const last = await h.toProjects(made.json().connection.id)
    expect(last.allProjects).toEqual({ group: 'readers', allowTriggers: false })
    const dropped = await h.post(
      `/azure-devops/connect/${last.flowId}/projects`,
      { projects: [{ projectId: PROJECT_ID, group: 'readers' }] },
      last.ticket
    )
    expect(dropped.statusCode).toBe(200)
    expect(h.fake.rootAces.size).toBe(0)
  })

  it('finishes taking all projects back on retry after a removal cut short', async () => {
    const h = harness()
    const PROJECT_ROOT = '52d39943-cb85-4d7f-8fa8-c6baac873819'
    const GIT_ROOT = '2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87'
    const first = await h.toProjects()
    const made = await h.post(
      `/azure-devops/connect/${first.flowId}/projects`,
      { projects: [], allProjects: { group: 'contributors', allowTriggers: true } },
      first.ticket
    )
    expect(made.statusCode).toBe(200)
    const managed = await h.toProjects(made.json().connection.id)
    h.fake.failRootDeleteOnce = GIT_ROOT
    const body = { projects: [{ projectId: PROJECT_ID, group: 'readers' }] }
    const cut = await h.post(`/azure-devops/connect/${managed.flowId}/projects`, body, managed.ticket)
    expect(cut.statusCode).toBe(200)
    expect(cut.json().checklist).toContain('Remove its access to all projects.')
    // Triggers went first; project read stays until the end, so what is left is still readable.
    expect(Object.fromEntries(h.fake.rootAces)).toEqual({ [PROJECT_ROOT]: 1, [GIT_ROOT]: 16502 })
    const retried = await h.post(`/azure-devops/connect/${managed.flowId}/projects`, body, managed.ticket)
    expect(retried.statusCode).toBe(200)
    expect(retried.json().checklist).toBeUndefined()
    expect(h.fake.rootAces.size).toBe(0)
  })

  it('asks for a Project Collection Administrator when all projects is refused', async () => {
    const h = harness()
    h.fake.aceWriteAllowed = false
    const first = await h.toProjects()
    const res = await h.post(
      `/azure-devops/connect/${first.flowId}/projects`,
      {
        projects: [{ projectId: PROJECT_ID, group: 'readers' }],
        allProjects: { group: 'readers', allowTriggers: false }
      },
      first.ticket
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().checklist).toContain('Access to all projects needs a Project Collection Administrator.')
    expect(h.fake.rootAces.size).toBe(0)
  })

  it('refuses an Apply that names neither a project nor all projects', async () => {
    const h = harness()
    const first = await h.toProjects()
    const res = await h.post(`/azure-devops/connect/${first.flowId}/projects`, { projects: [] }, first.ticket)
    expect(res.statusCode).toBe(400)
  })

  it('lists a removal it may not make in the checklist', async () => {
    const h = harness()
    const first = await h.toProjects()
    const made = await h.post(
      `/azure-devops/connect/${first.flowId}/projects`,
      { projects: [{ projectId: PROJECT_ID, group: 'contributors' }] },
      first.ticket
    )
    expect(made.statusCode).toBe(200)
    h.fake.aceWriteAllowed = false
    const managed = await h.toProjects(made.json().connection.id)
    const res = await h.post(
      `/azure-devops/connect/${managed.flowId}/projects`,
      { projects: [{ projectId: PROJECT_ID, group: 'contributors', allowTriggers: false }] },
      managed.ticket
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().checklist).toEqual(['Turn off Allow triggers on Example Project.'])
    expect(h.fake.serviceHookGrants).toEqual(new Set([PROJECT_ID]))
  })

  it('reports a refused entry with a checklist naming the client ID, without failing the step', async () => {
    const h = harness()
    h.fake.aceWriteAllowed = false
    const { flowId, ticket } = await h.toProjects()
    const res = await h.post(
      `/azure-devops/connect/${flowId}/projects`,
      { projects: [{ projectId: PROJECT_ID, group: 'contributors' }] },
      ticket
    )
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      connection: { state: 'connected' },
      memberships: [{ projectId: PROJECT_ID, outcome: 'added' }],
      triggers: [{ projectId: PROJECT_ID, projectName: 'Example Project', outcome: 'refused' }]
    })
    const [item] = res.json().checklist as string[]
    expect(item).toContain('Example Project')
    expect(item).toContain(DEPLOYMENT_CLIENT_ID)
    expect(item).toContain('Project Collection Administrator')
    expect(h.fake.serviceHookGrants.size).toBe(0)
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
