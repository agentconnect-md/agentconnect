// An MCP provider's tool catalog: read the snapshot and ask a relay to fetch it now (mcp-tool-permissions.md §4, §5.5).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import type { McpProviderRecord, McpToolCatalogRecord } from '../../persistence/ports.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canView } from '../../authorization/policy.js'
import { MCP_TOOL_GROUPS, toolGroup } from '../../orchestrator/mcpToolPolicy.js'
import { ErrorDto, IdParam, McpToolCatalogDto } from '../dto/index.js'

function toDto(row: McpToolCatalogRecord | null): z.infer<typeof McpToolCatalogDto> {
  const tools = (row?.tools ?? []).map((tool) => ({ ...tool, group: toolGroup(tool) }))
  const groups = Object.fromEntries(MCP_TOOL_GROUPS.map((g) => [g, tools.filter((t) => t.group === g).length]))
  return {
    tools,
    fetchedAt: row?.fetchedAt?.toISOString() ?? null,
    failure: row?.failure ?? null,
    groups: groups as z.infer<typeof McpToolCatalogDto>['groups']
  }
}

export function mcpToolCatalogRoutes(deps: HttpDeps) {
  return async function mcpToolCatalogRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // A cross-org id and a provider the caller cannot see both read as 404; null means the refusal was sent.
    const visibleProvider = async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ): Promise<McpProviderRecord | null> => {
      const provider = await deps.repos.mcpProvider.get(orgOf(req), req.params.id)
      if (provider && canView(provider, ctxOf(req))) return provider
      await reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'mcp provider not found' })
      return null
    }

    r.get(
      '/mcp-providers/:id/tools',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Get an MCP provider tool catalog',
          description:
            'The provider’s last tool catalog snapshot, fetched by a relay with its own binding. Each tool carries its annotation hints and the group a tool policy sorts it into (`readOnly` for an explicit read-only hint, `write` for an explicit false one, `other` otherwise), with per-group counts. `fetchedAt` is null until a fetch succeeds; `failure` is the last fetch’s closed reason code, and a failure keeps the previous tools. Requires viewing the provider.',
          operationId: 'getMcpProviderToolCatalog',
          params: IdParam,
          response: { 200: McpToolCatalogDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const provider = await visibleProvider(req, reply)
        if (!provider) return
        return toDto(await deps.repos.mcpToolCatalog.get(orgOf(req), provider.id))
      }
    )

    r.post(
      '/mcp-providers/:id/tools/refresh',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Refresh an MCP provider tool catalog',
          description:
            'Ask a connected relay to list the provider’s tools now and return the resulting snapshot, waiting up to 15 seconds. A failed fetch keeps the previous tools and records `failure`: one of the relay’s codes, `relay_unavailable` when no capable relay is connected to this control plane, or `relay_timeout`. Requires viewing the provider, so an agent editor restricting its tools can refresh it; viewers are refused.',
          operationId: 'refreshMcpProviderToolCatalog',
          params: IdParam,
          response: { 200: McpToolCatalogDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const provider = await visibleProvider(req, reply)
        if (!provider) return
        if (!deps.mcpToolCatalog) {
          return reply
            .code(503)
            .send({ error: 'Service Unavailable', statusCode: 503, message: 'tool catalogs are not served here' })
        }
        return toDto(await deps.mcpToolCatalog.refresh(orgOf(req), provider.id))
      }
    )
  }
}
