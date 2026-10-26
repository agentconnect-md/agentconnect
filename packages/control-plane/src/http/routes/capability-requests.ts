// Capability requests in the console (capability-requests.md §4.5): the request page, the lists, and the actions a person takes on one; every change it asks for is saved through that change's own route.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { CAPABILITY_NOTE_MAX, type CapabilityDecider } from '@agentconnect.md/protocol'
import { assistantResponsibleUser } from '../../agents/assistant-mode.js'
import { canEdit, canView, type ViewCtx } from '../../authorization/policy.js'
import { askOf, type CapabilityActionRefusal } from '../../capability/capability-request.service.js'
import { capabilityWarnings, evaluateCapability } from '../../capability/capability-wording.js'
import { AgentId, type OrgId } from '../../domain/ids.js'
import type { AgentRecord, CapabilityRequestRecord, OrgMemberRecord } from '../../persistence/ports.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, orgOf } from '../rbac.js'

const RequestParam = z.object({ id: z.string().uuid() })
const ListQuery = z.object({
  agentId: z.string().uuid().optional(),
  status: z.enum(['open', 'completed', 'declined', 'expired', 'withdrawn']).optional()
})
const DeclineBody = z.object({ note: z.string().max(CAPABILITY_NOTE_MAX).optional() }).strict()
const ForwardBody = z.object({ userId: z.string().min(1).max(200).optional() }).strict()

const SettledByDto = z.union([
  z.object({ kind: z.literal('console'), userId: z.string(), name: z.string() }),
  z.object({ kind: z.literal('member'), platform: z.string(), name: z.string() })
])

export const CapabilityRequestDto = z.object({
  id: z.string(),
  orgId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  kind: z.enum(['agent-settings', 'mcp-server', 'skill']),
  target: z.string(),
  want: z.record(z.string(), z.unknown()),
  summary: z.string(),
  reason: z.string(),
  status: z.enum(['open', 'completed', 'declined', 'expired', 'withdrawn']),
  generation: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string(),
  settledAt: z.string().nullable(),
  settledBy: SettledByDto.nullable(),
  outcome: z.string().nullable(),
  differs: z.boolean(),
  note: z.string().nullable(),
  origins: z.array(
    z.object({
      sessionId: z.string(),
      platform: z.string(),
      placeLabel: z.string().nullable(),
      external: z.boolean(),
      askers: z.array(
        z.object({
          kind: z.enum(['console', 'member']),
          userId: z.string(),
          name: z.string().nullable(),
          platform: z.string().nullable()
        })
      ),
      nobody: z.boolean(),
      askedAt: z.string(),
      wake: z.enum(['none', 'pending', 'delivered', 'gone']),
      wakeReason: z.string().nullable()
    })
  ),
  current: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
  viewer: z.object({
    canComplete: z.boolean(),
    canDecline: z.boolean(),
    canReopen: z.boolean(),
    canForward: z.boolean(),
    missing: z.string().nullable(),
    whoCan: z.array(z.object({ userId: z.string(), name: z.string() }))
  })
})
export type CapabilityRequestDtoT = z.infer<typeof CapabilityRequestDto>

const memberName = (m: Pick<OrgMemberRecord, 'displayName' | 'email'>): string =>
  m.displayName?.trim() || m.email || 'A member'

/** A chat decider shows only their platform and name; their platform id stays out of the page. */
function settledByDto(by: CapabilityDecider | null): CapabilityRequestDtoT['settledBy'] {
  if (!by) return null
  if (by.kind === 'console') return { kind: 'console', userId: by.userId, name: by.name ?? 'A member' }
  return { kind: 'member', platform: by.platform, name: by.name ?? 'Someone in the conversation' }
}

export function capabilityRequestRoutes(deps: HttpDeps) {
  return async function capabilityRequestRoutesPlugin(app: FastifyInstance): Promise<void> {
    const service = deps.capabilityRequests
    if (!service) return
    const r = app.withTypeProvider<ZodTypeProvider>()

    type Failure = { status: 400 | 403 | 404 | 409; error: string; message: string }
    const send = (reply: FastifyReply, f: Failure) =>
      reply.code(f.status).send({ error: f.error, statusCode: f.status, message: f.message })
    const NOT_FOUND: Failure = { status: 404, error: 'Not Found', message: 'request not found' }
    const NOT_EDITOR: Failure = {
      status: 403,
      error: 'Forbidden',
      message: 'only an editor of this agent can act on its requests'
    }
    const refused = (refusal: CapabilityActionRefusal): Failure =>
      refusal === 'not_found'
        ? NOT_FOUND
        : {
            status: 409,
            error: 'Conflict',
            message:
              refusal === 'not_declined'
                ? 'only a declined request can be reopened'
                : refusal === 'conflict'
                  ? 'another open request asks for the same thing'
                  : 'this request is no longer open'
          }

    const viewerName = async (userId: string): Promise<string> => {
      const profile = await deps.repos.user.getProfile(userId).catch(() => null)
      return profile?.displayName?.trim() || profile?.email || 'A member'
    }

    const toDto = async (
      row: CapabilityRequestRecord,
      agent: AgentRecord,
      ctx: ViewCtx,
      members: readonly OrgMemberRecord[]
    ): Promise<CapabilityRequestDtoT> => {
      const ask = askOf(row)
      let current: Record<string, unknown> = {}
      if (ask) {
        current = evaluateCapability(ask, agent).current
        if (ask.kind === 'mcp-server') {
          const provider = (await deps.repos.mcpProvider.listForOrg(agent.orgId)).find(
            (p) => p.name === ask.want.server
          )
          current = { ...current, exists: provider !== undefined, providerId: provider?.id ?? null }
        }
      }
      const editor = canEdit(agent, ctx)
      const open = row.status === 'open'
      return {
        id: row.id,
        orgId: row.orgId,
        agentId: row.agentId,
        agentName: agent.displayName?.trim() || agent.name,
        kind: row.kind,
        target: row.target,
        want: row.want,
        summary: row.summary,
        reason: row.reason,
        status: row.status,
        generation: row.generation,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        settledAt: row.settledAt?.toISOString() ?? null,
        settledBy: settledByDto(row.settledBy),
        outcome: row.outcome,
        differs: row.differs,
        note: row.note,
        origins: row.origins.map((origin) => ({
          sessionId: origin.sessionId,
          platform: origin.platform,
          placeLabel: origin.placeLabel,
          external: origin.external,
          askers: origin.askers.people.map((asker) => ({
            kind: asker.kind,
            userId: asker.userId,
            name: asker.name ?? null,
            platform: asker.kind === 'member' ? asker.platform : null
          })),
          nobody: origin.askers.nobody,
          askedAt: origin.askedAt.toISOString(),
          // A wake of an earlier generation is not this one's.
          wake: origin.wakeGeneration === row.generation ? origin.wakeState : 'none',
          wakeReason: origin.wakeGeneration === row.generation ? origin.wakeReason : null
        })),
        current,
        warnings: ask ? capabilityWarnings(ask, agent) : [],
        viewer: {
          canComplete: editor && open,
          canDecline: editor && open,
          canReopen: editor && row.status === 'declined',
          canForward: open,
          missing: editor ? null : 'Only an editor of this agent can complete or decline this request.',
          whoCan: members.filter((m) => canEdit(agent, m)).map((m) => ({ userId: m.userId, name: memberName(m) }))
        }
      }
    }

    /** The request and its agent, when the caller may see that agent; otherwise the reply is a 404. */
    const admit = async (
      req: FastifyRequest,
      reply: FastifyReply,
      id: string
    ): Promise<{ row: CapabilityRequestRecord; agent: AgentRecord } | null> => {
      const orgId = orgOf(req)
      const row = await service.get(orgId, id)
      const agent = row ? await deps.repos.agent.get(orgId, row.agentId) : null
      if (!row || !agent || !canView(agent, ctxOf(req))) {
        await send(reply, NOT_FOUND)
        return null
      }
      return { row, agent }
    }

    const dtoOf = async (orgId: OrgId, req: FastifyRequest, row: CapabilityRequestRecord, agent: AgentRecord) =>
      toDto(row, agent, ctxOf(req), await deps.repos.user.listMembers(orgId))

    /** Reload the agent after an action, so the page shows what holds now. */
    const fresh = async (req: FastifyRequest, row: CapabilityRequestRecord) => {
      const agent = await deps.repos.agent.get(orgOf(req), row.agentId)
      return agent ? dtoOf(orgOf(req), req, row, agent) : null
    }

    r.get(
      '/capability-requests',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List capability requests',
          description:
            'Lists the requests agents made for something they lack — a setting, an MCP server or a skill — newest first, at most 200, for the agents the caller can see. Filter by `agentId` and `status`. Each carries what was asked, the agent’s reason as untrusted plain text, the conversations waiting for it and what the caller may do with it.',
          operationId: 'listCapabilityRequests',
          querystring: ListQuery,
          response: { 200: z.object({ requests: z.array(CapabilityRequestDto) }) }
        }
      },
      async (req) => {
        const orgId = orgOf(req)
        const ctx = ctxOf(req)
        const rows = await service.list(orgId, {
          ...(req.query.agentId ? { agentIds: [AgentId(req.query.agentId)] } : {}),
          ...(req.query.status ? { status: req.query.status } : {})
        })
        const agents = new Map<string, AgentRecord | null>()
        const members = rows.length > 0 ? await deps.repos.user.listMembers(orgId) : []
        const requests: CapabilityRequestDtoT[] = []
        for (const row of rows) {
          if (!agents.has(row.agentId)) agents.set(row.agentId, await deps.repos.agent.get(orgId, row.agentId))
          const agent = agents.get(row.agentId)
          if (!agent || !canView(agent, ctx)) continue
          requests.push(await toDto(row, agent, ctx, members))
        }
        return { requests }
      }
    )

    r.get(
      '/capability-requests/:id',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Get a capability request',
          description:
            'One request an agent made, with the current values of what it asks to change, warnings for changes that raise what the agent can do on its own, the conversations waiting for it and whether the caller can complete, decline, reopen or forward it. Answers 404 unless the caller can see the agent.',
          operationId: 'getCapabilityRequest',
          params: RequestParam,
          response: { 200: CapabilityRequestDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, req.params.id)
        if (!admitted) return reply
        return dtoOf(orgOf(req), req, admitted.row, admitted.agent)
      }
    )

    r.post(
      '/capability-requests/:id/settle',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Complete a capability request',
          description:
            'Completes an open request after its change was saved through the change’s own route. The outcome is computed from the agent as it is now, so a save that differs from what was asked still completes the request and the agent is told what it got. The conversations that asked are told once the agent’s daemon has applied the change. Only an editor of the agent may complete a request; one no longer open answers 409.',
          operationId: 'settleCapabilityRequest',
          params: RequestParam,
          response: { 200: CapabilityRequestDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, req.params.id)
        if (!admitted) return reply
        const ctx = ctxOf(req)
        if (!canEdit(admitted.agent, ctx)) return send(reply, NOT_EDITOR)
        const result = await service.settleFromConsole(orgOf(req), req.params.id, {
          kind: 'console',
          userId: ctx.userId,
          name: await viewerName(ctx.userId)
        })
        if (typeof result === 'string') return send(reply, refused(result))
        return (await fresh(req, result)) ?? send(reply, NOT_FOUND)
      }
    )

    r.post(
      '/capability-requests/:id/decline',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Decline a capability request',
          description:
            'Declines an open request, with an optional note the agent is shown quoted as the decider’s words. The conversations that asked are told, and the agent does not ask again for the same thing for 24 hours. Only an editor of the agent may decline from the console; one no longer open answers 409.',
          operationId: 'declineCapabilityRequest',
          params: RequestParam,
          body: DeclineBody,
          response: { 200: CapabilityRequestDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, req.params.id)
        if (!admitted) return reply
        const ctx = ctxOf(req)
        if (!canEdit(admitted.agent, ctx)) return send(reply, NOT_EDITOR)
        const result = await service.declineFromConsole(
          orgOf(req),
          req.params.id,
          { kind: 'console', userId: ctx.userId, name: await viewerName(ctx.userId) },
          req.body.note
        )
        if (typeof result === 'string') return send(reply, refused(result))
        return (await fresh(req, result)) ?? send(reply, NOT_FOUND)
      }
    )

    r.post(
      '/capability-requests/:id/reopen',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Reopen a declined capability request',
          description:
            'Reopens a declined request under the same link with a new generation: its cards in chat return to their open form, and a Decline from an earlier card no longer counts. Only an editor of the agent may reopen a request; one that is not declined, or whose target another open request already asks for, answers 409.',
          operationId: 'reopenCapabilityRequest',
          params: RequestParam,
          response: { 200: CapabilityRequestDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, req.params.id)
        if (!admitted) return reply
        if (!canEdit(admitted.agent, ctxOf(req))) return send(reply, NOT_EDITOR)
        const result = await service.reopen(orgOf(req), req.params.id)
        if (typeof result === 'string') return send(reply, refused(result))
        return (await fresh(req, result)) ?? send(reply, NOT_FOUND)
      }
    )

    r.post(
      '/capability-requests/:id/forward',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Forward a capability request',
          description:
            'Sends an open request to someone who can complete it: the named editor, else the agent’s responsible user, else its first editor. It reaches them as a direct message where the agent can send one to their linked chat account (`forwarded: dm`); otherwise it stays listed for them (`forwarded: activity`). Any member who can see the agent may forward; a `userId` who cannot edit the agent answers 400, and a request no longer open answers 409.',
          operationId: 'forwardCapabilityRequest',
          params: RequestParam,
          body: ForwardBody,
          response: {
            200: z.object({ forwarded: z.enum(['dm', 'activity']) }),
            400: ErrorDto,
            404: ErrorDto,
            409: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const admitted = await admit(req, reply, req.params.id)
        if (!admitted) return reply
        if (admitted.row.status !== 'open') return send(reply, refused('not_open'))
        const members = await deps.repos.user.listMembers(orgOf(req))
        const editors = members.filter((m) => canEdit(admitted.agent, m))
        let target: OrgMemberRecord | undefined
        if (req.body.userId) {
          target = editors.find((m) => m.userId === req.body.userId)
          if (!target)
            return send(reply, { status: 400, error: 'Bad Request', message: 'that member cannot edit this agent' })
        } else {
          target = assistantResponsibleUser(admitted.agent, members) ?? editors[0]
        }
        if (!target) return { forwarded: 'activity' as const }
        const forwarded = await service.forward(admitted.row, target.userId, await viewerName(ctxOf(req).userId))
        return { forwarded }
      }
    )
  }
}
