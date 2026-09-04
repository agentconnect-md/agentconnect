/**
 * `http/routes/crons.ts` (design §2.1) — CRUD for cron definitions through the
 * C6 `CronRepo`. A cron drives ONE agent (§3.11): `agentId` is required on
 * upsert; `targetChannel` is optional output routing (absent ⇒ headless fire).
 * `PUT /crons/:id` is an idempotent upsert keyed on the cron UUID, mirroring
 * the `cron/upsert` re-apply semantics; `DELETE` mirrors `cron/remove`.
 *
 * Every write is also pushed live to the OWNING AGENT'S daemon (§3.11: "pushed
 * via `cron/upsert` … removed via `cron/remove`"; same placement scope as
 * integrations). A push failure never fails the CRUD: an offline daemon
 * converges on its next `register` reconcile. All reads/writes scope to the
 * caller's active org; viewers are read-only.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { isSyntheticEmail, type AgentRecord, type CronRecord } from '../../persistence/ports.js'
import { AgentId, CronId, IntegrationId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { refreshMutationAgent as refreshAgentUnderMutation } from '../mutation-agent.js'
import { canView, canEdit, canManageSharing, type ViewCtx } from '../../authorization/policy.js'
import { resolveShareSet } from '../sharing.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { cronToUpsert } from '../../orchestrator/placement.js'
import { toDbPlatform } from '../../persistence/platform.js'
import { Tag } from '../plugins/openapi.js'
import {
  UpsertCronBody,
  SetSharingBody,
  CronDto,
  CronListDto,
  CronRunListDto,
  ErrorDto,
  IdParam,
  type CronDtoT
} from '../dto/index.js'

function toDto(c: CronRecord, ctx: ViewCtx): CronDtoT {
  return {
    id: c.id,
    orgId: c.orgId,
    agentId: c.agentId,
    name: c.name,
    schedule: c.schedule,
    timezone: c.timezone,
    // Cron targets are only ever slack/telegram (webchat has no external channel
    // to fire into); narrow the wider protocol platform to the DTO's target enum.
    targetPlatform: toDbPlatform(c.targetPlatform),
    targetChannel: c.targetChannel,
    targetIntegrationId: c.targetIntegrationId,
    trigger: c.trigger,
    enabled: c.enabled,
    lastRunAt: c.lastRunAt ? c.lastRunAt.toISOString() : null,
    // The creator's userId (web resolves it to a display name / "You"); a synthesized
    // `<sub>@oidc.local` placeholder means a non-human creator → null (shows "—").
    createdBy: c.createdBy && !isSyntheticEmail(c.createdBy.email) ? c.createdBy.userId : null,
    createdAt: c.createdAt.toISOString(),
    lastModifiedBy: c.lastModifiedBy && !isSyntheticEmail(c.lastModifiedBy.email) ? c.lastModifiedBy.userId : null,
    lastModifiedAt: c.lastModifiedAt.toISOString(),
    visibility: c.visibility,
    sharedWith: c.sharedWith,
    canEdit: canEdit(c, ctx),
    canManageSharing: canManageSharing(c, ctx)
  }
}

export function cronRoutes(deps: HttpDeps) {
  return async function cronRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const refreshMutationAgent = (observed: AgentRecord) => refreshAgentUnderMutation(deps.repos.agent, observed)

    // Fetch a cron AND verify it's in the caller's org AND visible to them — a
    // cross-org id OR a restricted cron they can't see both read as absent (404).
    // The single insertion point that replaces the scattered inline org checks.
    const getOrgCron = async (req: FastifyRequest, id: string): Promise<CronRecord | null> => {
      const cron = await deps.repos.cron.get(orgOf(req), CronId(id))
      if (!cron) return null
      return canView(cron, ctxOf(req)) ? cron : null
    }

    // Best-effort per-target log for a cron push. The delivery set itself is
    // `deps.agentDelivery`'s call (placement ∪ duty holders): a cron drives the
    // agent, so it belongs wherever the agent is served. Offline daemon ⇒ the
    // register/ok reconcile snapshot carries it on the next connect.
    const cronPushFailed =
      (what: string) =>
      (err: unknown, daemonId: string): void => {
        if (err instanceof NoConnection) {
          app.log.debug({ daemonId }, `${what} skipped: daemon offline`)
          return
        }
        app.log.warn({ daemonId, err }, `${what} live push failed — daemon converges on next register`)
      }

    r.put(
      '/crons/:id',
      {
        schema: {
          tags: [Tag.Crons],
          summary: 'Create or update a cron',
          description:
            'Idempotent upsert of a cron definition keyed on its client-minted UUID; every write is best-effort pushed live to the owning agent’s daemon.',
          operationId: 'upsertCron',
          params: IdParam,
          body: UpsertCronBody,
          response: { 200: CronDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        // The UUID is client-minted. On an EDIT (existing row), refuse if it's
        // another org's cron OR one this caller can't see (both 404), and require
        // edit rights (403). A brand-new id falls through to create.
        const existing = await deps.repos.cron.get(orgId, CronId(req.params.id))
        if (existing) {
          const ctx = ctxOf(req)
          if (!canView(existing, ctx)) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'cron not found' })
          }
          if (!canEdit(existing, ctx)) {
            return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this cron' })
          }
        }
        // The cron's agent must exist IN THIS ORG and be VISIBLE to the caller — it
        // defines both the fire target and the owning daemon. A restricted agent they
        // can't see is rejected identically to a nonexistent id (no existence oracle,
        // and no binding-then-firing a restricted agent). Mirrors integrations create.
        let agent = await deps.repos.agent.get(orgOf(req), AgentId(req.body.agentId))
        if (!agent || !canView(agent, ctxOf(req))) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'unknown agentId' })
        }
        // The target rides one of THIS agent's integrations — the anchor is
        // posted through that bot connection, and the stored platform is derived
        // from it. Only meaningful with a channel (headless ⇒ dropped).
        let targetIntegrationId: IntegrationId | undefined
        let targetPlatform = req.body.targetPlatform
        if (req.body.targetIntegrationId && req.body.targetChannel) {
          const integ = await deps.repos.integration.get(orgId, IntegrationId(req.body.targetIntegrationId))
          if (!integ || integ.agentId !== agent.id) {
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'targetIntegrationId is not an integration of this agent'
            })
          }
          targetIntegrationId = integ.id
          targetPlatform = toDbPlatform(integ.platform)
        }
        const release = deps.agentMutations.tryBeginMutation([
          agent.id,
          ...(existing?.agentId && existing.agentId !== agent.id ? [existing.agentId] : [])
        ])
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the cron change' })
        }
        try {
          const current = await refreshMutationAgent(agent)
          const previousAgent =
            existing?.agentId && existing.agentId !== agent.id
              ? await deps.repos.agent.get(orgOf(req), existing.agentId)
              : current
          if (!current || !previousAgent) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'agent placement changed; refresh and retry the cron change'
            })
          }
          agent = current
          // Restricted-on-create: honored only for a NEW cron (the repo writes sharing
          // on its create branch only). sharedWith is intersected with org members.
          const initialSharedWith =
            !existing && req.body.sharedWith
              ? await resolveShareSet(deps.repos.user, orgId, req.body.sharedWith)
              : undefined
          const cron = await deps.repos.cron.upsert({
            cronId: CronId(req.params.id),
            orgId,
            agentId: agent.id,
            ...(req.body.name ? { name: req.body.name } : {}),
            schedule: req.body.schedule,
            // The server never guesses a zone. This used to fall back to the CP PROCESS's own zone —
            // UTC in a container — so an omission put a schedule on a clock nobody chose, and an edit
            // that omitted it moved an existing schedule off the one it was authored on.
            timezone: req.body.timezone ?? existing?.timezone ?? 'UTC',
            targetPlatform,
            ...(req.body.targetChannel ? { targetChannel: req.body.targetChannel } : {}),
            ...(targetIntegrationId ? { targetIntegrationId } : {}),
            trigger: req.body.trigger,
            enabled: req.body.enabled,
            ...(!existing && req.body.visibility ? { visibility: req.body.visibility } : {}),
            ...(initialSharedWith ? { sharedWith: initialSharedWith } : {}),
            // createdByUserId is stamped on create only; lastModifiedByUserId is
            // stamped on every upsert (create AND edit) — this PUT is a human action.
            ...(req.principal
              ? { createdByUserId: req.principal.userId, lastModifiedByUserId: req.principal.userId }
              : {})
          })
          // An enabled cron is a duty edge (design §4.7), so enabling or
          // disabling one changes the group's claimability.
          deps.recomputeDuties?.(orgId)
          void deps.repos.audit
            .append({
              kind: 'cron_change',
              orgId,
              agentId: agent.id,
              ...(req.principal ? { actorUserId: req.principal.userId } : {}),
              frameType: 'cron/upsert',
              message: `cron ${cron.id} upserted`,
              details: {
                cronId: cron.id,
                schedule: cron.schedule,
                timezone: cron.timezone,
                targetChannel: cron.targetChannel,
                enabled: cron.enabled
              }
            })
            .catch(() => {})
          const wire = cronToUpsert(cron)
          if (wire) {
            await deps.agentDelivery.cronUpsert(agent, wire, cronPushFailed('cron/upsert'))
          }
          return toDto(cron, ctxOf(req))
        } finally {
          release()
        }
      }
    )

    r.get(
      '/crons',
      {
        schema: {
          tags: [Tag.Crons],
          summary: 'List crons',
          description: 'Every cron definition in the caller’s active organization.',
          operationId: 'listCrons',
          response: { 200: CronListDto }
        }
      },
      async (req) => {
        const ctx = ctxOf(req)
        const rows = await deps.repos.cron.listForOrg(orgOf(req), ctx)
        return rows.map((c) => toDto(c, ctx))
      }
    )

    r.get(
      '/crons/:id',
      {
        schema: {
          tags: [Tag.Crons],
          summary: 'Get a cron',
          description: 'A single cron definition by id, scoped to the caller’s active organization.',
          operationId: 'getCron',
          params: IdParam,
          response: { 200: CronDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const cron = await getOrgCron(req, req.params.id)
        if (!cron) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'cron not found' })
        }
        return toDto(cron, ctxOf(req))
      }
    )

    // Run history (daemon-reported via cron/report), newest first — the console
    // detail page's Runs card.
    r.get(
      '/crons/:id/runs',
      {
        schema: {
          tags: [Tag.Crons],
          summary: 'List cron runs',
          description: 'Daemon-reported run history for a cron, newest first.',
          operationId: 'listCronRuns',
          params: IdParam,
          response: { 200: CronRunListDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const cron = await getOrgCron(req, req.params.id)
        if (!cron) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'cron not found' })
        }
        const runs = await deps.repos.cron.listRuns(cron.orgId, cron.id)
        return runs.map((run) => ({
          id: run.id,
          startedAt: run.startedAt.toISOString(),
          status: run.status,
          durationMs: run.durationMs,
          sessionId: run.sessionId,
          reason: run.reason
        }))
      }
    )

    // Console "Run now": fire the cron on its daemon immediately. The 202 only
    // says the daemon ACCEPTED the fire — the run itself is async and lands in
    // the run history via cron/report. Offline daemon / unplaced agent ⇒ 503.
    r.post(
      '/crons/:id/run',
      {
        schema: {
          tags: [Tag.Crons],
          summary: 'Trigger a cron run',
          description:
            'Fire the cron on its daemon immediately; the 202 only means the daemon accepted the fire — the run itself is async and lands in the run history.',
          operationId: 'triggerCronRun',
          params: IdParam,
          response: { 202: z.null(), 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        // "Run now" fires an agent turn — an execution-causing WRITE, so it needs
        // canEdit, not just visibility. A collaborator who can't see a restricted
        // cron 404s; one who can see but not edit it 403s.
        const cron = await getOrgCron(req, req.params.id)
        if (!cron) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'cron not found' })
        }
        if (!canEdit(cron, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot run this cron' })
        }
        const agent = cron.agentId ? await deps.repos.agent.get(orgOf(req), cron.agentId) : null
        // A manual run goes to whoever serves the agent right now — its placement, or the member
        // holding its duty. Nothing serving it is a 503, exactly as an unplaced agent was.
        if (!agent || !(await deps.placementResolver.servingDaemon(agent))) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'agent is not placed on a daemon' })
        }
        const release = deps.agentMutations.tryBeginMutation(agent.id)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the cron run' })
        }
        try {
          const current = await refreshMutationAgent(agent)
          if (!current) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'agent placement changed; refresh and retry the cron run'
            })
          }
          // Re-resolved under the lease rather than read off the row, so the fire reaches the
          // member serving a pool agent instead of refusing on a column that names no machine.
          const daemonId = await deps.placementResolver.servingDaemon(current)
          if (!daemonId) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'agent is no longer placed; refresh and retry' })
          }
          const ack = await deps.control.cronRun(daemonId, { cronId: cron.id })
          if (!ack.ok) {
            return reply
              .code(400)
              .send({ error: 'Bad Request', statusCode: 400, message: ack.reason ?? 'daemon rejected the run' })
          }
        } catch (err) {
          if (err instanceof NoConnection) {
            return reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: 'daemon is offline' })
          }
          throw err
        } finally {
          release()
        }
        return reply.code(202).send(null)
      }
    )

    r.delete(
      '/crons/:id',
      {
        schema: {
          tags: [Tag.Crons],
          summary: 'Delete a cron',
          description: 'Remove a cron definition and best-effort push the removal to the owning agent’s daemon.',
          operationId: 'deleteCron',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const existing = await getOrgCron(req, req.params.id)
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'cron not found' })
        }
        if (!canEdit(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this cron' })
        }
        const removePersistedCron = async (): Promise<boolean> => {
          const removed = await deps.repos.cron.remove(orgId, existing.id, existing.agentId)
          if (!removed) return false
          deps.recomputeDuties?.(orgId)
          void deps.repos.audit
            .append({
              kind: 'cron_change',
              orgId,
              ...(existing.agentId ? { agentId: existing.agentId } : {}),
              ...(req.principal ? { actorUserId: req.principal.userId } : {}),
              frameType: 'cron/remove',
              message: `cron ${existing.id} removed`,
              details: { cronId: existing.id }
            })
            .catch(() => {})
          return true
        }
        const existingAgentId = existing.agentId
        if (!existingAgentId) {
          if (!(await removePersistedCron())) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'cron changed; refresh and retry the delete' })
          }
          return reply.code(204).send(null)
        }
        let agent = await deps.repos.agent.get(orgOf(req), existingAgentId)
        if (!agent) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent changed; refresh and retry the cron change' })
        }
        const release = deps.agentMutations.tryBeginMutation(existingAgentId)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the cron change' })
        }
        try {
          const current = await refreshMutationAgent(agent)
          if (!current) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'agent placement changed; refresh and retry the cron change'
            })
          }
          agent = current
          if (!(await removePersistedCron())) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'cron changed; refresh and retry the delete' })
          }
          // The row's own org scopes cron/remove when a holder never registered this cron.
          await deps.agentDelivery.cronRemove(agent, existing.id, existing.orgId, cronPushFailed('cron/remove'))
          return reply.code(204).send(null)
        } finally {
          release()
        }
      }
    )

    // Set who can see this cron (visibility + complete Selected audience).
    // Gated exactly like a content edit (§13.3). A cron carries visibility
    // independently of its target agent. Visibility
    // never rides the wire.
    r.put(
      '/crons/:id/sharing',
      {
        schema: {
          tags: [Tag.Crons],
          summary: 'Set cron sharing',
          description:
            'Set a schedule’s visibility (Everyone vs Selected) and complete Selected audience. Requires edit rights; Selected must retain at least one current organization member, and sharedWith is intersected with current membership.',
          operationId: 'setCronSharing',
          params: IdParam,
          body: SetSharingBody,
          response: { 200: CronDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await getOrgCron(req, req.params.id)
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'cron not found' })
        }
        if (!canManageSharing(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot change sharing' })
        }
        const existingAgentId = existing.agentId
        if (!existingAgentId) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'cron has no agent; refresh and retry' })
        }
        const observedAgent = await deps.repos.agent.get(orgOf(req), existingAgentId)
        if (!observedAgent) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent changed; refresh and retry the cron change' })
        }
        const release = deps.agentMutations.tryBeginMutation(existingAgentId)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the cron change' })
        }
        try {
          if (!(await refreshMutationAgent(observedAgent))) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'agent placement changed; refresh and retry the cron change'
            })
          }
          const sharedWith = await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
          const cron = await deps.repos.cron.setSharing(
            orgOf(req),
            CronId(req.params.id),
            { visibility: req.body.visibility, sharedWith },
            req.principal?.userId
          )
          return toDto(cron, ctxOf(req))
        } finally {
          release()
        }
      }
    )
  }
}
