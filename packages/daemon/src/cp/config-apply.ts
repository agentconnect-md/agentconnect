/**
 * `ConfigApply` — the seam from CP control frames to daemon config/cron
 * mutations. The CP changes *config*, never live routing; the `Daemon`
 * implements this interface. `mergeConfigPush` is the pure whitelist-merge used
 * by the real implementation and unit-tested on its own (Task 6).
 */
import type {
  RegisterOk,
  RelayRosterEntry,
  CronUpsert,
  RouteAssign,
  RouteUpdate,
  AgentUpsert,
  CollabRoutesSnapshot,
  AgentLaunch,
  AgentLaunched,
  AgentStop,
  AgentDetach,
  AgentActivate,
  IntegrationSpec,
  IntegrationForget,
  IntegrationLeave,
  IntegrationLeaveOk,
  McpServerSpec,
  MemoryConnectionSpec,
  Ack,
  Drain,
  DrainProgress,
  DrainDone,
  DaemonRestart,
  DaemonUpgrade,
  DaemonControlAck,
  AgentPermissionRequestList,
  AgentPermissionRequestPage,
  AgentPermissionDecision,
  SessionVisibilityPush
} from '@agentconnect.md/protocol'
import type { Config } from '../config/config-schema.js'

export interface ConfigApply {
  /** Merge whitelisted non-secret config keys (config/push EVT). */
  applyConfigPush(keys: Record<string, unknown>): void
  /** Converge crons + agent specs (+ record leases) from the register/ok reconcile snapshot. */
  applyReconcileSnapshot(snap: RegisterOk): void | Promise<void>
  /** Apply a CP agent spec and resolve after disk + live reconcile converge. */
  applyAgentUpsert(upsert: AgentUpsert): Promise<Ack>
  /** Drop a CP agent spec (agent/remove EVT). */
  applyAgentRemove(agentId: string): void | Promise<void>
  /** Quiesce + archive an agent for a safe cold move (agent/detach REQ). */
  applyAgentDetach(detach: AgentDetach): Promise<Ack>
  /** Restore/reconcile an agent and verify it is servable (agent/activate REQ). */
  applyAgentActivate(activate: AgentActivate): Promise<Ack>
  /** Bounded daemon-local editor approval history (secret-masked summaries only). */
  listAgentPermissionRequests(req: AgentPermissionRequestList): AgentPermissionRequestPage
  /** Resolve one live ACP request from the Agent editor. */
  decideAgentPermission(req: AgentPermissionDecision): Ack
  /** Add or replace a CP-owned platform integration in memory (integration/upsert EVT). */
  applyIntegrationUpsert(spec: IntegrationSpec): void
  /** Drop a CP-owned integration (integration/remove EVT). */
  applyIntegrationRemove(integrationId: string): void
  /** Withdraw the bot from a conversation/space at the PLATFORM (integration/leave
   *  REQ). Resolves with the platform's verdict — a refusal is `ok:false`, not a
   *  rejection — and reconciles the channel set as a side effect. */
  applyIntegrationLeave(leave: IntegrationLeave): Promise<IntegrationLeaveOk>
  /** Stop reporting conversations an operator forgot (integration/forget EVT). The
   *  platform is untouched; this only suppresses them in the console's channel list. */
  applyIntegrationForget(forget: IntegrationForget): void
  /** Add or replace a CP-pushed MCP server def in memory (mcpserver/upsert EVT). */
  applyMcpServerUpsert(spec: McpServerSpec): void
  /** Drop a CP-pushed MCP server def by name (mcpserver/remove EVT). */
  applyMcpServerRemove(name: string): void
  /** Add or replace one daemon-private external-memory connection definition. */
  applyMemoryConnectionUpsert(spec: MemoryConnectionSpec): Promise<Ack>
  /** Drop one daemon-private external-memory connection definition. */
  applyMemoryConnectionRemove(connectionId: string): void
  /** Add or replace a CP cron (cron/upsert REQ). Throws on a bad schedule. */
  upsertCron(cron: CronUpsert): void
  /** Remove a CP cron (cron/remove REQ). */
  removeCron(cronId: string): void
  /** Fire a CP cron immediately (cron/run REQ — console "Run now"). The fire is
   *  async; the ack only says whether this daemon holds the cron. */
  runCron(cronId: string): Ack
  /** Apply a per-session routing override (route/assign REQ). */
  applyRouteAssign(a: RouteAssign): void
  /** Apply the global routing-rule set (route/update EVT). */
  applyRouteUpdate(u: RouteUpdate): void
  /** Converge the relay dial-out set (relay/roster EVT — hot update of register/ok.relays). */
  applyRelayRoster(relays: RelayRosterEntry[]): void
  /** FULL-REPLACE the bot-agnostic collaboration routing snapshot (collaboration/routes
   *  EVT; baseline in register/ok.collabRoutes) — the daemon's terminal-verify source
   *  for REMOTE agent callers (agent-collaboration §2.3/§6.2/§6.5). */
  applyCollabRoutes(snap: CollabRoutesSnapshot): void
  /** Warm-start an agent's host (agent/launch REQ); resolves with the launch fact. */
  applyAgentLaunch(launch: AgentLaunch): Promise<AgentLaunched>
  /** Drain + stop an agent's host (agent/stop REQ); resolves once it's down. */
  applyAgentStop(stop: AgentStop): Promise<Ack>
  /** Graceful drain (daemon/drain REQ): emit `drain/progress` via `onProgress`,
   *  resolve with the released SessionKeys for `drain/done`. */
  applyDaemonDrain(drain: Drain, onProgress: (p: DrainProgress) => void): Promise<DrainDone>
  /** Drain + exit so the supervisor restarts the daemon (daemon/restart REQ). */
  applyDaemonRestart(req: DaemonRestart): DaemonControlAck
  /** Drain + exit for a version bump (daemon/upgrade REQ). */
  applyDaemonUpgrade(req: DaemonUpgrade): DaemonControlAck
  /**
   * Apply the CP's effective session visibility to the local memory-capture gate
   * (session-visibility.md §5.1). Idempotent by `visibilityRev`: a revision at or
   * below the stored one is reported `superseded` and NOT reapplied — but it is
   * still acknowledged, so a lost ack cannot make the CP retry forever.
   */
  applySessionVisibility(p: SessionVisibilityPush): 'applied' | 'superseded'
}

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error'])
const SESSION_RETENTIONS = new Set(['never', '7d', '2weeks', '1month', '30d', '90d'])

/**
 * Merge a `config/push` payload into the running config — whitelist only, no
 * secrets. Unknown or wrongly-typed keys are ignored (reported, not thrown).
 * Returns the keys actually applied vs. ignored.
 */
export function mergeConfigPush(cfg: Config, keys: Record<string, unknown>): { applied: string[]; ignored: string[] } {
  const applied: string[] = []
  const ignored: string[] = []
  for (const [key, value] of Object.entries(keys)) {
    let ok = false
    switch (key) {
      case 'logging.level':
        if (typeof value === 'string' && LOG_LEVELS.has(value)) {
          cfg.logging.level = value as Config['logging']['level']
          ok = true
        }
        break
      case 'limits.maxAgents':
        if (typeof value === 'number' && Number.isInteger(value)) {
          cfg.limits.maxAgents = value
          ok = true
        }
        break
      case 'limits.maxConcurrentSessions':
        if (typeof value === 'number' && Number.isInteger(value)) {
          cfg.limits.maxConcurrentSessions = value
          ok = true
        }
        break
      case 'limits.agentIdleTimeoutMs':
        if (typeof value === 'number' && Number.isInteger(value)) {
          cfg.limits.agentIdleTimeoutMs = value
          ok = true
        }
        break
      case 'sessions.retention':
        if (typeof value === 'string' && SESSION_RETENTIONS.has(value)) {
          cfg.sessions.retention = value as Config['sessions']['retention']
          ok = true
        }
        break
      default:
        ok = false
    }
    ;(ok ? applied : ignored).push(key)
  }
  return { applied, ignored }
}
