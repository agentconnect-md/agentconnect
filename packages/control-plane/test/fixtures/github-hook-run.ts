import type { HookRunRecord } from '../../src/persistence/ports.js'

type RequiredRunFields =
  | 'hookId'
  | 'agentId'
  | 'dispatchDaemonId'
  | 'repoId'
  | 'repoFullName'
  | 'sourceInstallationId'
  | 'pullNumber'
  | 'headSha'
  | 'baseSha'
  | 'reportSha'

type HookRunFixtureInput = Partial<HookRunRecord> & Pick<HookRunRecord, RequiredRunFields>

/** Complete, valid GitHub HookRun baseline for unit tests. Individual suites
 * override only the identity/revision facts that matter to their scenario. */
export function githubHookRun(input: HookRunFixtureInput): HookRunRecord {
  return {
    id: 'run-1',
    orgId: 'org_1' as HookRunRecord['orgId'],
    deliveryKey: 'delivery-1',
    event: 'pull_request:opened',
    configRevision: 1n,
    dispatchRevision: 1n,
    projectionEpoch: 1n,
    reviewPolicySnapshot: 'full',
    reportingModeSnapshot: 'check',
    gateModeSnapshot: 'informational',
    projectionIntent: 'revision_event',
    subjectKind: 'pull_request',
    isDraft: false,
    baseChanged: false,
    startedAt: new Date(0),
    turnStartedAt: null,
    completedAt: null,
    orphanedAt: null,
    projectionId: null,
    projectionGeneration: null,
    reviewAttemptId: null,
    reviewAttemptState: null,
    reviewErrorCode: null,
    reviewId: null,
    reviewEvent: null,
    verdict: null,
    reviewCommitId: null,
    publishedCommentKind: null,
    publishedCommentId: null,
    status: 'running',
    durationMs: null,
    sessionId: null,
    reason: null,
    redeliveryAttempts: 0,
    redeliveryLastRequestedAt: null,
    redeliveryNextAttemptAt: null,
    ...input
  }
}
