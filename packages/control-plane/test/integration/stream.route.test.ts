/**
 * The session-event feed hijacks Fastify's raw response for a long-lived SSE
 * connection. Exercise it over a real socket so pending Fastify headers (most
 * importantly the global CORS headers) cannot be lost at `writeHead` again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get, type ClientRequest, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'

import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { prisma } from '../setup.db.js'

const ORIGIN = 'https://app.example.com'
const opened: HttpApp[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

function openStream(url: string): Promise<{ request: ClientRequest; response: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { origin: ORIGIN, accept: 'text/event-stream' } }, (response) => {
      resolve({ request, response })
    })
    request.once('error', reject)
    request.setTimeout(5_000, () => request.destroy(new Error('timed out opening session event stream')))
  })
}

describe('session event stream', () => {
  it('preserves CORS headers on the hijacked SSE response', async () => {
    const app = buildHttpApp(prisma, { CORS_ORIGIN: ORIGIN })
    opened.push(app)
    const base = await app.app.listen({ port: 0, host: '127.0.0.1' })
    const { request, response } = await openStream(`${base}/api/v1/orgs/${DEFAULT_ORG_ID}/stream`)

    try {
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toBe('text/event-stream')
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN)
      expect(response.headers.vary).toContain('Origin')
    } finally {
      await new Promise<void>((resolve) => {
        if (response.destroyed) return resolve()
        response.once('close', resolve)
        response.destroy()
        request.destroy()
      })
    }
  })

  // session-visibility.md §5: BOTH session-scoped envelope variants are gated —
  // the milestone carries a content-derived summary, and the activity event
  // still exposes the session's existence, revision, and live activity.
  it('withholds both envelope variants of a private session from a non-owner', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    await seedSessionMeta(prisma, 'session-private', agentId, {
      daemonId,
      visibility: 'private',
      ownerIdentity: 'user:someone-else'
    })
    await seedSessionMeta(prisma, 'session-shared', agentId, { daemonId })

    // devAuth's principal is DEFAULT_OWNER_ID, whose org role is `owner` — the
    // governance exception would see everything, so subscribe as a collaborator.
    const email = 'stream-collaborator@acme.dev'
    const { userId } = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'stream-collaborator',
      email,
      emailVerified: true
    })
    await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')

    const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
    opened.push(app)
    const base = await app.app.listen({ port: 0, host: '127.0.0.1' })
    const { request, response } = await openStream(`${base}/api/v1/orgs/${DEFAULT_ORG_ID}/stream`)
    const chunks: string[] = []
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => chunks.push(chunk))

    try {
      app.events.publishActivity(daemonId, {
        sessionId: 'session-private',
        agentId,
        revision: '3',
        ts: '2026-07-30T00:00:00.000Z'
      })
      app.events.publish(daemonId, {
        sessionId: 'session-private',
        agentId,
        phase: 'plan',
        summary: 'secret plan',
        ts: '2026-07-30T00:00:01.000Z'
      })
      // A visible session's event is the ordering barrier: once it has arrived,
      // the two above were definitively dropped rather than merely pending.
      app.events.publishActivity(daemonId, {
        sessionId: 'session-shared',
        agentId,
        revision: '4',
        ts: '2026-07-30T00:00:02.000Z'
      })

      await vi.waitFor(() => expect(chunks.join('')).toContain('"sessionId":"session-shared"'))
      const body = chunks.join('')
      expect(body).not.toContain('session-private')
      expect(body).not.toContain('secret plan')
    } finally {
      await new Promise<void>((resolve) => {
        if (response.destroyed) return resolve()
        response.once('close', resolve)
        response.destroy()
        request.destroy()
      })
    }
  })

  it('relays a body-free session activity event for a visible agent', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const app = buildHttpApp(prisma)
    opened.push(app)
    const base = await app.app.listen({ port: 0, host: '127.0.0.1' })
    const { request, response } = await openStream(`${base}/api/v1/orgs/${DEFAULT_ORG_ID}/stream`)
    const chunks: string[] = []
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => chunks.push(chunk))

    // The activity gate reads the session row (session-visibility.md §5), so seed
    // the milestone the daemon would have reported before any turn activity.
    await seedSessionMeta(prisma, 'session-live', agentId, { daemonId })

    try {
      app.events.publishActivity(daemonId, {
        sessionId: 'session-live',
        agentId,
        revision: '12',
        ts: '2026-07-27T00:00:00.000Z'
      })
      await vi.waitFor(() => {
        const body = chunks.join('')
        expect(body).toContain('event: session-activity')
        expect(body).toContain('"sessionId":"session-live"')
        expect(body).not.toContain('"text"')
      })
    } finally {
      await new Promise<void>((resolve) => {
        if (response.destroyed) return resolve()
        response.once('close', resolve)
        response.destroy()
        request.destroy()
      })
    }
  })
})
