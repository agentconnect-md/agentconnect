/**
 * The named refusal a turn-time GitLab host disagreement takes (gitlab-com-integration.md §24.4).
 *
 * A hook may reach an ALREADY-RUNNING session whose environment cannot be retroactively edited: its
 * credential git-config block, injected helper table and `GITLAB_HOST` export were all established
 * at spawn for the instance the spec named. So a delivery whose trusted metadata names another
 * instance is refused under this reason and never re-targeted.
 */
export const GITLAB_HOST_MISMATCH_REASON = 'gitlab_host_mismatch'
