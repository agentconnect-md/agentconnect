import { describe, it, expect } from 'vitest'
import { PlatformSendQueue } from '../src/platforms/send-queue.js'

/** A fake clock + sleep so spacing is asserted deterministically (no real timers). */
function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps
  }
}

describe('PlatformSendQueue', () => {
  it('runs a gate after the spacing and before the task, outside the task’s own timeout', async () => {
    const clk = fakeClock()
    // A 20 ms task timeout against a gate that really waits 40 ms: inside the timeout the task would be abandoned.
    const q = new PlatformSendQueue(100, clk.now, clk.sleep, 20)
    const order: string[] = []
    const gate = async () => {
      order.push('gate')
      await new Promise((r) => setTimeout(r, 40))
    }
    const first = q.enqueue(async () => order.push('a'))
    const second = q.enqueue(async () => order.push('b'), gate)
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(3)
    expect(order).toEqual(['a', 'gate', 'b'])
    expect(clk.sleeps).toEqual([100])
  })

  it('runs the first task immediately (no initial wait) and returns its result', async () => {
    const clk = fakeClock()
    const q = new PlatformSendQueue(1000, clk.now, clk.sleep)
    expect(await q.enqueue(async () => 'first')).toBe('first')
    expect(clk.sleeps).toEqual([])
  })

  it('preserves FIFO order and spaces subsequent tasks by minIntervalMs', async () => {
    const clk = fakeClock()
    const q = new PlatformSendQueue(100, clk.now, clk.sleep)
    const order: number[] = []
    const ps = [1, 2, 3].map((n) => q.enqueue(async () => (order.push(n), n)))
    expect(await Promise.all(ps)).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
    // first immediate, two subsequent each waited one interval
    expect(clk.sleeps).toEqual([100, 100])
  })

  it('a throwing task rejects its own promise but does not break the chain', async () => {
    const q = new PlatformSendQueue(0)
    const ran: string[] = []
    const p1 = q.enqueue(async () => {
      throw new Error('boom')
    })
    const p2 = q.enqueue(async () => {
      ran.push('ok')
      return 'ok'
    })
    await expect(p1).rejects.toThrow('boom')
    await expect(p2).resolves.toBe('ok')
    expect(ran).toEqual(['ok'])
  })

  it('abandons a hung task after the per-task timeout so the queue keeps moving', async () => {
    // real timer for the timeout; fake clock only for spacing (minInterval 0)
    const q = new PlatformSendQueue(
      0,
      () => 0,
      async () => {},
      30
    )
    const ran: string[] = []
    const hung = q.enqueue(() => new Promise<string>(() => {})) // never resolves
    const next = q.enqueue(async () => (ran.push('next'), 'ok'))
    await expect(hung).rejects.toThrow(/abandoned/)
    await expect(next).resolves.toBe('ok')
    expect(ran).toEqual(['next']) // a hung best-effort call did not block the next write
  })
})
