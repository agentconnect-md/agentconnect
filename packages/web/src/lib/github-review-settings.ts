/**
 * R1/R2a GitHub review settings shared by the create and edit surfaces.
 *
 * Keep the release boundary explicit here: the console only offers formal
 * reviews plus informational Checks. Required gates and legacy commit statuses
 * are later milestones and therefore have no option in this module.
 */

export type HookReviewPolicy = 'off' | 'comment' | 'request_changes' | 'full'
export type HookReportingMode = 'off' | 'check'
export type HookGateMode = 'informational'
export type EffectiveRepoAccess = 'none' | 'read' | 'comment' | 'write'
export type GithubChecksPermission = 'write' | 'missing' | 'unknown'
export type GithubPullRequestsPermission = 'read' | 'write' | 'missing' | 'unknown'

export interface GithubReviewSettingsValue {
  reviewPolicy: HookReviewPolicy
  reportingMode: HookReportingMode
}

export interface GithubReviewCapabilities {
  inlineComments: boolean
  requestChanges: boolean
  approve: boolean
  statusCheck: boolean
}

/** Present the hierarchical reviewPolicy enum as capability checkboxes. */
export function githubReviewCapabilities(value: GithubReviewSettingsValue): GithubReviewCapabilities {
  return {
    inlineComments: value.reviewPolicy !== 'off',
    requestChanges: value.reviewPolicy === 'request_changes' || value.reviewPolicy === 'full',
    approve: value.reviewPolicy === 'full',
    statusCheck: value.reportingMode === 'check'
  }
}

/** Collapse capability checkboxes back to the strongest enabled R1 policy. */
export function githubReviewSettingsFromCapabilities(
  capabilities: GithubReviewCapabilities
): GithubReviewSettingsValue {
  return {
    reviewPolicy: capabilities.approve
      ? 'full'
      : capabilities.requestChanges
        ? 'request_changes'
        : capabilities.inlineComments
          ? 'comment'
          : 'off',
    reportingMode: capabilities.statusCheck ? 'check' : 'off'
  }
}

export const REVIEW_POLICY_OPTIONS: ReadonlyArray<{
  value: HookReviewPolicy
  label: string
  description: string
}> = [
  { value: 'off', label: 'Off', description: 'Keep the normal PR reply only.' },
  { value: 'comment', label: 'Comment', description: 'Submit a formal COMMENT review.' },
  {
    value: 'request_changes',
    label: 'Request changes',
    description: 'Allow COMMENT or REQUEST_CHANGES.'
  },
  { value: 'full', label: 'Full', description: 'Also allow the shared App bot to approve.' }
]

export const REPORTING_MODE_OPTIONS: ReadonlyArray<{
  value: HookReportingMode
  label: string
  description: string
}> = [
  { value: 'off', label: 'Off', description: 'Do not publish a GitHub Check.' },
  { value: 'check', label: 'Informational Check', description: 'Show progress and verdict in the PR Checks tab.' }
]

const ACCESS_RANK: Record<EffectiveRepoAccess, number> = {
  none: 0,
  read: 1,
  comment: 2,
  write: 3
}

/**
 * The additional capability a selected R1/R2a configuration needs. Any formal
 * review — even a COMMENT-type one — is submitted through the Reviews API, which
 * requires the App's pull_requests:write scope; the console now grants that only
 * via the `write` tier (the standalone `comment` grant tier was retired from the
 * UI). Informational Checks need checks:write, likewise the `write` tier.
 */
export function requiredRepoAccess({ reviewPolicy, reportingMode }: GithubReviewSettingsValue): 'none' | 'write' {
  return reviewPolicy !== 'off' || reportingMode === 'check' ? 'write' : 'none'
}

export function repoAccessSatisfies(actual: EffectiveRepoAccess, required: 'none' | 'write'): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required]
}

/**
 * Checks are authorized from the installation-effective permission snapshot,
 * not GitHub's coarse "new App permissions are waiting" status. The latter
 * can include unrelated permissions, while a legacy/unknown snapshot must
 * still fail closed.
 */
export function hasChecksWritePermission(
  installation: { checksPermission: GithubChecksPermission } | null | undefined
): boolean {
  return installation?.checksPermission === 'write'
}

/** Formal review mutations likewise require the installation-effective
 * pull_requests:write fact; a missing legacy snapshot is not authority. */
export function hasPullRequestsWritePermission(
  installation: { pullRequestsPermission: GithubPullRequestsPermission } | null | undefined
): boolean {
  return installation?.pullRequestsPermission === 'write'
}

/** R2a's live commit-to-PR association needs pull_requests:read; write is a
 * superset. Keep this distinct from the formal-review write gate. */
export function hasPullRequestsReadPermission(
  installation: { pullRequestsPermission: GithubPullRequestsPermission } | null | undefined
): boolean {
  return installation?.pullRequestsPermission === 'read' || installation?.pullRequestsPermission === 'write'
}

interface WorkspaceRepoMatchInput {
  repoId?: string | null
  repoFullName: string | null | undefined
  workspace: {
    mode: 'github' | 'scratch'
    repoId?: string
    repo?: string
    installationId?: string
  }
}

/** Resolve whether a selected repository is the App-backed workspace grant. */
export function isWorkspaceRepo(input: WorkspaceRepoMatchInput): boolean {
  const wantedId = input.repoId?.trim()
  const wanted = input.repoFullName?.trim().toLowerCase()
  const workspaceId = input.workspace.mode === 'github' ? input.workspace.repoId?.trim() : undefined
  return (
    input.workspace.mode === 'github' &&
    !!input.workspace.installationId &&
    ((!!wantedId && !!workspaceId && wantedId === workspaceId) ||
      ((!wantedId || !workspaceId) && !!wanted && input.workspace.repo?.toLowerCase() === wanted))
  )
}

/**
 * Resolve the hook repo against the agent's implicit App-backed workspace
 * grant first, then its explicit repo grants. Scratch has no implicit repo,
 * while a manual GitHub workspace can carry an explicit grant for its own repo.
 */
export function effectiveRepoAccess(input: {
  repoId?: string | null
  repoFullName: string | null | undefined
  workspace: {
    mode: 'github' | 'scratch'
    repoId?: string
    repo?: string
    installationId?: string
    gitAccess?: 'read' | 'write'
  }
  authorizations: ReadonlyArray<{
    repoId?: string
    repoFullName: string
    access: 'read' | 'comment' | 'write'
  }>
}): EffectiveRepoAccess {
  const wantedId = input.repoId?.trim()
  const wanted = input.repoFullName?.trim().toLowerCase()
  if (!wantedId && !wanted) return 'none'
  // Rolling compatibility: name matching is allowed only when one side has no
  // numeric provenance. Conflicting ids must never name-match.
  if (isWorkspaceRepo(input)) {
    // App-backed workspaces historically omitted the field and defaulted to
    // write on the CP, so preserve that safe compatibility interpretation.
    return input.workspace.gitAccess ?? 'write'
  }
  if (wantedId) {
    const exact = input.authorizations.find((row) => row.repoId?.trim() === wantedId)
    if (exact) return exact.access
    const legacy = input.authorizations.find(
      (row) => !row.repoId && !!wanted && row.repoFullName.toLowerCase() === wanted
    )
    return legacy?.access ?? 'none'
  }
  return input.authorizations.find((row) => !!wanted && row.repoFullName.toLowerCase() === wanted)?.access ?? 'none'
}

export function informationalCheckName(): string {
  return 'AgentConnect PR Review'
}

export function installationForRepo<T extends { accountLogin: string }>(
  repoFullName: string | null | undefined,
  installations: readonly T[]
): T | undefined {
  const owner = repoFullName?.split('/')[0]?.toLowerCase()
  return owner ? installations.find((installation) => installation.accountLogin.toLowerCase() === owner) : undefined
}

export function reviewPolicyLabel(policy: HookReviewPolicy): string {
  return REVIEW_POLICY_OPTIONS.find((option) => option.value === policy)?.label ?? 'Off'
}
