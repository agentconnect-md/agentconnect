import { describe, expect, it } from 'vitest'
import { startOperatorOpenTelemetry } from './observability.js'

// Asserted through the exported entry point: what callers depend on is that an operator with no
// OTLP endpoint pays nothing, which is what keeps local runs and self-hosted installs unaffected.
describe('startOperatorOpenTelemetry', () => {
  it('stays off until an OTLP endpoint is configured', () => {
    expect(startOperatorOpenTelemetry({}).enabled).toBe(false)
  })

  it('honours OTEL_SDK_DISABLED even when an endpoint is set', () => {
    const handle = startOperatorOpenTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4317',
      OTEL_SDK_DISABLED: 'true'
    })
    expect(handle.enabled).toBe(false)
  })

  it('treats an exporter set to none as off', () => {
    expect(startOperatorOpenTelemetry({ OTEL_TRACES_EXPORTER: 'none' }).enabled).toBe(false)
  })

  it('starts once an endpoint is configured, and shuts down cleanly', async () => {
    const handle = startOperatorOpenTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4317',
      NODE_ENV: 'test'
    })
    expect(handle.enabled).toBe(true)
    // The whole point: the Kubernetes client dials through this export, so it has to be the wrapper.
    const { request } = await import('node:https')
    expect(Boolean((request as { __wrapped?: boolean }).__wrapped)).toBe(true)
    await expect(handle.shutdown()).resolves.not.toThrow()
  })
})
