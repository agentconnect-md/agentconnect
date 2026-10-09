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
  anonymous: Pick<GitSkillRefTracker, 'resolve' | 'resolveTracked'>
  credentialed: Pick<CodeHostRefResolver, 'resolveRef'>
}

/** A Git skill Source's resolution as the in-pod plan uses it: the daemon's planned commit, the full ref it followed, and who vouched. */
export type SkillRefPlan =
  | {
      ok: true
      commit: string
      /** The full `refs/heads/*` or `refs/tags/*` name, when the resolution knows it; absent for a pinned SHA. */
      ref?: string
      pinned: boolean
      /** `resolveRef` succeeded for THIS agent: the only authority a `cred` cache read may rest on (source-cache.md §5). */
      credentialed: boolean
    }
  | { ok: false }

/** Resolve a Git skill Source for an in-pod plan: pinned as given, credentialed per agent, anonymous through the shared check. */
export function createSkillRefPlanResolution(
  deps: SkillRefResolutionDeps,
  // Only a cache key needs the anonymous ref's name; a commit-only caller never spends the listing.
  opts: { nameAnonymousRef?: boolean } = {}
): (entry: AgentSkillEntry, agentId: string) => Promise<SkillRefPlan> {
  const nameAnonymousRef = opts.nameAnonymousRef ?? true
  return async (entry, agentId) => {
    let pinned: boolean
    try {
      pinned = isPinnedGitSkillRef(entry)
    } catch {
      return { ok: false }
    }
    if (pinned) {
      return { ok: true, commit: resolveBoundedGitSkillSource(entry).ref!.toLowerCase(), pinned, credentialed: false }
    }
    if (!isCredentialedSkillSource(entry)) {
      const tracked = nameAnonymousRef
        ? await deps.anonymous.resolveTracked(entry)
        : await deps.anonymous.resolve(entry).then((commit) => (commit === null ? null : { commit, ref: undefined }))
      if (tracked === null) return { ok: false }
      const { commit, ref } = tracked
      return { ok: true, commit, ...(ref ? { ref } : {}), pinned, credentialed: false }
    }
    const result = await resolveCredentialedSkillRef(deps.credentialed, entry, agentId)
    if (!result.ok) return { ok: false }
    return { ok: true, commit: result.commit, ...(result.ref ? { ref: result.ref } : {}), pinned, credentialed: true }
  }
}

/** The planned commit for a tracking skill ref, or null when unknown (the installed commit then stands). */
export function createSkillRefResolution(
  deps: SkillRefResolutionDeps
): (entry: AgentSkillEntry, agentId: string) => Promise<string | null> {
  const plan = createSkillRefPlanResolution(deps, { nameAnonymousRef: false })
  return async (entry, agentId) => {
    const resolved = await plan(entry, agentId)
    return resolved.ok && !resolved.pinned ? resolved.commit : null
  }
}
