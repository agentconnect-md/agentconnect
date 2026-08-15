/**
 * Unauthenticated GitHub repository lookup — the binding fallback for skill
 * sources (docs/designs/shared-skills.md §4).
 *
 * A skill source needs its NUMERIC repo id to project onto an AgentSpec, but the
 * installation-token path (`GithubService.repoRefFor`) only covers repos an org
 * GitHub App installation can see. Skill sources are public by contract, and the
 * commonest source of all — a skills.sh registry hit like `anthropics/skills` —
 * belongs to no installation. This read closes that gap with the same anonymous
 * endpoint the daemon already uses to verify identity before acquisition.
 *
 * No credential is involved and nothing is persisted: `/repos/{owner}/{repo}` on
 * a public repo is exactly what an unauthenticated `git clone` could learn.
 */
import { githubRequest, GithubApiError } from './api.js'
import type { FetchLike } from './api.js'

/** What binding needs: rename-proof identity, the public-only guard, and the
 *  default branch a `subDir` source must pin its ref to. */
export interface PublicRepoRef {
  repoId: bigint
  fullName: string
  private: boolean
  defaultBranch: string
}

/** `not-found` is a definitive answer (no such public repo) and must fail the
 *  write; `unreachable` (rate limit, outage, timeout) is NOT — the caller
 *  reports it as retryable rather than persisting a row it could not bind. */
export type PublicRepoLookup = PublicRepoRef | 'not-found' | 'unreachable'

export type PublicRepoResolver = (owner: string, repo: string) => Promise<PublicRepoLookup>

export function createPublicRepoResolver(opts: { fetchImpl?: FetchLike; baseUrl?: string } = {}): PublicRepoResolver {
  return async (owner, repo) => {
    try {
      const meta = await githubRequest<{ id: number; full_name: string; private: boolean; default_branch: string }>(
        `/repos/${owner}/${repo}`,
        {
          auth: null,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {})
        }
      )
      return {
        repoId: BigInt(meta.id),
        fullName: meta.full_name,
        private: meta.private,
        defaultBranch: meta.default_branch
      }
    } catch (e) {
      // Anonymous reads see 404 for both "gone" and "private" — either way the repo
      // is not a public source this release can install, so both are definitive.
      if (e instanceof GithubApiError && e.status === 404) return 'not-found'
      return 'unreachable'
    }
  }
}
