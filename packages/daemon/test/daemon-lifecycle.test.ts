import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TASK_LIST_TASKS, type SessionPurged } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { TaskViolationError } from '../src/cp/task-reader.js'
import { configFilesDir } from '../src/shim/config-file-env.js'
import { readSkillLedger, skillLedgerLocation } from '../src/skills/skill-install-ledger.js'
import { sessionKey } from '../src/store/local-store.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// vi.waitFor defaults to a 1000ms budget — too tight on a loaded CI runner, where a
// cold session boot (workspace + host + session/new) can stall well past a second.
// Give every poll in this file the same generous budget instead.
const WAIT = { timeout: 10_000 }

const TRANSPORT_SCOPE = `slack:${createHash('sha256').update('slack\0p').digest('hex').slice(0, 24)}`

/** A daemon root with one DM-less agent (we attach routing + a fake conn by hand,
 *  exactly like daemon-commands.test.ts). `limits` overrides the lifecycle tunables. */
function scaffold(limits: Record<string, number> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-life-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } },
      limits
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

function quietHost() {
  return {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async () => 'end_turn'),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
}

function blockingHost() {
  let release!: () => void
  const blocked = new Promise<void>((r) => (release = r))
  let calls = 0
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async () => {
      if (++calls === 1) await blocked
      return 'end_turn'
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  return { host, release: () => release() }
}

function multiBlockingHost() {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => (release = resolve))
  let nextSession = 0
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${++nextSession}`),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async () => {
      await blocked
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async (_sessionId: string) => {}),
    stop: vi.fn(async () => {})
  }
  return { host, release: () => release() }
}

function coldBlockingHost() {
  let releaseSession!: () => void
  const sessionBlocked = new Promise<void>((resolve) => (releaseSession = resolve))
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => {
      await sessionBlocked
      return 'acp-cold'
    }),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  return { host, releaseSession: () => releaseSession() }
}

function writePause(root: string, pause: boolean): void {
  const path = join(root, 'agents', 'bot-a', 'agent.json')
  const agent = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  writeFileSync(path, JSON.stringify({ ...agent, pause }))
}

function makeRoutable(daemon: Daemon) {
  const a = (daemon as any).agents.get('bot-a')
  a.integrations = [
    {
      id: 'int-a',
      platform: 'slack',
      core: { bindRules: [{ match: { kind: 'dm' } }] },
      config: { botToken: 'b', appToken: 'p' }
    }
  ]
  const conn = {
    workspaceId: vi.fn(() => 'T1'),
    setStatus: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    postMessage: vi.fn(async () => {})
  }
  ;(daemon as any).connByIntegration.set('int-a', conn)
  return conn
}

const dm = (ts: string, text: string, thread = 'T1') => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread,
  transportScope: TRANSPORT_SCOPE,
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

const KEY = sessionKey('slack', 'C1', 'T1', 'bot-a', TRANSPORT_SCOPE)
/** `sdkLeaseKey('bot-a', 'acp-1')` — leases are per (agent, ACP session), not per session id. */
const LEASE_KEY = JSON.stringify(['bot-a', 'acp-1'])

/** The wake fence is two counters — armed timers and in-flight deliveries. "Settled" means
 *  both are clear; `armedWakes` alone hits 0 the moment a delivery starts. */
function wakeFenceHeld(daemon: Daemon): boolean {
  const lease = (daemon as any).sdkLease.get(LEASE_KEY)
  return !!lease && (lease.armedWakes > 0 || lease.deliveringWakes > 0)
}

function pendingFor(daemon: Daemon, acpSessionId: string): any {
  return [...(daemon as any).pending.values()].find(
    (pending: any) => pending.plan.agentId === 'bot-a' && pending.acpSessionId === acpSessionId
  )
}

describe('Daemon session lifecycle (#118)', () => {
  it('prepares the workspace before every direct cold-host lifecycle start', async () => {
    const root = scaffold()
    const workspace = join(root, 'agents', 'bot-a', 'workspace')
    const host = quietHost()
    const factory = vi.fn(() => {
      // ensureHostAsync is shared by memory/Dream extraction, activation proof,
      // CP launch, and ordinary session startup. Construction itself must not
      // happen until the complete workspace preparation gate has settled.
      expect(existsSync(workspace)).toBe(true)
      return host as any
    })
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: factory })
    await daemon.start()
    expect(existsSync(workspace)).toBe(false)

    await (daemon as any).ensureHostAsync('bot-a')

    expect(factory).toHaveBeenCalledOnce()
    expect(host.start).toHaveBeenCalledOnce()
    await daemon.stop()
  }, 15_000)

  it('does not construct or start a cold host when workspace preparation fails', async () => {
    const root = scaffold()
    const workspace = join(root, 'agents', 'bot-a', 'workspace')
    writeFileSync(workspace, 'not a directory')
    const factory = vi.fn(() => quietHost() as any)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: factory })
    await daemon.start()

    await expect((daemon as any).ensureHostAsync('bot-a')).rejects.toThrow()

    expect(factory).not.toHaveBeenCalled()
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await daemon.stop()
  }, 15_000)

  it('shares one cold preparation between host start and session creation', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const prepare = vi.spyOn(daemon as any, 'prepareAgentWorkspace')

    await (daemon as any).dispatch('bot-a', dm('100', 'cold'), 'int-a')
    expect(prepare).toHaveBeenCalledTimes(1)

    // A different logical session on the already-running host still performs
    // its one warm new-session preparation.
    await (daemon as any).dispatch('bot-a', dm('200', 'warm', 'T2'), 'int-a')
    expect(prepare).toHaveBeenCalledTimes(2)
    await daemon.stop()
  }, 20_000)

  it('earns one extra host start attempt when it repairs the runtime install', async () => {
    const root = scaffold({ agentStartAttempts: 1, agentStartBackoffMs: 0 })
    const failing = quietHost()
    failing.start.mockRejectedValue(
      new Error('Codex process has exited with code 1:\nError: Missing optional dependency @openai/codex-linux-x64')
    )
    const started = quietHost()
    const factory = vi.fn().mockReturnValueOnce(failing).mockReturnValueOnce(started)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: factory })
    await daemon.start()
    ;(daemon as any).hostRuntimeHome.set('bot-a', join(root, 'agents', 'bot-a', 'home'))
    const repair = vi.spyOn(daemon as any, 'repairAgentRuntimeInstall').mockResolvedValue('repaired')

    await expect((daemon as any).ensureHostAsync('bot-a')).resolves.toBe(started)
    expect(repair).toHaveBeenCalledTimes(1)
    expect((daemon as any).lastStartFailure.has('bot-a')).toBe(false)
    await daemon.stop()
  }, 20_000)

  it('does not spend its one repair on a failure that was never a broken install', async () => {
    const root = scaffold({ agentStartAttempts: 2, agentStartBackoffMs: 0 })
    const unrelated = quietHost()
    unrelated.start.mockRejectedValue(new Error('initialize failed'))
    const missing = quietHost()
    missing.start.mockRejectedValue(new Error('Error: Missing optional dependency @openai/codex-linux-x64'))
    const started = quietHost()
    const factory = vi.fn().mockReturnValueOnce(unrelated).mockReturnValueOnce(missing).mockReturnValueOnce(started)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: factory })
    await daemon.start()
    ;(daemon as any).hostRuntimeHome.set('bot-a', join(root, 'agents', 'bot-a', 'home'))
    const repair = vi
      .spyOn(daemon as any, 'repairAgentRuntimeInstall')
      .mockResolvedValueOnce('declined')
      .mockResolvedValueOnce('repaired')

    await expect((daemon as any).ensureHostAsync('bot-a')).resolves.toBe(started)
    expect(repair).toHaveBeenCalledTimes(2)
    await daemon.stop()
  }, 20_000)

  it('records the redacted cause when no repair rescues the start', async () => {
    const root = scaffold({ agentStartAttempts: 1, agentStartBackoffMs: 0 })
    const failing = quietHost()
    failing.start.mockRejectedValue(
      new Error('Codex process has exited with code 1:\nError: Missing optional dependency @openai/codex-linux-x64')
    )
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: vi.fn(() => failing as any)
    })
    await daemon.start()
    ;(daemon as any).hostRuntimeHome.set('bot-a', join(root, 'agents', 'bot-a', 'home'))
    const repair = vi.spyOn(daemon as any, 'repairAgentRuntimeInstall').mockResolvedValue('failed')

    await expect((daemon as any).ensureHostAsync('bot-a')).rejects.toThrow('Missing optional dependency')
    expect(repair).toHaveBeenCalledTimes(1)
    expect((daemon as any).lastStartFailure.get('bot-a')).toBe(
      'Error: Missing optional dependency @openai/codex-linux-x64'
    )
    await daemon.stop()
  }, 20_000)

  it('declines a repair it cannot own: no matching tree, or a cluster-launched runtime', async () => {
    const root = scaffold()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: vi.fn(() => quietHost() as any)
    })
    await daemon.start()
    const home = join(root, 'agents', 'bot-a', 'home')

    expect(await (daemon as any).repairAgentRuntimeInstall('bot-a', home, new Error('initialize failed'))).toBe(
      'declined'
    )
    ;(daemon as any).k8sPlane = { stop: async () => {} }
    const missing = new Error('Error: Missing optional dependency @openai/codex-linux-x64')
    expect(await (daemon as any).repairAgentRuntimeInstall('bot-a', home, missing)).toBe('declined')
    await daemon.stop()
  }, 20_000)

  it('re-runs the workspace receipt gate before every fresh host retry', async () => {
    const root = scaffold({ agentStartAttempts: 2, agentStartBackoffMs: 0 })
    const workspace = join(root, 'agents', 'bot-a', 'workspace')
    const sentinel = join(workspace, 'tampered-by-failed-host')
    const first = quietHost()
    first.start.mockImplementation(async () => {
      writeFileSync(sentinel, 'tampered')
      throw new Error('initialize failed')
    })
    const second = quietHost()
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: factory })
    await daemon.start()
    const realPrepare = (daemon as any).prepareAgentWorkspace.bind(daemon)
    let preparations = 0
    vi.spyOn(daemon as any, 'prepareAgentWorkspace').mockImplementation(async (agent: unknown) => {
      preparations += 1
      if (preparations === 2 && existsSync(sentinel)) throw new Error('skill receipt changed after failed host')
      return realPrepare(agent)
    })

    await expect((daemon as any).ensureHostAsync('bot-a')).rejects.toThrow('skill receipt changed')

    expect(preparations).toBe(2)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(first.stop).toHaveBeenCalledOnce()
    expect(second.start).not.toHaveBeenCalled()
    await daemon.stop()
  }, 15_000)

  it('drains a superseded cold preparation before reconcile admits the next generation', async () => {
    const root = scaffold()
    const host = quietHost()
    const factory = vi.fn(() => host as any)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: factory })
    await daemon.start()

    const realPrepare = (daemon as any).prepareAgentWorkspace.bind(daemon)
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    let markFirstEntered!: () => void
    const firstEntered = new Promise<void>((resolve) => (markFirstEntered = resolve))
    const preparedModels: Array<string | undefined> = []
    let preparations = 0
    vi.spyOn(daemon as any, 'prepareAgentWorkspace').mockImplementation(async (agent: any) => {
      preparations += 1
      preparedModels.push(agent.runtimeOverrides?.model)
      if (preparations === 1) {
        markFirstEntered()
        await firstBlocked
      }
      return realPrepare(agent)
    })

    const firstStart = (daemon as any).ensureHostAsync('bot-a') as Promise<unknown>
    const firstRejected = expect(firstStart).rejects.toThrow(
      /host start superseded|workspace preparation blocked while agent authority is draining/
    )
    await firstEntered

    const agentPath = join(root, 'agents', 'bot-a', 'agent.json')
    const agent = JSON.parse(readFileSync(agentPath, 'utf8')) as Record<string, unknown>
    writeFileSync(agentPath, JSON.stringify({ ...agent, runtimeOverrides: { model: 'opus' } }))
    let reconciled = false
    const reconciling = daemon.reconcile().then(() => {
      reconciled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(reconciled).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    releaseFirst()
    await firstRejected
    await reconciling

    await (daemon as any).ensureHostAsync('bot-a')
    expect(preparedModels).toEqual([undefined, 'opus'])
    expect(factory).toHaveBeenCalledOnce()
    expect(host.start).toHaveBeenCalledOnce()
    await daemon.stop()
  }, 20_000)

  it('serializes an aborted warm preparation before the reconciled host prepares and starts', async () => {
    const root = scaffold()
    const configPath = join(root, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>
    writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        runtimes: { ...config.runtimes, codex: { command: 'node', args: ['unused'] } }
      })
    )
    const firstHost = quietHost()
    const secondHost = quietHost()
    const factory = vi.fn().mockReturnValueOnce(firstHost).mockReturnValueOnce(secondHost)
    const clock = new FakeClock()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: factory, clock })
    await daemon.start()
    makeRoutable(daemon)
    await (daemon as any).ensureHostAsync('bot-a')

    const realRunPreparation = (daemon as any).runAgentWorkspacePreparation.bind(daemon)
    let releaseWarm!: () => void
    const warmBlocked = new Promise<void>((resolve) => (releaseWarm = resolve))
    let markWarmEntered!: () => void
    const warmEntered = new Promise<void>((resolve) => (markWarmEntered = resolve))
    const preparedRuntimes: string[] = []
    let preparations = 0
    vi.spyOn(daemon as any, 'runAgentWorkspacePreparation').mockImplementation(async (agent: any) => {
      preparations += 1
      preparedRuntimes.push(agent.runtime)
      if (preparations === 1) {
        markWarmEntered()
        await warmBlocked
      }
      return realRunPreparation(agent)
    })

    const warmDispatch = (daemon as any).dispatch('bot-a', dm('200', 'warm', 'T2'), 'int-a') as Promise<unknown>
    await warmEntered

    const agentPath = join(root, 'agents', 'bot-a', 'agent.json')
    const agent = JSON.parse(readFileSync(agentPath, 'utf8')) as Record<string, unknown>
    writeFileSync(agentPath, JSON.stringify({ ...agent, runtime: 'codex' }))
    await daemon.reconcile()

    // Reconcile interrupted the pre-session turn and stopped its warm host. The
    // cold backstop aborts only SessionManager's caller; the helper remains live.
    clock.advance(30_000)
    await expect(warmDispatch).resolves.toBeNull()
    expect((daemon as any).workspacePreparationTails.has('bot-a')).toBe(true)

    const replacement = (daemon as any).ensureHostAsync('bot-a') as Promise<unknown>
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(factory).toHaveBeenCalledTimes(1)
    expect(preparedRuntimes).toEqual(['claude'])

    releaseWarm()
    await replacement

    expect(preparedRuntimes).toEqual(['claude', 'codex'])
    expect(factory).toHaveBeenCalledTimes(2)
    expect(secondHost.start).toHaveBeenCalledOnce()
    const workspace = join(root, 'agents', 'bot-a', 'workspace')
    const ledger = await readSkillLedger(await skillLedgerLocation(workspace, join(root, 'skill-installs')))
    expect(ledger).toMatchObject({ phase: 'ready', agentId: 'bot-a', runtime: 'codex' })
    await daemon.stop()
  }, 20_000)

  it('rejects a late warm preparation after its host generation was stopped', async () => {
    const firstHost = quietHost()
    const secondHost = quietHost()
    const factory = vi.fn().mockReturnValueOnce(firstHost).mockReturnValueOnce(secondHost)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold(), hostFactory: factory })
    await daemon.start()
    await (daemon as any).ensureHostAsync('bot-a')
    const capturedAgent = (daemon as any).agents.get('bot-a')
    const preparation = vi.spyOn(daemon as any, 'runAgentWorkspacePreparation')

    await (daemon as any).stopHost('bot-a')
    await (daemon as any).ensureHostAsync('bot-a')
    expect(preparation).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledTimes(2)

    expect(() => (daemon as any).prepareAgentWorkspace(capturedAgent, firstHost)).toThrow(/superseded warm host/)
    expect(preparation).toHaveBeenCalledOnce()
    expect((daemon as any).hosts.get('bot-a')).toBe(secondHost)
    await daemon.stop()
  }, 20_000)

  it('keeps stopAgent fenced until an aborted warm preparation quiesces', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    makeRoutable(daemon)
    await (daemon as any).ensureHostAsync('bot-a')

    const realRunPreparation = (daemon as any).runAgentWorkspacePreparation.bind(daemon)
    let releaseWarm!: () => void
    const warmBlocked = new Promise<void>((resolve) => (releaseWarm = resolve))
    let markWarmEntered!: () => void
    const warmEntered = new Promise<void>((resolve) => (markWarmEntered = resolve))
    vi.spyOn(daemon as any, 'runAgentWorkspacePreparation').mockImplementationOnce(async (agent: any) => {
      markWarmEntered()
      await warmBlocked
      return realRunPreparation(agent)
    })

    const warmTurn = (daemon as any).dispatch('bot-a', dm('200', 'warm', 'T2'), 'int-a') as Promise<unknown>
    await warmEntered
    let stopped = false
    const stop = ((daemon as any).stopAgent('bot-a') as Promise<void>).then(() => {
      stopped = true
    })
    await expect(warmTurn).resolves.toBeNull()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    expect((daemon as any).workspacePreparationTails.has('bot-a')).toBe(true)

    releaseWarm()
    await stop
    expect(stopped).toBe(true)
    expect((daemon as any).workspacePreparationTails.has('bot-a')).toBe(false)
    await daemon.stop()
  }, 20_000)

  it('coordinates a console git write like a file write, minus the host stop', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    const agent = (daemon as any).agents.get('bot-a')
    const stopHost = vi.spyOn(daemon as any, 'stopHost')

    // Same per-agent serial tail: a preparation in flight holds the git write out.
    let releasePreparation!: () => void
    const preparationBlocked = new Promise<void>((resolve) => (releasePreparation = resolve))
    let markPreparationEntered!: () => void
    const preparationEntered = new Promise<void>((resolve) => (markPreparationEntered = resolve))
    const preparing = (daemon as any).enqueueAgentWorkspacePreparation(agent, async () => {
      markPreparationEntered()
      await preparationBlocked
    }) as Promise<void>
    await preparationEntered

    let wrote = false
    const writing = (daemon as any).withWorkspaceIndexWrite('bot-a', async () => {
      wrote = true
    }) as Promise<void>
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(wrote).toBe(false)
    releasePreparation()
    await preparing
    await writing
    expect(wrote).toBe(true)
    // The distinguishing property: a stage toggle must not evict the warm ACP host, while a file
    // write still does — the two coordinators differ in exactly this.
    expect(stopHost).not.toHaveBeenCalled()
    await (daemon as any).withWorkspaceFileWrite('bot-a', async () => undefined)
    expect(stopHost).toHaveBeenCalledWith('bot-a')

    // The turn-admission fence a dispatch waits on is published for a git write too.
    let releaseWrite!: () => void
    const writeBlocked = new Promise<void>((resolve) => (releaseWrite = resolve))
    let markWriting!: () => void
    const writeEntered = new Promise<void>((resolve) => (markWriting = resolve))
    const fenced = (daemon as any).withWorkspaceIndexWrite('bot-a', async () => {
      markWriting()
      await writeBlocked
    }) as Promise<void>
    await writeEntered
    expect((daemon as any).workspaceDispatchFences.has('bot-a')).toBe(true)
    releaseWrite()
    await fenced
    // The fence is dropped in its own continuation, so let that microtask land before reading it.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((daemon as any).workspaceDispatchFences.has('bot-a')).toBe(false)

    // And "busy" is the same predicate both coordinators refuse on.
    ;(daemon as any).drainingAgents.add('bot-a')
    await expect((daemon as any).withWorkspaceIndexWrite('bot-a', async () => 'ran')).rejects.toThrow(
      /agent is working in this workspace/
    )
    ;(daemon as any).drainingAgents.delete('bot-a')
    await daemon.stop()
  }, 20_000)

  it('waits out a workspace mutation instead of failing an admitted cold host start', async () => {
    const host = quietHost()
    const factory = vi.fn(() => host as any)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold(), hostFactory: factory })
    await daemon.start()

    // A per-session worktree cleanup fences the WHOLE agent, so a cold turn admitted just
    // before it used to die on an unrelated session's cleanup rather than wait the seconds out.
    let releaseMutation!: () => void
    const mutationBlocked = new Promise<void>((resolve) => (releaseMutation = resolve))
    const mutating = (daemon as any).withWorkspaceAdmissionFence('bot-a', () => mutationBlocked) as Promise<void>
    expect((daemon as any).workspaceDispatchFences.has('bot-a')).toBe(true)

    const starting = (daemon as any).ensureHostAsync('bot-a') as Promise<unknown>
    const settled = vi.fn()
    void starting.then(settled, settled)
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Still the old invariant: no child is constructed while the mutation holds the tree.
    expect(settled).not.toHaveBeenCalled()
    expect(factory).not.toHaveBeenCalled()

    releaseMutation()
    await mutating
    await expect(starting).resolves.toBe(host)
    expect(host.start).toHaveBeenCalledOnce()
    await daemon.stop()
  }, 20_000)

  it('still refuses a host start when a hard gate closes while the mutation drains', async () => {
    const factory = vi.fn(() => quietHost() as any)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold(), hostFactory: factory })
    await daemon.start()

    let releaseMutation!: () => void
    const mutationBlocked = new Promise<void>((resolve) => (releaseMutation = resolve))
    const mutating = (daemon as any).withWorkspaceAdmissionFence('bot-a', () => mutationBlocked) as Promise<void>
    const starting = (daemon as any).ensureHostAsync('bot-a') as Promise<unknown>
    await new Promise<void>((resolve) => setImmediate(resolve))

    // Joining the fence must not launder a real refusal: the gates are re-read on the far side.
    ;(daemon as any).drainingAgents.add('bot-a')
    releaseMutation()
    await mutating
    await expect(starting).rejects.toThrow(/agent is draining/)
    expect(factory).not.toHaveBeenCalled()
    ;(daemon as any).drainingAgents.delete('bot-a')
    await daemon.stop()
  }, 20_000)

  it('serializes workspace preparation and file publication in both admission orders', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    const agent = (daemon as any).agents.get('bot-a')

    let releasePreparation!: () => void
    const preparationBlocked = new Promise<void>((resolve) => (releasePreparation = resolve))
    let markPreparationEntered!: () => void
    const preparationEntered = new Promise<void>((resolve) => (markPreparationEntered = resolve))
    const preparing = (daemon as any).enqueueAgentWorkspacePreparation(agent, async () => {
      markPreparationEntered()
      await preparationBlocked
    }) as Promise<void>
    await preparationEntered

    let publicationEntered = false
    const publishingAfterPreparation = (daemon as any).withWorkspaceFileWrite('bot-a', async () => {
      publicationEntered = true
    }) as Promise<void>
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(publicationEntered).toBe(false)

    releasePreparation()
    await preparing
    await publishingAfterPreparation
    expect(publicationEntered).toBe(true)

    let releasePublication!: () => void
    const publicationBlocked = new Promise<void>((resolve) => (releasePublication = resolve))
    let markPublicationEntered!: () => void
    const publicationStarted = new Promise<void>((resolve) => (markPublicationEntered = resolve))
    const publishing = (daemon as any).withWorkspaceFileWrite('bot-a', async () => {
      markPublicationEntered()
      await publicationBlocked
    }) as Promise<void>
    await publicationStarted

    let laterPreparationEntered = false
    const preparingAfterPublication = (daemon as any).enqueueAgentWorkspacePreparation(agent, async () => {
      laterPreparationEntered = true
    }) as Promise<void>
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(laterPreparationEntered).toBe(false)

    releasePublication()
    await publishing
    await preparingAfterPublication
    expect(laterPreparationEntered).toBe(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((daemon as any).workspacePreparationTails.has('bot-a')).toBe(false)
    expect((daemon as any).workspaceDispatchFences.has('bot-a')).toBe(false)
    await daemon.stop()
  }, 20_000)

  it('writes the session back to idle once a turn finishes (no longer stuck prompting)', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    makeRoutable(daemon)
    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('idle')
    await daemon.stop()
  }, 15_000)

  it('does not post a cron anchor while the target agent is paused', async () => {
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    ;(daemon as any).agents.get('bot-a').pause = true

    await expect(
      (daemon as any).fireTrigger(
        'bot-a',
        { ...dm('100', 'scheduled'), source: 'cron' },
        { channel: 'C1', integrationId: 'int-a' },
        '⏰ scheduled',
        'cron "c1"'
      )
    ).resolves.toBeNull()
    expect(conn.postMessage).not.toHaveBeenCalled()
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  }, 15_000)

  it('attributes a cron anchor to its agent and uses its Slack timestamp for follow-ups', async () => {
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    Object.assign((daemon as any).agents.get('bot-a'), {
      displayName: 'Review Bot',
      iconUrl: 'https://console.example.test/icons/review-bot'
    })
    const conn = makeRoutable(daemon)
    const postMessage = vi.fn(async () => '100.100000')
    Object.assign(conn, {
      postMessage,
      postBlocks: vi.fn(async () => 'status-1'),
      updateBlocks: vi.fn(async () => {})
    })

    await (daemon as any).fireTrigger(
      'bot-a',
      {
        ...dm('ignored', 'scheduled', 'cron:cron-1:trace-1'),
        msgId: 'cron:cron-1:trace-1',
        traceId: 'trace-1',
        source: 'cron',
        trigger: 'cron',
        isDm: false
      },
      { channel: 'C1', integrationId: 'int-a' },
      '⏰ scheduled',
      'cron "cron-1"'
    )

    expect(postMessage).toHaveBeenCalledWith('C1', '⏰ scheduled', undefined, {
      username: 'Review Bot',
      icon_url: 'https://console.example.test/icons/review-bot',
      agentAuthorId: 'bot-a'
    })
    const key = sessionKey('slack', 'C1', '100.100000', 'bot-a', TRANSPORT_SCOPE)
    expect((await (daemon as any).store.getSession(key))?.lastDeliveredTs).toBe('100.100000')

    await (daemon as any).dispatch(
      'bot-a',
      { ...dm('100.200000', 'are you sure?', '100.100000'), isDm: false },
      'int-a'
    )
    expect(host.prompt).toHaveBeenCalledTimes(2)
    const secondPrompt = ((host.prompt as any).mock.calls[1][1] as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n')
    expect(secondPrompt).toContain('are you sure?')
    await daemon.stop()
  }, 15_000)

  it('§6.8: a telegram anchored fire keys the session by that platform conversation model', async () => {
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const postMessage = vi.fn(async () => '777')
    // Re-home int-a onto the telegram connection map (makeRoutable wires the slack
    // map, which the integration lookup checks first).
    ;(daemon as any).connByIntegration.delete('int-a')
    ;(daemon as any).tgConnByIntegration.set('int-a', {
      postMessage,
      postChrome: vi.fn(async () => {}),
      updateMessage: vi.fn(async () => {})
    })

    await (daemon as any).fireTrigger(
      'bot-a',
      {
        ...dm('ignored', 'scheduled', 'cron:cron-tg:trace-1'),
        msgId: 'cron:cron-tg:trace-1',
        traceId: 'trace-1',
        source: 'cron',
        trigger: 'cron',
        platform: 'telegram',
        channel: '-100123',
        isDm: false
      },
      { channel: '-100123', integrationId: 'int-a' },
      '⏰ scheduled',
      'cron "cron-tg"'
    )

    expect(postMessage).toHaveBeenCalledWith('-100123', '⏰ scheduled')
    // threadKeyForPost: a Telegram reply chain resolves to `tg:<root>` — the anchor
    // session must mint the SAME key or follow-up replies open a different session.
    const key = sessionKey('telegram', '-100123', 'tg:777', 'bot-a', TRANSPORT_SCOPE)
    expect(await (daemon as any).store.getSession(key)).toBeTruthy()
    await daemon.stop()
  }, 15_000)

  it('§6.8: a telegram DM anchored fire keys `dm` and classifies as a DM session', async () => {
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const postMessage = vi.fn(async () => '888')
    const getChannelInfo = vi.fn(async () => ({ isIm: true }))
    ;(daemon as any).connByIntegration.delete('int-a')
    ;(daemon as any).tgConnByIntegration.set('int-a', {
      postMessage,
      getChannelInfo,
      postChrome: vi.fn(async () => {}),
      updateMessage: vi.fn(async () => {})
    })

    await (daemon as any).fireTrigger(
      'bot-a',
      {
        ...dm('ignored', 'scheduled', 'cron:cron-dm:trace-1'),
        msgId: 'cron:cron-dm:trace-1',
        traceId: 'trace-1',
        source: 'cron',
        trigger: 'cron',
        platform: 'telegram',
        channel: '42',
        isDm: false
      },
      { channel: '42', integrationId: 'int-a' },
      '⏰ scheduled',
      'cron "cron-dm"'
    )

    expect(getChannelInfo).toHaveBeenCalledWith('42')
    // A Telegram DM is ONE continuous conversation keyed `dm` — the anchor must
    // join it, not open a `tg:<messageId>` session no inbound reply resolves to.
    const key = sessionKey('telegram', '42', 'dm', 'bot-a', TRANSPORT_SCOPE)
    expect(await (daemon as any).store.getSession(key)).toBeTruthy()
    await daemon.stop()
  }, 15_000)

  it('§6.8: a discord DM anchored fire classifies as a private DM session', async () => {
    // A Discord DM is one continuous conversation keyed by its channel. The same
    // classification also drives `conversationKind` and the private-capture gate.
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const postMessage = vi.fn(async () => 'msg-1')
    const getChannelInfo = vi.fn(async () => ({ id: 'D-1', isIm: true }))
    ;(daemon as any).connByIntegration.delete('int-a')
    ;(daemon as any).dcConnByIntegration.set('int-a', {
      postMessage,
      getChannelInfo,
      postChrome: vi.fn(async () => {}),
      updateMessage: vi.fn(async () => {})
    })

    await (daemon as any).fireTrigger(
      'bot-a',
      {
        ...dm('ignored', 'scheduled', 'cron:cron-dc:trace-1'),
        msgId: 'cron:cron-dc:trace-1',
        traceId: 'trace-1',
        source: 'cron',
        trigger: 'cron',
        platform: 'discord',
        channel: 'D-1',
        isDm: false
      },
      { channel: 'D-1', integrationId: 'int-a' },
      '⏰ scheduled',
      'cron "cron-dc"'
    )

    expect(getChannelInfo).toHaveBeenCalledWith('D-1')
    const key = sessionKey('discord', 'D-1', 'D-1', 'bot-a', TRANSPORT_SCOPE)
    const rec = await (daemon as any).store.getSession(key)
    expect(rec?.conversationKind).toBe('dm')
    // The private-capture gate follows the same bit.
    expect(await (daemon as any).store.isCaptureExcluded('bot-a', rec?.acpSessionId)).toBe(true)
    await daemon.stop()
  }, 15_000)

  it('§6.8: a discord guild anchored fire materializes its native thread before dispatch', async () => {
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const postMessage = vi.fn(async () => 'msg-1')
    const getChannelInfo = vi.fn(async () => ({ id: 'C-1', isIm: false }))
    const createThread = vi.fn(async () => 'msg-1')
    ;(daemon as any).connByIntegration.delete('int-a')
    ;(daemon as any).dcConnByIntegration.set('int-a', {
      postMessage,
      getChannelInfo,
      createThread,
      postChrome: vi.fn(async () => {}),
      updateMessage: vi.fn(async () => {})
    })

    await (daemon as any).fireTrigger(
      'bot-a',
      {
        ...dm('ignored', 'scheduled', 'cron:cron-dc-guild:trace-1'),
        msgId: 'cron:cron-dc-guild:trace-1',
        traceId: 'trace-1',
        source: 'cron',
        trigger: 'cron',
        platform: 'discord',
        channel: 'C-1',
        isDm: false
      },
      { channel: 'C-1', integrationId: 'int-a' },
      '⏰ scheduled',
      'cron "cron-dc-guild"'
    )

    expect(createThread).toHaveBeenCalledWith('C-1', 'msg-1', '⏰ scheduled')
    const key = sessionKey('discord', 'C-1', 'msg-1', 'bot-a', TRANSPORT_SCOPE)
    expect(await (daemon as any).store.getSession(key)).toBeTruthy()
    await daemon.stop()
  }, 15_000)

  it('§6.8: a discord guild anchored fire starts no session when thread creation fails', async () => {
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    makeRoutable(daemon)
    const createThread = vi.fn(async () => undefined)
    ;(daemon as any).connByIntegration.delete('int-a')
    ;(daemon as any).dcConnByIntegration.set('int-a', {
      postMessage: vi.fn(async () => 'msg-1'),
      getChannelInfo: vi.fn(async () => ({ id: 'C-1', isIm: false })),
      createThread,
      postChrome: vi.fn(async () => {}),
      updateMessage: vi.fn(async () => {})
    })

    const result = await (daemon as any).fireTrigger(
      'bot-a',
      {
        ...dm('ignored', 'scheduled', 'cron:cron-dc-failed:trace-1'),
        msgId: 'cron:cron-dc-failed:trace-1',
        traceId: 'trace-1',
        source: 'cron',
        trigger: 'cron',
        platform: 'discord',
        channel: 'C-1',
        isDm: false
      },
      { channel: 'C-1', integrationId: 'int-a' },
      '⏰ scheduled',
      'cron "cron-dc-failed"'
    )

    expect(result).toBeNull()
    expect(
      await (daemon as any).store.getSession(sessionKey('discord', 'C-1', 'msg-1', 'bot-a', TRANSPORT_SCOPE))
    ).toBeUndefined()
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  }, 15_000)

  it('reports a cron session before its turn finishes', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    Object.assign(conn, {
      postBlocks: vi.fn(async () => 'status-1'),
      updateBlocks: vi.fn(async () => {})
    })
    const emitCronReport = vi.fn()
    ;(daemon as any).cpClient = {
      emitCronReport,
      emitEventSession: vi.fn(),
      emitUsageReport: vi.fn(),
      stop: vi.fn(async () => {})
    }

    const run = (daemon as any).onCronFire(
      'bot-a',
      { ...dm('100', 'scheduled'), source: 'cron' },
      {
        id: 'cron-1',
        schedule: '0 9 * * *',
        timezone: 'UTC',
        trigger: 'scheduled',
        enabled: true,
        origin: 'cp',
        target: { platform: 'slack', channel: 'C1', integrationId: 'int-a' }
      }
    )

    await vi.waitFor(() => expect(blocked.host.prompt).toHaveBeenCalledWith('acp-1', expect.any(Array)), WAIT)
    expect(emitCronReport).toHaveBeenCalledTimes(2)
    expect(emitCronReport.mock.calls[0]![0]).not.toHaveProperty('sessionId')
    // A cron run is a console deep link on the CP side, so it is reported under the session's
    // outward id (session-concept.md §1.1) — the same one on the ready report and the close.
    const outward = (await (daemon as any).store.getSessionByAcpId('acp-1'))!.sessionId
    expect(outward).not.toBe('acp-1')
    expect(emitCronReport.mock.calls[1]![0]).toMatchObject({ sessionId: outward })
    expect(emitCronReport.mock.calls[1]![0]).not.toHaveProperty('status')

    blocked.release()
    await run
    expect(emitCronReport.mock.calls[2]![0]).toMatchObject({ status: 'success', sessionId: outward })
    await daemon.stop()
  }, 15_000)

  it('!stop sets cancelling, and the backstop force-stops the host if the agent ignores cancel', async () => {
    const clock = new FakeClock()
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any,
      clock
    })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined(), WAIT)

    await (daemon as any).onInboundOutcome(dm('200', '!stop'))
    expect(blocked.host.cancel).toHaveBeenCalledWith('acp-1')
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('cancelling')

    // agent ignores session/cancel → after cancelBackstopMs the host is force-stopped
    clock.advance(30_000)
    await vi.waitFor(() => expect(blocked.host.stop).toHaveBeenCalled(), WAIT)
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await vi.waitFor(async () => expect((await (daemon as any).store.getSession(KEY))?.state).toBe('idle'), WAIT)

    blocked.release()
    await turn.catch(() => {})
    await daemon.stop()
  }, 15_000)

  // A background memory write races teardown here and its atomic rename hits EPERM — Windows cannot replace a file another handle holds open. Tracked separately.
  it.skipIf(process.platform === 'win32')(
    'pausing interrupts every active session, drops queued turns, and keeps the host warm',
    async () => {
      const root = scaffold()
      const blocked = multiBlockingHost()
      const daemon = new Daemon({
        slackAppFactory: fakeSlackAppFactory(),
        root,
        hostFactory: () => blocked.host as any
      })
      await daemon.start()

      const first = (daemon as any).dispatch('bot-a', dm('100', 'first', 'T1'))
      const second = (daemon as any).dispatch('bot-a', dm('200', 'second', 'T2'))
      await vi.waitFor(() => expect((daemon as any).pending.size).toBe(2), WAIT)
      const queued = (daemon as any).dispatch('bot-a', dm('300', 'queued', 'T1'))
      await vi.waitFor(() => expect((daemon as any).serialQueue.get(KEY)).toHaveLength(1), WAIT)

      writePause(root, true)
      await daemon.reconcile()

      expect((daemon as any).agents.get('bot-a').pause).toBe(true)
      expect(blocked.host.cancel).toHaveBeenCalledTimes(2)
      expect(new Set(blocked.host.cancel.mock.calls.map(([id]) => id))).toEqual(new Set(['acp-1', 'acp-2']))
      await expect(queued).resolves.toBeNull()
      expect((daemon as any).serialQueue.size).toBe(0)
      expect(await (daemon as any).store.listInboxBySessionKeyFifo()).toHaveLength(0)
      expect(blocked.host.stop).not.toHaveBeenCalled()

      const promptCount = blocked.host.prompt.mock.calls.length
      await expect((daemon as any).dispatch('bot-a', dm('400', 'paused', 'T3'))).resolves.toBeNull()
      expect(blocked.host.prompt).toHaveBeenCalledTimes(promptCount)

      blocked.release()
      await Promise.all([first, second])
      expect((daemon as any).hosts.has('bot-a')).toBe(true)

      writePause(root, false)
      await daemon.reconcile()
      await expect((daemon as any).dispatch('bot-a', dm('500', 'resumed', 'T3'))).resolves.toBe('acp-3')
      expect(blocked.host.prompt).toHaveBeenCalledTimes(promptCount + 1)

      await daemon.stop()
    },
    15_000
  )

  it('pausing suppresses renderer actions already queued by the old turn', async () => {
    const root = scaffold()
    const blocked = blockingHost()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => blocked.host as any })
    await daemon.start()
    const conn = makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'stream', 'T1'))
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined(), WAIT)
    const pending = pendingFor(daemon, 'acp-1')
    let releaseApply!: () => void
    pending.signals.applyChain = new Promise<void>((resolve) => (releaseApply = resolve))
    ;(daemon as any).enqueueApply(pending, { kind: 'post', text: 'must not post' })

    writePause(root, true)
    await daemon.reconcile()
    expect(pending.outputSuppressed).toBe('pause')
    releaseApply()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(conn.postMessage).not.toHaveBeenCalledWith('C1', 'must not post', 'T1')

    // New ACP chunks after the pause are ignored too.
    ;(daemon as any).onAcpUpdate('bot-a', 'acp-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'also suppressed' }
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(conn.postMessage).not.toHaveBeenCalled()

    blocked.release()
    await expect(turn).resolves.toBeNull()
    await daemon.stop()
  }, 15_000)

  it('does not revive a cold pre-pause turn after a quick unpause', async () => {
    const root = scaffold()
    const cold = coldBlockingHost()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => cold.host as any })
    await daemon.start()

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'cold', 'T1'))
    await vi.waitFor(() => expect(cold.host.newSession).toHaveBeenCalledTimes(1), WAIT)
    expect((daemon as any).pending.size).toBe(0)

    writePause(root, true)
    await daemon.reconcile()
    // Unpause before the cold newSession resolves. The old entry must retain its
    // per-turn cancellation latch, and the agent-level drain gate stays closed until
    // that entry fully unwinds.
    writePause(root, false)
    await daemon.reconcile()
    expect((daemon as any).agents.get('bot-a').pause).toBe(false)
    await expect((daemon as any).dispatch('bot-a', dm('150', 'too early', 'T2'))).resolves.toBeNull()
    cold.releaseSession()

    await expect(turn).resolves.toBeNull()
    expect(cold.host.prompt).not.toHaveBeenCalled()
    expect(cold.host.cancel).not.toHaveBeenCalled()
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('idle')

    await vi.waitFor(() => expect((daemon as any).safetyDrainingAgents.has('bot-a')).toBe(false), WAIT)
    await expect((daemon as any).dispatch('bot-a', dm('200', 'fresh', 'T2'))).resolves.toBe('acp-cold')
    expect(cold.host.prompt).toHaveBeenCalledTimes(1)

    await daemon.stop()
  }, 15_000)
})

describe('Daemon idle sweep (#111/#118)', () => {
  it('reaps an idle host back to provisioned and TTL-closes its session', async () => {
    const clock = new FakeClock()
    const host = quietHost()
    let onUpdate!: (sessionId: string, update: unknown) => void
    host.stop = vi.fn(async () => {
      await onUpdate('acp-1', { sessionUpdate: 'session_info_update', title: 'Final stopped title' })
    })
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold({ agentIdleTimeoutMs: 1000, idleSweepMs: 1000 }),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      },
      clock
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('idle')

    // advance past the TTL so the next sweep reaps the host + closes the session
    clock.advance(1001)
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false), WAIT)
    expect(host.stop).toHaveBeenCalled()
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('closed')
    expect((await (daemon as any).store.getSession(KEY))?.title).toBe('Final stopped title')
    await vi.waitFor(() => expect(conn.setTitle).toHaveBeenCalledWith('C1', 'T1', 'Final stopped title'), WAIT)

    await daemon.stop()
  }, 15_000)

  it('does not TTL-close a session while an admitted initialization owns its dispatch fences', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({
      root: scaffold({ agentIdleTimeoutMs: 1000, idleSweepMs: 10_000_000 }),
      hostFactory: () => quietHost() as any,
      clock
    })
    await daemon.start()
    makeRoutable(daemon)
    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')

    let releaseActive!: () => void
    const active = new Promise<void>((resolve) => (releaseActive = resolve))
    ;(daemon as any).inflight.add(KEY)
    ;(daemon as any).activeDispatchDoneByKey.set(KEY, active)
    ;(daemon as any).activeDispatchesByAgent.set('bot-a', new Set([active]))
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('idle')

    ;(daemon as any).inflight.delete(KEY)
    ;(daemon as any).activeDispatchDoneByKey.delete(KEY)
    ;(daemon as any).activeDispatchesByAgent.delete('bot-a')
    releaseActive()
    await (daemon as any).sweepIdle()
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('closed')

    await daemon.stop()
  }, 15_000)

  it('removes the materialized config-file secrets when the host stops', async () => {
    const clock = new FakeClock()
    const host = quietHost()
    const root = scaffold({ agentIdleTimeoutMs: 1000, idleSweepMs: 1000 })
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => host as any, clock })
    await daemon.start()
    makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    // Simulate what the real spawn path materializes (the hostFactory seam skips
    // the runtime-env work); the reaper must remove it with the host.
    const secretsDir = configFilesDir(join(root, 'agents', 'bot-a'))
    mkdirSync(secretsDir, { recursive: true })
    writeFileSync(join(secretsDir, 'kubeconfig'), 'apiVersion: v1')

    clock.advance(1001)
    // The host leaves the map synchronously at the top of stopHost; the secret
    // files go away when the teardown settles — wait for that edge separately.
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false), WAIT)
    await vi.waitFor(() => expect(existsSync(secretsDir)).toBe(false), WAIT)

    await daemon.stop()
  }, 15_000)

  it('idle-sweeps config-file secrets while the host stays warm, and re-materializes before the next turn', async () => {
    const clock = new FakeClock()
    const host = quietHost()
    const root = scaffold({ agentIdleTimeoutMs: 1_000_000, idleSweepMs: 10_000_000, configFilesIdleMs: 1000 })
    const adir = join(root, 'agents', 'bot-a')
    const kubeFile = join(configFilesDir(adir), 'kubeconfig')
    // Record whether the file was on disk at the moment each turn reached the child.
    const sawFileAtPrompt: boolean[] = []
    host.prompt = vi.fn(async () => {
      sawFileAtPrompt.push(existsSync(kubeFile))
      return 'end_turn'
    })
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => host as any, clock })
    await daemon.start()
    makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    // Simulate what the real spawn path records + materializes (the hostFactory
    // seam skips the runtime-env work).
    const entry = (daemon as any).hostConfigFiles.get('bot-a')
    entry.childEnv = { KUBECONFIG_DATA: 'apiVersion: v1' }
    entry.materialized = true
    mkdirSync(configFilesDir(adir), { recursive: true })
    writeFileSync(kubeFile, 'apiVersion: v1')
    const configRootInode = statSync(configFilesDir(adir)).ino

    // Quiet past configFilesIdleMs → the files go, the host and its bind-mounted
    // config root stay warm.
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    expect(existsSync(kubeFile)).toBe(false)
    expect(statSync(configFilesDir(adir)).ino).toBe(configRootInode)
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    // The next turn re-writes the file BEFORE the prompt reaches the child.
    await (daemon as any).dispatch('bot-a', dm('101', 'again'), 'int-a')
    expect(sawFileAtPrompt.at(-1)).toBe(true)
    expect(readFileSync(kubeFile, 'utf8')).toBe('apiVersion: v1')
    expect(statSync(configFilesDir(adir)).ino).toBe(configRootInode)

    await daemon.stop()
  }, 15_000)

  it('does not sweep config-file secrets while a turn is in flight', async () => {
    const clock = new FakeClock()
    const blocked = multiBlockingHost()
    const root = scaffold({ agentIdleTimeoutMs: 1_000_000, idleSweepMs: 10_000_000, configFilesIdleMs: 1000 })
    const adir = join(root, 'agents', 'bot-a')
    const kubeFile = join(configFilesDir(adir), 'kubeconfig')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: () => blocked.host as any,
      clock
    })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(blocked.host.prompt).toHaveBeenCalled(), WAIT)
    const entry = (daemon as any).hostConfigFiles.get('bot-a')
    entry.childEnv = { KUBECONFIG_DATA: 'apiVersion: v1' }
    entry.materialized = true
    mkdirSync(configFilesDir(adir), { recursive: true })
    writeFileSync(kubeFile, 'apiVersion: v1')

    // Way past the quiet window, but the turn is still running → files must stay.
    clock.advance(5000)
    await (daemon as any).sweepIdle()
    expect(existsSync(kubeFile)).toBe(true)

    blocked.release()
    await turn
    await daemon.stop()
  }, 15_000)

  it('sweeps config-file secrets left behind by a non-graceful exit at startup', async () => {
    const root = scaffold()
    const secretsDir = configFilesDir(join(root, 'agents', 'bot-a'))
    mkdirSync(secretsDir, { recursive: true })
    writeFileSync(join(secretsDir, 'kubeconfig'), 'stale')

    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => quietHost() as any })
    await daemon.start()
    expect(existsSync(secretsDir)).toBe(false)
    await daemon.stop()
  }, 15_000)

  it('does not instantly reclaim a freshly-started host that has served no turn', async () => {
    // Regression: a host that is up but has recorded NO session activity has an unset
    // `agentLastActivityTs` (⇒ 0). At a realistic wall-clock the reaper's `now - 0`
    // dwarfs the TTL, so the host was reclaimed the instant it came up — racing its
    // own first dispatch (ACP "connection closed" → "already started" → "Session not
    // found"). The idle window must run from when the host STARTED, not from epoch.
    const clock = new FakeClock()
    clock.advance(1_700_000_000_000) // a realistic epoch, so `now - 0` ≫ TTL (the bug's trigger)
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold({ agentIdleTimeoutMs: 1000, idleSweepMs: 10_000_000 }),
      hostFactory: () => host as any,
      clock
    })
    await daemon.start()

    // Bring the host up WITHOUT a turn (no activity stamped).
    await (daemon as any).ensureHostAsync('bot-a')
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    // A sweep BEFORE the TTL-from-start must NOT reclaim it (pre-fix: reclaimed).
    clock.advance(500)
    await (daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    // Past the TTL measured from host start → now genuinely idle → reclaimed.
    clock.advance(600) // 1100ms since start > 1000ms TTL
    await (daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false), WAIT)
    expect(host.stop).toHaveBeenCalled()

    await daemon.stop()
  }, 15_000)
})

describe('Daemon idle sweep — background-task lease', () => {
  const evt = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype, ...extra })

  async function bootWithTurn(clock: FakeClock, limits: Record<string, number>) {
    const host = quietHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(limits),
      hostFactory: () => host as any,
      clock
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    return { daemon, host, conn }
  }

  it('defers host reclaim + session TTL-close while a background task is live, then reclaims once it settles', async () => {
    const clock = new FakeClock()
    const { daemon, host } = await bootWithTurn(clock, {
      agentIdleTimeoutMs: 1000,
      agentMaxLifetimeMs: 10_000_000,
      idleSweepMs: 10_000_000
    })

    // A run_in_background task starts — the lease is non-empty.
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))

    // Past the idle TTL, but the lease defers reclaim AND spares the session from close.
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('idle')

    // The task settles, but its completion wake is now armed — that still fences reclaim, or
    // the sweep would close the session out from under a delivery about to happen.
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
    clock.advance(1001) // past the TTL again, still inside the wake's grace window
    await (daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('idle')

    // Wake fires and is delivered; the fence is held until that turn SETTLES, not until it is
    // dispatched, so wait on the count rather than on the timer set.
    clock.advance(4000)
    await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false), WAIT)
    await vi.waitFor(async () => expect((await (daemon as any).store.getSession(KEY))?.state).toBe('idle'), WAIT)
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false), WAIT)
    expect(host.stop).toHaveBeenCalled()
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('closed')

    await daemon.stop()
  }, 15_000)

  it('a running SDK cycle (followup turn) with no tasks defers reclaim until it returns to idle', async () => {
    const clock = new FakeClock()
    const { daemon } = await bootWithTurn(clock, {
      agentIdleTimeoutMs: 1000,
      agentMaxLifetimeMs: 10_000_000,
      idleSweepMs: 10_000_000
    })

    // end_turn fired, but Claude self-woke a followup turn to drain a completed task —
    // no `this.pending` entry, only the SDK cycle is running.
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'running' }))
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'idle' }))
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false), WAIT)

    await daemon.stop()
  }, 15_000)

  it('an authoritative background_tasks_changed snapshot heals missed settle edges', async () => {
    const clock = new FakeClock()
    const { daemon } = await bootWithTurn(clock, {
      agentIdleTimeoutMs: 1000,
      agentMaxLifetimeMs: 10_000_000,
      idleSweepMs: 10_000_000
    })

    // Two tasks start; both settle edges are LOST — only an empty snapshot arrives.
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't2' }))
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true) // still deferred

    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('background_tasks_changed', { tasks: [] }))
    // Both settled on that one edge, so both completion wakes are armed and still fence reclaim.
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    clock.advance(4000)
    await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false), WAIT)
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false), WAIT)

    await daemon.stop()
  }, 15_000)

  it('force-reclaims past the absolute lifetime ceiling even with a live background task', async () => {
    const clock = new FakeClock()
    // ceiling only just above the idle TTL so we can cross it deterministically
    const { daemon, host } = await bootWithTurn(clock, {
      agentIdleTimeoutMs: 1000,
      agentMaxLifetimeMs: 2000,
      idleSweepMs: 10_000_000
    })

    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))

    // Past the idle TTL but under the ceiling → deferred.
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    // Past the ceiling (from host start) → force reclaim despite the live task.
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false), WAIT)
    expect(host.stop).toHaveBeenCalled()

    await daemon.stop()
  }, 15_000)

  it('announces a completed background task to the thread when output mode ≥ medium', async () => {
    const clock = new FakeClock()
    const { daemon, conn } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })
    await (daemon as any).store.setOutputModeOverride(KEY, 'medium')

    await (daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 't1', description: 'Sleep for 15 seconds' })
    )
    expect(conn.postMessage).not.toHaveBeenCalled() // nothing on start
    await (daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_updated', { task_id: 't1', patch: { status: 'completed' } })
    )

    expect(conn.postMessage).toHaveBeenCalledTimes(1)
    const [channel, text, thread] = (conn.postMessage as any).mock.calls[0]
    expect(channel).toBe('C1')
    expect(thread).toBe('T1')
    expect(text).toContain('Sleep for 15 seconds')
    expect(text).toContain('completed')

    // The near-simultaneous task_notification for the same task must NOT double-post.
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
    expect(conn.postMessage).toHaveBeenCalledTimes(1)
    await daemon.stop()
  }, 15_000)

  it('does not announce when output mode is below medium', async () => {
    const clock = new FakeClock()
    const { daemon, conn } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })
    await (daemon as any).store.setOutputModeOverride(KEY, 'low')

    await (daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 't1', description: 'Sleep for 15 seconds' })
    )
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
    expect(conn.postMessage).not.toHaveBeenCalled()
    await daemon.stop()
  }, 15_000)

  it('does not announce an internal subagent task', async () => {
    const clock = new FakeClock()
    const { daemon, conn } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })
    await (daemon as any).store.setOutputModeOverride(KEY, 'high')

    await (daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 's1', subagent_type: 'general', description: 'a subagent' })
    )
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 's1' }))
    expect(conn.postMessage).not.toHaveBeenCalled() // subagents are internal — not announced
    await daemon.stop()
  }, 15_000)

  // The `run_in_background` "you will be notified when it completes" contract is a HARNESS
  // promise, not an SDK one. Under ACP the foreground turn has already returned end_turn by
  // the time the task settles, so the daemon has to deliver the completion itself or the work
  // (and anything the model owed on the back of it) is stranded.
  describe('waking the session when a background task settles', () => {
    it('wakes the idle session with a fresh turn once the grace period passes', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })
      await (daemon as any).store.setOutputModeOverride(KEY, 'low') // a wake is NOT gated on output mode
      expect(host.prompt).toHaveBeenCalledTimes(1) // just the human turn so far

      await (daemon as any).onSdkLifecycle(
        'bot-a',
        'acp-1',
        evt('task_started', { task_id: 't1', description: 'Sleep 30s then print the time' })
      )
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      expect(host.prompt).toHaveBeenCalledTimes(1) // deferred, not immediate

      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
      const woken = JSON.stringify((host.prompt as any).mock.calls[1])
      expect(woken).toContain('background task finished')
      expect(woken).toContain('Sleep 30s then print the time')
      expect(woken).toContain('t1')
      await daemon.stop()
    }, 15_000)

    // The runtime's own self-drain cycle produces NOTHING a user can see (no Pending ⇒
    // onAcpUpdate drops it), so the wake waits it out but must never stand down for it.
    it('waits out the runtime self-drain cycle, then wakes anyway', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      // Claude self-woke a followup cycle to drain it.
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'running' }))

      clock.advance(4000) // re-armed, not abandoned
      await vi.waitFor(() => expect((daemon as any).bgWakeTimers.size).toBe(1), WAIT)
      expect((daemon as any).sdkLease.get(LEASE_KEY)?.armedWakes).toBe(1) // fence never dipped
      expect(host.prompt).toHaveBeenCalledTimes(1)

      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'idle' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
      await daemon.stop()
    }, 15_000)

    it('gives up re-arming if the runtime cycle never returns to idle', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'running' }))

      // 15 re-arms then nothing left armed — a wedged cycle must not be polled forever.
      for (let i = 0; i < 16; i++) {
        clock.advance(4000)
        await new Promise((r) => setImmediate(r))
      }
      expect((daemon as any).bgWakeTimers.size).toBe(0)
      expect(host.prompt).toHaveBeenCalledTimes(1)
      await daemon.stop()
    }, 15_000)

    it('wakes once for the last task, not once per task', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't2' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      clock.advance(4000) // t2 is still live — t1's wake must stand down
      await new Promise((r) => setImmediate(r))
      expect(host.prompt).toHaveBeenCalledTimes(1)

      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't2' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
      await daemon.stop()
    }, 15_000)

    // The armed wake must fence automatic cleanup: `settle()` removes the task before the
    // timer is armed, so a session whose task outlived the TTL would otherwise be closed
    // (and its lease dropped) inside the grace window — losing the completion again.
    it('keeps the session non-quiescent while a wake is armed, and releases it after', async () => {
      const clock = new FakeClock()
      const { daemon } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      expect((daemon as any).sdkLease.get(LEASE_KEY)?.tasks.size).toBe(0) // task already released
      expect((daemon as any).sdkLease.get(LEASE_KEY)?.armedWakes).toBe(1)
      expect((daemon as any).sessionSdkQuiescent('bot-a', 'acp-1')).toBe(false)
      expect((daemon as any).agentHasLiveSdkWork('bot-a')).toBe(true)

      clock.advance(4000)
      await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false), WAIT)
      expect((daemon as any).sessionSdkQuiescent('bot-a', 'acp-1')).toBe(true)
      await daemon.stop()
    }, 15_000)

    // The hand-off after the fence is released is its own race: `dispatch()` claims the serial
    // gate synchronously, but `dispatchOne` then awaits thread history / attachments / memory
    // recall before SessionManager writes `state = 'prompting'`. Releasing at dispatch time
    // would leave an already-expired session reading quiescent AND idle for that whole window.
    it('holds the fence through async turn initialization, not just up to dispatch', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, {
        agentIdleTimeoutMs: 1000,
        agentMaxLifetimeMs: 10_000_000,
        idleSweepMs: 10_000_000
      })
      // Stall initialization exactly where it is slow in production (managed-memory recall),
      // i.e. AFTER the wake's dispatch but BEFORE the row leaves `idle`.
      let releaseRecall!: () => void
      const recallBlocked = new Promise<void>((resolve) => (releaseRecall = resolve))
      const memory = (daemon as any).memory
      const realRecall = memory.recallForTurn.bind(memory)
      memory.recallForTurn = async (...args: unknown[]) => {
        await recallBlocked
        return realRecall(...args)
      }

      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT) // wake dispatched, stalled

      // Past the TTL, mid-initialization: the row is still `idle` and has no Pending, so only
      // the lease fence can keep the sweep off it.
      clock.advance(1001)
      await (daemon as any).sweepIdle()
      expect((await (daemon as any).store.getSession(KEY))?.state).not.toBe('closed')
      expect((daemon as any).hosts.has('bot-a')).toBe(true)
      expect(host.stop).not.toHaveBeenCalled()

      releaseRecall()
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
      await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false), WAIT)
      await daemon.stop()
    }, 15_000)

    // The dispatch promise deliberately outlives `host.prompt()` (renderer/finalization still
    // runs). A task settling in THAT window cannot have been observed in-turn — the model has
    // already stopped — so it must not be coalesced into the delivery that is finishing.
    it('delivers a task that settles after a wake prompt returned but before its turn settles', async () => {
      const clock = new FakeClock()
      // Hold wake A's turn open (its prompt blocks) while telling the lease the model has gone
      // idle — that pair IS the post-prompt/pre-cleanup window.
      let releaseA!: () => void
      const aBlocked = new Promise<void>((resolve) => (releaseA = resolve))
      let prompts = 0
      const host = {
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-1'),
        prompt: vi.fn(async () => {
          if (++prompts === 2) await aBlocked
          return 'end_turn'
        }),
        cancel: vi.fn(async () => {}),
        stop: vi.fn(async () => {})
      }
      const daemon = new Daemon({
        slackAppFactory: fakeSlackAppFactory(),
        root: scaffold({ agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 }),
        hostFactory: () => host as any,
        clock
      })
      await daemon.start()
      makeRoutable(daemon)
      await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')

      // Wake A → prompt #2, which blocks. Its dispatch stays pending.
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 'a' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 'a' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
      // The model is done even though the turn is not — exactly what the SDK reports here.
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'idle' }))

      // Task B settles inside that window. It must be deferred, not folded into A.
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 'b' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 'b' }))
      for (let i = 0; i < 3; i++) {
        clock.advance(4000)
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(host.prompt).toHaveBeenCalledTimes(2) // not delivered while A is in flight…
      expect(wakeFenceHeld(daemon)).toBe(true) // …and still owed, not discarded

      releaseA()
      // Once A settles, B's deferred wake re-arms and delivers: a THIRD prompt. Without the
      // deferral B is dropped here and this never reaches 3.
      await vi.waitFor(
        async () => {
          clock.advance(4000)
          await new Promise((r) => setTimeout(r, 20))
          expect(host.prompt).toHaveBeenCalledTimes(3)
        },
        { timeout: 8000, interval: 50 }
      )
      await daemon.stop()
    }, 20_000)

    it('does not wake for an internal subagent task', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      await (daemon as any).onSdkLifecycle(
        'bot-a',
        'acp-1',
        evt('task_started', { task_id: 's1', subagent_type: 'general' })
      )
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 's1' }))
      clock.advance(4000)
      await new Promise((r) => setImmediate(r))
      expect(host.prompt).toHaveBeenCalledTimes(1)
      await daemon.stop()
    }, 15_000)

    it('does not wake a session whose host was already reclaimed', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      await (daemon as any).stopHost('bot-a') // drops the lease with the ACP session

      clock.advance(4000)
      await new Promise((r) => setImmediate(r))
      expect(host.prompt).toHaveBeenCalledTimes(1)
      await daemon.stop()
    }, 15_000)

    // A wake has no hopCount to bound and a woken turn may start further background tasks, so
    // the budget is the only backstop against a self-feeding loop.
    it('stops waking once the per-session budget is exhausted', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      clock.advance(4000)
      const lease = (daemon as any).sdkLease.get(LEASE_KEY)
      await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false), WAIT)
      expect(host.prompt).toHaveBeenCalledTimes(2)
      expect(lease.bgWakes).toBe(1) // a delivered wake is spent

      // Pre-spend the rest rather than driving 19 more real turns: the property under test is
      // the refusal at the cap, not the arithmetic getting there.
      lease.bgWakes = 20
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't2' }))
      await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't2' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false), WAIT) // fence released, no wake
      expect(host.prompt).toHaveBeenCalledTimes(2)
      expect(lease.bgWakes).toBe(20) // never spends past the cap
      await daemon.stop()
    }, 30_000)
  })

  // ACP session ids are runtime-local: two agents can each expose `acp-1`. Sharing one lease
  // entry would let one agent's task overwrite the other's record, suppress its completion
  // wake (via `tasks.size`/`sdkState`), or spend its wake budget.
  it('keys the lease per (agent, ACP session) so two agents sharing an id do not collide', async () => {
    const clock = new FakeClock()
    const { daemon } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

    await (daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 't1', description: 'a-work' })
    )
    await (daemon as any).onSdkLifecycle(
      'bot-b',
      'acp-1',
      evt('task_started', { task_id: 't1', description: 'b-work' })
    )
    expect((daemon as any).sdkLease.size).toBe(2)
    expect((daemon as any).sdkLease.get(LEASE_KEY)?.tasks.get('t1')?.description).toBe('a-work')

    // Settling bot-b's identically-named task must not settle bot-a's.
    await (daemon as any).onSdkLifecycle('bot-b', 'acp-1', evt('task_notification', { task_id: 't1' }))
    expect((daemon as any).sdkLease.get(LEASE_KEY)?.tasks.size).toBe(1)
    expect((daemon as any).sessionSdkQuiescent('bot-a', 'acp-1')).toBe(false)
    await daemon.stop()
  }, 15_000)

  // `task/list` needs settled tasks to exist at all, and the ONLY safe place to keep them is
  // outside `lease.tasks`: every reclaim decision reads that map as the liveness set. These four
  // cases pin that the retained record is inert — it neither announces, nor wakes, nor spends the
  // wake budget, nor keeps a session or a host or a workspace mutation fenced.
  it('retains a settled task for the panel while keeping it out of every liveness read', async () => {
    const clock = new FakeClock()
    const { daemon, host, conn } = await bootWithTurn(clock, {
      agentIdleTimeoutMs: 1000,
      agentMaxLifetimeMs: 10_000_000,
      idleSweepMs: 10_000_000
    })
    await (daemon as any).store.setOutputModeOverride(KEY, 'medium')
    const lease = () => (daemon as any).sdkLease.get(LEASE_KEY)
    const announces = () =>
      (conn.postMessage as any).mock.calls.filter((call: any[]) => String(call[1]).includes('Sleep 15')).length

    await (daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 't1', description: 'Sleep 15' })
    )
    expect((daemon as any).agentHasLiveSdkWork('bot-a')).toBe(true)
    expect((daemon as any).workspaceMutationBusy('bot-a')).toBe(true) // console edits refused while it runs

    // Settled: released from the liveness set, retained for the panel.
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
    expect(lease().tasks.size).toBe(0)
    expect(lease().settled.map((t: any) => t.id)).toEqual(['t1'])
    expect(announces()).toBe(1)

    // Its wake delivers once; the fence clears with the retained record still in place.
    clock.advance(4000)
    await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false), WAIT)
    expect(lease().bgWakes).toBe(1)

    // The next authoritative snapshot no longer lists it. Re-settling a retained record is what
    // would re-announce, re-wake, and burn the 20-wake budget on EVERY subsequent snapshot.
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('background_tasks_changed', { tasks: [] }))
    expect(lease().bgWakes).toBe(1)
    expect(wakeFenceHeld(daemon)).toBe(false)
    expect(announces()).toBe(1)
    expect(lease().settled).toHaveLength(1)

    // Quiescent WITH the record retained, so the session TTL-closes and the host is reclaimed.
    expect((daemon as any).sessionSdkQuiescent('bot-a', 'acp-1')).toBe(true)
    expect((daemon as any).agentHasLiveSdkWork('bot-a')).toBe(false)
    expect((daemon as any).workspaceMutationBusy('bot-a')).toBe(false)
    await vi.waitFor(async () => expect((await (daemon as any).store.getSession(KEY))?.state).toBe('idle'), WAIT)
    clock.advance(1001)
    await (daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false), WAIT)
    expect(host.stop).toHaveBeenCalled()
    expect((await (daemon as any).store.getSession(KEY))?.state).toBe('closed')

    await daemon.stop()
  }, 15_000)

  it('projects the lease for task/list — running, done, and a failure refined by a later edge', async () => {
    const clock = new FakeClock()
    const { daemon } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })
    const list = async () => await (daemon as any).listBackgroundTasks({ agentId: 'bot-a', sessionId: 'acp-1' })
    // The console asks by the id it routed on — the outward one (session-concept.md §1.1) — and
    // must get the same lease back, since the lease itself is keyed by the runtime's id.
    const outwardList = async () =>
      await (daemon as any).listBackgroundTasks({
        agentId: 'bot-a',
        sessionId: (await (daemon as any).store.getSessionByAcpId('acp-1'))!.sessionId
      })

    await (daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 't1', description: 'Sleep 15' })
    )
    clock.advance(1000)
    await (daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 't2', subagent_type: 'general' })
    )

    // Live rows, newest start first. The internal subagent is CARRIED, not filtered at the source:
    // it fences reclaim exactly like a real task, so hiding it here would make the panel and the
    // thing deferring reclaim disagree. Consumers filter at render.
    expect((await list()).tasks.map((t: any) => [t.id, t.state, t.subagent])).toEqual([
      ['t2', 'running', true],
      ['t1', 'running', false]
    ])
    expect((await list()).tracked).toBe(true)
    expect((await outwardList()).tasks.map((t: any) => t.id)).toEqual((await list()).tasks.map((t: any) => t.id))
    expect((await list()).truncated).toBe(false)
    expect((await list()).tasks[1].description).toBe('Sleep 15')
    expect((await list()).tasks[1].startedAt).toBe(new Date(0).toISOString()) // the task_started edge's arrival
    expect((await list()).tasks[1].endedAt).toBeUndefined() // a live task has not ended
    expect((await list()).tasks[0].description).toBeUndefined() // the runtime omitted it

    // The snapshot settles both and carries NO status, which is the common case — so `done` means
    // "settled without a reported failure", and `detail` stays absent rather than claiming success.
    clock.advance(1000)
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('background_tasks_changed', { tasks: [] }))
    expect((await list()).tasks.map((t: any) => [t.id, t.state, t.endedAt, t.detail])).toEqual([
      ['t1', 'done', new Date(2000).toISOString(), undefined],
      ['t2', 'done', new Date(2000).toISOString(), undefined]
    ])

    // A later terminal edge DOES carry a status. Refining the retained row is the only way `failed`
    // is reachable at all, and it must stay display-only: no re-announce, no liveness change.
    await (daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_updated', { task_id: 't1', patch: { status: 'failed' } })
    )
    const refined = (await list()).tasks.find((t: any) => t.id === 't1')
    expect([refined.state, refined.detail]).toEqual(['failed', 'failed'])
    expect((daemon as any).sdkLease.get(LEASE_KEY).tasks.size).toBe(0)
    expect((daemon as any).sessionSdkQuiescent('bot-a', 'acp-1')).toBe(false) // t1's own wake, not the record

    await daemon.stop()
  }, 15_000)

  it('bounds the retained history and the page, and neither bound touches the liveness set', async () => {
    const clock = new FakeClock()
    const { daemon } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })
    const list = async () => await (daemon as any).listBackgroundTasks({ agentId: 'bot-a', sessionId: 'acp-1' })
    // Subagent tasks, so the sweep of settles below neither announces nor wakes — they are retained
    // and counted as live exactly like any other task, which is the point.
    const ids = Array.from({ length: MAX_TASK_LIST_TASKS + 1 }, (_unused, i) => `t${i}`)
    for (const id of ids) {
      clock.advance(1)
      await (daemon as any).onSdkLifecycle(
        'bot-a',
        'acp-1',
        evt('task_started', { task_id: id, subagent_type: 'general' })
      )
    }
    expect((daemon as any).sdkLease.get(LEASE_KEY).tasks.size).toBe(MAX_TASK_LIST_TASKS + 1)
    expect((await list()).tasks).toHaveLength(MAX_TASK_LIST_TASKS)
    expect((await list()).truncated).toBe(true)

    // All settle on one snapshot. Retention keeps the newest MAX_SETTLED_TASKS_PER_SESSION (20) and
    // the liveness set empties completely — the cap evicts history, never a live task.
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('background_tasks_changed', { tasks: [] }))
    expect((daemon as any).sdkLease.get(LEASE_KEY).tasks.size).toBe(0)
    expect((await list()).tasks).toHaveLength(20)
    expect((await list()).truncated).toBe(false)
    expect((await list()).tasks.map((t: any) => t.id)).not.toContain('t0') // oldest settle evicted first
    expect((await list()).tasks.every((t: any) => t.state === 'done' && t.subagent)).toBe(true)
    expect((daemon as any).sessionSdkQuiescent('bot-a', 'acp-1')).toBe(true) // 20 retained rows, still quiescent

    await daemon.stop()
  }, 15_000)

  it('answers a session with no lease as tracked:false, and an unknown agent as a violation', async () => {
    const clock = new FakeClock()
    const { daemon } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

    // No lease is NOT "no background tasks": a non-Claude runtime and an adapter without the
    // lifecycle extension both land here, and the console says so rather than claiming idleness.
    expect(await (daemon as any).listBackgroundTasks({ agentId: 'bot-a', sessionId: 'acp-9' })).toEqual({
      agentId: 'bot-a',
      sessionId: 'acp-9',
      tracked: false,
      tasks: [],
      truncated: false
    })
    await expect((daemon as any).listBackgroundTasks({ agentId: 'nope', sessionId: 'acp-1' })).rejects.toThrow(
      TaskViolationError
    )

    await daemon.stop()
  }, 15_000)

  it('drops an agent lease when its host is torn down', async () => {
    const clock = new FakeClock()
    const { daemon } = await bootWithTurn(clock, {
      agentIdleTimeoutMs: 10_000_000,
      agentMaxLifetimeMs: 10_000_000,
      idleSweepMs: 10_000_000
    })
    await (daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
    expect((daemon as any).sdkLease.size).toBe(1)
    await (daemon as any).stopHost('bot-a')
    expect((daemon as any).sdkLease.size).toBe(0)
    await daemon.stop()
  }, 15_000)
})

describe('Daemon graceful shutdown drain (#109)', () => {
  it('awaits an in-flight turn before tearing the host down (no mid-turn kill)', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined(), WAIT)

    let stopped = false
    const stopping = daemon.stop().then(() => (stopped = true))
    // new inbound is dropped while draining
    await (daemon as any).onInboundOutcome(dm('300', 'too late'))
    await new Promise((r) => setTimeout(r, 20))
    expect(stopped).toBe(false) // still waiting on the in-flight turn

    blocked.release()
    await stopping
    expect(stopped).toBe(true)
    expect(blocked.host.cancel).not.toHaveBeenCalled() // drained gracefully, not cancelled
    expect(blocked.host.stop).toHaveBeenCalled()
  }, 15_000)

  it('keeps the store alive until an admitted workspace file write settles', async () => {
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any
    })
    await daemon.start()
    const store = (daemon as any).store
    const close = vi.spyOn(store, 'close')

    let releaseWrite!: () => void
    const blocked = new Promise<void>((resolve) => (releaseWrite = resolve))
    let markWriteEntered!: () => void
    const entered = new Promise<void>((resolve) => (markWriteEntered = resolve))
    const writing = (daemon as any).withWorkspaceFileWrite('bot-a', async () => {
      markWriteEntered()
      await blocked
    }) as Promise<void>
    await entered

    let stopped = false
    const stopping = daemon.stop().then(() => {
      stopped = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect((daemon as any).workspaceDispatchFences.has('bot-a')).toBe(true)

    releaseWrite()
    await writing
    await stopping
    expect(close).toHaveBeenCalledOnce()
    expect((daemon as any).workspaceDispatchFences.has('bot-a')).toBe(false)
  }, 15_000)
})

describe('Daemon CP drain (#109)', () => {
  const farFuture = '2099-01-01T00:00:00.000Z'

  it('scope:daemon drains in-flight turns, releases them, stops hosts, re-opens the gate', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined(), WAIT)

    const draining = (daemon as any).runDrain({ scope: { kind: 'daemon' }, deadline: farFuture }, () => {})
    blocked.release() // let the turn finish so the drain completes gracefully
    await turn
    const done = await draining
    expect(done.released).toEqual([{ platform: 'slack', channel: 'C1', thread: 'T1' }])
    expect((daemon as any).hosts.has('bot-a')).toBe(false) // reclaimed → provisioned
    expect((daemon as any).draining).toBe(false) // gate re-opened (bare drain is a rebalance)

    await daemon.stop()
  }, 15_000)

  it('omits the thread for a channel-root session in released[] (matches the CP key)', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => blocked.host as any
    })
    await daemon.start()
    makeRoutable(daemon)

    const root = {
      msgId: 'slack:C1:500',
      traceId: '500',
      source: 'user' as const,
      platform: 'slack' as const,
      channel: 'C1',
      thread: undefined,
      sender: { id: 'U1', isBot: false },
      text: 'hi',
      mentionedBots: [] as string[],
      isDm: false,
      trigger: 'mention' as const
    }
    const turn = (daemon as any).dispatch('bot-a', root, 'int-a')
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined(), WAIT)

    const draining = (daemon as any).runDrain({ scope: { kind: 'daemon' }, deadline: farFuture }, () => {})
    blocked.release()
    await turn
    const done = await draining
    // channel-root: released key carries NO thread (CP keys it as `slack:C1:-`)
    expect(done.released).toEqual([{ platform: 'slack', channel: 'C1' }])

    await daemon.stop()
  }, 15_000)
})

describe('Daemon session retention GC (#485)', () => {
  // `start()` fires its own retention pass, and the sweep drops a call that lands while one is
  // running — so a test that just called it could assert against a pass that judged the clock it
  // had before the advance. Wait the startup pass out, then sweep for real.
  const sweepRetention = async (daemon: Daemon) => {
    while ((daemon as any).sessionRetentionSweepInFlight) await new Promise((resolve) => setTimeout(resolve, 5))
    await (daemon as any).sweepSessionRetention()
  }

  const seedSession = async (
    daemon: Daemon,
    key: string,
    state: 'idle' | 'prompting' | 'closed',
    updatedAt: number
  ): Promise<string> => {
    await (daemon as any).store.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: key,
      acpSessionId: `acp-${key}`,
      state,
      lastDeliveredTs: null,
      updatedAt
    })
    return (await (daemon as any).store.getSession(key))!.sessionId!
  }

  it('the idle sweep deletes expired sessions but spares live turns and gate-owned keys', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any,
      clock
    })
    await daemon.start()

    await seedSession(daemon, 'expired-closed', 'closed', 0)
    await seedSession(daemon, 'expired-idle', 'idle', 0)
    await seedSession(daemon, 'fresh-closed', 'closed', 2 * 24 * 3_600_000) // inside the window at sweep time
    await seedSession(daemon, 'expired-prompting', 'prompting', 0) // live turn — durable state guard
    await seedSession(daemon, 'expired-gated', 'closed', 0) // owned serial gate — in-memory guard
    ;(daemon as any).inflight.add('expired-gated')

    // Past the default 7d retention window; the hourly gate inside sweepIdle opens too.
    clock.advance(8 * 24 * 3_600_000)
    await vi.waitFor(async () => expect(await (daemon as any).store.getSession('expired-closed')).toBeUndefined(), WAIT)
    expect(await (daemon as any).store.getSession('expired-idle')).toBeUndefined()
    expect(await (daemon as any).store.getSession('fresh-closed')).toBeDefined()
    expect(await (daemon as any).store.getSession('expired-prompting')).toBeDefined()
    expect(await (daemon as any).store.getSession('expired-gated')).toBeDefined()

    await daemon.stop()
  }, 15_000)

  it('retention "never" disables the sweep entirely', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any,
      clock
    })
    await daemon.start()
    ;(daemon as any).cfg.sessions.retention = 'never'
    await seedSession(daemon, 'expired-closed', 'closed', 0)

    clock.advance(8 * 24 * 3_600_000)
    await sweepRetention(daemon)
    expect(await (daemon as any).store.getSession('expired-closed')).toBeDefined()

    await daemon.stop()
  }, 15_000)

  it('reports each purged session to the CP and clears the receipt only on the ACK', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any,
      clock
    })
    await daemon.start()
    const emitSessionPurged = vi.fn(async (_purged: SessionPurged) => 'acknowledged' as const)
    ;(daemon as any).cpClient = { emitSessionPurged, state: 'READY', stop: vi.fn(async () => {}) }

    const expiredA = await seedSession(daemon, 'expired-a', 'closed', 0)
    const expiredB = await seedSession(daemon, 'expired-b', 'idle', 0)
    clock.advance(8 * 24 * 3_600_000)
    await sweepRetention(daemon)
    await vi.waitFor(() => expect(emitSessionPurged).toHaveBeenCalledOnce(), WAIT)

    // One frame per agent, carrying the sessions' outward ids — the identity the CP knows.
    expect(emitSessionPurged.mock.calls[0]![0]).toMatchObject({
      agentId: 'bot-a',
      reason: 'retention'
    })
    expect([...emitSessionPurged.mock.calls[0]![0].sessionIds].sort()).toEqual([expiredA, expiredB].sort())
    // ACKed ⇒ the durable receipts are released, which the drain does after the report returns.
    await vi.waitFor(async () => expect(await (daemon as any).store.listSessionPurges(10, 0)).toEqual([]), WAIT)

    await daemon.stop()
  }, 15_000)

  it('never reports a session under another purge time or agent', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any,
      clock
    })
    await daemon.start()
    const emitSessionPurged = vi.fn(async (_purged: SessionPurged) => 'acknowledged' as const)
    ;(daemon as any).cpClient = { emitSessionPurged, state: 'READY', stop: vi.fn(async () => {}) }
    const store = (daemon as any).store

    // Two sweeps' worth of receipts plus a second agent: every frame states one
    // agent + reason + timestamp for all the sessions it carries, so a row may
    // never ride in a frame that would mislabel when (or by whom) it was purged.
    await store.deleteSession('x', { reason: 'retention', at: 1_000 }) // absent row — no receipt
    const sweep1a = await seedSession(daemon, 'sweep-1a', 'closed', 0)
    const sweep1b = await seedSession(daemon, 'sweep-1b', 'closed', 0)
    await store.deleteSession('sweep-1a', { reason: 'retention', at: 1_000 })
    await store.deleteSession('sweep-1b', { reason: 'retention', at: 1_000 })
    const sweep2 = await seedSession(daemon, 'sweep-2', 'closed', 0)
    await store.deleteSession('sweep-2', { reason: 'retention', at: 2_000 })

    await (daemon as any).drainSessionPurges()

    expect(emitSessionPurged).toHaveBeenCalledTimes(2)
    const frames = emitSessionPurged.mock.calls
      .map((call) => call[0])
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    expect([...frames[0]!.sessionIds].sort()).toEqual([sweep1a, sweep1b].sort())
    expect(frames[0]!.ts).toBe(new Date(1_000).toISOString())
    expect(frames[1]!.sessionIds).toEqual([sweep2])
    expect(frames[1]!.ts).toBe(new Date(2_000).toISOString())
    expect(await store.listSessionPurges(10, 0)).toEqual([])

    await daemon.stop()
  }, 15_000)

  it('leaves the receipts alone while the CP socket is down', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any,
      clock
    })
    await daemon.start()
    const emitSessionPurged = vi.fn()
    ;(daemon as any).cpClient = { emitSessionPurged, state: 'DEGRADED', stop: vi.fn(async () => {}) }

    await seedSession(daemon, 'expired-a', 'closed', 0)
    clock.advance(8 * 24 * 3_600_000)
    await sweepRetention(daemon)

    // Not even attempted: the receipt is durable and the reconnect drains it, so a
    // request here would only log a failure on every sweep of a local-only daemon.
    expect(emitSessionPurged).not.toHaveBeenCalled()
    expect(await (daemon as any).store.listSessionPurges(10, 0)).toHaveLength(1)

    await daemon.stop()
  }, 15_000)

  it('keeps the purge receipts when the CP cannot accept them yet', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any,
      clock
    })
    await daemon.start()
    // A CP that does not advertise the feature would reject the unknown frame, so
    // the receipt must survive for a post-upgrade reconnect.
    ;(daemon as any).cpClient = {
      emitSessionPurged: vi.fn(async () => 'unsupported' as const),
      state: 'READY',
      stop: vi.fn()
    }

    const expiredA = await seedSession(daemon, 'expired-a', 'closed', 0)
    clock.advance(8 * 24 * 3_600_000)
    await sweepRetention(daemon)
    await (daemon as any).drainSessionPurges()

    expect(await (daemon as any).store.listSessionPurges(10, 0)).toMatchObject([
      { agentId: 'bot-a', sessionId: expiredA, reason: 'retention' }
    ])

    // ...and a reporting failure is equally non-destructive.
    ;(daemon as any).cpClient = {
      emitSessionPurged: vi.fn(async () => {
        throw new Error('control plane unreachable')
      }),
      state: 'READY',
      stop: vi.fn()
    }
    await (daemon as any).drainSessionPurges()
    expect(await (daemon as any).store.listSessionPurges(10, 0)).toHaveLength(1)

    await daemon.stop()
  }, 15_000)

  it('a session with pending durable inbox work is treated as active and kept', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => quietHost() as any,
      clock
    })
    await daemon.start()
    await seedSession(daemon, 'expired-queued', 'closed', 0)
    await (daemon as any).store.appendInbox({
      id: 'm-queued',
      sessionKey: 'expired-queued',
      agentId: 'bot-a',
      msg: '{}',
      enqueuedAt: '0000000001'
    })

    clock.advance(8 * 24 * 3_600_000)
    await sweepRetention(daemon)
    expect(await (daemon as any).store.getSession('expired-queued')).toBeDefined()

    await daemon.stop()
  }, 15_000)
})
