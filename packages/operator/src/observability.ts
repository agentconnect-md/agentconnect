// SDK wiring, the on/off gate, and span-name hygiene are shared; only the name and version are the operator's own.
// No Fastify plugin, no extra instrumentation: the operator's only egress is the in-cluster API server.
import { readFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { startOpenTelemetry, type OpenTelemetryHandle } from '@agentconnect.md/observability'

export type { OpenTelemetryHandle }

/** No-op unless an OTLP endpoint or exporter is configured, so local runs and self-hosted installs pay nothing. */
export function startOperatorOpenTelemetry(env: NodeJS.ProcessEnv = process.env): OpenTelemetryHandle {
  const handle = startOpenTelemetry({
    serviceName: 'agentconnect-operator',
    serviceVersion: readPackageVersion(),
    env
  })
  if (handle.enabled) armCoreHttpInstrumentation()
  return handle
}

/** HTTP instrumentation patches the CJS exports through the require hook, which a pure-ESM process never
 *  fires for a core module. Pull both through it once and re-sync the builtin ESM facade, so the client's
 *  `import { request } from 'node:https'` resolves to the wrapper instead of the untraced original. */
function armCoreHttpInstrumentation(): void {
  const require = createRequire(import.meta.url)
  require('node:http')
  require('node:https')
  syncBuiltinESMExports()
}

/** Resolved here rather than in the shared package, which would otherwise report its own version. */
function readPackageVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}
