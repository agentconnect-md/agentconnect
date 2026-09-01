/**
 * The identity lock's three budgets are an ORDERING, and the failure it prevents is silent and
 * expensive: a connect callback whose transaction expires while queued behind a sweep has already
 * spent its OAuth authorization code, and Linear will not honour that code twice. The operator sees
 * "something went wrong" and a workspace that will not connect.
 *
 * Nothing in the type system relates these constants, and they live in two files, so the ordering is
 * asserted here instead — the whole point is that they cannot drift apart quietly.
 */
import { describe, it, expect } from 'vitest'
import { LINEAR_IDENTITY_LOCK_MAX_HOLD_MS, LINEAR_IDENTITY_LOCK_WAIT_BUDGET_MS } from './linear-identity-lock.js'
import { LINEAR_API_REQUEST_TIMEOUT_MS } from '../platforms/linear/api.js'

describe('the Linear identity lock budgets', () => {
  it('keeps a single upstream call inside the longest permitted hold', () => {
    // The sweeper revokes while holding the lock, so its HTTP ceiling has to fit inside the
    // transaction's — otherwise a hung Linear surfaces as an expired transaction (an internal
    // error) rather than as `unreachable` (a retry).
    expect(LINEAR_API_REQUEST_TIMEOUT_MS).toBeLessThan(LINEAR_IDENTITY_LOCK_MAX_HOLD_MS)
  })

  it('lets a waiter outlast the longest permitted hold', () => {
    // `pg_advisory_xact_lock` blocks INSIDE the waiter's transaction, so its `timeout` is what has
    // to cover the wait. Below the holder's ceiling, a callback colliding with a sweep dies having
    // already spent its authorization code.
    expect(LINEAR_IDENTITY_LOCK_WAIT_BUDGET_MS).toBeGreaterThan(LINEAR_IDENTITY_LOCK_MAX_HOLD_MS)
  })

  it('leaves real headroom rather than a coincidental margin', () => {
    // A waiter can queue behind a hold that is itself waiting out a slow upstream call, so "greater
    // than" is not enough to be comfortable — pin the intended slack so shaving either number is a
    // deliberate act with a failing test attached.
    expect(LINEAR_IDENTITY_LOCK_WAIT_BUDGET_MS - LINEAR_IDENTITY_LOCK_MAX_HOLD_MS).toBeGreaterThanOrEqual(
      LINEAR_API_REQUEST_TIMEOUT_MS
    )
  })
})
