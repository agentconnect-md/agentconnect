import { WRITE_BACK_FALLBACK_REASONS } from '../source-cache/bundle-retry.js'
import type { BundleStage } from './bundle-handler.js'
import type { SkillGitBundleOutcome } from './skill-git-acquire.js'
import type { GitPlanOutcome } from './skill-git-plan.js'
import type { SkillWriteBackCandidate, SkillWriteBackTrigger } from './skill-protocol.js'

// The shim half of skill write-back (source-cache.md §9): bundle an installed Git plan clone the daemon may upload.

/** Each bundle's own limit, and the most one reconcile spends bundling, so write-back never costs the install its timeout. */
export const SKILL_STAGE_TIMEOUT_MS = 2 * 60_000
export const SKILL_STAGE_BUDGET_MS = 4 * 60_000

/** What the skill handler needs from the bundle handler: stage a clone under a handle, or drop one nobody will use. */
export interface SkillWriteBackStaging {
  stage: BundleStage
  discard(handle: string): unknown
}

type Acquired = Extract<GitPlanOutcome, { kind: 'acquired' }>

/** Why this clone is worth writing back, or undefined: a miss, a bad-bundle fallback, or a hit the daemon marked stale. */
export function skillWriteBackTrigger(
  writeBack: Acquired['plan']['writeBack'],
  bundle: SkillGitBundleOutcome
): SkillWriteBackTrigger | undefined {
  if (!writeBack) return undefined
  if (bundle.kind === 'uncached') return 'miss'
  if (bundle.kind === 'fallback') return WRITE_BACK_FALLBACK_REASONS.has(bundle.reason) ? 'fallback' : undefined
  return writeBack.stale ? 'stale' : undefined
}

/** Bundle each eligible installed clone, one at a time; a failure costs only that candidate, never the install. */
export async function stageSkillWriteBacks(input: {
  outcomes: Acquired[]
  staging: SkillWriteBackStaging
  abort: AbortSignal
  log?: { warn(message: string): void }
  now?: () => number
}): Promise<SkillWriteBackCandidate[]> {
  const now = input.now ?? Date.now
  const deadline = now() + SKILL_STAGE_BUDGET_MS
  const candidates: SkillWriteBackCandidate[] = []
  for (const outcome of input.outcomes) {
    const { plan } = outcome
    const trigger = skillWriteBackTrigger(plan.writeBack, outcome.bundle)
    // The clone's branch already proved it names the planned commit; the stage re-checks it, then lists the bundle's heads.
    if (!trigger || !plan.writeBack || outcome.writeBackRef === undefined || outcome.commit !== plan.plannedCommit)
      continue
    if (input.abort.aborted) break
    const remaining = deadline - now()
    if (remaining <= 0) {
      input.log?.warn(`skill git ${plan.sourceId}: no write-back bundle (the reconcile's bundling budget is spent)`)
      continue
    }
    try {
      const staged = await input.staging.stage(
        {
          repo: outcome.repo,
          ref: outcome.writeBackRef,
          commit: outcome.commit,
          shape: 'blobless',
          maxBytes: plan.writeBack.maxBytes,
          timeoutMs: Math.min(SKILL_STAGE_TIMEOUT_MS, remaining)
        },
        input.abort
      )
      candidates.push({
        sourceId: plan.sourceId,
        branch: outcome.writeBackRef,
        commit: outcome.commit,
        handle: staged.handle,
        bytes: staged.bytes,
        sha256: staged.sha256,
        trigger
      })
    } catch (err) {
      input.log?.warn(`skill git ${plan.sourceId}: no write-back bundle (${(err as Error).message})`)
    }
  }
  return candidates
}
