// A stateful fake of the Entra token endpoint and dev.azure.com, shaped like azure-devops-integration.md §12's answers; every identifier is synthetic.
import { AzureDevOpsApiClient, type FetchLike } from '../../src/azure-devops/api.js'

// The fixed hosts themselves: the fake answers in place of the network, so the production URLs are what is exercised.
export const LOGIN_BASE = 'https://login.microsoftonline.com'
export const DEVOPS_BASE = 'https://dev.azure.com'
export const PROFILE_BASE = 'https://app.vssps.visualstudio.com'
export const ENTITLEMENTS_BASE = 'https://vsaex.dev.azure.com'
export const GRAPH_BASE = 'https://vssps.dev.azure.com'

export const TENANT_ID = '00000000-0000-4000-8000-0000000000a1'
export const CLIENT_ID = '00000000-0000-4000-8000-0000000000c1'
export const DEPLOYMENT_CLIENT_ID = '00000000-0000-4000-8000-0000000000d1'
export const INSTANCE_ID = '00000000-0000-4000-8000-0000000000e1'
export const IDENTITY_ID = '00000000-0000-4000-8000-0000000000f1'
export const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
export const REPOSITORY_ID = '00000000-0000-4000-8000-000000000002'
export const SECOND_REPOSITORY_ID = '00000000-0000-4000-8000-000000000003'
export const SP_OBJECT_ID = '00000000-0000-4000-8000-0000000000b1'
export const ADMIN_ID = '00000000-0000-4000-8000-0000000000b2'
export const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000b3'
export const SECOND_PROJECT_ID = '00000000-0000-4000-8000-000000000004'
export const AUTH_CODE = 'example-code'
export const ADMIN_TOKEN = 'example-admin-token'
export const ORGANIZATION = 'example-org'
export const PROJECT = 'Example Project'
export const REPOSITORY = 'Example Repo'

export interface FakeAzureRepository {
  id: string
  name: string
  projectId: string
  projectName: string
  defaultBranch?: string
  isDisabled?: boolean
  isInMaintenance?: boolean
  /** Whether the identity holds GenericContribute (§12 item 7). */
  contribute: boolean
}

export interface FakeAzureDevOpsOptions {
  /** client ID → the one secret Entra accepts for it. */
  secrets?: Record<string, string>
  repositories?: FakeAzureRepository[]
  expiresInSec?: number
}

export function exampleRepository(overrides: Partial<FakeAzureRepository> = {}): FakeAzureRepository {
  return {
    id: REPOSITORY_ID,
    name: REPOSITORY,
    projectId: PROJECT_ID,
    projectName: PROJECT,
    defaultBranch: 'refs/heads/main',
    contribute: true,
    ...overrides
  }
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** The delegated sign-in and the organization's administration side (§3.2 steps 1-4). */
export interface FakeAdministration {
  /** The tenant the ID token names; the consumer tenant is a personal account. */
  signInTenant: string
  /** Refuse the code redemption as Entra does for missing consent. */
  consentRequired: boolean
  /** Whether the application's service principal is in the organization, and at Basic. */
  spInOrganization: boolean
  spBasic: boolean
  entitlement: 'success' | 'refuse5032'
  /** Whether the caller may make Graph memberships, and add the principal through a group. */
  membershipsAllowed: boolean
  projects: Array<{ id: string; name: string }>
  /** Existing memberships as `subject|group`. */
  memberships: Set<string>
}

export class FakeAzureDevOps {
  readonly requests: Array<{ method: string; url: string; body?: string }> = []
  readonly admin: FakeAdministration = {
    signInTenant: TENANT_ID,
    consentRequired: false,
    spInOrganization: true,
    spBasic: true,
    entitlement: 'success',
    membershipsAllowed: true,
    projects: [
      { id: PROJECT_ID, name: PROJECT },
      { id: SECOND_PROJECT_ID, name: 'Second Project' }
    ],
    memberships: new Set()
  }
  /** The last code redemption's form, for the PKCE and redirect assertions. */
  redeemed: URLSearchParams | undefined
  secrets: Record<string, string>
  repositories: FakeAzureRepository[]
  expiresInSec: number
  /** Which identity and organization connectionData reports. */
  identityId = IDENTITY_ID
  instanceId = INSTANCE_ID
  /** When set, every dev.azure.com call answers 401 with this TF code (`TF401444`, `TF400813`). */
  revoked: string | undefined
  /** When set, the next dev.azure.com call answers a plain 401, as for a token that went stale. */
  staleTokenOnce = false
  /** When set, the next dev.azure.com call answers 429 with this Retry-After. */
  throttleOnceSec: number | undefined
  tokensIssued = 0
  readonly api: AzureDevOpsApiClient

  constructor(opts: FakeAzureDevOpsOptions = {}, now?: () => number) {
    this.secrets = opts.secrets ?? { [CLIENT_ID]: 'example-secret' }
    this.repositories = opts.repositories ?? [exampleRepository()]
    this.expiresInSec = opts.expiresInSec ?? 3599
    this.api = new AzureDevOpsApiClient({ fetch: this.fetch, ...(now ? { now } : {}) })
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  }

  readonly fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    this.requests.push({ method, url, ...(init?.body !== undefined ? { body: String(init.body) } : {}) })
    if (url.startsWith(`${LOGIN_BASE}/`)) return this.token(url, String(init?.body ?? ''))
    if (url.startsWith(`${DEVOPS_BASE}/`)) return this.devOps(url, method, init)
    if ([PROFILE_BASE, ENTITLEMENTS_BASE, GRAPH_BASE].some((base) => url.startsWith(`${base}/`))) {
      return this.administration(url, method, init)
    }
    return this.json(404, { message: 'unknown host' })
  }

  private token(url: string, body: string): Response {
    const form = new URLSearchParams(body)
    if (form.get('grant_type') === 'authorization_code') return this.redeem(url, form)
    if (!url.endsWith(`/${TENANT_ID}/oauth2/v2.0/token`)) {
      return this.json(400, { error: 'invalid_request', error_codes: [90002] })
    }
    const clientId = form.get('client_id') ?? ''
    if (!(clientId in this.secrets)) return this.json(400, { error: 'unauthorized_client', error_codes: [700016] })
    if (this.secrets[clientId] !== form.get('client_secret')) {
      return this.json(401, {
        error: 'invalid_client',
        error_description: 'AADSTS7000215: Invalid client secret provided.',
        error_codes: [7000215]
      })
    }
    this.tokensIssued += 1
    return this.json(200, {
      token_type: 'Bearer',
      expires_in: this.expiresInSec,
      // The first segment keeps the prefix the dev.azure.com check reads; the payload carries the service principal's claims.
      access_token: `example-token-${this.tokensIssued}.${b64({ oid: SP_OBJECT_ID, tid: TENANT_ID, app_displayname: 'Example Application' })}.sig`
    })
  }

  private redeem(url: string, form: URLSearchParams): Response {
    this.redeemed = form
    if (this.admin.consentRequired) {
      return this.json(400, {
        error: 'invalid_grant',
        error_description: 'AADSTS65001: The user or administrator has not consented to use the application.',
        error_codes: [65001]
      })
    }
    if (!url.endsWith('/oauth2/v2.0/token') || form.get('code') !== AUTH_CODE || !form.get('code_verifier')) {
      return this.json(400, { error: 'invalid_grant' })
    }
    const clientId = form.get('client_id') ?? ''
    if (this.secrets[clientId] !== form.get('client_secret')) return this.json(401, { error: 'invalid_client' })
    return this.json(200, {
      token_type: 'Bearer',
      expires_in: 3599,
      access_token: ADMIN_TOKEN,
      id_token: `${b64({ alg: 'none' })}.${b64({ tid: this.admin.signInTenant, aud: clientId, oid: ADMIN_ID })}.sig`
    })
  }

  private administration(url: string, method: string, init?: RequestInit): Response {
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${ADMIN_TOKEN}`) {
      return this.json(401, { message: 'unauthorized' })
    }
    const u = new URL(url)
    const path = decodeURIComponent(u.pathname)
    const admin = this.admin
    if (url.startsWith(PROFILE_BASE)) {
      if (path === '/_apis/profile/profiles/me') return this.json(200, { id: ADMIN_ID, displayName: 'Example Admin' })
      if (path === '/_apis/accounts' && u.searchParams.get('memberId') === ADMIN_ID) {
        return this.json(200, { count: 1, value: [{ accountId: ACCOUNT_ID, accountName: ORGANIZATION }] })
      }
      return this.json(404, { message: 'not found' })
    }
    const org = `/${ORGANIZATION}/_apis`
    if (url.startsWith(ENTITLEMENTS_BASE)) {
      if (path !== `${org}/serviceprincipalentitlements` || method !== 'POST') return this.json(404, {})
      if (admin.entitlement === 'refuse5032') {
        return this.json(200, {
          isSuccess: false,
          operationResult: { isSuccess: false, errors: [{ key: 5032, value: 'Add Users' }], result: null }
        })
      }
      admin.spInOrganization = true
      admin.spBasic = true
      return this.json(200, {
        isSuccess: true,
        operationResult: {
          isSuccess: true,
          errors: [],
          result: {
            accessLevel: { accountLicenseType: 'express' },
            servicePrincipal: { descriptor: `aadsp.${IDENTITY_ID}` }
          }
        }
      })
    }
    if (path.startsWith(`${org}/graph/descriptors/`) && method === 'GET') {
      const key = path.slice(`${org}/graph/descriptors/`.length)
      if (admin.projects.some((project) => project.id === key)) return this.json(200, { value: `scp.${key}` })
      if (key === IDENTITY_ID && admin.spInOrganization) return this.json(200, { value: `aadsp.${key}` })
      return this.json(404, { message: 'not found' })
    }
    if (path === `${org}/graph/groups` && method === 'GET') {
      const projectId = (u.searchParams.get('scopeDescriptor') ?? '').replace(/^scp\./, '')
      const project = admin.projects.find((p) => p.id === projectId)
      if (!project) return this.json(404, { message: 'not found' })
      const domain = `vstfs:///Classification/TeamProject/${project.id}`
      const group = (kind: string, displayName: string, name: string) => ({
        descriptor: `vssgp.${kind}.${project.id}`,
        displayName,
        principalName: `[${project.name}]\\${name}`,
        domain
      })
      return this.json(200, {
        value: [
          // A decoy whose display text reads Contributors but whose principal name is another group's.
          group('leads', 'Contributors', 'Contributors Leads'),
          group('admins', 'Project Administrators', 'Project Administrators'),
          group('readers', 'Leser', 'Readers'),
          group('contributors', 'Mitwirkende', 'Contributors')
        ]
      })
    }
    if (path.startsWith(`${org}/graph/memberships/`) && method === 'PUT') {
      if (!admin.membershipsAllowed) return this.json(403, { message: 'TF50309: insufficient permissions' })
      const [subject, group] = path.slice(`${org}/graph/memberships/`.length).split('/')
      const key = `${subject}|${group}`
      if (admin.memberships.has(key)) return this.json(200, { containerDescriptor: group })
      admin.memberships.add(key)
      return this.json(201, { containerDescriptor: group })
    }
    if (path === `${org}/graph/serviceprincipals` && method === 'POST') {
      if (!admin.membershipsAllowed) return this.json(403, { message: 'TF50309: insufficient permissions' })
      const subject = `aadsp.${IDENTITY_ID}`
      admin.spInOrganization = true
      // Added through a group, the principal lands at the organization's default level, Stakeholder here.
      admin.spBasic = false
      for (const group of (u.searchParams.get('groupDescriptors') ?? '').split(',').filter(Boolean)) {
        admin.memberships.add(`${subject}|${group}`)
      }
      return this.json(201, { descriptor: subject, originId: SP_OBJECT_ID })
    }
    return this.json(404, { message: 'not found' })
  }

  /** dev.azure.com as the signed-in administrator. */
  private adminDevOps(url: string): Response {
    const path = new URL(url).pathname
    if (path === `/${ORGANIZATION}/_apis/connectionData`) {
      return this.json(200, {
        authenticatedUser: { id: ADMIN_ID, providerDisplayName: 'Example Admin' },
        instanceId: this.instanceId
      })
    }
    if (path === `/${ORGANIZATION}/_apis/projects`) {
      return this.json(200, {
        count: this.admin.projects.length,
        value: this.admin.projects.map((project) => ({ ...project, state: 'wellFormed' }))
      })
    }
    return this.json(401, { message: 'TF400813: The user is not authorized to access this resource.' })
  }

  private devOps(url: string, method: string, init?: RequestInit): Response {
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (auth === `Bearer ${ADMIN_TOKEN}`) return this.adminDevOps(url)
    if (!auth.startsWith('Bearer example-token-')) return this.json(401, { message: 'TF400813: unauthorized' })
    if (!this.admin.spInOrganization) {
      return this.json(401, { message: 'TF401444: Please sign-in at least once as the service principal.' })
    }
    if (this.revoked) {
      return this.json(401, { message: `${this.revoked}: The user is not authorized to access this resource.` })
    }
    if (this.staleTokenOnce) {
      this.staleTokenOnce = false
      return this.json(401, { message: 'The token is no longer valid.' })
    }
    if (this.throttleOnceSec !== undefined) {
      const seconds = this.throttleOnceSec
      this.throttleOnceSec = undefined
      return this.json(429, { message: 'throttled' }, { 'retry-after': String(seconds) })
    }
    const path = new URL(url).pathname
    if (path === `/${ORGANIZATION}/_apis/connectionData`) {
      return this.json(200, {
        authenticatedUser: { id: this.identityId, providerDisplayName: 'Example Application' },
        authorizedUser: { id: this.identityId },
        instanceId: this.instanceId
      })
    }
    if (path === `/${ORGANIZATION}/_apis/git/repositories` && method === 'GET') {
      // Stakeholder reaches no repository (§12 item 2).
      const visible = this.admin.spBasic ? this.repositories : []
      return this.json(200, {
        count: visible.length,
        value: visible.map((repo) => ({
          id: repo.id,
          name: repo.name,
          project: { id: repo.projectId, name: repo.projectName, state: 'wellFormed' },
          defaultBranch: repo.defaultBranch,
          remoteUrl: `https://${ORGANIZATION}@dev.azure.com/${ORGANIZATION}/${encodeURIComponent(repo.projectName)}/_git/${encodeURIComponent(repo.name)}`,
          isDisabled: repo.isDisabled ?? false,
          ...(repo.isInMaintenance !== undefined ? { isInMaintenance: repo.isInMaintenance } : {})
        }))
      })
    }
    if (path === `/${ORGANIZATION}/_apis/security/permissionevaluationbatch` && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        evaluations: Array<{ securityNamespaceId: string; token: string; permissions: number }>
      }
      return this.json(200, {
        evaluations: body.evaluations.map((evaluation) => {
          const repositoryId = evaluation.token.split('/')[2]
          const repo = this.repositories.find((r) => r.id === repositoryId)
          const value = repo ? (evaluation.permissions === 4 ? repo.contribute : true) : false
          return { ...evaluation, value }
        })
      })
    }
    return this.json(404, { message: 'not found' })
  }
}
