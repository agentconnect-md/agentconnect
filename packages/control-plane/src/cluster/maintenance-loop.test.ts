/**
 * The provisioner's periodic pass. Two pieces of work share one timer, and
 * neither may cost the other: a drain that throws must not stop the re-apply,
 * and an envelope the re-apply cannot write must be named rather than counted.
 */
import { describe, it, expect, vi } from 'vitest'
import { ClusterMaintenanceLoop, type ClusterMaintenanceLog, type ClusterMaintenanceWork } from './maintenance-loop.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const INTERVAL_MS = 5 * 60 * 1000

function fakeLog(): ClusterMaintenanceLog & {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function work(overrides: Partial<ClusterMaintenanceWork> = {}): ClusterMaintenanceWork {
  return {
    drainTeardowns: async () => 0,
    resyncEnvelopes: async () => ({ converged: 0, failures: [] }),
    ...overrides
  }
}

describe('ClusterMaintenanceLoop', () => {
  it('drains teardowns and re-applies envelopes in the same pass', async () => {
    const drainTeardowns = vi.fn(async () => 1)
    const resyncEnvelopes = vi.fn(async () => ({ converged: 3, failures: [] }))
    const loop = new ClusterMaintenanceLoop(work({ drainTeardowns, resyncEnvelopes }), new FakeClock(), INTERVAL_MS)

    await loop.tick()

    expect(drainTeardowns).toHaveBeenCalledOnce()
    expect(resyncEnvelopes).toHaveBeenCalledOnce()
    loop.stop()
  })

  it('says nothing when every envelope converged — the steady state is silence', async () => {
    const log = fakeLog()
    const loop = new ClusterMaintenanceLoop(
      work({ resyncEnvelopes: async () => ({ converged: 12, failures: [] }) }),
      new FakeClock(),
      INTERVAL_MS,
      log
    )

    await loop.tick()

    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    loop.stop()
  })

  it('reports each envelope it could not apply, at error', async () => {
    const log = fakeLog()
    const loop = new ClusterMaintenanceLoop(
      work({
        resyncEnvelopes: async () => ({
          converged: 1,
          failures: [
            { orgId: 'org-a', error: new Error('cluster unreachable') },
            { orgId: 'org-b', error: new Error('cluster unreachable') }
          ]
        })
      }),
      new FakeClock(),
      INTERVAL_MS,
      log
    )

    await loop.tick()

    // Per envelope and not per pass: an operator has to know WHICH one is stuck,
    // and it stays stuck — on whatever spec it has — until someone acts.
    expect(log.error).toHaveBeenCalledTimes(2)
    expect(log.error.mock.calls.map((call) => (call[0] as { orgId: string }).orgId)).toEqual(['org-a', 'org-b'])
    loop.stop()
  })

  it('keeps the re-apply running when the teardown drain throws', async () => {
    const log = fakeLog()
    const resyncEnvelopes = vi.fn(async () => ({ converged: 1, failures: [] }))
    const loop = new ClusterMaintenanceLoop(
      work({
        drainTeardowns: async () => {
          throw new Error('db down')
        },
        resyncEnvelopes
      }),
      new FakeClock(),
      INTERVAL_MS,
      log
    )

    await expect(loop.tick()).resolves.toBeUndefined()

    expect(resyncEnvelopes).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledOnce()
    loop.stop()
  })

  it('swallows a re-apply pass that fails outright and keeps the loop alive', async () => {
    const log = fakeLog()
    const clock = new FakeClock()
    const resyncEnvelopes = vi.fn(async () => {
      throw new Error('db down')
    })
    const loop = new ClusterMaintenanceLoop(work({ resyncEnvelopes }), clock, INTERVAL_MS, log)

    await expect(loop.tick()).resolves.toBeUndefined()
    // One line, not one per envelope: nothing was selected, so nothing is named.
    expect(log.warn).toHaveBeenCalledOnce()
    expect(log.error).not.toHaveBeenCalled()

    // Re-armed by the failed pass, so drift still converges on the next one.
    clock.advance(INTERVAL_MS)
    await new Promise((resolve) => setImmediate(resolve)) // let the async tick settle
    expect(resyncEnvelopes).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  it('does nothing at all when cluster execution is off', async () => {
    const loop = new ClusterMaintenanceLoop(undefined, new FakeClock(), INTERVAL_MS)
    loop.start()
    await expect(loop.tick()).resolves.toBeUndefined()
    loop.stop()
  })
})
