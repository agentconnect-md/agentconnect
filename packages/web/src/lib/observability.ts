import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, WebTracerProvider, type PropagateTraceHeaderCorsUrls } from '@opentelemetry/sdk-trace-web'
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION
} from '@opentelemetry/semantic-conventions'
import { ZoneContextManager } from '@opentelemetry/context-zone'

declare global {
  interface Window {
    __AC_ENV?: Record<string, string>
  }
}

interface BrowserOtelConfig {
  tracesEndpoint: string
  resourceAttributes: Record<string, string>
  propagateTraceHeaderCorsUrls: PropagateTraceHeaderCorsUrls
}

let started = false
let provider: WebTracerProvider | undefined

export function startBrowserOpenTelemetry(): void {
  if (started || typeof window === 'undefined') return

  const config = readConfig()
  if (!config) return

  started = true

  try {
    const exporter = new OTLPTraceExporter({ url: config.tracesEndpoint })
    provider = new WebTracerProvider({
      resource: resourceFromAttributes(config.resourceAttributes),
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          scheduledDelayMillis: 3000
        })
      ]
    })

    provider.register({
      contextManager: new ZoneContextManager(),
      propagator: new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()]
      })
    })

    registerInstrumentations({
      instrumentations: [
        new FetchInstrumentation({
          clearTimingResources: true,
          ignoreUrls: [config.tracesEndpoint],
          propagateTraceHeaderCorsUrls: config.propagateTraceHeaderCorsUrls
        })
      ]
    })

    window.addEventListener('pagehide', () => {
      void provider?.forceFlush().catch(() => {})
    })
  } catch (err) {
    started = false
    console.warn(`web opentelemetry failed to start: ${(err as Error).message}`)
  }
}

function readConfig(): BrowserOtelConfig | undefined {
  const env = readRuntimeEnv()
  if (disabled(env.OTEL_WEB_ENABLED)) return undefined

  const tracesEndpoint = env.OTEL_WEB_TRACES_ENDPOINT?.trim()
  if (!tracesEndpoint) return undefined

  const serviceName = env.OTEL_WEB_SERVICE_NAME?.trim() || 'agentconnect-web'
  const resourceAttributes = {
    [ATTR_SERVICE_NAMESPACE]: 'agentconnect.md',
    [ATTR_SERVICE_NAME]: serviceName,
    ...(process.env.NEXT_PUBLIC_APP_VERSION ? { [ATTR_SERVICE_VERSION]: process.env.NEXT_PUBLIC_APP_VERSION } : {}),
    ...(env.OTEL_WEB_DEPLOYMENT_ENVIRONMENT
      ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.OTEL_WEB_DEPLOYMENT_ENVIRONMENT }
      : {}),
    ...parseResourceAttributes(env.OTEL_WEB_RESOURCE_ATTRIBUTES)
  }

  return {
    tracesEndpoint,
    resourceAttributes,
    propagateTraceHeaderCorsUrls: readPropagationTargets(env)
  }
}

function readRuntimeEnv(): Record<string, string> {
  const runtime = window.__AC_ENV ?? {}
  const fallback = {
    OTEL_WEB_ENABLED: process.env.NEXT_PUBLIC_OTEL_WEB_ENABLED,
    OTEL_WEB_TRACES_ENDPOINT: process.env.NEXT_PUBLIC_OTEL_WEB_TRACES_ENDPOINT,
    OTEL_WEB_SERVICE_NAME: process.env.NEXT_PUBLIC_OTEL_WEB_SERVICE_NAME,
    OTEL_WEB_DEPLOYMENT_ENVIRONMENT: process.env.NEXT_PUBLIC_OTEL_WEB_DEPLOYMENT_ENVIRONMENT,
    OTEL_WEB_RESOURCE_ATTRIBUTES: process.env.NEXT_PUBLIC_OTEL_WEB_RESOURCE_ATTRIBUTES,
    OTEL_WEB_PROPAGATE_TRACE_HEADER_URLS: process.env.NEXT_PUBLIC_OTEL_WEB_PROPAGATE_TRACE_HEADER_URLS,
    CP_URL: process.env.NEXT_PUBLIC_CP_URL
  }
  const read = (key: keyof typeof fallback) => runtime[key] || fallback[key] || ''
  return {
    OTEL_WEB_ENABLED: read('OTEL_WEB_ENABLED'),
    OTEL_WEB_TRACES_ENDPOINT: read('OTEL_WEB_TRACES_ENDPOINT'),
    OTEL_WEB_SERVICE_NAME: read('OTEL_WEB_SERVICE_NAME'),
    OTEL_WEB_DEPLOYMENT_ENVIRONMENT: read('OTEL_WEB_DEPLOYMENT_ENVIRONMENT'),
    OTEL_WEB_RESOURCE_ATTRIBUTES: read('OTEL_WEB_RESOURCE_ATTRIBUTES'),
    OTEL_WEB_PROPAGATE_TRACE_HEADER_URLS: read('OTEL_WEB_PROPAGATE_TRACE_HEADER_URLS'),
    CP_URL: read('CP_URL')
  }
}

function readPropagationTargets(env: Record<string, string>): PropagateTraceHeaderCorsUrls {
  const configured = parseList(env.OTEL_WEB_PROPAGATE_TRACE_HEADER_URLS).map(urlPrefixPattern)
  if (configured.length > 0) return configured

  const defaults = [urlPrefixPattern(window.location.origin)]
  const cpOrigin = originFromUrl(env.CP_URL)
  if (cpOrigin && cpOrigin !== window.location.origin) defaults.push(urlPrefixPattern(cpOrigin))
  return defaults
}

function parseResourceAttributes(value: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const pair of parseList(value)) {
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const key = pair.slice(0, index).trim()
    const attrValue = pair.slice(index + 1).trim()
    if (key && attrValue) attrs[key] = attrValue
  }
  return attrs
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function originFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value, window.location.origin).origin
  } catch {
    return undefined
  }
}

function urlPrefixPattern(value: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}`)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function disabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value?.trim() ?? '')
}
