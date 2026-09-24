import { describe, expect, it } from 'vitest'
import {
  UNPLACED,
  migratedExecution,
  placementStrategies,
  resolveExecution,
  type DaemonStrategyReport,
  type PlacementStrategies
} from './execution.js'

const NO_LEGACY = { supported: false, required: false }
const OFF = (reason: string) => ({ available: false as const, reason })
const ON = { available: true as const }

/** An S1 daemon on the default backend: `host` and `srt`, and microsandbox not configured. */
const SRT_DAEMON: DaemonStrategyReport = {
  strategies: { host: ON, srt: ON, microsandbox: OFF('microsandbox is not the configured sandbox backend') },
  sandboxBackend: 'srt',
  legacy: { supported: true, required: false }
}

/** A daemon that requires a sandbox and runs microsandbox. */
const VM_ONLY: DaemonStrategyReport = {
  strategies: {
    host: OFF('security.requireSandbox is set'),
    srt: OFF('srt is not the configured sandbox backend'),
    microsandbox: ON
  },
  sandboxBackend: 'microsandbox',
  legacy: { supported: true, required: true }
}

const table = (report: DaemonStrategyReport): PlacementStrategies => placementStrategies([report])

describe('the one-time migration of runInSandbox', () => {
  it('is host when unsandboxed, the reported backend when it is microsandbox, and srt otherwise', () => {
    expect(migratedExecution(false, 'microsandbox')).toBe('host')
    expect(migratedExecution(true, 'microsandbox')).toBe('microsandbox')
    expect(migratedExecution(true, 'srt')).toBe('srt')
    expect(migratedExecution(true, undefined)).toBe('srt')
  })
})

describe('the strategies a placement offers', () => {
  it('a group offers what at least one member offers, keeping the first reason for what nobody can run', () => {
    const merged = placementStrategies([VM_ONLY, SRT_DAEMON])
    expect(merged).toEqual({
      kind: 'table',
      table: { host: ON, srt: ON, microsandbox: ON },
      backend: 'microsandbox'
    })
    const none = placementStrategies([
      { strategies: { microsandbox: OFF('no /dev/kvm') }, legacy: NO_LEGACY },
      { strategies: { microsandbox: OFF('msb is missing') }, legacy: NO_LEGACY }
    ])
    expect(none).toEqual({ kind: 'table', table: { microsandbox: OFF('no /dev/kvm') } })
  })

  it('falls back to the legacy policy of the first member when no member reports a table', () => {
    expect(placementStrategies([{ legacy: { supported: true, required: true } }])).toEqual({
      kind: 'legacy',
      supported: true,
      required: true
    })
    expect(placementStrategies([])).toBe(UNPLACED)
  })
})

describe('resolving an ask against a placement that reports tables', () => {
  it('accepts an available strategy and keeps runInSandbox in step', () => {
    expect(resolveExecution(table(SRT_DAEMON), { execution: 'srt' })).toEqual({ execution: 'srt', runInSandbox: true })
    expect(resolveExecution(table(SRT_DAEMON), { execution: 'host' })).toEqual({
      execution: 'host',
      runInSandbox: false
    })
  })

  it('refuses an unavailable strategy with its probe’s reason, and one nobody offers', () => {
    expect(resolveExecution(table(SRT_DAEMON), { execution: 'microsandbox' })).toEqual({
      refused:
        'execution strategy "microsandbox" is unavailable where this agent is placed: microsandbox is not the configured sandbox backend'
    })
    expect(resolveExecution(table(SRT_DAEMON), { execution: 'docker' })).toEqual({
      refused: 'execution strategy "docker" is not offered where this agent is placed'
    })
    expect(resolveExecution(table(VM_ONLY), { runInSandbox: false })).toEqual({
      refused: 'execution strategy "host" is unavailable where this agent is placed: security.requireSandbox is set'
    })
  })

  it('reads the legacy boolean as the daemon’s backend, or the agent’s own sandbox when it already has one', () => {
    expect(resolveExecution(table(VM_ONLY), { runInSandbox: true })).toEqual({
      execution: 'microsandbox',
      runInSandbox: true
    })
    expect(resolveExecution(table(SRT_DAEMON), { runInSandbox: true })).toEqual({
      execution: 'srt',
      runInSandbox: true
    })
    expect(resolveExecution(table(SRT_DAEMON), { runInSandbox: false }, 'srt')).toEqual({
      execution: 'host',
      runInSandbox: false
    })
    // An agent already on a sandbox keeps it rather than being moved to the daemon's backend.
    const both = placementStrategies([{ ...SRT_DAEMON, strategies: { ...SRT_DAEMON.strategies, microsandbox: ON } }])
    expect(resolveExecution(both, { runInSandbox: true }, 'microsandbox')).toEqual({
      execution: 'microsandbox',
      runInSandbox: true
    })
  })

  it('defaults a create to host where host runs, and to the sandbox where it does not', () => {
    expect(resolveExecution(table(SRT_DAEMON), {})).toEqual({ execution: 'host', runInSandbox: false })
    expect(resolveExecution(table(VM_ONLY), {})).toEqual({ execution: 'microsandbox', runInSandbox: true })
    const down = placementStrategies([
      { ...VM_ONLY, strategies: { ...VM_ONLY.strategies, microsandbox: OFF('no /dev/kvm') } }
    ])
    expect(resolveExecution(down, {})).toEqual({
      refused: 'execution strategy "microsandbox" is unavailable where this agent is placed: no /dev/kvm'
    })
    expect(resolveExecution(placementStrategies([{ strategies: { host: OFF('x') }, legacy: NO_LEGACY }]), {})).toEqual({
      refused: 'no sandboxing strategy is offered where this agent is placed'
    })
  })
})

describe('resolving an ask against a daemon that reports no table', () => {
  const legacy = (policy: { supported: boolean; required: boolean }, backend?: string): PlacementStrategies =>
    placementStrategies([{ legacy: policy, ...(backend ? { sandboxBackend: backend } : {}) }])

  it('keeps today’s two refusals', () => {
    expect(resolveExecution(legacy({ supported: true, required: true }), { runInSandbox: false })).toEqual({
      refused: 'execution strategy "host" is unavailable where this agent is placed: its daemon requires a sandbox'
    })
    expect(resolveExecution(legacy(NO_LEGACY), { runInSandbox: true })).toEqual({
      refused: 'no sandbox is available where this agent is placed'
    })
    expect(resolveExecution(UNPLACED, { execution: 'srt' })).toEqual({
      refused: 'no sandbox is available where this agent is placed'
    })
  })

  it('leaves a sandboxed strategy unknown until the daemon reports its backend, and never forgets a known one', () => {
    const supported = { supported: true, required: false }
    expect(resolveExecution(legacy(supported), { runInSandbox: true })).toEqual({ execution: null, runInSandbox: true })
    expect(resolveExecution(legacy(supported, 'microsandbox'), { runInSandbox: true })).toEqual({
      execution: 'microsandbox',
      runInSandbox: true
    })
    expect(resolveExecution(legacy(supported), { runInSandbox: true }, 'microsandbox')).toEqual({
      execution: 'microsandbox',
      runInSandbox: true
    })
    expect(resolveExecution(legacy(supported), { execution: 'microsandbox' })).toEqual({
      execution: 'microsandbox',
      runInSandbox: true
    })
    expect(resolveExecution(legacy({ supported: true, required: true }), {})).toEqual({
      execution: null,
      runInSandbox: true
    })
    expect(resolveExecution(UNPLACED, {})).toEqual({ execution: 'host', runInSandbox: false })
  })
})
