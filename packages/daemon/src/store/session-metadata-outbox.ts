/**
 * The daemon's durable session-metadata outbox: build the CP's DB-backed session-list
 * projection, persist it locally, and drain it to the CP one acknowledged snapshot at a
 * time (claim / park / defer included). The Daemon keeps thin delegates with unchanged
 * signatures; everything here reaches back through the narrow {@link SessionMetadataHost}
 * port, so the outbox owns its own timers and in-flight drain.
 */
import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import {
  EventSession as EventSessionSchema,
  SESSION_METADATA_ACK_FEATURE,
  type EventSession,
  type SessionKey,
  type SessionListItem
} from '@agentconnect.md/protocol'
import type { LoadedAgent } from '../agents/load-agents.js'
import { selectedPermissionPreset } from '../acp/permission-modes.js'
import type { CpClient } from '../cp/client.js'
import { createSessionReader } from '../cp/session-reader.js'
import {
  SESSION_METADATA_DEFER_MS,
  SESSION_METADATA_FAILURES_BEFORE_DEFER,
  SESSION_METADATA_PARK_MS,
  SESSION_METADATA_RETRY_MS
} from '../daemon/constants.js'
import { formatErr } from '../daemon/text.js'
import type { LocalStore, SessionMetadataOutboxRow, SessionRecord } from './local-store.js'

/** Exactly what the outbox touches on the Daemon — nothing wider. */
export interface SessionMetadataHost {
  store(): LocalStore
  warn(message: string): void
  debug(message: string): void
  clock(): Clock
  daemonId(): string | undefined
  /** True when this daemon is configured to reach a CP, even before the client exists. */
  controlPlaneConfigured(): boolean
  /** Shutdown gate: no new claim, retry, or drain pass once the daemon is draining. */
  draining(): boolean
  cpClient(): CpClient | undefined
  agents(): Map<string, LoadedAgent>
  servesAgent(agentId: string): boolean
  sessionLink(acpSessionId: string): string
  sessionThreadUrl(session: SessionRecord): string | undefined
}

export interface SessionMetadataSnapshotInput {
  sessionId: string
  agentId: string
  phase: EventSession['phase']
  platform: SessionKey['platform']
  channel: string
  thread?: string
  status?: string
  runtime?: string
  model?: string | null
  permissionMode?: string
}

export class SessionMetadataOutbox {
  // One-at-a-time durable session metadata sync. Sequential ACKs provide natural
  // CP/DB backpressure after an outage; the promise is joined during shutdown.
  private drain?: Promise<void>
  private retryTimer?: TimerHandle
  private retryAt?: number

  constructor(private readonly host: SessionMetadataHost) {}

  /** The in-flight drain, joined by the daemon's shutdown path. */
  inFlightDrain(): Promise<void> | undefined {
    return this.drain
  }

  /** Timer teardown for Daemon.stop(); the drain promise is settled separately. */
  dispose(): void {
    if (this.retryTimer !== undefined) {
      this.host.clock().clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    this.retryAt = undefined
  }

  async sessionListProjection(sessionId: string, agentId: string): Promise<SessionListItem | undefined> {
    return (
      await createSessionReader(this.host.store(), (session) => this.host.sessionThreadUrl(session)).list({ agentId })
    ).sessions.find((s) => s.sessionId === sessionId)
  }

  /**
   * Push the CP's DB-backed session-list metadata from the daemon's canonical
   * local projection. This is still metadata-only: transcript rows and tool bodies
   * remain daemon-local and are fetched via the on-demand session read-back frames.
   */
  async emitSessionMetadataSnapshot(input: SessionMetadataSnapshotInput): Promise<void> {
    const store = this.host.store()
    const cpClient = this.host.cpClient()
    // Session work may begin during startup before startCpClient() runs. Persist
    // that obligation whenever this daemon is configured to connect; only the
    // live send still depends on a constructed client.
    if (!cpClient && !this.host.controlPlaneConfigured()) return
    const now = new Date(this.host.clock().now()).toISOString()
    // Callers hold the ACP hop's id; the wire carries the session's outward one (§1.1).
    const slot = await store.getSessionByAcpIdForAgent(input.agentId, input.sessionId)
    // An unresolvable slot keeps the id it was given — the same thing a pre-v12 daemon would have sent.
    const outwardSessionId =
      slot?.sessionId ??
      (slot ? await store.ensureOutwardSessionId(slot.key, input.agentId, this.host.clock().now()) : input.sessionId)
    // The projection speaks the same outward language the wire does, so it is looked up that way.
    const row = await this.sessionListProjection(outwardSessionId, input.agentId)
    const key = row?.sessionKey
    const event: EventSession = {
      sessionId: outwardSessionId,
      agentId: input.agentId,
      phase: input.phase,
      platform: key?.platform ?? input.platform,
      channel: key?.channel ?? input.channel,
      link: this.host.sessionLink(outwardSessionId),
      lastActivityAt: row?.lastActivityAt ?? now,
      ts: now
    }
    if (row?.parentSessionId !== undefined) event.parentSessionId = row.parentSessionId
    // Visibility-classification inputs (session-visibility.md §4.1), read from
    // the session row so every re-emit carries them. Absent fields make the CP
    // fail closed (no owner) rather than guess — never send a placeholder.
    const classification = await store.getSessionClassification(input.agentId, input.sessionId)
    if (classification?.conversationKind !== undefined) {
      event.conversationKind = classification.conversationKind as EventSession['conversationKind']
    }
    if (classification?.tenantScope !== undefined) event.transportScope = classification.tenantScope
    if (classification?.launchCorrelationId !== undefined) {
      event.launchCorrelationId = classification.launchCorrelationId
    }
    if (classification?.sourceBindingKind !== undefined) {
      event.sourceBindingKind = classification.sourceBindingKind
    }
    // §4.2: this row's coordinates are its own conversation, so `parentSessionId` below is
    // lineage and the CP classifies the row instead of inheriting the parent's audience.
    if (classification?.directDestination) event.directDestination = true
    // Only a direct trusted ingress reports a credential locator. A2A children
    // persist the same source tuple for the local gate but let the CP inherit
    // the already-validated parent scope instead of presenting the parent's bot
    // integration as if it belonged to the child agent.
    if (classification?.externalOrigin) event.externalOrigin = classification.externalOrigin
    else if (
      (classification?.externalProvider === 'slack' || classification?.externalProvider === 'feishu') &&
      classification.externalResourceKey &&
      classification.externalIntegrationId
    ) {
      // Rolling compatibility for a conversation row created before direct-origin
      // proof was persisted as one object.
      event.externalOrigin = {
        provider: classification.externalProvider,
        resourceKind: 'conversation',
        resourceKey: classification.externalResourceKey,
        ...(classification.externalRealmKey ? { realmKey: classification.externalRealmKey } : {}),
        integrationId: classification.externalIntegrationId
      }
    }
    const thread = key?.thread ?? input.thread
    if (thread !== undefined) event.thread = thread
    if (row?.title !== undefined) event.title = row.title
    if (input.status !== undefined) event.status = input.status
    else if (row?.status !== undefined) event.status = row.status
    if (row?.triggeredBy !== undefined) event.triggeredBy = row.triggeredBy
    if (row?.channelName !== undefined) event.channelName = row.channelName
    if (row?.triggeredByName !== undefined) event.triggeredByName = row.triggeredByName
    if (row?.threadUrl !== undefined) event.threadUrl = row.threadUrl
    // Effective execution config: the session's sticky overrides (console/⚙-modal
    // in-session switches) win over the agent's configured values; absent ⇒ the
    // runtime's own default. Snapshotted here so the CP records what this session
    // actually ran with — the agent's config can change later without rewriting history.
    const agent = this.host.agents().get(input.agentId)
    const allowRuntimeChangesInChat = agent?.allowRuntimeChangesInChat === true
    if (input.runtime !== undefined) event.runtime = input.runtime
    else if (agent?.runtime) event.runtime = agent.runtime
    const sessionRecord = await store.getSessionByAcpIdForAgent(input.agentId, input.sessionId)
    if (sessionRecord?.workspaceIsolation) event.workspaceIsolation = sessionRecord.workspaceIsolation
    const storeKey = sessionRecord?.key
    const configuredModel =
      (allowRuntimeChangesInChat && storeKey ? await store.getModelOverride(storeKey) : undefined) ??
      agent?.runtimeOverrides?.model
    const observedModel =
      input.model !== undefined ? input.model : storeKey ? await store.getObservedModel(storeKey) : undefined
    if (observedModel !== undefined) {
      event.observedModel = observedModel
      if (observedModel !== null) event.model = observedModel
    } else if (configuredModel !== undefined) {
      event.model = configuredModel
    }
    const effort =
      (allowRuntimeChangesInChat && storeKey ? await store.getEffortOverride(storeKey) : undefined) ??
      agent?.reasoningEffort
    if (effort !== undefined) event.effort = effort
    const fastMode =
      (allowRuntimeChangesInChat && storeKey ? await store.getFastModeOverride(storeKey) : undefined) ?? agent?.fastMode
    if (fastMode !== undefined) event.fastMode = fastMode
    const permissionMode =
      (allowRuntimeChangesInChat && storeKey ? await store.getPermissionModeOverride(storeKey) : undefined) ??
      (agent?.permissionMode
        ? selectedPermissionPreset(agent.permissionMode, agent.approvalsReviewer ?? 'user')
        : undefined)
    if (input.permissionMode !== undefined) event.permissionMode = input.permissionMode
    else if (permissionMode !== undefined) event.permissionMode = permissionMode
    const outputMode = (storeKey ? await store.getOutputModeOverride(storeKey) : undefined) ?? agent?.output?.mode
    if (outputMode !== undefined) event.outputMode = outputMode

    const snapshot = await this.convergedPendingSessionMetadataSnapshot(event)
    let pending = false
    try {
      // A lifecycle milestone creates the durable obligation. `plan` is title /
      // display-name enrichment: it updates an already-pending snapshot but does
      // not turn a historical session into upgrade-time replay work.
      pending =
        (await store.saveSessionMetadataSnapshot(
          input.agentId,
          // The obligation belongs to the SESSION, so the row is keyed by its outward id — a
          // rebuilt ACP hop updates the same pending snapshot instead of opening a second one.
          outwardSessionId,
          JSON.stringify(snapshot),
          input.phase !== 'plan',
          this.host.clock().now(),
          this.host.daemonId()
        )) !== undefined
    } catch (err) {
      // Preserve the pre-outbox behavior if the local write fails: a live CP may
      // still accept the best-effort event, and the turn itself must not fail.
      this.host.warn(`event/session outbox persist failed (session ${input.sessionId}): ${formatErr(err)}`)
    }

    if (!cpClient) return
    if (pending && cpClient.supportsServerFeature?.(SESSION_METADATA_ACK_FEATURE)) {
      void this.drainSessionMetadataSnapshots()
      return
    }
    try {
      cpClient.emitEventSession(event)
    } catch (err) {
      this.host.debug(`event/session emit failed (session ${input.sessionId}): ${(err as Error).message}`)
    }
  }

  /** Keep a terminal milestone in an unacknowledged latest-wins snapshot while
   * title/name enrichment updates its remaining fields. Otherwise a post-turn
   * `plan` update could erase the only durable copy of the missing `end`. */
  async convergedPendingSessionMetadataSnapshot(next: EventSession): Promise<EventSession> {
    if (next.phase !== 'plan') return next
    const pending = await this.host.store().pendingSessionMetadataSnapshot(next.agentId, next.sessionId)
    if (!pending) return next
    try {
      const parsed = EventSessionSchema.safeParse(JSON.parse(pending.snapshot))
      const previous = parsed.success ? parsed.data : undefined
      if (
        previous?.agentId === next.agentId &&
        previous.sessionId === next.sessionId &&
        (previous.phase === 'end' || previous.phase === 'problem')
      ) {
        return { ...next, phase: previous.phase, ts: previous.ts }
      }
    } catch {
      // A newly generated valid snapshot replaces corrupt local state below.
    }
    return next
  }

  /** Start or join the sequential durable metadata drain. One correlated request
   * at a time is intentional backpressure: reconnect cannot fan a backlog into
   * the CP's database pool. */
  drainSessionMetadataSnapshots(): Promise<void> {
    if (this.drain) return this.drain
    const cp = this.host.cpClient()
    if (
      this.host.draining() ||
      !cp ||
      (cp.state !== 'READY' && cp.state !== 'DRAINING') ||
      !cp.supportsServerFeature?.(SESSION_METADATA_ACK_FEATURE)
    ) {
      return Promise.resolve()
    }
    const drain = this.runSessionMetadataDrain(cp).finally(async () => {
      if (this.drain === drain) this.drain = undefined
      try {
        // Close the empty-read/new-write race and re-arm the earliest deferred snapshot.
        await this.schedulePendingSessionMetadataDrain()
      } catch (err) {
        this.host.warn(`event/session outbox refill check failed (${formatErr(err)})`)
      }
    })
    this.drain = drain
    return drain
  }

  private async runSessionMetadataDrain(cp: CpClient): Promise<void> {
    const store = this.host.store()
    const clock = this.host.clock()
    const daemonId = this.host.daemonId()
    while (!this.host.draining() && (cp.state === 'READY' || cp.state === 'DRAINING')) {
      let row: SessionMetadataOutboxRow | undefined
      try {
        row = await store.nextSessionMetadataSnapshot(clock.now(), daemonId, this.servedAgentIds())
        if (!row) return
        // Emit only under a live claim: on a pool this outbox is one shared table, so a
        // row a peer holds is that member's to report, never ours to duplicate or drop.
        if (
          !(await store.claimSessionMetadataSnapshot(row.agentId, row.sessionId, row.revision, daemonId, clock.now()))
        ) {
          continue
        }
        // The frame is scoped by the agent's organization, and only a member serving the
        // agent can resolve it — leave the row for that member instead of failing it here.
        if (!this.host.servesAgent(row.agentId) && (await this.parkSessionMetadataRow(row, 'agent served elsewhere')))
          continue
        const parsed = EventSessionSchema.safeParse(JSON.parse(row.snapshot))
        if (!parsed.success || parsed.data.agentId !== row.agentId || parsed.data.sessionId !== row.sessionId) {
          this.host.warn(`event/session outbox dropped an invalid snapshot for session ${row.sessionId}`)
          await store.acknowledgeSessionMetadataSnapshot(row.agentId, row.sessionId, row.revision, daemonId)
          continue
        }
        const result = await cp.syncEventSession(parsed.data)
        if (result === 'unsupported') return
        // Revision fencing: an event produced while this request was in flight
        // remains pending instead of being cleared by the older ACK.
        await store.acknowledgeSessionMetadataSnapshot(row.agentId, row.sessionId, row.revision, daemonId)
      } catch (err) {
        if (!row) {
          this.host.warn(`event/session outbox read failed (${formatErr(err)})`)
          this.scheduleSessionMetadataRetry()
          return
        }
        // SCOPE_DENIED says this member cannot name the agent's organization, not that the
        // snapshot is bad. Park it for the member that can rather than burning a failure.
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          err.code === 'SCOPE_DENIED' &&
          (await this.parkSessionMetadataRow(row, 'organization unresolvable here'))
        ) {
          continue
        }
        const nextFailure = row.failedAttempts + 1
        const explicitlyPermanent =
          typeof err === 'object' && err !== null && 'retryable' in err && err.retryable === false
        const defer = explicitlyPermanent || nextFailure >= SESSION_METADATA_FAILURES_BEFORE_DEFER
        let failure
        try {
          failure = await store.recordSessionMetadataSnapshotFailure(
            row.agentId,
            row.sessionId,
            row.revision,
            defer ? clock.now() + SESSION_METADATA_DEFER_MS : null,
            daemonId
          )
        } catch (storeErr) {
          this.host.warn(`event/session outbox failure record failed (${formatErr(storeErr)})`)
          this.scheduleSessionMetadataRetry()
          return
        }
        // A newer revision replaced the failed request while it was in flight; drain that revision now.
        if (!failure) continue
        if (defer) {
          this.host.warn(
            `event/session snapshot deferred after ${failure.failedAttempts} failures for session ${row.sessionId} (${formatErr(err)})`
          )
          continue
        }
        const message = `event/session snapshot retained for retry (${formatErr(err)})`
        if (failure.failedAttempts === 1) this.host.warn(message)
        else this.host.debug(message)
        this.scheduleSessionMetadataRetry()
        return
      }
    }
  }

  /** Agents whose shared-outbox rows this member may work on: the ones it serves. */
  servedAgentIds(): string[] {
    return [...this.host.agents().keys()].filter((agentId) => this.host.servesAgent(agentId))
  }

  /** Release a snapshot this member cannot scope, so the member serving the agent drains
   *  it. The body and the failure count survive; the backoff only keeps it out of this
   *  member's next pass. False on a local store, where there is no other member. */
  async parkSessionMetadataRow(row: SessionMetadataOutboxRow, why: string): Promise<boolean> {
    let parked = false
    try {
      parked = await this.host
        .store()
        .parkSessionMetadataSnapshot(
          row.agentId,
          row.sessionId,
          row.revision,
          this.host.clock().now() + SESSION_METADATA_PARK_MS
        )
    } catch (err) {
      this.host.warn(`event/session outbox park failed (${formatErr(err)})`)
      return false
    }
    if (parked) this.host.debug(`event/session snapshot parked for session ${row.sessionId} (${why})`)
    return parked
  }

  /** A duty newly held here owns that agent's snapshots: take the parked ones off their
   *  backoff and the previous holder's claim off the rest — it released the duty, so it
   *  will never emit them — then replay at once instead of waiting out the lease. */
  async replayGainedSessionMetadata(agentIds: readonly string[]): Promise<void> {
    if (!agentIds.length) return
    try {
      await this.host.store().reclaimSessionMetadataSnapshots(agentIds, this.host.daemonId())
    } catch (err) {
      this.host.warn(`event/session outbox reclaim failed (${formatErr(err)})`)
    }
    void this.drainSessionMetadataSnapshots()
  }

  /** Shutdown counterpart: this member will not emit again, so every claim it still holds
   *  goes back to the pool for its successor instead of blocking on the lease. */
  async releaseOwnedSessionMetadata(): Promise<void> {
    try {
      const released = await this.host.store().releaseOwnedSessionMetadataSnapshots(this.host.daemonId())
      if (released) this.host.debug(`event/session outbox released ${released} claim(s) for the pool`)
    } catch (err) {
      this.host.warn(`event/session outbox release failed (${formatErr(err)})`)
    }
  }

  async schedulePendingSessionMetadataDrain(): Promise<void> {
    if (this.host.draining() || !this.host.cpClient()?.supportsServerFeature?.(SESSION_METADATA_ACK_FEATURE)) return
    const store = this.host.store()
    const daemonId = this.host.daemonId()
    const served = this.servedAgentIds()
    if (!(await store.hasPendingSessionMetadata(daemonId, served))) return
    const attemptAt = await store.nextSessionMetadataAttemptAt(daemonId, served)
    if (attemptAt !== undefined) {
      this.scheduleSessionMetadataRetry(Math.max(0, attemptAt - this.host.clock().now()))
    }
  }

  scheduleSessionMetadataRetry(delayMs = SESSION_METADATA_RETRY_MS): void {
    if (this.host.draining()) return
    const clock = this.host.clock()
    const retryAt = clock.now() + Math.max(0, delayMs)
    if (this.retryTimer !== undefined) {
      if (this.retryAt !== undefined && this.retryAt <= retryAt) return
      clock.clearTimeout(this.retryTimer)
    }
    this.retryAt = retryAt
    this.retryTimer = clock.setTimeout(
      () => {
        this.retryTimer = undefined
        this.retryAt = undefined
        void this.drainSessionMetadataSnapshots()
      },
      Math.max(0, delayMs)
    )
  }

  async emitSessionMetadataSnapshotsForDisplayName(id: string): Promise<void> {
    if (!this.host.cpClient()) return
    for (const row of await this.host.store().listSessions()) {
      if (!row.acpSessionId) continue
      if (row.channel !== id && row.triggeredBy !== id) continue
      await this.emitSessionMetadataSnapshot({
        sessionId: row.acpSessionId,
        agentId: row.agentId,
        phase: 'plan',
        platform: row.platform as SessionKey['platform'],
        channel: row.channel,
        thread: row.thread
      })
    }
  }
}
