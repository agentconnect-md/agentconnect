// R1/R2a GitHub review settings shared by the create and edit surfaces.
// The release boundary is explicit: only formal reviews plus informational Checks have options here.
// The host-neutral half lives in `code-host-review-settings.ts`; what stays is GitHub's own
// App-installation permissions and the per-repository access tier an effect is clamped against.

import type { CodeHostProvider } from '@agentconnect.md/protocol/code-host'
import {
  codeHostReviewCapabilities,
  codeHostReviewSettingsFromCapabilities,
  type CodeHostReviewCapabilities,
  type CodeHostReviewSettingsValue,
  type HookReportingMode
} from './code-host-review-settings'

export {
  REVIEW_POLICY_OPTIONS,
  reviewPolicyLabel,
  type HookGateMode,
  type HookReportingMode,
  type HookReviewPolicy
} from './code-host-review-settings'

export type EffectiveRepoAccess = 'none' | 'read' | 'comment' | 'write'
export type GithubChecksPermission = 'write' | 'missing' | 'unknown'
export type GithubPullRequestsPermission = 'read' | 'write' | 'missing' | 'unknown'

export type GithubReviewSettingsValue = CodeHostReviewSettingsValue
export type GithubReviewCapabilities = CodeHostReviewCapabilities

export const githubReviewCapabilities = codeHostReviewCapabilities
export const githubReviewSettingsFromCapabilities = codeHostReviewSettingsFromCapabilities

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

/** The tier a configuration needs: every formal review and every Check goes through an API the
 *  App holds only at `write`, so anything but the off pair demands the `write` grant tier. */
export function requiredRepoAccess({ reviewPolicy, reportingMode }: GithubReviewSettingsValue): 'none' | 'write' {
  return reviewPolicy !== 'off' || reportingMode === 'check' ? 'write' : 'none'
}

export function repoAccessSatisfies(actual: EffectiveRepoAccess, required: 'none' | 'write'): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required]
}

/** Checks are authorized from the installation-effective snapshot, not the coarse
 *  "permissions waiting" status; a legacy or unknown snapshot still fails closed. */
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
    mode: 'git' | 'scratch'
    provider?: CodeHostProvider
    repoId?: string
    repo?: string
  }
}

/** Resolve whether a selected repository is the App-backed workspace grant. */
export function isWorkspaceRepo(input: WorkspaceRepoMatchInput): boolean {
  const wantedId = input.repoId?.trim()
  const wanted = input.repoFullName?.trim().toLowerCase()
  const githubBacked = input.workspace.mode === 'git' && input.workspace.provider === 'github'
  const workspaceId = githubBacked ? input.workspace.repoId?.trim() : undefined
  return (
    githubBacked &&
    ((!!wantedId && !!workspaceId && wantedId === workspaceId) ||
      ((!wantedId || !workspaceId) && !!wanted && input.workspace.repo?.toLowerCase() === wanted))
  )
}

/** The tier an installation grant covering the repository's owner confers, or `none`. */
export function installationGrantAccess(
  repoFullName: string | null | undefined,
  grants: ReadonlyArray<{ accountLogin: string; access: 'read' | 'comment' | 'write' }> | undefined
): EffectiveRepoAccess {
  const owner = repoFullName?.trim().split('/')[0]?.toLowerCase()
  return (owner && grants?.find((grant) => grant.accountLogin.toLowerCase() === owner)?.access) || 'none'
}

/** Resolve the hook repo against the implicit workspace grant, then explicit repo grants, then installation grants. */
export function effectiveRepoAccess(input: {
  repoId?: string | null
  repoFullName: string | null | undefined
  workspace: {
    mode: 'git' | 'scratch'
    provider?: CodeHostProvider
    repoId?: string
    repo?: string
    gitAccess?: 'read' | 'write'
  }
  authorizations: ReadonlyArray<{
    repoId?: string
    repoFullName: string
    access: 'read' | 'comment' | 'write'
  }>
  /** An explicit row keeps its own tier; a grant counts only when no row matches (decision 10). */
  installationGrants?: ReadonlyArray<{ accountLogin: string; access: 'read' | 'comment' | 'write' }>
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
  const explicit = wantedId
    ? (input.authorizations.find((row) => row.repoId?.trim() === wantedId) ??
      input.authorizations.find((row) => !row.repoId && !!wanted && row.repoFullName.toLowerCase() === wanted))
    : input.authorizations.find((row) => !!wanted && row.repoFullName.toLowerCase() === wanted)
  return explicit?.access ?? installationGrantAccess(input.repoFullName, input.installationGrants)
}

export function installationForRepo<T extends { accountLogin: string }>(
  repoFullName: string | null | undefined,
  installations: readonly T[]
): T | undefined {
  const owner = repoFullName?.split('/')[0]?.toLowerCase()
  return owner ? installations.find((installation) => installation.accountLogin.toLowerCase() === owner) : undefined
}
