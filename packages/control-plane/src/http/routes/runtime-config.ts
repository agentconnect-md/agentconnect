import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'

const PublicBrowserAuth = z
  .object({
    endpoint: z.string().url(),
    issuer: z.string().url(),
    appId: z.string().min(1),
    apiResource: z.string().url().nullable(),
    socialProviders: z.array(z.string().min(1))
  })
  .strict()

export const RuntimeConfigDto = z
  .object({
    schemaVersion: z.literal('1'),
    revision: z.number().int().positive().nullable(),
    config: z
      .object({
        auth: PublicBrowserAuth.nullable()
      })
      .strict()
      .nullable()
  })
  .strict()

export type RuntimeConfigDto = z.infer<typeof RuntimeConfigDto>

export interface RuntimeConfigRouteDeps {
  /** Immutable DB-owned browser auth state loaded at process startup. */
  publicRuntimeConfig?: RuntimeConfigDto['config']
  deploymentRevision?: number
}

/** Public, secret-free auth config consumed by the prebuilt Web image at startup. */
export function runtimeConfigRoutes(deps: RuntimeConfigRouteDeps) {
  return async function runtimeConfigRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    r.get(
      '/runtime-config',
      {
        schema: {
          tags: [Tag.Deployment],
          summary: 'Get public runtime configuration',
          description:
            'Returns the secret-free browser authentication configuration loaded for this process. A deployment change takes effect after restart.',
          operationId: 'getRuntimeConfig',
          response: { 200: RuntimeConfigDto }
        }
      },
      async () => ({
        schemaVersion: '1' as const,
        revision: deps.deploymentRevision ?? null,
        config: deps.publicRuntimeConfig ?? null
      })
    )
  }
}
