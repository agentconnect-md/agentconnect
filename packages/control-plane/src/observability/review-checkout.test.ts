import { describe, expect, it, vi } from 'vitest'
import { createReviewCheckoutMetric } from './review-checkout.js'

describe('review checkout metric', () => {
  it('labels exact and degraded checkouts with closed, identifier-free attributes', () => {
    const counter = { add: vi.fn() }
    const count = createReviewCheckoutMetric(counter)

    count({ outcome: 'exact' }, 'install')
    count({ outcome: 'degraded', reason: 'fetch_timeout' }, 'org')

    expect(counter.add.mock.calls).toEqual([
      [1, { outcome: 'exact', reason: 'none', daemon_scope: 'install' }],
      [1, { outcome: 'degraded', reason: 'fetch_timeout', daemon_scope: 'org' }]
    ])
  })

  it('never throws into the caller', () => {
    const count = createReviewCheckoutMetric({
      add: () => {
        throw new Error('exporter down')
      }
    })
    expect(() => count({ outcome: 'exact' }, 'org')).not.toThrow()
  })
})
