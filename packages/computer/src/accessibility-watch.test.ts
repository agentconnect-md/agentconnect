import { describe, expect, it } from 'vitest'
import { watchAccessibility } from './accessibility-watch.js'

describe('accessibility watch', () => {
  it('restarts the driver once the grant appears, and then stops checking', async () => {
    let granted = false
    let checks = 0
    let restarts = 0
    const watch = watchAccessibility({
      check: async () => (checks++, granted),
      restartDriver: async () => void restarts++,
      log: () => undefined,
      intervalMs: 5
    })
    expect(await watch.now()).toBe(false)
    expect(restarts).toBe(0)
    granted = true
    await expect.poll(() => restarts).toBe(1)
    const settled = checks
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(checks).toBe(settled)
    expect(await watch.now()).toBe(true)
    expect(restarts).toBe(1)
  })

  it('reads a failed check as not granted', async () => {
    const watch = watchAccessibility({
      check: async () => {
        throw new Error('driver timed out')
      },
      restartDriver: async () => undefined,
      log: () => undefined,
      intervalMs: 60_000
    })
    expect(await watch.now()).toBe(false)
    watch.stop()
  })
})
