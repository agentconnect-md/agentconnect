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

export interface Mem0OpenTelemetryHandle {
  enabled: boolean
  shutdown(): Promise<void>
}

const noopTelemetry: Mem0OpenTelemetryHandle = { enabled: false, shutdown: async () => {} }

/** Opt-in OTLP bootstrap. No request/response bodies or credential headers are
 * configured as span attributes. */
export function startMem0OpenTelemetry(env: NodeJS.ProcessEnv = process.env): Mem0OpenTelemetryHandle {
  if (!shouldStart(env)) return noopTelemetry
  const serviceName = env.OTEL_SERVICE_NAME || 'agentconnect-memory-mem0'
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAMESPACE]: 'agentconnect.md',
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: '1.0.0',
      ...(env.NODE_ENV ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.NODE_ENV } : {})
    }),
    serviceName,
    logRecordProcessors: [],
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()]
  })
  try {
    sdk.start()
  } catch {
    console.error('agentconnect-memory-mem0: opentelemetry failed to start')
    return noopTelemetry
  }
  return { enabled: true, shutdown: () => sdk.shutdown() }
}

function shouldStart(env: NodeJS.ProcessEnv): boolean {
  if (/^(1|true|yes)$/i.test(env.OTEL_SDK_DISABLED?.trim() ?? '')) return false
  if (env.OTEL_EXPERIMENTAL_CONFIG_FILE?.trim()) return true
  if (
    [
      env.OTEL_EXPORTER_OTLP_ENDPOINT,
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    ].some((value) => Boolean(value?.trim()))
  ) {
    return true
  }
  return [env.OTEL_TRACES_EXPORTER, env.OTEL_METRICS_EXPORTER].some((value) =>
    value
      ?.split(',')
      .map((part) => part.trim().toLowerCase())
      .some((part) => part !== '' && part !== 'none' && part !== 'null')
  )
}
