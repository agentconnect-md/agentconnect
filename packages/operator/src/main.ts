import { hostname } from 'node:os'
import { K8sHttp, LeaseElector, loadInClusterConfig } from '@agentconnect.md/k8s-client'
import { loadConfig } from './config.js'
import { Controller } from './controller.js'
import { AgentConnectOrgApi } from './crd/api.js'
import { PREFLIGHT_UNINSTALL, preflightUninstall } from './preflight.js'
import { reconcile } from './reconcile/reconcile.js'
import type { OpenTelemetryHandle } from './observability.js'
import type { ReconcileContext } from './reconcile/context.js'

// No loadConfig(): the guard only needs the in-cluster identity, so the hook Job
// carries none of the operator's install-time env.
async function runPreflightUninstall(): Promise<void> {
  const cluster = loadInClusterConfig()
  const result = await preflightUninstall(new AgentConnectOrgApi(new K8sHttp(cluster), cluster.namespace))
  if (result.remaining.length === 0) {
    console.log(result.message)
    return
  }
  console.error(result.message)
  process.exit(1)
}

/** The bin's body; `index.ts` starts telemetry and only then imports this module. */
export async function main(argv: string[] = process.argv.slice(2), telemetry?: OpenTelemetryHandle): Promise<void> {
  if (argv[0] === PREFLIGHT_UNINSTALL) return runPreflightUninstall()
  const config = loadConfig()
  const cluster = loadInClusterConfig()
  const http = new K8sHttp(cluster)
  const orgApi = new AgentConnectOrgApi(http, cluster.namespace)
  const log = {
    debug: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message)
  }
  const ctx: ReconcileContext = { http, orgApi, config, controlNamespace: cluster.namespace, log }
  const controller = new Controller({
    http,
    orgApi,
    config,
    log,
    reconcile: (name) => reconcile(ctx, name)
  })
  const elector = new LeaseElector(http, {
    namespace: cluster.namespace,
    leaseName: config.leaseName,
    identity: process.env.HOSTNAME ?? `${hostname()}-${process.pid}`,
    log,
    onStartedLeading: () => controller.onStartedLeading(),
    onStoppedLeading: () => void controller.onStoppedLeading()
  })
  const shutdown = (signal: string): void => {
    log.warn(`${signal} received; releasing lease and draining`)
    void elector
      .stop()
      .then(() => controller.onStoppedLeading())
      // Last, so spans from the drain above still make it out.
      .then(() => telemetry?.shutdown())
      .catch((error: unknown) => log.warn(`operator shutdown failed: ${(error as Error).message}`))
      .finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  log.debug(
    `agentconnect-operator starting: control namespace ${cluster.namespace}, prefix ${config.orgNamespacePrefix}`
  )
  await elector.start()
}
