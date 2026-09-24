import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RegisterReq } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { agentHostKey } from '../src/acp/host-key.js'

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
    ...(opts.hosts === false
      ? {}
      : { hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never })
  })
  await daemon.start()
  return { daemon: daemon as never as Record<string, any>, stop: () => daemon.stop().catch(() => {}) }
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
