// TURN bytes per Computer since the last report (computer-use.md §15.5), so the Control Plane can meter viewer media.
import type { TurnMetrics } from './metrics.js'

export interface TurnUsageReport {
  from: string
  to: string
  entries: Array<{ computerId: string; bytes: number }>
}

export class TurnUsageMeter {
  private bytes = new Map<string, number>()
  private since: number

  constructor(private readonly now: () => number = Date.now) {
    this.since = now()
  }

  add(computerId: string, bytes: number): void {
    this.bytes.set(computerId, (this.bytes.get(computerId) ?? 0) + bytes)
  }

  /** What was relayed since the last drain, in reports of at most `max` Computers; none when nothing was. */
  drain(max: number): TurnUsageReport[] {
    const to = this.now()
    const from = this.since
    this.since = to
    const entries = [...this.bytes].map(([computerId, bytes]) => ({ computerId, bytes }))
    this.bytes = new Map()
    const reports: TurnUsageReport[] = []
    for (let i = 0; i < entries.length; i += max) {
      reports.push({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        entries: entries.slice(i, i + max)
      })
    }
    return reports
  }

  /** Put an unsent report back, so a link blip delays its bytes rather than losing them. */
  restore(report: TurnUsageReport): void {
    this.since = Math.min(this.since, Date.parse(report.from))
    for (const e of report.entries) this.add(e.computerId, e.bytes)
  }
}

/** The metrics with every relayed datagram also counted toward its Computer. */
export function meteredTurnMetrics(metrics: TurnMetrics, meter: TurnUsageMeter): TurnMetrics {
  return {
    ...metrics,
    relayed: (bytes, from, to) => {
      metrics.relayed(bytes, from, to)
      const computer = from.kind === 'computer' ? from : to.kind === 'computer' ? to : undefined
      if (computer?.computerId) meter.add(computer.computerId, bytes)
    }
  }
}
