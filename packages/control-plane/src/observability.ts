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
import { PrismaInstrumentation } from '@prisma/instrumentation'

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

/** Prisma emits `operation`, `serialize`, and `db_query` per call, plus `compile`
 * the first time it sees a query shape. `serialize` only measures turning JS
 * arguments into the query AST — always sub-millisecond, never the reason a
 * request is slow — so it is dropped and steady state settles at two spans per
 * query. The rest stay: `db_query` carries the SQL this instrumentation exists to
 * expose, `compile` isolates query-compiler time (a v7 queryCompiler cost that is
 * otherwise invisible, and cached, so it does not scale with traffic), and
 * `operation` names the call site that issued them. */
const PRISMA_IGNORED_SPAN_TYPES = ['prisma:client:serialize']

/** Prisma tracing is a `globalThis` contract, not a module patch: enabling this
 * installs a tracing helper that the `@prisma/client` runtime looks up by major
 * version. Exported so the integration test asserts the shipped configuration
 * rather than a copy of it. */
export function buildPrismaInstrumentation(): PrismaInstrumentation {
  return new PrismaInstrumentation({ ignoreSpanTypes: PRISMA_IGNORED_SPAN_TYPES })
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
      new UndiciInstrumentation({
        ignoreRequestHook: shouldIgnoreUndiciRequest,
        requestHook: (span, request) => {
          const name = undiciClientSpanName(request)
          if (name) span.updateName(name)
        }
      }),
      buildPrismaInstrumentation(),
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
