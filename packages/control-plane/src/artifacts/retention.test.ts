// The retention sweep's decision (artifacts.md §10.1, P3).
import { describe, expect, it } from 'vitest'
import { retentionWindowMs, revisionExpired, type RevisionRetentionFacts } from './retention.js'

const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2026-11-27T00:00:00.000Z')

const facts = (over: Partial<RevisionRetentionFacts> = {}): RevisionRetentionFacts => ({
  state: 'ready',
  number: 1,
  createdAt: new Date(NOW - 91 * DAY),
  latestRevision: 2,
  retention: '90d',
  activelyShared: false,
  ...over
})

describe('retentionWindowMs', () => {
  it('reads a day count and keeps everything for never or a value the CP would not deliver', () => {
    expect(retentionWindowMs('90d')).toBe(90 * DAY)
    expect(retentionWindowMs('1d')).toBe(DAY)
    expect(retentionWindowMs('9999d')).toBe(9999 * DAY)
    for (const kept of ['never', null, undefined, '', '0d', '10000d', '7', '2weeks', ' 7d']) {
      expect(retentionWindowMs(kept)).toBeNull()
    }
  })
})

describe('revisionExpired', () => {
  it('expires a ready, older, unshared revision past its window', () => {
    expect(revisionExpired(facts(), NOW)).toBe(true)
  })

  it('keeps a revision still inside its window, measured from its creation', () => {
    expect(revisionExpired(facts({ createdAt: new Date(NOW - 89 * DAY) }), NOW)).toBe(false)
    expect(revisionExpired(facts({ createdAt: new Date(NOW - 90 * DAY) }), NOW)).toBe(false)
    expect(revisionExpired(facts({ createdAt: new Date(NOW - 90 * DAY - 1) }), NOW)).toBe(true)
  })

  it('always keeps the latest revision', () => {
    expect(revisionExpired(facts({ number: 2, latestRevision: 2 }), NOW)).toBe(false)
  })

  it('keeps a revision an active share pins', () => {
    expect(revisionExpired(facts({ activelyShared: true }), NOW)).toBe(false)
  })

  it('leaves a revision that never became ready to the publish path', () => {
    expect(revisionExpired(facts({ state: 'pending' }), NOW)).toBe(false)
    expect(revisionExpired(facts({ state: 'pending', number: 3 }), NOW)).toBe(false)
  })

  it('keeps everything under never or an unknown retention', () => {
    expect(revisionExpired(facts({ retention: 'never' }), NOW)).toBe(false)
    expect(revisionExpired(facts({ retention: null }), NOW)).toBe(false)
  })

  it('follows a shorter window', () => {
    expect(revisionExpired(facts({ retention: '7d', createdAt: new Date(NOW - 8 * DAY) }), NOW)).toBe(true)
  })
})
