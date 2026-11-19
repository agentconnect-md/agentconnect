/** `GET /orgs/:orgId/capabilities` — which optional settings areas this organization has, and whether each can be edited. */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { HttpDeps } from '../deps.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import { ErrorDto } from '../dto/index.js'

const OrgCapabilitiesDto = z.object({
  capabilities: z
    .record(z.string(), z.enum(['active', 'read_only']))
    .describe('Each settings area the deployment adds for this organization. An area that is not named is hidden.')
})

export function capabilityRoutes(deps: HttpDeps) {
  return async function capabilityRoutesPlugin(app: FastifyInstance): Promise<void> {
    app.withTypeProvider<ZodTypeProvider>().get(
      '/capabilities',
      {
        schema: {
          tags: [Tag.Organizations],
          summary: 'List the organization’s optional settings areas',
          description:
            'Any member. Names each optional settings area the deployment provides for this organization and whether it can be edited (`active`) or only read (`read_only`). A deployment that adds none answers an empty map.',
          operationId: 'getOrganizationCapabilities',
          response: { 200: OrgCapabilitiesDto, 404: ErrorDto }
        }
      },
      // Core names no capability of its own: the answer is whatever the extension says, and nothing without one.
      async (req) => ({ capabilities: (await deps.extension?.capabilities?.(req.orgCtx!.orgId)) ?? {} })
    )
  }
}
