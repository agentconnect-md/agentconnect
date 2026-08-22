import { describe, it, expect, vi } from 'vitest'
import { SystemMetrics, type LoadSample } from '../src/metrics/system-metrics.js'
import { FakeClock } from './cp/fake-clock.js'

/** Let queued microtasks (the async tick body) settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('SystemMetrics', () => {
  it('defaults to zeros before the first sample resolves', () => {
    const m = new SystemMetrics({ clock: new FakeClock(), sample: async () => ({ cpu: 0.9, mem: 0.9 }) })
    expect(m.snapshot()).toEqual({ cpu: 0, mem: 0 })
  })

  it('samples once on start and re-samples every interval on the injected clock', async () => {
    const clock = new FakeClock()
    const samples: LoadSample[] = [
      { cpu: 0.1, mem: 0.2 },
      { cpu: 0.3, mem: 0.4 },
      { cpu: 0.5, mem: 0.6 }
    ]
    let i = 0
    const sample = vi.fn(async () => samples[Math.min(i++, samples.length - 1)]!)
    const m = new SystemMetrics({ clock, intervalMs: 1000, sample })

    m.start()
    await flush()
    expect(sample).toHaveBeenCalledTimes(1)
    expect(m.snapshot()).toEqual({ cpu: 0.1, mem: 0.2 })

    clock.advance(1000)
    await flush()
    expect(sample).toHaveBeenCalledTimes(2)
    expect(m.snapshot()).toEqual({ cpu: 0.3, mem: 0.4 })

    m.stop()
    clock.advance(5000)
    await flush()
    expect(sample).toHaveBeenCalledTimes(2) // no further samples after stop
  })

  it('start is idempotent', async () => {
    const clock = new FakeClock()
    const sample = vi.fn(async () => ({ cpu: 0, mem: 0 }))
    const m = new SystemMetrics({ clock, intervalMs: 1000, sample })
    m.start()
    m.start()
    await flush()
    expect(sample).toHaveBeenCalledTimes(1)
    m.stop()
  })

  it('keeps the previous sample when a probe throws, then recovers', async () => {
    const clock = new FakeClock()
    let call = 0
    const sample = vi.fn(async () => {
      call++
      if (call === 2) throw new Error('probe failed')
      return { cpu: call / 10, mem: 0 }
    })
    const m = new SystemMetrics({ clock, intervalMs: 1000, sample })

    m.start()
    await flush()
    expect(m.snapshot().cpu).toBeCloseTo(0.1)

    clock.advance(1000) // 2nd sample throws — snapshot unchanged
    await flush()
    expect(m.snapshot().cpu).toBeCloseTo(0.1)

    clock.advance(1000) // 3rd sample succeeds — loop kept re-arming after the throw
    await flush()
    expect(m.snapshot().cpu).toBeCloseTo(0.3)
    m.stop()
  })
})
