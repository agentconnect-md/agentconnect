/**
 * `FrameRouter` (design §4.6) — the flat `type → handler` dispatch table.
 *
 * Handlers are `(frame, conn, deps) => Promise<void>` with all side effects
 * through the injected services/registry/clock. Correlated REPs to CP-issued
 * REQs are settled by the `ReqRep` in `connection.ts` BEFORE dispatch, and the
 * legal-frame gate (protocol §2.1) is checked there too — so a handler only ever
 * sees a legal, fully-validated inbound frame.
 *
 * Registers `auth`, `daemon/bootstrap/result`, `register`, `heartbeat`, `facts/runtime-profile`,
 * `facts/daemon-runtimes`, `usage/report`, `integration/channels`, `cron/report`.
 * Unhandled-but-legal EVTs (telemetry that lands in later phases) are a deliberate
 * no-op (forward-compat), never an error.
 */
import type { AnyFrame, FrameType } from '@agentconnect.md/protocol'
import type { DaemonWsDeps } from '../deps.js'
// Type-only import — erased at runtime, so there is no cycle with connection.ts.
import type { DaemonConnection } from '../connection.js'
import { handleAuth } from './auth.js'
import { handleDaemonBootstrapResult } from './daemon-bootstrap-result.js'
import { handleRegister } from './register.js'
import { handleCapabilitiesUpdate } from './capabilities-update.js'
import { handleHeartbeat } from './heartbeat.js'
import { handleRuntimeProfile } from './runtime-profile.js'
import { handleDaemonRuntimes } from './daemon-runtimes.js'
import { handleMemoryConnections } from './memory-connections.js'
import { handleUsageReport } from './usage-report.js'
import { handleIntegrationChannels } from './integration-channels.js'
import { handleCronReport } from './cron-report.js'
import { handleDutyRelease } from './duty-release.js'
import { handleDutyClaim } from './duty-claim.js'
import { handleDutyFetch } from './duty-fetch.js'
import { handleAgentExists } from './agent-exists.js'
import { handleHookReport } from './hook-report.js'
import { handleChannelAgents } from './channel-agents.js'
import { handleChildSessionStatus } from './child-session-status.js'
import { handleEventSession, handleEventSessionSync } from './event-session.js'
import { handleSessionActivity } from './event-session-activity.js'
import { handleAgentActivity } from './agent-activity.js'
import { handleSessionPurged } from './event-session-purged.js'
import { handleGitCredRequest } from './gitcred.js'
import { handleLinearCredRequest } from './linearcred.js'
import { handleHookStart } from './hook-start.js'
import { handleApprovalRoute } from './approval-route.js'
import { handleGithubReviewAuthorize } from './github-review-authorize.js'
import { handleGithubReviewResult } from './github-review-result.js'
import { handleCodeHostNoteResult } from './codehost-note-result.js'
import {
  handleCodeHostReviewAuthorize,
  handleCodeHostReviewLeaseRenew,
  handleCodeHostReviewOp,
  handleCodeHostReviewResult
} from './codehost-review.js'
import {
  handleWebchatMcpGrantAccept,
  handleWebchatMcpGrantIssue,
  handleWebchatMcpGrantRevoke
} from './webchat-mcp-grant.js'
import {
  handleKnowledgeSearch,
  handleKnowledgeList,
  handleOrgSkills,
  handleManagedSkillRead,
  handleOrganizationSuggestionsSync
} from './organization-knowledge.js'

export type Handler = (frame: AnyFrame, conn: DaemonConnection, deps: DaemonWsDeps) => Promise<void>

export class FrameRouter {
  private readonly table: Partial<Record<FrameType, Handler>>

  constructor(overrides: Partial<Record<FrameType, Handler>> = {}) {
    this.table = {
      auth: handleAuth,
      'daemon/bootstrap/result': handleDaemonBootstrapResult,
      register: handleRegister,
      'capabilities/update': handleCapabilitiesUpdate,
      heartbeat: handleHeartbeat,
      'facts/runtime-profile': handleRuntimeProfile,
      'facts/daemon-runtimes': handleDaemonRuntimes,
      'facts/memory-connections': handleMemoryConnections,
      'usage/report': handleUsageReport,
      'integration/channels': handleIntegrationChannels,
      'cron/report': handleCronReport,
      'duty/release': handleDutyRelease,
      'duty/claim': handleDutyClaim,
      'duty/fetch': handleDutyFetch,
      'agent/exists': handleAgentExists,
      'hook/report': handleHookReport,
      'hook/start': handleHookStart,
      'agent/approval-route': handleApprovalRoute,
      'github/review-authorize': handleGithubReviewAuthorize,
      'github/review-result': handleGithubReviewResult,
      'codehost/note-result': handleCodeHostNoteResult,
      'codehost/review-authz': handleCodeHostReviewAuthorize,
      'codehost/review-op': handleCodeHostReviewOp,
      'codehost/review-lease-renew': handleCodeHostReviewLeaseRenew,
      'codehost/review-result': handleCodeHostReviewResult,
      'channel/agents': handleChannelAgents,
      'session/child-status': handleChildSessionStatus,
      'event/session': handleEventSession,
      'event/session-sync': handleEventSessionSync,
      'event/session-activity': handleSessionActivity,
      'agent/activity': handleAgentActivity,
      'event/session-purged': handleSessionPurged,
      'gitcred/request': handleGitCredRequest,
      'linearcred/request': handleLinearCredRequest,
      'webchat/mcp-grant/issue': handleWebchatMcpGrantIssue,
      'webchat/mcp-grant/accept': handleWebchatMcpGrantAccept,
      'webchat/mcp-grant/revoke': handleWebchatMcpGrantRevoke,
      'knowledge/search': handleKnowledgeSearch,
      'knowledge/list': handleKnowledgeList,
      'skills/org': handleOrgSkills,
      'knowledge/suggestions/sync': handleOrganizationSuggestionsSync,
      'managed-skill/read': handleManagedSkillRead,
      ...overrides
    }
  }

  /** Dispatch a legal, validated inbound frame to its handler (no-op if none). */
  async dispatch(frame: AnyFrame, conn: DaemonConnection, deps: DaemonWsDeps): Promise<void> {
    const handler = this.table[frame.type as FrameType]
    if (handler) await handler(frame, conn, deps)
  }
}

export {
  handleAuth,
  handleDaemonBootstrapResult,
  handleRegister,
  handleCapabilitiesUpdate,
  handleHeartbeat,
  handleRuntimeProfile,
  handleDaemonRuntimes,
  handleMemoryConnections,
  handleUsageReport,
  handleIntegrationChannels,
  handleCronReport,
  handleHookReport,
  handleHookStart,
  handleApprovalRoute,
  handleGithubReviewAuthorize,
  handleGithubReviewResult,
  handleCodeHostNoteResult,
  handleCodeHostReviewAuthorize,
  handleCodeHostReviewOp,
  handleCodeHostReviewLeaseRenew,
  handleCodeHostReviewResult,
  handleChannelAgents,
  handleChildSessionStatus,
  handleEventSession,
  handleEventSessionSync,
  handleSessionActivity,
  handleAgentActivity,
  handleSessionPurged,
  handleWebchatMcpGrantIssue,
  handleWebchatMcpGrantAccept,
  handleWebchatMcpGrantRevoke,
  handleKnowledgeSearch,
  handleOrganizationSuggestionsSync,
  handleManagedSkillRead
}
