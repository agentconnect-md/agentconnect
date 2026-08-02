import { describe, expect, it } from 'vitest'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { ignoreSensitiveUndiciRequest } from '../src/observability.js'

describe('daemon OpenTelemetry URL secrecy', () => {
  it('suppresses exact GitHub codeload requests before url.full/url.query attributes are created', () => {
    const sentinel = 'private_archive_capability_MUST_NOT_EXPORT'
    const instrumentation = new UndiciInstrumentation({
      ignoreRequestHook: ignoreSensitiveUndiciRequest
    })
    const ignore = instrumentation.getConfig().ignoreRequestHook!

    expect(
      ignore({
        origin: 'https://codeload.github.com',
        path: `/acme/repo/legacy.tar.gz?token=${sentinel}`
      } as never)
    ).toBe(true)
    expect(
      ignore({
        origin: 'https://codeload.github.com.',
        path: `/acme/repo/legacy.tar.gz?token=${sentinel}`
      } as never)
    ).toBe(true)
    expect(ignore({ origin: 'https://api.github.com', path: `/repos/acme/repo?marker=${sentinel}` } as never)).toBe(
      false
    )
  })
})
