/**
 * Thin GitLab.com REST wrapper — the only spot the CP talks to gitlab.com (the
 * pattern set by `github/api.ts`). `fetch` is injectable so tests stub the API
 * without network; timeouts are short; every error is typed.
 *
 * NEVER log request headers, token parameters, or token-bearing response bodies.
 */
import { GITLAB_HOST } from './config.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type GitlabErrorCode = 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'NOT_FOUND' | 'INTERNAL'

/** GitLab call failure, pre-mapped for route/service handling. */
export class GitlabApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: GitlabErrorCode,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'GitlabApiError'
  }
}

const API_BASE = `${GITLAB_HOST}/api/v4`
const TIMEOUT_MS = 10_000

function codeFor(status: number): GitlabErrorCode {
  if (status === 401 || status === 403) return 'AUTH_REQUIRED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  return 'INTERNAL'
}

export interface GitlabRequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** OAuth or PAT bearer. Pass null only for the token endpoint itself. */
  auth: string | null
  body?: unknown
  fetchImpl?: FetchLike
  baseUrl?: string
}

/** One GitLab REST call → parsed JSON. Throws `GitlabApiError` on any non-2xx. */
export async function gitlabRequest<T>(path: string, opts: GitlabRequestOpts): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike)
  let res: Response
  try {
    res = await fetchImpl(`${opts.baseUrl ?? API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new GitlabApiError(`gitlab unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
  }
  if (res.ok) {
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }
  throw await gitlabError(res)
}

/** A non-2xx response as the typed error. Reads the body for diagnostics only;
 *  NEVER include token material. */
async function gitlabError(res: Response): Promise<GitlabApiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown; error_description?: unknown }
    const msg = body.message ?? body.error_description ?? body.error
    if (typeof msg === 'string') detail = `: ${msg}`
    else if (msg !== undefined) detail = `: ${JSON.stringify(msg)}`
  } catch {
    // non-JSON error body — status alone
  }
  return new GitlabApiError(`gitlab ${res.status}${detail}`, res.status, codeFor(res.status), res.status >= 500)
}

/** GitLab's own per-page ceiling for these listings. */
const PAGE_SIZE = 100
/** Runaway backstops on `gitlabPagedGet`; exceeding either refuses, never truncates.
 *  The wall-clock one is what keeps a paged read inside a caller's mutual-exclusion
 *  lease: an unbounded walk could otherwise outlive the lease it reads under. */
const MAX_PAGES = 50
const LISTING_BUDGET_MS = 60_000

/** EVERY row of a paginated GET, following GitLab's `x-next-page` header.
 *  A caller's predicate is sound only over a complete listing (§7.2), so this
 *  never returns a partial one: a bound or a stuck header raises instead. */
async function gitlabPagedGet<T>(path: string, opts: { auth: string; fetchImpl?: FetchLike }): Promise<T[]> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike)
  const deadline = Date.now() + LISTING_BUDGET_MS
  const rows: T[] = []
  let page = 1
  for (let requests = 0; requests < MAX_PAGES; requests++) {
    const budget = deadline - Date.now()
    if (budget <= 0) throw new GitlabApiError('gitlab listing exceeded its time budget', 0, 'INTERNAL', true)
    const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`
    let res: Response
    try {
      res = await fetchImpl(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${opts.auth}` },
        signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, budget))
      })
    } catch (e) {
      throw new GitlabApiError(`gitlab unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
    }
    if (!res.ok) throw await gitlabError(res)
    const batch = (await res.json()) as T[]
    if (!Array.isArray(batch)) throw new GitlabApiError('gitlab listing is not an array', 0, 'INTERNAL', false)
    rows.push(...batch)
    const next = res.headers.get('x-next-page')
    if (!next || !/^\d+$/.test(next)) return rows
    // A header that does not advance would spin or silently truncate: refuse.
    if (Number(next) <= page) throw new GitlabApiError('gitlab pagination did not advance', 0, 'INTERNAL', true)
    page = Number(next)
  }
  throw new GitlabApiError(`gitlab listing exceeds ${MAX_PAGES} pages`, 0, 'INTERNAL', true)
}

/** The token grant GitLab's `/oauth/token` returns for code exchange and refresh. */
export interface GitlabTokenGrant {
  access_token: string
  refresh_token: string
  expires_in?: number
  created_at?: number
  scope?: string
}

/** Exchange an authorization code (with its PKCE verifier) for a token pair. */
export async function gitlabExchangeCode(
  args: {
    clientId: string
    clientSecret: string
    code: string
    verifier: string
    redirectUri: string
  },
  fetchImpl?: FetchLike
): Promise<GitlabTokenGrant> {
  return gitlabTokenCall(
    {
      grant_type: 'authorization_code',
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri
    },
    fetchImpl
  )
}

/** One refresh. Rotates BOTH tokens — the caller owns the single-writer/CAS discipline (§9.3). */
export async function gitlabRefreshToken(
  args: { clientId: string; clientSecret: string; refreshToken: string; redirectUri: string },
  fetchImpl?: FetchLike
): Promise<GitlabTokenGrant> {
  return gitlabTokenCall(
    {
      grant_type: 'refresh_token',
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
      redirect_uri: args.redirectUri
    },
    fetchImpl
  )
}

async function gitlabTokenCall(params: Record<string, string>, fetchImpl?: FetchLike): Promise<GitlabTokenGrant> {
  const impl = fetchImpl ?? (fetch as FetchLike)
  let res: Response
  try {
    res = await impl(`${GITLAB_HOST}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new GitlabApiError(`gitlab token endpoint unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
  }
  if (!res.ok) {
    // Deliberately status-only: an OAuth error body can echo request parameters.
    throw new GitlabApiError(`gitlab token endpoint ${res.status}`, res.status, codeFor(res.status), res.status >= 500)
  }
  const grant = (await res.json()) as GitlabTokenGrant
  if (typeof grant.access_token !== 'string' || typeof grant.refresh_token !== 'string') {
    throw new GitlabApiError('gitlab token response is missing the token pair', 0, 'INTERNAL', false)
  }
  return grant
}

/** The authenticated GitLab.com user (`GET /user`) — administration identity facts. */
export interface GitlabCurrentUser {
  id: number
  username: string
}

export async function gitlabCurrentUser(accessToken: string, fetchImpl?: FetchLike): Promise<GitlabCurrentUser> {
  const user = await gitlabRequest<GitlabCurrentUser>('/user', { auth: accessToken, fetchImpl })
  if (typeof user?.id !== 'number' || typeof user.username !== 'string') {
    throw new GitlabApiError('gitlab /user response is not a user', 0, 'INTERNAL', false)
  }
  return user
}

/** One accessible project row for the picker (§10.1) — metadata only. */
export interface GitlabProjectSummary {
  id: number
  path_with_namespace: string
  default_branch?: string
  http_url_to_repo?: string
  last_activity_at?: string
}

/** Server-side paginated membership project search (§10.1). */
export async function gitlabListProjects(
  accessToken: string,
  opts: { search?: string; page?: number; perPage?: number },
  fetchImpl?: FetchLike
): Promise<{ projects: GitlabProjectSummary[]; nextPage: number | null }> {
  const params = new URLSearchParams({
    membership: 'true',
    order_by: 'last_activity_at',
    per_page: String(Math.min(opts.perPage ?? 30, 100)),
    page: String(opts.page ?? 1)
  })
  if (opts.search) params.set('search', opts.search)
  const impl = fetchImpl ?? (fetch as FetchLike)
  let res: Response
  try {
    res = await impl(`${GITLAB_HOST}/api/v4/projects?${params.toString()}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new GitlabApiError(`gitlab unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
  }
  if (!res.ok) {
    throw new GitlabApiError(`gitlab ${res.status}`, res.status, codeFor(res.status), res.status >= 500)
  }
  const nextHeader = res.headers.get('x-next-page')
  const nextPage = nextHeader && /^\d+$/.test(nextHeader) ? Number(nextHeader) : null
  return { projects: (await res.json()) as GitlabProjectSummary[], nextPage }
}

/** One project by numeric id; null on a definitive 404 (out of grant / gone). */
export async function gitlabProject(
  accessToken: string,
  projectId: bigint,
  fetchImpl?: FetchLike
): Promise<GitlabProjectSummary | null> {
  try {
    return await gitlabRequest<GitlabProjectSummary>(`/projects/${projectId}`, { auth: accessToken, fetchImpl })
  } catch (e) {
    if (e instanceof GitlabApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}

/** GitLab access levels this integration reasons about. */
export const GITLAB_ACCESS_REPORTER = 20
export const GITLAB_ACCESS_DEVELOPER = 30
export const GITLAB_ACCESS_MAINTAINER = 40

/** The project role a workspace authorization derives (§7.2): push needs
 *  Developer, a read-only workspace needs no more than Reporter. One definition,
 *  because the consumer query and the write paths must not disagree. */
export function gitlabWorkspaceAccessLevel(gitAccess: 'read' | 'write' | undefined): number {
  return gitAccess === 'read' ? GITLAB_ACCESS_REPORTER : GITLAB_ACCESS_DEVELOPER
}

export interface GitlabEffectiveMembership {
  access_level: number
  state: string
  expires_at: string | null
}

/** Effective membership including direct, ancestor-group, and invited-group
 *  paths (`/members/all/:user_id`, §12.2). Null on a definitive 404 (no membership). */
export async function gitlabEffectiveMembership(
  accessToken: string,
  projectId: bigint,
  userId: bigint,
  fetchImpl?: FetchLike
): Promise<GitlabEffectiveMembership | null> {
  try {
    return await gitlabRequest<GitlabEffectiveMembership>(`/projects/${projectId}/members/all/${userId}`, {
      auth: accessToken,
      fetchImpl
    })
  } catch (e) {
    if (e instanceof GitlabApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}

/** §12.2 acceptance predicate: active, unexpired (UTC date), and at/above the bar.
 *  Anything missing, ambiguous, or below fails closed. */
export function membershipSatisfies(
  membership: GitlabEffectiveMembership | null,
  minAccessLevel: number,
  nowUtcMs: number
): boolean {
  if (!membership) return false
  if (membership.state !== 'active') return false
  if (typeof membership.access_level !== 'number' || membership.access_level < minAccessLevel) return false
  if (membership.expires_at) {
    const expires = Date.parse(`${membership.expires_at}T00:00:00.000Z`)
    if (!Number.isFinite(expires) || expires <= nowUtcMs) return false
  }
  return true
}

// ── administration surface for the provisioning saga (§10.2, §7.2–§7.4, §11.1) ──

export interface GitlabNamespaceRef {
  id: number
  parent_id: number | null
  kind: string // 'group' | 'user'
  full_path: string
}

/** Project namespace facts ride the project payload. */
export interface GitlabProjectWithNamespace extends GitlabProjectSummary {
  namespace?: GitlabNamespaceRef
}

/** Walk to the ROOT namespace (service accounts hang off the top-level group).
 *  A personal (`user`) namespace has no service accounts — the caller reports it. */
export async function gitlabRootNamespace(
  accessToken: string,
  start: GitlabNamespaceRef,
  fetchImpl?: FetchLike
): Promise<GitlabNamespaceRef> {
  let current = start
  for (let depth = 0; depth < 20 && current.parent_id !== null; depth++) {
    current = await gitlabRequest<GitlabNamespaceRef>(`/namespaces/${current.parent_id}`, {
      auth: accessToken,
      fetchImpl
    })
  }
  return current
}

export interface GitlabServiceAccount {
  id: number
  username: string
  name: string
}

/** How much of the agent's name the username carries (§7.2). */
export const GITLAB_ACCOUNT_SLUG_MAX = 20

/** The agent's name folded to the lower-case `[a-z0-9-]` a GitLab username
 *  accepts: runs collapse, the ends are trimmed, and `agent` stands in when
 *  nothing survives. */
export function gitlabAccountSlug(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, GITLAB_ACCOUNT_SLUG_MAX)
    .replace(/-+$/, '')
  return slug || 'agent'
}

/** The uniqueness half of the username: the agent id's first twelve hex
 *  characters and the top-level group id in base 36. Those 48 bits put an
 *  accidental collision among even millions of accounts below one in a billion,
 *  and the root component is what lets one agent own an account in every root
 *  it spans. */
function accountKeySuffix(agentId: string, rootGroupId: bigint): string {
  return `${agentId.replace(/-/g, '').slice(0, 12)}-${rootGroupId.toString(36)}`
}

/** The account's non-secret marker (§7.2): `<agentSlug>-<agentId12>-<root36>`,
 *  readable in `@`-completion and globally unique. Taken at CREATION only — the
 *  row's numeric user id is the durable key, and this derivation is a recovery
 *  marker for an account the database does not know yet. */
export function gitlabAgentAccountUsername(agentId: string, agentName: string, rootGroupId: bigint): string {
  return `${gitlabAccountSlug(agentName)}-${accountKeySuffix(agentId, rootGroupId)}`
}

/** Does an existing username already carry this account's scheme? Only the
 *  shape and the key suffix are checked: the slug half is creation-time, so an
 *  agent renamed afterwards must NOT be renamed at the provider (§7.2). */
export function gitlabAccountUsernameMatchesScheme(username: string, agentId: string, rootGroupId: bigint): boolean {
  const suffix = `-${accountKeySuffix(agentId, rootGroupId)}`
  if (!username.endsWith(suffix)) return false
  const slug = username.slice(0, -suffix.length)
  return slug.length > 0 && slug.length <= GITLAB_ACCOUNT_SLUG_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
}

/** The account's human display name: the agent's own name, folded to a
 *  conservative ASCII set and capped so no name we write can be refused, and
 *  with no suffix. Falls back to the machine username when nothing survives. */
export function gitlabAgentAccountDisplayName(agentName: string, username: string): string {
  const folded = agentName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 48)
  return folded || username
}

/** The top-level group's OWN service accounts, ALL pages. Deliberately the only
 *  listing the recovery path reads: a global user search would let an account
 *  outside this root answer for one of ours (§7.2). It is also the snapshot the
 *  create window is dated against, so a partial page would read an account that
 *  merely sits further down as new — hence the exhaustive read. */
export async function gitlabListServiceAccounts(
  accessToken: string,
  groupId: number,
  fetchImpl?: FetchLike
): Promise<GitlabServiceAccount[]> {
  return gitlabPagedGet<GitlabServiceAccount>(`/groups/${groupId}/service_accounts`, { auth: accessToken, fetchImpl })
}

/** Find the marked account among the top-level group's service accounts. */
export async function gitlabFindServiceAccount(
  accessToken: string,
  groupId: number,
  username: string,
  fetchImpl?: FetchLike
): Promise<GitlabServiceAccount | null> {
  const accounts = await gitlabListServiceAccounts(accessToken, groupId, fetchImpl)
  return accounts.find((account) => account.username === username) ?? null
}

export async function gitlabCreateServiceAccount(
  accessToken: string,
  groupId: number,
  input: { username: string; name: string },
  fetchImpl?: FetchLike
): Promise<GitlabServiceAccount> {
  return gitlabRequest<GitlabServiceAccount>(`/groups/${groupId}/service_accounts`, {
    method: 'POST',
    auth: accessToken,
    body: { username: input.username, name: input.name },
    fetchImpl
  })
}

/** Relabel an existing account. Both members are cosmetic (§7.2): the durable
 *  identity is the numeric user id, never the display name or the username. */
export async function gitlabUpdateServiceAccount(
  accessToken: string,
  groupId: number,
  userId: bigint,
  input: { name?: string; username?: string },
  fetchImpl?: FetchLike
): Promise<GitlabServiceAccount> {
  return gitlabRequest<GitlabServiceAccount>(`/groups/${groupId}/service_accounts/${userId}`, {
    method: 'PATCH',
    auth: accessToken,
    body: input,
    fetchImpl
  })
}

export async function gitlabDeleteServiceAccount(
  accessToken: string,
  groupId: number,
  userId: bigint,
  fetchImpl?: FetchLike
): Promise<void> {
  await gitlabRequest<void>(`/groups/${groupId}/service_accounts/${userId}`, {
    method: 'DELETE',
    auth: accessToken,
    fetchImpl
  })
}

/** GitLab's avatar ceiling for `PUT /user/avatar`; the ideal edge is 192px. */
export const GITLAB_AVATAR_MAX_BYTES = 200 * 1024
export const GITLAB_AVATAR_SIZE = 192

/** Set the AUTHENTICATED user's avatar (`PUT /user/avatar`, GitLab 17.0+):
 *  multipart, form field `avatar`. Called with an agent account's own `api` PAT,
 *  so the authenticated user IS the account (§7.2). A provider that does not
 *  offer the endpoint answers 404, which the caller treats as a cosmetic skip.
 *  Status-only errors: the request body carries image bytes and a bearer. */
export async function gitlabUploadCurrentUserAvatar(
  accountToken: string,
  png: Uint8Array,
  fetchImpl?: FetchLike
): Promise<void> {
  const impl = fetchImpl ?? (fetch as FetchLike)
  const form = new FormData()
  form.set('avatar', new Blob([png], { type: 'image/png' }), 'agent-icon.png')
  let res: Response
  try {
    res = await impl(`${API_BASE}/user/avatar`, {
      method: 'PUT',
      headers: { accept: 'application/json', authorization: `Bearer ${accountToken}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new GitlabApiError(`gitlab unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
  }
  if (!res.ok) {
    throw new GitlabApiError(`gitlab ${res.status}`, res.status, codeFor(res.status), res.status >= 500)
  }
}

export interface GitlabMember {
  id: number
  access_level: number
  state: string
}

/** One DIRECT project membership (`/members/:user_id`, not `/members/all/`);
 *  null when the account holds only an inherited grant, or none at all. */
export async function gitlabProjectMember(
  accessToken: string,
  projectId: bigint,
  userId: bigint,
  fetchImpl?: FetchLike
): Promise<GitlabMember | null> {
  try {
    return await gitlabRequest<GitlabMember>(`/projects/${projectId}/members/${userId}`, {
      auth: accessToken,
      fetchImpl
    })
  } catch (e) {
    if (e instanceof GitlabApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}

/** Converge the service account's DIRECT project membership to exactly
 *  `accessLevel` (§7.2), in either direction: a narrowed workspace clamp must
 *  lower the provider role, not only a widened one raise it. An account whose
 *  grant is inherited from an ancestor group has no direct row to converge, and
 *  a lower direct one could not reduce that grant, so it is left alone. */
export async function gitlabEnsureMember(
  accessToken: string,
  projectId: bigint,
  userId: bigint,
  accessLevel: number,
  fetchImpl?: FetchLike
): Promise<void> {
  try {
    await gitlabRequest<GitlabMember>(`/projects/${projectId}/members`, {
      method: 'POST',
      auth: accessToken,
      body: { user_id: Number(userId), access_level: accessLevel },
      fetchImpl
    })
    return
  } catch (e) {
    // 409: already a member — converge the existing level below.
    if (!(e instanceof GitlabApiError) || (e.status !== 409 && e.status !== 400)) throw e
  }
  const direct = await gitlabProjectMember(accessToken, projectId, userId, fetchImpl)
  if (direct?.access_level === accessLevel) return
  if (direct === null) {
    const inherited = await gitlabEffectiveMembership(accessToken, projectId, userId, fetchImpl)
    if (membershipSatisfies(inherited, accessLevel, Date.now())) return
  }
  await gitlabRequest<GitlabMember>(`/projects/${projectId}/members/${userId}`, {
    method: 'PUT',
    auth: accessToken,
    body: { access_level: accessLevel },
    fetchImpl
  })
}

/** Drop the account's direct project membership (§19.4 unbind). */
export async function gitlabRemoveMember(
  accessToken: string,
  projectId: bigint,
  userId: bigint,
  fetchImpl?: FetchLike
): Promise<void> {
  await gitlabRequest<void>(`/projects/${projectId}/members/${userId}`, {
    method: 'DELETE',
    auth: accessToken,
    fetchImpl
  })
}

export interface GitlabPatGrant {
  id: number
  name: string
  scopes: string[]
  active: boolean
  revoked?: boolean
  expires_at: string | null
  token?: string // present ONLY on create/rotate responses — never log
  user_id?: number
}

export async function gitlabCreateServiceAccountToken(
  accessToken: string,
  groupId: number,
  serviceAccountUserId: bigint,
  input: { name: string; scopes: string[]; expiresAt: string },
  fetchImpl?: FetchLike
): Promise<GitlabPatGrant> {
  return gitlabRequest<GitlabPatGrant>(
    `/groups/${groupId}/service_accounts/${serviceAccountUserId}/personal_access_tokens`,
    {
      method: 'POST',
      auth: accessToken,
      body: { name: input.name, scopes: input.scopes, expires_at: input.expiresAt },
      fetchImpl
    }
  )
}

/** ALL pages of the account's PATs (marker recovery); values are never returned
 *  here. Group-scoped on purpose: the installer OAuth identity is not an instance
 *  admin on GitLab.com and can manage ONLY the group's service-account tokens.
 *  Exhaustive because a stray this misses keeps a token whose plaintext is lost. */
export async function gitlabListServiceAccountTokens(
  accessToken: string,
  groupId: number,
  serviceAccountUserId: bigint,
  fetchImpl?: FetchLike
): Promise<GitlabPatGrant[]> {
  return gitlabPagedGet<GitlabPatGrant>(
    `/groups/${groupId}/service_accounts/${serviceAccountUserId}/personal_access_tokens`,
    { auth: accessToken, fetchImpl }
  )
}

/** Revoke one service-account PAT through the group endpoint (same reason as above). */
export async function gitlabRevokeServiceAccountToken(
  accessToken: string,
  groupId: number,
  serviceAccountUserId: bigint,
  tokenId: bigint,
  fetchImpl?: FetchLike
): Promise<void> {
  await gitlabRequest<void>(
    `/groups/${groupId}/service_accounts/${serviceAccountUserId}/personal_access_tokens/${tokenId}`,
    { method: 'DELETE', auth: accessToken, fetchImpl }
  )
}

export interface GitlabWebhook {
  id: number
  url: string
}

export interface GitlabWebhookEvents {
  push_events: boolean
  issues_events: boolean
  merge_requests_events: boolean
  note_events: boolean
}

export async function gitlabCreateWebhook(
  accessToken: string,
  projectId: bigint,
  input: { url: string; signingToken: string; events: GitlabWebhookEvents },
  fetchImpl?: FetchLike
): Promise<GitlabWebhook> {
  return gitlabRequest<GitlabWebhook>(`/projects/${projectId}/hooks`, {
    method: 'POST',
    auth: accessToken,
    // `signing_token` is the whsec HMAC key producing `webhook-signature`;
    // `token` would configure the legacy X-Gitlab-Token header instead (§11.1).
    body: { url: input.url, signing_token: input.signingToken, enable_ssl_verification: true, ...input.events },
    fetchImpl
  })
}

export async function gitlabUpdateWebhook(
  accessToken: string,
  projectId: bigint,
  webhookId: bigint,
  input: { url: string; signingToken: string; events: GitlabWebhookEvents },
  fetchImpl?: FetchLike
): Promise<GitlabWebhook> {
  return gitlabRequest<GitlabWebhook>(`/projects/${projectId}/hooks/${webhookId}`, {
    method: 'PUT',
    auth: accessToken,
    body: { url: input.url, signing_token: input.signingToken, enable_ssl_verification: true, ...input.events },
    fetchImpl
  })
}

/** ALL pages of the project's webhooks — crash-left create reconciliation
 *  (exact-URL adoption). Exhaustive because a hook this misses is read as
 *  absent: the converge creates a duplicate, and cleanup orphans it. */
export async function gitlabListWebhooks(
  accessToken: string,
  projectId: bigint,
  fetchImpl?: FetchLike
): Promise<GitlabWebhook[]> {
  return gitlabPagedGet<GitlabWebhook>(`/projects/${projectId}/hooks`, { auth: accessToken, fetchImpl })
}

export async function gitlabDeleteWebhook(
  accessToken: string,
  projectId: bigint,
  webhookId: bigint,
  fetchImpl?: FetchLike
): Promise<void> {
  await gitlabRequest<void>(`/projects/${projectId}/hooks/${webhookId}`, {
    method: 'DELETE',
    auth: accessToken,
    fetchImpl
  })
}

/** Fire one provider test delivery at a newly created or repaired webhook (§10.2 step 7). */
export async function gitlabTestWebhook(
  accessToken: string,
  projectId: bigint,
  webhookId: bigint,
  trigger: 'push_events' | 'issues_events' | 'merge_requests_events' | 'note_events',
  fetchImpl?: FetchLike
): Promise<void> {
  await gitlabRequest<void>(`/projects/${projectId}/hooks/${webhookId}/test/${trigger}`, {
    method: 'POST',
    auth: accessToken,
    fetchImpl
  })
}

// ── subject reads for the Console rerun (§16.1) ──

export interface GitlabMergeRequest {
  iid: number
  state: string
  title?: string
  web_url?: string
  draft?: boolean
  work_in_progress?: boolean
  sha?: string | null
  source_project_id?: number
  target_project_id?: number
  diff_refs?: { base_sha?: string | null; head_sha?: string | null; start_sha?: string | null } | null
}

/** One merge request by IID; null on a definitive 404 (deleted or out of grant). */
export async function gitlabMergeRequest(
  accessToken: string,
  projectId: bigint,
  iid: number,
  fetchImpl?: FetchLike
): Promise<GitlabMergeRequest | null> {
  try {
    return await gitlabRequest<GitlabMergeRequest>(`/projects/${projectId}/merge_requests/${iid}`, {
      auth: accessToken,
      fetchImpl
    })
  } catch (e) {
    if (e instanceof GitlabApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}

export interface GitlabIssue {
  iid: number
  state: string
  title?: string
  web_url?: string
}

/** One issue by IID; null on a definitive 404. */
export async function gitlabIssue(
  accessToken: string,
  projectId: bigint,
  iid: number,
  fetchImpl?: FetchLike
): Promise<GitlabIssue | null> {
  try {
    return await gitlabRequest<GitlabIssue>(`/projects/${projectId}/issues/${iid}`, { auth: accessToken, fetchImpl })
  } catch (e) {
    if (e instanceof GitlabApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}
