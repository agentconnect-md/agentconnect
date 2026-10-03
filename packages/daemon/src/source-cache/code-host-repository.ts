/**
 * The Source Cache's trusted code-host resolution seam (`source-cache.md` §5).
 *
 * A resolved ref is a security decision: for a credentialed Source it is the proof that the
 * reading agent may read that Source's `cred` cache entries. The resolver therefore never asks
 * for a credential on an anonymous Source, verifies a GitLab project by its numeric id before
 * reading a commit, and returns an opaque authorization that the cache read path can require
 * before issuing a `cred` GET.
 */
import { parseCodeHostJson } from '../codehost/json.js'

export const SOURCE_CACHE_RESOLUTION_TTL_MS = 60_000

const DEFAULT_TIMEOUT_MS = 10_000
const GITHUB_API_BASE = 'https://api.github.com'
const GITLAB_API_BASE = 'https://gitlab.com/api/v4'
const GITHUB_API_VERSION = '2022-11-28'
const COMMIT_SHA = /^[a-f0-9]{40}$/i
const DECIMAL_ID = /^[1-9]\d{0,19}$/
const SAFE_REF = /^[^\0\r\n]{1,256}$/
const GITHUB_COMPONENT = /^[A-Za-z0-9_.-]+$/
const MAX_RESPONSE_BYTES = 128 * 1024
const MAX_CREDENTIAL_BYTES = 16 * 1024

export type SupportedCodeHostProvider = 'github' | 'gitlab'
export type SourceAccessClass = 'anon' | 'cred'

export type SourceCredential = { provider: 'github'; repoId?: string } | { provider: 'gitlab'; projectId: string }

/** The provider-qualified catalog identity a Source resolution must be anchored to. */
export interface CodeHostRepositoryRef {
  provider: SupportedCodeHostProvider
  externalId: string
  /** Current provider display path. It is a mutable hint, never the anti-replacement identity. */
  path?: string
}

export interface Source {
  /** Canonical, credential-free clone URL. */
  cloneUrl: string
  /** Branch, tag, or commit; absent means the host's default/HEAD. */
  ref?: string
  /** Absent means anonymous. A credential is never inferred from a URL. */
  credential?: SourceCredential
  /** The CodeHostRepository reference. Required for a daemon-side resolution. */
  codeHostRepository?: CodeHostRepositoryRef
}

export interface ResolveRefOptions {
  agentId: string
  signal?: AbortSignal
}

export interface ResolvedRef {
  readonly commit: string
  readonly ref: string
  readonly accessClass: SourceAccessClass
  readonly agentId: string
  readonly repository: Readonly<CodeHostRepositoryRef>
}

export interface CodeHostCredentialRequest {
  agentId: string
  provider: SupportedCodeHostProvider
  repository: Readonly<CodeHostRepositoryRef>
  cloneUrl: string
  signal: AbortSignal
}

export type CodeHostCredentialValue = string | { token: string } | { password: string }
export type CodeHostCredentialProvider = (request: CodeHostCredentialRequest) => Promise<CodeHostCredentialValue>

export interface CodeHostRepositoryOptions {
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  /** GitHub's REST root. Overridden only by tests. */
  githubApiBaseUrl?: string
  /** GitLab's `/api/v4` root from trusted deployment configuration, never from a URL the user typed. */
  gitlabApiBaseUrl?: string | ((source: Source) => string)
  /** Called only when `source.credential` is present. */
  credentialProvider?: CodeHostCredentialProvider
}

export class CodeHostResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CodeHostResolutionError'
  }
}

interface NormalizedSource {
  cloneUrl: string
  ref: string
  credentialed: boolean
  repository: CodeHostRepositoryRef
  apiBaseFingerprint: string
  github?: { owner: string; repo: string; path: string }
  gitlab?: { apiBase: URL; projectPath: string }
}

interface CachedResolution {
  resolution: ResolvedRef
  resolvedAt: number
  etag?: string
}

interface ResolutionResult {
  resolution: ResolvedRef
  etag?: string
}

interface CredentialAuthorization {
  key: string
  resolvedAt: number
}

interface LinkedSignal {
  signal: AbortSignal
  cleanup: () => void
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): LinkedSignal {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason)
    else parent.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('code-host resolution timed out')), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    }
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function decimalId(value: unknown): string | undefined {
  if (typeof value === 'string' && DECIMAL_ID.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

function commitSha(value: unknown): string | undefined {
  return typeof value === 'string' && COMMIT_SHA.test(value) ? value.toLowerCase() : undefined
}

function safeRef(value: string | undefined): string {
  const ref = value ?? 'HEAD'
  if (!SAFE_REF.test(ref) || ref.trim() !== ref) throw new CodeHostResolutionError('Source ref is invalid')
  return ref
}

function safeAgentId(value: string): string {
  if (typeof value !== 'string') throw new CodeHostResolutionError('Source resolution requires an agent id')
  const agentId = value.trim()
  if (!agentId || agentId.length > 256 || /[\0\r\n]/.test(agentId)) {
    throw new CodeHostResolutionError('Source resolution requires a valid agent id')
  }
  return agentId
}

function cleanRepositoryPath(value: string, label: string): string {
  const trimmed = value.trim()
  const withoutSuffix = trimmed.replace(/\.git$/i, '')
  const normalized = withoutSuffix.replace(/^\/+|\/+$/g, '')
  const parts = normalized.split('/')
  if (
    !normalized ||
    parts.some(
      (part) => !part || part === '.' || part === '..' || part.includes('\\') || /[\u0000-\u001f\u007f]/.test(part)
    )
  ) {
    throw new CodeHostResolutionError(`${label} path is invalid`)
  }
  return parts.join('/')
}

function githubPathFromCloneUrl(cloneUrl: URL): string {
  const parts = cloneUrl.pathname.split('/')
  if (parts.length !== 3 || parts[0] !== '') {
    throw new CodeHostResolutionError('GitHub Source must identify exactly owner/repository')
  }
  let owner: string
  let repo: string
  try {
    owner = decodeURIComponent(parts[1]!)
    repo = decodeURIComponent(parts[2]!).replace(/\.git$/i, '')
  } catch {
    throw new CodeHostResolutionError('GitHub Source contains malformed URL encoding')
  }
  if (!GITHUB_COMPONENT.test(owner) || !GITHUB_COMPONENT.test(repo)) {
    throw new CodeHostResolutionError('GitHub Source contains an invalid owner or repository')
  }
  return `${owner}/${repo}`
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function validateApiBase(raw: string, label: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CodeHostResolutionError(`${label} API base URL is invalid`)
  }
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CodeHostResolutionError(`${label} API base URL must use HTTPS`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url
}

function parseCloneUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CodeHostResolutionError('Source clone URL is invalid')
  }
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CodeHostResolutionError('Source clone URL must be a credential-free HTTPS URL')
  }
  return url
}

function gitlabProjectPathFromCloneUrl(cloneUrl: URL, apiBase: URL): string {
  const apiSuffix = '/api/v4'
  if (!apiBase.pathname.endsWith(apiSuffix)) {
    throw new CodeHostResolutionError('GitLab API base URL must end in /api/v4')
  }
  const instancePrefix = apiBase.pathname.slice(0, -apiSuffix.length).replace(/\/+$/, '')
  let pathname = cloneUrl.pathname
  if (instancePrefix) {
    if (pathname === instancePrefix || !pathname.startsWith(`${instancePrefix}/`)) {
      throw new CodeHostResolutionError('GitLab clone URL is outside its configured instance path')
    }
    pathname = pathname.slice(instancePrefix.length)
  }
  const parts = pathname.split('/')
  if (parts[0] === '') parts.shift()
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new CodeHostResolutionError('GitLab clone URL must identify a project path')
  }
  let decoded: string[]
  try {
    decoded = parts.map((part) => decodeURIComponent(part))
  } catch {
    throw new CodeHostResolutionError('GitLab clone URL contains malformed URL encoding')
  }
  if (decoded.some((part) => !part || part.includes('/') || /[\u0000-\u001f\u007f]/.test(part))) {
    throw new CodeHostResolutionError('GitLab clone URL contains an invalid project path')
  }
  const last = decoded.at(-1)!.replace(/\.git$/i, '')
  return [...decoded.slice(0, -1), last].join('/')
}

function repositoryFromSource(source: Source): CodeHostRepositoryRef | undefined {
  const explicit = source.codeHostRepository
  if (explicit) {
    if (explicit.provider !== 'github' && explicit.provider !== 'gitlab') {
      throw new CodeHostResolutionError('Source resolution supports only GitHub and GitLab')
    }
    if (!DECIMAL_ID.test(explicit.externalId)) {
      throw new CodeHostResolutionError('CodeHostRepository external id is invalid')
    }
    return {
      provider: explicit.provider,
      externalId: explicit.externalId,
      ...(explicit.path !== undefined ? { path: explicit.path } : {})
    }
  }
  const credential = source.credential
  if (credential?.provider === 'gitlab') {
    if (!DECIMAL_ID.test(credential.projectId)) {
      throw new CodeHostResolutionError('GitLab Source project id is invalid')
    }
    return { provider: 'gitlab', externalId: credential.projectId }
  }
  if (credential?.provider === 'github' && credential.repoId !== undefined) {
    if (!DECIMAL_ID.test(credential.repoId)) {
      throw new CodeHostResolutionError('GitHub Source repository id is invalid')
    }
    return { provider: 'github', externalId: credential.repoId }
  }
  return undefined
}

function credentialMatchesRepository(source: Source, repository: CodeHostRepositoryRef): boolean {
  const credential = source.credential
  if (!credential) return true
  if (credential.provider !== repository.provider) return false
  if (credential.provider === 'gitlab') return credential.projectId === repository.externalId
  return credential.repoId === undefined || credential.repoId === repository.externalId
}

function credentialToken(value: CodeHostCredentialValue): string {
  const token = typeof value === 'string' ? value : 'token' in value ? value.token : value.password
  if (typeof token !== 'string' || !token || token.length > MAX_CREDENTIAL_BYTES || /[\0\r\n]/.test(token)) {
    throw new CodeHostResolutionError('code host credential provider returned an invalid token')
  }
  return token
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function readBoundedText(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  label: string
): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await discardResponse(response)
    throw new CodeHostResolutionError(`${label} exceeded the byte limit`)
  }
  if (!response.body) throw new CodeHostResolutionError(`${label} returned no body`)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw new CodeHostResolutionError(`${label} request was aborted`)
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new CodeHostResolutionError(`${label} exceeded the byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  ).toString('utf8')
}

function endpointUrl(base: URL, path: string): URL {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`
  return url
}

function githubHeaders(accept: string, token?: string): Record<string, string> {
  return {
    accept,
    'accept-encoding': 'identity',
    'user-agent': 'agentconnect-daemon',
    'x-github-api-version': GITHUB_API_VERSION,
    ...(token ? { authorization: `Bearer ${token}` } : {})
  }
}

function gitlabHeaders(token?: string): Record<string, string> {
  return {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'agentconnect-daemon',
    ...(token ? { 'private-token': token } : {})
  }
}

export class CodeHostRepository {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly githubApiBase: URL
  private readonly gitlabApiBase?: string | ((source: Source) => string)
  private readonly credentialProvider?: CodeHostCredentialProvider
  private readonly cache = new Map<string, CachedResolution>()
  private readonly inFlight = new Map<string, Promise<ResolvedRef>>()
  private readonly credentialAuthorizations = new WeakMap<object, CredentialAuthorization>()

  constructor(options: CodeHostRepositoryOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? SOURCE_CACHE_RESOLUTION_TTL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new CodeHostResolutionError('Source resolution TTL must be a positive integer')
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new CodeHostResolutionError('Source resolution timeout must be a positive integer')
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.githubApiBase = validateApiBase(options.githubApiBaseUrl ?? GITHUB_API_BASE, 'GitHub')
    this.gitlabApiBase = options.gitlabApiBaseUrl
    this.credentialProvider = options.credentialProvider
  }

  async resolveRef(source: Source, opts: ResolveRefOptions): Promise<ResolvedRef> {
    const agentId = safeAgentId(opts.agentId)
    const normalized = this.normalizeSource(source)
    const key = this.cacheKey(agentId, normalized)
    const now = this.now()
    const cached = this.cache.get(key)
    this.pruneExpired(now)
    if (cached && now - cached.resolvedAt < this.ttlMs) return cached.resolution
    const previous = cached
    this.cache.delete(key)

    const existing = this.inFlight.get(key)
    if (existing) return existing

    const pending = this.resolveUncached(agentId, normalized, opts.signal, previous)
      .then(({ resolution, etag }) => {
        const resolvedAt = this.now()
        this.cache.set(key, { resolution, resolvedAt, ...(etag ? { etag } : {}) })
        this.credentialAuthorizations.set(resolution, { key, resolvedAt })
        return resolution
      })
      .finally(() => {
        this.inFlight.delete(key)
      })
    this.inFlight.set(key, pending)
    return pending
  }

  /**
   * Gate a `cred` cache read on a successful credentialed resolution for the same agent, Source,
   * and ref, no more than the resolution TTL ago. A forged object, an anonymous resolution, a
   * mismatched Source, and an expired resolution all fail before `read` is called.
   */
  async authorizeCredRead<T>(
    resolution: ResolvedRef | undefined,
    source: Source,
    agentId: string,
    read: () => Promise<T>
  ): Promise<T> {
    const id = safeAgentId(agentId)
    const normalized = this.normalizeSource(source)
    const expectedKey = this.cacheKey(id, normalized)
    const authorization = resolution ? this.credentialAuthorizations.get(resolution) : undefined
    if (
      !resolution ||
      !authorization ||
      resolution.accessClass !== 'cred' ||
      authorization.key !== expectedKey ||
      this.now() - authorization.resolvedAt >= this.ttlMs
    ) {
      throw new CodeHostResolutionError(
        'cred cache read requires a successful credentialed resolveRef for the same agent, Source, and ref'
      )
    }
    return await read()
  }

  private normalizeSource(source: Source): NormalizedSource {
    const repository = repositoryFromSource(source)
    if (!repository) {
      throw new CodeHostResolutionError('Source resolution requires a CodeHostRepository reference')
    }
    if (!credentialMatchesRepository(source, repository)) {
      throw new CodeHostResolutionError('Source credential does not match its CodeHostRepository')
    }
    const cloneUrl = parseCloneUrl(source.cloneUrl)
    const ref = safeRef(source.ref)

    if (repository.provider === 'github') {
      if (cloneUrl.hostname.toLowerCase() !== 'github.com' || cloneUrl.port) {
        throw new CodeHostResolutionError('GitHub Source must use github.com')
      }
      const path = githubPathFromCloneUrl(cloneUrl)
      const declared = repository.path === undefined ? path : cleanRepositoryPath(repository.path, 'GitHub')
      if (declared.toLowerCase() !== path.toLowerCase()) {
        throw new CodeHostResolutionError('GitHub Source path does not match its CodeHostRepository')
      }
      const [owner, repo] = path.split('/') as [string, string]
      return {
        cloneUrl: `https://github.com/${path}`,
        ref,
        credentialed: source.credential !== undefined,
        repository: { ...repository, path },
        apiBaseFingerprint: this.githubApiBase.href,
        github: { owner, repo, path }
      }
    }

    const configured = typeof this.gitlabApiBase === 'function' ? this.gitlabApiBase(source) : this.gitlabApiBase
    const rawApiBase = configured ?? (cloneUrl.hostname.toLowerCase() === 'gitlab.com' ? GITLAB_API_BASE : undefined)
    if (!rawApiBase) throw new CodeHostResolutionError('GitLab Source has no configured API base')
    const apiBase = validateApiBase(rawApiBase, 'GitLab')
    if (cloneUrl.origin !== apiBase.origin) {
      throw new CodeHostResolutionError('GitLab Source clone URL does not match its API instance')
    }
    const projectPath = gitlabProjectPathFromCloneUrl(cloneUrl, apiBase)
    const declared = repository.path === undefined ? projectPath : cleanRepositoryPath(repository.path, 'GitLab')
    if (declared.toLowerCase() !== projectPath.toLowerCase()) {
      throw new CodeHostResolutionError('GitLab Source path does not match its CodeHostRepository')
    }
    return {
      cloneUrl: cloneUrl.toString(),
      ref,
      credentialed: source.credential !== undefined,
      repository: { ...repository, path: projectPath },
      apiBaseFingerprint: apiBase.href,
      gitlab: { apiBase, projectPath }
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (now - entry.resolvedAt >= this.ttlMs) this.cache.delete(key)
    }
  }

  private cacheKey(agentId: string, source: NormalizedSource): string {
    const repository = source.repository
    return [
      agentId,
      source.credentialed ? 'cred' : 'anon',
      repository.provider,
      repository.externalId,
      repository.path ?? '',
      source.cloneUrl,
      source.apiBaseFingerprint,
      source.ref
    ].join('\0')
  }

  private async resolveUncached(
    agentId: string,
    source: NormalizedSource,
    parentSignal: AbortSignal | undefined,
    previous?: CachedResolution
  ): Promise<ResolutionResult> {
    const linked = linkedSignal(parentSignal, this.timeoutMs)
    try {
      const token = await this.readCredential(agentId, source, linked.signal)
      const answer =
        source.repository.provider === 'github'
          ? await this.resolveGithub(source, token, linked.signal, previous)
          : { commit: await this.resolveGitlab(source, token, linked.signal) }
      const resolution = Object.freeze({
        commit: answer.commit,
        ref: source.ref,
        accessClass: source.credentialed ? ('cred' as const) : ('anon' as const),
        agentId,
        repository: Object.freeze({ ...source.repository })
      })
      return { resolution, ...(answer.etag ? { etag: answer.etag } : {}) }
    } finally {
      linked.cleanup()
    }
  }

  private async readCredential(
    agentId: string,
    source: NormalizedSource,
    signal: AbortSignal
  ): Promise<string | undefined> {
    if (!source.credentialed) return undefined
    if (!this.credentialProvider) {
      throw new CodeHostResolutionError('code host credentials are unavailable')
    }
    let value: CodeHostCredentialValue
    try {
      value = await this.credentialProvider({
        agentId,
        provider: source.repository.provider,
        repository: Object.freeze({ ...source.repository }),
        cloneUrl: source.cloneUrl,
        signal
      })
    } catch (error) {
      throw new CodeHostResolutionError('code host credentials are unavailable', { cause: error })
    }
    return credentialToken(value)
  }

  private async fetchChecked(
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
    label: string,
    options: { allowNotModified?: boolean } = {}
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal })
    } catch (error) {
      throw new CodeHostResolutionError(`${label} request failed`, { cause: error })
    }
    if (response.status !== 200 && !(options.allowNotModified === true && response.status === 304)) {
      const status = response.status
      await discardResponse(response)
      throw new CodeHostResolutionError(`${label} failed with status ${status}`)
    }
    return response
  }

  private async verifyGithubIdentity(
    source: NormalizedSource,
    token: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const github = source.github!
    const response = await this.fetchChecked(
      endpointUrl(this.githubApiBase, `/repositories/${source.repository.externalId}`),
      githubHeaders('application/vnd.github+json', token),
      signal,
      'GitHub repository identity lookup'
    )
    const raw = await readBoundedText(response, signal, MAX_RESPONSE_BYTES, 'GitHub repository identity lookup')
    const record = recordOf(parseCodeHostJson(raw))
    if (
      !record ||
      decimalId(record.id) !== source.repository.externalId ||
      typeof record.full_name !== 'string' ||
      record.full_name.toLowerCase() !== github.path.toLowerCase()
    ) {
      throw new CodeHostResolutionError('GitHub repository identity does not match the configured Source')
    }
  }

  private async resolveGithub(
    source: NormalizedSource,
    token: string | undefined,
    signal: AbortSignal,
    previous?: CachedResolution
  ): Promise<{ commit: string; etag?: string }> {
    const github = source.github!
    await this.verifyGithubIdentity(source, token, signal)
    if (COMMIT_SHA.test(source.ref)) return { commit: source.ref.toLowerCase() }

    const response = await this.fetchChecked(
      endpointUrl(
        this.githubApiBase,
        `/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repo)}/commits/${encodeURIComponent(source.ref)}`
      ),
      {
        ...githubHeaders('application/vnd.github.sha', token),
        ...(previous?.etag ? { 'if-none-match': previous.etag } : {})
      },
      signal,
      'GitHub commit resolution',
      { allowNotModified: true }
    )
    if (response.status === 304) {
      await discardResponse(response)
      if (!previous) throw new CodeHostResolutionError('GitHub commit resolution returned 304 without a cached result')
      // A rename or delete between the two calls must not let the name-based request escape the
      // numeric identity fence, even when the conditional answer is 304.
      await this.verifyGithubIdentity(source, token, signal)
      return { commit: previous.resolution.commit, ...(previous.etag ? { etag: previous.etag } : {}) }
    }

    const raw = await readBoundedText(response, signal, 1_024, 'GitHub commit resolution')
    const direct = raw.trim()
    const commit = COMMIT_SHA.test(direct) ? direct.toLowerCase() : commitSha(recordOf(parseCodeHostJson(direct))?.sha)
    if (!commit) throw new CodeHostResolutionError('GitHub commit resolution returned an invalid SHA')

    // A rename or delete between the two calls must not let the name-based commit lookup escape
    // the numeric identity fence.
    await this.verifyGithubIdentity(source, token, signal)
    return { commit, ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) }
  }

  private async verifyGitlabProject(
    source: NormalizedSource,
    token: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const response = await this.fetchChecked(
      endpointUrl(source.gitlab!.apiBase, `/projects/${source.repository.externalId}`),
      gitlabHeaders(token),
      signal,
      'GitLab project identity lookup'
    )
    const raw = await readBoundedText(response, signal, MAX_RESPONSE_BYTES, 'GitLab project identity lookup')
    const record = recordOf(parseCodeHostJson(raw))
    if (
      !record ||
      decimalId(record.id) !== source.repository.externalId ||
      typeof record.path_with_namespace !== 'string' ||
      record.path_with_namespace.toLowerCase() !== source.gitlab!.projectPath.toLowerCase()
    ) {
      throw new CodeHostResolutionError('GitLab project identity does not match the configured Source')
    }
  }

  private async resolveGitlab(
    source: NormalizedSource,
    token: string | undefined,
    signal: AbortSignal
  ): Promise<string> {
    await this.verifyGitlabProject(source, token, signal)
    if (COMMIT_SHA.test(source.ref)) return source.ref.toLowerCase()
    const response = await this.fetchChecked(
      endpointUrl(
        source.gitlab!.apiBase,
        `/projects/${source.repository.externalId}/repository/commits/${encodeURIComponent(source.ref)}`
      ),
      gitlabHeaders(token),
      signal,
      'GitLab commit resolution'
    )
    const raw = await readBoundedText(response, signal, MAX_RESPONSE_BYTES, 'GitLab commit resolution')
    const record = recordOf(parseCodeHostJson(raw))
    const commit = commitSha(record?.id)
    if (!commit) throw new CodeHostResolutionError('GitLab commit resolution returned an invalid SHA')
    if (record?.project_id !== undefined && decimalId(record.project_id) !== source.repository.externalId) {
      throw new CodeHostResolutionError('GitLab commit belongs to a different project')
    }
    return commit
  }
}
