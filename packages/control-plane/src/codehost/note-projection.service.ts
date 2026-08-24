/**
 * `CodeHostNoteProjectionService` — the Control-Plane half of the informational
 * run projection (gitlab-com-integration.md §16).
 *
 * It translates the authoritative hook-turn lifecycle into one desired
 * generation in the durable ledger, then hands that generation to the OWNING
 * DAEMON, which is the only GitLab Notes writer for this surface. The Control
 * Plane never posts or updates the note: an offline daemon, or one that has not
 * advertised `codehost-note-projection-v1`, leaves the row pending rather than
 * opening a second provider egress path (§16, §17.3).
 *
 * No note body, agent reply, review text, or provider exception text is
 * accepted here — the only free text is a bounded normalized reason code.
 */
import { randomUUID } from 'node:crypto'
import {
  CODEHOST_NOTE_PROJECTION_V1_FEATURE,
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  HOOK_REPORT_REASON_AGENT_HANDOVER,
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED,
  type CodeHostNoteDesired,
  type CodeHostNoteResult,
  type CodeHostNoteState,
  type GitlabHookMetadata,
  type HookConfigSnapshot,
  type OptionalHookConfigSnapshot
} from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { AgentId, HookId, type OrgId } from '../domain/ids.js'
import type {
  AgentRepo,
  GitlabAgentAccountRepo,
  CodeHostRunProjectionRecord,
  CodeHostRunProjectionRepo,
  GitlabProjectBindingRepo,
  HookRepo,
  OrgRepo
} from '../persistence/ports.js'

const PROVIDER = 'gitlab'
/** The window a dispatched generation stays owned by its daemon before the row is claimable again. */
const DEFAULT_WRITE_LEASE_MS = 120_000
const REASON_CODE = /^[a-z0-9_:-]{1,100}$/

/** Only a normalized code reaches a projection; anything else (a raw turn failure text) is dropped. */
function normalizedReason(reason: string | null | undefined): string | undefined {
  return reason && REASON_CODE.test(reason) ? reason : undefined
}

/** The §16 lifecycle a terminal daemon report projects to. */
export function reportedNoteState(status: 'success' | 'failed', reason?: string | null): CodeHostNoteState {
  if (status === 'success') return 'completed'
  if (reason === HOOK_REPORT_REASON_AGENT_HANDOVER) return 'interrupted'
  if (reason === HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED || reason === HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED)
    return 'skipped'
  return 'failed'
}

/** The complete §17.2 placement fence, or null when a partially rolled-out tuple cannot authorize one. */
export function completeSnapshot(snapshot: OptionalHookConfigSnapshot): HookConfigSnapshot | null {
  const { configRevision, dispatchRevision, dispatchDaemonId, reviewPolicy, reportingMode, gateMode } = snapshot
  if (
    configRevision === undefined ||
    dispatchRevision === undefined ||
    dispatchDaemonId === undefined ||
    reviewPolicy === undefined ||
    reportingMode === undefined ||
    gateMode === undefined
  )
    return null
  return { configRevision, dispatchRevision, dispatchDaemonId, reviewPolicy, reportingMode, gateMode }
}

/** The merge-request facts a projection needs; an issue or push subject has nothing to project. */
export function projectionSubject(
  gitlab: GitlabHookMetadata | undefined
): { projectId: bigint; projectPath: string; mergeRequestIid: number; headSha: string } | null {
  if (!gitlab || gitlab.target.kind !== 'merge_request' || !gitlab.target.headSha) return null
  return {
    projectId: BigInt(gitlab.projectId),
    projectPath: gitlab.projectPath,
    mergeRequestIid: gitlab.target.iid,
    headSha: gitlab.target.headSha
  }
}

/** One lifecycle edge, as the WS/relay frame that carries it already presents it. */
export interface NoteProjectionEdge {
  hookId: string
  agentId: string
  deliveryKey: string
  orgId: OrgId
  state: CodeHostNoteState
  reason?: string | null
  sessionId?: string
  gitlab: GitlabHookMetadata | undefined
  snapshot: OptionalHookConfigSnapshot
  at: Date
}

/** How a reported result settled. `denied` is a cross-org or cross-hook claim; `conflict` is a
 *  fence miss (stale generation, lost lease, or an older attempt's marker) the daemon may drop. */
export type NoteResultOutcome = 'settled' | 'conflict' | 'denied' | 'not_found'

/** Sends one desired generation to a daemon that has advertised the feature. */
export interface NoteProjectionSender {
  /** The daemon's advertised features, or undefined when it is offline. */
  daemonFeatures(daemonId: string): readonly string[] | undefined
  send(daemonId: string, desired: CodeHostNoteDesired, orgId: OrgId): void
}

export interface CodeHostNoteProjectionLog {
  warn(obj: unknown, msg?: string): void
}

export interface CodeHostNoteProjectionDeps {
  projections: CodeHostRunProjectionRepo
  /** The ACCEPTED run behind an edge — the only authority for its projection epoch. */
  runs: Pick<HookRepo, 'getRun'>
  agents: Pick<AgentRepo, 'getUnscoped'>
  bindings: Pick<GitlabProjectBindingRepo, 'byProject'>
  /** §7.2: the acting agent's own account on the project — the identity the
   *  effect lease is minted against, and so the epoch the daemon fences on. */
  accounts: Pick<GitlabAgentAccountRepo, 'forAgentBinding'>
  orgs?: Pick<OrgRepo, 'slugById'>
  sender: NoteProjectionSender
  clock: Clock
  /** Console origin for the ordinary authenticated session link; unset ⇒ the note carries no link. */
  webAppUrl?: string
  writeLeaseMs?: number
  log?: CodeHostNoteProjectionLog
}

export class CodeHostNoteProjectionService {
  private readonly writeLeaseMs: number

  constructor(private readonly deps: CodeHostNoteProjectionDeps) {
    this.writeLeaseMs = deps.writeLeaseMs ?? DEFAULT_WRITE_LEASE_MS
  }

  /** Relay accepted the delivery: the turn is queued, and a newer head preempts older generations. */
  async afterAccepted(edge: NoteProjectionEdge): Promise<void> {
    await this.converge({ ...edge, state: 'queued' })
  }

  /** Delivery failed before any turn ran — nothing was judged, so the note reads skipped. */
  async afterDeliveryFailed(edge: NoteProjectionEdge): Promise<void> {
    // A daemon that was offline at fire time cannot write the note either; the row stays pending.
    if (edge.reason === HOOK_DELIVERY_REASON_DAEMON_OFFLINE) return
    await this.converge({ ...edge, state: 'skipped' })
  }

  /** Daemon terminal report: completed / failed / skipped / interrupted (§16). */
  async afterReport(edge: NoteProjectionEdge): Promise<void> {
    await this.converge(edge)
  }

  /** The provider-neutral `hook/start` barrier crossed: the accepted turn is entering the prompt. */
  async afterStart(edge: NoteProjectionEdge): Promise<void> {
    await this.converge({ ...edge, state: 'running' })
  }

  /**
   * The daemon settled one desired generation: persist the observed note and drain any parked intent.
   *
   * Authorized against the PERSISTED row, never a live HookDef — a projection deliberately outlives
   * its hook so cleanup can settle, and a result arriving after deletion must still be acknowledged.
   */
  async recordResult(result: CodeHostNoteResult, reportingDaemonId: string, orgId: OrgId): Promise<NoteResultOutcome> {
    const row = await this.deps.projections.get(result.projectionId)
    if (!row) return 'not_found'
    if (row.orgId !== orgId || row.hookId !== result.hookId) return 'denied'
    const generation = BigInt(result.generation)
    const now = new Date(this.deps.clock.now())
    if (result.outcome === 'written' && result.observedState) {
      const settled = await this.deps.projections.completeWrite({
        projectionId: result.projectionId,
        generation,
        leaseOwner: reportingDaemonId,
        writeMarker: result.writeMarker,
        observedState: result.observedState,
        ...(result.noteId ? { noteId: result.noteId } : {}),
        recheckAt: now
      })
      if (!settled) return 'conflict'
      await this.drain(result.projectionId, now)
      return 'settled'
    }
    // A deterministic no-effect outcome releases the mutex and the lease; an ambiguous one keeps
    // both, so only this daemon's reconciliation — never a replay — may follow (§16).
    const keepWriteMutex = result.outcome === 'ambiguous'
    const released = await this.deps.projections.failWrite(
      result.projectionId,
      generation,
      reportingDaemonId,
      result.writeMarker,
      result.code ?? result.outcome,
      now,
      keepWriteMutex
    )
    if (!released) return 'conflict'
    if (!keepWriteMutex) await this.drain(result.projectionId, now)
    return 'settled'
  }

  private async drain(projectionId: string, now: Date): Promise<void> {
    const current = await this.deps.projections.get(projectionId)
    if (!current?.pendingIntent) return
    const advanced = await this.deps.projections.advancePending(projectionId, current.generation, now)
    if (advanced) await this.dispatch(advanced)
  }

  private async converge(edge: NoteProjectionEdge): Promise<void> {
    const subject = projectionSubject(edge.gitlab)
    if (!subject) return
    const snapshot = completeSnapshot(edge.snapshot)
    // A partially rolled-out dispatch tuple cannot authorize an effect, so it cannot open a
    // projection either — absence fails closed rather than being filled with a revision.
    if (!snapshot) return
    // The §16 note IS the run report, so reporting `off` opens nothing — judged from the ACCEPTED snapshot.
    if (snapshot.reportingMode === 'off') return
    // The ACCEPTED run's epoch, never the live hook's: an edit mid-run would otherwise fork a new row.
    const run = await this.deps.runs.getRun(HookId(edge.hookId), edge.deliveryKey)
    // No epoch means the run's fence missed at delivery and its key is retired — fail closed.
    if (!run || run.projectionEpoch === null) return
    const agent = await this.deps.agents.getUnscoped(AgentId(edge.agentId))
    if (!agent || agent.orgId !== edge.orgId) return
    const binding = await this.deps.bindings.byProject(edge.orgId, subject.projectId)
    if (!binding) return
    // The daemon fences the write on the epoch of the lease it mints, and that
    // lease is the ACTING AGENT's account (§7.2) — never the binding's counter,
    // which advances on its own schedule and would refuse every write. An agent
    // with no ready account there cannot write the note, so no projection opens.
    const account = await this.deps.accounts.forAgentBinding(edge.orgId, edge.agentId, binding.id)
    if (!account || account.serviceAccountUserId === null || account.state !== 'ready') return

    // A newer head preempts every older generation on the same merge request before the new one
    // opens, so exactly one note per head reads current.
    await this.deps.projections.supersede(
      HookId(edge.hookId),
      subject.projectId,
      subject.mergeRequestIid,
      subject.headSha,
      edge.at
    )
    const terminal = edge.state !== 'queued' && edge.state !== 'running'
    const reason = normalizedReason(edge.reason)
    const projection = await this.deps.projections.upsert({
      provider: PROVIDER,
      hookId: HookId(edge.hookId),
      orgId: edge.orgId,
      agentId: AgentId(edge.agentId),
      agentName: agent.name,
      projectionEpoch: run.projectionEpoch,
      desiredState: edge.state,
      currentDeliveryKey: edge.deliveryKey,
      currentRunAt: edge.at,
      credentialEpoch: account.credentialEpoch,
      configRevision: BigInt(snapshot.configRevision),
      dispatchRevision: BigInt(snapshot.dispatchRevision),
      dispatchDaemonId: snapshot.dispatchDaemonId,
      reviewPolicySnapshot: snapshot.reviewPolicy,
      reportingModeSnapshot: snapshot.reportingMode,
      gateModeSnapshot: snapshot.gateMode,
      ...subject,
      ...(reason ? { reason } : {}),
      ...(edge.sessionId ? { sessionId: edge.sessionId } : {}),
      ...(edge.state === 'queued' ? { queuedAt: edge.at } : {}),
      ...(edge.state === 'running' ? { startedAt: edge.at } : {}),
      ...(terminal ? { completedAt: edge.at } : {}),
      nextAttemptAt: edge.at
    })
    // Null ⇒ the hook was retired under the lifecycle fence while this edge was in flight; a retired
    // hook needs no projection, so the edge is simply dropped.
    if (!projection || projection.tombstonedAt) return
    // The upsert parks an edge that landed mid-write; that intent is dispatched when the in-flight
    // generation settles, not now.
    if (projection.writePhase !== null) return
    // Later edges of the same delivery move the state inside this generation. A late queued/running
    // one loses here against the terminal authority that already sealed it.
    const moved = await this.deps.projections.setDesired(
      projection.id,
      projection.generation,
      edge.state,
      edge.at,
      reason
    )
    if (!moved) return
    const fresh = await this.deps.projections.get(projection.id)
    if (fresh) await this.dispatch(fresh)
  }

  private async dispatch(projection: CodeHostRunProjectionRecord): Promise<void> {
    const daemonId = projection.dispatchDaemonId
    // The frame echoes the accepted tuple verbatim; a row missing any member is not dispatchable.
    if (
      !daemonId ||
      projection.configRevision === null ||
      projection.dispatchRevision === null ||
      projection.reviewPolicySnapshot === null ||
      projection.reportingModeSnapshot === null ||
      projection.gateModeSnapshot === null
    )
      return
    // §17.3 negotiation, checked against the connection that would carry the frame. A daemon that
    // is offline or has not advertised the feature leaves the row pending — never an error.
    const features = this.deps.sender.daemonFeatures(daemonId)
    if (!features?.includes(CODEHOST_NOTE_PROJECTION_V1_FEATURE)) return

    // A held marker is an unsettled mutation: it stays fail-closed on the writer that owns it until
    // that writer reconciles it, and daemon loss or lease expiry alone never authorizes another
    // attempt (§16). Duplicated with the repository's own fence so an alternate port cannot skip it.
    if (projection.writeMarker !== null) return

    const now = new Date(this.deps.clock.now())
    const leaseUntil = new Date(now.getTime() + this.writeLeaseMs)
    const writeMarker = randomUUID()
    const taken = await this.deps.projections.beginWrite(
      projection.id,
      projection.generation,
      daemonId,
      writeMarker,
      projection.noteId ? 'update' : 'create',
      now,
      leaseUntil
    )
    if (!taken) return

    const consoleUrl = await this.consoleUrl(projection)
    this.deps.sender.send(
      daemonId,
      {
        projectionId: projection.id,
        provider: projection.provider,
        hookId: projection.hookId,
        agentId: projection.agentId,
        agentName: projection.agentName ?? projection.agentId,
        deliveryKey: projection.currentDeliveryKey ?? '',
        generation: projection.generation.toString(),
        projectionEpoch: projection.projectionEpoch.toString(),
        projectionKey: projection.externalId,
        writeMarker,
        projectId: projection.projectId.toString(),
        projectPath: projection.projectPath,
        mergeRequestIid: projection.mergeRequestIid,
        headSha: projection.headSha,
        ...(projection.noteId ? { noteId: projection.noteId } : {}),
        state: projection.desiredState,
        ...(projection.reason ? { reason: projection.reason } : {}),
        queuedAt: (projection.queuedAt ?? projection.updatedAt).toISOString(),
        ...(projection.startedAt ? { startedAt: projection.startedAt.toISOString() } : {}),
        ...(projection.completedAt ? { completedAt: projection.completedAt.toISOString() } : {}),
        desiredAt: now.toISOString(),
        ...(consoleUrl ? { consoleUrl } : {}),
        snapshot: {
          configRevision: projection.configRevision.toString(),
          dispatchRevision: projection.dispatchRevision.toString(),
          dispatchDaemonId: daemonId,
          reviewPolicy: projection.reviewPolicySnapshot,
          reportingMode: projection.reportingModeSnapshot,
          gateMode: projection.gateModeSnapshot
        },
        credentialEpoch: projection.credentialEpoch.toString(),
        leaseUntil: leaseUntil.toISOString()
      },
      projection.orgId
    )
  }

  /** An ordinary authenticated Console session URL — never a bearer token, secret, or capability param. */
  private async consoleUrl(projection: CodeHostRunProjectionRecord): Promise<string | undefined> {
    if (!this.deps.webAppUrl || !this.deps.orgs || !projection.sessionId) return undefined
    try {
      const slug = await this.deps.orgs.slugById(projection.orgId)
      if (!slug) return undefined
      const base = `${this.deps.webAppUrl.replace(/\/+$/, '')}/${encodeURIComponent(slug)}`
      return `${base}/sessions/${encodeURIComponent(projection.sessionId)}?source=gitlab`
    } catch (err) {
      // A console-link lookup must never block the authoritative projection.
      this.deps.log?.warn({ err, projectionId: projection.id }, 'note projection: console link lookup failed')
      return undefined
    }
  }
}
