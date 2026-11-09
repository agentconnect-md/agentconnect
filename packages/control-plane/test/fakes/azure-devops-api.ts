// A stateful fake of the Entra token endpoint and dev.azure.com, shaped like azure-devops-integration.md §12's answers; every identifier is synthetic.
import { AzureDevOpsApiClient, type FetchLike } from '../../src/azure-devops/api.js'
import { AzureDevOpsUserAuthzService } from '../../src/azure-devops/user-authz.js'
import type { AzureDevOpsConnectionService } from '../../src/azure-devops/connection.service.js'

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
export const USER_OBJECT_ID = '00000000-0000-4000-8000-0000000000a2'
export const USER_IDENTITY_ID = '00000000-0000-4000-8000-0000000000a3'
export const USER_DESCRIPTOR = `Microsoft.IdentityModel.Claims.ClaimsIdentity;${TENANT_ID}\\${USER_OBJECT_ID}`
export const LINKED_MICROSOFT = { objectId: USER_OBJECT_ID, email: 'alex@example.test' }
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
  /** Whether the application's service principal is in the organization, and its access level there. */
  spInOrganization: boolean
  spAccessLevel: string
  /** How the entitlement add and raise answer: a caller below Project Collection Administrator gets 5032. */
  entitlement: 'success' | 'refuse5032'
  /** Whether the caller may make Graph memberships, and add the principal through a group. */
  membershipsAllowed: boolean
  projects: Array<{ id: string; name: string }>
  /** Existing memberships as `subject|group`. */
  memberships: Set<string>
}

/** One service hook subscription as the fake stores it, with the real password Azure DevOps never echoes. */
export interface FakeSubscription {
  id: string
  status: string
  eventType: string
  publisherId: string
  consumerId: string
  consumerActionId: string
  resourceVersion: string
  publisherInputs: Record<string, string>
  consumerInputs: Record<string, string>
}

/** The Git Repositories namespace's list on one token (§11.4). */
export interface FakeAccessControlList {
  inheritPermissions?: boolean
  aces: Record<string, { allow: number; deny: number }>
}

const SERVICE_HOOKS_NAMESPACE = 'cb594ebe-87dd-4fc9-ac2c-6a10a4c92046'
const PROJECT_NAMESPACE = '52d39943-cb85-4d7f-8fa8-c6baac873819'
const GIT_NAMESPACE = '2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87'

export class FakeAzureDevOps {
  readonly user = {
    id: USER_IDENTITY_ID,
    objectId: USER_OBJECT_ID,
    tenantId: TENANT_ID,
    descriptor: USER_DESCRIPTOR,
    email: LINKED_MICROSOFT.email,
    active: true,
    metaType: 'member',
    accessLevel: {
      accountLicenseType: 'express',
      licensingSource: 'account',
      msdnLicenseType: 'none',
      status: 'active'
    }
  }
  readonly effectivePermissions = new Map<string, { effectiveAllow?: number; effectiveDeny?: number }>()
  projectVisibility: 'private' | 'public' = 'private'
  readonly requests: Array<{ method: string; url: string; body?: string }> = []
  /** Projects where the service principal holds View and Edit subscriptions (§11.1). */
  readonly serviceHookGrants = new Set<string>()
  /** Whether the signed-in administrator may write the ServiceHooks entry; the access-control entries written, by project. */
  aceWriteAllowed = true
  readonly aceWrites: Array<{ token: string; descriptor: string; allow: number }> = []
  /** Service hook subscriptions by id. */
  readonly subscriptions = new Map<string, FakeSubscription>()
  /** Subscription ids whose next PUT answers 503, once each. */
  readonly failPutOnce = new Set<string>()
  private nextSubscription = 1
  /** Identities by id: their descriptor and transitive groups. */
  readonly identities = new Map<string, { descriptor: string; memberOf: string[] }>()
  /** Git Repositories lists by token; a token absent here has no list of its own. */
  readonly acls = new Map<string, FakeAccessControlList>()
  /** The application's entries at the organization roots, by namespace: the All projects grant. */
  readonly rootAces = new Map<string, number>()
  /** A root namespace whose next entry delete answers 503, once. */
  failRootDeleteOnce: string | null = null
  /** The next read of the application's memberships answers 503. */
  failMembershipReadOnce = false
  /** Tokens whose list the connection may not read: they answer 403. */
  readonly aclForbidden = new Set<string>()
  readonly admin: FakeAdministration = {
    signInTenant: TENANT_ID,
    consentRequired: false,
    spInOrganization: true,
    spAccessLevel: 'express',
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
  /** The tenant an unauthenticated connectionData names in `x-vss-resourcetenant`; null sends no header. */
  resourceTenant: string | null = TENANT_ID
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

  userAuthz(
    service: Pick<AzureDevOpsConnectionService, 'withApi'>,
    linked: boolean | (() => boolean) = true
  ): AzureDevOpsUserAuthzService {
    return new AzureDevOpsUserAuthzService({
      api: this.api,
      service,
      microsoftIdentityFor: async () => ((typeof linked === 'function' ? linked() : linked) ? LINKED_MICROSOFT : null),
      microsoftTenantIdentityFor: async () => null
    })
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
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (url.startsWith(`${GRAPH_BASE}/${ORGANIZATION}/_apis/identities?`) && auth.startsWith('Bearer example-token-')) {
      if (new URL(url).searchParams.get('searchFilter') === 'MailAddress') {
        return this.json(200, {
          value: [
            {
              id: this.user.id,
              descriptor: this.user.descriptor,
              providerDisplayName: 'Alex Example',
              isActive: this.user.active,
              isContainer: false,
              properties: {
                SchemaClassName: { $value: 'User' },
                Domain: { $value: this.user.tenantId },
                Mail: { $value: this.user.email },
                'http://schemas.microsoft.com/identity/claims/objectidentifier': { $value: this.user.objectId }
              }
            }
          ]
        })
      }
      const id = new URL(url).searchParams.get('identityIds') ?? ''
      const identity = this.identities.get(id)
      // The live API answers an unknown id with a null entry.
      return this.json(200, { count: 1, value: [identity ? { id, ...identity } : null] })
    }
    if (
      url.startsWith(`${ENTITLEMENTS_BASE}/${ORGANIZATION}/_apis/userentitlements?`) &&
      auth.startsWith('Bearer example-token-')
    ) {
      return this.json(200, {
        items: [
          {
            id: this.user.id,
            user: {
              origin: 'aad',
              originId: this.user.objectId,
              domain: this.user.tenantId,
              subjectKind: 'user',
              metaType: this.user.metaType
            },
            accessLevel: this.user.accessLevel
          }
        ],
        continuationToken: null,
        totalCount: 1
      })
    }
    if (auth !== `Bearer ${ADMIN_TOKEN}`) {
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
    if (url.startsWith(ENTITLEMENTS_BASE) && path === `${org}/serviceprincipalentitlements/${IDENTITY_ID}`) {
      if (!admin.spInOrganization) return this.json(404, { message: 'not found' })
      if (method === 'GET')
        return this.json(200, { id: IDENTITY_ID, accessLevel: { accountLicenseType: admin.spAccessLevel } })
      if (method !== 'PATCH' || new Headers(init?.headers).get('content-type') !== 'application/json-patch+json') {
        return this.json(400, { message: 'bad request' })
      }
      if (admin.entitlement === 'refuse5032') {
        return this.json(200, {
          isSuccess: false,
          operationResults: [{ isSuccess: false, errors: [{ key: 5032, value: 'Add Users' }], result: null }]
        })
      }
      const [patch] = JSON.parse(String(init?.body)) as Array<{ path: string; value: { accountLicenseType: string } }>
      if (patch?.path === '/accessLevel') admin.spAccessLevel = patch.value.accountLicenseType
      return this.json(200, {
        isSuccess: true,
        operationResults: [
          { isSuccess: true, errors: [], result: { accessLevel: { accountLicenseType: admin.spAccessLevel } } }
        ]
      })
    }
    if (url.startsWith(ENTITLEMENTS_BASE)) {
      if (path !== `${org}/serviceprincipalentitlements` || method !== 'POST') return this.json(404, {})
      if (admin.entitlement === 'refuse5032') {
        return this.json(200, {
          isSuccess: false,
          operationResult: { isSuccess: false, errors: [{ key: 5032, value: 'Add Users' }], result: null }
        })
      }
      admin.spInOrganization = true
      admin.spAccessLevel = 'express'
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
    if (path.startsWith(`${org}/graph/memberships/`) && method === 'GET') {
      if (this.failMembershipReadOnce) {
        this.failMembershipReadOnce = false
        return this.json(503, { message: 'unavailable' })
      }
      const subject = path.slice(`${org}/graph/memberships/`.length)
      const value = [...admin.memberships]
        .filter((key) => key.startsWith(`${subject}|`))
        .map((key) => ({ memberDescriptor: subject, containerDescriptor: key.slice(subject.length + 1) }))
      return this.json(200, { count: value.length, value })
    }
    if (path.startsWith(`${org}/graph/groups/`) && method === 'GET') {
      const [, kind, projectId] = path.slice(`${org}/graph/groups/`.length).split('.')
      const project = admin.projects.find((p) => p.id === projectId)
      if (!project || (kind !== 'readers' && kind !== 'contributors')) return this.json(404, { message: 'not found' })
      return this.json(200, {
        principalName: `[${project.name}]\\${kind === 'readers' ? 'Readers' : 'Contributors'}`,
        domain: `vstfs:///Classification/TeamProject/${project.id}`
      })
    }
    if (path.startsWith(`${org}/graph/memberships/`) && method === 'DELETE') {
      if (!admin.membershipsAllowed) return this.json(403, { message: 'TF50309: insufficient permissions' })
      const [subject, group] = path.slice(`${org}/graph/memberships/`.length).split('/')
      admin.memberships.delete(`${subject}|${group}`)
      return new Response(null, { status: 200 })
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
      admin.spAccessLevel = 'stakeholder'
      for (const group of (u.searchParams.get('groupDescriptors') ?? '').split(',').filter(Boolean)) {
        admin.memberships.add(`${subject}|${group}`)
      }
      return this.json(201, { descriptor: subject, originId: SP_OBJECT_ID })
    }
    return this.json(404, { message: 'not found' })
  }

  /** dev.azure.com as the signed-in administrator. */
  private adminDevOps(url: string, method = 'GET', init?: RequestInit): Response {
    const path = new URL(url).pathname
    const query = new URL(url).searchParams
    const roots: Record<string, string> = {
      [PROJECT_NAMESPACE]: '$PROJECT',
      [GIT_NAMESPACE]: 'repoV2',
      [SERVICE_HOOKS_NAMESPACE]: 'PublisherSecurity'
    }
    const security = /\/_apis\/accesscontrol(lists|entries)\/([0-9a-f-]+)$/.exec(path)
    const root = security ? roots[security[2]!] : undefined
    if (security && root) {
      const namespace = security[2]!
      const body =
        method === 'POST'
          ? (JSON.parse(String(init?.body ?? '{}')) as {
              token: string
              merge: boolean
              accessControlEntries: Array<{ descriptor: string; allow: number }>
            })
          : undefined
      const token = body?.token ?? query.get('token')
      if (token === root && security[1] === 'lists' && method === 'GET' && query.get('recurse') !== 'true') {
        const descriptor = query.get('descriptors') ?? ''
        const allow = this.rootAces.get(namespace) ?? 0
        return this.json(200, {
          value: [{ token: root, acesDictionary: { [descriptor]: { descriptor, allow, deny: 0 } } }]
        })
      }
      if (token === root && security[1] === 'entries' && (method === 'POST' || method === 'DELETE')) {
        if (!this.aceWriteAllowed) return this.json(403, { message: 'TF400813: insufficient permissions' })
        if (method === 'DELETE') {
          if (this.failRootDeleteOnce === namespace) {
            this.failRootDeleteOnce = null
            return this.json(503, { message: 'unavailable' })
          }
          this.rootAces.delete(namespace)
          return this.json(200, true)
        }
        const allow = body!.accessControlEntries[0]!.allow
        this.rootAces.set(namespace, body!.merge ? (this.rootAces.get(namespace) ?? 0) | allow : allow)
        return this.json(200, { count: 1, value: body!.accessControlEntries })
      }
    }
    if (path === `/${ORGANIZATION}/_apis/accesscontrollists/${SERVICE_HOOKS_NAMESPACE}` && method === 'GET') {
      const descriptor = query.get('descriptors') ?? ''
      return this.json(200, {
        value: [...this.serviceHookGrants].map((projectId) => ({
          token: `PublisherSecurity/${projectId}`,
          acesDictionary: { [descriptor]: { descriptor, allow: 3, deny: 0 } }
        }))
      })
    }
    if (path === `/${ORGANIZATION}/_apis/accesscontrolentries/${SERVICE_HOOKS_NAMESPACE}` && method === 'DELETE') {
      if (!this.aceWriteAllowed) return this.json(403, { message: 'TF400813: insufficient permissions' })
      this.serviceHookGrants.delete((query.get('token') ?? '').replace(/^PublisherSecurity\//, ''))
      return this.json(200, true)
    }
    if (path === `/${ORGANIZATION}/_apis/accesscontrolentries/${SERVICE_HOOKS_NAMESPACE}` && method === 'POST') {
      if (!this.aceWriteAllowed) return this.json(403, { message: 'TF400813: insufficient permissions' })
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        token: string
        merge: boolean
        accessControlEntries: Array<{ descriptor: string; allow: number; deny: number }>
      }
      for (const ace of body.accessControlEntries) {
        this.aceWrites.push({ token: body.token, descriptor: ace.descriptor, allow: ace.allow })
        if (ace.descriptor.endsWith(`;${this.admin.signInTenant}\\${SP_OBJECT_ID}`) && (ace.allow & 3) === 3) {
          this.serviceHookGrants.add(body.token.replace(/^PublisherSecurity\//, ''))
        }
      }
      return this.json(200, { count: body.accessControlEntries.length, value: body.accessControlEntries })
    }
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
    if (auth === `Bearer ${ADMIN_TOKEN}`) return this.adminDevOps(url, method, init)
    // An unauthenticated read is sent to sign-in, naming the organization's Entra tenant in a header.
    if (!auth && new URL(url).pathname === `/${ORGANIZATION}/_apis/connectionData`) {
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://login.example.test/',
          ...(this.resourceTenant ? { 'x-vss-resourcetenant': this.resourceTenant } : {})
        }
      })
    }
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
      const visible = ['stakeholder', 'none'].includes(this.admin.spAccessLevel) ? [] : this.repositories
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
          if (evaluation.securityNamespaceId === SERVICE_HOOKS_NAMESPACE) {
            const projectId = evaluation.token.replace(/^PublisherSecurity\//, '')
            return { ...evaluation, value: this.serviceHookGrants.has(projectId) }
          }
          const repositoryId = evaluation.token.split('/')[2]
          const repo = this.repositories.find((r) => r.id === repositoryId)
          const value = repo ? (evaluation.permissions === 4 ? repo.contribute : true) : false
          return { ...evaluation, value }
        })
      })
    }
    const subscriptions = `/${ORGANIZATION}/_apis/hooks/subscriptions`
    if (path === subscriptions && method === 'POST')
      return this.createSubscription(JSON.parse(String(init?.body ?? '{}')))
    if (path.startsWith(`${subscriptions}/`)) {
      const id = path.slice(subscriptions.length + 1)
      const stored = this.subscriptions.get(id)
      if (!stored) return this.json(404, { message: `VS1050003: subscription ${id} not found` })
      if (!this.serviceHookGrants.has(stored.publisherInputs.projectId ?? '')) return this.accessCheck()
      if (method === 'GET') return this.json(200, this.masked(stored))
      if (method === 'DELETE') {
        this.subscriptions.delete(id)
        return new Response(null, { status: 204 })
      }
      if (method === 'PUT') {
        if (this.failPutOnce.delete(id)) return this.json(503, { message: 'unavailable' })
        const body = JSON.parse(String(init?.body ?? '{}')) as Partial<FakeSubscription>
        // A PUT replaces the subscription whole; a masked password would be stored as the mask.
        const replaced: FakeSubscription = { ...this.shape(body), id, status: body.status ?? stored.status }
        this.subscriptions.set(id, replaced)
        return this.json(200, this.masked(replaced))
      }
    }
    if (path.startsWith(`/${ORGANIZATION}/_apis/projects/`) && method === 'GET') {
      return this.json(200, { id: path.split('/').at(-1), visibility: this.projectVisibility })
    }
    if (
      path.startsWith(`/${ORGANIZATION}/_apis/accesscontrollists/`) &&
      new URL(url).searchParams.get('includeExtendedInfo') === 'true'
    ) {
      const query = new URL(url).searchParams
      const resource = query.get('token') ?? ''
      if (this.aclForbidden.has(resource)) return this.json(403, { message: 'Access denied' })
      const descriptor = query.get('descriptors') ?? ''
      const bits = this.effectivePermissions.get(resource) ?? { effectiveAllow: path.endsWith(GIT_NAMESPACE) ? 6 : 1 }
      return this.json(200, {
        value: [
          {
            token: resource,
            acesDictionary: {
              [descriptor]: { descriptor, allow: 0, deny: 0, extendedInfo: bits }
            }
          }
        ]
      })
    }
    if (path === `/${ORGANIZATION}/_apis/accesscontrollists/${GIT_NAMESPACE}` && method === 'GET') {
      const token = new URL(url).searchParams.get('token') ?? ''
      if (this.aclForbidden.has(token))
        return this.json(403, { message: `Access Denied: needs permission on ${token}` })
      const list = this.acls.get(token)
      if (!list) return this.json(200, { count: 0, value: [] })
      const acesDictionary = Object.fromEntries(
        Object.entries(list.aces).map(([descriptor, ace]) => [descriptor, { descriptor, ...ace }])
      )
      return this.json(200, {
        count: 1,
        value: [
          {
            token,
            ...(list.inheritPermissions !== undefined ? { inheritPermissions: list.inheritPermissions } : {}),
            acesDictionary
          }
        ]
      })
    }
    return this.json(404, { message: 'not found' })
  }

  private accessCheck(): Response {
    return this.json(403, {
      typeKey: 'AccessCheckException',
      message: 'Access denied: needs Edit Subscription permissions to perform the action.'
    })
  }

  private shape(body: Partial<FakeSubscription>): Omit<FakeSubscription, 'id' | 'status'> {
    return {
      eventType: body.eventType ?? '',
      publisherId: body.publisherId ?? '',
      consumerId: body.consumerId ?? '',
      consumerActionId: body.consumerActionId ?? '',
      resourceVersion: body.resourceVersion ?? '',
      publisherInputs: { ...(body.publisherInputs ?? {}) },
      consumerInputs: { ...(body.consumerInputs ?? {}) }
    }
  }

  private createSubscription(body: Partial<FakeSubscription>): Response {
    if (!this.serviceHookGrants.has(body.publisherInputs?.projectId ?? '')) return this.accessCheck()
    if (body.consumerInputs && Object.values(body.consumerInputs).some((value) => value === '')) {
      return this.json(400, { message: 'an input value may not be empty' })
    }
    const id = `00000000-0000-4000-8000-${(0xc00000000000 + this.nextSubscription++).toString(16)}`
    const stored: FakeSubscription = { ...this.shape(body), id, status: 'enabled' }
    this.subscriptions.set(id, stored)
    return this.json(200, this.masked(stored))
  }

  /** What a read answers: the password masked, an Azure DevOps input of its own added. */
  private masked(stored: FakeSubscription): unknown {
    return {
      ...stored,
      publisherInputs: { ...stored.publisherInputs, tfsSubscriptionId: stored.id },
      consumerInputs: {
        ...stored.consumerInputs,
        ...(stored.consumerInputs.basicAuthPassword !== undefined ? { basicAuthPassword: '********' } : {})
      }
    }
  }

  /** The subscriptions of one kind's event type and filter, with their real passwords. */
  subscriptionsOf(eventType: string, notificationType?: string): FakeSubscription[] {
    return [...this.subscriptions.values()].filter(
      (sub) => sub.eventType === eventType && sub.publisherInputs.notificationType === notificationType
    )
  }
}
