// The code-host repository seam (source-cache.md §5, gitlab-com-integration.md §8.1): `resolveRef` per provider.
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { CredPlane, GitCredentialCache } from '../cp/git-credential.js'
import { githubRepository } from '../github/repository.js'
import { gitlabRepository } from '../gitlab/repository.js'
import type { CodeHostSpecHosts, QualifiedCodeHostProvider } from './credentials.js'
import type { RepositoryRefSpec } from './ref-spec.js'

/** A credentialed repository as resolution addresses it: provider-qualified numeric id plus its current path. */
export interface CodeHostRepositoryRef {
  provider: CodeHostProvider
  /** The rename-stable decimal id, the anti-replacement identity. */
  externalId: string
  /** The canonical clone URL the Source names. */
  cloneUrl: string
  /** The repository path from the instance root as the spec names it (lower-cased), checked against the host's own. */
  path: string
}

export {
  concreteRef,
  normalizeSkillRef,
  parseResolvableRef,
  resolvableRefName,
  type RepositoryRefSpec
} from './ref-spec.js'

export type ResolveRefFailureReason = 'access_denied' | 'not_found' | 'replaced' | 'ref_not_found' | 'unavailable'

export type ResolveRefResult =
  | { ok: true; commit: string; checkedAt: number; ref?: string }
  | { ok: false; reason: ResolveRefFailureReason; detail: string; checkedAt: number }

/** Conditional-request state carried across refreshes; never served without a fresh 200 or 304. */
export interface RefValidators {
  identityEtag?: string
  /** The host's own path for the repository when `identityEtag` was issued. */
  identityPath?: string
  refEtag?: string
  commit?: string
  /** The default branch the identity read named, so a 304 still answers `HEAD`. */
  defaultBranch?: string
}

/** One provider's answer before core caching. */
export type ProviderAnswer =
  | { ok: true; commit: string; validators: RefValidators; ref?: string }
  | {
      ok: false
      reason: ResolveRefFailureReason
      detail: string
      /** The host rejected the token itself (401): core re-mints once. */
      tokenRejected?: boolean
      retryAfterMs?: number
    }

/** Which CP-minted credential a provider's resolution reads with. */
export interface RepositoryTokenAsk {
  plane: CredPlane
  provider?: QualifiedCodeHostProvider
  externalRepoId?: string
  requestedAccess?: 'read'
  /** A token scoped to this one repository (`owner/repo`) rather than the workspace's. */
  repoFullName?: string
}

export interface RepositoryReadToken {
  token: string
  /** The numeric identity the CP echoed on the grant, when it named one. */
  externalRepoId?: string
}

/** The agent's scoped read credentials; only CP-minted tokens, never a spawned Git helper. */
export interface RepositoryReadTokens {
  get(agentId: string, ask: RepositoryTokenAsk): Promise<RepositoryReadToken>
  invalidate(agentId: string, ask: RepositoryTokenAsk, token: string): void
}

/** The daemon's GitCredentialCache as resolution's token source. */
export function gitCredReadTokens(cache: Pick<GitCredentialCache, 'get' | 'invalidate'>): RepositoryReadTokens {
  return {
    async get(agentId, ask) {
      const entry = await cache.get(agentId, 'fetch', {
        plane: ask.plane,
        ...(ask.provider !== undefined ? { provider: ask.provider } : {}),
        ...(ask.repoFullName !== undefined ? { repo: ask.repoFullName } : {}),
        ...(ask.externalRepoId !== undefined ? { externalRepoId: ask.externalRepoId } : {}),
        ...(ask.requestedAccess !== undefined ? { requestedAccess: ask.requestedAccess } : {})
      })
      return {
        token: entry.token,
        ...(entry.externalRepoId !== undefined ? { externalRepoId: entry.externalRepoId } : {})
      }
    },
    invalidate(agentId, ask, token) {
      cache.invalidate(agentId, token, {
        plane: ask.plane,
        ...(ask.provider !== undefined ? { provider: ask.provider } : {}),
        ...(ask.repoFullName !== undefined ? { repo: ask.repoFullName } : {})
      })
    }
  }
}

export interface ProviderResolveInput {
  apiBaseUrl: string
  repository: CodeHostRepositoryRef
  ref: RepositoryRefSpec
  token: string
  prior?: RefValidators
}

export interface ProviderResolveContext {
  fetch: typeof globalThis.fetch
  signal: AbortSignal
  now?: () => number
}

/** One code host's resolution behavior behind the seam. */
export interface CodeHostRepositoryModule {
  readonly provider: CodeHostProvider
  /** The REST root resolution talks to for one spec; the instance comes off the spec per call (§24.4). */
  apiBaseUrl(spec: CodeHostSpecHosts): string
  /** The CP-minted read credential this host resolves with; `repoFullName` asks for a repository-scoped one. */
  readTokenAsk(repository: { externalId?: string; repoFullName?: string }): RepositoryTokenAsk
  /** Identity by numeric id, then ref to commit; never throws. */
  resolve(input: ProviderResolveInput, ctx: ProviderResolveContext): Promise<ProviderAnswer>
}

/** Adding a host is one entry; a missing key is a compile error, `undefined` means no resolution on that host. */
const MODULES: { readonly [P in CodeHostProvider]: CodeHostRepositoryModule | undefined } = {
  github: githubRepository,
  gitlab: gitlabRepository,
  gitea: undefined
}

/** The resolution module owning one provider, or undefined when that host has none. */
export function codeHostRepository(provider: CodeHostProvider): CodeHostRepositoryModule | undefined {
  return MODULES[provider]
}
