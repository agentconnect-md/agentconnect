import { z } from 'zod'

import { AuthReq, AuthOk } from './frames/auth.js'
import { RegisterReq, RegisterOk, RelayRosterUpdate, CapabilitiesUpdate } from './frames/register.js'
import { CollabRoutesSnapshot } from './frames/collab.js'
import { RouteAssign, RouteAssignAck, RouteUpdate, Drain, DrainProgress, DrainDone } from './frames/route.js'
import {
  AgentLaunch,
  AgentLaunched,
  AgentStop,
  AgentUpsert,
  AgentRemove,
  AgentExists,
  AgentExistsOk,
  AgentDetach,
  AgentActivate,
  AgentActivity,
  AgentScopeDenied,
  AgentPermissionRequestList,
  AgentPermissionRequestPage,
  AgentPermissionDecision,
  AgentWakeReq,
  AgentWakeOk
} from './frames/agent.js'
import { CronUpsert, CronRemove, CronReport, CronRunNow } from './frames/cron.js'
import {
  DutyGrant,
  DutyRenewed,
  DutyRevoke,
  DutyRelease,
  DutyClaim,
  DutyClaimOk,
  DutyFetch,
  DutyFetchOk
} from './frames/duty.js'
import { CodeHostNoteDesired, CodeHostNoteResult, CodeHostNoteResultOk } from './frames/codehost-note.js'
import { AgentApprovalRoute, AgentApprovalRouted } from './frames/approval-route.js'
import {
  GithubReviewAuthorize,
  GithubReviewAuthorized,
  GithubReviewResultOk,
  GithubReviewResultReport,
  HookReport,
  HookStart,
  HookStartOk
} from './frames/hook.js'
import {
  CodeHostReviewAuthorize,
  CodeHostReviewAuthorized,
  CodeHostReviewLeaseRenew,
  CodeHostReviewLeaseRenewed,
  CodeHostReviewOpAccepted,
  CodeHostReviewOpRequest,
  CodeHostReviewResultOk,
  CodeHostReviewResultReport
} from './frames/codehost-review.js'
import {
  IntegrationUpsert,
  IntegrationRemove,
  IntegrationChannels,
  IntegrationForget,
  IntegrationLeave,
  IntegrationLeaveOk
} from './frames/integration.js'
import { McpServerUpsert, McpServerRemove } from './frames/mcpserver.js'
import { MemoryConnectionUpsert, MemoryConnectionRemove, MemoryConnectionFacts } from './frames/memory-connection.js'
import { GitCredRequest, GitCredGrant } from './frames/gitcred.js'
import { LinearCredRequest, LinearCredGrant } from './frames/linearcred.js'
import { SecretsRequest, SecretsGrant, SecretsRenew, SecretsRevoke, ScopeAttestation } from './frames/secrets.js'
import {
  SessionHistoryReq,
  SessionHistoryPage,
  SessionListReq,
  SessionListPage,
  SessionToolBodyReq,
  SessionToolBodyChunk,
  ChildSessionStatus,
  ChildSessionStatusReq,
  ChildSessionStatusProbe,
  SessionVisibilityPush,
  SessionVisibilityOk,
  SessionVisibilitySnapshot,
  SessionPullRequestFeedback,
  SessionPullRequestFeedbackResult
} from './frames/session.js'
import { ChannelAgentsReq, ChannelAgentsOk } from './frames/channel.js'
import {
  WorkspaceListReq,
  WorkspaceListPage,
  WorkspaceReadReq,
  WorkspaceReadContent,
  WorkspaceWriteReq,
  WorkspaceWriteOk,
  WorkspaceDeleteReq,
  WorkspaceDeleteOk,
  WorkspaceGitStatusReq,
  WorkspaceGitStatus,
  WorkspaceGitDiffReq,
  WorkspaceGitDiffResult,
  WorkspaceGitLogReq,
  WorkspaceGitLog,
  WorkspaceGitPullReq,
  WorkspaceGitPullResult,
  WorkspaceGitStageReq,
  WorkspaceGitCommitReq,
  WorkspaceGitCommitResult,
  WorkspaceGitPushReq,
  WorkspaceGitPushResult,
  WorkspaceGitMessageReq,
  WorkspaceGitMessageResult
} from './frames/workspace.js'
import { TaskListReq, TaskList } from './frames/task.js'
import { AutoMergeSetReq, AutoMergeStateReq, AutoMergeState } from './frames/automerge.js'
import { SandboxKeepAliveReq, SandboxKeepAlive } from './frames/sandbox-keepalive.js'
import {
  MemoryChannelsReq,
  MemoryChannelsPage,
  MemoryListReq,
  MemoryListPage,
  MemoryReadReq,
  MemoryReadContent,
  MemoryWriteReq,
  MemoryWriteOk,
  MemoryHistoryReq,
  MemoryHistoryPage,
  MemorySurfaceReq,
  MemorySurfaceInfo,
  MemoryRecordSearchReq,
  MemoryRecordSearchPage,
  MemoryRecordListReq,
  MemoryRecordListPage,
  MemoryRecordGetReq,
  MemoryRecordGetResult,
  MemoryRecordCreateReq,
  MemoryRecordCreateResult,
  MemoryRecordUpdateReq,
  MemoryRecordUpdateResult,
  MemoryRecordDeleteReq,
  MemoryRecordDeleteResult,
  MemoryRecordHistoryReq,
  MemoryRecordHistoryPage,
  DreamStartReq,
  DreamState,
  DreamCancelReq,
  DreamListReq,
  DreamListPage,
  DreamGetReq,
  DreamAdoptReq,
  DreamDiscardReq,
  DreamFilesReq,
  DreamFilesPage,
  DreamFileReadReq,
  DreamFileReadContent,
  DreamSkillReviewReq,
  DreamSkillReadReq,
  DreamSkillContent
} from './frames/memory.js'
import { LocalSkillsReq, LocalSkillsList } from './frames/skill.js'
import { RuntimeCommandsReq, RuntimeCommandsList } from './frames/runtime-command.js'
import {
  KnowledgeSearchReq,
  KnowledgeSearchOk,
  KnowledgeListReq,
  KnowledgeListOk,
  OrgSkillsReq,
  OrgSkillsOk,
  OrganizationSuggestionsSyncReq,
  OrganizationSuggestionsSyncOk,
  OrganizationSuggestionReadReq,
  OrganizationSuggestionChunk,
  OrganizationSuggestionReviewReq,
  ManagedSkillReadReq,
  ManagedSkillChunk
} from './frames/organization-knowledge.js'
import {
  Heartbeat,
  EventSession,
  SessionActivity,
  SessionPurged,
  UsageReport,
  FactsRuntimeProfile,
  DaemonRuntimes,
  ConfigPush,
  DaemonBootstrapResult,
  DaemonRestart,
  DaemonUpgrade,
  DaemonControlAck,
  Ack
} from './frames/telemetry.js'
import { ErrorFrame } from './frames/error.js'
import {
  WebchatMcpGrantAccept,
  WebchatMcpGrantActivate,
  WebchatMcpGrantIssue,
  WebchatMcpGrantIssued,
  WebchatMcpGrantRevoke,
  WebchatMcpGrantRevoked
} from './frames/remote-mcp.js'
// webchat CONTENT frames were retired in milestone A4 — content rides the relay's rd/*
// wire now, not the daemon↔CP control WS. The reply-payload schemas live on in
// frames/webchat.ts (reused by rd/chat); remote-MCP grant lifecycle frames
// remain valid on the control WebSocket.

/**
 * The single source of truth for the wire: `type` string → payload zod schema.
 *
 * Mirrors the frame index in daemon-cp-ws-protocol.md §10 (the 29 numbered
 * frames) plus the correlated REP types named in the "Reply" column
 * (`route/assign/ack`, `drain/done`, and the generic `ack` replies) that also
 * travel on the wire and must be decodable.
 *
 * `ws/codec.ts` validates every inbound `payload` against `FRAME_SCHEMAS[type]`;
 * an unknown `type` → `ErrorFrame{code:"UNKNOWN_FRAME"}` (a REP, not a close).
 */
export const FRAME_SCHEMAS = {
  // ── auth / identity ──
  auth: AuthReq,
  'auth/ok': AuthOk,
  // ── register / reconcile ──
  register: RegisterReq,
  'register/ok': RegisterOk,
  // ── capability refresh (D→C hot update of register.capabilities) ──
  'capabilities/update': CapabilitiesUpdate,
  // ── relay roster (C→D hot update of register/ok.relays) ──
  'relay/roster': RelayRosterUpdate,
  // ── collaboration routing snapshot (C→D hot push; baseline in register/ok) ──
  'collaboration/routes': CollabRoutesSnapshot,
  // ── telemetry ──
  heartbeat: Heartbeat,
  'duty/grant': DutyGrant,
  'duty/renewed': DutyRenewed,
  'duty/revoke': DutyRevoke,
  'duty/release': DutyRelease,
  'duty/claim': DutyClaim,
  'duty/claim/ok': DutyClaimOk,
  'duty/fetch': DutyFetch,
  'duty/fetch/ok': DutyFetchOk,
  // ── agent lifecycle / delivery ──
  'agent/launch': AgentLaunch,
  'agent/launched': AgentLaunched,
  'agent/stop': AgentStop,
  'agent/upsert': AgentUpsert,
  'agent/remove': AgentRemove,
  'agent/exists': AgentExists,
  'agent/exists/ok': AgentExistsOk,
  'agent/detach': AgentDetach,
  'agent/activate': AgentActivate,
  'agent/activity': AgentActivity,
  'agent/scope-denied': AgentScopeDenied,
  'agent/permission-requests': AgentPermissionRequestList,
  'agent/permission-requests/page': AgentPermissionRequestPage,
  'agent/permission-decision': AgentPermissionDecision,
  // ── approval-DM routing: pick / revalidate a Slack recipient (approval-route.ts).
  'agent/approval-route': AgentApprovalRoute,
  'agent/approval-routed': AgentApprovalRouted,
  // ── sandbox wake: a console-initiated resume with no turn (agent.ts `AgentWakeReq`).
  'agent/wake': AgentWakeReq,
  'agent/wake/ok': AgentWakeOk,
  // ── routing / orchestration ──
  'route/assign': RouteAssign,
  'route/assign/ack': RouteAssignAck,
  'route/update': RouteUpdate,
  'daemon/drain': Drain,
  'drain/progress': DrainProgress,
  'drain/done': DrainDone,
  // ── cron ──
  'cron/upsert': CronUpsert,
  'cron/remove': CronRemove,
  'cron/report': CronReport,
  'cron/run': CronRunNow,
  // ── hooks (content fires ride rd/*; only metadata/effect control is here) ──
  'hook/report': HookReport,
  'hook/start': HookStart,
  'hook/start/ok': HookStartOk,
  'github/review-authorize': GithubReviewAuthorize,
  'github/review-authorized': GithubReviewAuthorized,
  'github/review-result': GithubReviewResultReport,
  'github/review-result/ok': GithubReviewResultOk,
  // ── informational run projection (gitlab-com-integration.md §16) — body-free desired/result pair ──
  'codehost/note-desired': CodeHostNoteDesired,
  'codehost/note-result': CodeHostNoteResult,
  'codehost/note-result/ok': CodeHostNoteResultOk,
  // ── provider-neutral formal reviews (gitlab-com-integration.md §15, §17.2) ──
  'codehost/review-authz': CodeHostReviewAuthorize,
  'codehost/review-authz/result': CodeHostReviewAuthorized,
  'codehost/review-op': CodeHostReviewOpRequest,
  'codehost/review-op/ok': CodeHostReviewOpAccepted,
  'codehost/review-lease-renew': CodeHostReviewLeaseRenew,
  'codehost/review-lease-renew/ok': CodeHostReviewLeaseRenewed,
  'codehost/review-result': CodeHostReviewResultReport,
  'codehost/review-result/ok': CodeHostReviewResultOk,
  // ── integrations (platform config distribution; token-bearing — never log) ──
  'integration/upsert': IntegrationUpsert,
  'integration/remove': IntegrationRemove,
  'integration/channels': IntegrationChannels,
  'integration/forget': IntegrationForget,
  'integration/leave': IntegrationLeave,
  'integration/leave/ok': IntegrationLeaveOk,
  // ── MCP provider registry (CP-owned defs pushed to daemons; grant-key-bearing — never log) ──
  'mcpserver/upsert': McpServerUpsert,
  'mcpserver/remove': McpServerRemove,
  // ── external-memory connection registry (grant-bearing; never log) ──
  'memoryconnection/upsert': MemoryConnectionUpsert,
  'memoryconnection/remove': MemoryConnectionRemove,
  // ── git credentials (github-app workspaces; token-bearing — never log) ──
  'gitcred/request': GitCredRequest,
  'gitcred/grant': GitCredGrant,
  // ── Linear access-token broker (linear-integration.md §7.3; token-bearing — never log) ──
  'linearcred/request': LinearCredRequest,
  'linearcred/grant': LinearCredGrant,
  // ── secrets ──
  'secrets/request': SecretsRequest,
  'secrets/grant': SecretsGrant,
  'secrets/renew': SecretsRenew,
  'secrets/revoke': SecretsRevoke,
  'scope-attestation': ScopeAttestation,
  // ── webchat-scoped remote AgentConnect MCP grants ──
  'webchat/mcp-grant/issue': WebchatMcpGrantIssue,
  'webchat/mcp-grant/issued': WebchatMcpGrantIssued,
  'webchat/mcp-grant/accept': WebchatMcpGrantAccept,
  'webchat/mcp-grant/activate': WebchatMcpGrantActivate,
  'webchat/mcp-grant/revoke': WebchatMcpGrantRevoke,
  'webchat/mcp-grant/revoked': WebchatMcpGrantRevoked,
  // ── dashboard / facts ──
  'event/session': EventSession,
  // Durable latest-wins metadata snapshot — D→C REQ, replied with `ack`.
  'event/session-sync': EventSession,
  'event/session-activity': SessionActivity,
  // Retention-GC receipt (#485) — D→C REQ, replied with the generic `ack`.
  'event/session-purged': SessionPurged,
  'usage/report': UsageReport,
  'facts/runtime-profile': FactsRuntimeProfile,
  'facts/daemon-runtimes': DaemonRuntimes,
  'facts/memory-connections': MemoryConnectionFacts,
  // ── session read-back (console history pull) ──
  'session/list': SessionListReq,
  'session/list/page': SessionListPage,
  'session/history': SessionHistoryReq,
  'session/history/page': SessionHistoryPage,
  'session/tool-body': SessionToolBodyReq,
  'session/tool-body/chunk': SessionToolBodyChunk,
  // ── child-session status (session-concept §5.4). Two legs: D→C asks the CP (the placement
  // authority) about a child on another daemon; C→D forwards the lineage pair to the OWNING
  // daemon, which authorizes it. Metadata only — the CP never persists the answer.
  'session/child-status': ChildSessionStatusReq,
  'session/child-status/ok': ChildSessionStatus,
  'session/child-status/probe': ChildSessionStatusProbe,
  'session/child-status/probe/ok': ChildSessionStatus,
  // ── session visibility gate push (session-visibility.md §5.1). C→D REQs: a single
  // per-session push (reply: typed `session/visibility/ok`) and the register-time
  // snapshot replay (reply: generic `ack`). Rev-fenced in the payload — a stale rev
  // is acked `superseded`, never answered with an error frame.
  'session/visibility': SessionVisibilityPush,
  'session/visibility/ok': SessionVisibilityOk,
  'session/visibility/snapshot': SessionVisibilitySnapshot,
  'session/pull-request-feedback': SessionPullRequestFeedback,
  'session/pull-request-feedback/result': SessionPullRequestFeedbackResult,
  // ── channel agent directory (agent collaboration; D→C REQ → REP) ──
  'channel/agents': ChannelAgentsReq,
  'channel/agents/ok': ChannelAgentsOk,
  // ── workspace files (console live access; bytes transit, never stored) ──
  'workspace/list': WorkspaceListReq,
  'workspace/list/page': WorkspaceListPage,
  'workspace/read': WorkspaceReadReq,
  'workspace/read/content': WorkspaceReadContent,
  'workspace/write': WorkspaceWriteReq,
  'workspace/write/ok': WorkspaceWriteOk,
  'workspace/delete': WorkspaceDeleteReq,
  'workspace/delete/ok': WorkspaceDeleteOk,
  'workspace/gitstatus': WorkspaceGitStatusReq,
  'workspace/gitstatus/result': WorkspaceGitStatus,
  'workspace/gitdiff': WorkspaceGitDiffReq,
  'workspace/gitdiff/result': WorkspaceGitDiffResult,
  'workspace/gitlog': WorkspaceGitLogReq,
  'workspace/gitlog/result': WorkspaceGitLog,
  'workspace/gitpull': WorkspaceGitPullReq,
  'workspace/gitpull/result': WorkspaceGitPullResult,
  // ── workspace git writes: stage/unstage answer with the FRESH status; commit/push
  // report a refusal as DATA (`ok:false` + `reason`), never as an error frame.
  'workspace/gitstage': WorkspaceGitStageReq,
  'workspace/gitstage/result': WorkspaceGitStatus,
  'workspace/gitunstage': WorkspaceGitStageReq,
  'workspace/gitunstage/result': WorkspaceGitStatus,
  'workspace/gitcommit': WorkspaceGitCommitReq,
  'workspace/gitcommit/result': WorkspaceGitCommitResult,
  'workspace/gitpush': WorkspaceGitPushReq,
  'workspace/gitpush/result': WorkspaceGitPushResult,
  // ── AI commit message: a bounded model pass on the DAEMON's runtime, no write of any kind.
  'workspace/gitmessage': WorkspaceGitMessageReq,
  'workspace/gitmessage/result': WorkspaceGitMessageResult,
  // ── background tasks: a read of the daemon's in-memory lease. No cancel frame — see task.ts.
  'task/list': TaskListReq,
  'task/list/result': TaskList,
  // ── merge-when-ready: arm/read the EDGE's in-memory watcher. Nothing is stored on either side.
  'automerge/set': AutoMergeSetReq,
  'automerge/set/result': AutoMergeState,
  'automerge/state': AutoMergeStateReq,
  'automerge/state/result': AutoMergeState,
  // ── sandbox keep-alive: an open console page renewing a lease on its agent's pod.
  'sandbox/keepalive': SandboxKeepAliveReq,
  'sandbox/keepalive/result': SandboxKeepAlive,
  'memory/channels': MemoryChannelsReq,
  'memory/channels/page': MemoryChannelsPage,
  'memory/list': MemoryListReq,
  'memory/list/page': MemoryListPage,
  'memory/read': MemoryReadReq,
  'memory/read/content': MemoryReadContent,
  'memory/write': MemoryWriteReq,
  'memory/write/ok': MemoryWriteOk,
  'memory/history': MemoryHistoryReq,
  'memory/history/page': MemoryHistoryPage,
  'memory/surface': MemorySurfaceReq,
  'memory/surface/info': MemorySurfaceInfo,
  'memory/record/search': MemoryRecordSearchReq,
  'memory/record/search/page': MemoryRecordSearchPage,
  'memory/record/list': MemoryRecordListReq,
  'memory/record/list/page': MemoryRecordListPage,
  'memory/record/get': MemoryRecordGetReq,
  'memory/record/get/result': MemoryRecordGetResult,
  'memory/record/create': MemoryRecordCreateReq,
  'memory/record/create/result': MemoryRecordCreateResult,
  'memory/record/update': MemoryRecordUpdateReq,
  'memory/record/update/result': MemoryRecordUpdateResult,
  'memory/record/delete': MemoryRecordDeleteReq,
  'memory/record/delete/result': MemoryRecordDeleteResult,
  'memory/record/history': MemoryRecordHistoryReq,
  'memory/record/history/page': MemoryRecordHistoryPage,
  // ── memory dreaming (managed-store consolidation jobs; REPs carry DreamState) ──
  'memory/dream/start': DreamStartReq,
  'memory/dream/start/ok': DreamState,
  'memory/dream/cancel': DreamCancelReq,
  'memory/dream/cancel/ok': DreamState,
  'memory/dream/list': DreamListReq,
  'memory/dream/list/page': DreamListPage,
  'memory/dream/get': DreamGetReq,
  'memory/dream/get/result': DreamState,
  'memory/dream/adopt': DreamAdoptReq,
  'memory/dream/adopt/ok': DreamState,
  'memory/dream/discard': DreamDiscardReq,
  'memory/dream/discard/ok': DreamState,
  'memory/dream/files': DreamFilesReq,
  'memory/dream/files/page': DreamFilesPage,
  'memory/dream/file/read': DreamFileReadReq,
  'memory/dream/file/read/content': DreamFileReadContent,
  'memory/dream/skill/read': DreamSkillReadReq,
  'memory/dream/skill/read/ok': DreamSkillContent,
  'memory/dream/skill/accept': DreamSkillReviewReq,
  'memory/dream/skill/accept/ok': DreamState,
  'memory/dream/skill/dismiss': DreamSkillReviewReq,
  'memory/dream/skill/dismiss/ok': DreamState,
  'skills/local': LocalSkillsReq,
  'skills/local/list': LocalSkillsList,
  'runtime/commands': RuntimeCommandsReq,
  'runtime/commands/list': RuntimeCommandsList,
  // ── organization knowledge + managed skills ──
  'knowledge/search': KnowledgeSearchReq,
  'knowledge/search/ok': KnowledgeSearchOk,
  'knowledge/list': KnowledgeListReq,
  'knowledge/list/ok': KnowledgeListOk,
  'skills/org': OrgSkillsReq,
  'skills/org/ok': OrgSkillsOk,
  'knowledge/suggestions/sync': OrganizationSuggestionsSyncReq,
  'knowledge/suggestions/sync/ok': OrganizationSuggestionsSyncOk,
  'knowledge/suggestion/read': OrganizationSuggestionReadReq,
  'knowledge/suggestion/content': OrganizationSuggestionChunk,
  'knowledge/suggestion/review': OrganizationSuggestionReviewReq,
  'managed-skill/read': ManagedSkillReadReq,
  'managed-skill/chunk': ManagedSkillChunk,
  // ── fleet / config ──
  'config/push': ConfigPush,
  'daemon/bootstrap/result': DaemonBootstrapResult,
  'daemon/restart': DaemonRestart,
  'daemon/upgrade': DaemonUpgrade,
  // ── generic replies ──
  'daemon/control/ack': DaemonControlAck,
  ack: Ack,
  // ── error ──
  error: ErrorFrame
} as const

/** Union of every legal `type` discriminator on the wire. */
export type FrameType = keyof typeof FRAME_SCHEMAS

/** All frame `type` strings, as a runtime array (used by guards / tests). */
export const FRAME_TYPES = Object.keys(FRAME_SCHEMAS) as FrameType[]

/**
 * Builds the envelope schema for one frame `type` with a `type` literal and the
 * typed payload, so the discriminated union infers `payload` precisely.
 *
 * Kept as a local generic (payload pinned to `FRAME_SCHEMAS[T]`) so a
 * mispaired member — `frame('auth', FRAME_SCHEMAS['register'])` — is a compile
 * error; a bare `frameSchema` alias would accept it. The body is deliberately
 * inlined rather than delegated: `return frameSchema(type, payload)` under
 * THIS generic signature collapses every union member's `payload` to `unknown`
 * (113 × TS18046 under TS 6.0.3 / zod 4.4.3 — reproducible by making exactly
 * that substitution), while the small relay unions call `frameSchema` with
 * concrete schemas and infer fine.
 */
function frame<T extends FrameType>(type: T, payload: (typeof FRAME_SCHEMAS)[T]) {
  return z.object({
    v: z.literal(1),
    id: z.string().uuid(),
    ts: z.string().datetime(),
    type: z.literal(type),
    corr: z.string().uuid().optional(),
    orgId: z.string().min(1).max(64).optional(),
    payload
  })
}

/**
 * `AnyFrame` — the discriminated union over `type` of every fully-validated
 * frame (envelope + typed payload). This is the runtime guard at the socket
 * edge and the precise inferred type the handlers switch on.
 */
export const AnyFrame = z.discriminatedUnion('type', [
  frame('auth', FRAME_SCHEMAS['auth']),
  frame('auth/ok', FRAME_SCHEMAS['auth/ok']),
  frame('register', FRAME_SCHEMAS['register']),
  frame('register/ok', FRAME_SCHEMAS['register/ok']),
  frame('capabilities/update', FRAME_SCHEMAS['capabilities/update']),
  frame('relay/roster', FRAME_SCHEMAS['relay/roster']),
  frame('collaboration/routes', FRAME_SCHEMAS['collaboration/routes']),
  frame('heartbeat', FRAME_SCHEMAS['heartbeat']),
  frame('duty/grant', FRAME_SCHEMAS['duty/grant']),
  frame('duty/renewed', FRAME_SCHEMAS['duty/renewed']),
  frame('duty/revoke', FRAME_SCHEMAS['duty/revoke']),
  frame('duty/release', FRAME_SCHEMAS['duty/release']),
  frame('duty/claim', FRAME_SCHEMAS['duty/claim']),
  frame('duty/claim/ok', FRAME_SCHEMAS['duty/claim/ok']),
  frame('duty/fetch', FRAME_SCHEMAS['duty/fetch']),
  frame('duty/fetch/ok', FRAME_SCHEMAS['duty/fetch/ok']),
  frame('agent/launch', FRAME_SCHEMAS['agent/launch']),
  frame('agent/launched', FRAME_SCHEMAS['agent/launched']),
  frame('agent/stop', FRAME_SCHEMAS['agent/stop']),
  frame('agent/upsert', FRAME_SCHEMAS['agent/upsert']),
  frame('agent/remove', FRAME_SCHEMAS['agent/remove']),
  frame('agent/exists', FRAME_SCHEMAS['agent/exists']),
  frame('agent/exists/ok', FRAME_SCHEMAS['agent/exists/ok']),
  frame('agent/detach', FRAME_SCHEMAS['agent/detach']),
  frame('agent/activate', FRAME_SCHEMAS['agent/activate']),
  frame('agent/activity', FRAME_SCHEMAS['agent/activity']),
  frame('agent/scope-denied', FRAME_SCHEMAS['agent/scope-denied']),
  frame('agent/permission-requests', FRAME_SCHEMAS['agent/permission-requests']),
  frame('agent/permission-requests/page', FRAME_SCHEMAS['agent/permission-requests/page']),
  frame('agent/permission-decision', FRAME_SCHEMAS['agent/permission-decision']),
  frame('agent/approval-route', FRAME_SCHEMAS['agent/approval-route']),
  frame('agent/approval-routed', FRAME_SCHEMAS['agent/approval-routed']),
  frame('agent/wake', FRAME_SCHEMAS['agent/wake']),
  frame('agent/wake/ok', FRAME_SCHEMAS['agent/wake/ok']),
  // ── routing and daemon control ──
  frame('route/assign', FRAME_SCHEMAS['route/assign']),
  frame('route/assign/ack', FRAME_SCHEMAS['route/assign/ack']),
  frame('route/update', FRAME_SCHEMAS['route/update']),
  frame('daemon/drain', FRAME_SCHEMAS['daemon/drain']),
  frame('drain/progress', FRAME_SCHEMAS['drain/progress']),
  frame('drain/done', FRAME_SCHEMAS['drain/done']),
  frame('cron/upsert', FRAME_SCHEMAS['cron/upsert']),
  frame('cron/remove', FRAME_SCHEMAS['cron/remove']),
  frame('cron/report', FRAME_SCHEMAS['cron/report']),
  frame('cron/run', FRAME_SCHEMAS['cron/run']),
  frame('hook/report', FRAME_SCHEMAS['hook/report']),
  frame('hook/start', FRAME_SCHEMAS['hook/start']),
  frame('hook/start/ok', FRAME_SCHEMAS['hook/start/ok']),
  frame('github/review-authorize', FRAME_SCHEMAS['github/review-authorize']),
  frame('github/review-authorized', FRAME_SCHEMAS['github/review-authorized']),
  frame('github/review-result', FRAME_SCHEMAS['github/review-result']),
  frame('github/review-result/ok', FRAME_SCHEMAS['github/review-result/ok']),
  frame('codehost/note-desired', FRAME_SCHEMAS['codehost/note-desired']),
  frame('codehost/note-result', FRAME_SCHEMAS['codehost/note-result']),
  frame('codehost/note-result/ok', FRAME_SCHEMAS['codehost/note-result/ok']),
  frame('codehost/review-authz', FRAME_SCHEMAS['codehost/review-authz']),
  frame('codehost/review-authz/result', FRAME_SCHEMAS['codehost/review-authz/result']),
  frame('codehost/review-op', FRAME_SCHEMAS['codehost/review-op']),
  frame('codehost/review-op/ok', FRAME_SCHEMAS['codehost/review-op/ok']),
  frame('codehost/review-lease-renew', FRAME_SCHEMAS['codehost/review-lease-renew']),
  frame('codehost/review-lease-renew/ok', FRAME_SCHEMAS['codehost/review-lease-renew/ok']),
  frame('codehost/review-result', FRAME_SCHEMAS['codehost/review-result']),
  frame('codehost/review-result/ok', FRAME_SCHEMAS['codehost/review-result/ok']),
  frame('integration/upsert', FRAME_SCHEMAS['integration/upsert']),
  frame('integration/remove', FRAME_SCHEMAS['integration/remove']),
  frame('integration/channels', FRAME_SCHEMAS['integration/channels']),
  frame('integration/forget', FRAME_SCHEMAS['integration/forget']),
  frame('integration/leave', FRAME_SCHEMAS['integration/leave']),
  frame('integration/leave/ok', FRAME_SCHEMAS['integration/leave/ok']),
  frame('mcpserver/upsert', FRAME_SCHEMAS['mcpserver/upsert']),
  frame('mcpserver/remove', FRAME_SCHEMAS['mcpserver/remove']),
  frame('memoryconnection/upsert', FRAME_SCHEMAS['memoryconnection/upsert']),
  frame('memoryconnection/remove', FRAME_SCHEMAS['memoryconnection/remove']),
  frame('gitcred/request', FRAME_SCHEMAS['gitcred/request']),
  frame('gitcred/grant', FRAME_SCHEMAS['gitcred/grant']),
  frame('linearcred/request', FRAME_SCHEMAS['linearcred/request']),
  frame('linearcred/grant', FRAME_SCHEMAS['linearcred/grant']),
  frame('secrets/request', FRAME_SCHEMAS['secrets/request']),
  frame('secrets/grant', FRAME_SCHEMAS['secrets/grant']),
  frame('secrets/renew', FRAME_SCHEMAS['secrets/renew']),
  frame('secrets/revoke', FRAME_SCHEMAS['secrets/revoke']),
  frame('scope-attestation', FRAME_SCHEMAS['scope-attestation']),
  frame('webchat/mcp-grant/issue', FRAME_SCHEMAS['webchat/mcp-grant/issue']),
  frame('webchat/mcp-grant/issued', FRAME_SCHEMAS['webchat/mcp-grant/issued']),
  frame('webchat/mcp-grant/accept', FRAME_SCHEMAS['webchat/mcp-grant/accept']),
  frame('webchat/mcp-grant/activate', FRAME_SCHEMAS['webchat/mcp-grant/activate']),
  frame('webchat/mcp-grant/revoke', FRAME_SCHEMAS['webchat/mcp-grant/revoke']),
  frame('webchat/mcp-grant/revoked', FRAME_SCHEMAS['webchat/mcp-grant/revoked']),
  frame('event/session', FRAME_SCHEMAS['event/session']),
  frame('event/session-sync', FRAME_SCHEMAS['event/session-sync']),
  frame('event/session-activity', FRAME_SCHEMAS['event/session-activity']),
  frame('event/session-purged', FRAME_SCHEMAS['event/session-purged']),
  frame('usage/report', FRAME_SCHEMAS['usage/report']),
  frame('facts/runtime-profile', FRAME_SCHEMAS['facts/runtime-profile']),
  frame('facts/daemon-runtimes', FRAME_SCHEMAS['facts/daemon-runtimes']),
  frame('facts/memory-connections', FRAME_SCHEMAS['facts/memory-connections']),
  frame('session/list', FRAME_SCHEMAS['session/list']),
  frame('session/list/page', FRAME_SCHEMAS['session/list/page']),
  frame('session/history', FRAME_SCHEMAS['session/history']),
  frame('session/history/page', FRAME_SCHEMAS['session/history/page']),
  frame('session/tool-body', FRAME_SCHEMAS['session/tool-body']),
  frame('session/tool-body/chunk', FRAME_SCHEMAS['session/tool-body/chunk']),
  frame('session/child-status', FRAME_SCHEMAS['session/child-status']),
  frame('session/child-status/ok', FRAME_SCHEMAS['session/child-status/ok']),
  frame('session/child-status/probe', FRAME_SCHEMAS['session/child-status/probe']),
  frame('session/child-status/probe/ok', FRAME_SCHEMAS['session/child-status/probe/ok']),
  frame('session/visibility', FRAME_SCHEMAS['session/visibility']),
  frame('session/visibility/ok', FRAME_SCHEMAS['session/visibility/ok']),
  frame('session/visibility/snapshot', FRAME_SCHEMAS['session/visibility/snapshot']),
  frame('session/pull-request-feedback', FRAME_SCHEMAS['session/pull-request-feedback']),
  frame('session/pull-request-feedback/result', FRAME_SCHEMAS['session/pull-request-feedback/result']),
  frame('channel/agents', FRAME_SCHEMAS['channel/agents']),
  frame('channel/agents/ok', FRAME_SCHEMAS['channel/agents/ok']),
  frame('workspace/list', FRAME_SCHEMAS['workspace/list']),
  frame('workspace/list/page', FRAME_SCHEMAS['workspace/list/page']),
  frame('workspace/read', FRAME_SCHEMAS['workspace/read']),
  frame('workspace/read/content', FRAME_SCHEMAS['workspace/read/content']),
  frame('workspace/write', FRAME_SCHEMAS['workspace/write']),
  frame('workspace/write/ok', FRAME_SCHEMAS['workspace/write/ok']),
  frame('workspace/delete', FRAME_SCHEMAS['workspace/delete']),
  frame('workspace/delete/ok', FRAME_SCHEMAS['workspace/delete/ok']),
  frame('workspace/gitstatus', FRAME_SCHEMAS['workspace/gitstatus']),
  frame('workspace/gitstatus/result', FRAME_SCHEMAS['workspace/gitstatus/result']),
  frame('workspace/gitdiff', FRAME_SCHEMAS['workspace/gitdiff']),
  frame('workspace/gitdiff/result', FRAME_SCHEMAS['workspace/gitdiff/result']),
  frame('workspace/gitlog', FRAME_SCHEMAS['workspace/gitlog']),
  frame('workspace/gitlog/result', FRAME_SCHEMAS['workspace/gitlog/result']),
  frame('workspace/gitpull', FRAME_SCHEMAS['workspace/gitpull']),
  frame('workspace/gitpull/result', FRAME_SCHEMAS['workspace/gitpull/result']),
  frame('workspace/gitstage', FRAME_SCHEMAS['workspace/gitstage']),
  frame('workspace/gitstage/result', FRAME_SCHEMAS['workspace/gitstage/result']),
  frame('workspace/gitunstage', FRAME_SCHEMAS['workspace/gitunstage']),
  frame('workspace/gitunstage/result', FRAME_SCHEMAS['workspace/gitunstage/result']),
  frame('workspace/gitcommit', FRAME_SCHEMAS['workspace/gitcommit']),
  frame('workspace/gitcommit/result', FRAME_SCHEMAS['workspace/gitcommit/result']),
  frame('workspace/gitpush', FRAME_SCHEMAS['workspace/gitpush']),
  frame('workspace/gitpush/result', FRAME_SCHEMAS['workspace/gitpush/result']),
  frame('workspace/gitmessage', FRAME_SCHEMAS['workspace/gitmessage']),
  frame('workspace/gitmessage/result', FRAME_SCHEMAS['workspace/gitmessage/result']),
  frame('task/list', FRAME_SCHEMAS['task/list']),
  frame('task/list/result', FRAME_SCHEMAS['task/list/result']),
  frame('automerge/set', FRAME_SCHEMAS['automerge/set']),
  frame('automerge/set/result', FRAME_SCHEMAS['automerge/set/result']),
  frame('automerge/state', FRAME_SCHEMAS['automerge/state']),
  frame('automerge/state/result', FRAME_SCHEMAS['automerge/state/result']),
  frame('sandbox/keepalive', FRAME_SCHEMAS['sandbox/keepalive']),
  frame('sandbox/keepalive/result', FRAME_SCHEMAS['sandbox/keepalive/result']),
  frame('memory/channels', FRAME_SCHEMAS['memory/channels']),
  frame('memory/channels/page', FRAME_SCHEMAS['memory/channels/page']),
  frame('memory/list', FRAME_SCHEMAS['memory/list']),
  frame('memory/list/page', FRAME_SCHEMAS['memory/list/page']),
  frame('memory/read', FRAME_SCHEMAS['memory/read']),
  frame('memory/read/content', FRAME_SCHEMAS['memory/read/content']),
  frame('memory/write', FRAME_SCHEMAS['memory/write']),
  frame('memory/write/ok', FRAME_SCHEMAS['memory/write/ok']),
  frame('memory/history', FRAME_SCHEMAS['memory/history']),
  frame('memory/history/page', FRAME_SCHEMAS['memory/history/page']),
  frame('memory/surface', FRAME_SCHEMAS['memory/surface']),
  frame('memory/surface/info', FRAME_SCHEMAS['memory/surface/info']),
  frame('memory/record/search', FRAME_SCHEMAS['memory/record/search']),
  frame('memory/record/search/page', FRAME_SCHEMAS['memory/record/search/page']),
  frame('memory/record/list', FRAME_SCHEMAS['memory/record/list']),
  frame('memory/record/list/page', FRAME_SCHEMAS['memory/record/list/page']),
  frame('memory/record/get', FRAME_SCHEMAS['memory/record/get']),
  frame('memory/record/get/result', FRAME_SCHEMAS['memory/record/get/result']),
  frame('memory/record/create', FRAME_SCHEMAS['memory/record/create']),
  frame('memory/record/create/result', FRAME_SCHEMAS['memory/record/create/result']),
  frame('memory/record/update', FRAME_SCHEMAS['memory/record/update']),
  frame('memory/record/update/result', FRAME_SCHEMAS['memory/record/update/result']),
  frame('memory/record/delete', FRAME_SCHEMAS['memory/record/delete']),
  frame('memory/record/delete/result', FRAME_SCHEMAS['memory/record/delete/result']),
  frame('memory/record/history', FRAME_SCHEMAS['memory/record/history']),
  frame('memory/record/history/page', FRAME_SCHEMAS['memory/record/history/page']),
  frame('memory/dream/start', FRAME_SCHEMAS['memory/dream/start']),
  frame('memory/dream/start/ok', FRAME_SCHEMAS['memory/dream/start/ok']),
  frame('memory/dream/cancel', FRAME_SCHEMAS['memory/dream/cancel']),
  frame('memory/dream/cancel/ok', FRAME_SCHEMAS['memory/dream/cancel/ok']),
  frame('memory/dream/list', FRAME_SCHEMAS['memory/dream/list']),
  frame('memory/dream/list/page', FRAME_SCHEMAS['memory/dream/list/page']),
  frame('memory/dream/get', FRAME_SCHEMAS['memory/dream/get']),
  frame('memory/dream/get/result', FRAME_SCHEMAS['memory/dream/get/result']),
  frame('memory/dream/adopt', FRAME_SCHEMAS['memory/dream/adopt']),
  frame('memory/dream/adopt/ok', FRAME_SCHEMAS['memory/dream/adopt/ok']),
  frame('memory/dream/discard', FRAME_SCHEMAS['memory/dream/discard']),
  frame('memory/dream/discard/ok', FRAME_SCHEMAS['memory/dream/discard/ok']),
  frame('memory/dream/files', FRAME_SCHEMAS['memory/dream/files']),
  frame('memory/dream/files/page', FRAME_SCHEMAS['memory/dream/files/page']),
  frame('memory/dream/file/read', FRAME_SCHEMAS['memory/dream/file/read']),
  frame('memory/dream/file/read/content', FRAME_SCHEMAS['memory/dream/file/read/content']),
  frame('memory/dream/skill/read', FRAME_SCHEMAS['memory/dream/skill/read']),
  frame('memory/dream/skill/read/ok', FRAME_SCHEMAS['memory/dream/skill/read/ok']),
  frame('memory/dream/skill/accept', FRAME_SCHEMAS['memory/dream/skill/accept']),
  frame('memory/dream/skill/accept/ok', FRAME_SCHEMAS['memory/dream/skill/accept/ok']),
  frame('memory/dream/skill/dismiss', FRAME_SCHEMAS['memory/dream/skill/dismiss']),
  frame('memory/dream/skill/dismiss/ok', FRAME_SCHEMAS['memory/dream/skill/dismiss/ok']),
  frame('skills/local', FRAME_SCHEMAS['skills/local']),
  frame('skills/local/list', FRAME_SCHEMAS['skills/local/list']),
  frame('runtime/commands', FRAME_SCHEMAS['runtime/commands']),
  frame('runtime/commands/list', FRAME_SCHEMAS['runtime/commands/list']),
  frame('knowledge/search', FRAME_SCHEMAS['knowledge/search']),
  frame('knowledge/list', FRAME_SCHEMAS['knowledge/list']),
  frame('knowledge/list/ok', FRAME_SCHEMAS['knowledge/list/ok']),
  frame('skills/org', FRAME_SCHEMAS['skills/org']),
  frame('skills/org/ok', FRAME_SCHEMAS['skills/org/ok']),
  frame('knowledge/search/ok', FRAME_SCHEMAS['knowledge/search/ok']),
  frame('knowledge/suggestions/sync', FRAME_SCHEMAS['knowledge/suggestions/sync']),
  frame('knowledge/suggestions/sync/ok', FRAME_SCHEMAS['knowledge/suggestions/sync/ok']),
  frame('knowledge/suggestion/read', FRAME_SCHEMAS['knowledge/suggestion/read']),
  frame('knowledge/suggestion/content', FRAME_SCHEMAS['knowledge/suggestion/content']),
  frame('knowledge/suggestion/review', FRAME_SCHEMAS['knowledge/suggestion/review']),
  frame('managed-skill/read', FRAME_SCHEMAS['managed-skill/read']),
  frame('managed-skill/chunk', FRAME_SCHEMAS['managed-skill/chunk']),
  frame('config/push', FRAME_SCHEMAS['config/push']),
  frame('daemon/bootstrap/result', FRAME_SCHEMAS['daemon/bootstrap/result']),
  frame('daemon/restart', FRAME_SCHEMAS['daemon/restart']),
  frame('daemon/upgrade', FRAME_SCHEMAS['daemon/upgrade']),
  frame('daemon/control/ack', FRAME_SCHEMAS['daemon/control/ack']),
  frame('ack', FRAME_SCHEMAS['ack']),
  frame('error', FRAME_SCHEMAS['error'])
])
export type AnyFrame = z.infer<typeof AnyFrame>

/** Runtime guard: is `t` a known frame `type`? */
export function isFrameType(t: string): t is FrameType {
  return Object.prototype.hasOwnProperty.call(FRAME_SCHEMAS, t)
}
