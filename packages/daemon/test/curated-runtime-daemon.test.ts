import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Daemon } from '../src/daemon.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import { FakeClock } from './cp/fake-clock.js'

// vi.waitFor defaults to a 1000ms budget — too tight on a loaded CI runner, where a
// cold session boot (workspace + host + session/new) can stall well past a second.
// Give every poll in this file the same generous budget instead.
const WAIT = { timeout: 10_000 }

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'ac-curated-daemon-'))
  writeFileSync(join(path, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  return path
}

function catalog(): ResolvedRuntimeCatalog {
  const hermes = { command: 'hermes', args: ['acp'], env: [] }
  const explicit = { command: 'custom-acp', args: [], env: [] }
  return {
    entries: {
      'hermes-agent': { runtime: hermes, source: 'curated', name: 'Hermes Agent', version: '' },
      explicit: { runtime: explicit, source: 'user', name: 'explicit', version: '' }
    },
    runtimes: { 'hermes-agent': hermes, explicit }
  }
}

async function waitForProbe(daemon: Daemon, probe: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(probe).toHaveBeenCalled(), WAIT)
  await vi.waitFor(() => expect((daemon as any).probing).toBe(false), WAIT)
}

describe('daemon curated runtime admission', () => {
  it.each([
    [true, ['explicit', 'hermes-agent']],
    [false, ['explicit']]
  ])(
    'runs while CP is disabled and exposes only admitted winners (ok=%s)',
    async (ok, expected) => {
      const probe = vi.fn(async (runtimes: Record<string, unknown>, options: { curated?: boolean }) =>
        Object.keys(runtimes).map((runtime) => ({
          runtime,
          ok: runtime === 'hermes-agent' ? ok : true,
          models: [],
          ...(!ok && runtime === 'hermes-agent' ? { error: 'initialize failed' } : {})
        }))
      )
      const daemon = new Daemon({
        root: root(),
        resolveCatalog: async () => catalog(),
        installed: (runtimes) => runtimes,
        probeRuntimes: probe as never,
        hostFactory: () => ({}) as never
      })

      try {
        await daemon.start()
        await waitForProbe(daemon, probe)
        await vi.waitFor(() => expect(Object.keys((daemon as any).runtimes).sort()).toEqual(expected.sort()), WAIT)
        expect(probe.mock.calls.some(([, options]) => options.curated === true)).toBe(true)

        const calls = probe.mock.calls.length
        await (daemon as any).probeRuntimesAndEmit(false)
        expect(probe).toHaveBeenCalledTimes(calls)
      } finally {
        await daemon.stop()
      }
    },
    15_000
  )

  it('probes and admits a curated runtime UNSANDBOXED on a host with no sandbox mechanism (#36)', async () => {
    // Regression: the probe used to be skipped on a no-sandbox host, so curated
    // runtimes were never admitted and their agents could not run there. With no
    // injected probe and no hostFactory this exercises the REAL probe path.
    const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs')
    const runtime = { command: process.execPath, args: [fakeAgent], env: [] }
    const daemon = new Daemon({
      root: root(),
      sandboxMechanism: null,
      resolveCatalog: async () => ({
        entries: { 'hermes-agent': { runtime, source: 'curated', name: 'Hermes Agent', version: '' } },
        runtimes: { 'hermes-agent': runtime }
      }),
      installed: (runtimes) => runtimes
    })
    try {
      await daemon.start()
      // The real probe runs unconfined instead of skipping, so the curated runtime
      // is admitted (recorded) and becomes launchable.
      await vi.waitFor(() => expect(Object.keys((daemon as any).runtimes)).toContain('hermes-agent'), {
        timeout: 10_000
      })
    } finally {
      await daemon.stop()
    }
  }, 20_000)

  it('reports an auth-required curated runtime with the login warning without admitting it', async () => {
    const probe = vi.fn(async (runtimes: Record<string, unknown>) =>
      Object.keys(runtimes).map((runtime) => ({
        runtime,
        ok: runtime !== 'hermes-agent',
        models: [],
        ...(runtime === 'hermes-agent' ? { error: 'Authentication required', authRequired: true } : {})
      }))
    )
    const daemon = new Daemon({
      root: root(),
      resolveCatalog: async () => catalog(),
      installed: (runtimes) => runtimes,
      probeRuntimes: probe as never,
      hostFactory: () => ({}) as never
    })

    try {
      await daemon.start()
      await waitForProbe(daemon, probe)
      // Not admitted: launch and placement still refuse it…
      await vi.waitFor(() => expect(Object.keys((daemon as any).runtimes)).toEqual(['explicit']), WAIT)
      expect(() => (daemon as any).curatedRuntimeAdmission.assertLaunch('hermes-agent', 'curated')).toThrow(
        /Authentication required/
      )
      // …but the facts snapshot reports it so the console can show the warning.
      expect((daemon as any).reportedRuntimeIds().sort()).toEqual(['explicit', 'hermes-agent'])
      expect((daemon as any).runtimeProfileFor('hermes-agent')).toMatchObject({
        runtime: 'hermes-agent',
        models: [],
        authRequired: true
      })

      // The emit path carries it too (what the CP receives after a sweep).
      const emitted: Array<Array<{ runtime: string; authRequired?: boolean }>> = []
      ;(daemon as any).cpClient = {
        emitDaemonRuntimes: (profiles: Array<{ runtime: string; authRequired?: boolean }>) => {
          emitted.push(profiles)
        },
        stop: vi.fn(async () => {})
      }
      await (daemon as any).probeRuntimesAndEmit(true)
      expect(emitted.length).toBeGreaterThan(0)
      const last = emitted[emitted.length - 1]!
      expect(last.find((p) => p.runtime === 'hermes-agent')?.authRequired).toBe(true)
      expect(last.find((p) => p.runtime === 'explicit')?.authRequired).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  }, 15_000)

  it('keeps a live-observed login-required mark through a successful probe sweep', async () => {
    const probe = vi.fn(async (runtimes: Record<string, unknown>) =>
      Object.keys(runtimes).map((runtime) => ({ runtime, ok: true, models: [] }))
    )
    const daemon = new Daemon({
      root: root(),
      resolveCatalog: async () => catalog(),
      installed: (runtimes) => runtimes,
      probeRuntimes: probe as never,
      hostFactory: () => ({}) as never
    })

    try {
      await daemon.start()
      await waitForProbe(daemon, probe)
      const emitted: Array<Array<{ runtime: string; authRequired?: boolean }>> = []
      ;(daemon as any).cpClient = {
        emitDaemonRuntimes: (profiles: Array<{ runtime: string; authRequired?: boolean }>) => {
          emitted.push(profiles)
        },
        stop: vi.fn(async () => {})
      }

      // Live signal: a real turn on 'explicit' rejected with ACP -32000.
      ;(daemon as any).noteRuntimeAuthFromTurn('explicit', true)
      expect(emitted.length).toBe(1)
      expect(emitted[0]!.find((p) => p.runtime === 'explicit')?.authRequired).toBe(true)
      // Re-marking without a state flip does not re-emit.
      ;(daemon as any).noteRuntimeAuthFromTurn('explicit', true)
      expect(emitted.length).toBe(1)

      // A fresh all-OK sweep must NOT clear the live mark: claude-style adapters
      // probe fine (initialize + session/new succeed) while logged out.
      ;(daemon as any).lastProbeAtMs = 0
      await (daemon as any).probeRuntimesAndEmit(true)
      const afterSweep = emitted[emitted.length - 1]!
      expect(afterSweep.find((p) => p.runtime === 'explicit')?.authRequired).toBe(true)

      // The next successful turn clears it and emits the flip.
      const beforeClear = emitted.length
      ;(daemon as any).noteRuntimeAuthFromTurn('explicit', false)
      expect(emitted.length).toBe(beforeClear + 1)
      expect(emitted[emitted.length - 1]!.find((p) => p.runtime === 'explicit')?.authRequired).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  }, 15_000)

  it('refreshes curated admission after the TTL without requiring a CP reconnect', async () => {
    const clock = new FakeClock(100)
    const probe = vi.fn(async (runtimes: Record<string, unknown>) =>
      Object.keys(runtimes).map((runtime) => ({ runtime, ok: true, models: [] }))
    )
    const daemon = new Daemon({
      clock,
      probeRuntimes: probe as never,
      sandboxMechanism: null
    })

    try {
      ;(daemon as any).cfg = { security: { isolateAccountApps: true } }
      ;(daemon as any).root = '/tmp/curated-admission-test'
      ;(daemon as any).runtimeCatalog = catalog()
      ;(daemon as any).refreshAdmittedRuntimes()
      ;(daemon as any).armRuntimeProbeRefresh()

      clock.advance(5 * 60_000)
      await vi.waitFor(() => expect(probe).toHaveBeenCalled(), WAIT)
      await vi.waitFor(() => expect((daemon as any).probing).toBe(false), WAIT)
      expect(Object.keys((daemon as any).runtimes).sort()).toEqual(['explicit', 'hermes-agent'])
      expect(Object.keys(probe.mock.calls[0]![0])).toEqual(['hermes-agent'])
    } finally {
      ;(daemon as any).draining = true
      const timer = (daemon as any).runtimeProbeTimer
      if (timer !== undefined) clock.clearTimeout(timer)
    }
  }, 15_000)

  it('does not arm a local probe timer when no curated source wins', () => {
    const daemon = new Daemon({ clock: new FakeClock(100), sandboxMechanism: null })
    ;(daemon as any).runtimeCatalog = {
      entries: { explicit: catalog().entries.explicit },
      runtimes: { explicit: catalog().runtimes.explicit }
    }

    ;(daemon as any).armRuntimeProbeRefresh()

    expect((daemon as any).runtimeProbeTimer).toBeUndefined()
  })

  it('queues the ordinary CP-ready sweep behind an in-flight curated sweep', async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const probe = vi.fn(async (runtimes: Record<string, unknown>) => {
      if (probe.mock.calls.length === 1) await first
      return Object.keys(runtimes).map((runtime) => ({ runtime, ok: true, models: [] }))
    })
    const daemon = new Daemon({ probeRuntimes: probe as never, sandboxMechanism: null })
    ;(daemon as any).cfg = { security: { isolateAccountApps: true } }
    ;(daemon as any).root = '/tmp/curated-admission-queue-test'
    ;(daemon as any).runtimeCatalog = catalog()
    ;(daemon as any).refreshAdmittedRuntimes()

    const curated = (daemon as any).probeRuntimesAndEmit(false)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1), WAIT)
    await (daemon as any).probeRuntimesAndEmit(true)
    releaseFirst()
    await curated

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2), WAIT)
    expect(Object.keys(probe.mock.calls[0]![0])).toEqual(['hermes-agent'])
    expect(Object.keys(probe.mock.calls[1]![0])).toEqual(['explicit'])
  }, 15_000)
})
