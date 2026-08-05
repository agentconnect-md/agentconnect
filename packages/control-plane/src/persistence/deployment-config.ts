/**
 * Deployment-wide desired state.
 *
 * This is deliberately a typed product document, not an arbitrary env map.
 * Database/bootstrap/Vault/process settings stay in the boot environment. The
 * settings below are safe to load after Prisma and SecretCipher are available,
 * and take effect on the next process restart.
 *
 * Secret values are structurally write-only on the admin path: ordinary reads
 * expose only configured state, a stable fingerprint, and the last update time.
 * Only {@link DeploymentConfigStore.getRuntime} returns opened values.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SecretCipher } from '../secrets/cipher.js'

export const DEPLOYMENT_CONFIG_SCHEMA_VERSION = 1 as const

const HttpUrlSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'must use HTTP or HTTPS' })
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: 'custom', message: 'must not contain credentials' })
    }
    if (url.search || url.hash) {
      ctx.addIssue({ code: 'custom', message: 'must not contain query parameters or fragments' })
    }
  })

const OriginUrlSchema = HttpUrlSchema.refine(
  (value) => new URL(value).pathname === '/',
  'must be an origin without a path'
)
function isSecureHttpUrl(value: string): boolean {
  const url = new URL(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback =
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1'
  return url.protocol === 'https:' || loopback
}
const SecureHttpUrlSchema = HttpUrlSchema.refine(isSecureHttpUrl, 'must use HTTPS unless it is loopback')
const SecureOriginUrlSchema = SecureHttpUrlSchema.refine(
  (value) => new URL(value).pathname === '/',
  'must be an origin without a path'
)
const NullableUrlSchema = HttpUrlSchema.nullable()
const NullableOriginUrlSchema = OriginUrlSchema.nullable()

const PublicUrlsSchema = z.strictObject({
  controlPlane: NullableOriginUrlSchema,
  relay: NullableOriginUrlSchema,
  web: NullableOriginUrlSchema,
  mcp: NullableOriginUrlSchema
})

const AuthSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({
    mode: z.literal('oidc'),
    issuer: SecureHttpUrlSchema.refine(
      (value) => new URL(value).pathname.replace(/\/$/, '').endsWith('/oidc'),
      'must end in /oidc'
    ),
    audience: z.string().min(1),
    browserClient: z.strictObject({
      endpoint: SecureOriginUrlSchema,
      appId: z.string().min(1),
      apiResource: NullableUrlSchema
    }),
    // Provider ids are deployment data (for example github, google, lark), not
    // a closed core enum. An enabled social-only login needs at least one.
    socialProviders: z.array(z.string().trim().min(1)).min(1)
  })
])

/** Version 1 of the JSONB document persisted in `deployment_config.values`. */
export const DeploymentConfigValuesV1Schema = z
  .strictObject({
    publicUrls: PublicUrlsSchema,
    auth: AuthSchema,
    github: z
      .strictObject({
        appId: z.number().int().positive(),
        slug: z.string().trim().min(1),
        clientId: z.string().trim().min(1).nullable()
      })
      .nullable(),
    slack: z
      .strictObject({
        appId: z.string().trim().min(1),
        clientId: z.string().trim().min(1)
      })
      .nullable(),
    logto: z
      .strictObject({
        managementEndpoint: SecureOriginUrlSchema,
        managementAppId: z.string().trim().min(1),
        managementResource: HttpUrlSchema
      })
      .nullable(),
    features: z.strictObject({
      presetAgentsEnabled: z.boolean(),
      waitlistMode: z.boolean()
    })
  })
  .superRefine((values, ctx) => {
    for (const key of ['controlPlane', 'web'] as const) {
      if (!values.publicUrls[key]) {
        ctx.addIssue({
          code: 'custom',
          path: ['publicUrls', key],
          message: `a ${key} public URL is required in a persisted deployment configuration`
        })
      }
    }
    if (values.auth.mode === 'oidc') {
      const tokenAudience = values.auth.browserClient.apiResource ?? values.auth.browserClient.appId
      if (values.auth.audience !== tokenAudience) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'audience'],
          message: 'must equal the browser API resource, or the browser app id when no API resource is configured'
        })
      }
      const expectedIssuer = `${values.auth.browserClient.endpoint.replace(/\/+$/, '')}/oidc`
      if (values.auth.issuer.replace(/\/+$/, '') !== expectedIssuer) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'issuer'],
          message: 'must equal the browser endpoint plus /oidc'
        })
      }
      for (const key of ['controlPlane', 'web'] as const) {
        const url = values.publicUrls[key]
        if (!url || !isSecureHttpUrl(url)) {
          ctx.addIssue({
            code: 'custom',
            path: ['publicUrls', key],
            message: `a secure ${key} public URL is required when OIDC is enabled`
          })
        }
      }
    }
    if (values.github || values.slack) {
      for (const key of ['web', 'controlPlane', 'relay'] as const) {
        const url = values.publicUrls[key]
        if (!url || new URL(url).protocol !== 'https:') {
          const provider =
            values.github && values.slack ? 'GitHub and Slack Apps' : values.github ? 'GitHub App' : 'Slack App'
          ctx.addIssue({
            code: 'custom',
            path: ['publicUrls', key],
            message: `an HTTPS ${key} public URL is required when the ${provider} is enabled`
          })
        }
      }
    }
  })

export type DeploymentConfigValuesV1 = z.infer<typeof DeploymentConfigValuesV1Schema>

export const DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1: DeploymentConfigValuesV1 = {
  publicUrls: {
    controlPlane: 'http://localhost:8080',
    relay: 'http://localhost:8090',
    web: 'http://localhost:3000',
    mcp: null
  },
  auth: { mode: 'none' },
  github: null,
  slack: null,
  logto: null,
  features: { presetAgentsEnabled: true, waitlistMode: false }
}

export const DEPLOYMENT_SECRET_KEYS = [
  'github.privateKeyB64',
  'github.webhookSecret',
  // GitHub returns this only once during App creation. The CP does not consume
  // it today, but Logto's GitHub connector setup does, so it must not be lost.
  'github.clientSecret',
  'slack.clientSecret',
  'slack.signingSecret',
  'logto.managementAppSecret'
] as const

export const DeploymentSecretKeySchema = z.enum(DEPLOYMENT_SECRET_KEYS)
export type DeploymentSecretKey = z.infer<typeof DeploymentSecretKeySchema>

/** Omission preserves; a string replaces; null clears. Unknown keys fail. */
export const DeploymentSecretPatchSchema = z.partialRecord(DeploymentSecretKeySchema, z.string().min(1).nullable())
export type DeploymentSecretPatch = z.infer<typeof DeploymentSecretPatchSchema>

export interface DeploymentSecretAdminStatus {
  key: DeploymentSecretKey
  configured: boolean
  fingerprint: string | null
  updatedAt: Date | null
}

export interface DeploymentConfigAdmin {
  schemaVersion: typeof DEPLOYMENT_CONFIG_SCHEMA_VERSION
  revision: number
  values: DeploymentConfigValuesV1
  /** One redacted status per known key; never contains a secret value. */
  secrets: DeploymentSecretAdminStatus[]
  /** Internal bootstrap marker; Admin HTTP responses deliberately omit it. */
  adminClaimedFor: string | null
  updatedAt: Date
}

export interface DeploymentConfigRuntime {
  schemaVersion: typeof DEPLOYMENT_CONFIG_SCHEMA_VERSION
  revision: number
  values: DeploymentConfigValuesV1
  /** Explicit runtime-only plaintext projection. Never return this from Admin APIs. */
  secrets: Partial<Record<DeploymentSecretKey, string>>
  updatedAt: Date
}

export interface DeploymentConfigReplaceInput {
  /** 0 creates the singleton; later writes must match the last observed revision. */
  expectedRevision: number
  /** Full replacement of the typed non-secret document. */
  values: DeploymentConfigValuesV1
  /** Partial write-only patch: omitted preserve, string replace, null clear. */
  secrets?: DeploymentSecretPatch
}

export interface StoredDeploymentSecretMetadata {
  key: string
  fingerprint: string
  updatedAt: Date
}

export interface StoredDeploymentSecretRuntime extends StoredDeploymentSecretMetadata {
  sealedValue: string
}

export interface StoredDeploymentConfigAdmin {
  schemaVersion: number
  revision: number
  values: unknown
  secrets: StoredDeploymentSecretMetadata[]
  adminClaimedFor: string | null
  updatedAt: Date
}

export interface StoredDeploymentConfigRuntime {
  schemaVersion: number
  revision: number
  values: unknown
  secrets: StoredDeploymentSecretRuntime[]
  updatedAt: Date
}

export interface PreparedDeploymentSecret {
  sealedValue: string
  fingerprint: string
}

export interface PreparedDeploymentConfigReplace {
  expectedRevision: number
  schemaVersion: typeof DEPLOYMENT_CONFIG_SCHEMA_VERSION
  values: DeploymentConfigValuesV1
  secrets: Partial<Record<DeploymentSecretKey, PreparedDeploymentSecret | null>>
  requiredSecretKeys: readonly DeploymentSecretKey[]
}

/** DB-only port. Implementations must serialize and atomically apply replace + patch. */
export interface DeploymentConfigPersistence {
  readAdmin(): Promise<StoredDeploymentConfigAdmin | null>
  readRuntime(): Promise<StoredDeploymentConfigRuntime | null>
  replace(input: PreparedDeploymentConfigReplace): Promise<StoredDeploymentConfigAdmin>
  markAdminClaimed(expectedRevision: number, claimedFor: string): Promise<void>
}

/** The only public persistence surface used by admin/runtime composition. */
export interface DeploymentConfigStore {
  getAdmin(): Promise<DeploymentConfigAdmin | null>
  replace(input: DeploymentConfigReplaceInput): Promise<DeploymentConfigAdmin>
  /** Omit `secretKeys` for the normal active-provider projection. */
  getRuntime(secretKeys?: readonly DeploymentSecretKey[]): Promise<DeploymentConfigRuntime | null>
  markAdminClaimed(expectedRevision: number, claimedFor: string): Promise<void>
}

export class DeploymentConfigMissingSecretsError extends Error {
  readonly code = 'DEPLOYMENT_CONFIG_MISSING_SECRETS'

  constructor(readonly missing: readonly DeploymentSecretKey[]) {
    super(`deployment configuration is missing required secrets: ${missing.join(', ')}`)
    this.name = 'DeploymentConfigMissingSecretsError'
  }
}

export class DeploymentConfigConflictError extends Error {
  readonly code = 'DEPLOYMENT_CONFIG_REVISION_CONFLICT'

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`deployment configuration revision changed: expected ${expectedRevision}, found ${actualRevision}`)
    this.name = 'DeploymentConfigConflictError'
  }
}

export class DeploymentConfigSecretRefreshRequiredError extends Error {
  readonly code = 'DEPLOYMENT_CONFIG_SECRET_REFRESH_REQUIRED'

  constructor(readonly keys: readonly DeploymentSecretKey[]) {
    super(`provider identity changed; replace its write-only secrets in the same request: ${keys.join(', ')}`)
    this.name = 'DeploymentConfigSecretRefreshRequiredError'
  }
}

export function parseDeploymentConfigValues(schemaVersion: number, values: unknown): DeploymentConfigValuesV1 {
  if (schemaVersion !== DEPLOYMENT_CONFIG_SCHEMA_VERSION) {
    throw new Error(`unsupported deployment configuration schema version: ${schemaVersion}`)
  }
  return DeploymentConfigValuesV1Schema.parse(values)
}

export function deploymentSecretsRequiringRefresh(
  previous: DeploymentConfigValuesV1 | null,
  next: DeploymentConfigValuesV1
): DeploymentSecretKey[] {
  const githubAppChanged = next.github && previous?.github?.appId !== next.github.appId
  const githubClientChanged =
    next.github !== null && next.github.clientId !== null && previous?.github?.clientId !== next.github.clientId
  const slackIdentityChanged =
    next.slack && (previous?.slack?.appId !== next.slack.appId || previous?.slack?.clientId !== next.slack.clientId)
  const logtoIdentityChanged =
    next.logto &&
    (previous?.logto?.managementEndpoint !== next.logto.managementEndpoint ||
      previous?.logto?.managementAppId !== next.logto.managementAppId)

  return [
    ...(githubAppChanged ? (['github.privateKeyB64', 'github.webhookSecret'] as const) : []),
    ...(githubClientChanged ? (['github.clientSecret'] as const) : []),
    ...(slackIdentityChanged ? (['slack.clientSecret', 'slack.signingSecret'] as const) : []),
    ...(logtoIdentityChanged ? (['logto.managementAppSecret'] as const) : [])
  ]
}

function requiredSecrets(values: DeploymentConfigValuesV1): DeploymentSecretKey[] {
  return [
    ...(values.github ? (['github.privateKeyB64', 'github.webhookSecret'] as const) : []),
    ...(values.slack ? (['slack.clientSecret', 'slack.signingSecret'] as const) : []),
    ...(values.logto ? (['logto.managementAppSecret'] as const) : [])
  ]
}

function runtimeSecretKeys(values: DeploymentConfigValuesV1): Set<DeploymentSecretKey> {
  return new Set(requiredSecrets(values))
}

/** Bind a successful ADMIN claim to exactly one OIDC issuer/browser app pair. */
export function deploymentAdminClaimKey(values: DeploymentConfigValuesV1): string | null {
  if (values.auth.mode !== 'oidc') return null
  return createHash('sha256').update(`${values.auth.issuer}\0${values.auth.browserClient.appId}`, 'utf8').digest('hex')
}

function toAdmin(row: StoredDeploymentConfigAdmin): DeploymentConfigAdmin {
  const byKey = new Map<DeploymentSecretKey, StoredDeploymentSecretMetadata>()
  for (const secret of row.secrets) {
    const parsed = DeploymentSecretKeySchema.safeParse(secret.key)
    if (parsed.success) byKey.set(parsed.data, secret)
  }
  return {
    schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION,
    revision: row.revision,
    values: parseDeploymentConfigValues(row.schemaVersion, row.values),
    adminClaimedFor: row.adminClaimedFor,
    secrets: DEPLOYMENT_SECRET_KEYS.map((key) => {
      const secret = byKey.get(key)
      return {
        key,
        configured: secret !== undefined,
        fingerprint: secret?.fingerprint ?? null,
        updatedAt: secret?.updatedAt ?? null
      }
    }),
    updatedAt: row.updatedAt
  }
}

function fingerprint(value: string): string {
  // Short, stable display fingerprint. Persisting it avoids decrypting secrets
  // for ordinary Admin GETs and remains stable when ciphertext is rewrapped.
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`
}

export class DeploymentConfigService implements DeploymentConfigStore {
  constructor(
    private readonly persistence: DeploymentConfigPersistence,
    private readonly cipher: SecretCipher
  ) {}

  async getAdmin(): Promise<DeploymentConfigAdmin | null> {
    const row = await this.persistence.readAdmin()
    return row ? toAdmin(row) : null
  }

  async replace(input: DeploymentConfigReplaceInput): Promise<DeploymentConfigAdmin> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative integer')
    }
    const values = DeploymentConfigValuesV1Schema.parse(input.values)
    const secretPatch = DeploymentSecretPatchSchema.parse(input.secrets ?? {})
    const prepared: PreparedDeploymentConfigReplace['secrets'] = {}

    // A real cipher may call Vault. Seal before the repository opens its DB
    // transaction so a configuration write never holds a transaction on I/O.
    for (const [rawKey, value] of Object.entries(secretPatch)) {
      const key = DeploymentSecretKeySchema.parse(rawKey)
      prepared[key] =
        value === null
          ? null
          : {
              sealedValue: await this.cipher.seal(value),
              fingerprint: fingerprint(value)
            }
    }

    return toAdmin(
      await this.persistence.replace({
        expectedRevision: input.expectedRevision,
        schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION,
        values,
        secrets: prepared,
        requiredSecretKeys: requiredSecrets(values)
      })
    )
  }

  async getRuntime(secretKeys?: readonly DeploymentSecretKey[]): Promise<DeploymentConfigRuntime | null> {
    const row = await this.persistence.readRuntime()
    if (!row) return null

    const values = parseDeploymentConfigValues(row.schemaVersion, row.values)
    const activeKeys = runtimeSecretKeys(values)
    const openedKeys = secretKeys ? new Set(secretKeys.filter((key) => activeKeys.has(key))) : activeKeys
    const secrets: Partial<Record<DeploymentSecretKey, string>> = {}
    for (const secret of row.secrets) {
      const parsed = DeploymentSecretKeySchema.safeParse(secret.key)
      // Unknown rows from a newer binary are ignored by this older runtime.
      if (parsed.success && openedKeys.has(parsed.data)) {
        secrets[parsed.data] = await this.cipher.open(secret.sealedValue)
      }
    }
    return {
      schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION,
      revision: row.revision,
      values,
      secrets,
      updatedAt: row.updatedAt
    }
  }

  markAdminClaimed(expectedRevision: number, claimedFor: string): Promise<void> {
    return this.persistence.markAdminClaimed(expectedRevision, claimedFor)
  }
}
