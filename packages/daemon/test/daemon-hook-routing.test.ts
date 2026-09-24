import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionEvaluation, HookReport, HookRoutingProjection, RdMsgHook } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { DecisionEvaluationInput } from '../src/decisions/evaluator.js'
import { GithubReplyCollector } from '../src/github/poster.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// code-host-decisions.md §5: the evaluation host records a routed event, chooses once, and a selected fire carries why.

const AGENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const HOOK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_HOOK = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ROUTING = '55555555-5555-4555-8555-555555555555'
const DECISION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const STALE_DECISION = '99999999-9999-4999-8999-999999999999'
const RULE = '77777777-7777-4777-8777-777777777777'
const REPO = 'example-org/example-repo'
const question = { type: 'boolean', instructions: 'Is this a bug?', criteria: { true: 'Yes', false: 'No' } } as const
const projection = (over: Partial<HookRoutingProjection> = {}): HookRoutingProjection => ({
  routingId: ROUTING,
  provider: 'github',
  repoId: '123',
  repoFullName: REPO,
  family: 'issues',
  config: {
    enabled: true,
    decisionId: DECISION,
    rules: [{ id: RULE, when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: OTHER_AGENT } }],
    otherwise: { type: 'default_agent' }
  },
  definition: { id: DECISION, orgId: 'org-1', name: 'Bug', providerId: 'typesafe', model: 'jev-1.13.0', question },
  members: [
    { agentId: AGENT_ID, hookId: HOOK_ID },
    { agentId: OTHER_AGENT, hookId: OTHER_HOOK }
  ],
  ...over
})
const answered = (value: boolean): DecisionEvaluation => ({
  status: 'answered',
  answer: { type: 'boolean', value, probability: value ? 0.9 : 0.1 },
  model: 'jev-1.13.0',
  usage: { inputTokens: 20, outputTokens: 1 }
})

function scaffold(agentExtra: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-hook-routing-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  const adir = join(root, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' },
      hookRoutings: [projection()],
      ...agentExtra
    })
  )
  return root
}

async function boot(agentExtra: Record<string, unknown> = {}) {
  let onUpdate!: (sid: string, u: unknown) => void
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-hook-1'),
    modelOptions: vi.fn(() => null),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (sid: string, _blocks: { type: string; text?: string }[]) => {
      onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    forgetSession: vi.fn(),
    stop: vi.fn(async () => {})
  }
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root: scaffold(agentExtra),
    hostFactory: (_agent: unknown, cb: (sid: string, u: unknown) => void) => {
      onUpdate = cb
      return host as never
    }
  })
  await daemon.start()
  const hookReports: HookReport[] = []
  ;(daemon as any).cpClient = {
    organizationScope: () => 'connection' as const,
    stop: vi.fn(async () => {}),
    emitEventSession: () => {},
    emitHookReport: async (r: HookReport) => {
      hookReports.push(r)
      return 'acknowledged' as const
    }
  }
  const poster = { publish: vi.fn(async () => ({ kind: 'issue_comment' as const, commentId: '9001' })) }
  ;(daemon as any).githubReviews.makeCodeHostReply = vi.fn(() => ({ poster, collector: new GithubReplyCollector() }))
  const evaluate = vi.spyOn((daemon as any).decisionEvaluator, 'evaluate') as unknown as ReturnType<
    typeof vi.fn<(input: DecisionEvaluationInput, signal?: AbortSignal) => Promise<DecisionEvaluation>>
  >
  return { daemon, host, hookReports, evaluate, store: (daemon as any).store }
}

let delivery = 0
const event = (over: Partial<RdMsgHook> = {}, text = 'It crashes on start'): RdMsgHook => {
  delivery += 1
  return {
    source: 'hook',
    agentId: AGENT_ID,
    sessionKey: `${REPO}#42`,
    msgId: `${HOOK_ID}:d-${delivery}`,
    hookId: HOOK_ID,
    deliveryKey: `d-${delivery}`,
    firedAt: new Date(Date.now() + delivery).toISOString(),
    event: 'issue_comment:created',
    github: { repoId: '123', repoFullName: REPO, sourceInstallationId: '456', subjectKind: 'issue' },
    context: {
      source: 'github',
      event: 'issue_comment',
      action: 'created',
      repo: REPO,
      number: 42,
      title: 'Crash on start',
      senderLogin: 'reporter',
      authorAssociation: 'NONE',
      bodyExcerpt: text,
      subject: { authorLogin: 'reporter', authorType: 'User', state: 'open', body: 'The app crashes.' },
      truncated: false
    },
    ...over
  }
}
const candidates = [
  { hookId: HOOK_ID, agentId: AGENT_ID, via: 'implicit' as const },
  { hookId: OTHER_HOOK, agentId: OTHER_AGENT, via: 'implicit' as const }
]
// The relay's host copy: the evaluation agent's own rule, a `:route` msgId, and the candidates.
const hostCopy = (fired: RdMsgHook, routing: Partial<NonNullable<RdMsgHook['routing']>> = {}): RdMsgHook => ({
  ...fired,
  msgId: `${fired.msgId}:route`,
  routing: { routingId: ROUTING, decisionId: DECISION, candidates, ...routing }
})
const send = async (daemon: Daemon, msg: RdMsgHook): Promise<any> => await (daemon as any).handleRelayMsg(msg, () => {})
const rows = async (store: any): Promise<{ text: string; ts: string }[]> =>
  (await store.db
    .prepare(`SELECT text, ts FROM transcript WHERE channel = ? AND kind = 'text' ORDER BY seq`)
    .all(transcriptChannelKey(REPO, 'github:123'))) as { text: string; ts: string }[]
const verdicts = async (store: any): Promise<{ subject: string; state: string; disposition: string | null }[]> =>
  (await store.db.prepare('SELECT subject, state, disposition FROM decision_verdict ORDER BY seq').all()) as any[]

describe('code-host Decision routing host (daemon)', () => {
  it('records a record-only copy for a paused host under the base delivery identity and chooses nothing', async () => {
    const { daemon, host, hookReports, evaluate, store } = await boot({ pause: true })
    const fired = event({}, 'A bot reply')
    const ack = await send(daemon, hostCopy(fired, { candidates: [] }))
    expect(ack).toEqual({ msgId: `${fired.msgId}:route`, accepted: true })
    const recorded = await rows(store)
    expect(recorded.map((r) => r.text)).toEqual(['A bot reply'])
    expect(recorded[0]!.ts).toBe(`${Date.parse(fired.firedAt)}|${fired.msgId}`)
    expect(evaluate).not.toHaveBeenCalled()
    expect(host.prompt).not.toHaveBeenCalled()
    expect(hookReports).toEqual([])
    expect(await verdicts(store)).toEqual([])
    await daemon.stop()
  })

  it('chooses once with the thread history, persists the verdict, and replays it to a redelivery', async () => {
    const { daemon, host, evaluate, store } = await boot({ pause: true })
    evaluate.mockResolvedValue(answered(true))
    await send(daemon, hostCopy(event({}, 'Earlier comment'), { candidates: [] }))
    const fired = event({}, 'Please fix this')
    const ack = await send(daemon, hostCopy(fired))
    expect(ack).toMatchObject({ msgId: `${fired.msgId}:route`, accepted: true })
    expect(ack.hookRoute.targets).toEqual([
      {
        hookId: OTHER_HOOK,
        selection: expect.objectContaining({ routingId: ROUTING, decisionId: DECISION, reason: 'decision', question })
      }
    ])
    const state = evaluate.mock.calls[0]![0].state as any
    expect(state).toMatchObject({ source: 'github', currentMessage: { text: 'Please fix this' } })
    expect(state.history.map((h: { text: string }) => h.text)).toEqual(['Earlier comment'])
    expect(await verdicts(store)).toEqual([
      { subject: `hook-router:${ROUTING}`, state: 'admitted', disposition: 'match' }
    ])
    // A redelivery past the ack cache reads the stored choice.
    ;(daemon as any).relayMsgAcks.clear()
    evaluate.mockResolvedValue(answered(false))
    expect(await send(daemon, hostCopy(fired))).toEqual(ack)
    expect(evaluate).toHaveBeenCalledTimes(1)
    // Routing is not a turn: the paused host ran nothing.
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('holds a copy whose routing is missing, disabled, or names another Decision', async () => {
    for (const [extra, routing] of [
      [{ hookRoutings: [] }, {}],
      [{ hookRoutings: [projection({ config: { ...projection().config, enabled: false } })] }, {}],
      [{}, { decisionId: STALE_DECISION }]
    ] as const) {
      const { daemon, evaluate, store } = await boot(extra)
      const fired = event()
      const ack = await send(daemon, hostCopy(fired, routing))
      expect(ack).toEqual({ msgId: `${fired.msgId}:route`, accepted: false, reason: 'pending_sync' })
      expect(evaluate).not.toHaveBeenCalled()
      // The event is still recorded: the thread's history stays whole.
      expect((await rows(store)).map((r) => r.text)).toEqual(['It crashes on start'])
      await daemon.stop()
    }
  })

  it('renders a selected fire as decision evidence and leaves an unrouted fire unchanged', async () => {
    const { daemon, host, hookReports } = await boot()
    const selected = event(
      {
        routeSelection: {
          routingId: ROUTING,
          decisionId: DECISION,
          reason: 'decision',
          verdictSeq: 3,
          question,
          answer: { type: 'boolean', value: true, probability: 0.9 },
          model: 'jev-1.13.0'
        }
      },
      'Please fix this'
    )
    expect(await send(daemon, selected)).toEqual({ msgId: selected.msgId, accepted: true })
    await vi.waitFor(() => expect(hookReports).toHaveLength(1), WAIT)
    const blocks = host.prompt.mock.calls[0]![1].map((b) => b.text ?? '')
    const evidence = blocks.find((b) => b.startsWith('(Decision routing evidence'))
    expect(evidence).toContain("a routing rule matched the Decision's answer and named you")
    expect(evidence).toContain('Other agents watching this repository may also have been selected')
    const plain = event({ sessionKey: `${REPO}#7` })
    expect(await send(daemon, plain)).toEqual({ msgId: plain.msgId, accepted: true })
    await vi.waitFor(() => expect(hookReports).toHaveLength(2), WAIT)
    const plainBlocks = host.prompt.mock.calls[1]![1].map((b) => b.text ?? '')
    expect(plainBlocks.some((b) => b.includes('evidence'))).toBe(false)
    await daemon.stop()
  })
})
