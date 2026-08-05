/**
 * Process bootstrap configuration for the Tenant Admin server.
 *
 * Product/provider settings intentionally do not live here: they are loaded
 * from the deployment config singleton after initialization, or held only in
 * the in-process bootstrap draft before the first save. The database address
 * and the secret cipher's root of trust must remain available before that row
 * can be read, so they stay in the process environment.
 */
import { z } from 'zod'

const HttpOriginSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'must use HTTP or HTTPS' })
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      ctx.addIssue({ code: 'custom', message: 'must be an origin without credentials, path, query, or fragment' })
    }
  })

const SecureOriginSchema = HttpOriginSchema.superRefine((value, ctx) => {
  const url = new URL(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback =
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1'
  if (url.protocol !== 'https:' && !loopback) {
    ctx.addIssue({ code: 'custom', message: 'must use HTTPS unless it is loopback' })
  }
})

export const TenantAdminProcessConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8091),
    TENANT_ADMIN_URL: SecureOriginSchema.default('http://localhost:8091'),
    TENANT_ADMIN_ALLOW_CONTAINER_PROXY: z.stringbool().default(false),
    LOGTO_ADMIN_ENDPOINT: SecureOriginSchema.default('http://admin.agentconnect.localhost:3002'),
    DATABASE_URL: z
      .string()
      .url()
      .default('postgresql://agentconnect:agentconnect-local-only@127.0.0.1:5432/agentconnect?schema=public'),

    // Keep this startup-only slice aligned with the CP's SecretCipher. The
    // cipher key/address cannot be stored beside the ciphertext it unlocks.
    SECRET_CIPHER: z.enum(['none', 'vault-transit']).default('none'),
    VAULT_ADDR: HttpOriginSchema.optional(),
    VAULT_TRANSIT_KEY: z.string().default('agentconnect-cp'),
    VAULT_TRANSIT_MOUNT: z.string().default('transit'),
    VAULT_NAMESPACE: z.string().optional(),
    VAULT_TOKEN: z.string().optional(),
    VAULT_JWT_ROLE: z.string().optional(),
    VAULT_JWT_PATH: z.string().default('/var/run/secrets/kubernetes.io/serviceaccount/token'),
    VAULT_AUTH_MOUNT: z.string().default('kubernetes')
  })
  .superRefine((config, ctx) => {
    if (config.SECRET_CIPHER !== 'vault-transit') return
    if (!config.VAULT_ADDR) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAULT_ADDR'],
        message: 'SECRET_CIPHER=vault-transit requires VAULT_ADDR'
      })
    }
    const authCount = [config.VAULT_TOKEN, config.VAULT_JWT_ROLE].filter((value) => value !== undefined).length
    if (authCount !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAULT_TOKEN'],
        message: 'SECRET_CIPHER=vault-transit requires exactly one of VAULT_TOKEN or VAULT_JWT_ROLE'
      })
    }
  })

export type TenantAdminProcessConfig = z.infer<typeof TenantAdminProcessConfigSchema>

export function loadTenantAdminProcessConfig(env: NodeJS.ProcessEnv = process.env): TenantAdminProcessConfig {
  return TenantAdminProcessConfigSchema.parse(env)
}
