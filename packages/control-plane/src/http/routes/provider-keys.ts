import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ProviderKeyProvider, ProviderKeyStatus, SetProviderKeyBody } from '@agentconnect.md/protocol'
import type { ProviderKeyMetadata } from '../../persistence/ports.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { denyNonOwner, orgOf } from '../rbac.js'

const ProviderParam = z.object({ provider: ProviderKeyProvider })
const names: Record<ProviderKeyProvider, string> = { typesafe: 'TypeSafe (Jev)' }

function status(provider: ProviderKeyProvider, row?: ProviderKeyMetadata): ProviderKeyStatus {
  return { provider, name: names[provider], configured: !!row, updatedAt: row?.updatedAt.toISOString() ?? null }
}

export function providerKeyRoutes(deps: HttpDeps) {
  return async function providerKeyRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const store = deps.repos.providerKey

    r.get(
      '/provider-keys',
      {
        schema: {
          tags: [Tag.ProviderKeys],
          summary: 'List provider key status',
          description:
            'Lists supported providers and organization key configuration status. Never returns key material or validates credentials upstream.',
          operationId: 'listProviderKeys',
          response: { 200: z.array(ProviderKeyStatus) }
        }
      },
      async (req) => {
        const rows = await store.list(orgOf(req))
        return ProviderKeyProvider.options.map((provider) =>
          status(
            provider,
            rows.find((row) => row.provider === provider)
          )
        )
      }
    )

    r.put(
      '/provider-keys/:provider',
      {
        schema: {
          tags: [Tag.ProviderKeys],
          summary: 'Set an organization provider key',
          description:
            'Owner-only. Creates or replaces the organization default key using the configured secret cipher. The key is write-only and is not injected into agent environments.',
          operationId: 'setProviderKey',
          params: ProviderParam,
          body: SetProviderKeyBody,
          response: { 200: ProviderKeyStatus, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        try {
          return status(req.params.provider, await store.put(orgOf(req), req.params.provider, req.body.apiKey))
        } catch {
          // Cipher and database errors may embed the submitted value; never serialize or log them.
          return reply.code(503).send({
            error: 'Service Unavailable',
            statusCode: 503,
            message: 'Provider key could not be saved. Try again.'
          })
        }
      }
    )

    r.delete(
      '/provider-keys/:provider',
      {
        schema: {
          tags: [Tag.ProviderKeys],
          summary: 'Remove an organization provider key',
          description:
            'Owner-only. Removes the stored key idempotently. This does not revoke the credential at its provider.',
          operationId: 'deleteProviderKey',
          params: ProviderParam,
          response: { 204: z.null(), 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        await store.delete(orgOf(req), req.params.provider)
        return reply.code(204).send(null)
      }
    )
  }
}
