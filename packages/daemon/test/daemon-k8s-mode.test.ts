import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_BOOTSTRAP_UPGRADE_FEATURE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'

/** The behavior matrix for `--k8s`: each assertion here is one row of the mode
 *  contract, so k8s and self-hosted behavior cannot drift apart unnoticed. */

function root(opts: { declared?: unknown; requireSandbox?: boolean; cliEntry?: boolean } = {}): string {
  const path = mkdtempSync(join(tmpdir(), 'ac-k8s-mode-'))
  writeFileSync(
    join(path, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      ...(opts.requireSandbox ? { security: { requireSandbox: true } } : {})
    })
  )
  if (opts.declared !== undefined) {
    writeFileSync(join(path, 'k8s-runtimes.json'), JSON.stringify(opts.declared))
  }
  // A stale pointer left on the root volume is exactly the case that must NOT re-enable
  // the self-installing upgrade path in k8s mode. readCliEntry only accepts a pointer
  // whose target exists, so the fixture writes a real file to point at.
  if (opts.cliEntry) {
    const entry = join(path, 'cli-dist-entry.js')
    writeFileSync(entry, '// stand-in for an installed CLI entry\n')
    writeFileSync(join(path, 'cli-entry'), entry)
  }
  return path
}

function catalog(): ResolvedRuntimeCatalog {
  // Deliberately a command that does not exist on the test host: host discovery must
  // find nothing, so anything advertised came from the declared table.
  const absent = { command: 'ac-k8s-absent-runtime', args: [], env: [] }
  const hermes = { command: 'hermes', args: ['acp'], env: [] }
  return {
    entries: {
      claude: { runtime: absent, source: 'registry', name: 'Claude Code', version: '1.0.0', skillsAgentId: 'claude' },
      'hermes-agent': { runtime: hermes, source: 'curated', name: 'Hermes Agent', version: '', skillsAgentId: null }
    },
    runtimes: { claude: absent, 'hermes-agent': hermes }
  }
}

function daemon(opts: {
  root: string
  k8s: boolean
  probe?: ReturnType<typeof vi.fn>
  supervisor?: string
  /** Extra plane members for the rows that are ABOUT the plane the mode installs. */
  plane?: Record<string, unknown>
  dataPlane?: boolean
  openDataPlane?: ReturnType<typeof vi.fn>
  startControlPlane?: ReturnType<typeof vi.fn>
}): Daemon {
  return new Daemon({
    root: opts.root,
    k8s: opts.k8s,
    // The plane needs a cluster and has its own suite; this file is about what the MODE changes.
    // Stubbing it here keeps the refuse-to-boot-without-a-cluster behaviour real everywhere else.
    ...(opts.k8s
      ? {
          ...(opts.dataPlane === false
            ? {}
            : {
                openDataPlane: async () =>
                  ({
                    transcripts: {
                      appendTranscript: () => {},
                      insertToolCall: () => {},
                      updateToolCall: () => {},
                      transcriptTailForAgent: async () => ({ rows: [], hasMore: false, cursor: 0 }),
                      transcriptPageForAgentByEventTime: async () => ({ rows: [], hasMore: false }),
                      transcriptPageForAgent: async () => ({ rows: [], hasMore: false }),
                      currentTranscriptRevision: async () => 0,
                      getToolBodyForAgent: async () => undefined
                    },
                    close: async () => {}
                  }) as never
              }),
          startK8sPlane: async () =>
            ({
              driver: { claimName: (id: string) => `agent-${id}` } as never,
              listener: { listeningPort: () => 0 } as never,
              gitRunnerFor: () => undefined,
              launchedAgents: () => [],
              suspendIdle: async () => 'absent',
              discardAgent: async () => {},
              stop: async () => {},
              ...opts.plane
            }) as never
        }
      : {}),
    ...(opts.openDataPlane ? { openDataPlane: opts.openDataPlane as never } : {}),
    startControlPlane: (opts.startControlPlane ?? vi.fn(() => Promise.resolve())) as never,
    ...(opts.supervisor ? { supervisor: opts.supervisor } : {}),
    resolveCatalog: async () => catalog(),
    ...(opts.probe ? { probeRuntimes: opts.probe as never } : {}),
    hostFactory: () => ({}) as never
  })
}

describe('daemon --k8s mode', () => {
  it('does not inspect or open the PostgreSQL data plane outside k8s mode', async () => {
    const openDataPlane = vi.fn()
    const local = daemon({ root: root(), k8s: false, openDataPlane })
    try {
      await local.start()
      expect(openDataPlane).not.toHaveBeenCalled()
    } finally {
      await local.stop()
    }
  })

  it('requires the mounted PostgreSQL configuration before starting the execution plane', async () => {
    const k8sDaemon = daemon({ root: root(), k8s: true, dataPlane: false })
    await expect(k8sDaemon.start()).rejects.toThrow(/data-plane configuration is not readable/)
  })

  it('waits for the initial CP organization registry before completing cloud startup', async () => {
    let release!: () => void
    const registryReady = new Promise<void>((resolve) => {
      release = resolve
    })
    const startControlPlane = vi.fn(() => registryReady)
    const instance = daemon({ root: root(), k8s: true, startControlPlane })
    const starting = instance.start()
    let settled = false
    void starting.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.waitFor(() => expect(startControlPlane).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    release()
    try {
      await starting
    } finally {
      await instance.stop()
    }
  })

  it('refuses cloud startup when no authoritative CP organization registry is available', async () => {
    const instance = daemon({ root: root(), k8s: true, startControlPlane: vi.fn(() => undefined) })
    await expect(instance.start()).rejects.toThrow(/requires an authoritative CP organization registry/)
    await instance.stop()
  })

  it('advertises the runtimes the image declares, not what is installed on the host', async () => {
    const probe = vi.fn(async () => [])
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude', models: ['sonnet'] }] } }),
      k8s: true,
      probe
    })
    try {
      await k8sDaemon.start()
      expect(Object.keys((k8sDaemon as any).runtimes)).toEqual(['claude'])
      // Never launches a runtime locally to learn this — the table is the source.
      expect(probe).not.toHaveBeenCalled()
      const profile = (k8sDaemon as any).runtimeProfileFor('claude')
      expect(profile.models).toEqual(['sonnet'])
      // Declared, not probed: model gates must stay permissive on this provenance.
      expect(profile.modelsSource).toBe('cached')
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('advertises nothing in the same tree without --k8s, where host discovery decides', async () => {
    const local = daemon({ root: root({ declared: { runtimes: [{ id: 'claude' }] } }), k8s: false })
    try {
      await local.start()
      expect(Object.keys((local as any).runtimes)).toEqual([])
    } finally {
      await local.stop()
    }
  })

  it('drops a declared curated runtime instead of advertising one that cannot launch', async () => {
    const k8sDaemon = daemon({ root: root({ declared: { runtimes: [{ id: 'hermes-agent' }] } }), k8s: true })
    try {
      await k8sDaemon.start()
      expect(Object.keys((k8sDaemon as any).runtimes)).toEqual([])
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('advertises no runtime and keeps running when the declared table is missing', async () => {
    const k8sDaemon = daemon({ root: root(), k8s: true })
    try {
      await k8sDaemon.start()
      expect(Object.keys((k8sDaemon as any).runtimes)).toEqual([])
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('claims no sandbox capability: the pod is the isolation unit, not the SRT mechanism', async () => {
    const k8sDaemon = daemon({ root: root({ declared: { runtimes: [{ id: 'claude' }] } }), k8s: true })
    try {
      await k8sDaemon.start()
      expect((k8sDaemon as any).sandboxMechanism).toBeUndefined()
      const features: string[] = (k8sDaemon as any).registrationFeatures()
      expect(features).not.toContain('sandbox')
      expect(features).not.toContain('sandbox-required')
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('refuses the self-installing upgrade even with a supervisor marker and a cli-entry present', async () => {
    // Both prerequisites of the normal capability check are satisfied here: without a
    // mode-level refusal, the daemon would advertise bootstrap-upgrade and accept a
    // command that runs the CLI installer and exits the pod for an unrequested version.
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] }, cliEntry: true }),
      k8s: true,
      supervisor: 'service'
    })
    try {
      await k8sDaemon.start()
      expect((k8sDaemon as any).bootstrapUpgradeCapable()).toBe(false)
      expect((k8sDaemon as any).registrationFeatures()).not.toContain(DAEMON_BOOTSTRAP_UPGRADE_FEATURE)
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('still offers the self-installing upgrade outside k8s mode with the same prerequisites', async () => {
    // The control case, so the refusal above is attributable to the mode and not to a
    // missing prerequisite in the fixture.
    const local = daemon({ root: root({ cliEntry: true }), k8s: false, supervisor: 'service' })
    try {
      await local.start()
      expect((local as any).bootstrapUpgradeCapable()).toBe(true)
      expect((local as any).registrationFeatures()).toContain(DAEMON_BOOTSTRAP_UPGRADE_FEATURE)
    } finally {
      await local.stop()
    }
  })

  it('refuses to start when requireSandbox is configured, rather than pretending', async () => {
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] }, requireSandbox: true }),
      k8s: true
    })
    await expect(k8sDaemon.start()).rejects.toThrow(/requireSandbox is not supported with --k8s/)
  })

  it('suspends the pod of an agent that has gone quiet, and leaves a busy one alone', async () => {
    const suspended: string[] = []
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      plane: {
        launchedAgents: () => ['quiet', 'serving'],
        suspendIdle: async (agentId: string) => {
          suspended.push(agentId)
          return 'suspended'
        }
      }
    })
    try {
      await k8sDaemon.start()
      // A host that is still inside its own idle window owns the decision; suspending underneath
      // it would pull the pod out from a runtime that is merely between turns.
      ;(k8sDaemon as any).hosts.set('serving', { stop: async () => {} })
      ;(k8sDaemon as any).hostStartedAt.set('serving', Date.now())
      ;(k8sDaemon as any).sweepIdle()
      await vi.waitFor(() => expect(suspended).toEqual(['quiet']))
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('deletes a removed agent’s sandbox, which is what takes its workspace volume with it', async () => {
    const discarded: string[] = []
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      plane: { discardAgent: async (agentId: string) => void discarded.push(agentId) }
    })
    try {
      await k8sDaemon.start()
      const cp = (k8sDaemon as any).cpConfigApply()
      await cp.applyAgentUpsert({ agentId: 'doomed', spec: { name: 'doomed' } })
      // The local path deletes the checkout at exactly this point; in a pod the checkout is on a
      // volume no rmSync here can reach, so the claim is what has to go.
      await cp.applyAgentRemove('doomed')
      expect(discarded).toEqual(['doomed'])
    } finally {
      await k8sDaemon.stop()
    }
  })
})
