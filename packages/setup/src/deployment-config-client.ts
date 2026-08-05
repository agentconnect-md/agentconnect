/**
 * Small AI-first client for the temporary tenant-admin server.
 *
 * The setup bundle consumes the Control Plane's side-effect-free deployment
 * config subpath, which tsdown embeds into the published single-file CLI. That
 * keeps the schema authoritative without making the installed CLI depend on a
 * separately published Control Plane package. Secret values occur only in PUT
 * input and are never present in response types, errors, or command results.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DEPLOYMENT_SECRET_KEYS,
  DeploymentConfigValuesV1Schema,
  DeploymentSecretKeySchema,
  DeploymentSecretPatchSchema,
  type DeploymentConfigValuesV1,
  type DeploymentSecretKey,
  type DeploymentSecretPatch
} from '@agentconnect.md/control-plane/deployment-config-store'
import { z } from 'zod'

export {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DEPLOYMENT_SECRET_KEYS,
  DeploymentConfigValuesV1Schema,
  DeploymentSecretKeySchema,
  DeploymentSecretPatchSchema
}
export type { DeploymentConfigValuesV1, DeploymentSecretKey, DeploymentSecretPatch }

export const DEFAULT_TENANT_ADMIN_URL = 'http://127.0.0.1:8091'
export const TENANT_ADMIN_ID_TOKEN_ENV = 'TENANT_ADMIN_ID_TOKEN'
export const DEPLOYMENT_CONFIG_PATH = '/api/v1/deployment-config'
export const LOGTO_CHECK_PATH = '/api/v1/check/logto'
export const LOGTO_RECONCILE_PATH = '/api/v1/reconcile/logto'

export const DeploymentConfigPutSchema = z.strictObject({
  values: DeploymentConfigValuesV1Schema,
  secrets: DeploymentSecretPatchSchema.optional()
})
export type DeploymentConfigPut = z.infer<typeof DeploymentConfigPutSchema>

const DeploymentConfigRequestSchema = DeploymentConfigPutSchema.extend({
  expectedRevision: z.number().int().nonnegative()
})
type DeploymentConfigRequest = z.infer<typeof DeploymentConfigRequestSchema>

const DeploymentSecretAdminStatusSchema = z.strictObject({
  key: DeploymentSecretKeySchema,
  configured: z.boolean(),
  fingerprint: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }).nullable()
})

export const DeploymentConfigAdminSchema = z.strictObject({
  configured: z.boolean(),
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  values: DeploymentConfigValuesV1Schema,
  secrets: z.array(DeploymentSecretAdminStatusSchema),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
  // PUT always returns true. GET may omit it because reading has no pending
  // side effect; accepting the optional field keeps both methods one DTO.
  restartRequired: z.boolean().optional()
})
export type DeploymentConfigAdmin = z.infer<typeof DeploymentConfigAdminSchema>

const LogtoCheckFindingSchema = z.strictObject({
  id: z.enum([
    'logto.configuration',
    'logto.client_credentials',
    'logto.roles_read',
    'logto.admin_role',
    'logto.setup_configuration',
    'logto.application',
    'logto.connectors',
    'logto.sign_in_experience'
  ]),
  status: z.enum(['pass', 'fail', 'unknown']),
  message: z.string().min(1)
})

export const LogtoCheckResultSchema = z
  .strictObject({
    schemaVersion: z.literal('1'),
    checkedAt: z.string().datetime({ offset: true }),
    findings: z.array(LogtoCheckFindingSchema),
    summary: z.strictObject({
      pass: z.number().int().nonnegative(),
      fail: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative()
    })
  })
  .superRefine((result, ctx) => {
    const pass = result.findings.filter((finding) => finding.status === 'pass').length
    const fail = result.findings.filter((finding) => finding.status === 'fail').length
    const unknown = result.findings.length - pass - fail
    if (result.summary.pass !== pass || result.summary.fail !== fail || result.summary.unknown !== unknown) {
      ctx.addIssue({ code: 'custom', path: ['summary'], message: 'finding counts do not match the summary' })
    }
  })
export type LogtoCheckResult = z.infer<typeof LogtoCheckResultSchema>

export const LogtoReconcileResultSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  operation: z.literal('create.logto'),
  changed: z.boolean(),
  revision: z.number().int().nonnegative(),
  restartRequired: z.boolean(),
  application: z.strictObject({
    id: z.string().min(1),
    created: z.boolean(),
    changed: z.boolean()
  }),
  connectors: z.array(
    z.strictObject({
      target: z.string().min(1),
      id: z.string().min(1),
      created: z.boolean()
    })
  ),
  signInExperienceChanged: z.boolean(),
  adminRoleCreated: z.boolean()
})
export type LogtoReconcileResult = z.infer<typeof LogtoReconcileResultSchema>

export class TenantAdminRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'TenantAdminRequestError'
  }
}

export interface TenantAdminClientOptions {
  fetch?: typeof fetch
  idToken?: string
  timeoutMs?: number
}

function tenantAdminBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('--admin-url must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--admin-url must use HTTP or HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('--admin-url must not contain credentials, query parameters, or fragments')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('--admin-url must be an origin without a path')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const loopback =
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1'
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('--admin-url must use HTTPS unless it is loopback')
  }
  return url.origin
}

export class TenantAdminClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch
  private readonly idToken: string | undefined
  private readonly timeoutMs: number

  constructor(adminUrl = DEFAULT_TENANT_ADMIN_URL, options: TenantAdminClientOptions = {}) {
    this.baseUrl = tenantAdminBaseUrl(adminUrl)
    this.fetcher = options.fetch ?? fetch
    this.idToken = (options.idToken ?? process.env[TENANT_ADMIN_ID_TOKEN_ENV])?.trim() || undefined
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  get(): Promise<DeploymentConfigAdmin> {
    return this.request('GET', DEPLOYMENT_CONFIG_PATH, DeploymentConfigAdminSchema)
  }

  put(input: DeploymentConfigPut, expectedRevision: number): Promise<DeploymentConfigAdmin> {
    return this.request(
      'PUT',
      DEPLOYMENT_CONFIG_PATH,
      DeploymentConfigAdminSchema,
      DeploymentConfigRequestSchema.parse({ ...input, expectedRevision })
    )
  }

  checkLogto(): Promise<LogtoCheckResult> {
    return this.request('GET', LOGTO_CHECK_PATH, LogtoCheckResultSchema)
  }

  reconcileLogto(): Promise<LogtoReconcileResult> {
    return this.request('POST', LOGTO_RECONCILE_PATH, LogtoReconcileResultSchema)
  }

  private async request<T>(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    responseSchema: z.ZodType<T>,
    body?: DeploymentConfigRequest
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'user-agent': '@agentconnect.md/setup',
          ...(this.idToken ? { authorization: `Bearer ${this.idToken}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new Error(`tenant-admin ${method} ${path} is unreachable`)
    }

    if (!response.ok) {
      // Never echo a response body: it is outside this client's redacted schema
      // and could contain provider or proxy diagnostics.
      const errorBody = (await response.json().catch(() => null)) as { code?: unknown } | null
      const code = errorBody && typeof errorBody.code === 'string' ? errorBody.code : undefined
      if (response.status === 401) {
        throw new TenantAdminRequestError(
          `tenant-admin ${method} ${path} returned HTTP 401; set or refresh ${TENANT_ADMIN_ID_TOKEN_ENV}`,
          response.status,
          code
        )
      }
      if (response.status === 403) {
        throw new TenantAdminRequestError(
          `tenant-admin ${method} ${path} returned HTTP 403; ${TENANT_ADMIN_ID_TOKEN_ENV} must identify a deployment admin`,
          response.status,
          code
        )
      }
      throw new TenantAdminRequestError(
        `tenant-admin ${method} ${path} returned HTTP ${response.status}`,
        response.status,
        code
      )
    }
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new Error(`tenant-admin ${method} ${path} returned invalid JSON`)
    }
    const parsed = responseSchema.safeParse(value)
    if (!parsed.success) {
      throw new Error(`tenant-admin ${method} ${path} returned an invalid response`)
    }
    return parsed.data
  }
}

function secretFingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`
}

function equivalentPut(current: DeploymentConfigAdmin, input: DeploymentConfigPut): boolean {
  if (!current.configured) return false
  if (JSON.stringify(current.values) !== JSON.stringify(input.values)) return false
  const status = new Map(current.secrets.map((secret) => [secret.key, secret]))
  for (const [rawKey, value] of Object.entries(input.secrets ?? {})) {
    const key = DeploymentSecretKeySchema.parse(rawKey)
    const existing = status.get(key)
    if (value === null) {
      if (existing?.configured) return false
    } else if (!existing?.configured || existing.fingerprint !== secretFingerprint(value)) {
      return false
    }
  }
  return true
}

export interface DeploymentConfigApplyResult {
  schemaVersion: '1'
  operation: 'config.apply'
  changed: boolean
  previousRevision: number
  revision: number
  restartRequired: boolean
  config: DeploymentConfigAdmin
}

export async function applyDeploymentConfig(
  client: Pick<TenantAdminClient, 'get' | 'put'>,
  rawInput: unknown
): Promise<DeploymentConfigApplyResult> {
  const input = DeploymentConfigPutSchema.parse(rawInput)
  const current = await client.get()
  if (equivalentPut(current, input)) {
    return {
      schemaVersion: '1',
      operation: 'config.apply',
      changed: false,
      previousRevision: current.revision,
      revision: current.revision,
      restartRequired: false,
      config: current
    }
  }
  const updated = await client.put(input, current.revision)
  return {
    schemaVersion: '1',
    operation: 'config.apply',
    changed: true,
    previousRevision: current.revision,
    revision: updated.revision,
    restartRequired: updated.restartRequired ?? true,
    config: updated
  }
}

const MAX_APPLY_BYTES = 1024 * 1024

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  let source = ''
  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    source += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (Buffer.byteLength(source, 'utf8') > MAX_APPLY_BYTES) {
      throw new Error('deployment config input exceeds 1 MiB')
    }
  }
  return source
}

/** Read a JSON PUT document. `-` consumes stdin for pipes and AI automation. */
export async function readDeploymentConfigPut(
  file: string,
  stdin: NodeJS.ReadableStream = process.stdin
): Promise<DeploymentConfigPut> {
  let source: string
  try {
    source = file === '-' ? await readStdin(stdin) : await readFile(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.message === 'deployment config input exceeds 1 MiB') throw error
    throw new Error(`cannot read deployment config input '${file}'`)
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_APPLY_BYTES) throw new Error('deployment config input exceeds 1 MiB')

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('deployment config input is not valid JSON')
  }
  const parsed = DeploymentConfigPutSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')
    throw new Error(`invalid deployment config input: ${issues}`)
  }
  return parsed.data
}

export interface GithubDeploymentCredentials {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
  privateKeyBase64: string
  webhookSecret: string
}

export function githubDeploymentPut(
  current: DeploymentConfigAdmin,
  credentials: GithubDeploymentCredentials
): DeploymentConfigPut {
  const appId = Number(credentials.appId)
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('GitHub App creation returned an invalid app id')
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      github: { appId, slug: credentials.slug, clientId: credentials.clientId }
    },
    secrets: {
      'github.privateKeyB64': credentials.privateKeyBase64,
      'github.webhookSecret': credentials.webhookSecret,
      'github.clientSecret': credentials.clientSecret
    }
  })
}

export interface LogtoGithubConnectorCredentials {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
}

export function logtoGithubConnectorPut(
  current: DeploymentConfigAdmin,
  credentials: LogtoGithubConnectorCredentials
): DeploymentConfigPut {
  if (!current.values.logto) throw new Error('save Logto configuration before creating its GitHub connector App')
  const appId = Number(credentials.appId)
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('GitHub App creation returned an invalid app id')
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      logto: {
        ...current.values.logto,
        githubConnector: { appId, slug: credentials.slug, clientId: credentials.clientId }
      }
    },
    secrets: { 'logto.githubConnectorClientSecret': credentials.clientSecret }
  })
}

export interface SlackDeploymentCredentials {
  appId: string
  clientId: string
  clientSecret: string
  signingSecret: string
}

export function slackDeploymentPut(
  current: DeploymentConfigAdmin,
  credentials: SlackDeploymentCredentials
): DeploymentConfigPut {
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      slack: { appId: credentials.appId, clientId: credentials.clientId }
    },
    secrets: {
      'slack.clientSecret': credentials.clientSecret,
      'slack.signingSecret': credentials.signingSecret
    }
  })
}
