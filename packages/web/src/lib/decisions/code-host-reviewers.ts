'use client'

// Which visible agents watch a repository's pull requests: the only agents its reviewer Decision can pick.

import useSWR from 'swr'
import { fetchAgentHooks, type HookDto } from '@/lib/api'
import { githubHookFamily } from '@/lib/github-events'
import { useOrgs } from '@/lib/org-context'
import type { RosterAgent } from './routing-roster'

/** Whether a hook is a GitHub pull-request subscription on `repo` (named as its row reads it). */
export const watchesRepoPullRequests = (hook: HookDto, repo: string) =>
  hook.kind === 'github' &&
  githubHookFamily(hook) === 'pull_request' &&
  (hook.repoFullName ?? hook.name).toLowerCase() === repo.toLowerCase()

/** The `candidates` that watch `repo`'s pull requests, in their given order; an agent whose hooks fail to load is left out. */
export function useRepoReviewers(repo: string, candidates: RosterAgent[]): { loading: boolean; agents: RosterAgent[] } {
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  const ids = candidates.map((agent) => agent.id)
  const { data } = useSWR(orgId ? ['code-host-reviewers', orgId, repo, ids.join(',')] : null, async () => {
    const results = await Promise.allSettled(ids.map((id) => fetchAgentHooks(id, orgId)))
    return new Set(
      ids.filter((_, i) => {
        const result = results[i]!
        return result.status === 'fulfilled' && result.value.some((hook) => watchesRepoPullRequests(hook, repo))
      })
    )
  })
  return { loading: !data, agents: data ? candidates.filter((agent) => data.has(agent.id)) : [] }
}
