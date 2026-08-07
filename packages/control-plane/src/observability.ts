/**
 * Control-plane OpenTelemetry. The SDK wiring, the enable/disable predicate,
 * and the span-name hygiene live in `@agentconnect.md/observability` — shared
 * with the relay so the URL-redaction heuristics cannot drift between them.
 *
 * What stays here is what is genuinely the control plane's: its name, its
 * version, and Prisma, which no other service runs.
 */
import { readFileSync } from 'node:fs'
import { otelFastifyPlugin, startOpenTelemetry, type OpenTelemetryHandle } from '@agentconnect.md/observability'
import { PrismaInstrumentation } from '@prisma/instrumentation'

export type { OpenTelemetryHandle }
export { shouldIgnoreUndiciRequest, undiciClientSpanName } from '@agentconnect.md/observability'

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

export function controlPlaneOtelFastifyPlugin(): ReturnType<typeof otelFastifyPlugin> {
  return otelFastifyPlugin()
}

export function startControlPlaneOpenTelemetry(env: NodeJS.ProcessEnv = process.env): OpenTelemetryHandle {
  return startOpenTelemetry({
    serviceName: 'agentconnect-control-plane',
    serviceVersion: readPackageVersion(),
    env,
    extraInstrumentations: [buildPrismaInstrumentation()]
  })
}

/** Resolved here rather than in the shared package, which would otherwise
 *  report its own version instead of the control plane's. */
function readPackageVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}
