// The Azure DevOps calls Connect with Microsoft makes (azure-devops-integration.md §3.2 steps 3-4): the administrator's organizations and projects, the entitlement, and Graph memberships; never log a token or a body.
import { AzureDevOpsApiError, GIT_REPOSITORIES_NAMESPACE, isGuid, type AzureDevOpsApiClient } from './api.js'
import { EDIT_SUBSCRIPTIONS, SERVICE_HOOKS_NAMESPACE, VIEW_SUBSCRIPTIONS, serviceHooksToken } from './hooks-api.js'

/** The fixed hosts; the fake in tests answers for them in place of the network. */
export const PROFILE_BASE = 'https://app.vssps.visualstudio.com'
export const ENTITLEMENTS_BASE = 'https://vsaex.dev.azure.com'
export const GRAPH_BASE = 'https://vssps.dev.azure.com'

const API_VERSION = '7.1'
const PREVIEW_VERSION = '7.1-preview.1'
/** Pages followed for one list; an organization rarely has more than a few hundred projects. */
const MAX_PAGES = 20
/** An identity the organization has never seen, or one it removed; for a person, not a member. */
const NOT_MEMBER_RE = /\bTF40(?:1444|0813)\b/

interface AdminAnswer {
  status: number
  json: unknown
  continuationToken: string | null
}

/** One delegated or application call; a 203 is Azure DevOps' sign-in page, which means the token was not accepted. */
async function adminRequest(
  api: AzureDevOpsApiClient,
  token: string,
  url: string,
  init: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    body?: unknown
    contentType?: string
    okStatuses?: readonly number[]
  } = {}
): Promise<AdminAnswer> {
  let res: Response
  try {
    res = await api.fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': init.contentType ?? 'application/json' } : {})
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
    })
  } catch {
    throw new AzureDevOpsApiError('Azure DevOps is unreachable', 0, 'UNAVAILABLE', true)
  }
  const continuationToken = res.headers.get('x-ms-continuationtoken')
  if ((res.ok && res.status !== 203) || init.okStatuses?.includes(res.status)) {
    const json: unknown = await res.json().catch(() => null)
    if (res.ok && json === null && res.status !== 204 && init.method !== 'DELETE') {
      throw new AzureDevOpsApiError('Azure DevOps answered without a body', res.status, 'UNAUTHORIZED', true)
    }
    return { status: res.status, json, continuationToken }
  }
  const text = await res.text().catch(() => '')
  if (res.status === 203 || res.status === 401) {
    if (NOT_MEMBER_RE.test(text)) {
      throw new AzureDevOpsApiError('the account is not a member of that organization', 401, 'ACCESS_REVOKED', false)
    }
    throw new AzureDevOpsApiError('Azure DevOps did not accept the sign-in', 401, 'UNAUTHORIZED', false)
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after'))
    throw new AzureDevOpsApiError(
      'Azure DevOps asked to slow down — retry later',
      429,
      'RATE_LIMITED',
      true,
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
    )
  }
  if (res.status === 403) throw new AzureDevOpsApiError('Azure DevOps refused the request', 403, 'FORBIDDEN', false)
  if (res.status === 404) throw new AzureDevOpsApiError('not found in Azure DevOps', 404, 'NOT_FOUND', false)
  if (res.status >= 500)
    throw new AzureDevOpsApiError(`Azure DevOps answered ${res.status}`, res.status, 'UNAVAILABLE', true)
  throw new AzureDevOpsApiError(`Azure DevOps answered ${res.status}`, res.status, 'INVALID_REQUEST', false)
}

function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url)
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value)
  return u.toString()
}

/** Every page of a `value` list, following `x-ms-continuationtoken`. */
async function listAll(api: AzureDevOpsApiClient, token: string, url: string): Promise<unknown[]> {
  const items: unknown[] = []
  let continuation: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await adminRequest(
      api,
      token,
      continuation ? withQuery(url, { continuationToken: continuation }) : url
    )
    const value = (answer.json as { value?: unknown } | null)?.value
    if (Array.isArray(value)) items.push(...value)
    continuation = answer.continuationToken
    if (!continuation) break
  }
  return items
}

const org = (organization: string) => encodeURIComponent(organization)

const ZERO_GUID = '00000000-0000-0000-0000-000000000000'

/** The Entra tenant backing an organization, from the header Azure DevOps sends on an unauthenticated read; null when it names none. */
export async function readResourceTenant(api: AzureDevOpsApiClient, organization: string): Promise<string | null> {
  try {
    const res = await api.fetch(`${api.devOpsBaseUrl}/${org(organization)}/_apis/connectionData`, {
      method: 'GET',
      redirect: 'manual'
    })
    const tenant = res.headers.get('x-vss-resourcetenant')?.trim().toLowerCase()
    await res.body?.cancel().catch(() => {})
    return isGuid(tenant) && tenant !== ZERO_GUID ? tenant : null
  } catch {
    return null
  }
}

/** §3.2 step 3: the organizations the signed-in administrator belongs to, through the profile and accounts APIs. */
export async function listMemberOrganizations(
  api: AzureDevOpsApiClient,
  token: string
): Promise<Array<{ id: string; name: string }>> {
  const profile = await adminRequest(api, token, `${PROFILE_BASE}/_apis/profile/profiles/me?api-version=${API_VERSION}`)
  const memberId = (profile.json as { id?: unknown } | null)?.id
  if (!isGuid(memberId)) {
    throw new AzureDevOpsApiError('Azure DevOps answered a profile without an id', 200, 'UNAVAILABLE', true)
  }
  const accounts = await adminRequest(
    api,
    token,
    `${PROFILE_BASE}/_apis/accounts?memberId=${encodeURIComponent(memberId)}&api-version=${API_VERSION}`
  )
  const value = (accounts.json as { value?: unknown } | null)?.value
  const organizations: Array<{ id: string; name: string }> = []
  for (const raw of Array.isArray(value) ? (value as Array<{ accountId?: unknown; accountName?: unknown }>) : []) {
    if (typeof raw.accountName !== 'string' || !raw.accountName) continue
    organizations.push({
      id: typeof raw.accountId === 'string' ? raw.accountId.toLowerCase() : '',
      name: raw.accountName
    })
  }
  return organizations.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

/** §3.2 step 4: the organization's projects as the administrator sees them. */
export async function listProjects(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string
): Promise<Array<{ id: string; name: string }>> {
  const raw = await listAll(
    api,
    token,
    `${api.devOpsBaseUrl}/${org(organization)}/_apis/projects?$top=500&api-version=${API_VERSION}`
  )
  const projects: Array<{ id: string; name: string }> = []
  for (const item of raw as Array<{ id?: unknown; name?: unknown; state?: unknown }>) {
    if (!isGuid(item.id) || typeof item.name !== 'string') continue
    if (item.state !== undefined && item.state !== 'wellFormed') continue
    projects.push({ id: item.id.toLowerCase(), name: item.name })
  }
  return projects.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

/** The access level Basic, which the Control Plane always asks for: an omitted level is Stakeholder, which reaches no repository. */
export const BASIC_ACCESS_LEVEL = 'express'
/** The entitlement error a caller below Project Collection Administrator gets ("Add Users"). */
export const ADD_USERS_REFUSED = 5032
/** The levels that reach no repository; Basic and everything above it (Basic + Test Plans, Visual Studio subscriber) do. */
const BELOW_BASIC = new Set(['stakeholder', 'none'])

/** Whether an access level reaches Azure Repos; an absent level is not known to. */
export function reachesRepositories(level: unknown): boolean {
  return typeof level === 'string' && !!level && !BELOW_BASIC.has(level.toLowerCase())
}

export type AzureDevOpsEntitlementResult =
  | { outcome: 'added'; subjectDescriptor: string | null }
  | { outcome: 'refused'; errorCodes: number[]; subjectDescriptor: string | null }

interface RawOperationResult {
  isSuccess?: unknown
  errors?: Array<{ key?: unknown; value?: unknown }>
  result?: RawEntitlement
}
interface RawEntitlementAnswer {
  isSuccess?: unknown
  operationResult?: RawOperationResult
  /** The PATCH answers a list. */
  operationResults?: RawOperationResult[]
  servicePrincipalEntitlement?: RawEntitlement
}

function errorCodesOf(operations: readonly RawOperationResult[]): number[] {
  return operations
    .flatMap((operation) => operation.errors ?? [])
    .map((error) => Number(error.key ?? /\b(\d{4,})\b/.exec(String(error.value ?? ''))?.[1]))
    .filter((code) => Number.isFinite(code))
}
interface RawEntitlement {
  accessLevel?: { accountLicenseType?: unknown }
  servicePrincipal?: { descriptor?: unknown }
}

/** §3.2 step 4: add the service principal with Basic; the call answers 200 even when it refuses, so `isSuccess` decides. */
export async function addServicePrincipalEntitlement(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  servicePrincipalObjectId: string
): Promise<AzureDevOpsEntitlementResult> {
  const answer = await adminRequest(
    api,
    token,
    `${ENTITLEMENTS_BASE}/${org(organization)}/_apis/serviceprincipalentitlements?api-version=${PREVIEW_VERSION}`,
    {
      method: 'POST',
      body: {
        accessLevel: { accountLicenseType: BASIC_ACCESS_LEVEL },
        servicePrincipal: { origin: 'aad', originId: servicePrincipalObjectId, subjectKind: 'servicePrincipal' }
      }
    }
  )
  const json = (answer.json ?? {}) as RawEntitlementAnswer
  const operation = json.operationResult
  const entitlement = operation?.result ?? json.servicePrincipalEntitlement
  const descriptor = entitlement?.servicePrincipal?.descriptor
  const subjectDescriptor = typeof descriptor === 'string' && descriptor ? descriptor : null
  const success = (operation?.isSuccess ?? json.isSuccess) === true
  const errorCodes = errorCodesOf(operation ? [operation] : [])
  const level = entitlement?.accessLevel?.accountLicenseType
  if (!success) return { outcome: 'refused', errorCodes, subjectDescriptor }
  // A success below Basic reaches no repository, so it is reported as refused (§3.2 step 4).
  if (level !== undefined && !reachesRepositories(level)) return { outcome: 'refused', errorCodes, subjectDescriptor }
  return { outcome: 'added', subjectDescriptor }
}

const entitlementUrl = (organization: string, servicePrincipalId: string) =>
  `${ENTITLEMENTS_BASE}/${org(organization)}/_apis/serviceprincipalentitlements/${encodeURIComponent(servicePrincipalId)}?api-version=${PREVIEW_VERSION}`

/** A member's current access level by its Azure DevOps id; null when it holds no entitlement. */
export async function readServicePrincipalAccessLevel(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  servicePrincipalId: string
): Promise<string | null> {
  try {
    const answer = await adminRequest(api, token, entitlementUrl(organization, servicePrincipalId))
    const level = (answer.json as RawEntitlement | null)?.accessLevel?.accountLicenseType
    return typeof level === 'string' && level ? level : null
  } catch (e) {
    if (e instanceof AzureDevOpsApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}

/** Raise a member below Basic with the entitlement JSON patch; like the add, `isSuccess` decides, not the status code. */
export async function raiseServicePrincipalToBasic(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  servicePrincipalId: string
): Promise<{ outcome: 'raised' } | { outcome: 'refused'; errorCodes: number[] }> {
  const answer = await adminRequest(api, token, entitlementUrl(organization, servicePrincipalId), {
    method: 'PATCH',
    contentType: 'application/json-patch+json',
    body: [
      {
        from: '',
        op: 'replace',
        path: '/accessLevel',
        value: { accountLicenseType: BASIC_ACCESS_LEVEL, licensingSource: 'account' }
      }
    ]
  })
  const json = (answer.json ?? {}) as RawEntitlementAnswer
  const operations = json.operationResults ?? (json.operationResult ? [json.operationResult] : [])
  const success = operations.length > 0 ? operations.every((o) => o.isSuccess === true) : json.isSuccess === true
  if (!success) return { outcome: 'refused', errorCodes: errorCodesOf(operations) }
  const level =
    operations[0]?.result?.accessLevel?.accountLicenseType ??
    json.servicePrincipalEntitlement?.accessLevel?.accountLicenseType
  if (level !== undefined && !reachesRepositories(level)) {
    return { outcome: 'refused', errorCodes: errorCodesOf(operations) }
  }
  return { outcome: 'raised' }
}

/** A Graph descriptor for a storage key: a project id gives the project's scope, an identity id its subject. */
export async function readGraphDescriptor(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  storageKey: string
): Promise<string> {
  const answer = await adminRequest(
    api,
    token,
    `${GRAPH_BASE}/${org(organization)}/_apis/graph/descriptors/${encodeURIComponent(storageKey)}?api-version=${PREVIEW_VERSION}`
  )
  const value = (answer.json as { value?: unknown } | null)?.value
  if (typeof value !== 'string' || !value) {
    throw new AzureDevOpsApiError('Azure DevOps answered a descriptor without a value', 200, 'UNAVAILABLE', true)
  }
  return value
}

/** The project's Readers or Contributors group, matched on the principal name within that project, not on display text. */
export async function findProjectGroup(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  projectId: string,
  group: 'readers' | 'contributors'
): Promise<string | null> {
  const scope = await readGraphDescriptor(api, token, organization, projectId)
  const groups = await listAll(
    api,
    token,
    `${GRAPH_BASE}/${org(organization)}/_apis/graph/groups?scopeDescriptor=${encodeURIComponent(scope)}&api-version=${PREVIEW_VERSION}`
  )
  const suffix = group === 'readers' ? '\\readers' : '\\contributors'
  for (const raw of groups as Array<{ descriptor?: unknown; principalName?: unknown; domain?: unknown }>) {
    if (typeof raw.descriptor !== 'string' || typeof raw.principalName !== 'string') continue
    if (!raw.principalName.toLowerCase().endsWith(suffix)) continue
    if (typeof raw.domain === 'string' && !raw.domain.toLowerCase().endsWith(projectId.toLowerCase())) continue
    return raw.descriptor
  }
  return null
}

export type AzureDevOpsMembershipOutcome = 'added' | 'already_member' | 'refused' | 'failed'

/** One Graph membership; 201 is added, and an answer that the subject already belongs is a success too. */
export async function addGroupMembership(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  subjectDescriptor: string,
  groupDescriptor: string
): Promise<AzureDevOpsMembershipOutcome> {
  try {
    const answer = await adminRequest(
      api,
      token,
      `${GRAPH_BASE}/${org(organization)}/_apis/graph/memberships/${encodeURIComponent(subjectDescriptor)}/${encodeURIComponent(groupDescriptor)}?api-version=${PREVIEW_VERSION}`,
      { method: 'PUT', okStatuses: [409] }
    )
    return answer.status === 201 ? 'added' : 'already_member'
  } catch (e) {
    if (!(e instanceof AzureDevOpsApiError)) throw e
    if (e.code === 'FORBIDDEN' || e.code === 'UNAUTHORIZED' || e.code === 'ACCESS_REVOKED') return 'refused'
    if (e.code === 'RATE_LIMITED') throw e
    return 'failed'
  }
}

/** How allowing triggers on one project went (§11.1). */
export type AzureDevOpsTriggerGrantOutcome = 'granted' | 'refused' | 'failed'

/** §11.1: allow the service principal View and Edit subscriptions on a project, with the administrator's delegated token. */
export async function allowServiceHookSubscriptions(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  input: { projectId: string; tenantId: string; servicePrincipalObjectId: string }
): Promise<AzureDevOpsTriggerGrantOutcome> {
  const descriptor = servicePrincipalClaim(input.tenantId, input.servicePrincipalObjectId)
  try {
    await adminRequest(
      api,
      token,
      `${api.devOpsBaseUrl}/${org(organization)}/_apis/accesscontrolentries/${SERVICE_HOOKS_NAMESPACE}?api-version=${API_VERSION}`,
      {
        method: 'POST',
        body: {
          token: serviceHooksToken(input.projectId),
          merge: true,
          accessControlEntries: [{ descriptor, allow: VIEW_SUBSCRIPTIONS | EDIT_SUBSCRIPTIONS, deny: 0 }]
        }
      }
    )
    return 'granted'
  } catch (e) {
    if (!(e instanceof AzureDevOpsApiError)) throw e
    if (e.code === 'RATE_LIMITED') throw e
    return e.code === 'FORBIDDEN' || e.code === 'UNAUTHORIZED' || e.code === 'ACCESS_REVOKED' ? 'refused' : 'failed'
  }
}

/** Adds the service principal to the organization through a group, at the organization's default access level; for a caller who may not grant Basic. */
export async function addServicePrincipalThroughGroup(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  servicePrincipalObjectId: string,
  groupDescriptor: string
): Promise<string | null> {
  try {
    const answer = await adminRequest(
      api,
      token,
      `${GRAPH_BASE}/${org(organization)}/_apis/graph/serviceprincipals?groupDescriptors=${encodeURIComponent(groupDescriptor)}&api-version=${PREVIEW_VERSION}`,
      { method: 'POST', body: { originId: servicePrincipalObjectId } }
    )
    const descriptor = (answer.json as { descriptor?: unknown } | null)?.descriptor
    return typeof descriptor === 'string' && descriptor ? descriptor : null
  } catch (e) {
    if (e instanceof AzureDevOpsApiError && e.code === 'RATE_LIMITED') throw e
    if (e instanceof AzureDevOpsApiError) return null
    throw e
  }
}

export type AzureDevOpsProjectGroup = 'readers' | 'contributors'

/** The Readers and Contributors groups that directly hold the subject, by project id. */
export async function readProjectGroups(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  subjectDescriptor: string
): Promise<Map<string, Map<AzureDevOpsProjectGroup, string>>> {
  const answer = await adminRequest(
    api,
    token,
    `${GRAPH_BASE}/${org(organization)}/_apis/graph/memberships/${encodeURIComponent(subjectDescriptor)}?direction=up&api-version=${PREVIEW_VERSION}`
  )
  const containers = ((answer.json as { value?: unknown } | null)?.value ?? []) as Array<{
    containerDescriptor?: unknown
  }>
  const byProject = new Map<string, Map<AzureDevOpsProjectGroup, string>>()
  for (const { containerDescriptor } of containers) {
    if (typeof containerDescriptor !== 'string' || !containerDescriptor.startsWith('vssgp.')) continue
    const group = (
      await adminRequest(
        api,
        token,
        `${GRAPH_BASE}/${org(organization)}/_apis/graph/groups/${encodeURIComponent(containerDescriptor)}?api-version=${PREVIEW_VERSION}`
      )
    ).json as { principalName?: unknown; domain?: unknown } | null
    const name = typeof group?.principalName === 'string' ? group.principalName.toLowerCase() : ''
    const kind = name.endsWith('\\contributors') ? 'contributors' : name.endsWith('\\readers') ? 'readers' : null
    const projectId =
      typeof group?.domain === 'string' ? /TeamProject\/([0-9a-f-]{36})$/i.exec(group.domain)?.[1] : undefined
    if (!kind || !projectId) continue
    const groups = byProject.get(projectId.toLowerCase()) ?? new Map<AzureDevOpsProjectGroup, string>()
    groups.set(kind, containerDescriptor)
    byProject.set(projectId.toLowerCase(), groups)
  }
  return byProject
}

const servicePrincipalClaim = (tenantId: string, objectId: string) =>
  `Microsoft.VisualStudio.Services.Claims.AadServicePrincipal;${tenantId}\\${objectId}`

/** The project ids where the service principal holds View and Edit subscriptions (§11.1), in one recursive read. */
export async function readServiceHookGrants(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  input: { tenantId: string; servicePrincipalObjectId: string }
): Promise<Set<string>> {
  const descriptor = servicePrincipalClaim(input.tenantId, input.servicePrincipalObjectId)
  const answer = await adminRequest(
    api,
    token,
    `${api.devOpsBaseUrl}/${org(organization)}/_apis/accesscontrollists/${SERVICE_HOOKS_NAMESPACE}?token=PublisherSecurity&recurse=true&descriptors=${encodeURIComponent(descriptor)}&includeExtendedInfo=false&api-version=${API_VERSION}`
  )
  const lists = ((answer.json as { value?: unknown } | null)?.value ?? []) as Array<{
    token?: unknown
    acesDictionary?: Record<string, { allow?: unknown; deny?: unknown }>
  }>
  const granted = new Set<string>()
  const both = VIEW_SUBSCRIPTIONS | EDIT_SUBSCRIPTIONS
  for (const list of lists) {
    const projectId =
      typeof list.token === 'string' ? /^PublisherSecurity\/([0-9a-f-]{36})$/i.exec(list.token)?.[1] : undefined
    if (!projectId) continue
    const allowed = Object.values(list.acesDictionary ?? {}).some(
      (ace) => (Number(ace.allow) & both) === both && (Number(ace.deny) & both) === 0
    )
    if (allowed) granted.add(projectId.toLowerCase())
  }
  return granted
}

export type AzureDevOpsRemovalOutcome = 'removed' | 'refused' | 'failed'

/** Take the subject out of one group; one that is no longer a member counts as removed. */
export async function removeGroupMembership(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  subjectDescriptor: string,
  groupDescriptor: string
): Promise<AzureDevOpsRemovalOutcome> {
  try {
    await adminRequest(
      api,
      token,
      `${GRAPH_BASE}/${org(organization)}/_apis/graph/memberships/${encodeURIComponent(subjectDescriptor)}/${encodeURIComponent(groupDescriptor)}?api-version=${PREVIEW_VERSION}`,
      { method: 'DELETE', okStatuses: [404] }
    )
    return 'removed'
  } catch (e) {
    return removalOutcome(e)
  }
}

/** Withdraw the service principal's View and Edit subscriptions on a project (§11.1). */
export async function revokeServiceHookSubscriptions(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  input: { projectId: string; tenantId: string; servicePrincipalObjectId: string }
): Promise<AzureDevOpsRemovalOutcome> {
  const descriptor = servicePrincipalClaim(input.tenantId, input.servicePrincipalObjectId)
  try {
    await adminRequest(
      api,
      token,
      `${api.devOpsBaseUrl}/${org(organization)}/_apis/accesscontrolentries/${SERVICE_HOOKS_NAMESPACE}?token=${encodeURIComponent(serviceHooksToken(input.projectId))}&descriptors=${encodeURIComponent(descriptor)}&api-version=${API_VERSION}`,
      { method: 'DELETE' }
    )
    return 'removed'
  } catch (e) {
    return removalOutcome(e)
  }
}

function removalOutcome(e: unknown): AzureDevOpsRemovalOutcome {
  if (!(e instanceof AzureDevOpsApiError)) throw e
  if (e.code === 'RATE_LIMITED') throw e
  return e.code === 'FORBIDDEN' || e.code === 'UNAUTHORIZED' || e.code === 'ACCESS_REVOKED' ? 'refused' : 'failed'
}

const PROJECT_NAMESPACE = '52d39943-cb85-4d7f-8fa8-c6baac873819'
const PROJECT_READ = 1
const GIT_READ = 2
/** What a project's Contributors group holds: read, contribute, branches, tags, notes, pull requests. */
const GIT_WRITE = 2 | 4 | 16 | 32 | 64 | 16384
/** The root tokens every project inherits from: the project itself, its repositories, its service hooks. */
const ORG_ROOTS = {
  project: { namespace: PROJECT_NAMESPACE, token: '$PROJECT' },
  git: { namespace: GIT_REPOSITORIES_NAMESPACE, token: 'repoV2' },
  hooks: { namespace: SERVICE_HOOKS_NAMESPACE, token: 'PublisherSecurity' }
} as const

/** The service principal's access to every project, present and future, granted at the namespace roots. */
export interface AzureDevOpsOrgWideAccess {
  group: AzureDevOpsProjectGroup
  allowTriggers: boolean
}

type ServicePrincipalRef = { tenantId: string; servicePrincipalObjectId: string }

async function rootAllow(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  root: { namespace: string; token: string },
  descriptor: string
): Promise<number> {
  const answer = await adminRequest(
    api,
    token,
    `${api.devOpsBaseUrl}/${org(organization)}/_apis/accesscontrollists/${root.namespace}?token=${encodeURIComponent(root.token)}&descriptors=${encodeURIComponent(descriptor)}&recurse=false&includeExtendedInfo=false&api-version=${API_VERSION}`
  )
  const lists = ((answer.json as { value?: unknown } | null)?.value ?? []) as Array<{
    token?: unknown
    acesDictionary?: Record<string, { allow?: unknown }>
  }>
  const list = lists.find((entry) => entry.token === root.token)
  return Object.values(list?.acesDictionary ?? {}).reduce((bits, ace) => bits | (Number(ace.allow) || 0), 0)
}

/** Organization-wide access as granted at the roots; null when the projects themselves are not readable from there. */
export async function readOrgWideAccess(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  input: ServicePrincipalRef
): Promise<AzureDevOpsOrgWideAccess | null> {
  const descriptor = servicePrincipalClaim(input.tenantId, input.servicePrincipalObjectId)
  if ((await rootAllow(api, token, organization, ORG_ROOTS.project, descriptor)) & PROJECT_READ) {
    const git = await rootAllow(api, token, organization, ORG_ROOTS.git, descriptor)
    const group = (git & GIT_WRITE) === GIT_WRITE ? 'contributors' : git & GIT_READ ? 'readers' : null
    if (!group) return null
    const hooks = await rootAllow(api, token, organization, ORG_ROOTS.hooks, descriptor)
    const both = VIEW_SUBSCRIPTIONS | EDIT_SUBSCRIPTIONS
    return { group, allowTriggers: (hooks & both) === both }
  }
  return null
}

/** Grant every project at the roots; the Git entry is replaced, so Write lowered to Read drops the write bits. */
export async function grantOrgWideAccess(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  input: ServicePrincipalRef & AzureDevOpsOrgWideAccess
): Promise<AzureDevOpsTriggerGrantOutcome> {
  const descriptor = servicePrincipalClaim(input.tenantId, input.servicePrincipalObjectId)
  const write = (root: { namespace: string; token: string }, allow: number, merge: boolean) =>
    adminRequest(
      api,
      token,
      `${api.devOpsBaseUrl}/${org(organization)}/_apis/accesscontrolentries/${root.namespace}?api-version=${API_VERSION}`,
      { method: 'POST', body: { token: root.token, merge, accessControlEntries: [{ descriptor, allow, deny: 0 }] } }
    )
  try {
    await write(ORG_ROOTS.project, PROJECT_READ, true)
    await write(ORG_ROOTS.git, input.group === 'contributors' ? GIT_WRITE : GIT_READ, false)
    if (input.allowTriggers) await write(ORG_ROOTS.hooks, VIEW_SUBSCRIPTIONS | EDIT_SUBSCRIPTIONS, true)
    return 'granted'
  } catch (e) {
    if (!(e instanceof AzureDevOpsApiError)) throw e
    if (e.code === 'RATE_LIMITED') throw e
    return e.code === 'FORBIDDEN' || e.code === 'UNAUTHORIZED' || e.code === 'ACCESS_REVOKED' ? 'refused' : 'failed'
  }
}

/** Take back organization-wide access, Allow triggers, or both. */
export async function removeOrgWideAccess(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  input: ServicePrincipalRef & { access: boolean; triggers: boolean }
): Promise<AzureDevOpsRemovalOutcome> {
  const descriptor = servicePrincipalClaim(input.tenantId, input.servicePrincipalObjectId)
  // Project read goes last: it is what makes the others readable, so a removal cut short stays visible.
  const roots = [
    ...(input.triggers ? [ORG_ROOTS.hooks] : []),
    ...(input.access ? [ORG_ROOTS.git, ORG_ROOTS.project] : [])
  ]
  try {
    for (const root of roots) {
      await adminRequest(
        api,
        token,
        `${api.devOpsBaseUrl}/${org(organization)}/_apis/accesscontrolentries/${root.namespace}?token=${encodeURIComponent(root.token)}&descriptors=${encodeURIComponent(descriptor)}&api-version=${API_VERSION}`,
        { method: 'DELETE' }
      )
    }
    return 'removed'
  } catch (e) {
    return removalOutcome(e)
  }
}
