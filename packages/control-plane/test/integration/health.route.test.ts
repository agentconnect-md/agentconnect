/**
 * Infra probes for rolling updates (issue #240).
 *
 * `/livez` is static liveness; `/readyz` is readiness — green only while the pod
 * should take traffic. It flips to 503 the instant shutdown begins (so K8s drops
 * the pod from the Service before sockets close) and when the DB is unreachable
 * (a pod that can't reach Postgres would only serve 500s). `/health` stays as the
 * pre-#240 static alias.
 *
 * Runs against real Testcontainers Postgres so the ready-path ping is a real
 * `SELECT 1`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

describe('infra probes (/livez, /readyz, /health)', () => {
  it('serves /readyz 200 when the DB is reachable and not shutting down', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('serves /livez 200 (static liveness), unauthenticated', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: '/livez' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('keeps /health as a back-compat static probe', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('flips /readyz to 503 once shutdown begins, but keeps /livez green', async () => {
    running = buildHttpApp(prisma)
    running.deps.readiness.beginShutdown()

    const ready = await running.app.inject({ method: 'GET', url: '/readyz' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json()).toEqual({ status: 'shutting_down' })

    // Liveness must stay green through drain — else the kubelet SIGKILLs the pod.
    const live = await running.app.inject({ method: 'GET', url: '/livez' })
    expect(live.statusCode).toBe(200)
  })

  it('serves /readyz 503 (db_unreachable) when the DB ping fails', async () => {
    running = buildHttpApp(prisma)
    // Swap in a failing ping to simulate a lost Postgres connection.
    running.deps.readiness.pingDb = () => Promise.reject(new Error('connection refused'))

    const res = await running.app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'db_unreachable' })
  })
})
