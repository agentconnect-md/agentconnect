import { describe, it, expect } from 'vitest'
import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import { buildTurnPlan, type TurnPlanInput } from '../src/daemon/turn-plan.js'
import { AGENT_CALL_HOP_LIMIT_NOTICE } from '../src/daemon/constants.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import { TurnOutputRegistry, type TurnOutputSurface } from '../src/platforms/turn-output.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { CallMeta, DaemonConverger, DaemonRenderAction, Pending, QueueEntry } from '../src/daemon/turn-types.js'
import type { WebchatTurnContext } from '../src/webchat/types.js'

/**
 * The PURE half of one dispatched turn: every decision `dispatchOne` makes before
 * it touches a host, a store row, or a connection. No daemon boot, no I/O.
 */

type Surface = TurnOutputSurface<Pending, DaemonRenderAction, DaemonConverger, NormalizedMessage>

const surfaceFor = (platform: string): Surface =>
  ({
    platform,
    createConverger: () => ({ label: platform }),
    initialTurnState: () => ({ seed: platform }),
    apply: async () => {}
  }) as unknown as Surface

const surfaces = new TurnOutputRegistry<Pending, DaemonRenderAction, DaemonConverger, NormalizedMessage>(
  surfaceFor('slack')
)
for (const platform of ['telegram', 'discord', 'feishu']) surfaces.register(surfaceFor(platform))

const message = (over: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    msgId: 'm1',
    traceId: 't1',
    source: 'user',
    platform: 'slack',
    channel: 'C1',
    sender: { id: 'U1', isBot: false },
    text: 'hello',
    mentionedBots: [],
    isDm: false,
    ...over
  }) as NormalizedMessage

const webchatCtx = (over: Partial<WebchatTurnContext> = {}): WebchatTurnContext =>
  ({ conversationId: 'c1', turnId: 'wt1', sink: { done: () => {} }, ...over }) as unknown as WebchatTurnContext

const entryFor = (over: Partial<QueueEntry> = {}): QueueEntry =>
  ({ agentId: 'a1', msg: message(), initAbort: new AbortController(), ...over }) as unknown as QueueEntry

const agentFor = (over: Partial<TurnPlanInput['agent']> = {}): TurnPlanInput['agent'] => ({
  name: 'ada',
  output: { mode: 'low', showFooter: true, showStatusBar: false },
  ...over
})

const planFor = (over: Partial<TurnPlanInput> = {}) =>
  buildTurnPlan({
    entry: entryFor(),
    agent: agentFor(),
    sessionKey: 'slack:C1:T1',
    evaluationTurnId: 'turn-1',
    stickyOutputMode: undefined,
    hostAlreadyRunning: true,
    clusterPodBootstrap: false,
    protectedAddresses: [],
    codexUsageIsPerPrompt: false,
    features: { turnFinalContextRefresh: true },
    turnSurfaces: surfaces,
    ...over
  })

describe('buildTurnPlan', () => {
  it('lets a sticky output override win over the agent default, and falls back without one', () => {
    expect(planFor({ stickyOutputMode: 'high' }).mode).toBe('high')
    expect(planFor().mode).toBe('low')
    expect(
      planFor({ agent: agentFor({ output: { mode: 'medium', showFooter: true, showStatusBar: false } }) }).mode
    ).toBe('medium')
  })

  it('takes the null-connection seam for headless, non-continuation webchat, and `none`', () => {
    expect(planFor({ entry: entryFor({ msg: message({ headless: true }) }) }).suppressReplyConn).toBe(true)
    expect(planFor({ entry: entryFor({ webchat: webchatCtx() }) }).suppressReplyConn).toBe(true)
    // §5.2 dual sinks: a continuation keeps its platform connection.
    expect(planFor({ entry: entryFor({ webchat: webchatCtx({ continuation: true }) }) }).suppressReplyConn).toBe(false)
    expect(planFor({ stickyOutputMode: 'none' }).suppressReplyConn).toBe(true)
    expect(planFor().suppressReplyConn).toBe(false)
    // Mode wins even over a continuation's dual sink.
    expect(
      planFor({ stickyOutputMode: 'none', entry: entryFor({ webchat: webchatCtx({ continuation: true }) }) })
        .suppressReplyConn
    ).toBe(true)
  })

  it('suppresses the approval surface only for a `none` Slack turn with a live chat surface', () => {
    expect(planFor({ stickyOutputMode: 'none' }).approvalSurfaceSuppressed).toBe(true)
    for (const platform of ['telegram', 'discord', 'feishu', 'webchat']) {
      expect(
        planFor({ stickyOutputMode: 'none', entry: entryFor({ msg: message({ platform }) }) }).approvalSurfaceSuppressed
      ).toBe(false)
    }
    expect(
      planFor({ stickyOutputMode: 'none', entry: entryFor({ webchat: webchatCtx() }) }).approvalSurfaceSuppressed
    ).toBe(false)
    expect(
      planFor({ stickyOutputMode: 'none', entry: entryFor({ msg: message({ headless: true }) }) })
        .approvalSurfaceSuppressed
    ).toBe(false)
    expect(planFor().approvalSurfaceSuppressed).toBe(false)
  })

  it('labels startup activity by whether the host is already running', () => {
    expect(planFor({ hostAlreadyRunning: true }).startupActivityLabel).toBe('is thinking…')
    expect(planFor({ hostAlreadyRunning: false }).startupActivityLabel).toBe('is starting up…')
  })

  it('lets a sandbox pod that is not up yet outrank both startup labels', () => {
    for (const hostAlreadyRunning of [true, false]) {
      const plan = planFor({ hostAlreadyRunning, clusterPodBootstrap: true })
      expect(plan.startupActivityLabel).toBe('is allocating a sandbox pod…')
      expect(plan.clusterPodBootstrap).toBe(true)
    }
    expect(planFor({ clusterPodBootstrap: false }).clusterPodBootstrap).toBe(false)
  })

  it('routes the final context refresh to exactly one of stageAnswer / webchatRefresh', () => {
    const chat = planFor()
    expect([chat.stageAnswer, chat.webchatRefresh]).toEqual([true, false])

    const wc = planFor({
      entry: entryFor({ webchat: webchatCtx(), msg: message({ platform: 'webchat' }) })
    })
    expect([wc.stageAnswer, wc.webchatRefresh]).toEqual([false, true])

    const off = planFor({ features: { turnFinalContextRefresh: false } })
    expect([off.stageAnswer, off.webchatRefresh]).toEqual([false, false])

    const gh = planFor({ entry: entryFor({ githubReply: { owner: 'o' } as never }) })
    expect([gh.stageAnswer, gh.webchatRefresh]).toEqual([false, false])
  })

  it('enables the attribution footer only where the platform has that chrome', () => {
    expect(planFor().attributionFooterEnabled).toBe(true)
    const telegram = planFor({ entry: entryFor({ msg: message({ platform: 'telegram' }) }) })
    expect(telegram.showFooter).toBe(true)
    expect(telegram.attributionFooterEnabled).toBe(false)
    expect(
      planFor({ agent: agentFor({ output: { mode: 'low', showFooter: false, showStatusBar: false } }) })
        .attributionFooterEnabled
    ).toBe(false)
  })

  it('carries the hop-limit notice only for a call that reaches the limit', () => {
    const call = (hopCount: number): CallMeta => ({ hopCount }) as unknown as CallMeta
    expect(planFor({ entry: entryFor({ callMeta: call(MAX_AGENT_CALL_HOPS - 1) }) }).hopLimitNotice).toBe(
      AGENT_CALL_HOP_LIMIT_NOTICE
    )
    expect(planFor({ entry: entryFor({ callMeta: call(MAX_AGENT_CALL_HOPS - 2) }) }).hopLimitNotice).toBeUndefined()
    // A human turn is depth 0 and never carries the notice, whatever the limit.
    expect(planFor().hopLimitNotice).toBeUndefined()
  })

  it('gates a github turn on the poster publish state', () => {
    const githubReply = { owner: 'o' } as never
    expect(planFor({ entry: entryFor({ githubReply }) }).githubTurnEligible).toBe(true)
    expect(planFor({ entry: entryFor({ githubReply, posterPublishState: 'not_started' }) }).githubTurnEligible).toBe(
      true
    )
    for (const posterPublishState of ['in_flight', 'settled'] as const) {
      expect(planFor({ entry: entryFor({ githubReply, posterPublishState }) }).githubTurnEligible).toBe(false)
    }
    expect(planFor().githubTurnEligible).toBe(false)
  })

  it('activates a github reply batch only when it is sealed and holds more than one item', () => {
    const batch = (over: Record<string, unknown>) =>
      entryFor({ hookContext: { github: { subjectKind: 'pull_request' }, githubReviewBatch: over } as never })
    expect(planFor({ entry: batch({ sealed: true, items: [1, 2] }) }).githubReplyBatchActive).toBe(true)
    expect(planFor({ entry: batch({ sealed: true, items: [1] }) }).githubReplyBatchActive).toBe(false)
    expect(planFor({ entry: batch({ sealed: false, items: [1, 2] }) }).githubReplyBatchActive).toBe(false)
    expect(planFor().githubReplyBatchActive).toBe(false)
  })

  it('opens the batched reply tool for no provider that publishes its batch as one ordinary reply', () => {
    // A GitLab note batch is answered by the single daemon-owned note, so the GitHub tool stays closed.
    const gitlab = entryFor({
      hookContext: {
        gitlab: { target: { kind: 'merge_request', iid: 7 } },
        githubReviewBatch: { sealed: true, items: [1, 2] }
      } as never
    })
    expect(planFor({ entry: gitlab }).githubReplyBatchActive).toBe(false)
  })

  it('keys the transcript channel by channel plus transport scope', () => {
    expect(planFor().transcriptChannel).toBe(transcriptChannelKey('C1', undefined))
    const scoped = planFor({ entry: entryFor({ msg: message({ transportScope: 'bot-7' }) }) })
    expect(scoped.transcriptChannel).toBe(transcriptChannelKey('C1', 'bot-7'))
    const nulled = planFor({ entry: entryFor({ msg: message({ transportScope: null as never }) }) })
    expect(nulled.transcriptChannel).toBe(transcriptChannelKey('C1', null))
  })

  it('falls the status thread back to the message id at a channel root', () => {
    expect(planFor().statusThread).toBe('m1')
    expect(planFor({ entry: entryFor({ msg: message({ thread: 'T9' }) }) }).statusThread).toBe('T9')
  })

  it('is deterministic — the same input plans the same turn', () => {
    const entry = entryFor({ msg: message({ thread: 'T9', transportScope: 'bot-7' }), callMeta: {} as CallMeta })
    const input = { entry, protectedAddresses: ['<@U_SHARED> reviewer'] }
    const a = planFor(input)
    const b = planFor(input)
    expect(a).toEqual(b)
    // A fresh turn context per plan — the converger it seeds must never be shared.
    expect(a.turnCtx).not.toBe(b.turnCtx)
    expect(a.turnCtx).toEqual(b.turnCtx)
  })
})
