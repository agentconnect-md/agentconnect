/**
 * The generic-webhook ingress authenticates on a token carried in the URL path, so
 * that token must never reach the request log — an access log is a strictly lower
 * trust boundary than the hook's owning org, and a leaked token fires the hook.
 */
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { buildRelayServer, redactUrl } from './server.js'

const deps = { isReady: () => true, relayId: () => 'relay-1' }

describe('request-log redaction', () => {
  it('redacts the webhook capability token, keeping the rest of the path', () => {
    expect(redactUrl('/webhooks/in/whk_ab12cd34')).toBe('/webhooks/in/<redacted>')
    // A query string is not part of the token segment and must survive.
    expect(redactUrl('/webhooks/in/whk_ab12cd34?retry=1')).toBe('/webhooks/in/<redacted>?retry=1')
    // Unknown/typo'd tokens 404, and those requests are logged too.
    expect(redactUrl('/webhooks/in/probe')).toBe('/webhooks/in/<redacted>')
  })

  it('leaves every other path untouched', () => {
    for (const url of ['/healthz', '/readyz', '/slack/events', '/webhooks/in', '/x/webhooks/in/whk_1']) {
      expect(redactUrl(url)).toBe(url)
    }
  })

  it('serializes a live request with the token already redacted', async () => {
    const lines: unknown[] = []
    const app = buildRelayServer(deps, {
      logger: { level: 'info', stream: { write: (s: string) => lines.push(JSON.parse(s)) } }
    })
    await app.inject({ method: 'POST', url: '/webhooks/in/whk_secret_value' })
    await app.close()

    const urls = lines
      .map((l) => (l as { req?: { url?: string } }).req?.url)
      .filter((u): u is string => typeof u === 'string')
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('/webhooks/in/<redacted>'))).toBe(true)
    // The decisive assertion: the raw token is nowhere in the emitted log records.
    expect(JSON.stringify(lines)).not.toContain('whk_secret_value')
  })

  it('redacts through a caller-supplied logger instance too', async () => {
    // `loggerInstance` is a SEPARATE Fastify option from `logger`, carrying a pino
    // whose serializers were fixed at construction — so merging into `logger` alone
    // would leave this path printing the raw url. Borrowing another Fastify's `log`
    // gives a realistic instance (default serializers already installed) with no
    // extra dependency.
    const lines: unknown[] = []
    const carrier = Fastify({ logger: { level: 'info', stream: { write: (s: string) => lines.push(JSON.parse(s)) } } })
    const app = buildRelayServer(deps, { loggerInstance: carrier.log })
    await app.inject({ method: 'POST', url: '/webhooks/in/whk_secret_value' })
    await app.close()

    expect(lines.length).toBeGreaterThan(0)
    expect(JSON.stringify(lines)).not.toContain('whk_secret_value')
    expect(JSON.stringify(lines)).toContain('/webhooks/in/<redacted>')
  })

  it('still serves its probes with logging switched off', async () => {
    const app = buildRelayServer(deps, { logger: false })
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
    await app.close()
  })
})
