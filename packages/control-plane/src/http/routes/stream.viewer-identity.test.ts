/**
 * The SSE gate × viewer identity — the live-unlink case: the identity set is
 * re-resolved per event, so unlinking Slack stops private-DM events on an
 * ALREADY-OPEN stream (revocation lands on the next event, not the next
 * connection). Runs over a real socket because the route hijacks the reply —
 * `inject` cannot observe an unterminated stream.
 */
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { HttpDeps } from '../deps.js'
import type { SessionEventEnvelope } from '../../events/sink.js'
import { streamRoutes } from './stream.js'

const ORG_ID = 'org-1'
const SLACK_OWNER = 'slack:T024BE7LD:U0123ABCD'

const sessions: Record<string, { orgId: string; agentId: string; visibility: string; ownerIdentity: string | null }> = {
  'sess-dm': { orgId: ORG_ID, agentId: 'agent-1', visibility: 'private', ownerIdentity: SLACK_OWNER },
  'sess-org': { orgId: ORG_ID, agentId: 'agent-1', visibility: 'org', ownerIdentity: null }
}

function envelope(sessionId: string): SessionEventEnvelope {
  return { daemonId: 'd-1', event: { agentId: 'agent-1', sessionId } } as unknown as SessionEventEnvelope
}

/** Read SSE frames off a fetch body, one `data:` event at a time. */
function sseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    /** The next non-comment event's `data:` payload. */
    async nextEvent(): Promise<string> {
      for (;;) {
        const at = buffer.indexOf('\n\n')
        if (at >= 0) {
          const frame = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .join('')
          if (data) return data
          continue // a comment (': connected' / keepalive) — skip
        }
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        buffer += decoder.decode(value, { stream: true })
      }
    },
    cancel: () => reader.cancel().catch(() => undefined)
  }
}

describe('stream route × viewer identity (live unlink)', () => {
  const cleanups: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()))
  })

  it('stops private-DM events mid-stream once the Slack identity is gone', async () => {
    // Stands in for LogtoIdentityService AFTER unlink+invalidate: the fenced
    // cache answers null on the very next read.
    let linked: { teamId: string; userId: string } | null = { teamId: 'T024BE7LD', userId: 'U0123ABCD' }
    const handlers: Array<(e: SessionEventEnvelope) => void> = []
    const deps = {
      registry: { getAvailable: async () => ({ orgId: ORG_ID }) },
      repos: {
        org: { roleOf: async () => 'collaborator' },
        session: {
          // Org-fenced read: a row of another org is absent, exactly like an
          // unknown id (org-scoped-data-layer.md §3).
          get: async (orgId: string, id: string) => {
            const row = sessions[id]
            return row && row.orgId === orgId ? row : null
          },
          getExternalScopes: async () => [],
          getExternalAccessPolicy: async () => null
        }
      },
      events: {
        subscribe: (cb: (e: SessionEventEnvelope) => void) => {
          handlers.push(cb)
          return () => {}
        }
      },
      clock: { now: () => Date.now() },
      sessionAccessPlugins: [
        {
          provider: 'slack',
          available: true,
          addViewerIdentities: async ({ identitySet }: { identitySet: Set<string> }) => {
            if (linked) identitySet.add(`slack:${linked.teamId}:${linked.userId}`)
          },
          resolve: async () => ({ allowedScopes: [], degraded: false })
        }
      ]
    } as unknown as HttpDeps

    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      req.principal = { userId: 'u-1' }
      req.orgCtx = { orgId: ORG_ID, role: 'collaborator', userId: 'u-1' } as never
      req.oidcSubject = 'logto-sub'
    })
    await app.register(streamRoutes(deps))
    const base = await app.listen({ host: '127.0.0.1', port: 0 })
    cleanups.push(() => app.close())

    const controller = new AbortController()
    const res = await fetch(`${base}/stream`, { signal: controller.signal })
    const sse = sseReader(res.body!)
    cleanups.push(async () => {
      controller.abort()
      await sse.cancel()
    })
    // The subscription exists once the route wrote its ': connected' comment;
    // waiting on the handler keeps this free of sleeps.
    await expect.poll(() => handlers.length).toBe(1)
    const emit = (sessionId: string) => handlers.forEach((cb) => cb(envelope(sessionId)))

    // Linked: the private DM event flows.
    emit('sess-dm')
    expect(JSON.parse(await sse.nextEvent())).toMatchObject({ event: { sessionId: 'sess-dm' } })

    // Unlinked: the SAME connection must drop the next DM event. The org event
    // emitted right after is the ordering probe — events are relayed in order,
    // so receiving it FIRST proves the DM one was dropped, not still queued.
    linked = null
    emit('sess-dm')
    emit('sess-org')
    expect(JSON.parse(await sse.nextEvent())).toMatchObject({ event: { sessionId: 'sess-org' } })
  })
})
