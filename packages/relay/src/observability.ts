/**
 * Relay OpenTelemetry. The SDK wiring, the enable/disable predicate, and the
 * span-name hygiene live in `@agentconnect.md/observability` — shared with the
 * control plane so the URL-redaction heuristics cannot drift between them.
 *
 * The relay is the only public ingress (Slack and Feishu callbacks, GitHub and
 * generic webhooks, webchat), and it is the one hop that used to have no traces
 * at all. Its container logs carry Fastify's `responseTime`, which is a latency
 * number but not a causal chain.
 *
 * `service.name` is the relay in every environment, exactly as the control
 * plane's is; environments are told apart by the `k8s.*` attributes the
 * collector adds, and the dashboards key on those. Nothing starts unless the
 * OTLP endpoint is configured, so a self-hosted or local relay pays nothing.
 */
import { readFileSync } from 'node:fs'
import { otelFastifyPlugin, startOpenTelemetry, type OpenTelemetryHandle } from '@agentconnect.md/observability'

export type { OpenTelemetryHandle }
export { shouldIgnoreUndiciRequest, undiciClientSpanName } from '@agentconnect.md/observability'

export function relayOtelFastifyPlugin(): ReturnType<typeof otelFastifyPlugin> {
  return otelFastifyPlugin()
}

export function startRelayOpenTelemetry(env: NodeJS.ProcessEnv = process.env): OpenTelemetryHandle {
  return startOpenTelemetry({
    serviceName: 'agentconnect-relay',
    serviceVersion: readPackageVersion(),
    env
  })
}

/** Resolved here rather than in the shared package, which would otherwise
 *  report its own version instead of the relay's. */
function readPackageVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}
