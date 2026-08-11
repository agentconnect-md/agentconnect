// SDK wiring, the on/off gate, and span-name hygiene are shared; only the name and version are the operator's own.
// No Fastify plugin, no extra instrumentation: the operator's only egress is the in-cluster API server.
import { readFileSync } from 'node:fs'
import { startOpenTelemetry, type OpenTelemetryHandle } from '@agentconnect.md/observability'

export type { OpenTelemetryHandle }

/** No-op unless an OTLP endpoint or exporter is configured, so local runs and self-hosted installs pay nothing. */
export function startOperatorOpenTelemetry(env: NodeJS.ProcessEnv = process.env): OpenTelemetryHandle {
  return startOpenTelemetry({ serviceName: 'agentconnect-operator', serviceVersion: readPackageVersion(), env })
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
