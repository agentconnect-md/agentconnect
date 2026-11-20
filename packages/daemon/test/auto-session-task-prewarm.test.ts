// auto-session-mode.md §4.8: a likely task's model host starts while its coordinator decides, and is released unless the task claims it.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { deliveredMessage } from '../src/auto-session/coordinator-sessions.js'
import {
  COORDINATOR_PREWARM_MS,
  prewarmsTask,
  TaskPrewarms,
  TASK_PREWARM_GRACE_MS,
  TASK_PREWARM_MAX_MS,
  TASK_PREWARMS_PER_TURN
} from '../src/auto-session/task-prewarm.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { coordinatorConversationId } from '@agentconnect.md/protocol'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const slack = (ts: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    msgId: `slack:C1:${ts}`,
    traceId: `t-${ts}`,
    source: 'user',
    platform: 'slack',
    channel: 'C1',
    thread: ts,
    sender: { id: 'U1', isBot: false },
    text: 'hello',
    mentionedBots: [],
    isDm: false,
    ...over
  }) as NormalizedMessage

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function prewarms() {
  const start = vi.fn(async (_agentId: string, _taskKey: string) => {})
  const release = vi.fn(async (_taskKey: string) => {})
  const warn = vi.fn()
  const releasable = vi.fn((_taskKey: string) => true)
  return { start, release, releasable, warn, prewarms: new TaskPrewarms({ start, release, releasable, warn }) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('which messages prewarm a task host', () => {
  it('prewarms a person’s message addressed to the agent, never a report or a page task', () => {
    const of = (msg: NormalizedMessage) => prewarmsTask(deliveredMessage(msg))
    expect(of(slack('1.1', { trigger: 'mention' }))).toBe(true)
    expect(of(slack('1.1', { isDm: true }))).toBe(true)
    expect(of(slack('1.1', { platform: 'webchat', thread: 'post-1' }))).toBe(true)
    // An unaddressed channel message is the one a coordinator mostly leaves.
    expect(of(slack('1.1'))).toBe(false)
    expect(of(slack('1.1', { source: 'agent', trigger: 'mention' }))).toBe(false)
    // A post-less console message's task opens on a page whose key is minted only then.
    expect(of(slack('1.1', { platform: 'webchat', thread: undefined }))).toBe(false)
  })
})

describe('a prewarmed task host', () => {
  it('is released a grace after its coordinator’s turn ends without the task', async () => {
    vi.useFakeTimers()
    const { start, release, prewarms: p } = prewarms()
    p.begin('coord', 'bot-a', 'task-1')
    expect(start).toHaveBeenCalledWith('bot-a', 'task-1')
    p.turnEnded('coord')
    await vi.advanceTimersByTimeAsync(TASK_PREWARM_GRACE_MS - 1)
    expect(release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(release).toHaveBeenCalledWith('task-1')
  })

  it('is released after the cap when the coordinator’s turn never ends', async () => {
    vi.useFakeTimers()
    const { release, prewarms: p } = prewarms()
    p.begin('coord', 'bot-a', 'task-1')
    p.turnEnded('another-coordinator')
    await vi.advanceTimersByTimeAsync(TASK_PREWARM_MAX_MS)
    expect(release).toHaveBeenCalledWith('task-1')
  })

  it('is kept once its task claims it, and the claim waits for the start', async () => {
    vi.useFakeTimers()
    const { start, release, prewarms: p } = prewarms()
    const starting = deferred()
    start.mockImplementationOnce(async () => await starting.promise)
    p.begin('coord', 'bot-a', 'task-1')
    let claimed = false
    const claim = p.claim('task-1').then(() => (claimed = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(claimed).toBe(false)
    starting.resolve()
    await claim
    p.turnEnded('coord')
    await vi.advanceTimersByTimeAsync(TASK_PREWARM_MAX_MS)
    expect(release).not.toHaveBeenCalled()
  })

  it('releases only after its start settles, and a claim then waits for that release', async () => {
    vi.useFakeTimers()
    const { start, release, prewarms: p } = prewarms()
    const starting = deferred()
    start.mockImplementationOnce(async () => await starting.promise)
    p.begin('coord', 'bot-a', 'task-1')
    p.turnEnded('coord')
    await vi.advanceTimersByTimeAsync(TASK_PREWARM_GRACE_MS)
    // A release before the start made its host would find nothing to stop.
    expect(release).not.toHaveBeenCalled()
    const claim = p.claim('task-1')
    starting.resolve()
    await claim
    expect(release).toHaveBeenCalledWith('task-1')
    // Released and gone: a later turn starts its own host.
    p.begin('coord', 'bot-a', 'task-1')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('starts once per task, and a failed start is no claim’s error', async () => {
    const { start, prewarms: p } = prewarms()
    start.mockRejectedValueOnce(new Error('organization is not currently allowed'))
    p.begin('coord', 'bot-a', 'task-1')
    p.begin('coord', 'bot-a', 'task-1')
    expect(start).toHaveBeenCalledTimes(1)
    await expect(p.claim('task-1')).resolves.toBeUndefined()
  })

  it('waits out a turn of its task that owns the key, and a later turn deciding on it keeps it', async () => {
    vi.useFakeTimers()
    const { release, releasable, prewarms: p } = prewarms()
    p.begin('coord', 'bot-a', 'task-1')
    p.turnEnded('coord')
    releasable.mockReturnValueOnce(false)
    await vi.advanceTimersByTimeAsync(TASK_PREWARM_GRACE_MS)
    expect(release).not.toHaveBeenCalled()
    p.begin('coord-2', 'bot-a', 'task-1')
    p.turnEnded('coord')
    await vi.advanceTimersByTimeAsync(TASK_PREWARM_GRACE_MS)
    expect(release).not.toHaveBeenCalled()
    p.turnEnded('coord-2')
    await vi.advanceTimersByTimeAsync(TASK_PREWARM_GRACE_MS)
    expect(release).toHaveBeenCalledWith('task-1')
  })

  it('is released at its own window when one is given, as a page’s prewarm is', async () => {
    vi.useFakeTimers()
    const { release, prewarms: p } = prewarms()
    p.begin('page:u1', 'bot-a', 'coordinator-1', COORDINATOR_PREWARM_MS)
    await vi.advanceTimersByTimeAsync(COORDINATOR_PREWARM_MS - 1)
    expect(release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(release).toHaveBeenCalledWith('coordinator-1')
  })

  it('starts nothing once shut down', async () => {
    const { start, prewarms: p } = prewarms()
    await p.stop(true)
    p.begin('coord', 'bot-a', 'task-1')
    expect(start).not.toHaveBeenCalled()
  })

  it('stops by waiting for every start and leaving the release to the pool', async () => {
    vi.useFakeTimers()
    const { release, prewarms: p } = prewarms()
    p.begin('coord', 'bot-a', 'task-1')
    await p.stop()
    await vi.advanceTimersByTimeAsync(TASK_PREWARM_MAX_MS)
    expect(release).not.toHaveBeenCalled()
  })
})

function scaffold(workspace: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-task-prewarm-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { autoSessionMode: true },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
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
      workspace: { path: join(adir, 'workspace'), ...workspace },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

/** A daemon whose pool issues per-session credentials, with the pool's host start observed. */
async function boot(workspace: Record<string, unknown> = { mode: 'from-scratch' }, keyServer = true) {
  const daemon = new Daemon({ root: scaffold(workspace), slackAppFactory: fakeSlackAppFactory() })
  await daemon.start()
  const d = daemon as any
  const ensure = vi.fn(async () => ({}))
  d.k8sPlane = {}
  d.modelSessions = { enabled: keyServer, has: () => false, ensure, release: vi.fn(async () => {}) }
  return { d, ensure, prewarmed: () => ensure.mock.calls.map((call: unknown[]) => call[1]) }
}

const taskKeyOf = (thread: string) => sessionKey('slack', 'C1', thread, 'bot-a', undefined)

describe('a coordinator turn prewarms', () => {
  it('the task of each addressed message, up to the cap, and skips a thread a task already holds', async () => {
    const { d, prewarmed } = await boot()
    await d.store.assistantSubsessions.open({
      agentId: 'bot-a',
      childSessionKey: taskKeyOf('2.1'),
      parentSessionId: 'sid-coordinator',
      parentSessionKey: 'coord',
      title: 'Held',
      now: 1
    })
    await d.store.assistantSubsessions.attachThread({
      agentId: 'bot-a',
      childSessionKey: taskKeyOf('2.1'),
      platform: 'slack',
      channel: 'C1',
      transportScope: '',
      thread: '2.1',
      sinceRound: 1,
      now: 1
    })
    const messages = [
      slack('1.1'),
      slack('2.1', { trigger: 'mention' }),
      slack('3.1', { trigger: 'mention' }),
      slack('4.1', { isDm: true }),
      slack('5.1', { trigger: 'mention' })
    ].map((msg) => deliveredMessage(msg))
    await d.prewarmCoordinatorTasks('bot-a', 'coord', messages)
    expect(prewarmed()).toEqual([taskKeyOf('3.1'), taskKeyOf('4.1')].slice(0, TASK_PREWARMS_PER_TURN))
    await d.taskPrewarms.stop()
  })

  it('not a task whose turn already owns its key, which would race it for the host', async () => {
    const { d, prewarmed } = await boot()
    d.inflight.add(taskKeyOf('1.1'))
    await d.prewarmCoordinatorTasks('bot-a', 'coord', [deliveredMessage(slack('1.1', { isDm: true }))])
    expect(prewarmed()).toEqual([])
  })

  it('nothing for an agent whose tasks run in pods of their own, pick their runtime, or lack per-session credentials', async () => {
    const isolated = await boot({ mode: 'git-repo', gitRepo: 'https://github.com/acme/app.git', isolation: 'session' })
    await isolated.d.prewarmCoordinatorTasks('bot-a', 'coord', [deliveredMessage(slack('1.1', { isDm: true }))])
    expect(isolated.prewarmed()).toEqual([])
    const routed = await boot()
    routed.d.agents.get('bot-a').modelSelection = { decisionId: 'pick-a-model' }
    await routed.d.prewarmCoordinatorTasks('bot-a', 'coord', [deliveredMessage(slack('1.1', { isDm: true }))])
    expect(routed.prewarmed()).toEqual([])
    const local = await boot({ mode: 'from-scratch' }, false)
    await local.d.prewarmCoordinatorTasks('bot-a', 'coord', [deliveredMessage(slack('1.1', { isDm: true }))])
    expect(local.prewarmed()).toEqual([])
  })
})

describe('opening the console prewarms the member’s coordinator (§4.9)', () => {
  const ORG_ID = 'org-1'
  const conversation = (userId: string) => coordinatorConversationId(ORG_ID, userId, 'bot-a')

  async function withCoordinator(userId: string) {
    const booted = await boot()
    booted.d.orgForAgent = () => ORG_ID
    const coordinate: string = await booted.d.store.resolveAppendCoordinate(
      'bot-a',
      conversation(userId),
      null,
      1,
      'coordinator'
    )
    return { ...booted, key: sessionKey('webchat', conversation(userId), coordinate, 'bot-a') }
  }

  it('starts the host of the member’s existing coordinator, held for its own window', async () => {
    const { d, key, prewarmed } = await withCoordinator('u1')
    await d.prewarmWebchatCoordinator('bot-a', 'u1')
    expect(prewarmed()).toEqual([key])
    await d.taskPrewarms.stop()
  })

  it('only wakes for a member with no coordinator yet, and mints none', async () => {
    const { d, prewarmed } = await boot()
    d.orgForAgent = () => ORG_ID
    await d.prewarmWebchatCoordinator('bot-a', 'u2')
    expect(prewarmed()).toEqual([])
    expect(await d.store.currentAppendCoordinate('bot-a', conversation('u2'), null, 'coordinator')).toBeUndefined()
  })

  it('leaves a running coordinator host, and one whose coordinator runs on another runtime', async () => {
    const running = await withCoordinator('u1')
    running.d.modelSessions.has = (key: string) => key === running.key
    await running.d.prewarmWebchatCoordinator('bot-a', 'u1')
    expect(running.prewarmed()).toEqual([])
    const moved = await withCoordinator('u1')
    moved.d.agents.get('bot-a').coordinatorModel = { runtime: 'codex-acp', model: 'gpt-6-luna' }
    await moved.d.prewarmWebchatCoordinator('bot-a', 'u1')
    expect(moved.prewarmed()).toEqual([])
  })
})
