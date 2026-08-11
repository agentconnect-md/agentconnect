#!/usr/bin/env node
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { K8sHttp, LeaseElector, loadInClusterConfig } from '@agentconnect.md/k8s-client'
import { loadConfig } from './config.js'
import { Controller } from './controller.js'
import { AgentConnectOrgApi } from './crd/api.js'
import { startOperatorOpenTelemetry } from './observability.js'
import { preflightUninstall } from './preflight.js'
import { reconcile } from './reconcile/reconcile.js'
import type { ReconcileContext } from './reconcile/context.js'

/** Hidden subcommand: the chart's pre-delete hook runs it, nobody types it. */
const PREFLIGHT_UNINSTALL = 'preflight-uninstall'

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

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === PREFLIGHT_UNINSTALL) return runPreflightUninstall()
  // Before the API client exists, so its calls are instrumented. No-op unless OTLP is configured.
  const telemetry = startOperatorOpenTelemetry()
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
      .then(() => telemetry.shutdown())
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

// Run only as a bin; importing this module (tests, tooling) must stay side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
