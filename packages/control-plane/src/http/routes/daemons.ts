/**
 * `http/routes/daemons.ts` (design §2.1) — the daemon fleet read model + token
 * lifecycle. `GET /daemons` projects the C4 registry (`DaemonRegistry.list`),
 * overlaying live connection status from the in-memory index so a daemon that has
 * exited reads as `offline` (the durable `status` is a lifecycle marker that is
 * NOT downgraded on disconnect). `PATCH /daemons/:id` assigns a console display
 * name. `POST /daemons/token` provisions a connect token + start command for a NEW
 * daemon (copy-paste onboarding); `POST /daemons/:id/token/rotate` mints a
 * fresh token for an EXISTING daemon. All authenticated C2 ops (design §5.6a).
 * Daemons are a READ model here — the row materializes on the WS `auth`
 * handshake, never created via REST.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { DAEMON_BOOTSTRAP_UPGRADE_FEATURE, SESSION_RETENTION_RE } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { DaemonView, DaemonLiveness, DaemonRegistry } from '../../ports.js'
import { isSyntheticEmail } from '../../persistence/ports.js'
import { DaemonId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canView, canEdit, canManageSharing, type ViewCtx } from '../../authorization/policy.js'
import { resolveShareSet } from '../sharing.js'
import {
  DaemonListDto,
  DaemonViewDto,
  DaemonLifecycleOpDto,
  UpdateDaemonBody,
  DaemonUpgradeBody,
  SetSharingBody,
  DaemonConnectDto,
  IdParam,
  ErrorDto
} from '../dto/index.js'
import type { DaemonViewDtoT } from '../dto/index.js'
import type { DaemonLifecycleOpRecord, DaemonLifecycleOpRepo } from '../../persistence/ports.js'
import { provisionDaemonConnect } from '../onboarding.js'
import { detachDaemon } from '../daemon-removal.js'
import { Tag } from '../plugins/openapi.js'

/** Drain + (install +) relaunch + re-register budget for a CP-commanded lifecycle op.
 *  A still-`pending` op older than this reads as no-longer-in-flight and is closed
 *  `failed` on the next register (cli-daemon-split.md §7). */
const LIFECYCLE_DEADLINE_MS = 15 * 60_000

/** Backoff for the background arm-write recovery (§7). Bounded to well within
 *  {@link LIFECYCLE_DEADLINE_MS} so a transient DB blip recovers before the op expires. */
const ARM_RECOVERY_DELAYS_MS = [2_000, 10_000, 60_000, 300_000]

/**
 * Background recovery when the in-request arm write couldn't be persisted (e.g. a transient
 * DB blip): retries `markAccepted` with backoff, then re-runs the READY closure so an
 * already-observed completion still settles. Without this an accepted command left unarmed
 * would be ignored by every later READY and falsely time out (cli-daemon-split.md §7).
 * Fire-and-forget; bounded, and a DB down past the deadline expires the op like any other.
 */
export async function retryArm(
  ops: DaemonLifecycleOpRepo,
  registry: DaemonRegistry,
  opId: string,
  daemonId: string,
  epoch: bigint,
  delaysMs: number[],
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<boolean> {
  for (const delay of delaysMs) {
    if (delay > 0)
      await new Promise<void>((r) => {
        const t = setTimeout(r, delay)
        t.unref?.() // a dangling recovery must never keep the process alive
      })
    try {
      // Both steps must succeed before declaring recovery: in the fast-restart case the
      // READY has ALREADY been observed, so this re-check is the only remaining settle
      // trigger — swallowing its failure would strand the op until a false timeout. Both
      // are idempotent, so the outer loop safely retries a settle failure too.
      await ops.markAccepted(opId, new Date(), epoch)
      await registry.settleLifecycleOpOnReady(DaemonId(daemonId))
      return true
    } catch (err) {
      log?.warn({ opId, daemonId, err }, 'lifecycle op arm recovery attempt failed')
    }
  }
  return false
}

/**
 * The status the console should show: derived from the LIVE connection, not the
 * durable `status` (which stays `ready` after a clean exit). Absent from the live
 * index ⇒ `offline`; present-but-frozen ⇒ `unreachable`; otherwise reflect the
 * handshake lifecycle.
 *
 * `graceMs` softens the not-connected case: the live index is in-memory only, so a
 * CP restart empties it and every daemon would flash `offline` (dragging its agents
 * red too) until each re-handshakes a few seconds later. A daemon that heartbeated
 * within `graceMs` therefore reads `connecting` (amber) rather than `offline` —
 * covering the reconnect window without hiding a genuinely-dead daemon for long.
 */
function liveStatus(view: DaemonView, liveness: DaemonLiveness, graceMs: number, nowMs: number): string {
  const live = liveness.get(view.daemonId)
  if (!live) {
    // A never-authed provisioned daemon reads `pending` (operator can Regenerate
    // its command). An established daemon that heartbeated within the grace window
    // reads `connecting` (likely mid-reconnect after a CP restart); older than that
    // ⇒ `offline`.
    if (view.status === 'provisioned') return 'pending'
    if (graceMs > 0 && view.lastSeenAt && nowMs - view.lastSeenAt.getTime() < graceMs) return 'connecting'
    return 'offline'
  }
  if (!live.reachable) return 'unreachable'
  if (live.state === 'READY') return 'ready'
  if (live.state === 'DRAINING') return 'draining'
  return 'connecting' // CONNECTING / AUTHENTICATING / REGISTERING
}

function toDto(
  view: DaemonView,
  liveness: DaemonLiveness,
  ctx: ViewCtx,
  graceMs: number,
  nowMs: number,
  release: { channel: string; latestVersion: string | null; availableVersions: string[] },
  latestOp: DaemonLifecycleOpRecord | null
): DaemonViewDtoT {
  // Read-time expiry projection: a still-`pending` op past its deadline is reported as
  // `failed` (timed out) even before the sweep/next-command persists that — so the
  // console never renders a dead op as in-flight, and a stuck op reads terminal.
  const expired = latestOp?.status === 'pending' && latestOp.deadline.getTime() <= nowMs
  const orgOwned = view.orgId !== null
  return {
    daemonId: view.daemonId,
    host: view.host,
    name: view.name,
    agentVersion: view.agentVersion,
    // Deployment-wide daemon release channel + its latest published version (same
    // for every row); the console flags a daemon whose agentVersion trails it.
    releaseChannel: release.channel,
    latestVersion: release.latestVersion,
    availableVersions: release.availableVersions,
    lifecycleOp: latestOp
      ? {
          id: latestOp.id,
          op: latestOp.op,
          status: expired ? 'failed' : latestOp.status,
          targetVersion: latestOp.targetVersion,
          outcome: expired ? 'timed out — the daemon did not re-register before the deadline' : latestOp.outcome
        }
      : null,
    status: liveStatus(view, liveness, graceMs, nowMs),
    // Org-less ⇒ an install-wide pool member; the console groups the pool under one entry.
    cloud: !orgOwned,
    health: view.health,
    capabilities: view.capabilities,
    runtimeProfiles: view.runtimeProfiles.map((p) => ({ ...p, observedAt: p.observedAt.toISOString() })),
    mcpServers: view.mcpServers.map((s) => ({ name: s.name, transport: s.transport })),
    load: view.load,
    sessionEpoch: Number(view.sessionEpoch),
    maxAgents: view.maxAgents,
    activeSessions: view.activeSessions,
    lastSeenAt: view.lastSeenAt ? view.lastSeenAt.toISOString() : null,
    createdAt: view.createdAt.toISOString(),
    // The creator's userId — the web resolves it to a display name (or "You"). A
    // synthesized placeholder email (`<sub>@oidc.local`) means a non-human creator → null.
    createdBy: view.createdBy && !isSyntheticEmail(view.createdBy.email) ? view.createdBy.userId : null,
    lastModifiedAt: view.lastModifiedAt.toISOString(),
    lastModifiedBy:
      view.lastModifiedBy && !isSyntheticEmail(view.lastModifiedBy.email) ? view.lastModifiedBy.userId : null,
    // Defensive read-time normalization: the PATCH route only writes validated
    // values, so a fallback here just keeps an unexpected stored value from
    // failing the whole response's schema serialization.
    sessionRetention: SESSION_RETENTION_RE.test(view.sessionRetention) ? view.sessionRetention : '7d',
    memberSetId: view.memberSetId,
    visibility: view.visibility,
    sharedWith: view.sharedWith,
    canEdit: orgOwned && canEdit(view, ctx),
    canManageSharing: orgOwned && canManageSharing(view, ctx),
    // Install-wide infrastructure is visible but mutable only through its deployment owner.
    canManageLifecycle: orgOwned && canEdit(view, ctx)
  }
}

export function daemonRoutes(deps: HttpDeps) {
  // How long after its last heartbeat a disconnected daemon still reads `connecting`
  // rather than `offline` (0 ⇒ disabled — the pre-grace behavior). Set from
  // HEARTBEAT_SEC × MISSED_BEATS so it tracks the watchdog's freeze threshold.
  const graceMs = deps.config.DAEMON_OFFLINE_GRACE_MS ?? 0
  // The deployment's daemon release (channel + latest npm version) is one value for
  // the whole fleet; resolved best-effort (null until the first npm fetch lands, or
  // when the resolver is disabled). Falls back to the configured channel name so the
  // DTO always carries it even before/without a successful fetch.
  const release = (): { channel: string; latestVersion: string | null; availableVersions: string[] } =>
    deps.daemonRelease?.get() ?? {
      channel: deps.config.DAEMON_DIST_TAG || 'latest',
      latestVersion: null,
      availableVersions: []
    }
  // Evaluated per DTO render so the grace compares against the actual request time. A
  // single mutation response fetches its own daemon's latest op; the list route batches
  // (see below) to avoid an N+1. `latestForDaemon` (any status, not just pending) so a
  // terminal op stays observable — the console reads terminal state, not just in-flight.
  const dtoWith = (view: DaemonView, ctx: ViewCtx, latestOp: DaemonLifecycleOpRecord | null): DaemonViewDtoT =>
    toDto(view, deps.liveness, ctx, graceMs, Date.now(), release(), latestOp)
  const dto = async (view: DaemonView, ctx: ViewCtx): Promise<DaemonViewDtoT> =>
    dtoWith(view, ctx, await deps.repos.daemonLifecycleOp.latestForDaemon(DaemonId(view.daemonId)))

  return async function daemonRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/daemons',
      {
        schema: {
          tags: [Tag.Daemons],
          summary: 'List daemons',
          description:
            'The org’s available daemon fleet, including install-wide pool members, overlaid with live connection status.',
          operationId: 'listDaemons',
          response: { 200: DaemonListDto }
        }
      },
      async (req) => {
        const ctx = ctxOf(req)
        const rows = await deps.registry.listAvailable(orgOf(req), ctx)
        // One batched latest-op query for the whole fleet (no N+1), grouped by daemon.
        const ops = await deps.repos.daemonLifecycleOp.latestForDaemons(rows.map((d) => DaemonId(d.daemonId)))
        const byDaemon = new Map(ops.map((o) => [o.daemonId as string, o]))
        return rows.map((d) => dtoWith(d, ctx, byDaemon.get(d.daemonId) ?? null))
      }
    )

    // Tenancy is the repository's job now (org-scoped-data-layer.md §3): the read
    // is org-fenced, so a cross-org id reads as absent. What stays here is the
    // POLICY half — a restricted daemon the caller can't see is 404 too. The
    // console reaches daemons only through the registry service, so the canView
    // gate lives here (and in list).
    const getOrgDaemon = async (req: FastifyRequest, id: string) => {
      const view = await deps.registry.get(orgOf(req), DaemonId(id))
      if (!view) return null
      return canView(view, ctxOf(req)) ? view : null
    }

    // Update console daemon settings (name / session retention). The row
    // materializes on the WS `auth` handshake, so a missing id (Prisma P2025)
    // maps to 404 via the error handler.
    r.patch(
      '/daemons/:id',
      {
        schema: {
          tags: [Tag.Daemons],
          summary: 'Update a daemon',
          description:
            'Update console daemon settings: the human-friendly display name and/or the finished-session retention window ("Expire sessions"). A retention change is hot-pushed to a connected daemon and re-issued in the register/ok snapshot on reconnect.',
          operationId: 'updateDaemon',
          params: IdParam,
          body: UpdateDaemonBody,
          response: { 200: DaemonViewDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgDaemon(req, req.params.id)
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (!canEdit(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this daemon' })
        }
        const { name, sessionRetention } = req.body
        const did = DaemonId(req.params.id)
        let view = existing
        if (name !== undefined) view = await deps.registry.rename(orgOf(req), did, name, req.principal?.userId)
        if (sessionRetention !== undefined) {
          view = await deps.registry.setSessionRetention(orgOf(req), did, sessionRetention, req.principal?.userId)
          // Hot-push the new window to the connected daemon (config/push EVT).
          // Best-effort: an offline daemon converges from the register/ok
          // snapshot on its next connect.
          try {
            deps.control.configPush(req.params.id, { 'sessions.retention': sessionRetention })
          } catch {
            // NoConnection — the reconnect snapshot is the backstop
          }
        }
        return dto(view, ctxOf(req))
      }
    )

    // Provision a NEW daemon (provisioned row + first API key) + ready-to-run command.
    r.post(
      '/daemons/token',
      {
        schema: {
          tags: [Tag.Daemons],
          summary: 'Issue a daemon enrollment token',
          description:
            'Provision a new daemon (a provisioned row plus its first API key) and return a ready-to-run connect command for onboarding.',
          operationId: 'createDaemonToken',
          response: { 201: DaemonConnectDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const connect = await provisionDaemonConnect(
          deps.apiKeys,
          deps.config,
          req.orgCtx!.orgId,
          req.principal?.userId
        )
        return reply.code(201).send(connect)
      }
    )

    // Remove a daemon from the fleet. Refused while it is live + reachable (409): an
    // online daemon is actively serving — take it offline first. FK cascades drop its
    // keys/leases/launches and unplace its agents; a missing id (P2025) maps to 404.
    r.delete(
      '/daemons/:id',
      {
        schema: {
          tags: [Tag.Daemons],
          summary: 'Detach a daemon',
          description:
            'Remove a daemon from the fleet, cascading its keys, leases, and launches; refused while it is online and reachable.',
          operationId: 'deleteDaemon',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgDaemon(req, req.params.id)
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (!canEdit(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this daemon' })
        }
        const live = deps.liveness.get(req.params.id)
        if (live && live.reachable) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'daemon is online; take it offline before deleting' })
        }
        // Unplacement, relay revoke, collaboration push and hook re-converge —
        // the whole sequence, shared with the pool-member reaper so the two
        // cannot drift apart.
        await detachDaemon(deps, orgOf(req), DaemonId(req.params.id), req.log)
        return reply.code(204).send(null)
      }
    )

    // Set who can see this daemon (visibility + complete Selected audience).
    // Gated exactly like a content edit (§13.3).
    // Independent of any agent's visibility — a daemon can be restricted-away
    // while its agents stay org-visible.
    r.put(
      '/daemons/:id/sharing',
      {
        schema: {
          tags: [Tag.Daemons],
          summary: 'Set daemon sharing',
          description:
            'Set a daemon’s visibility (Everyone vs Selected) and complete Selected audience. Requires edit rights; Selected must retain at least one current organization member, and sharedWith is intersected with current membership.',
          operationId: 'setDaemonSharing',
          params: IdParam,
          body: SetSharingBody,
          response: { 200: DaemonViewDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgDaemon(req, req.params.id)
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (!canManageSharing(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot change sharing' })
        }
        const sharedWith = await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
        const view = await deps.registry.setSharing(
          orgOf(req),
          DaemonId(req.params.id),
          { visibility: req.body.visibility, sharedWith },
          req.principal?.userId
        )
        return dto(view, ctxOf(req))
      }
    )

    // Open a fleet lifecycle op; bootstrap-capable upgrades may wait durably for the next auth.
    const commandLifecycle = async (
      req: FastifyRequest,
      reply: FastifyReply,
      id: string,
      op: 'restart' | 'upgrade',
      targetVersion?: string
    ) => {
      if (denyViewerWrite(req, reply)) return
      const existing = await getOrgDaemon(req, id)
      if (!existing) {
        return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
      }
      // Restart/upgrade use the ordinary daemon edit policy: visible and not viewer-owned.
      if (!canEdit(existing, ctxOf(req))) {
        return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot manage this daemon' })
      }
      const liveConn = deps.liveness.get(id)
      // Direct delivery requires READY; only advertised bootstrap upgrades can queue offline.
      const liveReady = Boolean(liveConn?.reachable && liveConn.state === 'READY')
      const bootstrapUpgrade =
        op === 'upgrade' && existing.capabilities.features.includes(DAEMON_BOOTSTRAP_UPGRADE_FEATURE)
      if (!liveReady && !bootstrapUpgrade) {
        return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: 'daemon is not ready' })
      }
      // Expire stale operations before the partial unique index admits another command.
      await deps.repos.daemonLifecycleOp.expireOverdue(new Date(), DaemonId(id))
      // The pre-check gives a clear 409; the partial unique index backstops races.
      if (await deps.repos.daemonLifecycleOp.pendingForDaemon(DaemonId(id))) {
        return reply
          .code(409)
          .send({ error: 'Conflict', statusCode: 409, message: 'a restart or upgrade is already in progress' })
      }
      const opRow = await deps.repos.daemonLifecycleOp.open({
        daemonId: DaemonId(id),
        op,
        ...(targetVersion ? { targetVersion } : {}),
        ...(req.principal?.userId ? { initiator: req.principal.userId } : {}),
        // Live delivery replaces this estimate with the sender's actual connection epoch.
        commandEpoch: BigInt(liveConn?.sessionEpoch ?? existing.sessionEpoch),
        deadline: new Date(Date.now() + LIFECYCLE_DEADLINE_MS)
      })

      // Re-resolve after open: READY receives direct control; pre-READY reconnects through auth.
      const deliveryConn = deps.liveness.get(id)
      const deliveryReady = Boolean(deliveryConn?.reachable && deliveryConn.state === 'READY')
      if (!deliveryReady && bootstrapUpgrade) {
        if (deliveryConn?.reachable) {
          deps.liveness.reconnectForBootstrap?.(id, deliveryConn.sessionEpoch)
        }
        return reply.code(202).send({
          id: opRow.id,
          op: opRow.op,
          status: opRow.status,
          targetVersion: opRow.targetVersion,
          outcome: opRow.outcome
        })
      }

      // Arm with the exact sent epoch; background recovery handles exhausted write retries.
      const arm = async (epoch: bigint): Promise<boolean> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await deps.repos.daemonLifecycleOp.markAccepted(opRow.id, new Date(), epoch)
            return true
          } catch (err) {
            req.log.warn({ daemonId: id, opId: opRow.id, attempt, err }, 'lifecycle op arm write failed; retrying')
          }
        }
        return false
      }

      const result =
        op === 'upgrade' && targetVersion
          ? await deps.control.daemonUpgrade(id, { targetVersion, drainFirst: true })
          : await deps.control.daemonRestart(id, { reason: 'console-initiated restart', drainFirst: true })

      // Definitely unsent (pre-dispatch NoConnection) → fail the op + 503.
      if (result.kind === 'unsent') {
        await deps.repos.daemonLifecycleOp
          .settle(opRow.id, 'failed', 'daemon connection lost before the command was sent', new Date())
          .catch(() => {})
        return reply
          .code(503)
          .send({ error: 'Service Unavailable', statusCode: 503, message: 'daemon is not reachable' })
      }
      // Definite negative reply (a correlated daemon error frame) → the daemon refused; it did
      // NOT run. Terminal-fail + 409. (This is NOT an ambiguous transport loss.)
      if (result.kind === 'rejected') {
        await deps.repos.daemonLifecycleOp.settle(
          opRow.id,
          'failed',
          `daemon rejected the command: ${result.code}`,
          new Date()
        )
        return reply
          .code(409)
          .send({ error: 'Conflict', statusCode: 409, message: `daemon rejected the command (${result.code})` })
      }
      // A reply that explicitly declined → terminal-fail + 409.
      if (result.kind === 'acked' && !result.ack.accepted) {
        await deps.repos.daemonLifecycleOp.settle(
          opRow.id,
          'failed',
          result.ack.reason ?? 'daemon declined the command',
          new Date()
        )
        return reply
          .code(409)
          .send({ error: 'Conflict', statusCode: 409, message: result.ack.reason ?? 'daemon declined the command' })
      }

      // Accepted OR ambiguous (timeout / post-dispatch loss): the daemon may be draining, so
      // the op must stay resolvable — arm it with the sender's captured epoch and let a later
      // READY settle it (or the deadline fail it). NEVER terminal-fail an ambiguous send.
      const epoch = BigInt(result.epoch)
      if (!(await arm(epoch))) {
        // In-request arm exhausted (transient DB failure). Kick a bounded background recovery
        // that arms + settles once the DB recovers (within the deadline), so the op isn't left
        // unarmed → falsely timed out. Tell the caller the outcome is not yet confirmed.
        void retryArm(deps.repos.daemonLifecycleOp, deps.registry, opRow.id, id, epoch, ARM_RECOVERY_DELAYS_MS, req.log)
        return reply.code(502).send({
          error: 'Bad Gateway',
          statusCode: 502,
          message: 'daemon accepted the command but the control plane could not record it yet — recovery in progress'
        })
      }
      // Armed → re-check to close an already-observed completion (a fast restart that reached
      // READY before/while this returned). If the re-check throws, that READY may have been
      // the only settle trigger, so hand off to the background recovery (retries settle) rather
      // than swallowing it — otherwise the op could sit until a false timeout.
      try {
        await deps.registry.settleLifecycleOpOnReady(DaemonId(id))
      } catch (err) {
        req.log.warn({ daemonId: id, opId: opRow.id, err }, 'lifecycle op READY re-check failed; scheduling recovery')
        void retryArm(deps.repos.daemonLifecycleOp, deps.registry, opRow.id, id, epoch, ARM_RECOVERY_DELAYS_MS, req.log)
      }
      const latest = (await deps.repos.daemonLifecycleOp.getById(opRow.id).catch(() => null)) ?? opRow
      return reply.code(202).send({
        id: latest.id,
        op: latest.op,
        status: latest.status,
        targetVersion: latest.targetVersion,
        outcome: latest.outcome
      })
    }

    // Install a target daemon version, then drain + relaunch onto it (§7).
    r.post(
      '/daemons/:id/upgrade',
      {
        schema: {
          tags: [Tag.Daemons],
          summary: 'Upgrade a daemon',
          description:
            'Open an upgrade op for a daemon. A ready daemon receives it immediately; an offline daemon that previously advertised bootstrap recovery consumes it during its next auth. The 202 means accepted or durably queued, while success requires READY on the target version.',
          operationId: 'upgradeDaemon',
          params: IdParam,
          body: DaemonUpgradeBody,
          response: {
            202: DaemonLifecycleOpDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            502: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => commandLifecycle(req, reply, req.params.id, 'upgrade', req.body.version)
    )

    // Drain + relaunch on the SAME version (supervisor restart, §7).
    r.post(
      '/daemons/:id/restart',
      {
        schema: {
          tags: [Tag.Daemons],
          summary: 'Restart a daemon',
          description:
            'Command a daemon to drain and exit so its supervisor relaunches it (same version). The 202 returns the opened lifecycle op (with its id) and only means the daemon accepted the command; success is confirmed when it re-registers — track the op by id via the fleet read model’s lifecycleOp.',
          operationId: 'restartDaemon',
          params: IdParam,
          response: {
            202: DaemonLifecycleOpDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            502: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => commandLifecycle(req, reply, req.params.id, 'restart')
    )

    // Fetch one lifecycle op by id — the console polls THIS (not the fleet's single
    // latest-op slot) so its tracking survives a newer op from another client becoming
    // the daemon's latest. Read-only; org-scoped + visibility-gated like the daemon itself.
    r.get(
      '/daemons/:id/lifecycle/:opId',
      {
        schema: {
          tags: [Tag.Daemons],
          summary: 'Get a daemon lifecycle op',
          description:
            'Fetch a single CP-commanded restart/upgrade op by id (status expiry-projected). The console polls this to track the command it issued.',
          operationId: 'getDaemonLifecycleOp',
          params: z.object({ id: z.string(), opId: z.string() }),
          response: { 200: DaemonLifecycleOpDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const existing = await getOrgDaemon(req, req.params.id)
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        const opRow = await deps.repos.daemonLifecycleOp.getById(req.params.opId)
        // 404 a foreign op id too (belongs to another daemon) — no cross-daemon oracle.
        if (!opRow || opRow.daemonId !== req.params.id) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'lifecycle op not found' })
        }
        const expired = opRow.status === 'pending' && opRow.deadline.getTime() <= Date.now()
        return {
          id: opRow.id,
          op: opRow.op,
          status: expired ? ('failed' as const) : opRow.status,
          targetVersion: opRow.targetVersion,
          outcome: expired ? 'timed out — the daemon did not re-register before the deadline' : opRow.outcome
        }
      }
    )
  }
}
