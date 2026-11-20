// A session this daemon has no record of is admitted with the CP once, under its outward id, before its runtime starts; the turn never waits on the answer (org-session-policy.md, Admission).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { EvaluationEventCollector } from '../src/evaluation/index.js'
import { fakeCpClient } from './webchat-continuation-fixture.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { FakeClock } from './cp/fake-clock.js'

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

type Outcome = 'admitted' | 'unsupported' | 'failed'

async function start(outcome: Outcome | (() => Promise<Outcome>) = 'admitted', admits = true) {
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
  const admitSession = vi.fn(async (_agentId: string, _sessionId: string): Promise<Outcome> => {
    timeline.push('admit')
    return typeof outcome === 'function' ? await outcome() : outcome
  })
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
    expect(admitSession.mock.calls).toEqual([[agentId, row.sessionId]])

    // The session now has a local record, so a later turn of it is never admitted again.
    expect(await turn('first', 'And again')).toMatchObject({ output: 'Done' })
    expect(admitSession).toHaveBeenCalledOnce()
  })

  it('starts the session anyway when admission fails, warning once', async () => {
    const { admitSession, warn, turn } = await start('failed')
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
    const { admitSession, warn, turn } = await start('unsupported')
    expect(await turn('first')).toMatchObject({ output: 'Done' })
    expect(admitSession).toHaveBeenCalledOnce()
    expect(admissionWarnings(warn)).toEqual([])
  })

  it('sends nothing while no control plane admits sessions', async () => {
    const { admitSession, timeline, turn } = await start('admitted', false)
    expect(await turn('first')).toMatchObject({ output: 'Done' })
    expect(admitSession).not.toHaveBeenCalled()
    expect(timeline).toEqual(['host.start', 'session/new'])
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
      [agentId, await internal.store.ensureOutwardSessionId('session-admit-key', agentId)]
    ])
  })
})
