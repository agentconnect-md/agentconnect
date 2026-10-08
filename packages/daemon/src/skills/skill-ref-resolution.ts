// Which resolver plans a tracking Git skill ref (source-cache.md §5): credentialed per agent, anonymous shared.
import type { AgentSkillEntry } from '@agentconnect.md/protocol'
import type { CodeHostRefResolver } from '../codehost/ref-resolver.js'
import { normalizeSkillRef, type CodeHostRepositoryRef, type ResolveRefResult } from '../codehost/repository.js'
import type { GitSkillRefTracker } from './git-skill-ref-tracker.js'
import { gitSkillRepositoryPath, isPinnedGitSkillRef, resolveBoundedGitSkillSource } from './skill-git-source.js'

/** A Source read with a CP-minted credential: today every private GitHub skill repository. */
export function isCredentialedSkillSource(entry: AgentSkillEntry): boolean {
  return entry.private === true
}

/** The credentialed repository a skill entry names, or undefined when the entry is not a bounded GitHub source. */
export function skillSourceRepository(entry: AgentSkillEntry): CodeHostRepositoryRef | undefined {
  const path = gitSkillRepositoryPath(entry)
  if (path === undefined) return undefined
  return {
    provider: 'github',
    externalId: entry.githubRepoId,
    cloneUrl: resolveBoundedGitSkillSource(entry).cloneUrl,
    path
  }
}

/** One agent's own answer for a credentialed skill Source, read with a token scoped to that repository. */
export async function resolveCredentialedSkillRef(
  resolver: Pick<CodeHostRefResolver, 'resolveRef'>,
  entry: AgentSkillEntry,
  agentId: string
): Promise<ResolveRefResult> {
  const repository = skillSourceRepository(entry)
  if (!repository) return { ok: false, reason: 'unavailable', detail: 'invalid_source', checkedAt: Date.now() }
  const candidates = normalizeSkillRef(resolveBoundedGitSkillSource(entry).ref)
  let result: ResolveRefResult | undefined
  for (const ref of candidates) {
    result = await resolver.resolveRef({ agentId, repository, ref, hosts: {}, tokenScope: 'repository' })
    // Only a missing ref falls through: a bare name that is no branch may still be a tag.
    if (result.ok || result.reason !== 'ref_not_found') return result
  }
  return result!
}

export interface SkillRefResolutionDeps {
  anonymous: Pick<GitSkillRefTracker, 'resolve'>
  credentialed: Pick<CodeHostRefResolver, 'resolveRef'>
}

/** The planned commit for a tracking skill ref, or null when unknown (the installed commit then stands). */
export function createSkillRefResolution(
  deps: SkillRefResolutionDeps
): (entry: AgentSkillEntry, agentId: string) => Promise<string | null> {
  return async (entry, agentId) => {
    try {
      if (isPinnedGitSkillRef(entry)) return null
    } catch {
      return null
    }
    if (!isCredentialedSkillSource(entry)) return deps.anonymous.resolve(entry)
    const result = await resolveCredentialedSkillRef(deps.credentialed, entry, agentId)
    return result.ok ? result.commit : null
  }
}
