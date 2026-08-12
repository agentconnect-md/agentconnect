import { z } from 'zod'

type Environment = Readonly<Record<string, string | undefined>>

const LOCAL_HOST = 'localhost'

function isLoopback(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
}

function originSchema(allowInternalHttp = false) {
  return z
    .string()
    .url()
    .superRefine((value, ctx) => {
      const url = new URL(value)
      const httpAllowed = url.protocol === 'http:' && (allowInternalHttp || isLoopback(url.hostname))
      if (url.protocol !== 'https:' && !httpAllowed) {
        ctx.addIssue({
          code: 'custom',
          message: allowInternalHttp ? 'must use HTTP or HTTPS' : 'must use HTTPS unless it is loopback'
        })
      }
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        ctx.addIssue({ code: 'custom', message: 'must be an origin without credentials, path, query, or fragment' })
      }
    })
}

function serviceBaseUrlSchema() {
  return z
    .string()
    .url()
    .superRefine((value, ctx) => {
      const url = new URL(value)
      const httpAllowed = url.protocol === 'http:' && isLoopback(url.hostname)
      if (url.protocol !== 'https:' && !httpAllowed) {
        ctx.addIssue({ code: 'custom', message: 'must use HTTPS unless it is loopback' })
      }
      if (url.username || url.password || url.search || url.hash) {
        ctx.addIssue({ code: 'custom', message: 'must not contain credentials, query, or fragment' })
      }
    })
    .transform((value) => {
      const url = new URL(value)
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
    })
}

const OriginSchema = originSchema()
const ServerOriginSchema = originSchema(true)
const ServiceBaseUrlSchema = serviceBaseUrlSchema()

const IssuerSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
      ctx.addIssue({ code: 'custom', message: 'must use HTTPS unless it is loopback' })
    }
    if (url.username || url.password || url.search || url.hash) {
      ctx.addIssue({ code: 'custom', message: 'must not contain credentials, query, or fragment' })
    }
    if (!url.pathname.replace(/\/$/, '').endsWith('/oidc')) {
      ctx.addIssue({ code: 'custom', message: 'must end in /oidc' })
    }
  })

function environmentValue(environment: Environment, key: string): string | undefined {
  return environment[key]?.trim() || undefined
}

function localPort(environment: Environment, key: string, fallback: number): number {
  const raw = environmentValue(environment, key)
  if (!raw) return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${key} must be an integer from 1 to 65535`)
  return port
}

function serviceUrl(
  environment: Environment,
  publicUrlKey: string,
  portKey: string,
  defaultHost: string,
  defaultPort: number
): string {
  return (
    environmentValue(environment, publicUrlKey) ??
    `http://${defaultHost}:${localPort(environment, portKey, defaultPort)}`
  )
}

export interface DeploymentEnvironment {
  services: {
    web: string
    controlPlane: string
    relay: string
  }
  issuer: string
  managementEndpoint: string
}

export function loadDeploymentEnvironment(environment: Environment = process.env): DeploymentEnvironment {
  const logtoEndpoint = environmentValue(environment, 'LOGTO_ENDPOINT')
  const logtoOrigin = logtoEndpoint ? new URL(OriginSchema.parse(logtoEndpoint)).origin : undefined
  const defaultLogtoOrigin = 'http://localhost:3001'
  return {
    services: {
      web: OriginSchema.parse(
        serviceUrl(environment, 'AGENTCONNECT_PUBLIC_WEB_URL', 'AGENTCONNECT_WEB_PORT', LOCAL_HOST, 3000)
      ),
      controlPlane: ServiceBaseUrlSchema.parse(
        serviceUrl(environment, 'AGENTCONNECT_PUBLIC_CP_URL', 'AGENTCONNECT_CP_PORT', LOCAL_HOST, 8080)
      ),
      relay: ServiceBaseUrlSchema.parse(
        serviceUrl(environment, 'AGENTCONNECT_PUBLIC_RELAY_URL', 'AGENTCONNECT_RELAY_PORT', LOCAL_HOST, 8090)
      )
    },
    issuer: IssuerSchema.parse(
      environmentValue(environment, 'OIDC_ISSUER') ?? `${logtoOrigin ?? defaultLogtoOrigin}/oidc`
    ),
    managementEndpoint: ServerOriginSchema.parse(
      environmentValue(environment, 'LOGTO_MGMT_ENDPOINT') ?? logtoOrigin ?? defaultLogtoOrigin
    )
  }
}
