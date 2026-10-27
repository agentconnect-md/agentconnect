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

// The deployment's GitLab instance (§24.1 axis) — public topology the console
// needs for tile/source derivation; gitlab.com when the deployment carries none.
const PublicGitlabInstance = z.object({ instanceUrl: z.string().url() }).strict()

export const RuntimeConfigDto = z
  .object({
    schemaVersion: z.literal('1'),
    webchatProtocol: z.enum(['legacy', 'ahp']),
    ahp: z.object({ enabled: z.boolean(), publicAccess: z.boolean() }).strict().optional(),
    revision: z.number().int().positive().nullable(),
    config: z
      .object({
        auth: PublicBrowserAuth.nullable(),
        gitlab: PublicGitlabInstance.nullable()
      })
      .strict()
      .nullable(),
    // Console file transfer through the deployment's bucket; null when this process signs none. `partBytes` only while uploads may go in parts.
    fileTransfer: z
      .object({ maxBytes: z.number().int().positive(), partBytes: z.number().int().positive().optional() })
      .strict()
      .nullable()
      .optional()
  })
  .strict()

export type RuntimeConfigDto = z.infer<typeof RuntimeConfigDto>

export interface RuntimeConfigRouteDeps {
  webchatProtocol?: 'legacy' | 'ahp'
  ahp?: { enabled: boolean; publicAccess: boolean }
  /** Immutable DB-owned browser auth state loaded at process startup. */
  publicRuntimeConfig?: RuntimeConfigDto['config']
  deploymentRevision?: number
  /** Set when this process signs console file transfers; read per request, since the bucket's lifecycle can change. */
  fileTransfer?: () => { maxBytes: number; partBytes?: number }
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
            'Returns the secret-free browser configuration loaded for this process: authentication, the GitLab instance the deployment talks to, and whether console file transfer is available with its per-file cap and, when uploads may go in parts, the largest part. A deployment change takes effect after restart.',
          operationId: 'getRuntimeConfig',
          response: { 200: RuntimeConfigDto }
        }
      },
      async () => ({
        schemaVersion: '1' as const,
        webchatProtocol: deps.webchatProtocol ?? 'legacy',
        ahp: { enabled: deps.ahp?.enabled ?? false, publicAccess: deps.ahp?.publicAccess ?? false },
        revision: deps.deploymentRevision ?? null,
        config: deps.publicRuntimeConfig ?? null,
        fileTransfer: deps.fileTransfer?.() ?? null
      })
    )
  }
}
