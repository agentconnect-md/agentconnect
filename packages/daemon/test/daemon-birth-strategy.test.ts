// The strategy a session was born with is durable on its holder (session-executors.md §5): recorded with the birth verdict and read by every later launch.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutorCandidatesResult, ExecutorPrepareReq, ExecutorPrepareResult } from '@agentconnect.md/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHostKey, sessionHostKey, sessionKeyDirName } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { sessionSandboxSubject } from '../src/remote/sandbox-subject.js'
import { sessionKey, type SessionRecord } from '../src/store/local-store.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const EXECUTOR = '44444444-4444-4444-8444-444444444444'
const KEY = (thread: string): string => sessionKey('slack', 'C1', thread, AGENT)
const READY: ExecutorPrepareResult = {
  status: 'ready',
  generation: 1,
  endpoint: { host: '192.0.2.10', port: 7100 },
  psk: Buffer.alloc(32, 7).toString('base64url'),
  runtimeRoot: '/home/agent/runtime',
  liveCount: 1
}
const MISMATCH: ExecutorPrepareResult = { status: 'refused', reason: 'strategy_mismatch' }

function writeAgent(root: string, agent: Record<string, unknown>): void {
  const dir = join(root, 'agents', AGENT)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: 'birth-strategy',
      status: 'active',
      runtime: 'claude',
      workspace: {
        mode: 'git-repo',
        path: join(dir, 'workspace'),
        gitRepo: 'https://git.example.test/example-org/example-repo.git',
        gitBranch: 'main',
        isolation: 'session'
      },
      integrations: [],
      output: { mode: 'medium' },
      ...agent
    })
  )
}

describe('the birth strategy on the holder', () => {
  const roots: string[] = []
  const running = new Set<any>()

  afterEach(async () => {
    for (const internal of running) await stop(internal)
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function scaffold(agent: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'ac-birth-strategy-'))
    roots.push(root)
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    writeAgent(root, agent)
    return root
  }

  /** A daemon with a control connection stubbed to exactly what placement asks of it. */
  async function start(root: string, cp: Record<string, unknown> = {}): Promise<any> {
    const daemon = new Daemon({ root, sandboxMechanism: 'bwrap', probeRuntimes: async () => [] })
    await daemon.start()
    const internal = daemon as any
    running.add(internal)
    internal.cpClient = {
      organizationScope: () => 'connection',
      memberSet: () => null,
      connected: () => false,
      stop: vi.fn(async () => {}),
      ...cp
    }
    return internal
  }

  async function stop(internal: any): Promise<void> {
    running.delete(internal)
    internal.cpClient = undefined
    await internal.stop()
  }

  async function row(internal: any, key: string): Promise<void> {
    const rec: SessionRecord = {
      key,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: key,
      acpSessionId: null,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1,
      workspaceIsolation: 'session'
    }
    await internal.store.upsertSession(rec)
    internal.sessionIsolation.set(key, 'session')
  }

  it('launches a session in the strategy it was born with after a restart under a changed `execution`', async () => {
    const root = scaffold({ execution: 'srt' })
    const first = await start(root)
    const key = KEY('1700000000.000100')
    await row(first, key)
    await first.placeSessionOnExecutor(first.agents.get(AGENT), key)
    // A daemon in no group stays home, and the verdict carries the boundary the session was born in.
    expect(await first.store.getSessionExecutor(key)).toEqual({
      stayedHomeReason: 'not_on_group',
      birthStrategy: 'srt'
    })
    await stop(first)

    writeAgent(root, { execution: 'host' })
    const second = await start(root)
    const agent = second.agents.get(AGENT)
    expect(second.agentStrategy(agent)).toBe('host')
    second.sessionIsolation.set(key, 'session')
    await second.placeSessionOnExecutor(agent, key)
    const build = vi.spyOn(second, 'buildAcpHost').mockReturnValue({ host: { stop: async () => {} } })
    const fresh = KEY('1700000000.000200')
    second.ensureHost(sessionHostKey(AGENT, key), second.cfg, join(root, 'born-srt'))
    second.ensureHost(sessionHostKey(AGENT, fresh), second.cfg, join(root, 'born-now'))
    expect(build.mock.calls.map((call) => (call[2] as { strategy: string }).strategy)).toEqual(['srt', 'host'])
    // While nothing stands on disk for it, its tier follows the same boundary: clones of its own, where a new session gets the shared host.
    expect(second.hostKeyFor(AGENT, key)).toBe(sessionHostKey(AGENT, key))
    second.sessionIsolation.set(fresh, 'session')
    expect(second.hostKeyFor(AGENT, fresh)).toBe(agentHostKey(AGENT))
    expect(await second.store.getSessionExecutor(key)).toEqual({
      stayedHomeReason: 'not_on_group',
      birthStrategy: 'srt'
    })
  })

  it('prepares a placed session in its recorded strategy, and leaves an environment of another one as it is', async () => {
    const sent: ExecutorPrepareReq[] = []
    const internal = await start(scaffold({ execution: 'microsandbox' }), {
      connected: () => true,
      executorPrepare: async (req: ExecutorPrepareReq) => {
        sent.push(req)
        return MISMATCH
      }
    })
    const key = KEY('1700000000.000300')
    await row(internal, key)
    await internal.store.setSessionExecutor(key, { executorDaemonId: EXECUTOR, birthStrategy: 'host' })
    await internal.placeSessionOnExecutor(internal.agents.get(AGENT), key)
    expect(internal.executorPlane.placementOf(key)).toMatchObject({ executorDaemonId: EXECUTOR, strategy: 'host' })

    // The executor made it under another strategy: the launch fails with that reason, and nothing moves or is rewritten.
    await expect(
      internal.executorPlane.ensureChannel(sessionSandboxSubject(AGENT, sessionKeyDirName(key)))
    ).rejects.toThrow('made under another strategy than host; it is left as it is rather than recreated')
    expect(sent.map((req) => [req.executorDaemonId, req.strategy])).toEqual([[EXECUTOR, 'host']])
    expect(internal.executorPlane.placementOf(key)).toMatchObject({ executorDaemonId: EXECUTOR })
    expect(await internal.store.getSessionExecutor(key)).toEqual({ executorDaemonId: EXECUTOR, birthStrategy: 'host' })
  })

  it('resumes a session placed elsewhere in the birth strategy the candidates hint names, and records it', async () => {
    const sent: ExecutorPrepareReq[] = []
    const answers: ExecutorPrepareResult[] = [READY, MISMATCH]
    const candidates: ExecutorCandidatesResult = {
      candidates: [
        {
          daemonId: EXECUTOR,
          endpoint: { host: '192.0.2.10', port: 7100 },
          strategies: { host: { available: true }, microsandbox: { available: true } },
          hostedSessions: 3,
          runtimes: [{ runtime: 'claude', authRequired: false }]
        }
      ],
      currentExecutorDaemonId: EXECUTOR,
      birthStrategy: 'host'
    }
    // No managed memory on this disk, which would keep it home on its own (§7).
    const internal = await start(scaffold({ execution: 'microsandbox', memory: { provider: 'none' } }), {
      memberSet: () => ({ setId: 'set-1', name: 'example-group' }),
      connected: () => true,
      executorCandidates: async () => structuredClone(candidates),
      executorPrepare: async (req: ExecutorPrepareReq) => {
        sent.push(req)
        return answers.shift()!
      }
    })
    vi.spyOn(internal, 'hostedSessionCount').mockResolvedValue(0)
    const agent = internal.agents.get(AGENT)
    const key = KEY('1700000000.000400')
    await row(internal, key)

    await internal.placeSessionOnExecutor(agent, key)
    expect(sent.map((req) => [req.executorDaemonId, req.strategy])).toEqual([[EXECUTOR, 'host']])
    expect(await internal.store.getSessionExecutor(key)).toEqual({ executorDaemonId: EXECUTOR, birthStrategy: 'host' })
    expect(internal.sessionStrategy(agent, key)).toBe('host')

    // A hint that names no strategy leaves the agent's; an environment made under another one is a startup error, never recreated elsewhere.
    delete candidates.birthStrategy
    const other = KEY('1700000000.000500')
    await row(internal, other)
    await expect(internal.placeSessionOnExecutor(agent, other)).rejects.toThrow(
      'made under another strategy than microsandbox'
    )
    expect(sent.map((req) => req.strategy)).toEqual(['host', 'microsandbox'])
    expect(internal.executorPlane.placementOf(other)).toBeUndefined()
    expect(await internal.store.getSessionExecutor(other)).toBeUndefined()
  })

  it('gives a key born again after its row was purged the agent’s strategy now, not the one cached from before', async () => {
    const root = scaffold({ execution: 'srt' })
    const internal = await start(root)
    const agent = internal.agents.get(AGENT)
    const key = KEY('1700000000.000900')
    await row(internal, key)
    await internal.placeSessionOnExecutor(agent, key)
    expect(internal.sessionStrategy(agent, key)).toBe('srt')

    // Purged by anyone — retention here, a peer on a shared store — and then the same thread speaks again.
    await internal.store.deleteSession(key, { reason: 'retention', at: 2 })
    agent.execution = 'host'
    await row(internal, key)
    await internal.placeSessionOnExecutor(agent, key)
    expect(internal.sessionStrategy(agent, key)).toBe('host')
    expect(await internal.store.getSessionExecutor(key)).toEqual({
      stayedHomeReason: 'not_on_group',
      birthStrategy: 'host'
    })
  })

  it('fills a verdict recorded before strategies were once, with the agent’s migrated `execution`', async () => {
    // Not migrated by the Control Plane yet: `runInSandbox` is read as the migration reads it.
    const root = scaffold({ runInSandbox: true })
    const first = await start(root)
    const earlier = KEY('1700000000.000600')
    const undecided = KEY('1700000000.000700')
    await row(first, earlier)
    await row(first, undecided)
    // What a daemon before this change wrote.
    await first.store.setSessionExecutor(earlier, { stayedHomeReason: 'holder_least_loaded' })
    await stop(first)

    const second = await start(root)
    expect(await second.store.getSessionExecutor(earlier)).toEqual({
      stayedHomeReason: 'holder_least_loaded',
      birthStrategy: 'srt'
    })
    expect((await second.store.getSession(undecided))?.birthStrategy).toBeNull()
    // A later change of the agent's setting reaches none of it.
    const agent = second.agents.get(AGENT)
    agent.execution = 'host'
    second.sessionIsolation.set(earlier, 'session')
    await second.placeSessionOnExecutor(agent, earlier)
    expect(second.sessionStrategy(agent, earlier)).toBe('srt')

    // One written without a strategy after startup — an older member of a shared store — is filled at its next placement.
    const late = KEY('1700000000.000800')
    await row(second, late)
    await second.store.setSessionExecutor(late, { executorDaemonId: EXECUTOR })
    await second.placeSessionOnExecutor(agent, late)
    expect(await second.store.getSessionExecutor(late)).toEqual({ executorDaemonId: EXECUTOR, birthStrategy: 'host' })
    expect(second.executorPlane.placementOf(late)).toMatchObject({ strategy: 'host' })
  })
})
