import { describe, expect, it } from 'vitest'
import { noTurnMetrics } from './metrics.js'
import { meteredTurnMetrics, TurnUsageMeter } from './usage.js'

const A = '00000000-0000-4000-8000-0000000000aa'
const B = '00000000-0000-4000-8000-0000000000bb'

describe('TURN usage per Computer (computer-use.md §15.5)', () => {
  it('counts each relayed datagram toward the Computer on either end, and drains it once', () => {
    let now = 1_760_000_000_000
    const meter = new TurnUsageMeter(() => now)
    const metrics = meteredTurnMetrics(noTurnMetrics, meter)
    metrics.relayed(1000, { kind: 'computer', computerId: A }, { kind: 'viewer' })
    metrics.relayed(500, { kind: 'viewer' }, { kind: 'computer', computerId: A })
    metrics.relayed(70, { kind: 'viewer' }, { kind: 'computer', computerId: B })
    metrics.relayed(9, { kind: 'viewer' }, { kind: 'other' })
    now += 60_000
    expect(meter.drain(1)).toEqual([
      {
        from: new Date(now - 60_000).toISOString(),
        to: new Date(now).toISOString(),
        entries: [{ computerId: A, bytes: 1500 }]
      },
      {
        from: new Date(now - 60_000).toISOString(),
        to: new Date(now).toISOString(),
        entries: [{ computerId: B, bytes: 70 }]
      }
    ])
    expect(meter.drain(10)).toEqual([])
  })

  it('keeps an unsent report for the next drain', () => {
    let now = 1_760_000_000_000
    const meter = new TurnUsageMeter(() => now)
    meter.add(A, 10)
    now += 60_000
    const [report] = meter.drain(10)
    meter.add(A, 5)
    meter.restore(report!)
    now += 60_000
    expect(meter.drain(10)).toEqual([
      {
        from: new Date(now - 120_000).toISOString(),
        to: new Date(now).toISOString(),
        entries: [{ computerId: A, bytes: 15 }]
      }
    ])
  })
})
