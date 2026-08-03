/**
 * `http/routes/organization-environment.ts` — the organization-owned variable and
 * secret registry (organization-secrets-and-variables.md §6).
 *
 *   GET    /orgs/:orgId/environment
 *   POST   /orgs/:orgId/environment
 *   PATCH  /orgs/:orgId/environment/:entryId
 *   DELETE /orgs/:orgId/environment/:entryId
 *   PUT    /orgs/:orgId/environment/:entryId/agents/:agentId
 *   DELETE /orgs/:orgId/environment/:entryId/agents/:agentId
 *
 * THREE invariants this layer owns:
 *
 *  1. WRITE-ONLY SECRETS. A value is accepted on create/replace and never leaves:
 *     no response field, no log line, no audit payload, no error message. Not even
 *     an owner can read one back.
 *
 *  2. NO RESTRICTED-AGENT DISCOVERY. `organization.manage` gates the registry, but
 *     it never widens agent visibility. Creating a binding — including through `all`
 *     enrollment — takes a `resource.edit` decision on that agent, made inside the
 *     repository transaction. A point request for an invisible, non-editable, or
 *     foreign agent gets the ordinary not-found response, so the endpoint cannot be
 *     used to probe for another member's private agent. Responses list only bindings
 *     whose agents the caller can view, and editing that visible selection neither
 *     returns nor removes bindings to agents it cannot see.
 *
 *  3. DURABLE FIRST, FAN-OUT AFTER. The entry commits, then `agent/upsert` goes to
 *     each affected online daemon. Fan-out is best-effort: an unplaced agent needs
 *     no event, an offline daemon picks the resolved maps up from the `register/ok`
 *     roster, and an older fan-out completing late is harmless because its lower
 *     `configRevision` cannot overwrite a newer daemon snapshot.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AGENT_CONFIG_REVISION_FEATURE } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { ctxOf, denyNonOwner, orgOf } from '../rbac.js'
import { AgentId, type DaemonId, type OrgId } from '../../domain/ids.js'
import { canEdit, canView, type ViewCtx } from '../../authorization/policy.js'
import type {
  OrganizationEnvironmentEntryRecord,
  OrganizationEnvironmentWriteResult,
  OrganizationEnvironmentWriteFailure
} from '../../persistence/ports.js'
import {
  CreateOrganizationEnvironmentEntryBody,
  ErrorDto,
  OrganizationEnvironmentAgentParam,
  OrganizationEnvironmentEntryDto,
  OrganizationEnvironmentEntryParam,
  OrganizationEnvironmentListDto,
  UpdateOrganizationEnvironmentEntryBody,
  type OrganizationEnvironmentEntryDtoT
} from '../dto/index.js'

/**
 * Project one entry for a human response. `visibleAgentIds` is the caller-filtered
 * binding set: the entry may be bound to agents this caller cannot see, and the
 * response must neither list them nor let the caller infer that they exist.
 */
function entryDto(
  row: OrganizationEnvironmentEntryRecord,
  visibleAgentIds: string[]
): OrganizationEnvironmentEntryDtoT {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    // A variable's value is ordinary configuration. A secret contributes only
    // whether material is stored — the value itself has no read path at all.
    ...(row.kind === 'variable'
      ? { variableValue: row.variableValue ?? '' }
      : { secretConfigured: row.secretConfigured }),
    audience: row.audience,
    visibleAgentIds,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

function missing(reply: FastifyReply, message = 'organization environment entry not found') {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404, message })
}

export function organizationEnvironmentRoutes(deps: HttpDeps) {
  return async function organizationEnvironmentRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const repo = deps.repos.organizationEnvironment

    /** The agent ids among `agentIds` that this caller may VIEW (not necessarily edit). */
    const visibleAgentIdsOf = async (orgId: OrgId, ctx: ViewCtx, agentIds: readonly string[]): Promise<string[]> => {
      if (agentIds.length === 0) return []
      const agents = await deps.repos.agent.list(orgId)
      const byId = new Map(agents.map((agent) => [agent.id as string, agent]))
      return agentIds.filter((agentId) => {
        const agent = byId.get(agentId)
        return agent !== undefined && canView(agent, ctx)
      })
    }

    const dtoFor = async (
      orgId: OrgId,
      ctx: ViewCtx,
      row: OrganizationEnvironmentEntryRecord
    ): Promise<OrganizationEnvironmentEntryDtoT> => entryDto(row, await visibleAgentIdsOf(orgId, ctx, row.agentIds))

    /**
     * Replicate the resolved spec to each affected agent's online daemon after the
     * durable commit. Deliberately swallows per-agent failures: the entry is already
     * authoritative and the reconnect roster repairs anything missed. Logs carry
     * ids, keys, kinds, and counts — never a variable value in bulk and never a
     * secret value at all (§9).
     */
    const fanOut = async (orgId: OrgId, agentIds: readonly string[], reason: string): Promise<void> => {
      if (agentIds.length === 0) return
      const agents = await deps.repos.agent.list(orgId)
      const affected = agents.filter((agent) => agentIds.includes(agent.id))
      await Promise.all(
        affected.map(async (agent) => {
          // An unplaced agent needs no event; it will be assembled at placement.
          if (!agent.daemonId) return
          try {
            const spec = await deps.agentSpecs.assemble(agent)
            await deps.control.agentUpsert(agent.daemonId, { agentId: agent.id, spec })
          } catch (err) {
            app.log.warn(
              { err, orgId, agentId: agent.id, reason },
              'organization environment fan-out deferred to reconnect roster'
            )
          }
        })
      )
    }

    /** Does this placed agent's daemon persist and enforce `configRevision`? An
     *  unplaced agent is always fine (placement re-checks the feature), and an
     *  unknown/never-registered daemon cannot be proven compatible — the gate
     *  never relies on lenient behavior from an unverified daemon. */
    const onCompatibleDaemon = async (daemonId: DaemonId | null): Promise<boolean> => {
      if (daemonId === null) return true
      const daemon = await deps.registry.get(daemonId)
      return !!daemon?.capabilities.features.includes(AGENT_CONFIG_REVISION_FEATURE)
    }

    /**
     * The subset of `agentIds` on an incompatible daemon — the agents `all`
     * enrollment SKIPS (§10 step 3) rather than letting one stale daemon block an
     * organization-wide entry. A skipped agent stays unbound until a later
     * authorized configuration write enrolls it, by which point rotation and
     * placement gates protect it. Callers pass only caller-editable ids, so the
     * result is always safe to act on (and count in logs).
     */
    const incompatiblePlacedAgentIds = async (orgId: OrgId, agentIds: readonly string[]): Promise<string[]> => {
      if (agentIds.length === 0) return []
      const wanted = new Set(agentIds)
      const placed = (await deps.repos.agent.list(orgId)).filter((agent) => wanted.has(agent.id))
      const out: string[] = []
      for (const agent of placed) {
        if (!(await onCompatibleDaemon(agent.daemonId))) out.push(agent.id)
      }
      return out
    }

    /**
     * Rollout gate (§10 step 3) for the writes that CANNOT skip an agent: an
     * explicitly requested binding (the caller named the agent, so a silent
     * no-op would lie) and a value rotation that genuinely reaches every
     * already-bound agent. Full-map replacement is only safe behind the
     * `configRevision` fence: on an older daemon a late-completing older snapshot
     * could reinstate a rotated or deleted value. An unplaced bound agent may be
     * saved — placement then requires the same daemon feature.
     *
     * Returns the message to refuse with, or null when every affected agent is fine.
     *
     * NON-DISCLOSING BY CONSTRUCTION. This runs BEFORE the repository applies
     * `resource.edit` to a caller-supplied target, so it must never let a 409 prove
     * something a 404 would have hidden. Two rules:
     *
     *  - `mode: 'requested'` — the ids came from the request body/path and are not
     *    yet authorized. Only agents the caller may EDIT are examined; anything else
     *    is left to the repository, which returns the not-found-shaped result. A
     *    guessed restricted agent id therefore still yields 404, never a 409 that
     *    names it.
     *  - `mode: 'bound'` — the ids are already-bound agents on a rotation path, so
     *    the gate must cover them all (the new value really does reach them), but an
     *    agent the caller cannot VIEW is described without its name.
     */
    const incompatibleDaemonMessage = async (
      orgId: OrgId,
      ctx: ViewCtx,
      agentIds: readonly string[],
      mode: 'requested' | 'bound'
    ): Promise<string | null> => {
      if (agentIds.length === 0) return null
      const wanted = new Set(agentIds)
      const agents = (await deps.repos.agent.list(orgId)).filter((agent) => wanted.has(agent.id))
      // An unauthorized target is not this gate's business — dropping it here is
      // what keeps the refusal indistinguishable from a missing agent.
      const inScope = mode === 'requested' ? agents.filter((agent) => canEdit(agent, ctx)) : agents
      for (const agent of inScope) {
        if (!(await onCompatibleDaemon(agent.daemonId))) {
          // Naming is safe only for an agent the caller can already see.
          return canView(agent, ctx)
            ? `agent ${agent.name} runs on a daemon that does not yet support organization environment entries; upgrade it first`
            : 'an agent this entry is assigned to runs on a daemon that does not yet support organization environment entries; upgrade it first'
        }
      }
      return null
    }

    /**
     * The agents `all` enrollment would reach for THIS caller — the same
     * `resource.edit` projection the repository re-evaluates inside its
     * transaction. Used only to pre-gate the daemon-compatibility check; the
     * repository decision remains authoritative. Naming one of these agents in an
     * error is safe: the caller can already manage every agent in this set.
     */
    const enrollableAgentIdsOf = async (orgId: OrgId, ctx: ViewCtx): Promise<string[]> => {
      if (ctx.role === 'viewer') return []
      const agents = await deps.repos.agent.list(orgId, ctx)
      return agents.filter((agent) => canEdit(agent, ctx)).map((agent) => agent.id as string)
    }

    /** Map a repository refusal onto its HTTP shape, never carrying a value. */
    const sendFailure = (reply: FastifyReply, failure: OrganizationEnvironmentWriteFailure) => {
      switch (failure.outcome) {
        case 'not_found':
        // An unauthorized or invisible agent target is deliberately
        // INDISTINGUISHABLE from a missing one, so this endpoint cannot be used to
        // discover another member's restricted agent.
        case 'agent_not_found':
          return missing(reply)
        case 'version_conflict':
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'this entry changed since it was loaded; refresh before saving'
          })
        case 'duplicate_key':
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'this organization already has a variable or secret with that name'
          })
        case 'not_selected':
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'per-agent assignment applies only while the entry targets selected agents'
          })
        case 'cross_kind_conflict':
          // Names, not values: an organization VARIABLE may not take over a key an
          // agent holds as a SECRET, because that would move it out of the
          // write-only map. The operator must remove or rename one side (§3.2).
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: `an agent already defines ${failure.keys.join(', ')} as a secret; an organization variable cannot replace a secret. Remove or rename one side first.`
          })
        case 'too_large':
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'the resulting agent configuration would exceed the size the daemon protocol admits'
          })
      }
    }

    /** Shared tail for the four mutating routes: gate, reply, then fan out. */
    const settle = async (
      req: FastifyRequest,
      reply: FastifyReply,
      result: OrganizationEnvironmentWriteResult,
      reason: string,
      code: 200 | 201 = 200
    ) => {
      if (result.outcome !== 'ok') return sendFailure(reply, result)
      const body = await dtoFor(orgOf(req), ctxOf(req), result.entry)
      // Fan out AFTER the durable commit; failures fall back to the reconnect roster.
      await fanOut(orgOf(req), result.affectedAgentIds, reason)
      return reply.code(code).send(body)
    }

    r.get(
      '/environment',
      {
        schema: {
          tags: [Tag.Environment],
          summary: 'List organization variables and secrets',
          description:
            'Lists the organization environment registry. Owner-only. Variable values are returned; secret values never are — only whether material is stored. Bindings are filtered to agents the caller can view.',
          operationId: 'listOrganizationEnvironment',
          response: { 200: OrganizationEnvironmentListDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const rows = await repo.list(orgOf(req))
        return Promise.all(rows.map((row) => dtoFor(orgOf(req), ctxOf(req), row)))
      }
    )

    r.post(
      '/environment',
      {
        schema: {
          tags: [Tag.Environment],
          summary: 'Create an organization variable or secret',
          description:
            'Defines one organization-owned entry and targets it at all agents or a selected set. A secret value is write-only: it is accepted here and never returned. `all` enrolls every agent the caller may edit and auto-enrolls agents on later authorized configuration writes; it never reaches an agent the caller cannot manage, and it skips an agent placed on a daemon that does not yet support organization environment entries (that agent enrolls on a later configuration write once its daemon is upgraded). `key` and `kind` are immutable afterwards.',
          operationId: 'createOrganizationEnvironmentEntry',
          body: CreateOrganizationEnvironmentEntryBody,
          response: { 201: OrganizationEnvironmentEntryDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = orgOf(req)
        const ctx = ctxOf(req)
        // Daemon compatibility, two postures: an EXPLICIT selection is gated (the
        // caller named the agent and can deselect it), while `all` enrollment SKIPS
        // an agent on an incompatible daemon — one stale daemon must not block an
        // organization-wide entry. The repository re-decides authorization inside
        // its transaction; this only shapes what a placed daemon must safely apply.
        let excludeAgentIds: string[] = []
        if (req.body.audience === 'all') {
          excludeAgentIds = await incompatiblePlacedAgentIds(orgId, await enrollableAgentIdsOf(orgId, ctx))
          if (excludeAgentIds.length > 0) {
            app.log.info(
              { orgId, skippedAgents: excludeAgentIds.length },
              'organization environment `all` enrollment skipped agents on incompatible daemons'
            )
          }
        } else {
          const blocked = await incompatibleDaemonMessage(orgId, ctx, req.body.agentIds ?? [], 'requested')
          if (blocked) return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: blocked })
        }
        // Seal OUTSIDE the transaction: a real cipher may make network calls, and a
        // transaction must never wait on one. Material prepared for a losing write is
        // discarded, never logged.
        const sealedSecret =
          req.body.kind === 'secret' ? await deps.repos.organizationEnvironmentSecret.seal(req.body.value) : undefined
        const result = await repo.create(
          orgId,
          {
            key: req.body.key,
            kind: req.body.kind,
            ...(req.body.kind === 'variable' ? { variableValue: req.body.value } : {}),
            ...(sealedSecret !== undefined ? { sealedSecret } : {}),
            audience: req.body.audience,
            ...(req.body.agentIds ? { agentIds: req.body.agentIds } : {}),
            ...(excludeAgentIds.length > 0 ? { excludeAgentIds } : {})
          },
          { actorUserId: ctx.userId, viewer: ctx }
        )
        return settle(req, reply, result, 'entry created', 201)
      }
    )

    r.patch(
      '/environment/:entryId',
      {
        schema: {
          tags: [Tag.Environment],
          summary: 'Replace a value or retarget an organization entry',
          description:
            'Replaces the value and/or changes the audience under `expectedVersion`. An omitted value leaves it unchanged, which is how the Console keeps an existing secret while editing other fields. Switching to `all` enrolls every agent the caller may edit (skipping agents on daemons that do not yet support organization environment entries) and keeps existing delegated bindings; switching to `selected` stops automatic enrollment without revoking bindings to private agents the caller cannot see. `key` and `kind` cannot change — rename or convert by deleting and recreating.',
          operationId: 'updateOrganizationEnvironmentEntry',
          params: OrganizationEnvironmentEntryParam,
          body: UpdateOrganizationEnvironmentEntryBody,
          response: { 200: OrganizationEnvironmentEntryDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = orgOf(req)
        const ctx = ctxOf(req)
        const existing = await repo.get(orgId, req.params.entryId)
        if (!existing) return missing(reply)
        // A value replacement re-reaches every currently bound agent, so that set
        // is GATED in full (the rotation genuinely reaches them; an agent the
        // caller cannot see is described without its name). A switch to `all` only
        // adds bindings, so newly enrolled agents on an incompatible daemon are
        // SKIPPED instead — same posture as create.
        const blocked = await incompatibleDaemonMessage(
          orgId,
          ctx,
          req.body.value !== undefined ? existing.agentIds : [],
          'bound'
        )
        if (blocked) return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: blocked })
        const excludeAgentIds =
          req.body.audience === 'all'
            ? await incompatiblePlacedAgentIds(orgId, await enrollableAgentIdsOf(orgId, ctx))
            : []
        if (excludeAgentIds.length > 0) {
          app.log.info(
            { orgId, entryId: req.params.entryId, skippedAgents: excludeAgentIds.length },
            'organization environment `all` enrollment skipped agents on incompatible daemons'
          )
        }
        const sealedSecret =
          existing.kind === 'secret' && req.body.value !== undefined
            ? await deps.repos.organizationEnvironmentSecret.seal(req.body.value)
            : undefined
        const result = await repo.update(
          orgId,
          req.params.entryId,
          req.body.expectedVersion,
          {
            ...(existing.kind === 'variable' && req.body.value !== undefined ? { variableValue: req.body.value } : {}),
            ...(sealedSecret !== undefined ? { sealedSecret } : {}),
            ...(req.body.audience !== undefined ? { audience: req.body.audience } : {}),
            ...(excludeAgentIds.length > 0 ? { excludeAgentIds } : {})
          },
          { actorUserId: ctx.userId, viewer: ctx }
        )
        return settle(req, reply, result, 'entry updated')
      }
    )

    r.delete(
      '/environment/:entryId',
      {
        schema: {
          tags: [Tag.Environment],
          summary: 'Delete an organization variable or secret',
          description:
            'Removes the entry and every binding it had, exercising the authority each binding already delegated. The agents that were receiving it are not disclosed. Each affected daemon then receives a full snapshot without the key, so any same-key agent-local row becomes effective again. A process already running keeps the old value until its next safe replacement point.',
          operationId: 'deleteOrganizationEnvironmentEntry',
          params: OrganizationEnvironmentEntryParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = orgOf(req)
        const result = await repo.delete(orgId, req.params.entryId)
        if (result.outcome !== 'ok') return missing(reply)
        // Deletion is always admissible — it can only shrink a resolved spec — so it
        // is NOT daemon-gated: an operator must be able to withdraw a credential even
        // from an agent placed on an older daemon.
        await fanOut(orgId, result.affectedAgentIds, 'entry deleted')
        return reply.code(204).send(null)
      }
    )

    r.put(
      '/environment/:entryId/agents/:agentId',
      {
        schema: {
          tags: [Tag.Environment],
          summary: 'Assign an organization entry to one agent',
          description:
            'Idempotently binds the entry to one agent. Valid only while the entry targets selected agents. Requires `resource.edit` on the target, not merely `resource.view` — an agent the caller cannot manage returns 404, identical to a missing one. The binding is a durable delegation: organization environment managers may afterwards rotate the entry without gaining visibility into this agent.',
          operationId: 'assignOrganizationEnvironmentEntry',
          params: OrganizationEnvironmentAgentParam,
          response: { 200: OrganizationEnvironmentEntryDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = orgOf(req)
        const ctx = ctxOf(req)
        // 'requested': the id is caller-supplied and not yet authorized, so a target
        // this caller cannot edit is skipped here and answered 404 by the repository
        // rather than 409-with-a-name.
        const blocked = await incompatibleDaemonMessage(orgId, ctx, [req.params.agentId], 'requested')
        if (blocked) return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: blocked })
        const result = await repo.bind(orgId, req.params.entryId, AgentId(req.params.agentId), {
          actorUserId: ctx.userId,
          viewer: ctx
        })
        return settle(req, reply, result, 'agent assigned')
      }
    )

    r.delete(
      '/environment/:entryId/agents/:agentId',
      {
        schema: {
          tags: [Tag.Environment],
          summary: 'Unassign an organization entry from one agent',
          description:
            'Idempotently removes one binding. Valid only while the entry targets selected agents, and requires `resource.edit` on the target. The agent then receives a full snapshot without the key, so a retained same-key agent-local row becomes effective again without re-entering its value.',
          operationId: 'unassignOrganizationEnvironmentEntry',
          params: OrganizationEnvironmentAgentParam,
          response: { 200: OrganizationEnvironmentEntryDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const ctx = ctxOf(req)
        // Not daemon-gated, for the same reason delete is not: withdrawing a
        // credential must always be possible.
        const result = await repo.unbind(orgOf(req), req.params.entryId, AgentId(req.params.agentId), {
          actorUserId: ctx.userId,
          viewer: ctx
        })
        return settle(req, reply, result, 'agent unassigned')
      }
    )
  }
}
