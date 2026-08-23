/**
 * The authenticated half of the version floor (gitlab-com-integration.md §24.2):
 * read `GET /api/v4/version`, record what the instance said on the
 * deployment-level state, and hand back the parsed verdict.
 *
 * One helper for two callers so both record the same observation: the OAuth
 * callback, whose FIRST credentialed call this is, and the reconciliation pass,
 * which refreshes it so an instance downgraded under live bindings converges on
 * refusing new provisioning while existing sessions keep working.
 *
 * A failed read is upstream trouble, not a verdict — it THROWS `GitlabApiError`
 * and records nothing, so a transient fault never gets remembered as a version.
 */
import type { Clock } from '../domain/clock.js'
import type { GitlabInstanceStateRepo } from '../persistence/ports.js'
import { gitlabVersion, type GitlabApiClient } from './api.js'
import { parseGitlabVersion, type GitlabInstanceVersion } from './version.js'

export interface InstanceVersionDeps {
  api: GitlabApiClient
  instanceState: GitlabInstanceStateRepo
  clock: Clock
}

export async function observeInstanceVersion(
  deps: InstanceVersionDeps,
  accessToken: string
): Promise<GitlabInstanceVersion> {
  const reported = await gitlabVersion(accessToken, deps.api)
  const parsed = parseGitlabVersion(reported.version)
  // Recorded even when it refuses: the observation is what an operator reads to
  // learn WHY, and a refusal that leaves no trace is a silent one.
  await deps.instanceState.record({
    baseUrl: deps.api.baseUrl,
    version: parsed.raw,
    enterprise: parsed.enterprise,
    observedAt: new Date(deps.clock.now())
  })
  return parsed
}
