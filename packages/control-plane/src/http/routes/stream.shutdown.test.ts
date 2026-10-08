// Shutdown ends open SSE streams, so closing the server does not wait on connections that never finish on their own.
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { HttpDeps } from '../deps.js'
import { streamRoutes } from './stream.js'

describe('stream route × shutdown', () => {
  it('ends an open stream when the server closes, so close completes instead of waiting on it', async () => {
    let subscribed = false
    const deps = {
      registry: { getAvailable: async () => null },
      repos: { org: { roleOf: async () => 'collaborator' } },
      events: {
        subscribe: () => {
          subscribed = true
          return () => {}
        }
      },
      clock: { now: () => Date.now() },
      sessionAccessPlugins: []
    } as unknown as HttpDeps
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      req.principal = { userId: 'u-1' }
      req.orgCtx = { orgId: 'org-1', role: 'collaborator', userId: 'u-1' } as never
    })
    await app.register(streamRoutes(deps))
    const base = await app.listen({ host: '127.0.0.1', port: 0 })
    const controller = new AbortController()
    const res = await fetch(`${base}/stream`, { signal: controller.signal })
    const reader = res.body!.getReader()
    await expect.poll(() => subscribed).toBe(true)

    const closed = app.close().then(() => 'closed' as const)
    const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000).unref())
    try {
      expect(await Promise.race([closed, hung])).toBe('closed')
      // The browser sees the stream end and redials the replacement pod.
      for (;;) if ((await reader.read()).done) break
    } finally {
      controller.abort()
      await reader.cancel().catch(() => undefined)
      await closed
    }
  })
})
