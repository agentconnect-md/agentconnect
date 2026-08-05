import { randomBytes } from 'node:crypto'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions
} from 'fastify'
import { z } from 'zod'
import {
  OfficialFeishuRegistrationProvider,
  type FeishuRegistrationProvider
} from '@agentconnect.md/control-plane/feishu-registration-provider'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  DEPLOYMENT_CONFIG_SCHEMA_VERSION,
  DEPLOYMENT_SECRET_KEYS,
  DeploymentConfigConflictError,
  DeploymentConfigMissingSecretsError,
  DeploymentConfigSecretRefreshRequiredError,
  DeploymentConfigValuesV1Schema,
  DeploymentSecretPatchSchema,
  deploymentAdminClaimKey,
  openDeploymentConfigStore,
  type DeploymentConfigAdmin,
  type DeploymentConfigRuntime,
  type DeploymentConfigStore,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import { loadDeploymentEnvironment } from '../deployment-environment.js'
import {
  githubDeploymentPut,
  localAuthLogtoPut,
  logtoGoogleConnectorPut,
  logtoGithubConnectorPut,
  slackDeploymentPut
} from '../deployment-config-client.js'
import {
  auditGithubApp,
  buildGithubAppManifest,
  convertGithubManifest,
  githubConfiguredUrls,
  githubManifestRegistrationUrl
} from '../github-app.js'
import {
  auditSlackManifest,
  buildSlackDeploymentManifest,
  createSlackApp,
  exportSlackManifest,
  requireProviderAppEndpoints,
  slackConfiguredUrls,
  type ProviderAppConfig
} from '../slack-app.js'
import {
  TenantAdminAuthError,
  TenantAdminAuthenticator,
  type AdminOidcConfig,
  type TenantAdminPrincipal,
  type VerifyOidcToken
} from './auth.js'
import { loadTenantAdminProcessConfig } from './config.js'
import { TENANT_ADMIN_HTML } from './html.js'
import {
  LOGTO_GITHUB_CONNECTOR_ID,
  LOGTO_GOOGLE_CONNECTOR_ID,
  LOGTO_SLACK_CONNECTOR_ID,
  LogtoAdminClaimClient,
  LogtoManagementError,
  type LogtoManagementConfig,
  type LogtoSetupDesired
} from './logto-management.js'

const PutDeploymentConfigBody = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  values: DeploymentConfigValuesV1Schema,
  secrets: DeploymentSecretPatchSchema.optional()
})

const BootstrapLogtoBody = z.strictObject({
  managementAppId: z.string().trim().min(1).max(200),
  managementAppSecret: z.string().min(1).max(10_000),
  socialProvider: z.enum(['github', 'google', 'slack']).optional()
})

const GithubOwnerSchema = z.discriminatedUnion('owner', [
  z.strictObject({ owner: z.literal('personal'), organization: z.null().optional() }),
  z.strictObject({
    owner: z.literal('organization'),
    organization: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
  })
])

const CreateGithubStartBody = z.strictObject({
  purpose: z.literal('deployment'),
  name: z.string().trim().min(1).max(100),
  ownership: GithubOwnerSchema,
  connectLogto: z.boolean().optional().default(false)
})

const CreateSlackBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  configToken: z.string().trim().min(1).max(10_000),
  connectLogto: z.boolean().optional().default(false)
})

const ConfigureGoogleBody = z.strictObject({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().min(1).max(10_000).optional()
})

const RegionalLoginAppBody = z
  .strictObject({
    appId: z.string().trim().min(1).max(500),
    appSecret: z.string().min(1).max(10_000).optional()
  })
  .nullable()

const ConfigureRegionalLoginAppBody = z.strictObject({
  region: z.enum(['feishu', 'lark']),
  app: RegionalLoginAppBody
})

const CreateRegionalLoginAppBody = z.strictObject({
  region: z.enum(['feishu', 'lark']),
  name: z.string().trim().min(1).max(100)
})

const CheckSlackBody = z.strictObject({
  configToken: z.string().trim().min(1).max(10_000)
})

interface OidcDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
}

export interface TenantAdminServerDeps {
  store: DeploymentConfigStore
  publicUrl: string
  fetch?: typeof fetch
  verifyOidcToken?: VerifyOidcToken
  makeLogtoClaimClient?: (config: LogtoManagementConfig) => Pick<LogtoAdminClaimClient, 'assignAdmin'>
  makeLogtoCheckClient?: (
    config: LogtoManagementConfig
  ) => Pick<LogtoAdminClaimClient, 'verifyClientCredentials' | 'inspectAdminRole' | 'inspectSetup'>
  makeLogtoSetupClient?: (config: LogtoManagementConfig) => Pick<LogtoAdminClaimClient, 'reconcileSetup'>
  feishuRegistrationProvider?: Pick<FeishuRegistrationProvider, 'begin' | 'poll'>
  localAuthBootstrap?: {
    issuer: string
    adminEndpoint?: string
    services: { web: string; controlPlane: string; relay: string }
  }
  now?: () => Date
  /** Compose-only: host publishing is loopback and the admin bridge is isolated. */
  allowContainerLoopbackProxy?: boolean
}

export type TenantAdminServerOptions = FastifyServerOptions

function problem(reply: FastifyReply, statusCode: number, message: string, code?: string): FastifyReply {
  return reply.code(statusCode).send({
    error:
      statusCode === 400
        ? 'Bad Request'
        : statusCode === 401
          ? 'Unauthorized'
          : statusCode === 403
            ? 'Forbidden'
            : statusCode === 409
              ? 'Conflict'
              : statusCode === 502
                ? 'Bad Gateway'
                : statusCode === 503
                  ? 'Service Unavailable'
                  : 'Internal Server Error',
    statusCode,
    message,
    ...(code ? { code } : {})
  })
}

function isLoopbackHostname(raw: string): boolean {
  const hostname = raw
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1'
}

function isLocalRequest(publicUrl: string, allowContainerLoopbackProxy: boolean, request: FastifyRequest): boolean {
  const advertisedLocal = isLoopbackHostname(new URL(publicUrl).hostname)
  const directLoopback = isLoopbackHostname(request.ip)
  return advertisedLocal && isLoopbackHostname(request.hostname) && (directLoopback || allowContainerLoopbackProxy)
}

function localOnly(publicUrl: string, allowContainerLoopbackProxy = false) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Direct CLI use requires a loopback peer. Compose explicitly opts into
    // its loopback-published, isolated bridge proxy because Docker rewrites the
    // peer address before Fastify sees it.
    if (!isLocalRequest(publicUrl, allowContainerLoopbackProxy, request)) {
      void problem(reply, 403, 'deployment bootstrap is available on loopback only', 'LOOPBACK_REQUIRED')
    }
  }
}

function toStatus(record: DeploymentConfigAdmin | null) {
  const secrets = record
    ? record.secrets.map((secret) => ({
        ...secret,
        updatedAt: secret.updatedAt?.toISOString() ?? null
      }))
    : DEPLOYMENT_SECRET_KEYS.map((key) => ({ key, configured: false, fingerprint: null, updatedAt: null }))
  return {
    configured: record !== null,
    schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION,
    revision: record?.revision ?? 0,
    values: record?.values ?? DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
    secrets,
    updatedAt: record?.updatedAt.toISOString() ?? null
  }
}

function oidcOf(record: DeploymentConfigAdmin | null, issuer: string): AdminOidcConfig | null {
  const auth = record?.values.auth
  // Logto emits the `roles` scope into the ID token. Tenant Admin therefore
  // validates that token against the browser application's client id. The CP
  // continues to validate API access tokens against auth.audience separately.
  return auth?.mode === 'oidc' ? { issuer, audience: auth.browserClient.appId } : null
}

function authFailure(reply: FastifyReply, error: TenantAdminAuthError): FastifyReply {
  return problem(reply, error.statusCode, error.message, error.code)
}

interface CheckFinding {
  id: string
  status: 'pass' | 'fail' | 'unknown'
  message: string
}

function checkReport(findings: CheckFinding[], now: () => Date) {
  const pass = findings.filter((finding) => finding.status === 'pass').length
  const fail = findings.filter((finding) => finding.status === 'fail').length
  return {
    schemaVersion: '1' as const,
    checkedAt: now().toISOString(),
    findings,
    summary: { pass, fail, unknown: findings.length - pass - fail }
  }
}

function logtoUpstreamStatus(error: unknown): 'fail' | 'unknown' {
  if (error instanceof LogtoManagementError && error.code !== 'LOGTO_UNAVAILABLE') return 'fail'
  const status = error instanceof LogtoManagementError ? error.status : undefined
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'fail' : 'unknown'
}

function logtoConfig(record: DeploymentConfigRuntime | null, endpoint: string): LogtoManagementConfig | null {
  if (!record || !record.values.logto) return null
  const secret = record.secrets['logto.managementAppSecret']
  if (!secret) return null
  return {
    endpoint: new URL(endpoint).origin,
    appId: record.values.logto.managementAppId,
    appSecret: secret,
    resource: record.values.logto.managementResource
  }
}

interface ResolvedLogtoSetup {
  desired: LogtoSetupDesired
  endpoint: string
  apiResource: string | null
  socialProviders: string[]
}

function appendPath(origin: string, path: string): string {
  return new URL(path, `${origin.replace(/\/+$/, '')}/`).toString()
}

function googleRedirectUris(endpoint: string): string[] {
  return [
    appendPath(endpoint, `/callback/${LOGTO_GOOGLE_CONNECTOR_ID}`),
    appendPath(endpoint, `/account/callback/social/${LOGTO_GOOGLE_CONNECTOR_ID}`)
  ]
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...right].sort())
}

type ServiceTopology = { web: string; controlPlane: string; relay: string }

function providerAppConfig(services: ServiceTopology): ProviderAppConfig {
  return { services }
}

function slackProviderAppConfig(services: ServiceTopology): ProviderAppConfig {
  const config = providerAppConfig(services)
  requireProviderAppEndpoints(config)
  return config
}

function logtoSetup(
  record: DeploymentConfigRuntime,
  tenantAdminUrl: string,
  services: ServiceTopology,
  endpoint: string
): ResolvedLogtoSetup | null {
  const { auth, logto } = record.values
  if (!logto) return null
  const browser =
    logto.browser ??
    (auth.mode === 'oidc'
      ? {
          applicationName: 'AgentConnect',
          apiResource: auth.browserClient.apiResource,
          socialProviders: auth.socialProviders
        }
      : null)
  if (!browser) return null
  const resolvedEndpoint = new URL(endpoint).origin

  const githubSecret = record.secrets['logto.githubConnectorClientSecret']
  const googleSecret = record.secrets['logto.googleConnectorClientSecret']
  const slackSecret = record.secrets['slack.clientSecret']
  const applicationId = auth.mode === 'oidc' ? auth.browserClient.appId : undefined
  const webOrigin = new URL(services.web).origin
  const adminOrigin = new URL(tenantAdminUrl).origin
  return {
    endpoint: resolvedEndpoint,
    apiResource: browser.apiResource,
    socialProviders: [...browser.socialProviders],
    desired: {
      ...(applicationId ? { applicationId } : {}),
      applicationName: browser.applicationName,
      redirectUris: [appendPath(webOrigin, '/auth/callback'), appendPath(adminOrigin, '/auth/callback')],
      postLogoutRedirectUris: [appendPath(webOrigin, '/login')],
      corsAllowedOrigins: [...new Set([webOrigin, adminOrigin])],
      socialProviders: [...browser.socialProviders],
      ...(logto.githubConnector && githubSecret
        ? { github: { clientId: logto.githubConnector.clientId, clientSecret: githubSecret } }
        : {}),
      ...(logto.googleConnector && googleSecret
        ? { google: { clientId: logto.googleConnector.clientId, clientSecret: googleSecret } }
        : {}),
      ...(logto.slackConnector && slackSecret
        ? {
            slack: {
              clientId: logto.slackConnector.clientId,
              clientSecret: slackSecret,
              scope: 'openid profile email'
            }
          }
        : {})
    }
  }
}

/** Build the thin UI/API over the shared typed deployment-config service. */
export function buildTenantAdminServer(
  deps: TenantAdminServerDeps,
  options: TenantAdminServerOptions = {}
): FastifyInstance {
  const app = Fastify({ logger: false, ...options })
  const fetchImpl = deps.fetch ?? fetch
  const requireLocal = localOnly(deps.publicUrl, deps.allowContainerLoopbackProxy)
  const authenticator = new TenantAdminAuthenticator(
    { get: async () => oidcOf(await deps.store.getAdmin(), localAuthBootstrap.issuer) },
    deps.verifyOidcToken
  )
  const discovery = new Map<string, Promise<OidcDiscovery>>()
  let mutationTail: Promise<void> = Promise.resolve()
  const defaultEnvironment = loadDeploymentEnvironment({})
  const localAuthBootstrap = deps.localAuthBootstrap ?? {
    issuer: defaultEnvironment.issuer,
    adminEndpoint: 'http://admin.agentconnect.localhost:3002',
    services: defaultEnvironment.services
  }
  const logtoEndpoint = new URL(localAuthBootstrap.issuer).origin
  const logtoAdminEndpoint =
    localAuthBootstrap.adminEndpoint?.replace(/\/+$/, '') ?? 'http://admin.agentconnect.localhost:3002'
  const githubFlows = new Map<
    string,
    {
      expectedRevision: number
      connectLogto: boolean
      configuredUrls: ReturnType<typeof githubConfiguredUrls>
      expires: ReturnType<typeof setTimeout>
    }
  >()
  const feishuRegistrationProvider =
    deps.feishuRegistrationProvider ?? new OfficialFeishuRegistrationProvider(fetchImpl)
  const regionalAppFlows = new Map<
    string,
    {
      region: 'feishu' | 'lark'
      providerDomain: string
      deviceCode: string
      intervalMs: number
      nextPollAt: number
      expiresAt: number
    }
  >()

  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation)
    mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const expectedGithubManifest = (values: DeploymentConfigValuesV1): Record<string, unknown> => {
    const browser = values.logto?.browser
    const connectLogto = Boolean(values.logto?.githubConnector && browser)
    return buildGithubAppManifest(
      providerAppConfig(localAuthBootstrap.services),
      'AgentConnect',
      new URL('/api/v1/create/github/callback', deps.publicUrl).toString(),
      connectLogto && browser
        ? {
            webUrl: localAuthBootstrap.services.web,
            logtoEndpoint,
            connectorId: LOGTO_GITHUB_CONNECTOR_ID
          }
        : undefined
    )
  }

  app.addHook('onClose', async () => {
    for (const flow of githubFlows.values()) clearTimeout(flow.expires)
    githubFlows.clear()
    regionalAppFlows.clear()
  })

  const discover = (issuer: string): Promise<OidcDiscovery> => {
    const normalized = issuer.replace(/\/+$/, '')
    const cached = discovery.get(normalized)
    if (cached) return cached
    const pending = (async () => {
      const response = await fetchImpl(`${normalized}/.well-known/openid-configuration`)
      if (!response.ok) throw new Error(`OIDC discovery failed: HTTP ${response.status}`)
      const body = (await response.json()) as { authorization_endpoint?: unknown; token_endpoint?: unknown }
      if (typeof body.authorization_endpoint !== 'string' || typeof body.token_endpoint !== 'string') {
        throw new Error('OIDC discovery is missing authorization_endpoint or token_endpoint')
      }
      return { authorizationEndpoint: body.authorization_endpoint, tokenEndpoint: body.token_endpoint }
    })().catch((error) => {
      discovery.delete(normalized)
      throw error
    })
    discovery.set(normalized, pending)
    return pending
  }

  const requireConfigurationAccess = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const current = await deps.store.getAdmin()
    const claimedFor = current ? deploymentAdminClaimKey(current.values, localAuthBootstrap.issuer) : null
    if (!current || current.values.auth.mode === 'none' || !claimedFor || current.adminClaimedFor !== claimedFor) {
      return requireLocal(request, reply)
    }
    try {
      request.tenantAdminPrincipal = await authenticator.authenticate(request.headers.authorization)
    } catch (error) {
      if (!(error instanceof TenantAdminAuthError)) throw error
      void authFailure(reply, error)
    }
  }

  const requireDiagnosticAccess = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (isLocalRequest(deps.publicUrl, deps.allowContainerLoopbackProxy ?? false, request)) return
    return requireConfigurationAccess(request, reply)
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DeploymentConfigMissingSecretsError) {
      return problem(reply, 400, error.message, error.code)
    }
    if (error instanceof DeploymentConfigSecretRefreshRequiredError) {
      return problem(reply, 400, error.message, error.code)
    }
    if (error instanceof DeploymentConfigConflictError) {
      return problem(reply, 409, error.message, error.code)
    }
    if (error instanceof LogtoManagementError) {
      const status =
        error.code === 'LOGTO_UNAVAILABLE' ? 502 : error.code === 'SOCIAL_CONNECTOR_UNSUPPORTED' ? 400 : 409
      return problem(reply, status, error.message, error.code)
    }
    request.log.error({ err: error }, 'tenant-admin request failed')
    return problem(reply, 500, 'internal server error')
  })

  app.get('/livez', async () => ({ status: 'ok' }))
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(TENANT_ADMIN_HTML))
  app.get('/auth/callback', async (_request, reply) => reply.type('text/html; charset=utf-8').send(TENANT_ADMIN_HTML))

  // Public browser bootstrap data only; these values are already published to
  // the normal console. No deployment secrets or management credentials leave.
  app.get('/api/v1/auth-config', async (_request, reply) => {
    const current = await deps.store.getAdmin()
    const auth = current?.values.auth
    if (!auth || auth.mode === 'none') return { mode: 'none' as const, logtoAdminEndpoint }
    const claimedFor = deploymentAdminClaimKey(current.values, localAuthBootstrap.issuer)
    try {
      const endpoints = await discover(localAuthBootstrap.issuer)
      return {
        mode: 'oidc' as const,
        logtoAdminEndpoint,
        claimAvailable: claimedFor !== null && current.adminClaimedFor !== claimedFor,
        endpoint: logtoEndpoint,
        appId: auth.browserClient.appId,
        resource: auth.browserClient.apiResource,
        redirectUri: new URL('/auth/callback', deps.publicUrl).toString(),
        ...endpoints
      }
    } catch (error) {
      return {
        mode: 'unavailable' as const,
        logtoAdminEndpoint,
        message: error instanceof Error ? error.message : 'OIDC discovery failed'
      }
    }
  })

  app.get('/api/v1/bootstrap-info', { preHandler: requireLocal }, async () => {
    const redirectUris = googleRedirectUris(logtoEndpoint)
    const current = await deps.store.getAdmin()
    const logtoConfigured = Boolean(
      current?.values.logto?.managementAppId &&
      current.secrets.some((secret) => secret.key === 'logto.managementAppSecret' && secret.configured)
    )
    let githubAvailable = true
    let githubWebhookActive = false
    try {
      const config = providerAppConfig(localAuthBootstrap.services)
      const manifest = buildGithubAppManifest(
        config,
        'AgentConnect',
        new URL('/api/v1/create/github/callback', deps.publicUrl).toString()
      )
      githubWebhookActive = githubConfiguredUrls(config, manifest).webhookActive
    } catch {
      githubAvailable = false
    }
    const slackLoginEndpoint = logtoEndpoint
    let slackAvailable = new URL(slackLoginEndpoint).protocol === 'https:'
    if (slackAvailable) {
      try {
        slackProviderAppConfig(localAuthBootstrap.services)
      } catch {
        slackAvailable = false
      }
    }
    return {
      services: localAuthBootstrap.services,
      logtoEndpoint,
      logtoAdminEndpoint,
      logtoConfigured,
      logtoManagementAppId: current?.values.logto?.managementAppId ?? null,
      google: { javascriptOrigins: [logtoEndpoint], redirectUris },
      githubAvailable,
      githubWebhookActive,
      slackAvailable,
      slackLoginRedirectUrl: appendPath(slackLoginEndpoint, `/callback/${LOGTO_SLACK_CONNECTOR_ID}`)
    }
  })

  app.get('/api/v1/deployment-config', { preHandler: requireConfigurationAccess }, async () =>
    toStatus(await deps.store.getAdmin())
  )

  app.put('/api/v1/deployment-config', { preHandler: requireConfigurationAccess }, async (request, reply) => {
    const parsed = PutDeploymentConfigBody.safeParse(request.body)
    if (!parsed.success) {
      return problem(reply, 400, 'request does not match the deployment configuration schema')
    }
    const saved = await deps.store.replace({
      ...parsed.data,
      values: parsed.data.values
    })
    return {
      ...toStatus(saved),
      restartRequired: true as const
    }
  })

  app.post('/api/v1/bootstrap/logto', { preHandler: requireLocal }, async (request, reply) => {
    const parsed = BootstrapLogtoBody.safeParse(request.body)
    if (!parsed.success) return problem(reply, 400, 'Logto Management API credentials are required')
    return serializeMutation(async () => {
      const current = await deps.store.getAdmin()
      if (current?.values.auth.mode === 'oidc') {
        return problem(reply, 409, 'Logto sign-in is already configured')
      }
      const put = localAuthLogtoPut(
        { values: current?.values ?? DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 },
        {
          managementAppId: parsed.data.managementAppId,
          managementAppSecret: parsed.data.managementAppSecret,
          socialProvider: parsed.data.socialProvider
        }
      )
      const saved = await deps.store.replace({ expectedRevision: current?.revision ?? 0, ...put })
      return { ...toStatus(saved), restartRequired: true as const }
    })
  })

  app.post('/api/v1/create/github/start', { preHandler: requireConfigurationAccess }, async (request, reply) => {
    const parsed = CreateGithubStartBody.safeParse(request.body)
    if (!parsed.success) return problem(reply, 400, 'choose a valid GitHub App owner, name, and organization')
    const current = await deps.store.getAdmin()
    if (!current) return problem(reply, 409, 'save deployment settings before creating a GitHub App')

    const redirectUrl = new URL('/api/v1/create/github/callback', deps.publicUrl).toString()
    let manifest: Record<string, unknown>
    let connectLogto = false
    try {
      if (current.values.github) return problem(reply, 409, 'a deployment GitHub App is already configured')
      const browser = current.values.logto?.browser
      connectLogto = Boolean(
        browser &&
        !current.values.logto?.githubConnector &&
        (parsed.data.connectLogto || browser.socialProviders.includes('github'))
      )
      manifest = buildGithubAppManifest(
        providerAppConfig(localAuthBootstrap.services),
        parsed.data.name,
        redirectUrl,
        connectLogto && browser
          ? {
              webUrl: localAuthBootstrap.services.web,
              logtoEndpoint,
              connectorId: LOGTO_GITHUB_CONNECTOR_ID
            }
          : undefined
      )
    } catch (error) {
      return problem(reply, 409, error instanceof Error ? error.message : 'GitHub App configuration is incomplete')
    }

    const state = randomBytes(32).toString('base64url')
    const organization = parsed.data.ownership.owner === 'organization' ? parsed.data.ownership.organization : undefined
    const expires = setTimeout(() => githubFlows.delete(state), 15 * 60_000)
    expires.unref()
    githubFlows.set(state, {
      expectedRevision: current.revision,
      connectLogto,
      configuredUrls: githubConfiguredUrls(providerAppConfig(localAuthBootstrap.services), manifest),
      expires
    })
    return {
      action: githubManifestRegistrationUrl(organization, state),
      manifest,
      expiresInSeconds: 15 * 60
    }
  })

  app.get('/api/v1/create/github/callback', async (request, reply) => {
    const query = z
      .object({ state: z.string().min(1), code: z.string().min(1).optional(), error: z.string().optional() })
      .safeParse(request.query)
    if (!query.success) return reply.redirect('/?github=invalid-callback')
    const pending = githubFlows.get(query.data.state)
    if (!pending) return reply.redirect('/?github=expired')
    githubFlows.delete(query.data.state)
    clearTimeout(pending.expires)
    if (query.data.error || !query.data.code) return reply.redirect('/?github=cancelled')

    let credentials: Awaited<ReturnType<typeof convertGithubManifest>>
    try {
      credentials = await convertGithubManifest(query.data.code, { fetch: fetchImpl })
    } catch (error) {
      request.log.warn({ err: error }, 'GitHub App manifest conversion failed')
      return reply.redirect('/?github=conversion-failed')
    }

    return serializeMutation(async () => {
      const current = await deps.store.getAdmin()
      if (!current || current.revision !== pending.expectedRevision) {
        return reply.redirect('/?github=save-failed')
      }
      try {
        const put = githubDeploymentPut(current, credentials, {
          configuredUrls: pending.configuredUrls,
          connectLogto: pending.connectLogto
        })
        await deps.store.replace({ expectedRevision: current.revision, ...put })
      } catch (error) {
        request.log.error({ err: error }, 'created GitHub App could not be saved')
        return reply.redirect('/?github=save-failed')
      }
      return reply.redirect(`/?github=${pending.connectLogto ? 'deployment-login-created' : 'deployment-created'}`)
    })
  })

  app.post('/api/v1/configure/github-login', { preHandler: requireConfigurationAccess }, async (_request, reply) =>
    serializeMutation(async () => {
      const runtime = await deps.store.getRuntime(['github.clientSecret'])
      const github = runtime?.values.github
      const logto = runtime?.values.logto
      const clientSecret = runtime?.secrets['github.clientSecret']
      if (!runtime || !github || !github.clientId || !logto) {
        return problem(reply, 409, 'save the deployment GitHub App and Logto configuration first')
      }
      if (!clientSecret) {
        return problem(reply, 409, 'the deployment GitHub App client secret is missing')
      }
      const put = logtoGithubConnectorPut(runtime, {
        appId: String(github.appId),
        slug: github.slug,
        clientId: github.clientId,
        clientSecret
      })
      const saved = await deps.store.replace({ expectedRevision: runtime.revision, ...put })
      return { revision: saved.revision, restartRequired: true as const }
    })
  )

  app.post('/api/v1/configure/google', { preHandler: requireConfigurationAccess }, async (request, reply) => {
    const parsed = ConfigureGoogleBody.safeParse(request.body)
    if (!parsed.success) return problem(reply, 400, 'Google OAuth client id is required')
    return serializeMutation(async () => {
      const current = await deps.store.getAdmin()
      if (!current?.values.logto?.browser) return problem(reply, 409, 'save Logto browser configuration first')
      const redirectUris = googleRedirectUris(logtoEndpoint)
      const put = logtoGoogleConnectorPut(current, {
        clientId: parsed.data.clientId,
        ...(parsed.data.clientSecret ? { clientSecret: parsed.data.clientSecret } : {}),
        configuredRedirectUris: redirectUris
      })
      const saved = await deps.store.replace({ expectedRevision: current.revision, ...put })
      return { revision: saved.revision, redirectUris, restartRequired: true as const }
    })
  })

  app.post(
    '/api/v1/configure/regional-login-app',
    { preHandler: requireConfigurationAccess },
    async (request, reply) => {
      const parsed = ConfigureRegionalLoginAppBody.safeParse(request.body)
      if (!parsed.success) return problem(reply, 400, 'a valid regional App ID is required')
      return serializeMutation(async () => {
        const current = await deps.store.getAdmin()
        if (!current) return problem(reply, 409, 'save deployment settings before configuring a regional App')
        const { region, app: regionalApp } = parsed.data
        const secretKey = `${region}.loginAppSecret` as const
        const saved = await deps.store.replace({
          expectedRevision: current.revision,
          values: {
            ...current.values,
            [region]: regionalApp ? { loginAppId: regionalApp.appId } : null
          },
          secrets: regionalApp?.appSecret
            ? { [secretKey]: regionalApp.appSecret }
            : regionalApp === null
              ? { [secretKey]: null }
              : undefined
        })
        return { region, revision: saved.revision, restartRequired: true as const }
      })
    }
  )

  app.get(
    '/api/v1/check/regional-login-app/:region',
    { preHandler: requireDiagnosticAccess },
    async (request, reply) => {
      const parsed = z.strictObject({ region: z.enum(['feishu', 'lark']) }).safeParse(request.params)
      if (!parsed.success) return problem(reply, 400, 'choose Feishu or Lark')
      const { region } = parsed.data
      const secretKey = `${region}.loginAppSecret` as const
      const runtime = await deps.store.getRuntime([secretKey])
      const regionalApp = runtime?.values[region]
      const appSecret = runtime?.secrets[secretKey]
      if (!regionalApp || !appSecret) {
        return problem(reply, 409, `${region === 'feishu' ? 'Feishu' : 'Lark'} App credentials are not configured`)
      }

      const origin = region === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com'
      let response: Response
      try {
        response = await fetchImpl(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: regionalApp.loginAppId, app_secret: appSecret }),
          signal: AbortSignal.timeout(5_000)
        })
      } catch {
        return {
          provider: region,
          status: 'unknown' as const,
          message: `${region === 'feishu' ? 'Feishu' : 'Lark'} could not be reached.`
        }
      }
      const body = (await response.json().catch(() => ({}))) as { code?: number; tenant_access_token?: string }
      if (!response.ok) {
        return {
          provider: region,
          status: 'unknown' as const,
          message: `${region === 'feishu' ? 'Feishu' : 'Lark'} returned HTTP ${response.status}.`
        }
      }
      const matches = body.code === 0 && typeof body.tenant_access_token === 'string'
      return {
        provider: region,
        status: matches ? ('pass' as const) : ('fail' as const),
        message: matches
          ? `${region === 'feishu' ? 'Feishu' : 'Lark'} accepted the saved App ID and secret.`
          : `${region === 'feishu' ? 'Feishu' : 'Lark'} rejected the saved App ID or secret.`
      }
    }
  )

  app.post(
    '/api/v1/create/regional-login-app/start',
    { preHandler: requireConfigurationAccess },
    async (request, reply) => {
      const parsed = CreateRegionalLoginAppBody.safeParse(request.body)
      if (!parsed.success) return problem(reply, 400, 'choose Feishu or Lark and enter an App name')
      const current = await deps.store.getAdmin()
      if (!current) return problem(reply, 409, 'save deployment settings before creating a regional App')
      if (current.values[parsed.data.region]) {
        return problem(reply, 409, `${parsed.data.region === 'feishu' ? 'Feishu' : 'Lark'} is already configured`)
      }
      let begun: Awaited<ReturnType<FeishuRegistrationProvider['begin']>>
      try {
        begun = await feishuRegistrationProvider.begin(parsed.data.name, parsed.data.region)
      } catch {
        return problem(reply, 502, 'Could not start regional App creation. Please try again.')
      }
      const id = randomBytes(24).toString('base64url')
      const now = Date.now()
      regionalAppFlows.set(id, {
        region: parsed.data.region,
        providerDomain: begun.providerDomain,
        deviceCode: begun.deviceCode,
        intervalMs: begun.intervalMs,
        nextPollAt: now,
        expiresAt: now + begun.expiresInMs
      })
      return {
        id,
        region: parsed.data.region,
        authorizationUrl: begun.authorizationUrl,
        expiresAt: new Date(now + begun.expiresInMs).toISOString()
      }
    }
  )

  app.get(
    '/api/v1/create/regional-login-app/:id',
    { preHandler: requireConfigurationAccess },
    async (request, reply) => {
      const parsed = z.strictObject({ id: z.string().min(1) }).safeParse(request.params)
      if (!parsed.success) return problem(reply, 400, 'invalid regional App creation id')
      const flow = regionalAppFlows.get(parsed.data.id)
      if (!flow) return problem(reply, 404, 'regional App creation was not found or has expired')
      const now = Date.now()
      if (now >= flow.expiresAt) {
        regionalAppFlows.delete(parsed.data.id)
        return { status: 'failed' as const, reason: 'expired' as const }
      }
      if (now < flow.nextPollAt) {
        return { status: 'pending' as const, retryAfterMs: flow.nextPollAt - now }
      }

      let result: Awaited<ReturnType<FeishuRegistrationProvider['poll']>>
      try {
        result = await feishuRegistrationProvider.poll(flow.providerDomain, flow.deviceCode)
      } catch {
        flow.nextPollAt = now + flow.intervalMs
        return { status: 'pending' as const, retryAfterMs: flow.intervalMs }
      }
      if (result.outcome === 'pending' || result.outcome === 'slow_down' || result.outcome === 'switch_domain') {
        if (result.outcome === 'slow_down') flow.intervalMs += 5_000
        if (result.outcome === 'switch_domain') flow.providerDomain = result.providerDomain
        flow.nextPollAt = now + (result.outcome === 'switch_domain' ? 0 : flow.intervalMs)
        return { status: 'pending' as const, retryAfterMs: Math.max(250, flow.nextPollAt - now) }
      }
      if (result.outcome !== 'authorized') {
        regionalAppFlows.delete(parsed.data.id)
        return { status: 'failed' as const, reason: result.outcome }
      }
      const resolvedRegion = result.region ?? flow.region
      if (resolvedRegion !== flow.region) {
        regionalAppFlows.delete(parsed.data.id)
        return problem(reply, 409, 'The approved App belongs to the other regional platform. Use its matching card.')
      }

      return serializeMutation(async () => {
        const current = await deps.store.getAdmin()
        if (!current) return problem(reply, 409, 'deployment settings are no longer available')
        if (current.values[flow.region]) {
          regionalAppFlows.delete(parsed.data.id)
          return problem(
            reply,
            409,
            `${flow.region === 'feishu' ? 'Feishu' : 'Lark'} was configured by another session`
          )
        }
        const secretKey = `${flow.region}.loginAppSecret` as const
        const saved = await deps.store.replace({
          expectedRevision: current.revision,
          values: { ...current.values, [flow.region]: { loginAppId: result.appId } },
          secrets: { [secretKey]: result.appSecret }
        })
        regionalAppFlows.delete(parsed.data.id)
        return {
          status: 'completed' as const,
          region: flow.region,
          appId: result.appId,
          revision: saved.revision,
          restartRequired: true as const
        }
      })
    }
  )

  app.post('/api/v1/create/slack', { preHandler: requireConfigurationAccess }, async (request, reply) => {
    const parsed = CreateSlackBody.safeParse(request.body)
    if (!parsed.success) return problem(reply, 400, 'Slack App name and configuration token are required')
    return serializeMutation(async () => {
      const current = await deps.store.getAdmin()
      if (!current) return problem(reply, 409, 'save deployment settings before creating a Slack App')
      if (current.values.slack) return problem(reply, 409, 'a deployment Slack App is already configured')
      let manifest: Record<string, unknown>
      try {
        const browser = current.values.logto?.browser
        if (parsed.data.connectLogto && !browser) {
          return problem(reply, 409, 'save Logto browser configuration before enabling Slack sign-in')
        }
        manifest = buildSlackDeploymentManifest(
          slackProviderAppConfig(localAuthBootstrap.services),
          parsed.data.name,
          parsed.data.connectLogto && browser ? { logtoEndpoint, connectorId: LOGTO_SLACK_CONNECTOR_ID } : undefined
        )
      } catch (error) {
        return problem(reply, 409, error instanceof Error ? error.message : 'Slack App configuration is incomplete')
      }

      let credentials: Awaited<ReturnType<typeof createSlackApp>>
      try {
        credentials = await createSlackApp(parsed.data.configToken, manifest, { fetch: fetchImpl })
      } catch (error) {
        return problem(reply, 502, error instanceof Error ? error.message : 'Slack App creation failed')
      }
      const put = slackDeploymentPut(current, credentials, slackConfiguredUrls(manifest), parsed.data.connectLogto)
      const saved = await deps.store.replace({ expectedRevision: current.revision, ...put })

      try {
        const exported = await exportSlackManifest(parsed.data.configToken, credentials.appId, { fetch: fetchImpl })
        const missing = auditSlackManifest(exported, manifest)
        if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`)
      } catch (error) {
        return problem(
          reply,
          502,
          `Slack App ${credentials.appId} was created and saved, but manifest verification failed: ${(error as Error).message}`,
          'SLACK_APP_VERIFICATION_FAILED'
        )
      }

      return {
        operation: 'create.slack' as const,
        app: { id: credentials.appId },
        revision: saved.revision,
        restartRequired: true as const
      }
    })
  })

  app.get('/api/v1/check/github', { preHandler: requireDiagnosticAccess }, async (_request, reply) => {
    const runtime = await deps.store.getRuntime(['github.privateKeyB64'])
    const github = runtime?.values.github
    const privateKey = runtime?.secrets['github.privateKeyB64']
    if (!runtime || !github || !privateKey) {
      return problem(reply, 409, 'the deployment GitHub App is not fully configured')
    }
    let manifest: Record<string, unknown>
    try {
      manifest = expectedGithubManifest(runtime.values)
    } catch (error) {
      return problem(reply, 409, error instanceof Error ? error.message : 'GitHub App configuration is incomplete')
    }
    let audited: Awaited<ReturnType<typeof auditGithubApp>>
    try {
      audited = await auditGithubApp(github, privateKey, manifest, fetchImpl)
    } catch (error) {
      return problem(reply, 502, error instanceof Error ? error.message : 'GitHub App settings could not be checked')
    }
    const expectedUrls = githubConfiguredUrls(providerAppConfig(localAuthBootstrap.services), manifest)
    const confirmed = github.configuredUrls
    const missing = [...audited.missing]
    if (confirmed?.setupUrl !== expectedUrls.setupUrl) missing.push('setup_url')
    if (!sameStrings(confirmed?.callbackUrls, expectedUrls.callbackUrls)) missing.push('callback_urls')
    if (confirmed?.webhookActive !== expectedUrls.webhookActive) missing.push('webhook_active')
    return {
      provider: 'github' as const,
      status: missing.length === 0 ? ('pass' as const) : ('fail' as const),
      missing: [...new Set(missing)],
      expected: expectedUrls,
      settingsUrl: audited.app.settingsUrl,
      note: 'GitHub exposes permissions, events, and webhook URL to this check. Callback, setup, and webhook-active settings require operator confirmation after editing the App.'
    }
  })

  app.post('/api/v1/confirm/github-urls', { preHandler: requireConfigurationAccess }, async (_request, reply) =>
    serializeMutation(async () => {
      const runtime = await deps.store.getRuntime(['github.privateKeyB64'])
      const github = runtime?.values.github
      const privateKey = runtime?.secrets['github.privateKeyB64']
      if (!runtime || !github || !privateKey) {
        return problem(reply, 409, 'the deployment GitHub App is not fully configured')
      }
      let manifest: Record<string, unknown>
      let audited: Awaited<ReturnType<typeof auditGithubApp>>
      try {
        manifest = expectedGithubManifest(runtime.values)
        audited = await auditGithubApp(github, privateKey, manifest, fetchImpl)
      } catch (error) {
        return problem(reply, 502, error instanceof Error ? error.message : 'GitHub App settings could not be checked')
      }
      if (audited.missing.length > 0) {
        return problem(
          reply,
          409,
          `GitHub App still differs in: ${audited.missing.join(', ')}`,
          'GITHUB_APP_MANIFEST_DRIFT'
        )
      }
      const configuredUrls = githubConfiguredUrls(providerAppConfig(localAuthBootstrap.services), manifest)
      const saved = await deps.store.replace({
        expectedRevision: runtime.revision,
        values: { ...runtime.values, github: { ...github, configuredUrls } }
      })
      return { revision: saved.revision, configuredUrls, restartRequired: false as const }
    })
  )

  app.post('/api/v1/check/slack', { preHandler: requireDiagnosticAccess }, async (request, reply) => {
    const parsed = CheckSlackBody.safeParse(request.body)
    if (!parsed.success) return problem(reply, 400, 'a Slack App configuration token is required')
    return serializeMutation(async () => {
      const current = await deps.store.getAdmin()
      const slack = current?.values.slack
      if (!current || !slack) return problem(reply, 409, 'the deployment Slack App is not configured')
      let manifest: Record<string, unknown>
      try {
        const browser = current.values.logto?.browser
        manifest = buildSlackDeploymentManifest(
          slackProviderAppConfig(localAuthBootstrap.services),
          'AgentConnect',
          current.values.logto?.slackConnector && browser
            ? { logtoEndpoint, connectorId: LOGTO_SLACK_CONNECTOR_ID }
            : undefined
        )
      } catch (error) {
        return problem(reply, 409, error instanceof Error ? error.message : 'Slack App configuration is incomplete')
      }
      let actual: Record<string, unknown>
      try {
        actual = await exportSlackManifest(parsed.data.configToken, slack.appId, { fetch: fetchImpl })
      } catch (error) {
        return problem(reply, 502, error instanceof Error ? error.message : 'Slack App settings could not be checked')
      }
      const missing = auditSlackManifest(actual, manifest)
      const expected = slackConfiguredUrls(manifest)
      let revision = current.revision
      if (missing.length === 0 && JSON.stringify(slack.configuredUrls) !== JSON.stringify(expected)) {
        const saved = await deps.store.replace({
          expectedRevision: current.revision,
          values: { ...current.values, slack: { ...slack, configuredUrls: expected } }
        })
        revision = saved.revision
      }
      return {
        provider: 'slack' as const,
        status: missing.length === 0 ? ('pass' as const) : ('fail' as const),
        missing,
        expected,
        settingsUrl: `https://api.slack.com/apps/${encodeURIComponent(slack.appId)}`,
        revision,
        restartRequired: false as const
      }
    })
  })

  app.post('/api/v1/reconcile/logto', { preHandler: requireConfigurationAccess }, async (_request, reply) =>
    serializeMutation(async () => {
      const secretKeys = [
        'logto.managementAppSecret',
        'logto.githubConnectorClientSecret',
        'logto.googleConnectorClientSecret',
        'slack.clientSecret',
        'github.clientSecret'
      ] as const
      const initialRuntime = await deps.store.getRuntime(secretKeys)
      const config = logtoConfig(initialRuntime, logtoEndpoint)
      if (!initialRuntime || !config) {
        return problem(reply, 409, 'save the Logto Management API configuration before creating Logto resources')
      }
      let runtime = initialRuntime
      let setup = logtoSetup(runtime, deps.publicUrl, localAuthBootstrap.services, logtoEndpoint)
      if (!setup) {
        return problem(reply, 409, 'save Logto browser desired state before creating Logto resources')
      }
      const github = runtime.values.github
      const githubClientId = github?.clientId
      const githubSecret = runtime.secrets['github.clientSecret']
      const shouldReconnectGithub =
        setup.socialProviders.length === 0 &&
        runtime.values.auth.mode === 'oidc' &&
        runtime.values.auth.socialProviders.includes('github') &&
        github !== null &&
        typeof githubClientId === 'string' &&
        githubSecret !== undefined
      if (shouldReconnectGithub) {
        const put = logtoGithubConnectorPut(runtime, {
          appId: String(github.appId),
          slug: github.slug,
          clientId: githubClientId,
          clientSecret: githubSecret
        })
        await deps.store.replace({ expectedRevision: runtime.revision, ...put })
        const refreshed = await deps.store.getRuntime(secretKeys)
        if (!refreshed) return problem(reply, 409, 'the deployment configuration changed while reconnecting GitHub')
        runtime = refreshed
        setup = logtoSetup(runtime, deps.publicUrl, localAuthBootstrap.services, logtoEndpoint)
        if (!setup) return problem(reply, 409, 'save Logto browser desired state before creating Logto resources')
      }
      if (setup.socialProviders.length === 0) {
        return problem(reply, 409, 'configure a Logto sign-in provider before creating Logto resources')
      }

      const client = deps.makeLogtoSetupClient?.(config) ?? new LogtoAdminClaimClient(config)
      const reconciled = await client.reconcileSetup(setup.desired)
      const auth = {
        mode: 'oidc' as const,
        audience: setup.apiResource ?? reconciled.application.id,
        browserClient: {
          appId: reconciled.application.id,
          apiResource: setup.apiResource
        },
        socialProviders: setup.socialProviders
      }
      const nextValues = { ...runtime.values, auth }
      const configChanged = JSON.stringify(runtime.values) !== JSON.stringify(nextValues)
      const saved = configChanged
        ? await deps.store.replace({
            expectedRevision: runtime.revision,
            values: nextValues
          })
        : null
      const changed = reconciled.changed || configChanged
      return {
        schemaVersion: '1' as const,
        operation: 'create.logto' as const,
        changed,
        revision: saved?.revision ?? runtime.revision,
        restartRequired: changed,
        application: reconciled.application,
        connectors: reconciled.connectors,
        signInExperienceChanged: reconciled.signInExperienceChanged,
        adminRoleCreated: reconciled.adminRoleCreated
      }
    })
  )

  app.get('/api/v1/check/logto', { preHandler: requireDiagnosticAccess }, async () => {
    const findings: CheckFinding[] = []
    const report = () => checkReport(findings, deps.now ?? (() => new Date()))
    const runtime = await deps.store.getRuntime([
      'logto.managementAppSecret',
      'logto.githubConnectorClientSecret',
      'logto.googleConnectorClientSecret',
      'slack.clientSecret'
    ])

    if (!runtime) {
      findings.push({
        id: 'logto.configuration',
        status: 'fail',
        message: 'Deployment configuration has not been saved.'
      })
      return report()
    }
    if (!runtime.values.logto) {
      findings.push({
        id: 'logto.configuration',
        status: 'fail',
        message: 'Logto Management API configuration is missing.'
      })
      return report()
    }
    if (!runtime.secrets['logto.managementAppSecret']) {
      findings.push({
        id: 'logto.configuration',
        status: 'fail',
        message: 'Logto Management API application secret is missing.'
      })
      return report()
    }

    findings.push({
      id: 'logto.configuration',
      status: 'pass',
      message: 'Logto Management API configuration is complete.'
    })
    const config = logtoConfig(runtime, logtoEndpoint)!
    const client = deps.makeLogtoCheckClient?.(config) ?? new LogtoAdminClaimClient(config)
    const setup = logtoSetup(runtime, deps.publicUrl, localAuthBootstrap.services, logtoEndpoint)

    try {
      await client.verifyClientCredentials()
      findings.push({
        id: 'logto.client_credentials',
        status: 'pass',
        message: 'Logto accepted the Management API client_credentials grant with scope all.'
      })
    } catch (error) {
      const status = logtoUpstreamStatus(error)
      const upstreamStatus = error instanceof LogtoManagementError ? error.status : undefined
      findings.push({
        id: 'logto.client_credentials',
        status,
        message:
          status === 'fail'
            ? `Logto rejected the Management API client_credentials grant (HTTP ${upstreamStatus}).`
            : 'The Management API client_credentials grant could not be verified because Logto or the network is unavailable.'
      })
      return report()
    }

    let adminRole: Awaited<ReturnType<LogtoAdminClaimClient['inspectAdminRole']>>
    try {
      adminRole = await client.inspectAdminRole()
      findings.push({
        id: 'logto.roles_read',
        status: 'pass',
        message: 'The Management API application can read Logto roles.'
      })
    } catch (error) {
      const status = logtoUpstreamStatus(error)
      const upstreamStatus = error instanceof LogtoManagementError ? error.status : undefined
      findings.push({
        id: 'logto.roles_read',
        status,
        message:
          status === 'fail'
            ? `The Management API application cannot read Logto roles (HTTP ${upstreamStatus}).`
            : 'The Logto roles permission could not be verified because Logto or the network is unavailable.'
      })
      return report()
    }

    findings.push(
      adminRole.exists && adminRole.type === 'User' && adminRole.isDefault === false
        ? {
            id: 'logto.admin_role',
            status: 'pass',
            message: 'The exact non-default global User role ADMIN exists.'
          }
        : {
            id: 'logto.admin_role',
            status: 'fail',
            message: adminRole.exists
              ? 'A role named ADMIN exists, but it is not a non-default User role.'
              : 'The exact global User role ADMIN does not exist; the first Tenant Admin sign-in will create it.'
          }
    )
    if (!setup) {
      findings.push({
        id: 'logto.setup_configuration',
        status: 'fail',
        message: 'Logto browser desired state is missing.'
      })
      return report()
    }
    let setupInspection: Awaited<ReturnType<LogtoAdminClaimClient['inspectSetup']>>
    try {
      setupInspection = await client.inspectSetup(setup.desired)
    } catch (error) {
      const status = logtoUpstreamStatus(error)
      findings.push({
        id: 'logto.setup_configuration',
        status,
        message:
          status === 'fail'
            ? 'Logto browser resources are invalid or ambiguous.'
            : 'Logto browser resources could not be checked because Logto or the network is unavailable.'
      })
      return report()
    }
    findings.push(
      setupInspection.application.exists && setupInspection.application.matches
        ? {
            id: 'logto.application',
            status: 'pass',
            message: `Logto SPA ${setupInspection.application.id} has the expected redirects and CORS origins.`
          }
        : {
            id: 'logto.application',
            status: 'fail',
            message: setupInspection.application.exists
              ? 'The selected Logto SPA does not match the expected redirects and CORS origins.'
              : 'The AgentConnect Logto SPA does not exist.'
          }
    )
    const invalidConnectors = setupInspection.connectors
      .filter((connector) => !connector.exists || !connector.matches)
      .map((connector) => connector.target)
    findings.push(
      invalidConnectors.length === 0
        ? {
            id: 'logto.connectors',
            status: 'pass',
            message: 'All configured Logto social connectors match their saved OAuth clients.'
          }
        : {
            id: 'logto.connectors',
            status: 'fail',
            message: `Missing or mismatched Logto social connectors: ${invalidConnectors.join(', ')}.`
          }
    )
    findings.push(
      setupInspection.signInExperienceMatches
        ? {
            id: 'logto.sign_in_experience',
            status: 'pass',
            message: 'Logto sign-in methods match the deployment configuration.'
          }
        : {
            id: 'logto.sign_in_experience',
            status: 'fail',
            message: 'Logto sign-in methods do not match the deployment configuration.'
          }
    )
    return report()
  })

  // Local-only first-admin assignment. The Tenant Admin page calls this
  // automatically after the first OIDC sign-in. It verifies a real identity
  // without the role, then the Management API creates the exact global User
  // role ADMIN (if absent) and assigns that operator. Every ordinary config
  // route continues to require a fresh token carrying roles:[..., "ADMIN"].
  app.post('/api/v1/bootstrap/claim', { preHandler: requireLocal }, async (request, reply) =>
    serializeMutation(async () => {
      const runtime = await deps.store.getRuntime(['logto.managementAppSecret'])
      if (!runtime || runtime.values.auth.mode !== 'oidc' || !runtime.values.logto) {
        return problem(reply, 409, 'save OIDC and Logto Management API configuration before claiming ADMIN')
      }
      const claimedFor = deploymentAdminClaimKey(runtime.values, localAuthBootstrap.issuer)
      const admin = await deps.store.getAdmin()
      if (!claimedFor || admin?.revision !== runtime.revision) {
        return problem(reply, 409, 'deployment configuration changed while ADMIN was being claimed')
      }
      if (admin.adminClaimedFor === claimedFor) {
        return problem(reply, 409, 'ADMIN has already been claimed for this OIDC application', 'ADMIN_ALREADY_CLAIMED')
      }
      const managementSecret = runtime.secrets['logto.managementAppSecret']
      if (!managementSecret) {
        return problem(reply, 409, 'the Logto Management API secret is not configured')
      }

      let principal: TenantAdminPrincipal
      try {
        principal = await authenticator.authenticate(request.headers.authorization, false)
      } catch (error) {
        if (!(error instanceof TenantAdminAuthError)) throw error
        return authFailure(reply, error)
      }

      const logto = runtime.values.logto
      const claimClient =
        deps.makeLogtoClaimClient?.({
          endpoint: logtoEndpoint,
          appId: logto.managementAppId,
          appSecret: managementSecret,
          resource: logto.managementResource
        }) ??
        new LogtoAdminClaimClient({
          endpoint: logtoEndpoint,
          appId: logto.managementAppId,
          appSecret: managementSecret,
          resource: logto.managementResource
        })
      await claimClient.assignAdmin(principal.subject)
      await deps.store.markAdminClaimed(runtime.revision, claimedFor)
      return { claimed: true, reloginRequired: true }
    })
  )

  return app
}

/** Run the Tenant Admin HTTP server. */
export async function serveTenantAdmin(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadTenantAdminProcessConfig(env)
  const host = config.HOST
  const port = config.PORT
  const publicUrl = env.TENANT_ADMIN_URL ?? `http://localhost:${port}`
  const deploymentEnvironment = loadDeploymentEnvironment(env)
  if (!isLoopbackHostname(host) && !config.TENANT_ADMIN_ALLOW_CONTAINER_PROXY) {
    throw new Error('Tenant Admin may bind outside loopback only in the isolated Compose admin network')
  }
  const handle = openDeploymentConfigStore({
    databaseUrl: config.DATABASE_URL,
    SECRET_CIPHER: config.SECRET_CIPHER,
    VAULT_TRANSIT_KEY: config.VAULT_TRANSIT_KEY,
    VAULT_TRANSIT_MOUNT: config.VAULT_TRANSIT_MOUNT,
    VAULT_JWT_PATH: config.VAULT_JWT_PATH,
    VAULT_AUTH_MOUNT: config.VAULT_AUTH_MOUNT,
    ...(config.VAULT_ADDR ? { VAULT_ADDR: config.VAULT_ADDR } : {}),
    ...(config.VAULT_NAMESPACE ? { VAULT_NAMESPACE: config.VAULT_NAMESPACE } : {}),
    ...(config.VAULT_TOKEN ? { VAULT_TOKEN: config.VAULT_TOKEN } : {}),
    ...(config.VAULT_JWT_ROLE ? { VAULT_JWT_ROLE: config.VAULT_JWT_ROLE } : {})
  })
  const app = buildTenantAdminServer(
    {
      store: handle.store,
      publicUrl,
      allowContainerLoopbackProxy: config.TENANT_ADMIN_ALLOW_CONTAINER_PROXY,
      localAuthBootstrap: {
        issuer: deploymentEnvironment.issuer,
        adminEndpoint: config.LOGTO_ADMIN_ENDPOINT,
        services: deploymentEnvironment.services
      }
    },
    { logger: true }
  )
  try {
    await app.listen({ host, port })
    app.log.info(`Tenant Admin listening at ${publicUrl}`)
    await new Promise<void>((resolve) => {
      const stop = () => resolve()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  } finally {
    await app.close()
    await handle.close()
  }
}
