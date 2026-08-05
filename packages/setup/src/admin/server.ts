import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions
} from 'fastify'
import { z } from 'zod'
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
  type DeploymentConfigStore
} from '@agentconnect.md/control-plane/deployment-config-store'
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

function oidcOf(record: DeploymentConfigAdmin | null): AdminOidcConfig | null {
  const auth = record?.values.auth
  // Logto emits the `roles` scope into the ID token. Tenant Admin therefore
  // validates that token against the browser application's client id. The CP
  // continues to validate API access tokens against auth.audience separately.
  return auth?.mode === 'oidc' ? { issuer: auth.issuer, audience: auth.browserClient.appId } : null
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

function logtoConfig(record: DeploymentConfigRuntime | null): LogtoManagementConfig | null {
  if (!record || !record.values.logto) return null
  const secret = record.secrets['logto.managementAppSecret']
  if (!secret) return null
  return {
    endpoint: record.values.logto.managementEndpoint,
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

function logtoSetup(record: DeploymentConfigRuntime, tenantAdminUrl: string): ResolvedLogtoSetup | null {
  const { auth, logto, publicUrls } = record.values
  if (!logto || !publicUrls.web) return null
  const browser =
    logto.browser ??
    (auth.mode === 'oidc'
      ? {
          endpoint: auth.browserClient.endpoint,
          applicationName: 'AgentConnect',
          apiResource: auth.browserClient.apiResource,
          socialProviders: auth.socialProviders
        }
      : null)
  if (!browser) return null

  const githubSecret = record.secrets['logto.githubConnectorClientSecret']
  const applicationId =
    auth.mode === 'oidc' && auth.browserClient.endpoint === browser.endpoint ? auth.browserClient.appId : undefined
  const webOrigin = new URL(publicUrls.web).origin
  const adminOrigin = new URL(tenantAdminUrl).origin
  return {
    endpoint: browser.endpoint,
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
    { get: async () => oidcOf(await deps.store.getAdmin()) },
    deps.verifyOidcToken
  )
  const discovery = new Map<string, Promise<OidcDiscovery>>()
  let mutationTail: Promise<void> = Promise.resolve()

  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation)
    mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

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
    const claimedFor = current ? deploymentAdminClaimKey(current.values) : null
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
    if (!auth || auth.mode === 'none') return { mode: 'none' as const }
    const claimedFor = deploymentAdminClaimKey(current.values)
    try {
      const endpoints = await discover(auth.issuer)
      return {
        mode: 'oidc' as const,
        claimAvailable: claimedFor !== null && current.adminClaimedFor !== claimedFor,
        endpoint: auth.browserClient.endpoint,
        appId: auth.browserClient.appId,
        resource: auth.browserClient.apiResource,
        redirectUri: new URL('/auth/callback', deps.publicUrl).toString(),
        ...endpoints
      }
    } catch (error) {
      return problem(reply, 502, error instanceof Error ? error.message : 'OIDC discovery failed')
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
    const saved = await deps.store.replace(parsed.data)
    return {
      ...toStatus(saved),
      restartRequired: true as const
    }
  })

  app.post('/api/v1/reconcile/logto', { preHandler: requireConfigurationAccess }, async (_request, reply) =>
    serializeMutation(async () => {
      const runtime = await deps.store.getRuntime(['logto.managementAppSecret', 'logto.githubConnectorClientSecret'])
      const config = logtoConfig(runtime)
      if (!runtime || !config) {
        return problem(reply, 409, 'save the Logto Management API configuration before creating Logto resources')
      }
      const setup = logtoSetup(runtime, deps.publicUrl)
      if (!setup) {
        return problem(reply, 409, 'save Logto browser desired state before creating Logto resources')
      }

      const client = deps.makeLogtoSetupClient?.(config) ?? new LogtoAdminClaimClient(config)
      const reconciled = await client.reconcileSetup(setup.desired)
      const auth = {
        mode: 'oidc' as const,
        issuer: appendPath(setup.endpoint, '/oidc'),
        audience: setup.apiResource ?? reconciled.application.id,
        browserClient: {
          endpoint: setup.endpoint,
          appId: reconciled.application.id,
          apiResource: setup.apiResource
        },
        socialProviders: setup.socialProviders
      }
      const configChanged = JSON.stringify(runtime.values.auth) !== JSON.stringify(auth)
      const saved = configChanged
        ? await deps.store.replace({
            expectedRevision: runtime.revision,
            values: { ...runtime.values, auth }
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
    const runtime = await deps.store.getRuntime(['logto.managementAppSecret'])

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
    const config = logtoConfig(runtime)!
    const client = deps.makeLogtoCheckClient?.(config) ?? new LogtoAdminClaimClient(config)
    const setup = logtoSetup(runtime, deps.publicUrl)

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
              : 'The exact global User role ADMIN does not exist; claim it from the local Tenant Admin UI.'
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
    const missingConnectors = setupInspection.connectors
      .filter((connector) => !connector.exists)
      .map((connector) => connector.target)
    findings.push(
      missingConnectors.length === 0
        ? {
            id: 'logto.connectors',
            status: 'pass',
            message: 'All configured Logto social connectors exist.'
          }
        : {
            id: 'logto.connectors',
            status: 'fail',
            message: `Missing Logto social connectors: ${missingConnectors.join(', ')}.`
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

  // Local-only ADMIN self-claim. It verifies a real OIDC identity without the
  // role, then the Management API creates the exact global User role ADMIN (if
  // absent) and assigns the current operator. Every ordinary config route
  // continues to require a fresh token carrying roles:[..., "ADMIN"].
  app.post('/api/v1/bootstrap/claim', { preHandler: requireLocal }, async (request, reply) =>
    serializeMutation(async () => {
      const runtime = await deps.store.getRuntime(['logto.managementAppSecret'])
      if (!runtime || runtime.values.auth.mode !== 'oidc' || !runtime.values.logto) {
        return problem(reply, 409, 'save OIDC and Logto Management API configuration before claiming ADMIN')
      }
      const claimedFor = deploymentAdminClaimKey(runtime.values)
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
          endpoint: logto.managementEndpoint,
          appId: logto.managementAppId,
          appSecret: managementSecret,
          resource: logto.managementResource
        }) ??
        new LogtoAdminClaimClient({
          endpoint: logto.managementEndpoint,
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

export interface ServeTenantAdminOptions {
  host?: string
  port?: number
}

/** Long-running `agentconnect-setup serve` action; CLI wiring lives in index.ts. */
export async function serveTenantAdmin(
  options: ServeTenantAdminOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = loadTenantAdminProcessConfig(env)
  const host = options.host ?? config.HOST
  const port = options.port ?? config.PORT
  const publicUrl = env.TENANT_ADMIN_URL ?? `http://localhost:${port}`
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
    { store: handle.store, publicUrl, allowContainerLoopbackProxy: config.TENANT_ADMIN_ALLOW_CONTAINER_PROXY },
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
