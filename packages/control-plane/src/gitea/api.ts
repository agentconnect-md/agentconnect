/**
 * Thin Gitea REST wrapper — the only place the Control Plane talks to a Gitea instance
 * (gitea-integration.md §4.2), shaped like `gitlab/api.ts`. Every call takes the deployment's
 * base-bound {@link GiteaApiClient}; timeouts are short; every error is typed.
 *
 * NEVER log request headers, the token, or token-bearing bodies — nothing here echoes a token.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** `AUTH_REJECTED` is the definite rejection of §4.3; `FORBIDDEN` is a per-resource refusal of a valid token. */
export type GiteaErrorCode = 'AUTH_REJECTED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'VALIDATION' | 'INTERNAL'

export class GiteaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: GiteaErrorCode,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'GiteaApiError'
  }
}

/** Whether an error is the connection-level rejection that degrades every binding (§4.3). */
export function isGiteaAuthRejection(e: unknown): e is GiteaApiError {
  return e instanceof GiteaApiError && e.code === 'AUTH_REJECTED'
}

const TIMEOUT_MS = 10_000
/** Gitea's own default for `max_response_items`; used until `GET /settings/api` answers. */
export const GITEA_DEFAULT_PAGE_SIZE = 50
/** Runaway backstops on a paged walk; exceeding either refuses, never truncates. */
const MAX_PAGES = 200
const LISTING_BUDGET_MS = 60_000

/** The one Gitea instance this deployment talks to (§3): a normalized base bound to one `fetch`. */
export class GiteaApiClient {
  private readonly fetchImpl: FetchLike

  constructor(
    /** Normalized by `normalizeGiteaBaseUrl`: no trailing slash, a path prefix kept. */
    readonly baseUrl: string,
    fetchImpl?: FetchLike
  ) {
    this.fetchImpl = fetchImpl ?? (fetch as FetchLike)
  }

  /** Concatenation, never URL resolution: an absolute path would drop a base path prefix. */
  apiUrl(path: string): string {
    return `${this.baseUrl}/api/v1${path}`
  }

  fetch(url: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(url, init)
  }
}

/** A 403 naming the token's scopes is the token's fault; any other 403 is the resource's. */
function codeFor(status: number, detail: string): GiteaErrorCode {
  if (status === 401) return 'AUTH_REJECTED'
  if (status === 403) return /\bscope|\btoken\b/i.test(detail) ? 'AUTH_REJECTED' : 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 422) return 'VALIDATION'
  if (status === 429) return 'RATE_LIMITED'
  return 'INTERNAL'
}

interface GiteaDispatchOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** The bot token; null for the unauthenticated reads (`/version`, a public repository). */
  token: string | null
  body?: unknown
  timeoutMs?: number
  client: GiteaApiClient
}

/** The ONE place a Gitea URL is composed and a request is dispatched. */
async function giteaFetch(path: string, opts: GiteaDispatchOpts): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.token) headers.authorization = `token ${opts.token}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  try {
    return await opts.client.fetch(opts.client.apiUrl(path), {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)
    })
  } catch (e) {
    throw new GiteaApiError(`gitea unreachable: ${(e as Error).message}`, 0, 'INTERNAL', true)
  }
}

/** A non-2xx response as the typed error; the body is read for its message only. */
async function giteaError(res: Response): Promise<GiteaApiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { message?: unknown; errors?: unknown }
    if (typeof body.message === 'string') detail = body.message
    else if (Array.isArray(body.errors)) detail = body.errors.filter((m) => typeof m === 'string').join('; ')
  } catch {
    // non-JSON error body — status alone
  }
  return new GiteaApiError(
    `gitea ${res.status}${detail ? `: ${detail}` : ''}`,
    res.status,
    codeFor(res.status, detail),
    res.status >= 500
  )
}

/** One Gitea REST call → parsed JSON. Throws `GiteaApiError` on any non-2xx. */
async function giteaRequest<T>(path: string, opts: GiteaDispatchOpts): Promise<T> {
  const res = await giteaFetch(path, opts)
  if (!res.ok) throw await giteaError(res)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** The `page` a `Link: <…>; rel="next"` header points at, or null when there is no next page. */
export function nextPageOfLink(link: string | null): number | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim())
    if (!match) continue
    try {
      const page = new URL(match[1]!).searchParams.get('page')
      return page && /^\d+$/.test(page) ? Number(page) : null
    } catch {
      return null
    }
  }
  return null
}

interface PagedOpts {
  token: string | null
  client: GiteaApiClient
  /** The instance's `max_response_items` (§6); anything above it is silently clamped by Gitea. */
  pageSize: number
}

/** EVERY row of a paginated GET, following `Link` and `X-Total-Count`; never a partial listing. */
export async function giteaPagedGet<T>(path: string, opts: PagedOpts): Promise<T[]> {
  const deadline = Date.now() + LISTING_BUDGET_MS
  const rows: T[] = []
  let page = 1
  for (let requests = 0; requests < MAX_PAGES; requests++) {
    const budget = deadline - Date.now()
    if (budget <= 0) throw new GiteaApiError('gitea listing exceeded its time budget', 0, 'INTERNAL', true)
    const query = `${path.includes('?') ? '&' : '?'}page=${page}&limit=${opts.pageSize}`
    const res = await giteaFetch(`${path}${query}`, {
      token: opts.token,
      timeoutMs: Math.min(TIMEOUT_MS, budget),
      client: opts.client
    })
    if (!res.ok) throw await giteaError(res)
    const batch = (await res.json()) as T[]
    if (!Array.isArray(batch)) throw new GiteaApiError('gitea listing is not an array', 0, 'INTERNAL', false)
    rows.push(...batch)
    const total = res.headers.get('x-total-count')
    const complete = total !== null && /^\d+$/.test(total) && rows.length >= Number(total)
    const next = nextPageOfLink(res.headers.get('link'))
    if (batch.length === 0 || complete || next === null) return rows
    // A header that does not advance would spin or silently truncate: refuse.
    if (next <= page) throw new GiteaApiError('gitea pagination did not advance', 0, 'INTERNAL', true)
    page = next
  }
  throw new GiteaApiError(`gitea listing exceeds ${MAX_PAGES} pages`, 0, 'INTERNAL', true)
}

/** One page of one row: the cheapest read that exercises a listing's scope category (§4.1 scope verification). */
export async function giteaProbeListing(token: string, path: string, client: GiteaApiClient): Promise<void> {
  await giteaRequest<unknown[]>(`${path}?page=1&limit=1`, { token, client })
}

/** The instance's paging ceiling (`GET /settings/api`); the Gitea default when it cannot be read. */
export async function giteaPageSize(client: GiteaApiClient): Promise<number> {
  try {
    const settings = await giteaRequest<{ max_response_items?: unknown }>('/settings/api', { token: null, client })
    const items = settings?.max_response_items
    return typeof items === 'number' && Number.isInteger(items) && items > 0 ? items : GITEA_DEFAULT_PAGE_SIZE
  } catch {
    return GITEA_DEFAULT_PAGE_SIZE
  }
}

/** The instance's self-reported version (`GET /version`, §3) — answers without authentication. */
export async function giteaVersion(client: GiteaApiClient): Promise<string> {
  const body = await giteaRequest<{ version?: unknown }>('/version', { token: null, client })
  if (typeof body?.version !== 'string') {
    throw new GiteaApiError('gitea /version response carries no version', 0, 'INTERNAL', false)
  }
  return body.version
}

export interface GiteaUser {
  id: number
  login: string
  full_name?: string
}

function asUser(body: unknown, what: string): GiteaUser {
  const user = body as Partial<GiteaUser> | undefined
  if (typeof user?.id !== 'number' || typeof user.login !== 'string') {
    throw new GiteaApiError(`gitea ${what} response is not a user`, 0, 'INTERNAL', false)
  }
  return user as GiteaUser
}

/** The token's own user (`GET /user`) — the bot identity of §4.1; needs `read:user`. */
export async function giteaCurrentUser(token: string, client: GiteaApiClient): Promise<GiteaUser> {
  return asUser(await giteaRequest('/user', { token, client }), '/user')
}

/** One user by login (`GET /users/:username`); null on 404. The §8 username-to-id re-resolution. */
export async function giteaUser(token: string, username: string, client: GiteaApiClient): Promise<GiteaUser | null> {
  try {
    return asUser(await giteaRequest(`/users/${encodeURIComponent(username)}`, { token, client }), '/users')
  } catch (e) {
    if (e instanceof GiteaApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}

export interface GiteaRepository {
  id: number
  full_name: string
  name?: string
  owner?: { id?: number; login?: string }
  clone_url?: string
  html_url?: string
  default_branch?: string
  private?: boolean
  archived?: boolean
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean }
}

export interface GiteaOrganization {
  id: number
  name?: string
  username?: string
}

/** The login the organization's repositories are listed under. */
export function giteaOrganizationName(org: GiteaOrganization): string | null {
  return org.username ?? org.name ?? null
}

/** `GET /user/repos`, every page — the token's `read:repository` probe and half of the picker (§6). */
export async function giteaListUserRepositories(
  token: string,
  client: GiteaApiClient,
  pageSize: number
): Promise<GiteaRepository[]> {
  return giteaPagedGet<GiteaRepository>('/user/repos', { token, client, pageSize })
}

/** `GET /user/orgs`, every page — needs `read:user` AND `read:organization` together (§16). */
export async function giteaListUserOrganizations(
  token: string,
  client: GiteaApiClient,
  pageSize: number
): Promise<GiteaOrganization[]> {
  return giteaPagedGet<GiteaOrganization>('/user/orgs', { token, client, pageSize })
}

/** `GET /orgs/:org/repos`, every page — organization-scoped despite listing repositories (§16). */
export async function giteaListOrganizationRepositories(
  token: string,
  org: string,
  client: GiteaApiClient,
  pageSize: number
): Promise<GiteaRepository[]> {
  return giteaPagedGet<GiteaRepository>(`/orgs/${encodeURIComponent(org)}/repos`, { token, client, pageSize })
}

/** One repository by numeric id (`GET /repositories/:id`, rename-proof); null on a definitive 404. */
export async function giteaRepositoryById(
  token: string,
  repoId: bigint,
  client: GiteaApiClient
): Promise<GiteaRepository | null> {
  try {
    return await giteaRequest<GiteaRepository>(`/repositories/${repoId}`, { token, client })
  } catch (e) {
    if (e instanceof GiteaApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}

/** One repository by path, ANONYMOUSLY — resolves public repositories only; null when it is not one. */
export async function giteaPublicRepository(
  owner: string,
  repo: string,
  client: GiteaApiClient
): Promise<GiteaRepository | null> {
  try {
    return await giteaRequest<GiteaRepository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      token: null,
      client
    })
  } catch (e) {
    if (
      e instanceof GiteaApiError &&
      (e.code === 'NOT_FOUND' || e.code === 'AUTH_REJECTED' || e.code === 'FORBIDDEN')
    ) {
      return null
    }
    throw e
  }
}

/** The `owner/repo` halves of a repository path; null unless it has exactly two segments. */
export function splitGiteaRepoPath(path: string): { owner: string; repo: string } | null {
  const segments = path.split('/')
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null
  return { owner: segments[0], repo: segments[1] }
}

export type GiteaPermission = 'none' | 'read' | 'write' | 'admin' | 'owner'

export interface GiteaCollaboratorPermission {
  permission: GiteaPermission
  role_name?: string
  user?: { id?: number; login?: string }
}

/** Every answer of the permission lookup the collaborator gate accepts (§8). */
const ACCEPTED_PERMISSIONS: ReadonlySet<string> = new Set(['write', 'admin', 'owner'])

export function giteaPermissionAdmits(permission: string | undefined): boolean {
  return permission !== undefined && ACCEPTED_PERMISSIONS.has(permission)
}

/** `GET /repos/:owner/:repo/collaborators/:username/permission` — the live collaborator gate of §8.
 *  Needs the bot to hold `admin` on the repository (§4.4): a 403 here is `admin_lost`, not a denial. */
export async function giteaCollaboratorPermission(
  token: string,
  owner: string,
  repo: string,
  username: string,
  client: GiteaApiClient
): Promise<GiteaCollaboratorPermission> {
  const answer = await giteaRequest<GiteaCollaboratorPermission>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}/permission`,
    { token, client }
  )
  if (typeof answer?.permission !== 'string') {
    throw new GiteaApiError('gitea permission response carries no permission', 0, 'INTERNAL', false)
  }
  return answer
}

// ── the managed webhook (§7) ──────────────────────────────────────────────────

export interface GiteaWebhook {
  id: number
  type?: string
  active?: boolean
  events?: string[]
  config?: { url?: string; content_type?: string }
}

export interface GiteaWebhookSpec {
  url: string
  secret: string
  events: readonly string[]
}

function hookBody(spec: GiteaWebhookSpec) {
  // `active: true` is explicit because the API default is inactive (§7); no branch filter.
  return {
    type: 'gitea',
    config: { url: spec.url, content_type: 'json', secret: spec.secret },
    events: [...spec.events],
    active: true
  }
}

function hooksPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`
}

export async function giteaCreateWebhook(
  token: string,
  owner: string,
  repo: string,
  spec: GiteaWebhookSpec,
  client: GiteaApiClient
): Promise<GiteaWebhook> {
  return giteaRequest<GiteaWebhook>(hooksPath(owner, repo), { method: 'POST', token, body: hookBody(spec), client })
}

/** `PATCH` of the whole spec — the events, the URL and the signing secret together. */
export async function giteaUpdateWebhook(
  token: string,
  owner: string,
  repo: string,
  webhookId: bigint,
  spec: GiteaWebhookSpec,
  client: GiteaApiClient
): Promise<GiteaWebhook> {
  const { type: _type, ...patch } = hookBody(spec)
  return giteaRequest<GiteaWebhook>(`${hooksPath(owner, repo)}/${webhookId}`, {
    method: 'PATCH',
    token,
    body: patch,
    client
  })
}

/** `PATCH` of the signing secret alone — the rotation step of §7. */
export async function giteaUpdateWebhookSecret(
  token: string,
  owner: string,
  repo: string,
  webhookId: bigint,
  secret: string,
  client: GiteaApiClient
): Promise<GiteaWebhook> {
  return giteaRequest<GiteaWebhook>(`${hooksPath(owner, repo)}/${webhookId}`, {
    method: 'PATCH',
    token,
    body: { config: { secret } },
    client
  })
}

/** One webhook by id (`GET /hooks/:id`) — the read-back that catches silently dropped events (§7). */
export async function giteaWebhook(
  token: string,
  owner: string,
  repo: string,
  webhookId: bigint,
  client: GiteaApiClient
): Promise<GiteaWebhook | null> {
  try {
    return await giteaRequest<GiteaWebhook>(`${hooksPath(owner, repo)}/${webhookId}`, { token, client })
  } catch (e) {
    if (e instanceof GiteaApiError && e.code === 'NOT_FOUND') return null
    throw e
  }
}

/** ALL pages of the repository's webhooks — crash-left create reconciliation by exact URL. */
export async function giteaListWebhooks(
  token: string,
  owner: string,
  repo: string,
  client: GiteaApiClient,
  pageSize: number
): Promise<GiteaWebhook[]> {
  return giteaPagedGet<GiteaWebhook>(hooksPath(owner, repo), { token, client, pageSize })
}

export async function giteaDeleteWebhook(
  token: string,
  owner: string,
  repo: string,
  webhookId: bigint,
  client: GiteaApiClient
): Promise<void> {
  await giteaRequest<void>(`${hooksPath(owner, repo)}/${webhookId}`, { method: 'DELETE', token, client })
}

/** Fire one provider test delivery (`POST /hooks/:id/tests`, §6 step 4). */
export async function giteaTestWebhook(
  token: string,
  owner: string,
  repo: string,
  webhookId: bigint,
  client: GiteaApiClient
): Promise<void> {
  await giteaRequest<void>(`${hooksPath(owner, repo)}/${webhookId}/tests`, { method: 'POST', token, client })
}
