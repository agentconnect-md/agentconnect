import type { SkillWriteBackCandidate } from '../shim/skill-protocol.js'
import type { SkillWriteBackStager } from '../shim/skill-client.js'
import { isCredentialedSkillSource } from '../skills/skill-ref-resolution.js'
import type { SkillBundleRequest, SourceCacheSkillReader } from './read-plan.js'
import { WRITE_BACK_MAX_BUNDLE_AGE_MS, type SourceCacheWriter } from './write-back.js'

// Skill write-back planning (source-cache.md §8, §9): the daemon decides the target; the pod only offers a bundle for it.

/** What the plan asks the pod for, and how the daemon writes the bundle the pod offers back. */
export interface SkillWriteBackIntent {
  maxBytes: number
  /** The GET URL names a bundle past the write-back age, so a hit on it is a candidate too. */
  stale: boolean
  /** Upload and publish one offered bundle; always resolves, and the handle is discarded on every path. */
  write(candidate: SkillWriteBackCandidate, stager: SkillWriteBackStager): Promise<void>
}

export interface SkillSourceCachePlan {
  /** A presigned GET; never logged. */
  getUrl?: string
  writeBack?: SkillWriteBackIntent
}

export interface SkillCachePlannerDeps {
  reads: SourceCacheSkillReader
  /** Absent without a bucket: nothing is asked of the pod, so no handle is ever staged. */
  writer?: SourceCacheWriter
  maxBytes: number
  now?: () => number
  maxBundleAgeMs?: number
}

/** One Source's cache plan; write-back only for a branch target, in the class the daemon's own resolution chose. */
export function createSkillCachePlanner(
  deps: SkillCachePlannerDeps
): (request: SkillBundleRequest, options: { writeBack: boolean }) => Promise<SkillSourceCachePlan> {
  const now = deps.now ?? Date.now
  const maxAgeMs = deps.maxBundleAgeMs ?? WRITE_BACK_MAX_BUNDLE_AGE_MS
  return async (request, options) => {
    const plan = await deps.reads.plan(request)
    const getUrl = plan.getUrl !== undefined ? { getUrl: plan.getUrl } : {}
    const { target } = plan
    const writer = deps.writer
    // Only a branch is written back in P2: a tag, a pinned SHA and an anonymous Source with no named ref never are.
    if (!options.writeBack || !writer || !target || !target.ref.startsWith('refs/heads/')) return getUrl
    // The clone carried the managed credential only for a private entry; the writer refuses any other class pairing.
    const credentialed = isCredentialedSkillSource(request.entry)
    const stale =
      plan.getUrl !== undefined && plan.bundleCreatedAt !== undefined && now() - plan.bundleCreatedAt > maxAgeMs
    return {
      ...getUrl,
      writeBack: {
        maxBytes: deps.maxBytes,
        stale,
        write: async (candidate, stager) => {
          await writer.considerStaged({
            target,
            staged: {
              handle: candidate.handle,
              bytes: candidate.bytes,
              sha256: candidate.sha256,
              branch: candidate.branch
            },
            trigger: candidate.trigger,
            stager,
            credentialed
          })
        }
      }
    }
  }
}
