// Provider-neutral source resolution (source-cache.md §5): per-agent result cache, single flight, failure backoff.
import { CodeHostExternalId } from '@agentconnect.md/protocol'
import { GitCredUnavailableError } from '../cp/git-credential.js'
import type { CodeHostSpecHosts } from './credentials.js'
import {
  codeHostRepository,
  parseResolvableRef,
  type CodeHostRepositoryModule,
  type CodeHostRepositoryRef,
  type ProviderAnswer,
  type RefValidators,
  type RepositoryReadTokens,
  type RepositoryTokenAsk,
  type ResolveRefFailureReason,
  type ResolveRefResult
} from './repository.js'
import { MAX_RETRY_AFTER_MS } from './rest-read.js'

export interface ResolveRefRequest {
  agentId: string
  repository: CodeHostRepositoryRef
  /** `refs/heads/<b>` or a 40-hex commit. */
  ref: string
  /** The spec's host fields, so the instance is a per-call data dependency (§24.4). */
  hosts: CodeHostSpecHosts
}

export interface CodeHostRefResolverOptions {
  tokens: RepositoryReadTokens
  modules?: (provider: CodeHostRepositoryRef['provider']) => CodeHostRepositoryModule | undefined
  fetch?: typeof globalThis.fetch
  now?: () => number
  ttlMs?: number
  failureBaseMs?: number
  failureMaxMs?: number
  timeoutMs?: number
  maxEntries?: number
  log?: { warn(message: string): void }
}

interface CachedResolution {
  result: ResolveRefResult
  /** Wall-clock ms after which `result` is never served again. */
  expiresAt: number
  validators?: RefValidators
  failures: number
}

type Failure = Extract<ResolveRefResult, { ok: false }>

/** A token-source error as a resolution failure: a CP refusal is access_denied, anything else unavailable. */
export function tokenFailureOf(error: unknown): { reason: ResolveRefFailureReason; detail: string } {
  if (error instanceof GitCredUnavailableError && error.denied !== undefined) {
    return { reason: 'access_denied', detail: `credential_denied_${error.denied}` }
  }
  return { reason: 'unavailable', detail: 'credential_unavailable' }
}

export class CodeHostRefResolver {
  private readonly cache = new Map<string, CachedResolution>()
  private readonly inFlight = new Map<string, Promise<ResolveRefResult>>()
  /** Bumped by forgetAgent so a refresh already in flight never writes back. */
  private readonly epochs = new Map<string, number>()
  private readonly modules: NonNullable<CodeHostRefResolverOptions['modules']>
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly failureBaseMs: number
  private readonly failureMaxMs: number
  private readonly timeoutMs: number
  private readonly maxEntries: number

  constructor(private readonly opts: CodeHostRefResolverOptions) {
    this.modules = opts.modules ?? codeHostRepository
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? 60_000
    this.failureBaseMs = opts.failureBaseMs ?? 5_000
    this.failureMaxMs = opts.failureMaxMs ?? 60_000
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.maxEntries = opts.maxEntries ?? 4096
  }

  /** The commit `ref` names for this agent, with this agent's own access; a success is the cred-read authorization. */
  async resolveRef(request: ResolveRefRequest): Promise<ResolveRefResult> {
    const module = this.modules(request.repository.provider)
    if (!module) return this.uncached('unavailable', 'unsupported_provider')
    const ref = parseResolvableRef(request.ref)
    if (!ref) return this.uncached('unavailable', 'invalid_ref')
    if (!CodeHostExternalId.safeParse(request.repository.externalId).success) {
      return this.uncached('unavailable', 'invalid_repository')
    }
    const apiBaseUrl = module.apiBaseUrl(request.hosts)
    // Always agent-scoped (§5), keyed on the normalized ref so a SHA's case never splits an entry.
    const key = [
      request.agentId,
      request.repository.provider,
      apiBaseUrl,
      request.repository.externalId,
      ref.kind === 'commit' ? ref.sha : `refs/heads/${ref.name}`
    ].join('\u0000')
    const cached = this.cache.get(key)
    if (cached && this.now() < cached.expiresAt) {
      this.touch(key, cached)
      return cached.result
    }
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const pending = this.refresh(key, module, apiBaseUrl, request, ref, cached).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, pending)
    return pending
  }

  /** Drop every cached answer for one agent (agent removal or a credential change). */
  forgetAgent(agentId: string): void {
    this.epochs.set(agentId, (this.epochs.get(agentId) ?? 0) + 1)
    const prefix = `${agentId}\u0000`
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key)
  }

  private uncached(reason: ResolveRefFailureReason, detail: string): Failure {
    return { ok: false, reason, detail, checkedAt: this.now() }
  }

  private touch(key: string, entry: CachedResolution): void {
    this.cache.delete(key)
    this.cache.set(key, entry)
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private async refresh(
    key: string,
    module: CodeHostRepositoryModule,
    apiBaseUrl: string,
    request: ResolveRefRequest,
    ref: NonNullable<ReturnType<typeof parseResolvableRef>>,
    cached: CachedResolution | undefined
  ): Promise<ResolveRefResult> {
    const epoch = this.epochs.get(request.agentId) ?? 0
    const answer = await this.ask(module, apiBaseUrl, request, ref, cached?.validators)
    const checkedAt = this.now()
    let entry: CachedResolution
    if (answer.ok) {
      entry = {
        result: { ok: true, commit: answer.commit, checkedAt },
        expiresAt: checkedAt + this.ttlMs,
        validators: answer.validators,
        failures: 0
      }
    } else {
      // A failure replaces any cached success at once: a revoked grant must stop serving now.
      const failures = (cached?.failures ?? 0) + 1
      const backoff = Math.min(this.failureMaxMs, this.failureBaseMs * 2 ** (failures - 1))
      // Core caps again because a provider module may compute its own retryAfterMs.
      const wait = Math.max(backoff, Math.min(answer.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS))
      entry = {
        result: { ok: false, reason: answer.reason, detail: answer.detail, checkedAt },
        expiresAt: checkedAt + wait,
        ...(cached?.validators ? { validators: cached.validators } : {}),
        failures
      }
      this.opts.log?.warn(
        `source resolution failed agent=${request.agentId} provider=${request.repository.provider} repo=${request.repository.externalId} reason=${answer.reason} detail=${answer.detail}`
      )
    }
    if ((this.epochs.get(request.agentId) ?? 0) === epoch) this.touch(key, entry)
    return entry.result
  }

  private async ask(
    module: CodeHostRepositoryModule,
    apiBaseUrl: string,
    request: ResolveRefRequest,
    ref: NonNullable<ReturnType<typeof parseResolvableRef>>,
    prior: RefValidators | undefined
  ): Promise<ProviderAnswer> {
    const tokenAsk: RepositoryTokenAsk = module.readTokenAsk({ externalId: request.repository.externalId })
    for (let attempt = 0; ; attempt += 1) {
      let token: string
      try {
        token = (await this.opts.tokens.get(request.agentId, tokenAsk)).token
      } catch (error) {
        return { ok: false, ...tokenFailureOf(error) }
      }
      const answer = await this.attempt(module, { apiBaseUrl, repository: request.repository, ref, token, prior })
      if (answer.ok || !answer.tokenRejected) return answer
      // The host refused the token itself: drop it and re-mint once; a second refusal is final.
      this.opts.tokens.invalidate(request.agentId, tokenAsk, token)
      if (attempt >= 1) return { ok: false, reason: 'access_denied', detail: answer.detail }
    }
  }

  private async attempt(
    module: CodeHostRepositoryModule,
    input: Parameters<CodeHostRepositoryModule['resolve']>[0]
  ): Promise<ProviderAnswer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const answer = await module.resolve(input, { fetch: this.fetchImpl, signal: controller.signal, now: this.now })
      if (!answer.ok && controller.signal.aborted) return { ok: false, reason: 'unavailable', detail: 'timeout' }
      return answer
    } catch {
      return { ok: false, reason: 'unavailable', detail: controller.signal.aborted ? 'timeout' : 'provider_error' }
    } finally {
      clearTimeout(timer)
    }
  }
}
