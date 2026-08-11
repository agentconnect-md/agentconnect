import { describe, expect, it } from 'vitest'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import { WorkQueue } from './workqueue.js'

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('WorkQueue', () => {
  it('serializes per key and coalesces adds that arrive mid-run', async () => {
    const runs: string[] = []
    let release: (() => void) | undefined
    const queue = new WorkQueue(async (key) => {
      runs.push(key)
      await new Promise<void>((resolve) => (release = resolve))
    })
    queue.add('a')
    await waitUntil(() => runs.length === 1)
    // Three adds while running collapse into exactly one follow-up pass.
    queue.add('a')
    queue.add('a')
    queue.add('a')
    release?.()
    await waitUntil(() => runs.length === 2)
    release?.()
    await queue.shutdown()
    expect(runs).toEqual(['a', 'a'])
  })

  it('runs distinct keys independently', async () => {
    const runs: string[] = []
    const queue = new WorkQueue(async (key) => {
      runs.push(key)
    })
    queue.add('a')
    queue.add('b')
    await waitUntil(() => runs.length === 2)
    await queue.shutdown()
    expect(runs.sort()).toEqual(['a', 'b'])
  })

  it('retries a failing key on its own backoff and resets on success', async () => {
    const clock = new FakeClock()
    let attempts = 0
    const queue = new WorkQueue(
      async () => {
        attempts += 1
        if (attempts < 3) throw new Error('boom')
      },
      { clock, newBackoff: () => new Backoff({ baseMs: 1000, jitter: () => 0 }) }
    )
    queue.add('a')
    await waitUntil(() => attempts === 1)
    // Let the rejection reach the catch and arm the retry timer before advancing.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts).toBe(1)
    clock.advance(1000)
    await waitUntil(() => attempts === 2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Second failure: the delay grows — 1s is not enough, 2s is.
    clock.advance(1000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts).toBe(2)
    clock.advance(1000)
    await waitUntil(() => attempts === 3)
    await queue.shutdown()
  })

  it('evicts idle keys so lifetime org churn does not grow the map', async () => {
    const queue = new WorkQueue(async () => {})
    // A deleted CR still gets one final (successful, 404) pass — it must not stay resident.
    for (const key of ['a', 'b', 'c']) queue.add(key)
    await waitUntil(() => queue.size === 0)
    expect(queue.size).toBe(0)
    await queue.shutdown()
  })

  it('keeps a failing key resident until it succeeds', async () => {
    const clock = new FakeClock()
    let attempts = 0
    const queue = new WorkQueue(
      async () => {
        attempts += 1
        if (attempts < 2) throw new Error('boom')
      },
      { clock, newBackoff: () => new Backoff({ baseMs: 1000, jitter: () => 0 }) }
    )
    queue.add('a')
    await waitUntil(() => attempts === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Resident while a retry is armed, evicted once the pass finally succeeds.
    expect(queue.size).toBe(1)
    clock.advance(1000)
    await waitUntil(() => attempts === 2)
    await waitUntil(() => queue.size === 0)
    await queue.shutdown()
  })

  it('shutdown drops pending retries and waits for in-flight work', async () => {
    const clock = new FakeClock()
    let attempts = 0
    const queue = new WorkQueue(
      async () => {
        attempts += 1
        throw new Error('always')
      },
      { clock, newBackoff: () => new Backoff({ baseMs: 1000, jitter: () => 0 }) }
    )
    queue.add('a')
    await waitUntil(() => attempts === 1)
    await queue.shutdown()
    clock.advance(60_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts).toBe(1)
  })
})
