import { z } from 'zod'
import type { SetupConfig } from './config.js'

export type FindingStatus = 'pass' | 'fail'

export interface DeploymentFinding {
  id: string
  status: FindingStatus
  message: string
}

export interface CheckOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

const RuntimeBrowserAuthSchema = z
  .object({
    endpoint: z.string().url(),
    issuer: z.string().url(),
    appId: z.string().min(1),
    apiResource: z.string().url().nullable(),
    socialProviders: z.array(z.string().min(1))
  })
  .strict()

const RuntimeConfigSchema = z
  .object({
    schemaVersion: z.literal('1'),
    revision: z.number().int().positive().nullable(),
    config: z
      .object({
        apiUrl: z.string().url().nullable(),
        relayUrl: z.string().url().nullable(),
        webUrl: z.string().url().nullable(),
        mcpUrl: z.string().url().nullable(),
        auth: RuntimeBrowserAuthSchema.nullable()
      })
      .strict()
      .nullable()
  })
  .strict()
  .refine((value) => (value.revision === null) === (value.config === null))

type ActiveAuth = { mode: 'none' } | { mode: 'oidc'; issuer: string }
type ActiveServices = { controlPlane: string | null; relay: string | null; web: string | null }

type RuntimeInspection =
  | { source: 'database'; auth: ActiveAuth; services: ActiveServices; finding: DeploymentFinding }
  | { source: 'environment'; finding: DeploymentFinding }
  | { source: 'unavailable'; finding: DeploymentFinding }

const joinUrl = (base: string, path: string): string => {
  const prefix = base.endsWith('/') ? base : `${base}/`
  return new URL(path.replace(/^\//, ''), prefix).toString()
}

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/g, '')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  )
}

function controlPlaneBaseUrl(apiUrl: string): string | null {
  const parsed = new URL(apiUrl)
  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (!pathname.endsWith('/api/v1')) return null
  parsed.pathname = pathname.slice(0, -'/api/v1'.length) || '/'
  return parsed.toString()
}

function validateFinalUrl(requestedUrl: string, response: Response): void {
  if (!response.url) return
  const requested = new URL(requestedUrl)
  const final = new URL(response.url)
  if (requested.protocol === 'https:' && final.protocol !== 'https:') {
    throw new Error('HTTPS request redirected to a non-HTTPS URL')
  }
  if (!isLoopbackHostname(requested.hostname) && isLoopbackHostname(final.hostname)) {
    throw new Error('external request redirected to a loopback URL')
  }
}

async function request(
  fetcher: typeof fetch,
  url: string,
  timeoutMs: number,
  redirect: 'follow' | 'manual' = 'follow'
): Promise<Response> {
  const response = await fetcher(url, { redirect, signal: AbortSignal.timeout(timeoutMs) })
  validateFinalUrl(url, response)
  return response
}

async function checkHttp(
  fetcher: typeof fetch,
  timeoutMs: number,
  id: string,
  label: string,
  url: string
): Promise<DeploymentFinding> {
  try {
    const response = await request(fetcher, url, timeoutMs)
    if (!response.ok) return { id, status: 'fail', message: `${label} returned HTTP ${response.status}` }
    return { id, status: 'pass', message: `${label} is reachable` }
  } catch (error) {
    return { id, status: 'fail', message: `${label} is unreachable: ${(error as Error).message}` }
  }
}

async function checkReadiness(
  fetcher: typeof fetch,
  timeoutMs: number,
  id: string,
  label: string,
  url: string,
  expectedStatus: 'ok' | 'ready'
): Promise<DeploymentFinding> {
  try {
    const response = await request(fetcher, url, timeoutMs, 'manual')
    if (!response.ok) return { id, status: 'fail', message: `${label} returned HTTP ${response.status}` }
    const body = (await response.json()) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('status' in body)) {
      return { id, status: 'fail', message: `${label} returned an invalid readiness response` }
    }
    if (body.status !== expectedStatus) {
      return { id, status: 'fail', message: `${label} did not report ready` }
    }
    return { id, status: 'pass', message: `${label} is ready` }
  } catch (error) {
    return { id, status: 'fail', message: `${label} is unreachable: ${(error as Error).message}` }
  }
}

async function inspectRuntimeConfig(
  config: SetupConfig,
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<RuntimeInspection> {
  const url = joinUrl(config.services.controlPlane, 'api/v1/runtime-config')
  let response: Response
  try {
    response = await request(fetcher, url, timeoutMs, 'manual')
  } catch (error) {
    return {
      source: 'unavailable',
      finding: {
        id: 'control-plane.runtime-config',
        status: 'fail',
        message: `could not read active deployment configuration: ${(error as Error).message}`
      }
    }
  }
  if (!response.ok) {
    return {
      source: 'unavailable',
      finding: {
        id: 'control-plane.runtime-config',
        status: 'fail',
        message: `active deployment configuration returned HTTP ${response.status}`
      }
    }
  }

  let parsed: z.infer<typeof RuntimeConfigSchema>
  try {
    const result = RuntimeConfigSchema.safeParse(await response.json())
    if (!result.success) throw new Error('invalid runtime configuration')
    parsed = result.data
  } catch {
    return {
      source: 'unavailable',
      finding: {
        id: 'control-plane.runtime-config',
        status: 'fail',
        message: 'AgentConnect API returned an invalid active deployment configuration'
      }
    }
  }

  if (parsed.revision === null || parsed.config === null) {
    return {
      source: 'environment',
      finding: {
        id: 'control-plane.runtime-config',
        status: 'pass',
        message: 'AgentConnect API is using environment fallback (active deployment config revision: none)'
      }
    }
  }

  const auth: ActiveAuth = parsed.config.auth ? { mode: 'oidc', issuer: parsed.config.auth.issuer } : { mode: 'none' }
  return {
    source: 'database',
    auth,
    services: {
      controlPlane: parsed.config.apiUrl ? controlPlaneBaseUrl(parsed.config.apiUrl) : null,
      relay: parsed.config.relayUrl,
      web: parsed.config.webUrl
    },
    finding: {
      id: 'control-plane.runtime-config',
      status: 'pass',
      message: `AgentConnect API is running deployment config revision ${parsed.revision} with ${auth.mode === 'oidc' ? 'OIDC' : 'no-auth'} authentication`
    }
  }
}

async function checkAuthMode(
  expectAuth: boolean,
  controlPlaneUrl: string,
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<DeploymentFinding> {
  const url = joinUrl(controlPlaneUrl, 'api/v1/me')
  try {
    const response = await request(fetcher, url, timeoutMs, 'manual')
    if (expectAuth && response.status === 401) {
      return { id: 'auth.mode', status: 'pass', message: 'sign-in is required by the API' }
    }
    if (!expectAuth && response.ok) {
      return { id: 'auth.mode', status: 'pass', message: 'no-auth mode is active' }
    }
    return {
      id: 'auth.mode',
      status: 'fail',
      message: expectAuth
        ? `API did not require sign-in (HTTP ${response.status}); update active OIDC configuration and restart the Control Plane`
        : `no-auth mode did not admit the request (HTTP ${response.status})`
    }
  } catch (error) {
    return { id: 'auth.mode', status: 'fail', message: `could not verify sign-in mode: ${(error as Error).message}` }
  }
}

async function checkOidc(issuer: string, fetcher: typeof fetch, timeoutMs: number): Promise<DeploymentFinding[]> {
  const expectedIssuer = issuer.replace(/\/$/, '')
  const discoveryUrl = joinUrl(expectedIssuer, '.well-known/openid-configuration')
  let discovery: Response
  try {
    discovery = await request(fetcher, discoveryUrl, timeoutMs)
  } catch (error) {
    return [
      { id: 'oidc.discovery', status: 'fail', message: `OIDC discovery is unreachable: ${(error as Error).message}` }
    ]
  }
  if (!discovery.ok) {
    return [{ id: 'oidc.discovery', status: 'fail', message: `OIDC discovery returned HTTP ${discovery.status}` }]
  }

  let document: Record<string, unknown>
  try {
    const body = (await discovery.json()) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return [{ id: 'oidc.discovery', status: 'fail', message: 'OIDC discovery returned an invalid document' }]
    }
    document = body as Record<string, unknown>
  } catch {
    return [{ id: 'oidc.discovery', status: 'fail', message: 'OIDC discovery did not return JSON' }]
  }

  if (document.issuer !== expectedIssuer) {
    return [
      {
        id: 'oidc.discovery',
        status: 'fail',
        message: 'OIDC discovery issuer does not match the configured issuer'
      }
    ]
  }
  if (typeof document.jwks_uri !== 'string') {
    return [{ id: 'oidc.discovery', status: 'fail', message: 'OIDC discovery is missing jwks_uri' }]
  }
  try {
    const issuerUrl = new URL(expectedIssuer)
    const jwksUrl = new URL(document.jwks_uri)
    if (jwksUrl.protocol !== 'http:' && jwksUrl.protocol !== 'https:') throw new Error()
    if (issuerUrl.protocol === 'https:' && jwksUrl.protocol !== 'https:') throw new Error()
    if (!isLoopbackHostname(issuerUrl.hostname) && isLoopbackHostname(jwksUrl.hostname)) throw new Error()
  } catch {
    return [{ id: 'oidc.discovery', status: 'fail', message: 'OIDC discovery returned an unsafe jwks_uri' }]
  }

  const findings: DeploymentFinding[] = [
    { id: 'oidc.discovery', status: 'pass', message: 'OIDC discovery matches the configured issuer' }
  ]
  try {
    const response = await request(fetcher, document.jwks_uri, timeoutMs)
    if (!response.ok) {
      findings.push({ id: 'oidc.jwks', status: 'fail', message: `OIDC keys returned HTTP ${response.status}` })
      return findings
    }
    const body = (await response.json()) as unknown
    const keys = body && typeof body === 'object' && !Array.isArray(body) && 'keys' in body ? body.keys : undefined
    findings.push(
      Array.isArray(keys) && keys.length > 0
        ? { id: 'oidc.jwks', status: 'pass', message: 'OIDC signing keys are available' }
        : { id: 'oidc.jwks', status: 'fail', message: 'OIDC key set is empty' }
    )
  } catch (error) {
    findings.push({
      id: 'oidc.jwks',
      status: 'fail',
      message: `OIDC keys are unreachable: ${(error as Error).message}`
    })
  }
  return findings
}

export async function checkDeployment(config: SetupConfig, options: CheckOptions = {}): Promise<DeploymentFinding[]> {
  const fetcher = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  const runtime = await inspectRuntimeConfig(config, fetcher, timeoutMs)
  const activeAuth: ActiveAuth | undefined =
    runtime.source === 'database'
      ? runtime.auth
      : runtime.source === 'environment'
        ? config.mode === 'local'
          ? { mode: 'none' }
          : config.auth
            ? { mode: 'oidc', issuer: config.auth.issuer }
            : { mode: 'none' }
        : undefined
  const activeServices: ActiveServices | undefined =
    runtime.source === 'database'
      ? runtime.services
      : runtime.source === 'environment'
        ? {
            controlPlane: config.services.controlPlane,
            relay: config.services.relay ?? null,
            web: config.services.web ?? null
          }
        : undefined

  const unavailableService = (id: string, label: string): Promise<DeploymentFinding> =>
    Promise.resolve({ id, status: 'fail', message: `${label} URL is not configured in the active deployment` })
  const serviceChecks = [
    activeServices?.web
      ? checkHttp(fetcher, timeoutMs, 'web.reachable', 'Web console', activeServices.web)
      : unavailableService('web.reachable', 'Web console'),
    activeServices?.controlPlane
      ? checkReadiness(
          fetcher,
          timeoutMs,
          'control-plane.ready',
          'AgentConnect API',
          joinUrl(activeServices.controlPlane, 'readyz'),
          'ok'
        )
      : unavailableService('control-plane.ready', 'AgentConnect API'),
    ...(activeServices?.relay
      ? [
          checkReadiness(
            fetcher,
            timeoutMs,
            'relay.ready',
            'callback service',
            joinUrl(activeServices.relay, 'readyz'),
            'ready'
          )
        ]
      : []),
    activeAuth && activeServices?.controlPlane
      ? checkAuthMode(activeAuth.mode === 'oidc', activeServices.controlPlane, fetcher, timeoutMs)
      : Promise.resolve<DeploymentFinding>({
          id: 'auth.mode',
          status: 'fail',
          message: 'could not verify active sign-in mode without an active AgentConnect API URL'
        })
  ]

  const findings = [runtime.finding, ...(await Promise.all(serviceChecks))]
  if (activeAuth?.mode === 'oidc') findings.push(...(await checkOidc(activeAuth.issuer, fetcher, timeoutMs)))
  return findings
}
