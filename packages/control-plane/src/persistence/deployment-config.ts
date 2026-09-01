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
import { DEPLOYMENT_SCOPE } from '../secrets/scope.js'
import { GITLAB_DEFAULT_BASE_URL, normalizeGitlabBaseUrl } from '../gitlab/config.js'

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

const NullableUrlSchema = HttpUrlSchema.nullable()

const AuthSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({
    mode: z.literal('oidc'),
    audience: z.string().min(1),
    browserClient: z.strictObject({
      appId: z.string().min(1),
      apiResource: NullableUrlSchema
    }),
    // Provider ids are deployment data (for example github, google, lark), not
    // a closed core enum. An enabled social-only login needs at least one.
    socialProviders: z.array(z.string().trim().min(1)).min(1)
  })
])

const LogtoBrowserSchema = z.strictObject({
  applicationName: z.string().trim().min(1).default('AgentConnect'),
  apiResource: NullableUrlSchema.default(null),
  // The setup wizard persists and verifies Management API access before the
  // operator chooses a sign-in provider. Auth itself still requires one.
  socialProviders: z.array(z.string().trim().min(1)).default([])
})

function withoutDerivedConnectorId(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const { connectorId: _connectorId, ...stored } = value as Record<string, unknown>
  return stored
}

function withoutGoogleProviderSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const {
    connectorId: _connectorId,
    configuredRedirectUris: _configuredRedirectUris,
    ...stored
  } = value as Record<string, unknown>
  return stored
}

function withoutProviderUrlSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const { configuredUrls: _configuredUrls, ...stored } = value as Record<string, unknown>
  return stored
}

const LogtoGithubConnectorSchema = z.preprocess(
  withoutDerivedConnectorId,
  z.strictObject({
    appId: z.number().int().positive(),
    slug: z.string().trim().min(1),
    clientId: z.string().trim().min(1)
  })
)

const LogtoGoogleConnectorSchema = z.preprocess(
  withoutGoogleProviderSnapshot,
  z.strictObject({
    clientId: z.string().trim().min(1)
  })
)

const LogtoSlackConnectorSchema = z.preprocess(
  withoutDerivedConnectorId,
  z.strictObject({
    appId: z.string().trim().min(1),
    clientId: z.string().trim().min(1)
  })
)

const RegionalLoginAppSchema = z.strictObject({
  loginAppId: z.string().trim().min(1)
})

const GithubAppSchema = z.preprocess(
  withoutProviderUrlSnapshot,
  z.strictObject({
    appId: z.number().int().positive(),
    slug: z.string().trim().min(1),
    clientId: z.string().trim().min(1).nullable(),
    /** Whether Relay should accept GitHub webhook delivery for this App. Omitted means enabled. */
    webhookEnabled: z.boolean().optional()
  })
)

const GitlabBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      normalizeGitlabBaseUrl(value)
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message })
    }
  })

const GitlabAppSchema = z.preprocess(
  withoutProviderUrlSnapshot,
  z.strictObject({
    // GitLab OAuth application id (gitlab-com-integration.md §18.3); the client
    // secret is the write-only 'gitlab.clientSecret' deployment secret.
    clientId: z.string().trim().min(1),
    // The instance that application is registered on (§24.1). Absent means
    // GitLab.com — the default value of the axis, not a separate mode.
    baseUrl: GitlabBaseUrlSchema.nullable().optional()
  })
)

const SlackAppSchema = z.preprocess(
  withoutProviderUrlSnapshot,
  z.strictObject({
    appId: z.string().trim().min(1),
    clientId: z.string().trim().min(1)
  })
)

const LinearAppSchema = z.preprocess(
  withoutProviderUrlSnapshot,
  z.strictObject({
    // The deployment's one Linear OAuth app (linear-integration.md §7.1); its client
    // secret and webhook signing secret are write-only 'linear.*' deployment secrets.
    clientId: z.string().trim().min(1)
  })
)

/** Version 1 of the JSONB document persisted in `deployment_config.values`. */
export const DeploymentConfigValuesV1Schema = z
  .strictObject({
    auth: AuthSchema,
    github: GithubAppSchema.nullable(),
    gitlab: GitlabAppSchema.nullable().optional(),
    slack: SlackAppSchema.nullable(),
    linear: LinearAppSchema.nullable().optional(),
    /** Regional Login Apps used as the tenant anchor for Bot App admission. */
    feishu: RegionalLoginAppSchema.nullable().optional(),
    lark: RegionalLoginAppSchema.nullable().optional(),
    logto: z
      .strictObject({
        managementAppId: z.string().trim().min(1),
        managementResource: HttpUrlSchema,
        /** Desired browser app state; `create logto` projects it into `auth`. */
        browser: LogtoBrowserSchema.nullable().default(null),
        /** GitHub App OAuth identity used by the Logto connector. */
        githubConnector: LogtoGithubConnectorSchema.nullable().default(null),
        /** Google OAuth client identity. Its secret stays write-only. */
        googleConnector: LogtoGoogleConnectorSchema.nullable().optional(),
        /** Deployment Slack App identity reused for Slack social sign-in. */
        slackConnector: LogtoSlackConnectorSchema.nullable().optional()
      })
      .nullable(),
    features: z.strictObject({
      presetAgentsEnabled: z.boolean(),
      /** Maximum organizations a non-ADMIN account may create through the console. */
      maxOrgsPerNonAdminUser: z.number().int().nonnegative().default(1)
    })
  })
  .superRefine((values, ctx) => {
    if (values.logto?.slackConnector) {
      if (!values.slack) {
        ctx.addIssue({
          code: 'custom',
          path: ['logto', 'slackConnector'],
          message: 'requires the deployment Slack App'
        })
      } else if (
        values.logto.slackConnector.appId !== values.slack.appId ||
        values.logto.slackConnector.clientId !== values.slack.clientId
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['logto', 'slackConnector'],
          message: 'must reuse the deployment Slack App identity'
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
    }
  })

export type DeploymentConfigValuesV1 = z.infer<typeof DeploymentConfigValuesV1Schema>

export const DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1: DeploymentConfigValuesV1 = {
  auth: { mode: 'none' },
  github: null,
  slack: null,
  logto: null,
  features: { presetAgentsEnabled: true, maxOrgsPerNonAdminUser: 1 }
}

export const DEPLOYMENT_SECRET_KEYS = [
  'github.privateKeyB64',
  'github.webhookSecret',
  // GitHub returns this only once during App creation. The CP does not consume
  // it today, but Logto's GitHub connector setup does, so it must not be lost.
  'github.clientSecret',
  'gitlab.clientSecret',
  'slack.clientSecret',
  'slack.signingSecret',
  'linear.clientSecret',
  'linear.signingSecret',
  'feishu.loginAppSecret',
  'lark.loginAppSecret',
  'logto.managementAppSecret',
  'logto.githubConnectorClientSecret',
  'logto.googleConnectorClientSecret'
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

/** The named reason a GitLab base-URL change is refused (gitlab-com-integration.md §24.1). */
export const GITLAB_BASE_URL_LOCKED_REASON = 'gitlab_base_url_locked' as const

/** Retargeting would send the old host's credentials and host-relative numeric
 *  ids to a new one, because no GitLab row carries instance provenance (§24.1):
 *  the axis is immutable while any GitLab state exists. */
export class DeploymentConfigGitlabBaseUrlLockedError extends Error {
  readonly code = GITLAB_BASE_URL_LOCKED_REASON

  constructor(
    readonly currentBaseUrl: string,
    readonly requestedBaseUrl: string
  ) {
    super(
      `the GitLab instance base URL is locked while GitLab state exists (${currentBaseUrl} → ${requestedBaseUrl}); disconnect every GitLab project first`
    )
    this.name = 'DeploymentConfigGitlabBaseUrlLockedError'
  }
}

/** The instance a document's GitLab entry selects; absent means GitLab.com (§24.1). */
export function effectiveGitlabBaseUrl(values: DeploymentConfigValuesV1): string {
  const configured = values.gitlab?.baseUrl
  return configured ? normalizeGitlabBaseUrl(configured) : GITLAB_DEFAULT_BASE_URL
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
  const githubWebhookEnabled = next.github !== null && next.github.webhookEnabled !== false
  // A different instance is a different application, so its secret must be re-entered.
  const gitlabClientChanged =
    next.gitlab != null &&
    (previous?.gitlab?.clientId !== next.gitlab.clientId ||
      (previous != null && effectiveGitlabBaseUrl(previous) !== effectiveGitlabBaseUrl(next)))
  const slackIdentityChanged =
    next.slack && (previous?.slack?.appId !== next.slack.appId || previous?.slack?.clientId !== next.slack.clientId)
  // A different Linear OAuth app is a different client secret AND a different webhook signing secret.
  const linearIdentityChanged = next.linear && previous?.linear?.clientId !== next.linear.clientId
  const feishuIdentityChanged = next.feishu && previous?.feishu?.loginAppId !== next.feishu.loginAppId
  const larkIdentityChanged = next.lark && previous?.lark?.loginAppId !== next.lark.loginAppId
  const logtoIdentityChanged = next.logto && previous?.logto?.managementAppId !== next.logto.managementAppId
  const logtoGithubConnectorChanged =
    next.logto?.githubConnector &&
    (previous?.logto?.githubConnector?.appId !== next.logto.githubConnector.appId ||
      previous?.logto?.githubConnector?.clientId !== next.logto.githubConnector.clientId)
  const logtoGoogleConnectorChanged =
    next.logto?.googleConnector && previous?.logto?.googleConnector?.clientId !== next.logto.googleConnector.clientId
  return [
    ...(githubAppChanged ? (['github.privateKeyB64'] as const) : []),
    ...(next.github && githubWebhookEnabled && githubAppChanged ? (['github.webhookSecret'] as const) : []),
    ...(githubClientChanged ? (['github.clientSecret'] as const) : []),
    ...(gitlabClientChanged ? (['gitlab.clientSecret'] as const) : []),
    ...(slackIdentityChanged ? (['slack.clientSecret', 'slack.signingSecret'] as const) : []),
    ...(linearIdentityChanged ? (['linear.clientSecret', 'linear.signingSecret'] as const) : []),
    ...(feishuIdentityChanged ? (['feishu.loginAppSecret'] as const) : []),
    ...(larkIdentityChanged ? (['lark.loginAppSecret'] as const) : []),
    ...(logtoIdentityChanged ? (['logto.managementAppSecret'] as const) : []),
    ...(logtoGithubConnectorChanged ? (['logto.githubConnectorClientSecret'] as const) : []),
    ...(logtoGoogleConnectorChanged ? (['logto.googleConnectorClientSecret'] as const) : [])
  ]
}

function requiredSecrets(values: DeploymentConfigValuesV1): DeploymentSecretKey[] {
  return [
    ...(values.github ? (['github.privateKeyB64'] as const) : []),
    ...(values.github && values.github.webhookEnabled !== false ? (['github.webhookSecret'] as const) : []),
    ...(values.gitlab ? (['gitlab.clientSecret'] as const) : []),
    ...(values.slack ? (['slack.clientSecret', 'slack.signingSecret'] as const) : []),
    ...(values.linear ? (['linear.clientSecret', 'linear.signingSecret'] as const) : []),
    ...(values.feishu ? (['feishu.loginAppSecret'] as const) : []),
    ...(values.lark ? (['lark.loginAppSecret'] as const) : []),
    ...(values.logto ? (['logto.managementAppSecret'] as const) : []),
    ...(values.logto?.githubConnector ? (['logto.githubConnectorClientSecret'] as const) : []),
    ...(values.logto?.googleConnector ? (['logto.googleConnectorClientSecret'] as const) : [])
  ]
}

function runtimeSecretKeys(values: DeploymentConfigValuesV1): Set<DeploymentSecretKey> {
  const keys = new Set(requiredSecrets(values))
  // Setup Server may reuse the deployment App for Logto sign-in. Keep this
  // optional for the GitHub runtime, but allow an explicit setup-side read.
  if (values.github) keys.add('github.clientSecret')
  return keys
}

/** Bind a successful ADMIN claim to exactly one startup issuer/browser app pair. */
export function deploymentAdminClaimKey(values: DeploymentConfigValuesV1, issuer: string): string | null {
  if (values.auth.mode !== 'oidc') return null
  return createHash('sha256').update(`${issuer}\0${values.auth.browserClient.appId}`, 'utf8').digest('hex')
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
              // Deployment-owned material: the operator's own credentials, not
              // any tenant's — the one store that binds the deployment scope.
              sealedValue: await this.cipher.seal(value, DEPLOYMENT_SCOPE),
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
        secrets[parsed.data] = await this.cipher.open(secret.sealedValue, DEPLOYMENT_SCOPE)
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
