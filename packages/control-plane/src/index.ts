/**
 * Control Plane bootstrap (design §2.4, §6 Phase 5).
 *
 * The thin entrypoint — it owns process concerns ONLY (config load, the real
 * Prisma client, listen, graceful shutdown) and delegates ALL wiring to
 * `app.ts:buildApp(deps)`, the same factory the tests call. Orchestration /
 * registry / BFF live in the assembled graph; this file never sits on the message
 * hot path (see docs/designs/daemon-centric-detailed-design.md).
 *
 *   loadConfig() → buildApp({prisma, clock, secretsProvider})
 *     → http.listen() → mountWs() → SIGTERM/SIGINT → shutdown()
 */
import { startControlPlaneOpenTelemetry } from './observability.js'

const telemetry = startControlPlaneOpenTelemetry()

async function main(): Promise<void> {
  const [{ loadConfig }, { systemClock }, { createPrisma }, { makeSecretsProvider }, { buildApp }] = await Promise.all([
    import('./config/env.js'),
    import('./domain/clock.js'),
    import('./persistence/prisma.js'),
    import('./secrets/providers/memory.js'),
    import('./app.js')
  ])

  // 1. Validate config or refuse to start (fail-fast, §2.4).
  const config = loadConfig()

  // 2. The single Prisma touch in the process; the only seam the bootstrap owns.
  const prisma = createPrisma(config.DATABASE_URL)

  // 3. Assemble the identical graph prod and tests share.
  const app = buildApp({
    prisma,
    config,
    clock: systemClock,
    secretsProvider: makeSecretsProvider(config),
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
