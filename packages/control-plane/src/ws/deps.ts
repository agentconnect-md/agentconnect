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
  SessionRepo,
  IntegrationRepo,
  IntegrationChannelRepo,
  CronRepo,
  HookRepo,
  MemberSetRepo,
  AgentRepo,
  ExternalMemoryConnectionRepo,
  WebchatConversationRepo,
  LaunchRepo,
  OrganizationKnowledgeRepo,
  BotRepo,
  GithubInstallationRepo,
  DaemonLifecycleOpRepo,
  AgentRecord
} from '../persistence/ports.js'
import type { UsageWriter } from '../usage/writer.js'
import type { SessionVisibilityPushService } from '../orchestrator/visibilityPush.js'
import type { DutyAgentBundle, RelayRosterEntry } from '@agentconnect.md/protocol'
import type { GithubService } from '../github/service.js'
import type { GitlabGitcredService } from '../gitlab/gitcred.service.js'
import type { CodeHostReviewBrokerService } from '../codehost/review-lease.service.js'
import type { GithubReviewBrokerService } from '../github/review-broker.service.js'
import type { GithubRunCoordinator } from '../github/run-reporter.js'
import type { CodeHostNoteProjectionService } from '../codehost/note-projection.service.js'
import type { ReconcileService } from '../orchestrator/placement.js'
import type { ConnectionRegistry } from './registry.js'
import type { Clock } from '../domain/clock.js'
import type { SessionEventSink } from '../events/sink.js'
import type { AgentMutationGate } from '../orchestrator/agentMutationGate.js'
import type { PlacementResolver } from '../orchestrator/placementResolver.js'
import type { CollabRoutesService } from '../orchestrator/collabRoutes.service.js'
import type { GatedDmSeedResolver } from '../orchestrator/linkedDm.js'
import type { DutyLeaseService } from '../orchestrator/dutyLease.js'
import type { AgentId, DaemonId } from '../domain/ids.js'
import type { WebchatRemoteMcpService } from '../registry/webchatRemoteMcpService.js'
import type { SlackSessionAccessService } from '../http/slack-session-access.js'
import type { SessionAccessWarmer } from '../http/session-access-warmer.js'

/** Config slice the WS edge reads. */
export interface WsConfig {
  HEARTBEAT_SEC: number
  ACK_TIMEOUT_MS: number
  /** The path the daemon socket is mounted at (default `/daemon/ws`). */
  WS_PATH?: string
}

export interface DaemonWsDeps {
  /** Structured server log sink for failures handled at the daemon WS edge. */
  log: { error: (obj: Record<string, unknown>, message: string) => void }
  auth: DaemonAuth
  /** Durable lifecycle intent exposed during auth-only bootstrap. */
  lifecycleOps: DaemonLifecycleOpRepo
  registry: DaemonRegistry
  orchestrator: ReconcileService
  connReg: ConnectionRegistry
  /** The shared usage report interface — this plane is its `daemon`-source adapter. */
  usageWriter: UsageWriter
  /** Persists milestones from `event/session` EVT or acknowledged sync request. */
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
  /** §4.2(4) `isPrivate` cross-check (session-access-cold-visit.md): a snapshot observing a
   *  channel private drops its cached `public` audience verdict — invalidation only. */
  slackSessionAccess?: Pick<SlackSessionAccessService, 'dropPublicAudiences'>
  /** §14.8: which of a gated install's reported DMs seed to the ordinary DM default
   *  because their counterpart is in the agent's own audience; absent ⇒ all stay Off. */
  gatedDmSeeds?: GatedDmSeedResolver
  /** Republish the agent's integrations. Needed because §14.8 is the one path where a
   *  daemon REPORT creates an ENABLED row: the reporter is still holding bindRules that
   *  predate it, and it has already cached the conversation, so nothing re-reports and
   *  the DM stays refused until an unrelated push or reconnect. Absent ⇒ exactly that. */
  integrationConverge?: (agent: AgentRecord) => Promise<void>
  /** §4.1 activity poke (session-access-cold-visit.md): a committed live `event/session`
   *  milestone marks its external scope active so the warmer keeps its resource facts
   *  leased. Replayed `event/session-sync` frames never poke (§4.2(6)). */
  sessionAccessWarmer?: Pick<SessionAccessWarmer, 'poke'>
  /** Shares the HTTP agent-move boundary with daemon-originated conversation reports. */
  agentMutations: AgentMutationGate
  /** Resumes durable move tombstones advertised by a reconnecting daemon. */
  recoverStagedAgent: (agentId: AgentId, daemonId: DaemonId, moveId: string) => Promise<void>
  /** Refreshes relay and daemon collaboration snapshots after accepted conversation changes. */
  collabRoutes: CollabRoutesService
  /** The duty lease exchange riding the heartbeat (k8s daemons). */
  dutyLease: DutyLeaseService
  /** The set a connection may claim duties within (daemon-groups.md §3), re-read once the
   *  connection is registered so a membership change cannot slip through the handshake. */
  memberSets: Pick<MemberSetRepo, 'setIdOf'>
  /** Assembles one agent's complete installable definition for `duty/fetch` —
   *  the same bundle an `agent/activate` carries; absent ⇒ the fetch answers
   *  empty and the member installs nothing. */
  agentBundle?: (agent: AgentRecord) => Promise<DutyAgentBundle>
  /** Stamps `lastRunAt` from the `cron/report` EVT (daemon-scoped, latest-wins). */
  cron: CronRepo
  /** Closes `HookRun` rows from the correlated `hook/report` completion request. */
  hook: HookRepo
  /** Viewer-free agent reads for the `gitcred/request` placement check — a DATA-PLANE
   *  path (resource-visibility §9): restricted-but-active agents must keep minting. */
  agent: AgentRepo
  /** "May this connection act for that agent?" — placement OR a held duty. A pool member serves
   *  agents its row does not name, so placement equality is no longer the fence. Absent ⇒
   *  placement alone, which is the pre-duty behavior. */
  placementResolver?: PlacementResolver
  /** Accepted Knowledge/skills and retained suggestion metadata. */
  organizationKnowledge?: OrganizationKnowledgeRepo
  /** Revision-fenced sink for daemon external-memory conformance facts. */
  externalMemoryConnection?: ExternalMemoryConnectionRepo
  /** github-app workspaces façade; absent ⇒ gitcred/request answers SCOPE_DENIED. */
  github?: GithubService
  /** gitcred v2 GitLab grants (§13.1); absent ⇒ gitlab workspaces disabled. */
  gitlabGitcred?: GitlabGitcredService
  /** R1 action-time formal-review broker; absent ⇒ review/start REQs fail closed. */
  githubReviewBroker?: GithubReviewBrokerService
  /** Provider-neutral formal reviews: publication lease, operation ledger, outcome
   *  store (§15.1/§15.2). Absent ⇒ every `codehost/*` REQ fails closed. */
  codeHostReviewBroker?: CodeHostReviewBrokerService
  /** R2a metadata-only lifecycle → informational Check projection. */
  githubRunCoordinator?: GithubRunCoordinator
  /** §16 desired-generation ledger for the daemon-written run projection; absent ⇒ no GitLab bindings. */
  codeHostNoteProjection?: CodeHostNoteProjectionService
  /** The current relay roster, injected into `register/ok.relays` so a (re)connecting
   *  daemon converges to the relays it should dial (shared-bot-relay.md §5). */
  relayRoster: () => Promise<RelayRosterEntry[]>
  clock: Clock
  config: WsConfig
}
