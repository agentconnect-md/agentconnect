// A session this daemon has no record of is admitted with the CP under its outward id before its runtime starts; a refusal ends the turn (org-session-policy.md).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { sessionKey } from '../src/store/local-store.js'
import { sessionChannelOf, sessionThreadOf } from '../src/messages/normalized.js'
import { EvaluationEventCollector } from '../src/evaluation/index.js'
import { fakeCpClient } from './webchat-continuation-fixture.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { FakeClock } from './cp/fake-clock.js'
import type { SessionAdmitOutcome } from '../src/session-admission.js'

const agentId = 'example-agent'
const roots: string[] = []
const daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-session-admit-'))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { test: { command: 'node', args: ['unused'] } }
    })
  )
  const dir = join(root, 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id: agentId,
      name: 'Example agent',
      runtime: 'test',
      workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
      integrations: [],
      memory: { provider: 'none' }
    })
  )
  return root
}

type Outcome = SessionAdmitOutcome
const ADMITTED: Outcome = { kind: 'admitted' }
const FAILED: Outcome = { kind: 'failed' }
const UNSUPPORTED: Outcome = { kind: 'unsupported' }

async function start(outcome: Outcome | (() => Promise<Outcome>) = ADMITTED, admits = true) {
  const timeline: string[] = []
  const daemon = new Daemon({
    root: scaffold(),
    clock: new FakeClock(),
    slackAppFactory: fakeSlackAppFactory(),
    evaluation: { observer: new EvaluationEventCollector(), runId: 'session-admit' },
    hostFactory: (_agent, onUpdate) =>
      ({
        start: async () => {
          timeline.push('host.start')
        },
        stop: async () => {},
        cancel: async () => {},
        newSession: async () => {
          timeline.push('session/new')
          return 'acp-1'
        },
        loadSession: async () => true,
        hasSession: () => true,
        prompt: async (id: string) => {
          onUpdate(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } })
          return { stopReason: 'end_turn' }
        }
      }) as any
  })
  daemons.push(daemon)
  await daemon.start()
  const internal = daemon as any
  const admitSession = vi.fn(
    async (_agentId: string, _sessionId: string, _purpose?: string, _opts?: { wait?: boolean }): Promise<Outcome> => {
      timeline.push('admit')
      return typeof outcome === 'function' ? await outcome() : outcome
    }
  )
  internal.cpClient = {
    ...fakeCpClient(),
    emitEventSession: vi.fn(),
    emitIntegrationChannels: vi.fn(),
    supportsServerFeature: () => false,
    admitsSessions: () => admits,
    admitSession
  }
  const warn = vi.spyOn(internal.log, 'warn')
  const turn = async (conversationId: string, text = 'Please look at this') => {
    const result = await daemon.runEvaluationTurn({ agentId, conversationId, text })
    await daemon.waitForEvaluationIdle()
    return result
  }
  return { internal, admitSession, timeline, turn, warn }
}

const admissionWarnings = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter(([line]) => String(line).startsWith('session admission'))

describe('admitting a new session with the control plane', () => {
  it('admits a new session once, under its outward id, before its runtime starts', async () => {
    const { internal, admitSession, timeline, turn } = await start()

    expect(await turn('first')).toMatchObject({ sessionId: 'acp-1', output: 'Done' })
    expect(timeline).toEqual(['admit', 'host.start', 'session/new'])
    const [row] = await internal.store.listSessions(agentId)
    expect(admitSession.mock.calls).toEqual([[agentId, row.sessionId, undefined, { wait: false }]])

    // The session now has a local record, so a later turn of it is never admitted again.
    expect(await turn('first', 'And again')).toMatchObject({ output: 'Done' })
    expect(admitSession).toHaveBeenCalledOnce()
  })

  it('starts the session anyway when admission fails, warning once', async () => {
    const { admitSession, warn, turn } = await start(FAILED)
    expect(await turn('first')).toMatchObject({ output: 'Done' })
    expect(await turn('first', 'And again')).toMatchObject({ output: 'Done' })
    expect(admitSession).toHaveBeenCalledOnce()
    expect(admissionWarnings(warn)).toHaveLength(1)
  })

  it('starts the session anyway when the client throws', async () => {
    const { warn, turn } = await start(async () => {
      throw new Error('unexpected')
    })
    expect(await turn('first')).toMatchObject({ output: 'Done' })
    expect(admissionWarnings(warn)).toHaveLength(1)
  })

  it('starts the session without a warning when the control plane does not admit sessions', async () => {
    const { admitSession, warn, turn } = await start(UNSUPPORTED)
    expect(await turn('first')).toMatchObject({ output: 'Done' })
    expect(admitSession).toHaveBeenCalledOnce()
    expect(admissionWarnings(warn)).toEqual([])
  })

  it('sends nothing while no control plane admits sessions', async () => {
    const { admitSession, timeline, turn } = await start(ADMITTED, false)
    expect(await turn('first')).toMatchObject({ output: 'Done' })
    expect(admitSession).not.toHaveBeenCalled()
    expect(timeline).toEqual(['host.start', 'session/new'])
  })

  it('refuses a new session at the limit before its runtime starts, and admits it again on the next turn', async () => {
    const refused: Outcome = { kind: 'refused', limit: 2, used: 2, resetsAt: '2026-12-01T00:00:00.000Z' }
    const { internal, admitSession, timeline, turn } = await start(refused)

    const outcome = await turn('first').catch((err: unknown) => err)
    expect((outcome as Error).message).toContain('used 2 of its 2 sessions')
    expect(timeline).toEqual(['admit'])
    expect(await internal.store.listSessions(agentId)).toEqual([])
    // A refused id has no admission, so the next turn of the conversation asks again, now waiting on the answer.
    await turn('first', 'Again').catch(() => undefined)
    expect(admitSession).toHaveBeenCalledTimes(2)
    expect(admitSession.mock.calls[1]![3]).toEqual({ wait: true })
    expect(timeline).toEqual(['admit', 'admit'])
  })

  it('refuses as temporarily unavailable when an enforcing organization cannot be asked', async () => {
    const answers: Outcome[] = [{ kind: 'admitted', enforcing: true }, FAILED]
    const { admitSession, timeline, turn } = await start(async () => answers.shift()!)

    expect(await turn('first')).toMatchObject({ output: 'Done' })
    const outcome = await turn('second').catch((err: unknown) => err)
    expect((outcome as Error).message).toContain("can't start right now")
    expect(admitSession.mock.calls[1]![3]).toEqual({ wait: true })
    expect(timeline).toEqual(['admit', 'host.start', 'session/new', 'admit'])
  })

  it('admits an API turn under the key its session will have, and only while it has no local record', async () => {
    const refused: Outcome = { kind: 'refused', limit: 2, used: 2, resetsAt: '2026-12-01T00:00:00.000Z' }
    const { internal, admitSession, turn } = await start(refused)
    const msg = { platform: 'webchat', channel: 'conv-api', msgId: 'm1', sender: { id: 'U1' }, text: 'hi' }
    const answer = await internal.admitApiSession(agentId, msg)
    expect(answer).toEqual({ reason: 'session_limit_reached', detail: expect.stringContaining('2 of its 2 sessions') })
    const key = sessionKey('webchat', sessionChannelOf(msg), sessionThreadOf(msg as never), agentId)
    expect(admitSession.mock.calls[0]![1]).toBe(await internal.store.ensureOutwardSessionId(key, agentId))

    admitSession.mockImplementation(async () => ADMITTED)
    await turn('known')
    admitSession.mockClear()
    const [known] = await internal.store.listSessions(agentId)
    expect(
      await internal.admitApiSession(agentId, {
        ...msg,
        platform: known.platform,
        channel: known.channel,
        thread: known.thread
      })
    ).toBeUndefined()
    expect(admitSession).not.toHaveBeenCalled()
  })

  it('admits before the model session is ensured', async () => {
    const { internal, admitSession, timeline } = await start()
    internal.githubReviews = { prepareGithubReviewWorkspace: async () => ({}) }
    internal.modelSessions = {
      enabled: true,
      keys: () => [],
      release: async () => {},
      hasStartedHost: () => true,
      ensure: async () => {
        timeline.push('modelSessions.ensure')
        return { host: {}, hostKey: 'model-host', stop: async () => {}, waitForCleanup: async () => {} }
      }
    }
    internal.sessions = {
      handle: async () => {
        timeline.push('sessions.handle')
        return { sessionId: 'acp-1', blocks: [], created: true }
      }
    }
    const run = {
      entry: {
        agentId,
        initAbort: new AbortController(),
        msg: { platform: 'webchat', channel: 'C1', msgId: 'm1', sender: { id: 'U1' }, text: 'hi' }
      },
      key: 'session-admit-key',
      plan: { deliveryBinding: {} },
      agent: internal.agents.get(agentId),
      evaluation: {}
    }
    await internal.openSession(run, () => {})
    expect(timeline).toEqual(['admit', 'modelSessions.ensure', 'sessions.handle'])
    expect(admitSession.mock.calls).toEqual([
      [agentId, await internal.store.ensureOutwardSessionId('session-admit-key', agentId), undefined, { wait: false }]
    ])
  })

  it('neither ensures the model session nor starts the runtime of a refused session, and ends its hook run with the reason', async () => {
    const refused: Outcome = { kind: 'refused', limit: 1, used: 1, resetsAt: '2026-12-01T00:00:00.000Z' }
    const { internal, timeline } = await start(refused)
    const ensure = vi.fn()
    internal.modelSessions = {
      enabled: true,
      keys: () => [],
      release: async () => {},
      hasStartedHost: () => false,
      ensure
    }
    const handle = vi.fn()
    internal.sessions = { handle }
    const emitHookCompletion = vi.fn(async () => {})
    internal.emitHookCompletion = emitHookCompletion
    internal.reportsHookOutcome = () => true
    internal.surfaceTurnFailure = vi.fn(async () => {})
    const hookContext = { hookId: 'example-hook', runId: 'example-run' }
    const run = {
      entry: {
        agentId,
        initAbort: new AbortController(),
        hookContext,
        msg: { platform: 'webchat', channel: 'C1', msgId: 'm1', sender: { id: 'U1' }, text: 'hi' }
      },
      key: 'session-refused-key',
      plan: { deliveryBinding: {} },
      agent: internal.agents.get(agentId),
      evaluation: { failEvaluation: () => {}, finishEvaluation: () => {} }
    }
    await expect(internal.openSession(run, () => {})).rejects.toThrow('used 1 of its 1 sessions')
    expect(ensure).not.toHaveBeenCalled()
    expect(handle).not.toHaveBeenCalled()
    expect(timeline).toEqual(['admit'])
    expect(emitHookCompletion).toHaveBeenCalledWith(
      hookContext,
      'failed',
      { reason: 'session_limit_reached' },
      run.entry
    )
    const [surfaced] = (internal.surfaceTurnFailure as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect((surfaced as Error).message).toContain('resets on 2026-12-01 00:00 UTC')
  })
})

describe('admitting a memory dream with the control plane', () => {
  const dreamAgent = 'example-dream-agent'

  function dreamScaffold(): string {
    const root = mkdtempSync(join(tmpdir(), 'ac-dream-admit-'))
    roots.push(root)
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    const dir = join(root, 'agents', dreamAgent)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        id: dreamAgent,
        name: 'Example dream agent',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
        memory: { provider: 'managed', dreaming: { enabled: true } }
      })
    )
    return root
  }

  async function startDream(outcome: Outcome | (() => Promise<Outcome>) = ADMITTED) {
    const timeline: string[] = []
    const root = dreamScaffold()
    const daemon = new Daemon({
      root,
      dreamOperationPolicy: 'test-only',
      hostFactory: () =>
        ({
          start: async () => {
            timeline.push('host.start')
          },
          hasSession: () => true,
          usesMetaSystemPrompt: () => false,
          newSession: async () => 'dream-acp',
          modelOptions: () => null,
          permissionModeOptions: () => ({ modes: ['read-only'] }),
          setSessionPermissionMode: async () => true,
          prompt: async () => ({ stopReason: 'end_turn' }),
          discardSession: () => {},
          cancel: async () => {},
          stop: async () => {}
        }) as any
    })
    daemons.push(daemon)
    await daemon.start()
    const internal = daemon as any
    const admitSession = vi.fn(
      async (_agentId: string, _sessionId: string, _purpose?: string, _opts?: { wait?: boolean }): Promise<Outcome> => {
        timeline.push('admit')
        return typeof outcome === 'function' ? await outcome() : outcome
      }
    )
    const emitEventSession = vi.fn()
    internal.cpClient = {
      ...fakeCpClient(),
      emitEventSession,
      supportsServerFeature: () => false,
      admitsSessions: () => true,
      admitSession
    }
    const dream = (dreamId: string) =>
      internal.runDreamExtraction(dreamAgent, 'system', 'prompt', new AbortController().signal, {
        dreamId,
        trigger: 'schedule',
        sessionIds: [],
        inputDir: join(root, 'in'),
        materializeInputs: async () => {}
      })
    return { internal, admitSession, emitEventSession, timeline, dream }
  }

  it('admits once with the dream purpose, under the id its milestones carry, before its host starts', async () => {
    const { internal, admitSession, emitEventSession, timeline, dream } = await startDream()

    expect(await dream('drm-1')).toMatchObject({ sessionId: 'dream-acp' })
    expect(timeline).toEqual(['admit', 'host.start'])
    const outward = await internal.store.ensureOutwardSessionId(
      sessionKey('dream', 'memory', 'drm-1', dreamAgent),
      dreamAgent
    )
    expect(admitSession.mock.calls).toEqual([[dreamAgent, outward, 'memory-dream', { wait: false }]])
    const milestones = emitEventSession.mock.calls.map(([event]) => event).filter((e) => e.platform === 'dream')
    expect(milestones.map((e) => e.phase)).toEqual(['start', 'end'])
    expect(new Set(milestones.map((e) => e.sessionId))).toEqual(new Set([outward]))
  })

  it('skips the dream before its credential or host when admission refuses it', async () => {
    const refused: Outcome = { kind: 'refused', limit: 1, used: 1, resetsAt: '2026-12-01T00:00:00.000Z' }
    const { timeline, dream } = await startDream(refused)
    await expect(dream('drm-refused')).rejects.toThrow('sessions this month')
    expect(timeline).toEqual(['admit'])
  })

  it('skips the dream while its enforcing organization cannot be asked', async () => {
    const answers: Outcome[] = [{ kind: 'admitted', enforcing: true }, FAILED]
    const { admitSession, timeline, dream } = await startDream(async () => answers.shift()!)
    expect(await dream('drm-1')).toMatchObject({ sessionId: 'dream-acp' })
    await expect(dream('drm-2')).rejects.toThrow("can't start right now")
    expect(admitSession.mock.calls[1]![3]).toEqual({ wait: true })
    expect(timeline).toEqual(['admit', 'host.start', 'admit'])
  })

  it('runs the dream anyway when admission fails or throws', async () => {
    const failed = await startDream(FAILED)
    expect(await failed.dream('drm-failed')).toMatchObject({ sessionId: 'dream-acp' })
    expect(failed.admitSession).toHaveBeenCalledOnce()
    const thrown = await startDream(async () => {
      throw new Error('unexpected')
    })
    expect(await thrown.dream('drm-thrown')).toMatchObject({ sessionId: 'dream-acp' })
    expect(thrown.timeline).toEqual(['admit', 'host.start'])
  })
})
