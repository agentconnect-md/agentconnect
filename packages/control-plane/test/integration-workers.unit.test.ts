import { describe, expect, it } from 'vitest'
import { integrationTestWorkerCount } from './integration-workers.js'

describe('integrationTestWorkerCount', () => {
  it('defaults to four workers', () => {
    expect(integrationTestWorkerCount({})).toBe(4)
  })

  it('accepts a positive integer override', () => {
    expect(integrationTestWorkerCount({ INTEGRATION_TEST_WORKERS: '2' })).toBe(2)
  })

  it.each(['0', '-1', '1.5', 'many'])('rejects invalid worker count %j', (value) => {
    expect(() => integrationTestWorkerCount({ INTEGRATION_TEST_WORKERS: value })).toThrow(
      'INTEGRATION_TEST_WORKERS must be a positive integer'
    )
  })
})
