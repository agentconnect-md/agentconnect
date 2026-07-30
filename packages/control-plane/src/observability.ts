import { readFileSync } from 'node:fs'
import { FastifyOtelInstrumentation } from '@fastify/otel'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { UndiciInstrumentation, type UndiciRequest } from '@opentelemetry/instrumentation-undici'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION
} from '@opentelemetry/semantic-conventions'

export interface OpenTelemetryHandle {
  enabled: boolean
  shutdown(): Promise<void>
}

const noopTelemetry: OpenTelemetryHandle = {
  enabled: false,
  shutdown: async () => {}
}

/** Telegram puts BotFather tokens in Bot API URL paths. Drop those requests
 * before Undici instrumentation creates a span so neither url.full nor
 * url.path can export the credential. */
export function shouldIgnoreUndiciRequest(request: Pick<UndiciRequest, 'origin' | 'path'>): boolean {
  try {
    const url = new URL(request.path, request.origin)
    return url.protocol === 'https:' && url.hostname === 'api.telegram.org' && url.pathname.startsWith('/bot')
  } catch {
    return false
  }
}

const fastifyInstrumentation = new FastifyOtelInstrumentation({
  ignorePaths: ({ url }: { url: string }) => url === '/health' || url === '/livez' || url === '/readyz'
})

let fastifyPluginEnabled = false

export function controlPlaneOtelFastifyPlugin(): ReturnType<typeof fastifyInstrumentation.plugin> | undefined {
  return fastifyPluginEnabled ? fastifyInstrumentation.plugin() : undefined
}

export function startControlPlaneOpenTelemetry(env: NodeJS.ProcessEnv = process.env): OpenTelemetryHandle {
  if (!shouldStartOpenTelemetry(env)) return noopTelemetry

  const serviceVersion = readPackageVersion()
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAMESPACE]: 'agentconnect.md',
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || 'agentconnect-control-plane',
      ...(serviceVersion ? { [ATTR_SERVICE_VERSION]: serviceVersion } : {}),
      ...(env.NODE_ENV ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.NODE_ENV } : {})
    }),
    serviceName: env.OTEL_SERVICE_NAME || 'agentconnect-control-plane',
    logRecordProcessors: [],
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation({ ignoreRequestHook: shouldIgnoreUndiciRequest }),
      fastifyInstrumentation
    ]
  })

  try {
    sdk.start()
    fastifyPluginEnabled = true
  } catch (err) {
    console.error(`control-plane opentelemetry failed to start: ${(err as Error).message}`)
    return noopTelemetry
  }

  return {
    enabled: true,
    shutdown: () => sdk.shutdown()
  }
}

function shouldStartOpenTelemetry(env: NodeJS.ProcessEnv): boolean {
  if (truthy(env.OTEL_SDK_DISABLED)) return false
  if (nonEmpty(env.OTEL_EXPERIMENTAL_CONFIG_FILE)) return true
  if (
    [
      env.OTEL_EXPORTER_OTLP_ENDPOINT,
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    ].some(nonEmpty)
  )
    return true
  return [env.OTEL_TRACES_EXPORTER, env.OTEL_METRICS_EXPORTER].some(exporterEnabled)
}

function exporterEnabled(value: string | undefined): boolean {
  if (!value) return false
  return value.split(',').some((part) => {
    const v = part.trim().toLowerCase()
    return v !== '' && v !== 'none' && v !== 'null'
  })
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value?.trim() ?? '')
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim())
}

function readPackageVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}
