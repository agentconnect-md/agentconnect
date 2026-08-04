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

async function checkAuthMode(
  config: SetupConfig,
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<DeploymentFinding> {
  const expectAuth = config.mode !== 'local'
  const url = joinUrl(config.services.controlPlane, 'api/v1/me')
  try {
    const response = await request(fetcher, url, timeoutMs, 'manual')
    if (expectAuth && response.status === 401) {
      return { id: 'auth.mode', status: 'pass', message: 'sign-in is required by the API' }
    }
    if (!expectAuth && response.ok) {
      return { id: 'auth.mode', status: 'pass', message: 'local no-auth mode is active' }
    }
    return {
      id: 'auth.mode',
      status: 'fail',
      message: expectAuth
        ? `API did not require sign-in (HTTP ${response.status}); set OIDC_ISSUER and restart it`
        : `local no-auth mode did not admit the request (HTTP ${response.status})`
    }
  } catch (error) {
    return { id: 'auth.mode', status: 'fail', message: `could not verify sign-in mode: ${(error as Error).message}` }
  }
}

async function checkOidc(issuer: string, fetcher: typeof fetch, timeoutMs: number): Promise<DeploymentFinding[]> {
  const discoveryUrl = joinUrl(issuer, '.well-known/openid-configuration')
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

  if (document.issuer !== issuer) {
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
    const issuerUrl = new URL(issuer)
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
  const serviceChecks = [
    checkHttp(fetcher, timeoutMs, 'web.reachable', 'Web console', config.services.web),
    checkReadiness(
      fetcher,
      timeoutMs,
      'control-plane.ready',
      'AgentConnect API',
      joinUrl(config.services.controlPlane, 'readyz'),
      'ok'
    ),
    ...(config.services.relay
      ? [
          checkReadiness(
            fetcher,
            timeoutMs,
            'relay.ready',
            'callback service',
            joinUrl(config.services.relay, 'readyz'),
            'ready'
          )
        ]
      : []),
    checkAuthMode(config, fetcher, timeoutMs)
  ]

  const findings = await Promise.all(serviceChecks)
  if (config.mode !== 'local') findings.push(...(await checkOidc(config.auth.issuer, fetcher, timeoutMs)))
  return findings
}
