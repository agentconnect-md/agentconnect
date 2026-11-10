// The only place the Control Plane talks to Entra and Azure DevOps (azure-devops-integration.md §3.4, §5, §6.5); never log a token, a secret or a token-bearing body.
import { normalizeGitCloneUrl } from '@agentconnect.md/protocol'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** The Azure DevOps resource; `.default` asks for what the service principal holds there (§3.1). */
export const AZURE_DEVOPS_RESOURCE_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default'
/** The Git Repositories security namespace and the two bits derivation reads (§12 item 7). */
export const GIT_REPOSITORIES_NAMESPACE = '2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87'
export const GENERIC_READ = 2
export const GENERIC_CONTRIBUTE = 4

const API_VERSION = '7.1'
const TIMEOUT_MS = 10_000
/** A throttle signal without a usable Retry-After still holds calls back this long, so nothing hot-loops. */
const DEFAULT_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 10 * 60_000

/** `SECRET_REJECTED` and `ACCESS_REVOKED` are the connection-level verdicts of §3.5; `UNAUTHORIZED` is a token worth one retry. */
export type AzureDevOpsErrorCode =
  | 'SECRET_REJECTED'
  | 'ACCESS_REVOKED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'UNAVAILABLE'

export class AzureDevOpsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: AzureDevOpsErrorCode,
    readonly retryable: boolean,
    /** When the caller may try again, for a throttled answer. */
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'AzureDevOpsApiError'
  }
}

export interface AzureDevOpsApiOptions {
  fetch?: FetchLike
  /** Overridable for tests only; production always talks to the fixed hosts. */
  loginBaseUrl?: string
  devOpsBaseUrl?: string
  now?: () => number
}

/** The fixed Entra and Azure DevOps hosts behind one `fetch`, with a per-organization throttle gate (§6.5). */
export class AzureDevOpsApiClient {
  readonly loginBaseUrl: string
  readonly devOpsBaseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  /** Organization (lowercase) → the earliest time another request may go out. */
  private readonly notBefore = new Map<string, number>()

  constructor(opts: AzureDevOpsApiOptions = {}) {
    this.fetchImpl = opts.fetch ?? (fetch as FetchLike)
    this.loginBaseUrl = (opts.loginBaseUrl ?? 'https://login.microsoftonline.com').replace(/\/+$/, '')
    this.devOpsBaseUrl = (opts.devOpsBaseUrl ?? 'https://dev.azure.com').replace(/\/+$/, '')
    this.now = opts.now ?? Date.now
  }

  fetch(url: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  }

  /** Refuse locally while an earlier answer asked the organization's identity to back off. */
  checkThrottle(organization: string): void {
    const until = this.notBefore.get(organization.toLowerCase())
    if (until === undefined) return
    const waitMs = until - this.now()
    if (waitMs <= 0) {
      this.notBefore.delete(organization.toLowerCase())
      return
    }
    throw new AzureDevOpsApiError('Azure DevOps asked to slow down — retry later', 429, 'RATE_LIMITED', true, waitMs)
  }

  /** Read Retry-After and X-RateLimit-Remaining/Reset off any answer, success included (§6.5). */
  observeThrottle(organization: string, res: Response): number | undefined {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'), this.now())
    let waitMs = retryAfter
    if (waitMs === undefined && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      waitMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 - this.now() : DEFAULT_BACKOFF_MS
    }
    if (waitMs === undefined && res.status === 429) waitMs = DEFAULT_BACKOFF_MS
    if (waitMs === undefined || waitMs <= 0) return undefined
    const bounded = Math.min(waitMs, MAX_BACKOFF_MS)
    this.notBefore.set(organization.toLowerCase(), this.now() + bounded)
    return bounded
  }
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs)
}

// ── Entra client credentials (§3.1, §3.4) ────────────────────────────────────

export interface AzureDevOpsAccessToken {
  accessToken: string
  /** The lifetime Entra issued it with; never assumed (§3.4). */
  expiresInSec: number
}

/** Entra error codes that mean the client secret itself is wrong or expired. */
const SECRET_ERROR_CODES = new Set([7000215, 7000222])
/** The application has no service principal in that tenant: consent was never given or was withdrawn. */
const APPLICATION_ABSENT_CODES = new Set([700016, 7000229])

export async function requestAccessToken(
  client: AzureDevOpsApiClient,
  input: { tenantId: string; clientId: string; clientSecret: string }
): Promise<AzureDevOpsAccessToken> {
  const url = `${client.loginBaseUrl}/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: input.clientId,
    client_secret: input.clientSecret,
    scope: AZURE_DEVOPS_RESOURCE_SCOPE
  })
  let res: Response
  try {
    res = await client.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString()
    })
  } catch {
    throw new AzureDevOpsApiError('Microsoft sign-in is unreachable', 0, 'UNAVAILABLE', true)
  }
  const json = (await res.json().catch(() => null)) as {
    access_token?: unknown
    expires_in?: unknown
    error?: unknown
    error_codes?: unknown
  } | null
  if (res.ok && typeof json?.access_token === 'string') {
    const expiresIn = Number(json.expires_in)
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new AzureDevOpsApiError(
        'Microsoft sign-in issued a token without a lifetime',
        res.status,
        'UNAVAILABLE',
        true
      )
    }
    return { accessToken: json.access_token, expiresInSec: expiresIn }
  }
  const error = typeof json?.error === 'string' ? json.error : ''
  const codes = Array.isArray(json?.error_codes) ? json.error_codes.map(Number) : []
  if (error === 'invalid_client' || codes.some((code) => SECRET_ERROR_CODES.has(code))) {
    throw new AzureDevOpsApiError('Microsoft rejected the client secret', res.status, 'SECRET_REJECTED', false)
  }
  if (error === 'unauthorized_client' || codes.some((code) => APPLICATION_ABSENT_CODES.has(code))) {
    throw new AzureDevOpsApiError(
      'the application is not present in that tenant — an administrator must consent to it there',
      res.status,
      'ACCESS_REVOKED',
      false
    )
  }
  if (res.status === 429) {
    throw new AzureDevOpsApiError('Microsoft sign-in asked to slow down', 429, 'RATE_LIMITED', true)
  }
  if (res.status >= 500 || res.status === 0) {
    throw new AzureDevOpsApiError(`Microsoft sign-in answered ${res.status}`, res.status, 'UNAVAILABLE', true)
  }
  throw new AzureDevOpsApiError(
    error ? `Microsoft sign-in refused the request (${error})` : `Microsoft sign-in answered ${res.status}`,
    res.status,
    'INVALID_REQUEST',
    false
  )
}

// ── dev.azure.com ────────────────────────────────────────────────────────────

/** `TF401444`: an identity the organization has never seen; `TF400813`: one it no longer admits (§3.5). */
const ACCESS_REVOKED_RE = /\bTF40(?:1444|0813)\b/

async function devOpsRequest<T>(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {}
): Promise<T> {
  const url = `${client.devOpsBaseUrl}/${encodeURIComponent(organization)}/${path}`
  const json = await azureDevOpsCall<T>(client, token, organization, url, init)
  if (json === undefined)
    throw new AzureDevOpsApiError('Azure DevOps answered without a body', 200, 'UNAVAILABLE', true)
  return json
}

/** One call to an absolute Azure DevOps URL under the organization's throttle gate; a 204 or an empty answer is undefined. */
export async function azureDevOpsCall<T>(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  url: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}
): Promise<T | undefined> {
  client.checkThrottle(organization)
  let res: Response
  try {
    res = await client.fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
    })
  } catch {
    throw new AzureDevOpsApiError('Azure DevOps is unreachable', 0, 'UNAVAILABLE', true)
  }
  const retryAfterMs = client.observeThrottle(organization, res)
  if (res.ok) {
    if (res.status === 204) return undefined
    return (await res.json().catch(() => undefined)) as T | undefined
  }
  const text = await res.text().catch(() => '')
  const serviceError = res.headers.get('x-tfs-serviceerror') ?? ''
  if (res.status === 401) {
    if (ACCESS_REVOKED_RE.test(text) || ACCESS_REVOKED_RE.test(decodeHeader(serviceError))) {
      throw new AzureDevOpsApiError(
        `the application's service principal is not a member of ${organization}`,
        401,
        'ACCESS_REVOKED',
        false
      )
    }
    throw new AzureDevOpsApiError('Azure DevOps rejected the token', 401, 'UNAUTHORIZED', true)
  }
  if (res.status === 429) {
    throw new AzureDevOpsApiError(
      'Azure DevOps asked to slow down — retry later',
      429,
      'RATE_LIMITED',
      true,
      retryAfterMs
    )
  }
  if (res.status === 403) throw new AzureDevOpsApiError('Azure DevOps refused the request', 403, 'FORBIDDEN', false)
  if (res.status === 404) throw new AzureDevOpsApiError('not found in Azure DevOps', 404, 'NOT_FOUND', false)
  if (res.status >= 500) {
    throw new AzureDevOpsApiError(`Azure DevOps answered ${res.status}`, res.status, 'UNAVAILABLE', true, retryAfterMs)
  }
  throw new AzureDevOpsApiError(`Azure DevOps answered ${res.status}`, res.status, 'INVALID_REQUEST', false)
}

function decodeHeader(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export interface AzureDevOpsConnectionData {
  /** The identity's Azure DevOps id (`authenticatedUser.id`). */
  identityId: string
  identityName: string | null
  /** The organization's rename-stable `instanceId`. */
  instanceId: string
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID_RE.test(value)
}

/** §3.2 step 5: who the token is in the organization, and the organization's instance. */
export async function readConnectionData(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string
): Promise<AzureDevOpsConnectionData> {
  const json = await devOpsRequest<{
    authenticatedUser?: { id?: unknown; providerDisplayName?: unknown }
    instanceId?: unknown
  }>(client, token, organization, '_apis/connectionData')
  const id = json.authenticatedUser?.id
  if (!isGuid(id) || !isGuid(json.instanceId)) {
    throw new AzureDevOpsApiError('Azure DevOps answered connectionData without an identity', 200, 'UNAVAILABLE', true)
  }
  const name = json.authenticatedUser?.providerDisplayName
  return {
    identityId: id.toLowerCase(),
    identityName: typeof name === 'string' && name.trim() ? name.trim() : null,
    instanceId: json.instanceId.toLowerCase()
  }
}

export interface AzureDevOpsUserIdentity {
  name: string
  email: string
}

interface MicrosoftIdentityLookup {
  organization: string
  tenantId: string
  objectId: string
  email: string
}

interface RawMicrosoftIdentity {
  id?: unknown
  descriptor?: unknown
  providerDisplayName?: unknown
  isActive?: unknown
  isContainer?: unknown
  properties?: Record<string, { $value?: unknown }>
}

// Email locates candidates; only the linked object ID within the connection's tenant establishes identity.
async function findMicrosoftIdentity(
  client: AzureDevOpsApiClient,
  token: string,
  input: MicrosoftIdentityLookup
): Promise<RawMicrosoftIdentity | null> {
  const query = new URLSearchParams({
    searchFilter: 'MailAddress',
    filterValue: input.email,
    queryMembership: 'None',
    'api-version': API_VERSION
  })
  const result = await azureDevOpsCall<{ value?: RawMicrosoftIdentity[] }>(
    client,
    token,
    input.organization,
    `https://vssps.dev.azure.com/${encodeURIComponent(input.organization)}/_apis/identities?${query}`
  )
  const same = (value: unknown, expected: string) =>
    typeof value === 'string' && value.trim().toLowerCase() === expected.trim().toLowerCase()
  const matches = (Array.isArray(result?.value) ? result.value : []).filter(
    (identity) =>
      identity?.isActive === true &&
      identity.isContainer !== true &&
      same(identity.properties?.SchemaClassName?.$value, 'User') &&
      same(identity.properties?.Domain?.$value, input.tenantId) &&
      same(
        identity.properties?.['http://schemas.microsoft.com/identity/claims/objectidentifier']?.$value,
        input.objectId
      ) &&
      same(identity.properties?.Mail?.$value, input.email)
  )
  return matches.length === 1 ? matches[0]! : null
}

export async function readMicrosoftUser(
  client: AzureDevOpsApiClient,
  token: string,
  input: MicrosoftIdentityLookup
): Promise<AzureDevOpsUserIdentity | null> {
  const name = (await findMicrosoftIdentity(client, token, input))?.providerDisplayName
  return typeof name === 'string' && name.trim() ? { name: name.trim(), email: input.email } : null
}

export interface AzureDevOpsMicrosoftIdentity {
  id: string
  descriptor: string
}

// Authorization needs the stable identity and security descriptor, independently of its display name.
export async function readMicrosoftIdentity(
  client: AzureDevOpsApiClient,
  token: string,
  input: MicrosoftIdentityLookup
): Promise<AzureDevOpsMicrosoftIdentity | null> {
  const identity = await findMicrosoftIdentity(client, token, input)
  return identity && isGuid(identity.id) && typeof identity.descriptor === 'string' && identity.descriptor.trim()
    ? { id: identity.id.toLowerCase(), descriptor: identity.descriptor }
    : null
}

/** One repository as the identity sees it (§5), keyed by GUID. */
export interface AzureDevOpsRepository {
  id: string
  name: string
  projectId: string
  projectName: string
  /** The canonical four-segment clone URL. */
  cloneUrl: string
  defaultBranch: string | null
}

interface RawRepository {
  id?: unknown
  name?: unknown
  remoteUrl?: unknown
  defaultBranch?: unknown
  isDisabled?: unknown
  isInMaintenance?: unknown
  project?: { id?: unknown; name?: unknown }
}

/** The canonical clone URL of a listed repository: its own `remoteUrl` normalized, else composed from the names. */
export function azureDevOpsCanonicalCloneUrl(
  organization: string,
  projectName: string,
  name: string,
  remoteUrl?: unknown
): string {
  if (typeof remoteUrl === 'string') {
    try {
      return normalizeGitCloneUrl(remoteUrl)
    } catch {
      // A remoteUrl the codec refuses falls back to the composed canonical form.
    }
  }
  return `https://dev.azure.com/${organization.toLowerCase()}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(name)}`
}

/** Every Git repository in the organization the identity can see, without disabled or in-maintenance ones (§5). */
export async function listRepositories(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string
): Promise<AzureDevOpsRepository[]> {
  const json = await devOpsRequest<{ value?: RawRepository[] }>(
    client,
    token,
    organization,
    `_apis/git/repositories?api-version=${API_VERSION}`
  )
  const repositories: AzureDevOpsRepository[] = []
  for (const raw of Array.isArray(json.value) ? json.value : []) {
    if (raw.isDisabled === true || raw.isInMaintenance === true) continue
    const projectId = raw.project?.id
    const projectName = raw.project?.name
    if (!isGuid(raw.id) || typeof raw.name !== 'string' || !isGuid(projectId) || typeof projectName !== 'string')
      continue
    repositories.push({
      id: raw.id.toLowerCase(),
      name: raw.name,
      projectId: projectId.toLowerCase(),
      projectName,
      cloneUrl: azureDevOpsCanonicalCloneUrl(organization, projectName, raw.name, raw.remoteUrl),
      defaultBranch:
        typeof raw.defaultBranch === 'string' && raw.defaultBranch
          ? raw.defaultBranch.replace(/^refs\/heads\//, '')
          : null
    })
  }
  return repositories.sort((a, b) => cmp(a.projectName, b.projectName) || cmp(a.name, b.name))
}

function cmp(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

export interface AzureDevOpsRepositoryPermissions {
  read: boolean
  contribute: boolean
}

/** §12 item 7: the identity's own GenericRead and GenericContribute on one repository, in one call. */
export async function evaluateRepositoryPermissions(
  client: AzureDevOpsApiClient,
  token: string,
  organization: string,
  projectId: string,
  repositoryId: string
): Promise<AzureDevOpsRepositoryPermissions> {
  const securityToken = `repoV2/${projectId}/${repositoryId}`
  const json = await devOpsRequest<{ evaluations?: Array<{ permissions?: unknown; value?: unknown }> }>(
    client,
    token,
    organization,
    `_apis/security/permissionevaluationbatch?api-version=${API_VERSION}`,
    {
      method: 'POST',
      body: {
        alwaysAllowAdministrators: false,
        evaluations: [GENERIC_READ, GENERIC_CONTRIBUTE].map((permissions) => ({
          securityNamespaceId: GIT_REPOSITORIES_NAMESPACE,
          token: securityToken,
          permissions
        }))
      }
    }
  )
  const allowed = (bit: number) =>
    (json.evaluations ?? []).some((evaluation) => Number(evaluation.permissions) === bit && evaluation.value === true)
  return { read: allowed(GENERIC_READ), contribute: allowed(GENERIC_CONTRIBUTE) }
}
