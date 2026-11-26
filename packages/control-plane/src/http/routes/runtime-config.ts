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
    socialProviders: z.array(z.string().min(1)),
    // The SSO connector the console's sign-in button starts; null when the deployment offers none.
    sso: z
      .object({ connectorId: z.string().min(1), name: z.string().min(1) })
      .strict()
      .nullable(),
    // How the deployment's own SSO connector admits members to its organization; null when it has none.
    ssoMemberSource: z.enum(['invite', 'domain']).nullable(),
    // Organizations own SSO connections here, so the sign-in page asks for an address and looks its connector up.
    organizationSso: z.boolean()
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
      .optional(),
    // Artifacts (artifacts.md §12): on only with a transfer bucket and a content domain, whose wildcard serves revisions.
    artifacts: z.object({ enabled: z.boolean(), contentDomain: z.string().nullable() }).strict().optional()
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
  /** Set only when artifacts are offered: the content domain revisions render under. */
  artifactsContentDomain?: string
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
            'Returns the secret-free browser configuration loaded for this process: authentication, the GitLab instance the deployment talks to, whether console file transfer is available with its per-file cap and, when uploads may go in parts, the largest part, and whether artifacts are enabled with the content domain their revisions render under. A deployment change takes effect after restart.',
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
        fileTransfer: deps.fileTransfer?.() ?? null,
        artifacts: {
          enabled: deps.artifactsContentDomain !== undefined,
          contentDomain: deps.artifactsContentDomain ?? null
        }
      })
    )
  }
}
