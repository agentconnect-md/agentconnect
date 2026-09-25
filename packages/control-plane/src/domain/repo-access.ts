// The three repository access tiers (agent-multi-repo-authorization.md decision 3) and what a GitHub hook's actions need of one.
export type RepoAccessTier = 'read' | 'comment' | 'write'

const RANK: Record<RepoAccessTier, number> = { read: 0, comment: 1, write: 2 }

export function accessBelow(access: RepoAccessTier, than: RepoAccessTier): boolean {
  return RANK[access] < RANK[than]
}

/** The hook route's gate on a row or installation grant: Checks and non-comment reviews need write, a comment review needs comment. */
export function githubEffectsNeed(effects: { reviewPolicy: string; reportingMode: string }): RepoAccessTier {
  if (effects.reportingMode !== 'off') return 'write'
  if (effects.reviewPolicy === 'off') return 'read'
  return effects.reviewPolicy === 'comment' ? 'comment' : 'write'
}
