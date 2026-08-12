/**
 * `DaemonRegistryService` — implements the C4 `DaemonRegistry` port
 * (design §2.3, §4.6; protocol §3.3, §7.1, §7.3).
 *
 * The durable-fleet side of registration: it applies the `register` capability
 * upload, records heartbeats (the watchdog liveness feed) and runtime-profile
 * facts, marks daemons unreachable, and exposes the `GET /daemons` read model.
 * It does NOT compute the reconcile snapshot — that is the C3 `Orchestrator`'s
 * job (`reconcile`), which reads the same C6 routing table.
 *
 * Transport-free and Prisma-free: depends only on repository ports + a `Clock`.
 */
import type { RegisterReq, Heartbeat, FactsRuntimeProfile, FactsMcpServer } from '@agentconnect.md/protocol'
import type { DaemonRegistry, DaemonView, DaemonCapabilities, DaemonLoad, DaemonRuntimeProfile } from '../ports.js'
import type {
  DaemonRepo,
  DaemonRecord,
  DaemonLifecycleOpRepo,
  RuntimeProfileRepo,
  RuntimeProfileRecord,
  ResourceVisibility,
  ViewCtx
} from '../persistence/ports.js'
import type { DaemonId, OrgId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'

/** Coerce the stored `capabilities` JSON (defaults to `{}`) into the typed shape. */
function normCapabilities(raw: unknown): DaemonCapabilities {
  const c = (raw ?? {}) as Record<string, unknown>
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return { platforms: arr(c.platforms), runtimes: arr(c.runtimes), acp: c.acp === true, features: arr(c.features) }
}

/** Coerce the stored `load` JSON (null before the first heartbeat) into the typed shape. */
function normLoad(raw: unknown): DaemonLoad | null {
  if (raw == null || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return { cpu: num(l.cpu), mem: num(l.mem), agents: num(l.agents) }
}

/** Coerce the stored `mcpServers` JSON (defaults to `[]`) into the typed snapshot.
 *  Rows were written from a schema-validated frame, so only the array shape is guarded. */
function normMcpServers(raw: unknown): FactsMcpServer[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is FactsMcpServer => s !== null && typeof s === 'object')
}

/** Drop persistence ids from a runtime-profile record for the read model. */
function toProfileView(p: RuntimeProfileRecord): DaemonRuntimeProfile {
  return {
    runtime: p.runtime,
    version: p.version,
    models: p.models,
    contextWindow: p.contextWindow,
    acpSupport: p.acpSupport,
    acpProtocolVersion: p.acpProtocolVersion,
    toolCalling: p.toolCalling,
    mcpCapabilities: p.mcpCapabilities,
    modelCatalog: p.modelCatalog,
    modelsSource: p.modelsSource,
    authRequired: p.authRequired,
    observedAt: p.observedAt
  }
}

function toView(d: DaemonRecord, profiles: RuntimeProfileRecord[]): DaemonView {
  return {
    daemonId: d.id,
    orgId: d.orgId,
    host: d.host,
    name: d.name,
    agentVersion: d.agentVersion,
    cluster: d.cluster,
    status: d.status,
    health: d.health,
    capabilities: normCapabilities(d.capabilities),
    runtimeProfiles: profiles.map(toProfileView),
    mcpServers: normMcpServers(d.mcpServers),
    load: normLoad(d.load),
    sessionEpoch: d.sessionEpoch,
    maxAgents: d.maxAgents,
    activeSessions: d.activeSessions,
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
    createdBy: d.createdBy,
    lastModifiedAt: d.lastModifiedAt,
    lastModifiedBy: d.lastModifiedBy,
    createdByUserId: d.createdByUserId,
    visibility: d.visibility,
    sharedWith: d.sharedWith,
    sessionRetention: d.sessionRetention
  }
}

export class DaemonRegistryService implements DaemonRegistry {
  constructor(
    private readonly daemons: DaemonRepo,
    private readonly runtimeProfiles: RuntimeProfileRepo,
    private readonly lifecycleOps: DaemonLifecycleOpRepo,
    private readonly clock: Clock
  ) {}

  async upsertOnRegister(daemonId: DaemonId, req: RegisterReq): Promise<void> {
    await this.daemons.applyRegister(daemonId, {
      host: req.host,
      capabilities: req.capabilities,
      maxAgents: req.maxAgents,
      cluster: req.cluster
    })
  }

  async updateCapabilities(daemonId: DaemonId, capabilities: RegisterReq['capabilities']): Promise<void> {
    await this.daemons.setCapabilities(daemonId, capabilities)
  }

  /**
   * Close any pending restart/upgrade op for a daemon that has *actually* reached READY
   * (cli-daemon-split.md §7). This is deliberately SEPARATE from {@link upsertOnRegister}
   * and called only after reconcile succeeds and the connection transitions READY — so a
   * registration that fails mid-way never records the op as succeeded (the same-connection
   * READY invariant, design §4.6).
   *
   * A `restart` closes on any READY re-registration within the deadline. An `upgrade`
   * closes only once the daemon's reported `agentVersion` reaches the target — an
   * old-version reconnect (a failed install, or a relaunch of the prior bundle) keeps the
   * op pending until the target lands or the deadline lapses. A deadline already past
   * closes the op `failed`. Best-effort: a settle failure never blocks register.
   */
  async settleLifecycleOpOnReady(daemonId: DaemonId): Promise<void> {
    const op = await this.lifecycleOps.pendingForDaemon(daemonId)
    if (!op) return
    const now = new Date(this.clock.now())
    if (now.getTime() > op.deadline.getTime()) {
      await this.lifecycleOps.expireOverdue(now, daemonId)
      return
    }
    // Not yet armed: the daemon has not ACKed acceptance, so this READY is a coincidental
    // reconnect / duplicate register between open() and the ACK — NOT our command
    // completing. Leaving it pending prevents a false success (the ACK may still decline).
    if (!op.acceptedAt) return
    // Lifecycle settlement runs off the daemon's own connection — the internal
    // trust domain resolves the row without an org (org-scoped-data-layer.md §4).
    const daemon = await this.daemons.getUnscoped(daemonId)
    if (!daemon) return
    // Require a re-auth since the command was sent (STRICTLY greater sessionEpoch): a
    // same-epoch duplicate register is the same connection, not the daemon coming back
    // from a drain + relaunch. This is the "later READY from that command" gate.
    if (daemon.sessionEpoch <= op.commandEpoch) return
    // An upgrade must additionally have reached the target version; an old-version relaunch
    // keeps the op pending until the target lands or the deadline lapses.
    if (op.op === 'upgrade' && daemon.agentVersion !== op.targetVersion) return
    await this.lifecycleOps.settle(op.id, 'succeeded', null, now)
  }

  async recordHeartbeat(daemonId: DaemonId, hb: Heartbeat): Promise<void> {
    await this.daemons.touchHeartbeat(daemonId, hb, new Date(this.clock.now()))
  }

  async recordRuntimeProfile(daemonId: DaemonId, f: FactsRuntimeProfile): Promise<void> {
    await this.runtimeProfiles.record(daemonId, f, new Date(this.clock.now()))
  }

  async replaceRuntimeProfiles(
    daemonId: DaemonId,
    runtimes: FactsRuntimeProfile[],
    mcpServers: FactsMcpServer[],
    seq?: number
  ): Promise<void> {
    const applied = await this.runtimeProfiles.replaceAll(daemonId, runtimes, new Date(this.clock.now()), seq)
    // A stale snapshot (older seq than the last applied one) is dropped whole —
    // including its mcpServers list, which came from the same superseded frame.
    if (!applied) return
    // Daemon-level MCP snapshot from the same frame — replaced whole (empty clears).
    await this.daemons.setMcpServers(daemonId, mcpServers)
  }

  async markUnreachable(daemonId: DaemonId): Promise<void> {
    await this.daemons.markUnreachable(daemonId, new Date(this.clock.now()))
  }

  async rename(orgId: OrgId, daemonId: DaemonId, name: string, byUserId?: string): Promise<DaemonView> {
    const d = await this.daemons.rename(orgId, daemonId, name, byUserId)
    return toView(d, await this.runtimeProfiles.forDaemon(daemonId))
  }

  async setSessionRetention(
    orgId: OrgId,
    daemonId: DaemonId,
    sessionRetention: string,
    byUserId?: string
  ): Promise<DaemonView> {
    const d = await this.daemons.setSessionRetention(orgId, daemonId, sessionRetention, byUserId)
    return toView(d, await this.runtimeProfiles.forDaemon(daemonId))
  }

  async setSharing(
    orgId: OrgId,
    daemonId: DaemonId,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<DaemonView> {
    const d = await this.daemons.setSharing(orgId, daemonId, sharing, byUserId)
    return toView(d, await this.runtimeProfiles.forDaemon(daemonId))
  }

  async remove(orgId: OrgId, daemonId: DaemonId): Promise<void> {
    await this.daemons.delete(orgId, daemonId)
  }

  /** Org-fenced (org-scoped-data-layer.md §3): the repo read is filtered, so a
   *  cross-org id yields null exactly like an unknown one. The runtime-profile
   *  fetch below is reached only after that fence admits the row. */
  async get(orgId: OrgId, daemonId: DaemonId): Promise<DaemonView | null> {
    const d = await this.daemons.get(orgId, daemonId)
    if (!d) return null
    return toView(d, await this.runtimeProfiles.forDaemon(daemonId))
  }

  async getUnscoped(daemonId: DaemonId): Promise<DaemonView | null> {
    const d = await this.daemons.getUnscoped(daemonId)
    if (!d) return null
    return toView(d, await this.runtimeProfiles.forDaemon(daemonId))
  }

  async list(orgId: OrgId, viewer?: ViewCtx): Promise<DaemonView[]> {
    const rows = await this.daemons.list(orgId, viewer)
    // One batched query for the whole fleet, grouped by daemon (no N+1).
    const profiles = await this.runtimeProfiles.forDaemons(rows.map((d) => d.id))
    const byDaemon = new Map<string, RuntimeProfileRecord[]>()
    for (const p of profiles) {
      const arr = byDaemon.get(p.daemonId)
      if (arr) arr.push(p)
      else byDaemon.set(p.daemonId, [p])
    }
    return rows.map((d) => toView(d, byDaemon.get(d.id) ?? []))
  }
}
