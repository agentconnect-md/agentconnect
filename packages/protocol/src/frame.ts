import { z } from 'zod'

import { AuthReq, AuthOk } from './frames/auth.js'
import { RegisterReq, RegisterOk, RelayRosterUpdate } from './frames/register.js'
import { CollabRoutesSnapshot } from './frames/collab.js'
import { RouteAssign, RouteAssignAck, RouteUpdate, Drain, DrainProgress, DrainDone } from './frames/route.js'
import {
  AgentLaunch,
  AgentLaunched,
  AgentStop,
  AgentUpsert,
  AgentRemove,
  AgentDetach,
  AgentActivate,
  AgentActivity,
  AgentScopeDenied,
  AgentPermissionRequestList,
  AgentPermissionRequestPage,
  AgentPermissionDecision
} from './frames/agent.js'
import { CronUpsert, CronRemove, CronReport, CronRunNow } from './frames/cron.js'
import {
  GithubReviewAuthorize,
  GithubReviewAuthorized,
  GithubReviewResultOk,
  GithubReviewResultReport,
  HookReport,
  HookStart,
  HookStartOk
} from './frames/hook.js'
import { IntegrationUpsert, IntegrationRemove, IntegrationChannels } from './frames/integration.js'
import { McpServerUpsert, McpServerRemove } from './frames/mcpserver.js'
import { MemoryConnectionUpsert, MemoryConnectionRemove, MemoryConnectionFacts } from './frames/memory-connection.js'
import { GitCredRequest, GitCredGrant } from './frames/gitcred.js'
import { SecretsRequest, SecretsGrant, SecretsRenew, SecretsRevoke, ScopeAttestation } from './frames/secrets.js'
import {
  SessionHistoryReq,
  SessionHistoryPage,
  SessionListReq,
  SessionListPage,
  SessionToolBodyReq,
  SessionToolBodyChunk
} from './frames/session.js'
import { ChannelAgentsReq, ChannelAgentsOk } from './frames/channel.js'
import {
  WorkspaceListReq,
  WorkspaceListPage,
  WorkspaceReadReq,
  WorkspaceReadContent,
  WorkspaceGitStatusReq,
  WorkspaceGitStatus,
  WorkspaceGitPullReq,
  WorkspaceGitPullResult
} from './frames/workspace.js'
import {
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
  MemoryRecordHistoryPage
} from './frames/memory.js'
import {
  Heartbeat,
  EventSession,
  UsageReport,
  FactsRuntimeProfile,
  DaemonRuntimes,
  ConfigPush,
  DaemonRestart,
  DaemonUpgrade,
  DaemonControlAck,
  Ack
} from './frames/telemetry.js'
import { ErrorFrame } from './frames/error.js'
// webchat CONTENT frames were retired in milestone A4 — content rides the relay's rd/*
// wire now, not the daemon↔CP control WS. The reply-payload schemas live on in
// frames/webchat.ts (reused by rd/chat), but none are registered as control-WS frames.

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
  // ── relay roster (C→D hot update of register/ok.relays) ──
  'relay/roster': RelayRosterUpdate,
  // ── collaboration routing snapshot (C→D hot push; baseline in register/ok) ──
  'collaboration/routes': CollabRoutesSnapshot,
  // ── telemetry ──
  heartbeat: Heartbeat,
  // ── agent lifecycle / delivery ──
  'agent/launch': AgentLaunch,
  'agent/launched': AgentLaunched,
  'agent/stop': AgentStop,
  'agent/upsert': AgentUpsert,
  'agent/remove': AgentRemove,
  'agent/detach': AgentDetach,
  'agent/activate': AgentActivate,
  'agent/activity': AgentActivity,
  'agent/scope-denied': AgentScopeDenied,
  'agent/permission-requests': AgentPermissionRequestList,
  'agent/permission-requests/page': AgentPermissionRequestPage,
  'agent/permission-decision': AgentPermissionDecision,
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
  // ── integrations (platform config distribution; token-bearing — never log) ──
  'integration/upsert': IntegrationUpsert,
  'integration/remove': IntegrationRemove,
  'integration/channels': IntegrationChannels,
  // ── MCP provider registry (CP-owned defs pushed to daemons; grant-key-bearing — never log) ──
  'mcpserver/upsert': McpServerUpsert,
  'mcpserver/remove': McpServerRemove,
  // ── external-memory connection registry (grant-bearing; never log) ──
  'memoryconnection/upsert': MemoryConnectionUpsert,
  'memoryconnection/remove': MemoryConnectionRemove,
  // ── git credentials (github-app workspaces; token-bearing — never log) ──
  'gitcred/request': GitCredRequest,
  'gitcred/grant': GitCredGrant,
  // ── secrets ──
  'secrets/request': SecretsRequest,
  'secrets/grant': SecretsGrant,
  'secrets/renew': SecretsRenew,
  'secrets/revoke': SecretsRevoke,
  'scope-attestation': ScopeAttestation,
  // ── dashboard / facts ──
  'event/session': EventSession,
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
  // ── channel agent directory (agent collaboration; D→C REQ → REP) ──
  'channel/agents': ChannelAgentsReq,
  'channel/agents/ok': ChannelAgentsOk,
  // ── workspace file browsing (console live pull; bytes transit, never stored) ──
  'workspace/list': WorkspaceListReq,
  'workspace/list/page': WorkspaceListPage,
  'workspace/read': WorkspaceReadReq,
  'workspace/read/content': WorkspaceReadContent,
  'workspace/gitstatus': WorkspaceGitStatusReq,
  'workspace/gitstatus/result': WorkspaceGitStatus,
  'workspace/gitpull': WorkspaceGitPullReq,
  'workspace/gitpull/result': WorkspaceGitPullResult,
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
  // ── fleet / config ──
  'config/push': ConfigPush,
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
  frame('relay/roster', FRAME_SCHEMAS['relay/roster']),
  frame('collaboration/routes', FRAME_SCHEMAS['collaboration/routes']),
  frame('heartbeat', FRAME_SCHEMAS['heartbeat']),
  frame('agent/launch', FRAME_SCHEMAS['agent/launch']),
  frame('agent/launched', FRAME_SCHEMAS['agent/launched']),
  frame('agent/stop', FRAME_SCHEMAS['agent/stop']),
  frame('agent/upsert', FRAME_SCHEMAS['agent/upsert']),
  frame('agent/remove', FRAME_SCHEMAS['agent/remove']),
  frame('agent/detach', FRAME_SCHEMAS['agent/detach']),
  frame('agent/activate', FRAME_SCHEMAS['agent/activate']),
  frame('agent/activity', FRAME_SCHEMAS['agent/activity']),
  frame('agent/scope-denied', FRAME_SCHEMAS['agent/scope-denied']),
  frame('agent/permission-requests', FRAME_SCHEMAS['agent/permission-requests']),
  frame('agent/permission-requests/page', FRAME_SCHEMAS['agent/permission-requests/page']),
  frame('agent/permission-decision', FRAME_SCHEMAS['agent/permission-decision']),
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
  frame('integration/upsert', FRAME_SCHEMAS['integration/upsert']),
  frame('integration/remove', FRAME_SCHEMAS['integration/remove']),
  frame('integration/channels', FRAME_SCHEMAS['integration/channels']),
  frame('mcpserver/upsert', FRAME_SCHEMAS['mcpserver/upsert']),
  frame('mcpserver/remove', FRAME_SCHEMAS['mcpserver/remove']),
  frame('memoryconnection/upsert', FRAME_SCHEMAS['memoryconnection/upsert']),
  frame('memoryconnection/remove', FRAME_SCHEMAS['memoryconnection/remove']),
  frame('gitcred/request', FRAME_SCHEMAS['gitcred/request']),
  frame('gitcred/grant', FRAME_SCHEMAS['gitcred/grant']),
  frame('secrets/request', FRAME_SCHEMAS['secrets/request']),
  frame('secrets/grant', FRAME_SCHEMAS['secrets/grant']),
  frame('secrets/renew', FRAME_SCHEMAS['secrets/renew']),
  frame('secrets/revoke', FRAME_SCHEMAS['secrets/revoke']),
  frame('scope-attestation', FRAME_SCHEMAS['scope-attestation']),
  frame('event/session', FRAME_SCHEMAS['event/session']),
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
  frame('channel/agents', FRAME_SCHEMAS['channel/agents']),
  frame('channel/agents/ok', FRAME_SCHEMAS['channel/agents/ok']),
  frame('workspace/list', FRAME_SCHEMAS['workspace/list']),
  frame('workspace/list/page', FRAME_SCHEMAS['workspace/list/page']),
  frame('workspace/read', FRAME_SCHEMAS['workspace/read']),
  frame('workspace/read/content', FRAME_SCHEMAS['workspace/read/content']),
  frame('workspace/gitstatus', FRAME_SCHEMAS['workspace/gitstatus']),
  frame('workspace/gitstatus/result', FRAME_SCHEMAS['workspace/gitstatus/result']),
  frame('workspace/gitpull', FRAME_SCHEMAS['workspace/gitpull']),
  frame('workspace/gitpull/result', FRAME_SCHEMAS['workspace/gitpull/result']),
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
  frame('config/push', FRAME_SCHEMAS['config/push']),
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
