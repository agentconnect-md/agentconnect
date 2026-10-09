import { describe, expect, it } from 'vitest'
import { UNPLACED, placementStrategies, resolveExecution, type DaemonStrategyReport } from './execution.js'

const OFF = (reason: string) => ({ available: false as const, reason })
const ON = { available: true as const }

/** A daemon whose KVM probe failed: `host` and `srt` run, microsandbox does not. */
const SRT_DAEMON: DaemonStrategyReport = {
  strategies: { host: ON, srt: ON, microsandbox: OFF('no usable /dev/kvm') }
}

/** A daemon that offers no `host` and runs microsandbox. */
const VM_ONLY: DaemonStrategyReport = {
  strategies: { host: OFF('sandbox.host is off on this daemon'), srt: OFF('bwrap is missing'), microsandbox: ON }
}

const table = (report: DaemonStrategyReport) => placementStrategies([report])

describe('the strategies a placement offers', () => {
  it('a group offers what at least one member offers, keeping the first reason for what nobody can run', () => {
    expect(placementStrategies([VM_ONLY, SRT_DAEMON])).toEqual({ host: ON, srt: ON, microsandbox: ON })
    const none = placementStrategies([
      { strategies: { microsandbox: OFF('no /dev/kvm') } },
      { strategies: { microsandbox: OFF('msb is missing') } }
    ])
    expect(none).toEqual({ microsandbox: OFF('no /dev/kvm') })
  })

  it('offers only the direct child when no member reports a table, as for an unplaced agent', () => {
    expect(placementStrategies([{}])).toBe(UNPLACED)
    expect(placementStrategies([])).toBe(UNPLACED)
    expect(UNPLACED).toEqual({ host: ON })
  })
})

describe('resolving an ask against a placement', () => {
  it('accepts an available strategy', () => {
    expect(resolveExecution(table(SRT_DAEMON), 'srt')).toEqual({ execution: 'srt' })
    expect(resolveExecution(table(SRT_DAEMON), 'host')).toEqual({ execution: 'host' })
    expect(resolveExecution(table(VM_ONLY), 'microsandbox')).toEqual({ execution: 'microsandbox' })
  })

  it('refuses an unavailable strategy with its probe’s reason, and one nobody offers', () => {
    expect(resolveExecution(table(SRT_DAEMON), 'microsandbox')).toEqual({
      refused: 'execution strategy "microsandbox" is unavailable where this agent is placed: no usable /dev/kvm'
    })
    expect(resolveExecution(table(SRT_DAEMON), 'docker')).toEqual({
      refused: 'execution strategy "docker" is not offered where this agent is placed'
    })
    expect(resolveExecution(table(VM_ONLY), 'host')).toEqual({
      refused: 'execution strategy "host" is unavailable where this agent is placed: sandbox.host is off on this daemon'
    })
    expect(resolveExecution(UNPLACED, 'srt')).toEqual({
      refused: 'execution strategy "srt" is not offered where this agent is placed'
    })
  })

  it('defaults a create to host where host runs, and to the first available sandbox where it does not', () => {
    expect(resolveExecution(table(SRT_DAEMON), undefined)).toEqual({ execution: 'host' })
    expect(resolveExecution(UNPLACED, undefined)).toEqual({ execution: 'host' })
    expect(resolveExecution(table(VM_ONLY), undefined)).toEqual({ execution: 'microsandbox' })
    const down = placementStrategies([{ strategies: { ...VM_ONLY.strategies, microsandbox: OFF('no /dev/kvm') } }])
    expect(resolveExecution(down, undefined)).toEqual({
      refused: 'execution strategy "host" is unavailable where this agent is placed: sandbox.host is off on this daemon'
    })
    expect(resolveExecution(placementStrategies([{ strategies: {} }]), undefined)).toEqual({
      refused: 'no execution strategy is available where this agent is placed'
    })
  })
})
