/**
 * `FrameRouter` (design §4.6) — the flat `type → handler` dispatch table.
 *
 * Handlers are `(frame, conn, deps) => Promise<void>` with all side effects
 * through the injected services/registry/clock. Correlated REPs to CP-issued
 * REQs are settled by the `ReqRep` in `connection.ts` BEFORE dispatch, and the
 * legal-frame gate (protocol §2.1) is checked there too — so a handler only ever
 * sees a legal, fully-validated inbound frame.
 *
 * Registers `auth`, `register`, `heartbeat`, `facts/runtime-profile`,
 * `facts/daemon-runtimes`, `usage/report`, `integration/channels`, `cron/report`.
 * Unhandled-but-legal EVTs (telemetry that lands in later phases) are a deliberate
 * no-op (forward-compat), never an error.
 */
import type { AnyFrame, FrameType } from '@agentconnect.md/protocol'
import type { DaemonWsDeps } from '../deps.js'
// Type-only import — erased at runtime, so there is no cycle with connection.ts.
import type { DaemonConnection } from '../connection.js'
import { handleAuth } from './auth.js'
import { handleRegister } from './register.js'
import { handleHeartbeat } from './heartbeat.js'
import { handleRuntimeProfile } from './runtime-profile.js'
import { handleDaemonRuntimes } from './daemon-runtimes.js'
import { handleMemoryConnections } from './memory-connections.js'
import { handleUsageReport } from './usage-report.js'
import { handleIntegrationChannels } from './integration-channels.js'
import { handleCronReport } from './cron-report.js'
import { handleHookReport } from './hook-report.js'
import { handleChannelAgents } from './channel-agents.js'
import { handleEventSession } from './event-session.js'
import { handleSessionActivity } from './event-session-activity.js'
import { handleGitCredRequest } from './gitcred.js'
import { handleHookStart } from './hook-start.js'
import { handleGithubReviewAuthorize } from './github-review-authorize.js'
import { handleGithubReviewResult } from './github-review-result.js'

export type Handler = (frame: AnyFrame, conn: DaemonConnection, deps: DaemonWsDeps) => Promise<void>

export class FrameRouter {
  private readonly table: Partial<Record<FrameType, Handler>>

  constructor(overrides: Partial<Record<FrameType, Handler>> = {}) {
    this.table = {
      auth: handleAuth,
      register: handleRegister,
      heartbeat: handleHeartbeat,
      'facts/runtime-profile': handleRuntimeProfile,
      'facts/daemon-runtimes': handleDaemonRuntimes,
      'facts/memory-connections': handleMemoryConnections,
      'usage/report': handleUsageReport,
      'integration/channels': handleIntegrationChannels,
      'cron/report': handleCronReport,
      'hook/report': handleHookReport,
      'hook/start': handleHookStart,
      'github/review-authorize': handleGithubReviewAuthorize,
      'github/review-result': handleGithubReviewResult,
      'channel/agents': handleChannelAgents,
      'event/session': handleEventSession,
      'event/session-activity': handleSessionActivity,
      'gitcred/request': handleGitCredRequest,
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
  handleRegister,
  handleHeartbeat,
  handleRuntimeProfile,
  handleDaemonRuntimes,
  handleMemoryConnections,
  handleUsageReport,
  handleIntegrationChannels,
  handleCronReport,
  handleHookReport,
  handleHookStart,
  handleGithubReviewAuthorize,
  handleGithubReviewResult,
  handleChannelAgents,
  handleEventSession,
  handleSessionActivity
}
