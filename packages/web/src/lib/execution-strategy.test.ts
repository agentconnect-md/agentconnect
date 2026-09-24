import { describe, expect, it } from 'vitest'
import type { DaemonCaps, DaemonRow, StrategyTable } from '@/lib/data'
import {
  agentStrategies,
  agentStrategyValue,
  daemonStrategies,
  DEFAULT_SANDBOX_STRATEGY,
  defaultStrategy,
  executionAsk,
  groupStrategies,
  LEGACY_SANDBOX,
  sortStrategies,
  strategyNameKey,
  strategyOptions,
  strategyRuntimeModels,
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

describe('what the console calls a strategy', () => {
  it('calls the default process sandbox and a legacy daemon’s sandbox “Sandbox”, and every other known one by its own name', () => {
    expect(DEFAULT_SANDBOX_STRATEGY).toBe('srt')
    expect(strategyNameKey('host')).toBe('host')
    expect(strategyNameKey('srt')).toBe('sandbox')
    expect(strategyNameKey(LEGACY_SANDBOX)).toBe('sandbox')
    expect(strategyNameKey('microsandbox')).toBe('microsandbox')
    expect(strategyNameKey('docker')).toBe('docker')
  })

  it('moves “Sandbox” to whichever strategy is the default, and srt keeps its own name', () => {
    expect(strategyNameKey('docker', 'docker')).toBe('sandbox')
    expect(strategyNameKey('srt', 'docker')).toBe('srt')
  })

  it('has no name for a slug it does not know, which shows as itself', () => {
    expect(strategyNameKey('firecracker')).toBeUndefined()
  })

  it('orders host, the sandbox and the VM first, then any other by slug', () => {
    expect(sortStrategies(['zeta', 'microsandbox', 'alpha', 'srt', 'host'])).toEqual([
      'host',
      'srt',
      'microsandbox',
      'alpha',
      'zeta'
    ])
  })
})

describe('the runtimes one strategy starts', () => {
  type Runtime = DaemonRow['runtimeModels'][number]
  const claude: Runtime = {
    runtime: 'claude',
    version: '9.0.0',
    hostVersion: '2.0.0',
    models: ['host-model'],
    strategies: {
      host: { available: true, models: ['host-model'], modelsSource: 'probed' },
      srt: { available: true, models: ['host-model'], modelsSource: 'cached' },
      microsandbox: { available: true }
    }
  }
  const codex: Runtime = {
    runtime: 'codex',
    version: '3.0.0',
    hostVersion: '3.0.0',
    models: [],
    credentialsConfigured: true,
    strategies: {
      host: { available: true, models: ['codex-model'] },
      srt: { available: true, models: ['codex-model'] },
      microsandbox: { available: false, unavailableReason: 'the image does not provide this runtime' }
    }
  }

  it('reads each runtime’s entry for the strategy: its models there, and the install that strategy starts', () => {
    expect(strategyRuntimeModels([claude, codex], 'srt').map((rt) => [rt.runtime, rt.version, rt.models])).toEqual([
      ['claude', '2.0.0', ['host-model']],
      ['codex', '3.0.0', ['codex-model']]
    ])
  })

  it('shows a VM entry whose models are not probed yet as an empty list, the image’s version beside it', () => {
    const [vm] = strategyRuntimeModels([claude], 'microsandbox')
    expect(vm).toMatchObject({ runtime: 'claude', version: '9.0.0', models: [], unavailableReason: null })
  })

  it('keeps a runtime the strategy cannot start listed while it may hold a login, and drops it once it has none', () => {
    expect(strategyRuntimeModels([codex], 'microsandbox')).toMatchObject([
      { runtime: 'codex', version: '', models: [], unavailableReason: 'image-binary-missing' }
    ])
    // The VM entry speaks for the image, whatever the runtime-level reading says about the host.
    expect(
      strategyRuntimeModels([{ ...codex, unavailableReason: 'host-binary-missing' }], 'microsandbox')
    ).toMatchObject([{ unavailableReason: 'image-binary-missing' }])
    const hostless: Runtime = { ...codex, strategies: { host: { available: false }, srt: { available: false } } }
    expect(strategyRuntimeModels([hostless], 'srt')).toMatchObject([{ unavailableReason: 'host-binary-missing' }])
    expect(strategyRuntimeModels([{ ...codex, credentialsConfigured: false }], 'microsandbox')).toEqual([])
  })

  it('reads a daemon that predates the entries as the host or image install', () => {
    const legacy: Runtime = { ...claude, strategies: null, unavailableReason: 'image-binary-missing' }
    expect(strategyRuntimeModels([legacy], 'host')).toMatchObject([{ version: '2.0.0', unavailableReason: null }])
    expect(strategyRuntimeModels([legacy], LEGACY_SANDBOX)).toMatchObject([
      { version: '', models: ['host-model'], unavailableReason: 'image-binary-missing' }
    ])
  })
})
