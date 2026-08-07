import { describe, expect, it } from 'vitest'
import { relayOtelFastifyPlugin, shouldIgnoreUndiciRequest, startRelayOpenTelemetry } from './observability.js'

describe('shouldIgnoreUndiciRequest', () => {
  it.each(['/bottelegram-secret/getMe', '/bottelegram-secret/setMyProfilePhoto'])(
    'suppresses token-bearing Telegram Bot API path %s',
    (path) => {
      expect(shouldIgnoreUndiciRequest({ origin: 'https://api.telegram.org', path })).toBe(true)
    }
  )

  it('keeps unrelated outgoing requests instrumented', () => {
    expect(shouldIgnoreUndiciRequest({ origin: 'https://api.example.test', path: '/bottelegram-secret/getMe' })).toBe(
      false
    )
    expect(shouldIgnoreUndiciRequest({ origin: 'https://api.telegram.org', path: '/file/example' })).toBe(false)
  })
})

/**
 * The gate is asserted through the exported entry point rather than the private
 * predicate: what callers depend on is that a relay with no OTLP endpoint pays
 * nothing and registers no Fastify plugin, which is the property that keeps
 * tests, local runs and self-hosted deployments unaffected.
 *
 * Ordered on purpose. `startRelayOpenTelemetry` arms module-level state for the
 * Fastify plugin, so every not-started case has to be asserted before the one
 * that does start.
 */
describe('startRelayOpenTelemetry', () => {
  it('stays off, and registers no route plugin, until an OTLP endpoint is configured', () => {
    expect(startRelayOpenTelemetry({}).enabled).toBe(false)
    expect(relayOtelFastifyPlugin()).toBeUndefined()
  })

  it('honours OTEL_SDK_DISABLED even when an endpoint is set', () => {
    const handle = startRelayOpenTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4317',
      OTEL_SDK_DISABLED: 'true'
    })
    expect(handle.enabled).toBe(false)
    expect(relayOtelFastifyPlugin()).toBeUndefined()
  })

  it('treats an exporter set to none as off', () => {
    expect(startRelayOpenTelemetry({ OTEL_TRACES_EXPORTER: 'none' }).enabled).toBe(false)
    expect(relayOtelFastifyPlugin()).toBeUndefined()
  })

  it('starts, and arms the route plugin, once an endpoint is configured', async () => {
    const handle = startRelayOpenTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4317',
      NODE_ENV: 'test'
    })
    expect(handle.enabled).toBe(true)
    expect(relayOtelFastifyPlugin()).toBeDefined()
    await expect(handle.shutdown()).resolves.not.toThrow()
  })
})
