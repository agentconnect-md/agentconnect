import { describe, expect, it } from 'vitest'
import type { DaemonCaps, StrategyTable } from '@/lib/data'
import {
  agentStrategies,
  agentStrategyValue,
  daemonStrategies,
  defaultStrategy,
  executionAsk,
  groupStrategies,
  LEGACY_SANDBOX,
  strategyOptions,
  strategyUsesImage
} from './execution-strategy'

const caps = (extra: Partial<DaemonCaps> = {}): DaemonCaps => ({
  platforms: [],
  runtimes: [],
  acp: true,
  features: [],
  ...extra
})

const KVM = 'microsandbox needs a usable /dev/kvm'
const TABLE: StrategyTable = {
  microsandbox: { available: false, reason: KVM },
  host: { available: true },
  srt: { available: true }
}

describe('what a placement offers the picker', () => {
  it('lists a daemon’s own table weakest boundary first, an unavailable strategy with its probe’s reason', () => {
    expect(strategyOptions(daemonStrategies(caps({ strategies: TABLE })))).toEqual([
      { value: 'host', available: true },
      { value: 'srt', available: true },
      { value: 'microsandbox', available: false, reason: KVM }
    ])
  })

  it('offers for a group what at least one serving member offers', () => {
    const placement = groupStrategies([
      caps({ strategies: { host: { available: true }, microsandbox: { available: false, reason: KVM } } }),
      caps({
        strategies: { srt: { available: false, reason: 'no bwrap on edge-2' }, microsandbox: { available: true } }
      }),
      caps()
    ])
    expect(strategyOptions(placement)).toEqual([
      { value: 'host', available: true },
      { value: 'srt', available: false, reason: 'no bwrap on edge-2' },
      { value: 'microsandbox', available: true }
    ])
  })

  it('shows no picker on the pool, whose boundary is the pod', () => {
    expect(strategyOptions({ kind: 'pool' })).toEqual([])
    expect(
      strategyOptions(agentStrategies({ strategies: TABLE, sandboxSupported: false, sandboxRequired: false }, true))
    ).toEqual([])
    expect(executionAsk({ kind: 'pool' }, 'host')).toEqual({})
  })

  it('reads the sandbox features of a daemon that predates the table', () => {
    expect(strategyOptions(daemonStrategies(caps({ features: ['sandbox'] })))).toEqual([
      { value: 'host', available: true },
      { value: LEGACY_SANDBOX, available: true }
    ])
    expect(strategyOptions(daemonStrategies(caps({ features: ['sandbox-required'] })))).toEqual([
      { value: 'host', available: false, refusal: 'sandboxRequired' },
      { value: LEGACY_SANDBOX, available: true }
    ])
    expect(strategyOptions(daemonStrategies(caps({ features: ['sandbox'], sandboxUnavailable: KVM })))).toEqual([
      { value: 'host', available: true },
      { value: LEGACY_SANDBOX, available: false, reason: KVM }
    ])
    // A group none of whose members reports a table speaks through its first member, as the Control Plane reads it.
    expect(groupStrategies([caps(), caps({ features: ['sandbox'] })])).toEqual(daemonStrategies(caps()))
    expect(strategyOptions(daemonStrategies(undefined))).toEqual([{ value: 'host', available: true }])
  })

  it('reads an agent’s placement from the table the Control Plane projected, else from its sandbox fields', () => {
    const agent = { strategies: TABLE, sandboxSupported: true, sandboxRequired: false }
    expect(agentStrategies(agent, false)).toEqual({ kind: 'table', table: TABLE })
    expect(agentStrategies({ ...agent, strategies: null, sandboxUnavailable: KVM }, false)).toEqual({
      kind: 'legacy',
      sandbox: { supported: true, required: false, unavailable: KVM }
    })
  })

  it('keeps the current choice listed where the placement no longer offers it', () => {
    const placement = daemonStrategies(caps({ strategies: { host: { available: true } } }))
    expect(strategyOptions(placement, 'microsandbox')).toEqual([
      { value: 'host', available: true },
      { value: 'microsandbox', available: false, refusal: 'notOffered' }
    ])
    expect(strategyOptions(placement, 'host')).toEqual([{ value: 'host', available: true }])
  })
})

describe('the choice and its request', () => {
  it('defaults a new agent to host where it can run, else the first available sandbox', () => {
    expect(defaultStrategy(strategyOptions(daemonStrategies(caps({ strategies: TABLE }))))).toBe('host')
    const noHost = { ...TABLE, host: { available: false as const, reason: 'sandbox.host is false' } }
    expect(defaultStrategy(strategyOptions(daemonStrategies(caps({ strategies: noHost }))))).toBe('srt')
    expect(defaultStrategy([{ value: 'srt', available: false, reason: 'no bwrap' }])).toBeUndefined()
  })

  it('names the slug where the placement reports a table, and the legacy boolean where it does not', () => {
    expect(executionAsk(daemonStrategies(caps({ strategies: TABLE })), 'srt')).toEqual({ execution: 'srt' })
    expect(executionAsk(daemonStrategies(caps({ strategies: TABLE })), 'host')).toEqual({ execution: 'host' })
    const legacy = daemonStrategies(caps({ features: ['sandbox'] }))
    expect(executionAsk(legacy, LEGACY_SANDBOX)).toEqual({ runInSandbox: true })
    expect(executionAsk(legacy, 'host')).toEqual({ runInSandbox: false })
    // The legacy sandbox is never sent as a slug, even to a placement that now reports a table.
    expect(executionAsk(daemonStrategies(caps({ strategies: TABLE })), LEGACY_SANDBOX)).toEqual({ runInSandbox: true })
  })

  it('applies the image’s runtime warnings only to a strategy that starts the image’s install', () => {
    expect(strategyUsesImage('microsandbox')).toBe(true)
    // An unreported backend may be the VM, as the old toggle read it.
    expect(strategyUsesImage(LEGACY_SANDBOX)).toBe(true)
    // `srt` confines the host's install, so an image-only binary gap says nothing about it.
    expect(strategyUsesImage('srt')).toBe(false)
    expect(strategyUsesImage('host')).toBe(false)
  })

  it('reads an agent’s stored strategy, or the legacy sandbox while its backend is unreported', () => {
    expect(agentStrategyValue({ execution: 'microsandbox', runInSandbox: true })).toBe('microsandbox')
    expect(agentStrategyValue({ execution: null, runInSandbox: true })).toBe(LEGACY_SANDBOX)
    expect(agentStrategyValue({ runInSandbox: false })).toBe('host')
  })
})
