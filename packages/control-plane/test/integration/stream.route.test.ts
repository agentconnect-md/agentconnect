/**
 * The session-event feed hijacks Fastify's raw response for a long-lived SSE
 * connection. Exercise it over a real socket so pending Fastify headers (most
 * importantly the global CORS headers) cannot be lost at `writeHead` again.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { get, type ClientRequest, type IncomingMessage } from 'node:http'

import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
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
})
