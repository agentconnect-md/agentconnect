// Per-agent MCP tool policies: read with drift, save with save-time expansion, and return to Full access (mcp-tool-permissions.md §5).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { MCP_AGENT_DEFS_V1_FEATURE, MCP_TOOL_LIST_MAX, MCP_TOOL_POLICY_V1_FEATURE } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import type { AgentMcpToolPolicyRecord, AgentRecord, McpProviderRecord } from '../../persistence/ports.js'
import { AgentId, type OrgId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { grantKeyHash } from '../../orchestrator/mcpProvider.js'
import { expandToolPolicy, toolPolicyDrift, type ToolPolicyDrift } from '../../orchestrator/mcpToolPolicy.js'
import { resolveUpstreamHeaders } from '../../orchestrator/mcpUpstreamHeaders.js'
import { serializeByProvider } from '../provider-chain.js'
import { makeMcpPush } from '../mcp-push.js'
import { makeMcpDefSync } from '../mcp-defs.js'
import { AgentMcpToolPoliciesDto, AgentMcpToolPolicyDto, ErrorDto, SaveAgentMcpToolPolicyBody } from '../dto/index.js'

const AgentParams = z.object({ agentId: z.string() })
const PolicyParams = z.object({ agentId: z.string(), providerId: z.string().uuid() })

function toDto(policy: AgentMcpToolPolicyRecord, drift: ToolPolicyDrift | null): z.infer<typeof AgentMcpToolPolicyDto> {
  return {
    providerId: policy.mcpProviderId,
    providerName: policy.providerName,
    groups: policy.groups,
    overrides: policy.overrides,
    allowTools: policy.allowTools,
    approvalTools: policy.approvalTools,
    askTools: policy.askTools,
    catalogFetchedAt: policy.catalogFetchedAt?.toISOString() ?? null,
    updatedBy: policy.updatedByUserId,
    updatedAt: policy.updatedAt.toISOString(),
    drift
  }
}

const notFound = (reply: FastifyReply, what: string) =>
  reply.code(404).send({ error: 'Not Found', statusCode: 404, message: `${what} not found` })

export function agentMcpToolPolicyRoutes(deps: HttpDeps) {
  return async function agentMcpToolPolicyRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const push = makeMcpPush(deps)
    const defs = makeMcpDefSync(deps, app.log)

    const driftOf = async (orgId: OrgId, policy: AgentMcpToolPolicyRecord): Promise<ToolPolicyDrift | null> => {
      const catalog = await deps.repos.mcpToolCatalog.get(orgId, policy.mcpProviderId)
      return catalog ? toolPolicyDrift(policy, catalog.tools) : null
    }

    // The agent and provider a write names, with the checks enabling the provider takes; null means a refusal was sent.
    const writeTargets = async (
      req: FastifyRequest,
      reply: FastifyReply,
      params: { agentId: string; providerId: string }
    ): Promise<{ agent: AgentRecord; provider: McpProviderRecord } | null> => {
      const agent = await deps.repos.agent.get(orgOf(req), AgentId(params.agentId))
      if (!agent || !canView(agent, ctxOf(req))) {
        await notFound(reply, 'agent')
        return null
      }
      if (!canEdit(agent, ctxOf(req))) {
        await reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        return null
      }
      const provider = await deps.repos.mcpProvider.get(orgOf(req), params.providerId)
      if (!provider || !canView(provider, ctxOf(req))) {
        await notFound(reply, 'mcp provider')
        return null
      }
      return { agent, provider }
    }

    // A first save or a removal changes the spec an older daemon receives; the row is committed, so a failed push waits for the reconnect.
    const pushSpec = (agent: AgentRecord) =>
      deps.agentDelivery.upsert(agent, (err, daemonId) =>
        app.log.warn({ err, agentId: agent.id, daemonId }, 'agent spec push after an MCP tool policy change failed')
      )

    r.get(
      '/agents/:agentId/mcp-tool-policies',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List an agent’s MCP tool policies',
          description:
            'Every per-tool policy this agent holds, one per restricted MCP provider; a provider without one has Full access. Each carries its group decisions, overrides, the decision table expanded when it was saved, and `drift` against the current catalog snapshot (null without one): tools a re-save would no longer block, tools whose decision would change, and names the upstream no longer lists. Drift never changes the table. `compatibility` names the daemons serving the agent that cannot attach a restricted provider and counts the connected relays that refuse restricted calls. Gated by the agent’s visibility.',
          operationId: 'listAgentMcpToolPolicies',
          params: AgentParams,
          response: { 200: AgentMcpToolPoliciesDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent || !canView(agent, ctxOf(req))) return notFound(reply, 'agent')
        const policies = await deps.repos.agentMcpToolPolicy.listForAgent(orgOf(req), agent.id)
        const daemons = await deps.agentDelivery.daemonsFor(agent)
        return {
          policies: await Promise.all(policies.map(async (p) => toDto(p, await driftOf(orgOf(req), p)))),
          compatibility: {
            daemonsWithoutAgentDefinitions: daemons.filter(
              (d) => deps.control.daemonFeatures(d)?.includes(MCP_AGENT_DEFS_V1_FEATURE) !== true
            ),
            relaysWithoutToolPolicies: deps.relayControl.relaysLacking(MCP_TOOL_POLICY_V1_FEATURE)
          }
        }
      }
    )

    // Interactive only: an agent holding the admin MCP server or an API key could otherwise loosen its own tools.
    r.put(
      '/agents/:agentId/mcp-tool-policies/:providerId',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Agents],
          summary: 'Set an agent’s MCP tool policy',
          description:
            'Restrict one MCP provider for this agent: a decision (`allow`, `approval`, `ask`, `block`) for each tool group (`readOnly`, `write`, `other`) plus per-tool `overrides`. The decision table is expanded now from the provider’s catalog snapshot and the overrides, and is never re-expanded by a later catalog refresh; without a snapshot it is the overrides alone. Tools in no list are blocked. Until approvals ship, `approval` and `ask` tools are refused too. The first save gives the agent its own grant for the provider. Requires editing the agent and viewing the provider.',
          operationId: 'setAgentMcpToolPolicy',
          params: PolicyParams,
          body: SaveAgentMcpToolPolicyBody,
          response: { 200: AgentMcpToolPolicyDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const targets = await writeTargets(req, reply, req.params)
        if (!targets) return
        const { provider } = targets
        const orgId = orgOf(req)
        const release = deps.agentMutations.tryBeginMutation(targets.agent.id)
        if (!release) {
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'agent move is in progress; retry the policy save' })
        }
        let saved: { policy: AgentMcpToolPolicyRecord; created: boolean; agent: AgentRecord } | 'gone' | 'too_large'
        try {
          // Joins the provider's chain, so a rotation or another policy write never interleaves with this binding push.
          saved = await serializeByProvider(orgId, provider.name, async () => {
            const agent = await deps.repos.agent.get(orgId, AgentId(targets.agent.id))
            if (!agent) return 'gone' as const
            const catalog = await deps.repos.mcpToolCatalog.get(orgId, provider.id)
            const table = expandToolPolicy(req.body.groups, req.body.overrides, catalog?.tools ?? [])
            if (Object.values(table).some((names) => names.length > MCP_TOOL_LIST_MAX)) return 'too_large' as const
            const grants = await deps.repos.mcpGrant.activeForAgent(orgId, provider.id, agent.id)
            if (!grants.some((g) => g.custody === 'runtime'))
              await deps.repos.mcpGrant.mintForAgent(orgId, provider.id, agent.id, 'runtime')
            const { policy, created } = await deps.repos.agentMcpToolPolicy.save(orgId, {
              agentId: agent.id,
              mcpProviderId: provider.id,
              groups: req.body.groups,
              overrides: req.body.overrides,
              ...table,
              catalogFetchedAt: catalog?.fetchedAt ?? null,
              updatedByUserId: req.principal?.userId ?? null
            })
            await pushBinding(orgId, provider)
            if (agent.mcpServers.includes(provider.name)) await convergeOnAgent(orgId, provider, agent)
            return { policy, created, agent }
          })
        } finally {
          release()
        }
        if (saved === 'gone') return notFound(reply, 'agent')
        if (saved === 'too_large') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: `a decision list would exceed ${MCP_TOOL_LIST_MAX} tools`
          })
        }
        if (saved.created) await pushCurrentSpec(orgId, saved.agent)
        return toDto(saved.policy, await driftOf(orgId, saved.policy))
      }
    )

    r.delete(
      '/agents/:agentId/mcp-tool-policies/:providerId',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Agents],
          summary: 'Remove an agent’s MCP tool policy',
          description:
            'Return one MCP provider to Full access for this agent: the daemons serving it fall back to the organization’s shared definition, and the agent’s own grant for the provider is revoked on every relay. Requires editing the agent and viewing the provider.',
          operationId: 'deleteAgentMcpToolPolicy',
          params: PolicyParams,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const targets = await writeTargets(req, reply, req.params)
        if (!targets) return
        const { provider } = targets
        const orgId = orgOf(req)
        const release = deps.agentMutations.tryBeginMutation(targets.agent.id)
        if (!release) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'agent move is in progress; retry the policy removal'
          })
        }
        let removed: AgentRecord | null
        try {
          removed = await serializeByProvider(orgId, provider.name, async () => {
            const agent = await deps.repos.agent.get(orgId, AgentId(targets.agent.id))
            if (!agent || !(await deps.repos.agentMcpToolPolicy.delete(orgId, agent.id, provider.id))) return null
            // The shared definition lands and the agent's own leaves before its key is revoked.
            if (agent.mcpServers.includes(provider.name)) await convergeOnAgent(orgId, provider, agent)
            for (const grant of await deps.repos.mcpGrant.activeForAgent(orgId, provider.id, agent.id)) {
              await deps.repos.mcpGrant.revoke(grant.id)
              deps.relayControl.mcpUnassign({ providerId: provider.id, grantKeyHash: grantKeyHash(grant.key) })
            }
            return agent
          })
        } finally {
          release()
        }
        if (!removed) return notFound(reply, 'mcp tool policy')
        await pushCurrentSpec(orgId, removed)
        return reply.code(204).send(null)
      }
    )

    /** Push the agent as stored now: the policy write bumped its revision, and a daemon refuses a changed spec under the revision it already applied. */
    async function pushCurrentSpec(orgId: OrgId, agent: AgentRecord): Promise<void> {
      const current = await deps.repos.agent.get(orgId, AgentId(agent.id))
      if (current) await pushSpec(current)
    }

    /** Re-push the provider's relay binding with every active shared key and its current restricted grants. */
    async function pushBinding(orgId: OrgId, provider: McpProviderRecord): Promise<void> {
      const keys = (await deps.repos.mcpGrant.activeForProvider(orgId, provider.id)).map((g) => g.key)
      const headers = await resolveUpstreamHeaders(
        { secrets: deps.repos.mcpProviderSecret, ...(deps.mcpTokenResolver ? { tokens: deps.mcpTokenResolver } : {}) },
        provider,
        orgId,
        { allowNetwork: false }
      )
      if (headers !== null) await push.pushBinding(provider, headers, keys)
    }

    /** Converge the provider on the daemons serving this agent, retiring its own definition where it no longer needs one. */
    async function convergeOnAgent(orgId: OrgId, provider: McpProviderRecord, agent: AgentRecord): Promise<void> {
      const daemonIds = await deps.agentDelivery.daemonsFor(agent)
      if (daemonIds.length > 0) await defs.converge(orgId, provider, { daemonIds, retireAgentIds: [agent.id] })
    }
  }
}
