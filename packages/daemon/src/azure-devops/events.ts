// The normalized events an Azure DevOps delivery arrives with or is classified into (azure-devops-integration.md §11.4), in one place for admission, lifecycle and the prompt.

/** Deliveries that establish a new pull-request head. */
export const AZURE_DEVOPS_PULL_REVISION_EVENTS: ReadonlySet<string> = new Set([
  'merge_request:opened',
  'merge_request:synchronize'
])

/** A reviewer change the turn-start read confirmed names the connection identity: it re-runs the current head. */
export const AZURE_DEVOPS_REVIEW_REQUESTED_EVENT = 'merge_request:review_requested'
export const AZURE_DEVOPS_PULL_RERUN_EVENTS: ReadonlySet<string> = new Set([AZURE_DEVOPS_REVIEW_REQUESTED_EVENT])

/** Deliveries that open a formal review generation for the current head (§11.6). */
export const AZURE_DEVOPS_PULL_REVIEW_GENERATION_EVENTS: ReadonlySet<string> = new Set([
  ...AZURE_DEVOPS_PULL_REVISION_EVENTS,
  ...AZURE_DEVOPS_PULL_RERUN_EVENTS
])

/** What the relay forwards for a status change; the read classifies it, and one left unclassified is ignored. */
export const AZURE_DEVOPS_STATE_CHANGED_EVENT = 'merge_request:state_changed'
/** A reviewer change the read found is not a request of the connection identity. */
export const AZURE_DEVOPS_REVIEWERS_UPDATED_EVENT = 'merge_request:reviewers_updated'

/** The classifications of a status change. */
export const AZURE_DEVOPS_REOPENED_EVENT = 'merge_request:reopened'
export const AZURE_DEVOPS_CLOSED_EVENT = 'merge_request:closed'
export const AZURE_DEVOPS_MERGED_EVENT = 'merge_request:merged'

/** A comment written on a pull-request thread. */
export const AZURE_DEVOPS_COMMENT_EVENT = 'note:created'

/** Why an ignored delivery started no turn, by the event it was left as. */
export const AZURE_DEVOPS_IGNORED_EVENTS: ReadonlyMap<string, string> = new Map([
  [AZURE_DEVOPS_STATE_CHANGED_EVENT, 'state_change_ignored'],
  [AZURE_DEVOPS_REVIEWERS_UPDATED_EVENT, 'review_request_not_for_identity']
])
