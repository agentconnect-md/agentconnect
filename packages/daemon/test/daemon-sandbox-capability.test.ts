import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RegisterReq } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { agentHostKey } from '../src/acp/host-key.js'

// msb's install, which tests control rather than fetch.
const install = vi.fn(async (): Promise<unknown> => Promise.reject(new Error('tests install no msb')))

const AGENT_ID = 'bot-a'
const NO_KVM = 'microsandbox requires KVM, but this daemon cannot open /dev/kvm: the device is absent'

function scaffold(config: Record<string, unknown> = {}, agent: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-sandbox-cap-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { 'arbitrary-acp': { command: 'node', args: ['unused'] } },
      ...config
    })
  )
  const adir = join(root, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'arbitrary-acp',
      builtin: true,
      runInSandbox: true,
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' },
      ...agent
    })
  )
  return root
}

/** A daemon on a host with no SRT and no KVM unless the caller says otherwise; `hosts: false` keeps the real launch path. */
async function boot(
  opts: {
    root?: string
    srt?: boolean
    kvm?: boolean
    hosts?: boolean
  } = {}
): Promise<{ daemon: Record<string, any>; stop: () => Promise<void> }> {
  const daemon = new Daemon({
    root: opts.root ?? scaffold(),
    sandboxMechanism: opts.srt ? 'bwrap' : null,
    microsandboxHost: () => (opts.kvm ? undefined : NO_KVM),
    installMicrosandbox: install as never,
    ...(opts.hosts === false
      ? {}
      : { hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never })
  })
  await daemon.start()
  return { daemon: daemon as never as Record<string, any>, stop: () => daemon.stop().catch(() => {}) }
}

/** The record a VM model probe or session leaves, written by an earlier image. */
function recordImageModels(root: string, models: Record<string, string[]>): void {
  mkdirSync(join(root, 'microsandbox'), { recursive: true })
  writeFileSync(
    join(root, 'microsandbox', 'image-models.json'),
    JSON.stringify({
      version: 1,
      image: 'registry.example.test/runtime:previous',
      identity: 'linux/amd64@sha256:0',
      models
    })
  )
}

/** A prepared image with one runtime, a manager that removes VMs, and this machine's VM entry, standing in for msb and KVM. */
function probeMachine(daemon: Record<string, any>) {
  const manager = {
    recordModels: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    environmentIds: async () => []
  }
  const executor = {
    withEnvironment: vi.fn(async (_environment: unknown, work: () => Promise<unknown>) => await work()),
    driverFor: vi.fn(() => ({ launch: vi.fn() })),
    stop: vi.fn(async () => {})
  }
  daemon.microsandbox = manager
  daemon.localExecutor = executor
  daemon.microsandboxCatalog = {
    entries: {
      'arbitrary-acp': { name: 'arbitrary-acp', version: '1.0.0', runtime: { command: 'image-acp', args: [], env: [] } }
    },
    runtimes: {}
  }
  return { manager, executor }
}

/** Probe hosts that answer with these models, or fail with this error. */
function probeHosts(models: Record<string, string[] | Error>) {
  return (_rt: unknown, id: string) => ({
    start: async () => {
      if (models[id] instanceof Error) throw models[id]
    },
    newSession: async () => 'probe-session',
    modelOptions: () => {
      const answer = models[id]
      return Array.isArray(answer) ? { current: answer[0], models: answer } : null
    },
    acpProtocolVersion: () => 1,
    stop: async () => {}
  })
}

function registers(capabilities: Record<string, unknown>): boolean {
  return RegisterReq.safeParse({
    host: 'example-host',
    capabilities: { platforms: [], runtimes: [], acp: true, features: [], ...capabilities },
    maxAgents: 1,
    localState: { assignments: [], crons: [], leases: [] }
  }).success
}

describe('the strategy table a daemon reports for its own sessions', () => {
  it('offers every strategy by default, each unavailable one with its probe’s reason', async () => {
    const { daemon, stop } = await boot()
    try {
      expect(daemon.strategyTable()).toEqual({
        host: { available: true },
        srt: { available: false, reason: 'this host has no supported SRT mechanism' },
        microsandbox: { available: false, reason: NO_KVM }
      })
      expect(registers({ strategies: daemon.strategyTable(), sandboxBackend: 'srt' })).toBe(true)
    } finally {
      await stop()
    }
  })

  it('makes a probed microsandbox available without installing or pulling anything', async () => {
    const root = scaffold({ sandbox: { microsandbox: { image: 'registry.example.test/runtime:dev' } } })
    const { daemon, stop } = await boot({ root, srt: true, kvm: true })
    try {
      expect(daemon.strategyTable()).toEqual({
        host: { available: true },
        srt: { available: true },
        microsandbox: { available: true }
      })
      // No msb in this root's store yet: the first session installs it and prepares the image.
      expect(daemon.microsandbox).toBeUndefined()
      expect(readdirSync(root)).not.toContain('runtimes')
    } finally {
      await stop()
    }
  })

  it('names a source build’s missing image as the reason, before any session asks', async () => {
    const { daemon, stop } = await boot({ kvm: true })
    try {
      expect(daemon.strategyTable().microsandbox).toEqual({
        available: false,
        reason: 'sandbox.microsandbox.image is required for a build without release image metadata'
      })
    } finally {
      await stop()
    }
  })

  it('withdraws what the table turns off, and names it by its key', async () => {
    const { daemon, stop } = await boot({
      root: scaffold({ sandbox: { host: true, srt: false, microsandbox: false } }),
      srt: true,
      kvm: true
    })
    try {
      expect(daemon.strategyTable()).toEqual({
        host: { available: true },
        srt: { available: false, reason: 'sandbox.srt is off on this daemon' },
        microsandbox: { available: false, reason: 'sandbox.microsandbox is off on this daemon' }
      })
      // A withdrawn srt confines nothing, not even a probe.
      expect(daemon.sandboxMechanism).toBeUndefined()
    } finally {
      await stop()
    }
  })

  it('refuses to start when nothing in the table can run', async () => {
    const daemon = new Daemon({
      root: scaffold({ sandbox: { host: false } }),
      sandboxMechanism: null,
      microsandboxHost: () => NO_KVM,
      hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never
    })
    await expect(daemon.start()).rejects.toThrow(
      'no execution strategy can run on this machine (host: sandbox.host is off on this daemon; srt: this host has no supported SRT mechanism; microsandbox: '
    )
    await daemon.stop().catch(() => {})
  })

  it('reads the retiring keys once, with a warning, as the default table', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { daemon, stop } = await boot({
      root: scaffold({ sandbox: { backend: 'microsandbox' }, security: { requireSandbox: true } }),
      srt: true
    })
    try {
      const lines = stderr.mock.calls.map(([line]) => String(line))
      expect(lines.some((line) => line.includes('sandbox.backend is retired'))).toBe(true)
      expect(
        lines.some((line) => line.includes('security.requireSandbox is retired and read as sandbox.host: false'))
      ).toBe(true)
      expect(daemon.strategyTable().host).toEqual({ available: false, reason: 'sandbox.host is off on this daemon' })
      expect(daemon.strategyTable().srt).toEqual({ available: true })
      // Kept only as what the Control Plane migrates `runInSandbox` from.
      expect(daemon.cfg.sandbox.backend).toBe('microsandbox')
      expect(daemon.registrationFeatures()).toEqual(expect.arrayContaining(['sandbox', 'sandbox-required']))
    } finally {
      stderr.mockRestore()
      await stop()
    }
  })
})

describe('the sandbox a daemon reports to a console without the strategy picker', () => {
  it('claims the capability only where a sandboxing strategy can run', async () => {
    const confined = await boot({ srt: true })
    try {
      expect(confined.daemon.registrationFeatures()).toContain('sandbox')
      expect(confined.daemon.sandboxUnavailableReason()).toBeUndefined()
    } finally {
      await confined.stop()
    }
  })

  it('says why every offered sandbox is out, bounded to fit the register frame', async () => {
    const { daemon, stop } = await boot()
    try {
      daemon.microsandboxFailure = `boom ${'x'.repeat(4000)}\n    at Object.run (/opt/daemon/dist/index.js:1:1)`
      const unavailable: string = daemon.sandboxUnavailableReason()
      expect(daemon.registrationFeatures()).not.toContain('sandbox')
      expect(unavailable).toContain('srt: this host has no supported SRT mechanism; microsandbox: boom')
      expect(unavailable.length).toBeLessThanOrEqual(500)
      // Stack frames are log material, not console material.
      expect(unavailable).not.toContain('at Object.run')
      expect(registers({ features: daemon.registrationFeatures(), sandboxUnavailable: unavailable })).toBe(true)
    } finally {
      await stop()
    }
  })
})

describe('a session in a strategy this machine cannot run', () => {
  /** Builds the agent's host on the real launch path, which refuses before anything spawns; undefined ⇒ it was built. */
  async function launch(
    agent: Record<string, unknown>,
    config: Record<string, unknown> = {},
    host: { srt?: boolean } = {}
  ): Promise<Error | undefined> {
    const { daemon, stop } = await boot({ root: scaffold(config, agent), hosts: false, ...host })
    try {
      const loaded = daemon.agents.get(AGENT_ID)
      daemon.buildAcpHost(loaded, daemon.cfg, {
        hostKey: agentHostKey(AGENT_ID),
        strategy: daemon.agentStrategy(loaded),
        cwd: loaded.workspace.path
      })
      return undefined
    } catch (error) {
      return error as Error
    } finally {
      await stop()
    }
  }

  it('is refused with the probe’s reason instead of running unconfined', async () => {
    const error = await launch({ runInSandbox: false, execution: 'srt' })
    expect(error?.message).toBe(
      `agent "${AGENT_ID}" runs its sessions in the srt strategy, which this daemon cannot run: this host has no supported SRT mechanism`
    )
  })

  it('reads an unmigrated agent’s runInSandbox, and refuses it the same way', async () => {
    expect((await launch({ runInSandbox: true }))?.message).toContain(
      'in the srt strategy, which this daemon cannot run'
    )
  })

  it('refuses a host session where host is withdrawn, and a strategy this daemon has never heard of', async () => {
    const withdrawn = await launch({ execution: 'host' }, { sandbox: { host: false } }, { srt: true })
    expect(withdrawn?.message).toContain('in the host strategy, which this daemon cannot run: sandbox.host is off')
    const unknown = await launch({ execution: 'docker' })
    expect(unknown?.message).toContain('this daemon has no "docker" execution strategy')
  })

  it('launches a host session where host is offered', async () => {
    expect(await launch({ runInSandbox: false, execution: 'host' })).toBeUndefined()
  })
})

describe('a runtime under each strategy this machine offers', () => {
  const IMAGE = { microsandbox: { image: 'registry.example.test/runtime:test' } }

  it('reports the host probe’s models for host and srt, and none for a VM whose image is not read yet', async () => {
    const { daemon, stop } = await boot({ root: scaffold({ sandbox: IMAGE }), srt: true, kvm: true })
    try {
      daemon.runtimeFacts.models.set('arbitrary-acp', ['m-1'])
      daemon.runtimeFacts.modelsSource.set('arbitrary-acp', 'probed')
      const probed = { available: true, models: ['m-1'], modelsSource: 'probed' }
      expect(daemon.runtimeFacts.profileFor('arbitrary-acp').strategies).toEqual({
        host: probed,
        srt: probed,
        // The on-by-default probe boots no VM, so the image's models wait for its own probe; absent stays permissive.
        microsandbox: { available: true }
      })
      // Once this run has read the image, a runtime it lacks is unavailable there alone.
      daemon.microsandboxCatalog = { entries: {}, runtimes: {} }
      expect(daemon.runtimeFacts.profileFor('arbitrary-acp').strategies.microsandbox).toEqual({
        available: false,
        unavailableReason: 'the microsandbox image does not provide this runtime'
      })
    } finally {
      await stop()
    }
  })

  it('names the models the image advertised in this machine’s own VM, and reads a recorded list as cached', async () => {
    const root = scaffold({ sandbox: IMAGE })
    const { daemon, stop } = await boot({ root, srt: true, kvm: true })
    const recordModels = vi.fn(async () => {})
    try {
      daemon.microsandbox = { recordModels, environmentIds: async () => [] }
      daemon.microsandboxCatalog = { entries: { 'arbitrary-acp': { name: 'arbitrary-acp' } }, runtimes: {} }
      const vm = () => daemon.runtimeFacts.profileFor('arbitrary-acp').strategies.microsandbox
      // Read back at startup without a VM, and permissive until this run's own session confirms it.
      recordImageModels(root, { 'arbitrary-acp': ['m-recorded'] })
      await daemon.loadMicrosandboxModels(root)
      expect(vm()).toEqual({ available: true, models: ['m-recorded'], modelsSource: 'cached' })
      const advertised = ['m-vm', 'm-recorded']
      const host = { modelOptions: () => ({ current: 'm-vm', models: advertised }) }
      const run = { key: 'example-session', agent: daemon.agents.get(AGENT_ID) }
      // A host that runs on this machine's host install is no probe of the image.
      await daemon.captureTurnModel(run, host, 'acp-1', undefined)
      expect(vm()).toMatchObject({ models: ['m-recorded'], modelsSource: 'cached' })
      daemon.imageRuntimeHosts.set(host, 'arbitrary-acp')
      await daemon.captureTurnModel(run, host, 'acp-1', undefined)
      expect(vm()).toEqual({ available: true, models: advertised, modelsSource: 'probed' })
      expect(recordModels).toHaveBeenCalledWith('arbitrary-acp', advertised)
      // Later turns advertising the same list record nothing more; the host entry keeps the host probe's list.
      await daemon.captureTurnModel(run, host, 'acp-1', undefined)
      expect(recordModels).toHaveBeenCalledOnce()
      expect(daemon.runtimeFacts.profileFor('arbitrary-acp').strategies.host).not.toHaveProperty('models', advertised)
    } finally {
      daemon.microsandbox = undefined
      await stop()
    }
  })

  it('starts from the previous image’s lists after an upgrade, before msb is even installed', async () => {
    const root = scaffold({ sandbox: IMAGE })
    recordImageModels(root, { 'arbitrary-acp': ['m-previous'] })
    const { daemon, stop } = await boot({ root, srt: true, kvm: true })
    try {
      expect(daemon.microsandbox).toBeUndefined()
      expect(daemon.runtimeFacts.profileFor('arbitrary-acp').strategies.microsandbox).toEqual({
        available: true,
        models: ['m-previous'],
        modelsSource: 'cached'
      })
    } finally {
      await stop()
    }
  })

  it('probes the image’s runtimes in a VM where the strategy is available, replacing a carried list', async () => {
    const root = scaffold({ sandbox: IMAGE })
    recordImageModels(root, { 'arbitrary-acp': ['m-previous'] })
    const { daemon, stop } = await boot({ root, srt: true, kvm: true })
    const vm = () => daemon.runtimeFacts.profileFor('arbitrary-acp').strategies.microsandbox
    const { manager, executor } = probeMachine(daemon)
    try {
      daemon.opts.probeHostFactory = probeHosts({ 'arbitrary-acp': ['m-image-1', 'm-image-2'] })
      daemon.startMicrosandboxModelProbe()
      await vi.waitFor(() =>
        expect(vm()).toEqual({ available: true, models: ['m-image-1', 'm-image-2'], modelsSource: 'probed' })
      )
      expect(manager.recordModels).toHaveBeenCalledWith('arbitrary-acp', ['m-image-1', 'm-image-2'])
      // The image's own runtime, in one VM this probe started, and removed again.
      expect(executor.withEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'probe/models' }),
        expect.any(Function)
      )
      await vi.waitFor(() => expect(manager.discard).toHaveBeenCalledTimes(2))
      // Once a run.
      daemon.startMicrosandboxModelProbe()
      expect(executor.withEnvironment).toHaveBeenCalledOnce()
    } finally {
      daemon.microsandbox = undefined
      await stop()
    }
  })

  it('keeps the carried list when the runtime fails in the VM', async () => {
    const root = scaffold({ sandbox: IMAGE })
    recordImageModels(root, { 'arbitrary-acp': ['m-previous'] })
    const { daemon, stop } = await boot({ root, srt: true, kvm: true })
    const { manager } = probeMachine(daemon)
    try {
      daemon.opts.probeHostFactory = probeHosts({ 'arbitrary-acp': new Error('adapter exited') })
      daemon.startMicrosandboxModelProbe()
      await vi.waitFor(() => expect(manager.discard).toHaveBeenCalledTimes(2))
      expect(daemon.runtimeFacts.profileFor('arbitrary-acp').strategies.microsandbox).toEqual({
        available: true,
        models: ['m-previous'],
        modelsSource: 'cached'
      })
      expect(manager.recordModels).not.toHaveBeenCalled()
    } finally {
      daemon.microsandbox = undefined
      await stop()
    }
  })

  it('adopts no manager and prepares no image once shutdown began during the msb install', async () => {
    const { daemon, stop } = await boot({ root: scaffold({ sandbox: IMAGE }), srt: true, kvm: true })
    const manager = { recover: vi.fn(async () => {}), prepare: vi.fn(), stopAll: vi.fn(async () => {}) }
    let installed!: (value: unknown) => void
    install.mockImplementationOnce(() => new Promise((resolve) => (installed = resolve)))
    daemon.opts.probeHostFactory = probeHosts({})
    daemon.startMicrosandboxModelProbe()
    await vi.waitFor(() => expect(install).toHaveBeenCalled())
    await stop()
    installed(manager)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(daemon.microsandbox).toBeUndefined()
    expect(manager.recover).not.toHaveBeenCalled()
    expect(manager.prepare).not.toHaveBeenCalled()
  })

  it('prepares no image once shutdown began while the manager recovered', async () => {
    const { daemon, stop } = await boot({ root: scaffold({ sandbox: IMAGE }), srt: true, kvm: true })
    let recovered!: () => void
    const manager = {
      recover: vi.fn(() => new Promise<void>((resolve) => (recovered = resolve))),
      prepare: vi.fn(),
      stopAll: vi.fn(async () => {})
    }
    daemon.microsandbox = manager
    daemon.opts.probeHostFactory = probeHosts({})
    daemon.startMicrosandboxModelProbe()
    await vi.waitFor(() => expect(manager.recover).toHaveBeenCalled())
    await stop()
    expect(manager.stopAll).toHaveBeenCalled()
    recovered()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(manager.prepare).not.toHaveBeenCalled()
  })

  it('probes no VM where microsandbox is unavailable or withdrawn', async () => {
    for (const setup of [
      { root: scaffold({ sandbox: IMAGE }), srt: true },
      { root: scaffold({ sandbox: { microsandbox: false } }), srt: true, kvm: true }
    ]) {
      const { daemon, stop } = await boot(setup)
      try {
        daemon.opts.probeHostFactory = probeHosts({})
        daemon.startMicrosandboxModelProbe()
        expect(daemon.vmModelProbe).toBeUndefined()
        expect(daemon.microsandboxReadiness).toBeUndefined()
      } finally {
        await stop()
      }
    }
  })

  it('carries an unavailable strategy’s reason and leaves out a withdrawn one', async () => {
    const { daemon, stop } = await boot({ root: scaffold({ sandbox: { srt: false } }) })
    try {
      expect(daemon.runtimeFacts.profileFor('arbitrary-acp').strategies).toEqual({
        host: { available: true },
        microsandbox: { available: false, unavailableReason: NO_KVM }
      })
    } finally {
      await stop()
    }
  })
})

describe('microsandbox state left by an earlier run', () => {
  async function startupWarnings(bindings?: string[], root = scaffold()): Promise<string[]> {
    if (bindings) {
      mkdirSync(join(root, 'microsandbox', 'bindings'), { recursive: true })
      for (const file of bindings) writeFileSync(join(root, 'microsandbox', 'bindings', file), '{}')
    }
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { stop } = await boot({ root })
      await stop()
      return stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('microsandbox state'))
    } finally {
      stderr.mockRestore()
    }
  }

  it('warns once, with the environment count and why, and deletes nothing', async () => {
    const root = scaffold()
    const warnings = await startupWarnings(['msb-a.json', 'msb-b.json', 'msb-a.json.tmp'], root)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`${join(root, 'microsandbox')} (2 environment(s))`)
    expect(warnings[0]).toContain(NO_KVM)
    expect(warnings[0]).toContain('remove that directory')
    expect(readdirSync(join(root, 'microsandbox', 'bindings'))).toHaveLength(3)
  })

  it('stays silent when no binding remains', async () => {
    expect(await startupWarnings()).toEqual([])
    expect(await startupWarnings([])).toEqual([])
  })
})
