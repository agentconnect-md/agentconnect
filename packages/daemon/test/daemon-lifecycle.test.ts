import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { configFilesDir } from '../src/agents/config-file-env.js'
import { readSkillLedger, skillLedgerLocation } from '../src/skills/skill-install-ledger.js'
import { sessionKey } from '../src/store/local-store.js'
import { FakeClock } from './cp/fake-clock.js'

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
    cancel: vi.fn(async () => {}),
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
      slack: { botToken: 'b', appToken: 'p', bindRules: [{ match: { kind: 'dm' } }] }
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
    (pending: any) => pending.agentId === 'bot-a' && pending.acpSessionId === acpSessionId
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
    const daemon = new Daemon({ root, hostFactory: factory })
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
    const daemon = new Daemon({ root, hostFactory: factory })
    await daemon.start()

    await expect((daemon as any).ensureHostAsync('bot-a')).rejects.toThrow()

    expect(factory).not.toHaveBeenCalled()
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await daemon.stop()
  }, 15_000)

  it('shares one cold preparation between host start and session creation', async () => {
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => quietHost() as any })
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
    const daemon = new Daemon({ root, hostFactory: factory })
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
    const daemon = new Daemon({ root, hostFactory: factory })
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
    const daemon = new Daemon({ root, hostFactory: factory, clock })
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
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
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
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => quietHost() as any })
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

  it('serializes workspace preparation and file publication in both admission orders', async () => {
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => quietHost() as any })
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
    expect((daemon as any).workspaceFileWrites.has('bot-a')).toBe(false)
    await daemon.stop()
  }, 20_000)

  it('writes the session back to idle once a turn finishes (no longer stuck prompting)', async () => {
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => quietHost() as any })
    await daemon.start()
    makeRoutable(daemon)
    await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    expect((daemon as any).store.getSession(KEY)?.state).toBe('idle')
    await daemon.stop()
  }, 15_000)

  it('does not post a cron anchor while the target agent is paused', async () => {
    const host = quietHost()
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
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
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
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
    expect((daemon as any).store.getSession(key)?.lastDeliveredTs).toBe('100.100000')

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
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
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
    expect((daemon as any).store.getSession(key)).toBeTruthy()
    await daemon.stop()
  }, 15_000)

  it('§6.8: a telegram DM anchored fire keys `dm` and classifies as a DM session', async () => {
    const host = quietHost()
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
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
    expect((daemon as any).store.getSession(key)).toBeTruthy()
    await daemon.stop()
  }, 15_000)

  it('reports a cron session before its turn finishes', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => blocked.host as any })
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

    await vi.waitFor(() => expect(blocked.host.prompt).toHaveBeenCalledWith('acp-1', expect.any(Array)))
    expect(emitCronReport).toHaveBeenCalledTimes(2)
    expect(emitCronReport.mock.calls[0]![0]).not.toHaveProperty('sessionId')
    expect(emitCronReport.mock.calls[1]![0]).toMatchObject({ sessionId: 'acp-1' })
    expect(emitCronReport.mock.calls[1]![0]).not.toHaveProperty('status')

    blocked.release()
    await run
    expect(emitCronReport.mock.calls[2]![0]).toMatchObject({ status: 'success', sessionId: 'acp-1' })
    await daemon.stop()
  }, 15_000)

  it('!stop sets cancelling, and the backstop force-stops the host if the agent ignores cancel', async () => {
    const clock = new FakeClock()
    const blocked = blockingHost()
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => blocked.host as any, clock })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined())

    ;(daemon as any).onInbound(dm('200', '!stop'))
    expect(blocked.host.cancel).toHaveBeenCalledWith('acp-1')
    expect((daemon as any).store.getSession(KEY)?.state).toBe('cancelling')

    // agent ignores session/cancel → after cancelBackstopMs the host is force-stopped
    clock.advance(30_000)
    await vi.waitFor(() => expect(blocked.host.stop).toHaveBeenCalled())
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await vi.waitFor(() => expect((daemon as any).store.getSession(KEY)?.state).toBe('idle'))

    blocked.release()
    await turn.catch(() => {})
    await daemon.stop()
  }, 15_000)

  it('pausing interrupts every active session, drops queued turns, and keeps the host warm', async () => {
    const root = scaffold()
    const blocked = multiBlockingHost()
    const daemon = new Daemon({ root, hostFactory: () => blocked.host as any })
    await daemon.start()

    const first = (daemon as any).dispatch('bot-a', dm('100', 'first', 'T1'))
    const second = (daemon as any).dispatch('bot-a', dm('200', 'second', 'T2'))
    await vi.waitFor(() => expect((daemon as any).pending.size).toBe(2))
    const queued = (daemon as any).dispatch('bot-a', dm('300', 'queued', 'T1'))
    expect((daemon as any).serialQueue.get(KEY)).toHaveLength(1)

    writePause(root, true)
    await daemon.reconcile()

    expect((daemon as any).agents.get('bot-a').pause).toBe(true)
    expect(blocked.host.cancel).toHaveBeenCalledTimes(2)
    expect(new Set(blocked.host.cancel.mock.calls.map(([id]) => id))).toEqual(new Set(['acp-1', 'acp-2']))
    await expect(queued).resolves.toBeNull()
    expect((daemon as any).serialQueue.size).toBe(0)
    expect((daemon as any).store.listInboxBySessionKeyFifo()).toHaveLength(0)
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
  }, 15_000)

  it('pausing suppresses renderer actions already queued by the old turn', async () => {
    const root = scaffold()
    const blocked = blockingHost()
    const daemon = new Daemon({ root, hostFactory: () => blocked.host as any })
    await daemon.start()
    const conn = makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'stream', 'T1'))
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined())
    const pending = pendingFor(daemon, 'acp-1')
    let releaseApply!: () => void
    pending.applyChain = new Promise<void>((resolve) => (releaseApply = resolve))
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
    const daemon = new Daemon({ root, hostFactory: () => cold.host as any })
    await daemon.start()

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'cold', 'T1'))
    await vi.waitFor(() => expect(cold.host.newSession).toHaveBeenCalledTimes(1))
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
    expect((daemon as any).store.getSession(KEY)?.state).toBe('idle')

    await vi.waitFor(() => expect((daemon as any).safetyDrainingAgents.has('bot-a')).toBe(false))
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
      onUpdate('acp-1', { sessionUpdate: 'session_info_update', title: 'Final stopped title' })
    })
    const daemon = new Daemon({
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
    expect((daemon as any).store.getSession(KEY)?.state).toBe('idle')

    // advance past the TTL so the next sweep reaps the host + closes the session
    clock.advance(1001)
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false))
    expect(host.stop).toHaveBeenCalled()
    expect((daemon as any).store.getSession(KEY)?.state).toBe('closed')
    expect((daemon as any).store.getSession(KEY)?.title).toBe('Final stopped title')
    expect(conn.setTitle).toHaveBeenCalledWith('C1', 'T1', 'Final stopped title')

    await daemon.stop()
  }, 15_000)

  it('removes the materialized config-file secrets when the host stops', async () => {
    const clock = new FakeClock()
    const host = quietHost()
    const root = scaffold({ agentIdleTimeoutMs: 1000, idleSweepMs: 1000 })
    const daemon = new Daemon({ root, hostFactory: () => host as any, clock })
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
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false))
    await vi.waitFor(() => expect(existsSync(secretsDir)).toBe(false))

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
    const daemon = new Daemon({ root, hostFactory: () => host as any, clock })
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

    // Quiet past configFilesIdleMs → the files go, the host stays warm.
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    expect(existsSync(kubeFile)).toBe(false)
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    // The next turn re-writes the file BEFORE the prompt reaches the child.
    await (daemon as any).dispatch('bot-a', dm('101', 'again'), 'int-a')
    expect(sawFileAtPrompt.at(-1)).toBe(true)
    expect(readFileSync(kubeFile, 'utf8')).toBe('apiVersion: v1')

    await daemon.stop()
  }, 15_000)

  it('does not sweep config-file secrets while a turn is in flight', async () => {
    const clock = new FakeClock()
    const blocked = multiBlockingHost()
    const root = scaffold({ agentIdleTimeoutMs: 1_000_000, idleSweepMs: 10_000_000, configFilesIdleMs: 1000 })
    const adir = join(root, 'agents', 'bot-a')
    const kubeFile = join(configFilesDir(adir), 'kubeconfig')
    const daemon = new Daemon({ root, hostFactory: () => blocked.host as any, clock })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(blocked.host.prompt).toHaveBeenCalled())
    const entry = (daemon as any).hostConfigFiles.get('bot-a')
    entry.childEnv = { KUBECONFIG_DATA: 'apiVersion: v1' }
    entry.materialized = true
    mkdirSync(configFilesDir(adir), { recursive: true })
    writeFileSync(kubeFile, 'apiVersion: v1')

    // Way past the quiet window, but the turn is still running → files must stay.
    clock.advance(5000)
    ;(daemon as any).sweepIdle()
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

    const daemon = new Daemon({ root, hostFactory: () => quietHost() as any })
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
    ;(daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    // Past the TTL measured from host start → now genuinely idle → reclaimed.
    clock.advance(600) // 1100ms since start > 1000ms TTL
    ;(daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false))
    expect(host.stop).toHaveBeenCalled()

    await daemon.stop()
  }, 15_000)
})

describe('Daemon idle sweep — background-task lease', () => {
  const evt = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype, ...extra })

  async function bootWithTurn(clock: FakeClock, limits: Record<string, number>) {
    const host = quietHost()
    const daemon = new Daemon({ root: scaffold(limits), hostFactory: () => host as any, clock })
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
    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))

    // Past the idle TTL, but the lease defers reclaim AND spares the session from close.
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    expect((daemon as any).store.getSession(KEY)?.state).toBe('idle')

    // The task settles, but its completion wake is now armed — that still fences reclaim, or
    // the sweep would close the session out from under a delivery about to happen.
    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
    clock.advance(1001) // past the TTL again, still inside the wake's grace window
    ;(daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    expect((daemon as any).store.getSession(KEY)?.state).toBe('idle')

    // Wake fires and is delivered; the fence is held until that turn SETTLES, not until it is
    // dispatched, so wait on the count rather than on the timer set.
    clock.advance(4000)
    await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false))
    await vi.waitFor(() => expect((daemon as any).store.getSession(KEY)?.state).toBe('idle'))
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false))
    expect(host.stop).toHaveBeenCalled()
    expect((daemon as any).store.getSession(KEY)?.state).toBe('closed')

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
    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'running' }))
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'idle' }))
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false))

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
    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't2' }))
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true) // still deferred

    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('background_tasks_changed', { tasks: [] }))
    // Both settled on that one edge, so both completion wakes are armed and still fence reclaim.
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    clock.advance(4000)
    await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false))
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false))

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

    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))

    // Past the idle TTL but under the ceiling → deferred.
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    // Past the ceiling (from host start) → force reclaim despite the live task.
    clock.advance(1001)
    ;(daemon as any).sweepIdle()
    await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false))
    expect(host.stop).toHaveBeenCalled()

    await daemon.stop()
  }, 15_000)

  it('announces a completed background task to the thread when output mode ≥ medium', async () => {
    const clock = new FakeClock()
    const { daemon, conn } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })
    ;(daemon as any).store.setOutputModeOverride(KEY, 'medium')

    ;(daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 't1', description: 'Sleep for 15 seconds' })
    )
    expect(conn.postMessage).not.toHaveBeenCalled() // nothing on start
    ;(daemon as any).onSdkLifecycle(
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
    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
    expect(conn.postMessage).toHaveBeenCalledTimes(1)
    await daemon.stop()
  }, 15_000)

  it('does not announce when output mode is below medium', async () => {
    const clock = new FakeClock()
    const { daemon, conn } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })
    ;(daemon as any).store.setOutputModeOverride(KEY, 'low')

    ;(daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 't1', description: 'Sleep for 15 seconds' })
    )
    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
    expect(conn.postMessage).not.toHaveBeenCalled()
    await daemon.stop()
  }, 15_000)

  it('does not announce an internal subagent task', async () => {
    const clock = new FakeClock()
    const { daemon, conn } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })
    ;(daemon as any).store.setOutputModeOverride(KEY, 'high')

    ;(daemon as any).onSdkLifecycle(
      'bot-a',
      'acp-1',
      evt('task_started', { task_id: 's1', subagent_type: 'general', description: 'a subagent' })
    )
    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 's1' }))
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
      ;(daemon as any).store.setOutputModeOverride(KEY, 'low') // a wake is NOT gated on output mode
      expect(host.prompt).toHaveBeenCalledTimes(1) // just the human turn so far

      ;(daemon as any).onSdkLifecycle(
        'bot-a',
        'acp-1',
        evt('task_started', { task_id: 't1', description: 'Sleep 30s then print the time' })
      )
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      expect(host.prompt).toHaveBeenCalledTimes(1) // deferred, not immediate

      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2))
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

      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      // Claude self-woke a followup cycle to drain it.
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'running' }))

      clock.advance(4000) // re-armed, not abandoned
      await vi.waitFor(() => expect((daemon as any).bgWakeTimers.size).toBe(1))
      expect((daemon as any).sdkLease.get(LEASE_KEY)?.armedWakes).toBe(1) // fence never dipped
      expect(host.prompt).toHaveBeenCalledTimes(1)

      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'idle' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2))
      await daemon.stop()
    }, 15_000)

    it('gives up re-arming if the runtime cycle never returns to idle', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'running' }))

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

      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't2' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      clock.advance(4000) // t2 is still live — t1's wake must stand down
      await new Promise((r) => setImmediate(r))
      expect(host.prompt).toHaveBeenCalledTimes(1)

      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't2' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2))
      await daemon.stop()
    }, 15_000)

    // The armed wake must fence automatic cleanup: `settle()` removes the task before the
    // timer is armed, so a session whose task outlived the TTL would otherwise be closed
    // (and its lease dropped) inside the grace window — losing the completion again.
    it('keeps the session non-quiescent while a wake is armed, and releases it after', async () => {
      const clock = new FakeClock()
      const { daemon } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      expect((daemon as any).sdkLease.get(LEASE_KEY)?.tasks.size).toBe(0) // task already released
      expect((daemon as any).sdkLease.get(LEASE_KEY)?.armedWakes).toBe(1)
      expect((daemon as any).sessionSdkQuiescent('bot-a', 'acp-1')).toBe(false)
      expect((daemon as any).agentHasLiveSdkWork('bot-a')).toBe(true)

      clock.advance(4000)
      await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false))
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

      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1)) // wake dispatched, stalled

      // Past the TTL, mid-initialization: the row is still `idle` and has no Pending, so only
      // the lease fence can keep the sweep off it.
      clock.advance(1001)
      ;(daemon as any).sweepIdle()
      expect((daemon as any).store.getSession(KEY)?.state).not.toBe('closed')
      expect((daemon as any).hosts.has('bot-a')).toBe(true)
      expect(host.stop).not.toHaveBeenCalled()

      releaseRecall()
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false))
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
        root: scaffold({ agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 }),
        hostFactory: () => host as any,
        clock
      })
      await daemon.start()
      makeRoutable(daemon)
      await (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')

      // Wake A → prompt #2, which blocks. Its dispatch stays pending.
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 'a' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 'a' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2))
      // The model is done even though the turn is not — exactly what the SDK reports here.
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('session_state_changed', { state: 'idle' }))

      // Task B settles inside that window. It must be deferred, not folded into A.
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 'b' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 'b' }))
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

      ;(daemon as any).onSdkLifecycle(
        'bot-a',
        'acp-1',
        evt('task_started', { task_id: 's1', subagent_type: 'general' })
      )
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 's1' }))
      clock.advance(4000)
      await new Promise((r) => setImmediate(r))
      expect(host.prompt).toHaveBeenCalledTimes(1)
      await daemon.stop()
    }, 15_000)

    it('does not wake a session whose host was already reclaimed', async () => {
      const clock = new FakeClock()
      const { daemon, host } = await bootWithTurn(clock, { agentIdleTimeoutMs: 10_000_000, idleSweepMs: 10_000_000 })

      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
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

      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't1' }))
      clock.advance(4000)
      const lease = (daemon as any).sdkLease.get(LEASE_KEY)
      await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false))
      expect(host.prompt).toHaveBeenCalledTimes(2)
      expect(lease.bgWakes).toBe(1) // a delivered wake is spent

      // Pre-spend the rest rather than driving 19 more real turns: the property under test is
      // the refusal at the cap, not the arithmetic getting there.
      lease.bgWakes = 20
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't2' }))
      ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_notification', { task_id: 't2' }))
      clock.advance(4000)
      await vi.waitFor(() => expect(wakeFenceHeld(daemon)).toBe(false)) // fence released, no wake
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

    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1', description: 'a-work' }))
    ;(daemon as any).onSdkLifecycle('bot-b', 'acp-1', evt('task_started', { task_id: 't1', description: 'b-work' }))
    expect((daemon as any).sdkLease.size).toBe(2)
    expect((daemon as any).sdkLease.get(LEASE_KEY)?.tasks.get('t1')?.description).toBe('a-work')

    // Settling bot-b's identically-named task must not settle bot-a's.
    ;(daemon as any).onSdkLifecycle('bot-b', 'acp-1', evt('task_notification', { task_id: 't1' }))
    expect((daemon as any).sdkLease.get(LEASE_KEY)?.tasks.size).toBe(1)
    expect((daemon as any).sessionSdkQuiescent('bot-a', 'acp-1')).toBe(false)
    await daemon.stop()
  }, 15_000)

  it('drops an agent lease when its host is torn down', async () => {
    const clock = new FakeClock()
    const { daemon } = await bootWithTurn(clock, {
      agentIdleTimeoutMs: 10_000_000,
      agentMaxLifetimeMs: 10_000_000,
      idleSweepMs: 10_000_000
    })
    ;(daemon as any).onSdkLifecycle('bot-a', 'acp-1', evt('task_started', { task_id: 't1' }))
    expect((daemon as any).sdkLease.size).toBe(1)
    await (daemon as any).stopHost('bot-a')
    expect((daemon as any).sdkLease.size).toBe(0)
    await daemon.stop()
  }, 15_000)
})

describe('Daemon graceful shutdown drain (#109)', () => {
  it('awaits an in-flight turn before tearing the host down (no mid-turn kill)', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => blocked.host as any })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined())

    let stopped = false
    const stopping = daemon.stop().then(() => (stopped = true))
    // new inbound is dropped while draining
    ;(daemon as any).onInbound(dm('300', 'too late'))
    await new Promise((r) => setTimeout(r, 20))
    expect(stopped).toBe(false) // still waiting on the in-flight turn

    blocked.release()
    await stopping
    expect(stopped).toBe(true)
    expect(blocked.host.cancel).not.toHaveBeenCalled() // drained gracefully, not cancelled
    expect(blocked.host.stop).toHaveBeenCalled()
  }, 15_000)

  it('keeps the store alive until an admitted workspace file write settles', async () => {
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => quietHost() as any })
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
    expect((daemon as any).workspaceFileWrites.has('bot-a')).toBe(true)

    releaseWrite()
    await writing
    await stopping
    expect(close).toHaveBeenCalledOnce()
    expect((daemon as any).workspaceFileWrites.has('bot-a')).toBe(false)
  }, 15_000)
})

describe('Daemon CP drain (#109)', () => {
  const farFuture = '2099-01-01T00:00:00.000Z'

  it('scope:daemon drains in-flight turns, releases them, stops hosts, re-opens the gate', async () => {
    const blocked = blockingHost()
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => blocked.host as any })
    await daemon.start()
    makeRoutable(daemon)

    const turn = (daemon as any).dispatch('bot-a', dm('100', 'hello'), 'int-a')
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined())

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
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => blocked.host as any })
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
    await vi.waitFor(() => expect(pendingFor(daemon, 'acp-1')).toBeDefined())

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
  const seedSession = (daemon: Daemon, key: string, state: 'idle' | 'prompting' | 'closed', updatedAt: number) =>
    (daemon as any).store.upsertSession({
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

  it('the idle sweep deletes expired sessions but spares live turns and gate-owned keys', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => quietHost() as any, clock })
    await daemon.start()

    seedSession(daemon, 'expired-closed', 'closed', 0)
    seedSession(daemon, 'expired-idle', 'idle', 0)
    seedSession(daemon, 'fresh-closed', 'closed', 2 * 24 * 3_600_000) // inside the window at sweep time
    seedSession(daemon, 'expired-prompting', 'prompting', 0) // live turn — durable state guard
    seedSession(daemon, 'expired-gated', 'closed', 0) // owned serial gate — in-memory guard
    ;(daemon as any).inflight.add('expired-gated')

    // Past the default 7d retention window; the hourly gate inside sweepIdle opens too.
    clock.advance(8 * 24 * 3_600_000)
    await vi.waitFor(() => expect((daemon as any).store.getSession('expired-closed')).toBeUndefined())
    expect((daemon as any).store.getSession('expired-idle')).toBeUndefined()
    expect((daemon as any).store.getSession('fresh-closed')).toBeDefined()
    expect((daemon as any).store.getSession('expired-prompting')).toBeDefined()
    expect((daemon as any).store.getSession('expired-gated')).toBeDefined()

    await daemon.stop()
  }, 15_000)

  it('retention "never" disables the sweep entirely', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => quietHost() as any, clock })
    await daemon.start()
    ;(daemon as any).cfg.sessions.retention = 'never'
    seedSession(daemon, 'expired-closed', 'closed', 0)

    clock.advance(8 * 24 * 3_600_000)
    await (daemon as any).sweepSessionRetention()
    expect((daemon as any).store.getSession('expired-closed')).toBeDefined()

    await daemon.stop()
  }, 15_000)

  it('a session with pending durable inbox work is treated as active and kept', async () => {
    const clock = new FakeClock()
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => quietHost() as any, clock })
    await daemon.start()
    seedSession(daemon, 'expired-queued', 'closed', 0)
    ;(daemon as any).store.appendInbox({
      id: 'm-queued',
      sessionKey: 'expired-queued',
      agentId: 'bot-a',
      msg: '{}',
      enqueuedAt: '0000000001'
    })

    clock.advance(8 * 24 * 3_600_000)
    await (daemon as any).sweepSessionRetention()
    expect((daemon as any).store.getSession('expired-queued')).toBeDefined()

    await daemon.stop()
  }, 15_000)
})
