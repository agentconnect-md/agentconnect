import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_WAKE_FEATURE, DAEMON_BOOTSTRAP_UPGRADE_FEATURE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { agentHostKey, sessionHostKey } from '../src/acp/host-key.js'
import { sandboxSubjectFor } from '../src/k8s/sandbox-identity.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import { LocalStore } from '../src/store/local-store.js'
import { mcpSocketPath, statePath } from '../src/paths.js'
import { SANDBOX_TUNNEL_PATHS } from '../src/shim/sandbox-paths.js'

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
  // A runtime whose command names a provider surface, so a probe of it composes a credential.
  const codex = { command: 'codex-acp', args: [], env: [] }
  return {
    entries: {
      claude: { runtime: absent, source: 'registry', name: 'Claude Code', version: '1.0.0', skillsAgentId: 'claude' },
      'codex-acp': { runtime: codex, source: 'registry', name: 'Codex', version: '1.0.0', skillsAgentId: 'codex' },
      'hermes-agent': { runtime: hermes, source: 'curated', name: 'Hermes Agent', version: '', skillsAgentId: null }
    },
    runtimes: { claude: absent, 'codex-acp': codex, 'hermes-agent': hermes }
  }
}

function daemon(opts: {
  root: string
  k8s: boolean
  probe?: ReturnType<typeof vi.fn>
  /** The ACP client the sandbox model probe drives, so the sweep runs without a cluster. */
  probeHostFactory?: (rt: unknown, id: string, cwd: string, policy: unknown) => unknown
  supervisor?: string
  /** Extra plane members for the rows that are ABOUT the plane the mode installs. */
  plane?: Record<string, unknown>
  dataPlane?: boolean
  /** A store shared by several members, so a pool-wide probe can be asserted across them. */
  store?: LocalStore
  openDataPlane?: ReturnType<typeof vi.fn>
  startControlPlane?: ReturnType<typeof vi.fn>
  /** Receives the options the mode hands the plane — the rows about what it asks the pod to serve. */
  onPlaneStart?: (options: any) => void
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
                    store: opts.store ?? (await LocalStore.open(':memory:')),
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
          startK8sPlane: async (options: any) => {
            opts.onPlaneStart?.(options)
            return {
              driver: { claimName: (id: string) => `agent-${id}` } as never,
              memberId: 'member-under-test',
              runtimeImage: async () => 'runtime-sandbox:test',
              listener: { listeningPort: () => 0 } as never,
              gitRunnerFor: () => undefined,
              launched: () => [],
              suspendIdle: async () => 'absent',
              discardAgent: async () => {},
              stop: async () => {},
              ...opts.plane
            } as never
          }
        }
      : {}),
    ...(opts.openDataPlane ? { openDataPlane: opts.openDataPlane as never } : {}),
    startControlPlane: (opts.startControlPlane ?? vi.fn(() => Promise.resolve())) as never,
    ...(opts.supervisor ? { supervisor: opts.supervisor } : {}),
    resolveCatalog: async () => catalog(),
    ...(opts.probe ? { probeRuntimes: opts.probe as never } : {}),
    ...(opts.probeHostFactory ? { probeHostFactory: opts.probeHostFactory as never } : {}),
    hostFactory: () => ({}) as never
  })
}

describe('daemon --k8s mode', () => {
  it('gives an isolated session its own host and pod, and a shared one the agent host, whatever mechanism this host has (§11)', async () => {
    const instance = daemon({ root: root(), k8s: true })
    try {
      await instance.start()
      // The mode never turns the in-process mechanism on; force it so the isolation rule — not the
      // mechanism rule that decides self-hosted — is what keys the host here.
      ;(instance as any).sandboxMechanism = 'bwrap'
      const agent = {
        id: 'bot-a',
        name: 'bot-a',
        status: 'active',
        runtime: 'claude',
        runInSandbox: false,
        workspace: {
          mode: 'git-repo',
          path: '/agents/bot-a/workspace',
          gitRepo: 'https://github.com/acme/private.git',
          gitBranch: 'main'
        },
        integrations: [],
        output: { mode: 'medium' }
      }
      ;(instance as any).agents.set('bot-a', agent)
      const shared = { sessionKey: 'slack:C1:T1:bot-a', isolation: 'shared' as const }
      const isolated = { sessionKey: 'slack:C1:T2:bot-a', isolation: 'session' as const }
      expect((instance as any).hostKeyForRequest('bot-a', shared)).toBe(agentHostKey('bot-a'))
      expect((instance as any).hostKeyForRequest('bot-a', isolated)).toBe(sessionHostKey('bot-a', isolated.sessionKey))
      // The learned isolation keeps answering for callers holding only the key, and the pod follows the host.
      expect((instance as any).hostKeyFor('bot-a', isolated.sessionKey)).toBe(
        sessionHostKey('bot-a', isolated.sessionKey)
      )
      expect((instance as any).hostKeyFor('bot-a', shared.sessionKey)).toBe(agentHostKey('bot-a'))
      expect((instance as any).podSubjectFor(agent, sessionHostKey('bot-a', isolated.sessionKey))).toBe(
        sandboxSubjectFor(sessionHostKey('bot-a', isolated.sessionKey))
      )
      // A session-shaped host key the pool does not know as isolated (a dream, a model-session host) stays in the agent pod.
      expect((instance as any).podSubjectFor(agent, sessionHostKey('bot-a', 'dream:bot-a:d1'))).toBeUndefined()
      expect((instance as any).podSubjectFor(agent, agentHostKey('bot-a'))).toBeUndefined()
      // A session the pool never heard of is the agent's, not a guess.
      expect((instance as any).hostKeyFor('bot-a', 'slack:C1:T9:bot-a')).toBe(agentHostKey('bot-a'))
      // Capacity keeps counting AGENTS: session hosts (and their pods) do not spend `maxAgents` slots.
      ;(instance as any).cfg.limits.maxAgents = 5
      ;(instance as any).hosts.set(sessionHostKey('bot-a', isolated.sessionKey), {})
      ;(instance as any).hosts.set(sessionHostKey('bot-a', 'slack:C1:T3:bot-a'), {})
      expect((instance as any).dutyCoordinator.dutyHeadroom()).toBe(5)
      ;(instance as any).hosts.clear()
    } finally {
      await instance.stop()
    }
  })

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

  it('uses the mounted PostgreSQL store without creating a pool member SQLite database', async () => {
    const rootDir = root()
    const instance = daemon({ root: rootDir, k8s: true })
    try {
      await instance.start()
      expect(existsSync(statePath(rootDir))).toBe(false)
    } finally {
      await instance.stop()
    }
  })

  it('waits for the initial CP organization registry before completing pool member startup', async () => {
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

  it('refuses pool member startup when no authoritative CP organization registry is available', async () => {
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
      const profile = (k8sDaemon as any).runtimeFacts.profileFor('claude')
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

  it('advertises the sandbox wake: in cluster mode there is a sandbox to wake', async () => {
    const k8sDaemon = daemon({ root: root({ declared: { runtimes: [{ id: 'claude' }] } }), k8s: true })
    try {
      await k8sDaemon.start()
      expect((k8sDaemon as any).registrationFeatures()).toContain(AGENT_WAKE_FEATURE)
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
        launched: () => [
          { subject: 'quiet', agentId: 'quiet', since: 0 },
          { subject: 'serving', agentId: 'serving', since: 0 }
        ],
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

  it('leaves a HELD sandbox alone — an open page is watching work a suspend would throw away', async () => {
    const suspended: string[] = []
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      plane: {
        launched: () => [
          { subject: 'watched', agentId: 'watched', since: 0 },
          { subject: 'abandoned', agentId: 'abandoned', since: 0 }
        ],
        suspendIdle: async (agentId: string) => {
          suspended.push(agentId)
          return 'suspended'
        }
      }
    })
    try {
      await k8sDaemon.start()
      // What the keep-alive route renews: a lease taken because that session's worktree is dirty.
      ;(k8sDaemon as any).sandboxHolds.renew('watched', 'session-1', ['uncommitted-files'])
      ;(k8sDaemon as any).sweepIdle()
      await vi.waitFor(() => expect(suspended).toEqual(['abandoned']))

      // The page closes: nothing renews, the lease lapses, and the next sweep suspends normally. The
      // fake plane re-answers for `abandoned` too, so the assertion is about the held one arriving.
      ;(k8sDaemon as any).sandboxHolds.release('watched', 'session-1')
      ;(k8sDaemon as any).sweepIdle()
      await vi.waitFor(() => expect(suspended).toContain('watched'))
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('judges the hold per POD, so one dirty session page cannot pin its agent or its siblings (§11)', async () => {
    // The lease is keyed by sandbox subject, not by agent: an agent-keyed one let a page watching one
    // dirty session worktree keep every running session pod of that agent out of the sweep.
    const suspended: string[] = []
    const dirty = 'watched/session-dirty'
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      plane: {
        launched: () => [
          { subject: dirty, agentId: 'watched', since: 0 },
          { subject: 'watched/session-clean', agentId: 'watched', since: 0 },
          { subject: 'watched', agentId: 'watched', since: 0 }
        ],
        suspendIdle: async (subject: string) => {
          suspended.push(subject)
          return 'suspended'
        }
      }
    })
    try {
      await k8sDaemon.start()
      ;(k8sDaemon as any).sandboxHolds.renew(dirty, 'session-dirty', ['uncommitted-files'])
      ;(k8sDaemon as any).sweepIdle()
      // The agent's own pod and the sibling session's are judged on their own keys, and suspend.
      await vi.waitFor(() => expect([...suspended].sort()).toEqual(['watched', 'watched/session-clean']))
      expect(suspended).not.toContain(dirty)
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('counts idleness from when the launch was taken over when no activity is recorded', async () => {
    const suspended: string[] = []
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      plane: {
        // No session row exists for either agent, so activity alone would read as idle since epoch.
        launched: () => [
          { subject: 'fresh', agentId: 'fresh', since: Date.now() },
          { subject: 'stale', agentId: 'stale', since: Date.now() - 24 * 3_600_000 }
        ],
        suspendIdle: async (agentId: string) => {
          suspended.push(agentId)
          return 'suspended'
        }
      }
    })
    try {
      await k8sDaemon.start()
      ;(k8sDaemon as any).sweepIdle()
      await vi.waitFor(() => expect(suspended).toEqual(['stale']))
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('never suspends the sandbox of an agent whose duty is held elsewhere', async () => {
    const suspended: string[] = []
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      plane: {
        launched: () => [
          { subject: 'held', agentId: 'held', since: 0 },
          { subject: 'moved', agentId: 'moved', since: 0 }
        ],
        suspendIdle: async (agentId: string) => {
          suspended.push(agentId)
          return 'suspended'
        }
      }
    })
    try {
      await k8sDaemon.start()
      // A member of the install-wide pool: the duty ledger decides which agents it serves.
      ;(k8sDaemon as any).cpClient = {
        organizationScope: () => 'frame',
        memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
        stop: async () => {}
      }
      ;(k8sDaemon as any).duties.applyGrant([
        {
          groupId: '11111111-1111-4111-8111-111111111111',
          orgId: 'org-1',
          term: '1',
          members: [{ kind: 'agent', refId: 'held' }]
        }
      ])
      ;(k8sDaemon as any).sweepIdle()
      await vi.waitFor(() => expect(suspended).toEqual(['held']))
      ;(k8sDaemon as any).sweepIdle()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(suspended).toEqual(['held', 'held'])
    } finally {
      ;(k8sDaemon as any).cpClient = undefined
      await k8sDaemon.stop()
    }
  })

  it('takes over the sandbox when a duty arrives and releases it — after the host stop — when the duty leaves', async () => {
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    const GROUP = '11111111-1111-4111-8111-111111111111'
    const events: string[] = []
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      plane: {
        adoptAgent: async (agentId: string) => void events.push(`adopt:${agentId}`),
        releaseAgent: (agentId: string) => void events.push(`release:${agentId}`)
      }
    })
    try {
      await k8sDaemon.start()
      ;(k8sDaemon as any).cpClient = {
        organizationScope: () => 'frame',
        memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
        stop: async () => {},
        releaseDuties: vi.fn(async () => {}),
        reportDutiesNow: vi.fn(() => {}),
        fetchDutyAgent: vi.fn(async () => ({
          bundle: {
            agentId: AGENT,
            spec: {
              orgId: 'org-1',
              name: 'scout',
              runtime: 'claude',
              workspace: { mode: 'scratch', isolation: 'shared' }
            },
            integrations: [],
            crons: []
          }
        }))
      }
      const grant = { groupId: GROUP, orgId: 'org-1', term: '1', members: [{ kind: 'agent', refId: AGENT }] }
      await (k8sDaemon as any).dutyCoordinator.admitDutyGrants([grant])
      await vi.waitFor(() => expect(events).toEqual([`adopt:${AGENT}`]))
      // A stopped host stands in for the ex-holder's runtime; the release must wait for it to be down.
      let hostDown = false
      ;(k8sDaemon as any).hosts.set(AGENT, {
        stop: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          hostDown = true
        }
      })
      ;(k8sDaemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP, reason: 'superseded' }])
      expect(events).toEqual([`adopt:${AGENT}`])
      await vi.waitFor(() => expect(events).toEqual([`adopt:${AGENT}`, `release:${AGENT}`]))
      expect(hostDown).toBe(true)
    } finally {
      ;(k8sDaemon as any).cpClient = undefined
      await k8sDaemon.stop()
    }
  })

  it('clears a readiness marker left on a mounted path before it waits on the control plane (#1043)', async () => {
    const rootDir = root()
    const marker = join(rootDir, 'ready')
    writeFileSync(marker, 'ready\n')
    vi.stubEnv('AC_READINESS_FILE', marker)
    let release!: () => void
    const startControlPlane = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const instance = daemon({ root: rootDir, k8s: true, startControlPlane })
    const starting = instance.start()
    try {
      // The marker outlives the container that wrote it, and startup blocks here for as long as the
      // CP is down — so it has to be gone before the wait, not after it.
      await vi.waitFor(() => expect(startControlPlane).toHaveBeenCalledOnce())
      expect(existsSync(marker)).toBe(false)
      expect(instance.readinessState()).toEqual({ ready: false, reason: 'starting' })
      release()
      await starting
      // Startup is done; what is left is the member's own registration.
      expect(instance.readinessState()).toEqual({ ready: false, reason: 'control-plane-unregistered' })
      expect(existsSync(marker)).toBe(false)
    } finally {
      await starting.catch(() => undefined)
      await instance.stop()
      vi.unstubAllEnvs()
    }
  })

  it('is not ready until the install-wide sandbox runtime probe returns (#1043)', async () => {
    let settle!: (table: unknown) => void
    const k8sDaemon = daemon({
      root: root(),
      k8s: true,
      plane: { probeRuntimes: () => new Promise((resolve) => (settle = resolve)) }
    })
    try {
      await k8sDaemon.start()
      // Registered, but the member still advertises nothing: the CP would assign it no agent, so
      // process health is not servability and the probe is the half only this member can settle.
      ;(k8sDaemon as any).cpClient = { state: 'READY' }
      expect(k8sDaemon.readinessState()).toEqual({ ready: false, reason: 'runtime-probe-pending' })
      settle({ runtimes: [{ id: 'claude', version: '1.2.3' }] })
      await vi.waitFor(() => expect(k8sDaemon.readinessState()).toEqual({ ready: true, reason: 'ready' }))
    } finally {
      ;(k8sDaemon as any).cpClient = undefined
      await k8sDaemon.stop()
    }
  })

  // The image's own table is generated with no provider credentials, so it carries no model list at
  // all — which is how every cluster runtime reached the console with an empty model picker. The
  // credentialed probe is the answer: run the runtime in the pod that ships it and ASK.
  it('reads each runtime’s models by running it in the probe sandbox, with the deployment’s credentials', async () => {
    vi.stubEnv('ANTHROPIC_MODEL_TOKEN', 'deployment-token')
    vi.stubEnv('ANTHROPIC_MODEL_BASE_URL', 'https://gateway.example/anthropic')
    const policies: Array<{ id: string; env?: Record<string, string>; inherit?: boolean; cwd: string }> = []
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      probeHostFactory: (_rt, id, cwd, policy: any) => {
        policies.push({ id, env: policy.env, inherit: policy.inheritProcessEnv, cwd })
        return {
          start: async () => {},
          newSession: async () => 'probe-session',
          modelOptions: () => ({ models: ['sonnet', 'opus[1m]'], current: 'sonnet' }),
          acpProtocolVersion: () => 1,
          acpAgentInfo: () => ({ name: 'claude-agent-acp', version: '0.66.0' }),
          stop: async () => {}
        } as never
      },
      // One held sandbox answers both halves: the table, then the runtimes it named.
      plane: {
        probeRuntimes: async (sweep: any) => {
          // The command is the IMAGE's, which is also what identifies the provider surface the
          // credential is written onto.
          const table = { runtimes: [{ id: 'claude', version: '1.2.3', command: 'claude-agent-acp' }] }
          await sweep?.(table, { agentId: 'ac-runtime-probe-abc', cwd: '/agent' })
          return table
        }
      }
    })
    try {
      await k8sDaemon.start()
      await vi.waitFor(() => expect((k8sDaemon as any).runtimeFacts.profileFor('claude').models).toHaveLength(2))
      const profile = (k8sDaemon as any).runtimeFacts.profileFor('claude')
      expect(profile.models).toEqual(['sonnet', 'opus[1m]'])
      // A live session said so, so the model gates are strict — unlike a declared snapshot.
      expect(profile.modelsSource).toBe('probed')
      // The runtime ran in the POD: routed by the probe identity, addressed in the pod's
      // coordinates, and carrying the deployment's provider pair rather than this daemon's env.
      expect(policies).toEqual([
        {
          id: 'claude',
          cwd: '/agent',
          inherit: false,
          env: {
            AC_AGENT_ID: 'ac-runtime-probe-abc',
            ANTHROPIC_API_KEY: 'deployment-token',
            ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic'
          }
        }
      ])
    } finally {
      await k8sDaemon.stop()
      vi.unstubAllEnvs()
    }
  })

  // One pod per POOL, not per replica. The answer describes the runtime image, and every member on
  // that image would spend a sandbox to be told the same thing.
  it('adopts the pool’s published probe instead of claiming a sandbox of its own', async () => {
    const store = await LocalStore.open(':memory:')
    await store.publishRuntimeImageProbe({
      imageRef: 'runtime-sandbox:test',
      now: Date.now(),
      payload: JSON.stringify({
        table: { runtimes: [{ id: 'claude', version: '9.9.9', command: 'claude-agent-acp' }] },
        results: [{ runtime: 'claude', ok: true, models: ['sonnet', 'opus[1m]'], acpProtocolVersion: 1 }]
      })
    })
    const probeRuntimes = vi.fn()
    const k8sDaemon = daemon({ root: root(), k8s: true, store, plane: { probeRuntimes } })
    try {
      await k8sDaemon.start()
      await vi.waitFor(() => expect((k8sDaemon as any).k8sRuntimeProbed).toBe(true))
      // No sandbox was claimed, and the member still advertises the models and the image's version.
      expect(probeRuntimes).not.toHaveBeenCalled()
      const profile = (k8sDaemon as any).runtimeFacts.profileFor('claude')
      expect(profile.models).toEqual(['sonnet', 'opus[1m]'])
      expect(profile.modelsSource).toBe('probed')
      expect(profile.version).toBe('9.9.9')
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('hands the claim back when its own probe leaves the pool no answer', async () => {
    // Holding a claim through a failure is what would make every other member wait out the whole
    // stale window for a payload that is never coming.
    const store = await LocalStore.open(':memory:')
    const k8sDaemon = daemon({
      root: root(),
      k8s: true,
      store,
      plane: {
        probeRuntimes: async () => {
          throw new Error('probe sandbox bound no session')
        }
      }
    })
    try {
      await k8sDaemon.start()
      await vi.waitFor(async () =>
        expect(
          await store.claimRuntimeImageProbe({
            imageRef: 'runtime-sandbox:test',
            memberId: 'another-member',
            now: Date.now(),
            staleBefore: 0
          })
        ).toBe(true)
      )
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('re-probes rather than inherit an answer that has gone stale', async () => {
    // An image reference is not always an immutable identity — a template pinned to a moving tag
    // keeps one key across rebuilds — and the answer also depends on the deployment's credentials.
    const store = await LocalStore.open(':memory:')
    await store.publishRuntimeImageProbe({
      imageRef: 'runtime-sandbox:test',
      now: Date.now() - 25 * 60 * 60_000,
      payload: JSON.stringify({
        table: { runtimes: [{ id: 'claude', version: 'from-a-previous-build' }] },
        results: [{ runtime: 'claude', ok: true, models: ['gone'] }]
      })
    })
    const probeRuntimes = vi.fn(async (sweep: any) => {
      const table = { runtimes: [{ id: 'claude', version: '1.2.3' }] }
      await sweep?.(table, { agentId: 'ac-runtime-probe-abc', cwd: '/agent' })
      return table
    })
    const k8sDaemon = daemon({
      root: root(),
      k8s: true,
      store,
      probeHostFactory: () =>
        ({
          start: async () => {},
          newSession: async () => 's',
          modelOptions: () => ({ models: ['sonnet'], current: 'sonnet' }),
          acpProtocolVersion: () => 1,
          stop: async () => {}
        }) as never,
      plane: { probeRuntimes }
    })
    try {
      await k8sDaemon.start()
      await vi.waitFor(() => expect((k8sDaemon as any).k8sRuntimeProbed).toBe(true))
      expect(probeRuntimes).toHaveBeenCalledOnce()
      const profile = (k8sDaemon as any).runtimeFacts.profileFor('claude')
      expect(profile.version).toBe('1.2.3')
      expect(profile.models).toEqual(['sonnet'])
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('probes for itself when the pool has published nothing for THIS image', async () => {
    // A template bump is a different key, so a member on a new image never adopts the old one's
    // answer — which is what makes one shared probe safe across a rollout.
    const store = await LocalStore.open(':memory:')
    await store.publishRuntimeImageProbe({
      imageRef: 'runtime-sandbox:previous',
      now: 1,
      payload: JSON.stringify({ table: { runtimes: [{ id: 'claude', version: '0.0.1' }] }, results: [] })
    })
    const probeRuntimes = vi.fn(async (sweep: any) => {
      const table = { runtimes: [{ id: 'claude', version: '1.2.3' }] }
      await sweep?.(table, { agentId: 'ac-runtime-probe-abc', cwd: '/agent' })
      return table
    })
    const k8sDaemon = daemon({
      root: root(),
      k8s: true,
      store,
      probeHostFactory: () =>
        ({
          start: async () => {},
          newSession: async () => 's',
          modelOptions: () => null,
          acpProtocolVersion: () => 1,
          stop: async () => {}
        }) as never,
      plane: { probeRuntimes }
    })
    try {
      await k8sDaemon.start()
      await vi.waitFor(() => expect((k8sDaemon as any).k8sRuntimeProbed).toBe(true))
      expect(probeRuntimes).toHaveBeenCalledOnce()
      expect((k8sDaemon as any).runtimeFacts.profileFor('claude').version).toBe('1.2.3')
      // And what it found is published for the members that start after it.
      const published = await store.readRuntimeImageProbe('runtime-sandbox:test')
      expect(JSON.parse(published!.payload).table.runtimes[0].version).toBe('1.2.3')
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('keeps the image’s declared facts when the sandbox probe cannot reach a runtime', async () => {
    // An empty `probed` list is a STRICT gate, so one slow pod would refuse an agent whose model
    // the declared table already vouches for. Unreachable says nothing about the runtime.
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude', models: ['sonnet'] }] } }),
      k8s: true,
      probeHostFactory: () =>
        ({
          start: async () => {
            throw new Error('no shim channel bound in time')
          },
          newSession: async () => 'unused',
          modelOptions: () => null,
          acpProtocolVersion: () => undefined,
          stop: async () => {}
        }) as never,
      plane: {
        probeRuntimes: async (sweep: any) => {
          const table = { runtimes: [{ id: 'claude', version: '1.2.3', models: ['sonnet'] }] }
          await sweep?.(table, { agentId: 'ac-runtime-probe-abc', cwd: '/agent' })
          return table
        }
      }
    })
    try {
      await k8sDaemon.start()
      await vi.waitFor(() => expect((k8sDaemon as any).k8sRuntimeProbed).toBe(true))
      const profile = (k8sDaemon as any).runtimeFacts.profileFor('claude')
      expect(profile.models).toEqual(['sonnet'])
      expect(profile.modelsSource).toBe('cached')
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('keeps the declared facts when a runtime refuses a probe this deployment gave no credential', async () => {
    // Codex and DeepSeek Harness refuse `session/new` with no credential at all, and publishing
    // that as authRequired empties the model picker AND asks the user to log a POD in.
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'codex-acp', models: ['gpt-5.6-sol'] }] } }),
      k8s: true,
      probeHostFactory: () =>
        ({
          start: async () => {
            throw Object.assign(new Error('Authentication required'), { code: -32000 })
          },
          newSession: async () => 'unused',
          modelOptions: () => null,
          acpProtocolVersion: () => undefined,
          stop: async () => {}
        }) as never,
      plane: {
        probeRuntimes: async (sweep: any) => {
          const table = {
            runtimes: [{ id: 'codex-acp', version: '1.2.3', command: 'codex-acp', models: ['gpt-5.6-sol'] }]
          }
          await sweep?.(table, { agentId: 'ac-runtime-probe-abc', cwd: '/agent' })
          return table
        }
      }
    })
    try {
      await k8sDaemon.start()
      await vi.waitFor(() => expect((k8sDaemon as any).k8sRuntimeProbed).toBe(true))
      const profile = (k8sDaemon as any).runtimeFacts.profileFor('codex-acp')
      expect(profile.models).toEqual(['gpt-5.6-sol'])
      expect(profile.authRequired).toBeUndefined()
    } finally {
      await k8sDaemon.stop()
    }
  })

  // A daemon-path bridge spec sent to a pod is not a degraded tool surface but an unspawnable one:
  // the runtime retried `/app/.../dist/index.js` on a backoff until it gave up, and the agent had no
  // AgentConnect tools at all. The spec has to name what the IMAGE reports shipping.
  it('injects the image’s own MCP bridge, in pod coordinates, once the probe reports one', async () => {
    const BRIDGE = { command: '/usr/local/bin/node', args: ['/opt/agentconnect/shim/mcp-bridge.js'] }
    let settle!: (table: unknown) => void
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      plane: { probeRuntimes: () => new Promise((resolve) => (settle = resolve)) }
    })
    try {
      await k8sDaemon.start()
      settle({ runtimes: [{ id: 'claude', version: '1.2.3' }], mcpBridge: BRIDGE })
      await vi.waitFor(() => expect(mcpServersFor(k8sDaemon)).toHaveLength(1))
      const [server] = mcpServersFor(k8sDaemon)
      // The image's own interpreter and entry, verbatim: anything resolved on this host — the
      // daemon's node, its CLI entry, even a bare `node` trusting the pod's PATH — names something
      // the runtime may not have.
      expect(server).toMatchObject({ command: BRIDGE.command, args: BRIDGE.args })
      // And the endpoint is the tunnel's in-pod socket, which the shim serves back to this daemon.
      expect(server!.env).toContainEqual({ name: 'AC_MCP_ENDPOINT', value: SANDBOX_TUNNEL_PATHS.mcp })
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('withholds the tool server from an image that reports no bridge, rather than a spec it cannot spawn', async () => {
    let settle!: (table: unknown) => void
    const k8sDaemon = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] } }),
      k8s: true,
      plane: { probeRuntimes: () => new Promise((resolve) => (settle = resolve)) }
    })
    try {
      await k8sDaemon.start()
      // An image built before the bridge shipped: it says nothing, and silence is the answer.
      settle({ runtimes: [{ id: 'claude', version: '1.2.3' }] })
      await vi.waitFor(() => expect((k8sDaemon as any).k8sRuntimeProbed).toBe(true))
      expect(mcpServersFor(k8sDaemon)).toEqual([])
    } finally {
      await k8sDaemon.stop()
    }
  })

  it('still injects this daemon’s own bridge outside k8s, where the runtime shares its filesystem', async () => {
    const local = daemon({ root: root(), k8s: false })
    try {
      await local.start()
      const servers = mcpServersFor(local)
      expect(servers).toHaveLength(1)
      expect(servers[0]!.args).toContain('mcp-bridge')
    } finally {
      await local.stop()
    }
  })

  it('asks every pod to serve the mcp socket, and the credential socket only where git needs one', async () => {
    let planeOptions!: any
    const rootDir = root({ declared: { runtimes: [{ id: 'claude' }] } })
    const k8sDaemon = daemon({ root: rootDir, k8s: true, onPlaneStart: (options) => (planeOptions = options) })
    try {
      await k8sDaemon.start()
      // Every pod agent: any session may carry tools, and the listener belongs to the pod's
      // lifetime while the spec that dials it is decided per session.
      ;(k8sDaemon as any).agents.set('plain', { id: 'plain', workspace: {} })
      expect(planeOptions.tunnelsFor('plain')).toEqual(['mcp'])
      expect(planeOptions.tunnelSocketPath('mcp')).toBe(mcpSocketPath(rootDir))
      ;(k8sDaemon as any).agents.set('gh', { id: 'gh', workspace: { mode: 'git-repo', gitCredential: 'github-app' } })
      expect(planeOptions.tunnelsFor('gh')).toEqual(['mcp', 'gitcred'])
      // A managed GitLab pod needs the same socket: its clone/pull and the agent's git/glab ask for one.
      ;(k8sDaemon as any).agents.set('gl', { id: 'gl', workspace: { mode: 'git-repo', gitCredential: 'gitlab' } })
      expect(planeOptions.tunnelsFor('gl')).toEqual(['mcp', 'gitcred'])
      // And nothing for the member's own runtime probe, whose channel is granted `probe` alone —
      // asking it to serve a socket would be refused, and the refusal logged, on every boot.
      expect(planeOptions.tunnelsFor('ac-runtime-probe-0f0f0f0f')).toEqual([])
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

/** The session seam that decides an agent's MCP servers, asked about an ordinary agent. */
function mcpServersFor(
  instance: Daemon
): { command: string; args: string[]; env: { name: string; value: string }[] }[] {
  const agent = { id: 'a1', name: 'a1', runtime: 'claude', integrations: [], mcpServers: [] }
  return (instance as any).sessions.deps.mcpServersFor({
    agent,
    platform: 'slack',
    channel: 'C1',
    thread: '1',
    isDm: false
  })
}
