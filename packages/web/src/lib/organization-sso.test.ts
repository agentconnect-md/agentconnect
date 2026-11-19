// @vitest-environment happy-dom

import { beforeEach, expect, it } from 'vitest'
import { commitPendingSignIn, notePendingSignIn, readLastSignIn, stashSsoTest, takeSsoTest } from './organization-sso'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

it('remembers a sign-in method only once the sign-in completes', () => {
  notePendingSignIn({ method: 'email', email: 'dana@acme.example' })
  expect(readLastSignIn()).toBeNull()

  commitPendingSignIn()
  expect(readLastSignIn()).toEqual({ method: 'email', email: 'dana@acme.example' })

  // A sign-in that noted nothing leaves the remembered method alone.
  commitPendingSignIn()
  expect(readLastSignIn()).toEqual({ method: 'email', email: 'dana@acme.example' })

  notePendingSignIn({ method: 'social', target: 'google' })
  commitPendingSignIn()
  expect(readLastSignIn()).toEqual({ method: 'social', target: 'google' })
})

it('ignores a remembered value it cannot read', () => {
  localStorage.setItem('ac.lastSignIn', '{"method":"email","email":"not an address"}')
  expect(readLastSignIn()).toBeNull()
  localStorage.setItem('ac.lastSignIn', 'not json')
  expect(readLastSignIn()).toBeNull()
})

it('hands a test sign-in to its landing page once, and only inside the test window', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const test = {
    nonce: 'nonce-1',
    returnTo: '/acme/settings#single-sign-on',
    expiresAt: '2026-01-01T00:10:00Z'
  }
  stashSsoTest(test)
  expect(takeSsoTest(now)).toEqual(test)
  expect(takeSsoTest(now)).toBeNull()

  stashSsoTest(test)
  expect(takeSsoTest(Date.parse('2026-01-01T00:10:01Z'))).toBeNull()
})

it('returns to Settings when the stashed destination is not a same-origin path', () => {
  stashSsoTest({
    nonce: 'nonce-1',
    returnTo: '//elsewhere.example.test',
    expiresAt: '2026-01-01T00:10:00Z'
  })
  expect(takeSsoTest(Date.parse('2026-01-01T00:00:00Z'))?.returnTo).toBe('/settings')
})
