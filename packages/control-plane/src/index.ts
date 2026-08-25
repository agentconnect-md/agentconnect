/**
 * Control Plane bootstrap (design §2.4, §6 Phase 5).
 *
 * The thin entrypoint — it owns process concerns ONLY (config load, the real
 * Prisma client, listen, graceful shutdown) and delegates ALL wiring to
 * `app.ts:buildApp(deps)`, the same factory the tests call. Orchestration /
 * registry / BFF live in the assembled graph; this file never sits on the message
 * hot path (see docs/designs/system-detailed-design.md).
 *
 *   loadConfig() → buildApp({prisma, clock, secretsProvider})
 *     → http.listen() → mountWs() → SIGTERM/SIGINT → shutdown()
 */
import { startControlPlaneOpenTelemetry } from './observability.js'

const telemetry = startControlPlaneOpenTelemetry()

// One process co-hosts the BFF REST surface, the daemon WS gateway, and the relay
// WS gateway for EVERY tenant, so a single floating rejection anywhere must not take
// the whole control plane down (and, under a restart loop, keep taking it down). The
// WS connections catch their own frame-processing rejections at the transport
// boundary; this is the last resort for the paths that cannot — mirroring the guards
// the daemon (index.ts) and relay (index.ts) already install. Node's default here is
// to crash the process.
process.on('unhandledRejection', (reason) => {
  console.error(
    `control-plane: unhandled rejection (continuing): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
  )
})

async function main(): Promise<void> {
  const [
    { loadBootstrapConfig, loadConfig },
    { applyDeploymentEnvironment },
    { systemClock },
    { createPrisma },
    { PgDeploymentConfigStore },
    { ensureDefaultTenant },
    { makeSecretsProvider },
    { makeSecretCipher },
    { buildApp }
  ] = await Promise.all([
    import('./config/env.js'),
    import('./config/deployment.js'),
    import('./domain/clock.js'),
    import('./persistence/prisma.js'),
    import('./persistence/repositories/deployment-config.repo.js'),
    import('./persistence/ensure-default-tenant.js'),
    import('./secrets/providers/memory.js'),
    import('./secrets/cipher.js'),
    import('./app.js')
  ])

  // 1. Bootstrap roots stay in the process environment: database access and
  // the SecretCipher root must exist before the deployment document can open.
  const bootstrapConfig = loadBootstrapConfig()

  // 2. The single Prisma touch in the process; the only seam the bootstrap owns.
  const prisma = createPrisma(bootstrapConfig.DATABASE_URL)
  const secretCipher = makeSecretCipher(bootstrapConfig)
  const deploymentConfig = await new PgDeploymentConfigStore(prisma, secretCipher).getRuntime()

  // A persisted document owns its projected keys and is applied once per
  // process lifetime. No row means the existing env-only deployment remains
  // fully compatible. `loadConfig` still performs the final fail-fast check.
  const config = deploymentConfig ? loadConfig(applyDeploymentEnvironment(process.env, deploymentConfig)) : loadConfig()
  if (!config.OIDC_ISSUER) {
    await ensureDefaultTenant(prisma, { presetAgents: config.PRESET_AGENTS_ENABLED })
  }

  // 3. Assemble the identical graph prod and tests share.
  const app = buildApp({
    prisma,
    config,
    clock: systemClock,
    secretsProvider: makeSecretsProvider(config),
    secretCipher,
    ...(deploymentConfig ? { deploymentConfig } : {}),
    fastify: { logger: true }
  })

  // 4. Listen, then mount the daemon WS gateway (needs the live http.Server).
  const address = await app.http.listen({ port: config.PORT, host: config.HOST })
  app.mountWs()
  app.startBackground() // arm the cron-run reaper (and future background loops)
  app.http.log.info(`control-plane listening at ${address} (ws ${config.WS_PATH})`)

  // 5. Graceful shutdown on signals. Order matters: drain the WS clients FIRST —
  //    Fastify's close() never destroys upgraded sockets, so with a daemon or relay
  //    connected `http.close()` would otherwise block while clients stayed pinned
  //    to the terminating process. A second signal force-exits, and a failsafe timer
  //    bounds the graceful path.
  const SHUTDOWN_DEADLINE_MS = 10_000
  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      console.error(`${signal} received again during shutdown — forcing exit`)
      process.exit(1)
    }
    shuttingDown = true
    app.http.log.info(`${signal} received — shutting down`)
    // Flip readiness to 503 FIRST (before draining): K8s then removes this pod
    // from the Service endpoints while it can still finish in-flight requests, so
    // a rolling update never routes new traffic to a terminating pod (issue #240).
    app.beginShutdown()
    setTimeout(() => {
      console.error(`shutdown did not finish within ${SHUTDOWN_DEADLINE_MS}ms — forcing exit`)
      process.exit(1)
    }, SHUTDOWN_DEADLINE_MS).unref()
    void (async () => {
      try {
        await app.drainWs()
        await app.http.close()
        await app.shutdown()
        await telemetry.shutdown()
        process.exit(0)
      } catch (err) {
        app.http.log.error(err)
        await telemetry.shutdown().catch((otelErr) => app.http.log.error(otelErr))
        process.exit(1)
      }
    })()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch(async (err) => {
  // Boot failed before the logger existed — fall back to stderr and exit non-zero.
  console.error('control-plane failed to start:', err)
  await telemetry.shutdown().catch((otelErr) => console.error('control-plane opentelemetry shutdown failed:', otelErr))
  process.exit(1)
})
