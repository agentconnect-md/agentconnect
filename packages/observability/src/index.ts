/**
 * The Node services' shared OpenTelemetry bootstrap.
 *
 * The control plane and the relay had byte-for-byte copies of this — the SDK
 * wiring, the enable/disable predicate, and the two functions that keep
 * credentials out of span names. The copies were made deliberately (six lines
 * of Telegram guard did not justify a package) and then the relay grew an
 * outbound HTTP call, which turned the duplication into ~90 identical lines
 * including the URL-hygiene heuristics. Those are the ones that must not drift:
 * a fix to redaction in one copy would silently not reach the other, and the
 * failure mode is a credential in an exported, retained span name.
 *
 * What stays with each service is what genuinely differs — its name, its
 * version, and any instrumentation only it has (Prisma, for the control plane).
 */
import { FastifyOtelInstrumentation } from '@fastify/otel'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { UndiciInstrumentation, type UndiciRequest } from '@opentelemetry/instrumentation-undici'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import type { Instrumentation } from '@opentelemetry/instrumentation'
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

/** Anything that does not read like a hand-written route word collapses to this. */
const PATH_SEGMENT_PLACEHOLDER = '{id}'

/** A route word starts with a letter — or a dot, for `.well-known` — and uses
 * only plain URL punctuation. */
const ROUTE_WORD = /^[A-Za-z.][A-Za-z0-9._-]*$/
/** Hex digests: SHA/MD5 sums and unhyphenated UUIDs, which carry no digit run. */
const HEX_DIGEST = /^[0-9a-fA-F]{16,}$/
/** Bot ids, snowflakes, and other numeric keys embedded in a longer segment. */
const LONG_DIGIT_RUN = /\d{4,}/
const MAX_ROUTE_WORD_LENGTH = 32
/** Above this length, letters mixed with digits mean an opaque key, not a word. */
const OPAQUE_SEGMENT_LENGTH = 16

function normalizeSpanNameSegment(segment: string): string {
  if (!ROUTE_WORD.test(segment)) return PATH_SEGMENT_PLACEHOLDER
  if (segment.length > MAX_ROUTE_WORD_LENGTH) return PATH_SEGMENT_PLACEHOLDER
  if (HEX_DIGEST.test(segment)) return PATH_SEGMENT_PLACEHOLDER
  if (LONG_DIGIT_RUN.test(segment)) return PATH_SEGMENT_PLACEHOLDER
  if (segment.length >= OPAQUE_SEGMENT_LENGTH && /\d/.test(segment)) return PATH_SEGMENT_PLACEHOLDER
  return segment
}

/** Undici names every client span after the bare HTTP method, so a request that
 * fans out to GitHub, Slack, Feishu, and Logto renders as four identical `GET`
 * bars. Add the destination — `GET api.example.test/repositories/{id}` — so a
 * waterfall is readable without expanding each span's attributes.
 *
 * Span names are exported and retained, so the name is rebuilt from vetted
 * pieces rather than interpolated raw:
 *
 * - the query string is never included (providers pass tokens there);
 * - every path segment that is not a plain route word — numeric ids, UUIDs, hex
 *   digests, bearer-ish blobs — collapses to `{id}`, which keeps credentials out
 *   of the name (`shouldIgnoreUndiciRequest` already drops the known Telegram
 *   case; this is the second line of defence) and bounds name cardinality.
 */
export function undiciClientSpanName(request: Pick<UndiciRequest, 'origin' | 'path' | 'method'>): string | undefined {
  let url: URL
  try {
    url = new URL(request.path, request.origin)
  } catch {
    return undefined
  }
  const route = url.pathname
    .split('/')
    .map((segment) => (segment === '' ? segment : normalizeSpanNameSegment(segment)))
    .join('/')
  // `HTTP` matches what the instrumentation itself falls back to for a method
  // outside the semantic-convention set.
  const method = request.method?.toUpperCase() ?? ''
  return `${/^[A-Z]{3,10}$/.test(method) ? method : 'HTTP'} ${url.host}${route}`
}

const fastifyInstrumentation = new FastifyOtelInstrumentation({
  ignorePaths: ({ url }: { url: string }) => url === '/health' || url === '/livez' || url === '/readyz'
})

let fastifyPluginEnabled = false

/** The route-span plugin, or undefined when the SDK never started — so a
 *  service builds the same server whether or not telemetry is configured. */
export function otelFastifyPlugin(): ReturnType<typeof fastifyInstrumentation.plugin> | undefined {
  return fastifyPluginEnabled ? fastifyInstrumentation.plugin() : undefined
}

export interface StartOpenTelemetryOptions {
  /** One name per service across every environment. Environments are told apart
   *  by the `k8s.*` attributes the collector adds, and the dashboards key on
   *  those — a per-environment service name would split one service into three. */
  serviceName: string
  /** The service's own package version. Read by the caller: resolving it here
   *  would report this package's version instead. */
  serviceVersion?: string | undefined
  env?: NodeJS.ProcessEnv
  /** Instrumentation only this service has — Prisma, for the control plane. */
  extraInstrumentations?: readonly Instrumentation[]
}

export function startOpenTelemetry({
  serviceName,
  serviceVersion,
  env = process.env,
  extraInstrumentations = []
}: StartOpenTelemetryOptions): OpenTelemetryHandle {
  if (!shouldStartOpenTelemetry(env)) return noopTelemetry

  const resolvedName = env.OTEL_SERVICE_NAME || serviceName
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAMESPACE]: 'agentconnect.md',
      [ATTR_SERVICE_NAME]: resolvedName,
      ...(serviceVersion ? { [ATTR_SERVICE_VERSION]: serviceVersion } : {}),
      ...(env.NODE_ENV ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.NODE_ENV } : {})
    }),
    serviceName: resolvedName,
    logRecordProcessors: [],
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation({
        ignoreRequestHook: shouldIgnoreUndiciRequest,
        requestHook: (span, request) => {
          const name = undiciClientSpanName(request)
          if (name) span.updateName(name)
        }
      }),
      ...extraInstrumentations,
      fastifyInstrumentation
    ]
  })

  try {
    sdk.start()
    fastifyPluginEnabled = true
  } catch (err) {
    console.error(`${serviceName} opentelemetry failed to start: ${(err as Error).message}`)
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
