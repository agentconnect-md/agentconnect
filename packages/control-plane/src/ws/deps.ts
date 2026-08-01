/**
 * `DaemonWsDeps` — the dependency bundle every connection actor and frame
 * handler receives (design §2.4 `createDaemonWsServer(app, deps)`).
 *
 * It is the composition-root's view of the WS edge: the C4 auth/registry
 * services, the C3 reconcile service, the in-memory connection index, the clock,
 * and the config slice the FSM needs. Kept in its own module so `connection.ts`
 * and `handlers/*` share the type without a cycle.
 *
 * Grows per phase: secrets/watchdog/full-orchestrator deps join in Phase 3.
 */
import type { DaemonAuth, DaemonRegistry } from '../ports.js'
import type {
  SessionUsageRepo,
  SessionRepo,
  IntegrationRepo,
  IntegrationChannelRepo,
  CronRepo,
  HookRepo,
  AgentRepo,
  ExternalMemoryConnectionRepo,
  WebchatConversationRepo,
  LaunchRepo,
  OrganizationKnowledgeRepo,
  BotRepo,
  GithubInstallationRepo
} from '../persistence/ports.js'
import type { SessionVisibilityPushService } from '../orchestrator/visibilityPush.js'
import type { RelayRosterEntry } from '@agentconnect.md/protocol'
import type { GithubService } from '../github/service.js'
import type { GithubReviewBrokerService } from '../github/review-broker.service.js'
import type { GithubRunCoordinator } from '../github/run-reporter.js'
import type { ReconcileService } from '../orchestrator/placement.js'
import type { ConnectionRegistry } from './registry.js'
import type { Clock } from '../domain/clock.js'
import type { SessionEventSink } from '../events/sink.js'
import type { AgentMutationGate } from '../orchestrator/agentMutationGate.js'
import type { CollabRoutesService } from '../orchestrator/collabRoutes.service.js'
import type { AgentId, DaemonId } from '../domain/ids.js'
import type { WebchatRemoteMcpService } from '../registry/webchatRemoteMcpService.js'

/** Config slice the WS edge reads. */
export interface WsConfig {
  HEARTBEAT_SEC: number
  ACK_TIMEOUT_MS: number
  /** The path the daemon socket is mounted at (default `/daemon/ws`). */
  WS_PATH?: string
}

export interface DaemonWsDeps {
  auth: DaemonAuth
  registry: DaemonRegistry
  orchestrator: ReconcileService
  connReg: ConnectionRegistry
  /** Persists per-session token usage from the `usage/report` EVT (dashboard telemetry). */
  sessionUsage: SessionUsageRepo
  /** Persists session milestones from the `event/session` EVT (deep-link metadata sync). */
  session: SessionRepo
  /** Resolves a webchat conversation's owning user for session-visibility ingest
   *  (session-visibility.md §4.2); absent ⇒ webchat sessions record no owner
   *  (null — visible to no one until a repair/backfill). */
  webchatConversation?: WebchatConversationRepo
  /** Confidential two-phase grant lifecycle for session-scoped remote MCP. */
  webchatRemoteMcp?: Pick<WebchatRemoteMcpService, 'issue' | 'accept' | 'revoke'>
  /** Resolves Web API launch provenance for the same classification (§4.4). */
  launch?: LaunchRepo
  /** Pushes the CP-confirmed capture gate to the owning daemon (§5.1); absent ⇒
   *  daemons converge on their next register snapshot instead. */
  visibilityPush?: SessionVisibilityPushService
  /** Publishes persisted session milestones to the WebUI SSE feed. */
  events: SessionEventSink
  /** Ownership check for the `integration/channels` EVT (integration → daemon scope). */
  integration: IntegrationRepo
  /** Validates a daemon-reported external credential locator before a Session
   *  is bound to its immutable provider scope. */
  bot?: BotRepo
  /** Resolves a trusted GitHub delivery's installation id to this org's
   * durable credential locator before binding a repository ExternalScope. */
  githubInstallation?: GithubInstallationRepo
  /** Persists authoritative membership snapshots and partial conversation reports. */
  integrationChannel: IntegrationChannelRepo
  /** Shares the HTTP agent-move boundary with daemon-originated conversation reports. */
  agentMutations: AgentMutationGate
  /** Resumes durable move tombstones advertised by a reconnecting daemon. */
  recoverStagedAgent: (agentId: AgentId, daemonId: DaemonId, moveId: string) => Promise<void>
  /** Refreshes relay and daemon collaboration snapshots after accepted conversation changes. */
  collabRoutes: CollabRoutesService
  /** Stamps `lastRunAt` from the `cron/report` EVT (daemon-scoped, latest-wins). */
  cron: CronRepo
  /** Closes `HookRun` rows from the correlated `hook/report` completion request. */
  hook: HookRepo
  /** Viewer-free agent reads for the `gitcred/request` placement check — a DATA-PLANE
   *  path (resource-visibility §9): restricted-but-active agents must keep minting. */
  agent: AgentRepo
  /** Accepted Knowledge/skills and retained suggestion metadata. */
  organizationKnowledge?: OrganizationKnowledgeRepo
  /** Revision-fenced sink for daemon external-memory conformance facts. */
  externalMemoryConnection?: ExternalMemoryConnectionRepo
  /** github-app workspaces façade; absent ⇒ gitcred/request answers SCOPE_DENIED. */
  github?: GithubService
  /** R1 action-time formal-review broker; absent ⇒ review/start REQs fail closed. */
  githubReviewBroker?: GithubReviewBrokerService
  /** R2a metadata-only lifecycle → informational Check projection. */
  githubRunCoordinator?: GithubRunCoordinator
  /** The current relay roster, injected into `register/ok.relays` so a (re)connecting
   *  daemon converges to the relays it should dial (shared-bot-relay.md §5). */
  relayRoster: () => Promise<RelayRosterEntry[]>
  clock: Clock
  config: WsConfig
}
