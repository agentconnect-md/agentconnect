import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
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

export interface DaemonOpenTelemetryOptions {
  serviceVersion?: string
  env?: NodeJS.ProcessEnv
}

const noopTelemetry: OpenTelemetryHandle = {
  enabled: false,
  shutdown: async () => {}
}

let activeTelemetry: OpenTelemetryHandle | undefined

export function startDaemonOpenTelemetry(opts: DaemonOpenTelemetryOptions = {}): OpenTelemetryHandle {
  if (activeTelemetry) return activeTelemetry
  const env = opts.env ?? process.env
  if (!shouldStartOpenTelemetry(env)) return noopTelemetry

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAMESPACE]: 'agentconnect.md',
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || 'agentconnect-daemon',
      ...(opts.serviceVersion ? { [ATTR_SERVICE_VERSION]: opts.serviceVersion } : {}),
      ...(env.NODE_ENV ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.NODE_ENV } : {})
    }),
    serviceName: env.OTEL_SERVICE_NAME || 'agentconnect-daemon',
    logRecordProcessors: [],
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation({ ignoreRequestHook: ignoreSensitiveUndiciRequest })
    ]
  })

  try {
    sdk.start()
  } catch (err) {
    console.error(`agentconnect: opentelemetry failed to start: ${(err as Error).message}`)
    return noopTelemetry
  }

  let shutdown: Promise<void> | undefined
  activeTelemetry = {
    enabled: true,
    shutdown: () => (shutdown ??= sdk.shutdown())
  }
  return activeTelemetry
}

/** GitHub private archive redirects carry a short-lived capability in the
 * codeload query string. Undici's default semantic attributes export both
 * url.full and url.query, so suppress this exact host at instrumentation time;
 * application-level log redaction is too late. */
export function ignoreSensitiveUndiciRequest(request: { origin?: string; path?: string }): boolean {
  try {
    const url = new URL(request.path ?? '', request.origin)
    return url.protocol === 'https:' && url.hostname.toLowerCase().replace(/\.+$/, '') === 'codeload.github.com'
  } catch {
    return false
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
