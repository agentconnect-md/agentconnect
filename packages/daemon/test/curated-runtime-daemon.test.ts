import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Daemon } from '../src/daemon.js'
import { CuratedRuntimeAdmission } from '../src/runtimes/curated-admission.js'
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
      'hermes-agent': { runtime: hermes, source: 'curated', name: 'Hermes Agent', version: '', skillsAgentId: null },
      explicit: { runtime: explicit, source: 'user', name: 'explicit', version: '', skillsAgentId: null }
    },
    runtimes: { 'hermes-agent': hermes, explicit }
  }
}

async function waitForProbe(daemon: Daemon, probe: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(probe).toHaveBeenCalled(), WAIT)
  await vi.waitFor(() => expect((daemon as any).runtimeFacts.probing).toBe(false), WAIT)
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
        await (daemon as any).runtimeFacts.probeAndEmit(false)
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
        entries: {
          'hermes-agent': { runtime, source: 'curated', name: 'Hermes Agent', version: '', skillsAgentId: null }
        },
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
      expect((daemon as any).runtimeFacts.profileFor('hermes-agent')).toMatchObject({
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
      await (daemon as any).runtimeFacts.probeAndEmit(true)
      expect(emitted.length).toBeGreaterThan(0)
      const last = emitted[emitted.length - 1]!
      expect(last.find((p) => p.runtime === 'hermes-agent')?.authRequired).toBe(true)
      expect(last.find((p) => p.runtime === 'explicit')?.authRequired).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  })

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
      ;(daemon as any).runtimeFacts.noteAuthFromTurn('explicit', true)
      expect(emitted.length).toBe(1)
      expect(emitted[0]!.find((p) => p.runtime === 'explicit')?.authRequired).toBe(true)
      // Re-marking without a state flip does not re-emit.
      ;(daemon as any).runtimeFacts.noteAuthFromTurn('explicit', true)
      expect(emitted.length).toBe(1)

      // A fresh all-OK sweep must NOT clear the live mark: claude-style adapters
      // probe fine (initialize + session/new succeed) while logged out.
      ;(daemon as any).runtimeFacts.lastProbeAtMs = 0
      await (daemon as any).runtimeFacts.probeAndEmit(true)
      const afterSweep = emitted[emitted.length - 1]!
      expect(afterSweep.find((p) => p.runtime === 'explicit')?.authRequired).toBe(true)

      // The next successful turn clears it and emits the flip.
      const beforeClear = emitted.length
      ;(daemon as any).runtimeFacts.noteAuthFromTurn('explicit', false)
      expect(emitted.length).toBe(beforeClear + 1)
      expect(emitted[emitted.length - 1]!.find((p) => p.runtime === 'explicit')?.authRequired).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  })

  // The sweep used to apply every result at one barrier, so a curated runtime whose
  // package launcher spends minutes building its install tree also held back the
  // runtimes that answered in seconds — including their admission.
  it('reports each probe as it lands instead of waiting for the slowest runtime', async () => {
    let releaseCurated = (): void => {}
    let gate: Promise<void> | undefined
    const probe = vi.fn(
      async (runtimes: Record<string, unknown>, options: { onResult?: (r: Record<string, unknown>) => void }) => {
        const results: Array<Record<string, unknown>> = []
        for (const runtime of Object.keys(runtimes)) {
          if (runtime === 'hermes-agent' && gate) await gate
          const result = { runtime, ok: true, models: [] }
          options.onResult?.(result)
          results.push(result)
        }
        return results
      }
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
      const emitted: string[][] = []
      ;(daemon as any).cpClient = {
        emitDaemonRuntimes: (profiles: Array<{ runtime: string }>) => emitted.push(profiles.map((p) => p.runtime)),
        stop: vi.fn(async () => {})
      }
      // Re-arm a full sweep whose curated probe blocks until released.
      ;(daemon as any).runtimeFacts.lastProbeAtMs = 0
      ;(daemon as any).curatedRuntimeAdmission = new CuratedRuntimeAdmission()
      ;(daemon as any).refreshAdmittedRuntimes()
      gate = new Promise<void>((resolve) => {
        releaseCurated = resolve
      })
      const sweep = (daemon as any).runtimeFacts.probeAndEmit(true)

      // The fast runtime is reported while the curated probe is still in flight.
      await vi.waitFor(() => expect(emitted.at(-1)).toContain('explicit'), WAIT)
      expect((daemon as any).runtimeFacts.probing).toBe(true)
      expect(emitted.at(-1)).not.toContain('hermes-agent')

      releaseCurated()
      await sweep
      expect(emitted.at(-1)!.slice().sort()).toEqual(['explicit', 'hermes-agent'])
    } finally {
      await daemon.stop()
    }
  })

  // Admission freshness has to survive a slow co-probe: the next sweep is scheduled from
  // sweep completion, so a runtime stamped when it landed would go unlaunchable (and get
  // pruned from the snapshot) for the rest of a long package-launcher install.
  it('keeps a fast curated result admitted when a slow co-probe outlasts its TTL', async () => {
    const clock = new FakeClock()
    // 'hermes-agent' answers immediately; the sweep then burns more than the 5-minute
    // admission TTL before returning, exactly like a cold npx install.
    const probe = vi.fn(
      async (
        runtimes: Record<string, unknown>,
        options: { onResult?: (r: Record<string, unknown>) => void }
      ): Promise<Array<Record<string, unknown>>> => {
        const results = Object.keys(runtimes).map((runtime) => ({ runtime, ok: true, models: [] }))
        for (const result of results) options.onResult?.(result)
        clock.advance(6 * 60_000)
        return results
      }
    )
    const daemon = new Daemon({ clock, probeRuntimes: probe as never, sandboxMechanism: null })

    try {
      ;(daemon as any).cfg = { security: { isolateAccountApps: true } }
      ;(daemon as any).root = '/tmp/curated-admission-ttl-test'
      ;(daemon as any).runtimeCatalog = catalog()
      ;(daemon as any).refreshAdmittedRuntimes()
      const emitted: string[][] = []
      ;(daemon as any).cpClient = {
        emitDaemonRuntimes: (profiles: Array<{ runtime: string }>) => emitted.push(profiles.map((p) => p.runtime)),
        stop: vi.fn(async () => {})
      }

      await (daemon as any).runtimeFacts.probeAndEmit(true)

      expect(probe).toHaveBeenCalled()
      expect(Object.keys((daemon as any).runtimes).sort()).toEqual(['explicit', 'hermes-agent'])
      expect(() => (daemon as any).curatedRuntimeAdmission.assertLaunch('hermes-agent', 'curated')).not.toThrow()
      // The restamp brought it back, so the CP sees it in the final snapshot too.
      expect(emitted.at(-1)).toContain('hermes-agent')
    } finally {
      ;(daemon as any).draining = true
      const timer = (daemon as any).runtimeFacts.probeTimer
      if (timer !== undefined) clock.clearTimeout(timer)
    }
  })

  it('refreshes curated admission after the TTL without requiring a CP reconnect', async () => {
    const clock = new FakeClock()
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
      ;(daemon as any).runtimeFacts.armProbeRefresh()

      clock.advance(5 * 60_000)
      await vi.waitFor(() => expect(probe).toHaveBeenCalled(), WAIT)
      await vi.waitFor(() => expect((daemon as any).runtimeFacts.probing).toBe(false), WAIT)
      expect(Object.keys((daemon as any).runtimes).sort()).toEqual(['explicit', 'hermes-agent'])
      expect(Object.keys(probe.mock.calls[0]![0])).toEqual(['hermes-agent'])
    } finally {
      ;(daemon as any).draining = true
      const timer = (daemon as any).runtimeFacts.probeTimer
      if (timer !== undefined) clock.clearTimeout(timer)
    }
  })

  it('does not arm a local probe timer when no curated source wins', () => {
    const daemon = new Daemon({ clock: new FakeClock(), sandboxMechanism: null })
    ;(daemon as any).runtimeCatalog = {
      entries: { explicit: catalog().entries.explicit },
      runtimes: { explicit: catalog().runtimes.explicit }
    }

    ;(daemon as any).runtimeFacts.armProbeRefresh()

    expect((daemon as any).runtimeFacts.probeTimer).toBeUndefined()
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

    const curated = (daemon as any).runtimeFacts.probeAndEmit(false)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1), WAIT)
    await (daemon as any).runtimeFacts.probeAndEmit(true)
    releaseFirst()
    await curated

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2), WAIT)
    expect(Object.keys(probe.mock.calls[0]![0])).toEqual(['hermes-agent'])
    expect(Object.keys(probe.mock.calls[1]![0])).toEqual(['explicit'])
  })
})
