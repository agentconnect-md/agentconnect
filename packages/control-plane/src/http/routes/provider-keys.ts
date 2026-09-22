import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  PROVIDER_KEY_PROFILES,
  ProviderKeyProvider,
  ProviderKeyStatus,
  SetProviderKeyBody
} from '@agentconnect.md/protocol'
import type { ProviderKeyMetadata } from '../../persistence/ports.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { denyNonOwner, orgOf } from '../rbac.js'

const ProviderParam = z.object({ provider: ProviderKeyProvider })
function status(provider: ProviderKeyProvider, row?: ProviderKeyMetadata): ProviderKeyStatus {
  return {
    provider,
    ...PROVIDER_KEY_PROFILES[provider],
    endpoint: row?.endpoint ?? null,
    headerNames: row?.headerNames ?? [],
    configured: !!row,
    updatedAt: row?.updatedAt.toISOString() ?? null
  }
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
            'Lists provider profiles, configured endpoints, header names, and organization key status. Never returns secret values or validates credentials upstream.',
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
            'Owner-only. Saves an API key, endpoint, and a header patch atomically. The first save requires a key; omitted secrets are retained and null header values remove headers. Cloudflare requires an endpoint on each save. Key and header values are write-only and use the configured secret cipher.',
          operationId: 'setProviderKey',
          params: ProviderParam,
          body: SetProviderKeyBody,
          response: { 200: ProviderKeyStatus, 400: ErrorDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (PROVIDER_KEY_PROFILES[req.params.provider].endpointRequired && !req.body.endpoint) {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'An endpoint is required for this provider.' })
        }
        try {
          const saved = await store.put(orgOf(req), req.params.provider, req.body)
          if (!saved)
            return reply
              .code(400)
              .send({ error: 'Bad Request', statusCode: 400, message: 'An API key is required for the first save.' })
          return status(req.params.provider, saved)
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
