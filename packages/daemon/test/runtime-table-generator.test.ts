import { describe, expect, it } from 'vitest'
import { ACP_AUTH_REQUIRED_CODE, isAuthRequired } from '../../../docker/runtime-sandbox/generate-runtime-table.mjs'

// The runtime image's table generator tolerates exactly one session/new failure: a runtime that is
// unauthenticated. Everything else must fail the build, because the smoke test exercises only
// Claude — so a broken Codex would otherwise be published AND verified with an empty snapshot.

describe('runtime table probe classification', () => {
  it('accepts only the ACP auth-required CODE, not a message that mentions auth', () => {
    expect(ACP_AUTH_REQUIRED_CODE).toBe(-32000)
    const unauthenticated = Object.assign(new Error('codex-acp session/new failed: Authentication required'), {
      acpCode: -32000
    })
    expect(isAuthRequired(unauthenticated)).toBe(true)

    // The case the earlier substring match got wrong: a broken auth store is a broken runtime.
    const brokenAuthStore = Object.assign(new Error('failed to initialize auth database at /agent/.codex'), {
      acpCode: -32603
    })
    expect(isAuthRequired(brokenAuthStore)).toBe(false)

    // And an error carrying no code at all — a spawn failure or a timeout — is never auth.
    expect(isAuthRequired(new Error('codex-acp did not answer session/new within 60000ms'))).toBe(false)
    expect(isAuthRequired(undefined)).toBe(false)
  })
})
