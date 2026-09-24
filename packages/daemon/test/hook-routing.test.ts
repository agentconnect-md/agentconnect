import { describe, expect, it, vi } from 'vitest'
import {
  DecisionEvaluationsReply,
  type DecisionEvaluation,
  type HookRoutingProjection,
  type RdHookRouteCandidate,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import { DecisionEvaluationReader, DecisionEvaluationScopeError } from '../src/decisions/evaluations.js'
import type { DecisionEvaluationInput } from '../src/decisions/evaluator.js'
import { hookRouteEvidenceText } from '../src/decisions/evidence.js'
import { buildCodeHostHookState } from '../src/codehost/decision-state.js'
import { HookRouter, hookRouterSubject } from '../src/codehost/hook-routing.js'
import type { ChannelTextRow, LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

// code-host-decisions.md §5, §5.1, §7: the host's choice, the code-host state, and the routing evaluation lane.

const ORG = 'org-1'
const AGENT = '11111111-1111-4111-8111-111111111111'
const AGENT_B = '22222222-2222-4222-8222-222222222222'
const AGENT_C = '33333333-3333-4333-8333-333333333333'
const HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const HOOK_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ROUTING = '55555555-5555-4555-8555-555555555555'
const DECISION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const RULE_BUG = '77777777-7777-4777-8777-777777777777'
const RULE_DOCS = '88888888-8888-4888-8888-888888888888'
const CHANNEL = 'example-org/example-repo'
const question = {
  type: 'choice',
  instructions: 'What kind of issue?',
  criteria: { bug: 'A defect', docs: 'Documentation', other: 'Anything else' }
} as const

const projection = (over: Partial<HookRoutingProjection['config']> = {}): HookRoutingProjection => ({
  routingId: ROUTING,
  provider: 'github',
  repoId: '123',
  repoFullName: CHANNEL,
  family: 'issues',
  config: {
    enabled: true,
    decisionId: DECISION,
    rules: [
      { id: RULE_BUG, when: { type: 'choice', thresholds: { bug: 0.5 } }, action: { type: 'agent', agentId: AGENT_B } },
      {
        id: RULE_DOCS,
        when: { type: 'choice', thresholds: { docs: 0.3 } },
        action: { type: 'agent', agentId: AGENT_C }
      }
    ],
    otherwise: { type: 'default_agent' },
    ...over
  },
  definition: { id: DECISION, orgId: ORG, name: 'Actionable', providerId: 'typesafe', model: 'jev-1.13.0', question },
  members: [
    { agentId: AGENT, hookId: HOOK },
    { agentId: AGENT_B, hookId: HOOK_B },
    { agentId: AGENT_C, hookId: HOOK_C }
  ]
})

const ALL: RdHookRouteCandidate[] = [
  { hookId: HOOK, agentId: AGENT },
  { hookId: HOOK_B, agentId: AGENT_B },
  { hookId: HOOK_C, agentId: AGENT_C }
]

const fire = (over: Partial<RdMsgHook> = {}): RdMsgHook => ({
  source: 'hook',
  agentId: AGENT,
  sessionKey: 'example-org/example-repo#42',
  msgId: `${HOOK}:d-1`,
  hookId: HOOK,
  deliveryKey: 'd-1',
  firedAt: '2026-01-01T00:00:00.000Z',
  event: 'issue_comment:created',
  github: {
    repoId: '123',
    repoFullName: 'example-org/example-repo',
    sourceInstallationId: '456',
    subjectKind: 'issue'
  },
  context: {
    source: 'github',
    event: 'issue_comment',
    action: 'created',
    repo: 'example-org/example-repo',
    number: 42,
    title: 'Crash on start',
    htmlUrl: 'https://github.example.test/example-org/example-repo/issues/42',
    authorAssociation: 'NONE',
    labels: ['bug'],
    subject: {
      authorLogin: 'reporter',
      authorType: 'User',
      authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      state: 'open',
      body: 'It crashes.'
    }
  },
  ...over
})

let seq = 0
const row = (text: string, thread = '42', sender = 'someone'): ChannelTextRow => {
  seq += 1
  return { seq, thread, ts: `${seq}|x`, sender, text, body: null, quoteJson: null, kind: 'text' } as ChannelTextRow
}

const answered = (bug: number, docs = 0): DecisionEvaluation => ({
  status: 'answered',
  answer: {
    type: 'choice',
    value: bug >= docs && bug >= 1 - bug - docs ? 'bug' : docs >= 1 - bug - docs ? 'docs' : 'other',
    probabilities: { bug, docs, other: Math.round((1 - bug - docs) * 100) / 100 },
    confidence: 0.9
  },
  model: 'jev-1.13.0',
  usage: { inputTokens: 20, outputTokens: 1 }
})
const MATCH_BOTH = answered(0.6, 0.35)
const NO_MATCH = answered(0.1, 0.1)

async function harness() {
  const store = await openTestStore()
  const evaluate = vi.fn<(input: DecisionEvaluationInput) => Promise<DecisionEvaluation>>(async () => MATCH_BOTH)
  // What the host applies now; null means the routing is gone, undefined keeps the event's own projection.
  const live: { current?: HookRoutingProjection | null; base?: HookRoutingProjection } = {}
  const router = new HookRouter({
    store: () => store,
    evaluate: (input) => evaluate(input),
    now: () => Date.now(),
    ownerFence: () => 'local:test',
    currentProjection: () => (live.current === null ? undefined : (live.current ?? live.base)),
    log: { warn: () => {} }
  })
  let n = 0
  const post = async (text: string, candidates: RdHookRouteCandidate[] = ALL, thread = '42', p = projection()) => {
    n += 1
    const ts = `${n}|${HOOK}:d-${n}`
    await store.appendTranscript({
      channel: CHANNEL,
      thread,
      ts,
      sender: 'reporter',
      kind: 'text',
      text,
      orgAgentId: AGENT
    })
    const record = (await store.channelRecordRef(CHANNEL, ts, AGENT))!
    const msg = { ...fire(), routing: { routingId: ROUTING, decisionId: DECISION, candidates } }
    live.base = p
    return { record, choose: () => router.choose(msg, record, p) }
  }
  const agentsOf = (outcome: Awaited<ReturnType<HookRouter['choose']>>) =>
    outcome.accepted ? outcome.targets.map((t) => t.hookId) : outcome.reason
  return { store, evaluate, post, agentsOf, live }
}

describe('hook router (host choice)', () => {
  it('fires every agent a matching rule names, dropping a candidate no rule names', async () => {
    const h = await harness()
    const event = await h.post('Please fix this')
    const outcome = await event.choose()
    expect(h.agentsOf(outcome)).toEqual([HOOK_B, HOOK_C])
    if (!outcome.accepted) throw new Error('refused')
    expect(outcome.targets[0]!.selection).toMatchObject({
      routingId: ROUTING,
      decisionId: DECISION,
      reason: 'decision',
      verdictSeq: event.record.seq,
      question,
      answer: { type: 'choice', value: 'bug' },
      matchedKeys: ['bug', 'docs'],
      model: 'jev-1.13.0'
    })
    const input = h.evaluate.mock.calls[0]![0]
    expect(input.state).toMatchObject({ source: 'github', currentMessage: { text: 'Please fix this' } })
    const verdict = await h.store.getDecisionVerdict(event.record.seq, hookRouterSubject(ROUTING))
    expect(verdict).toMatchObject({ state: 'admitted', disposition: 'match', integrationId: ROUTING, channel: CHANNEL })
    expect(JSON.parse(verdict!.targetsJson!)).toEqual([
      { hookId: HOOK_B, agentId: AGENT_B, reason: 'decision' },
      { hookId: HOOK_C, agentId: AGENT_C, reason: 'decision' }
    ])
    expect(JSON.parse(verdict!.configJson)).toMatchObject({ question, model: 'jev-1.13.0', candidates: ALL })
    await h.store.close()
  })

  it('only fires candidates: a rule agent the relay did not offer is dropped', async () => {
    const h = await harness()
    const outcome = await (await h.post('Fix', [ALL[0]!, ALL[1]!])).choose()
    expect(h.agentsOf(outcome)).toEqual([HOOK_B])
    await h.store.close()
  })

  it('applies Otherwise when no rule matched: every candidate, or nobody', async () => {
    const h = await harness()
    h.evaluate.mockResolvedValue(NO_MATCH)
    const all = await (await h.post('Thanks', ALL, '1')).choose()
    expect(h.agentsOf(all)).toEqual([HOOK, HOOK_B, HOOK_C])
    if (all.accepted) expect(all.targets[0]!.selection.reason).toBe('otherwise')
    const skipped = await (await h.post('Thanks', ALL, '2', projection({ otherwise: { type: 'skip' } }))).choose()
    expect(skipped).toEqual({ accepted: true, targets: [] })
    await h.store.close()
  })

  it('selects nobody when a skip rule matched', async () => {
    const h = await harness()
    const p = projection({
      rules: [{ id: RULE_BUG, when: { type: 'choice', thresholds: { bug: 0.5 } }, action: { type: 'skip' } }]
    })
    const event = await h.post('spam', ALL, '42', p)
    expect(await event.choose()).toEqual({ accepted: true, targets: [] })
    expect((await h.store.getDecisionVerdict(event.record.seq, hookRouterSubject(ROUTING)))?.state).toBe('skipped')
    await h.store.close()
  })

  it('fires every candidate when the provider is unavailable', async () => {
    const h = await harness()
    h.evaluate.mockResolvedValue({ status: 'unavailable', reason: 'provider' } as DecisionEvaluation)
    const outcome = await (await h.post('Fix')).choose()
    expect(h.agentsOf(outcome)).toEqual([HOOK, HOOK_B, HOOK_C])
    if (outcome.accepted)
      expect(outcome.targets[0]!.selection).toMatchObject({ reason: 'unavailable', unavailableReason: 'provider' })
    await h.store.close()
  })

  it('judges a mentioned event like any other, so the Decision target wins over the mention', async () => {
    const h = await harness()
    const outcome = await (await h.post('@agent-a look')).choose()
    expect(h.agentsOf(outcome)).toEqual([HOOK_B, HOOK_C])
    if (outcome.accepted) expect(outcome.targets[0]!.selection.reason).toBe('decision')
    expect(h.evaluate).toHaveBeenCalledTimes(1)
    await h.store.close()
  })

  it('judges every event of a thread again, so a later update can go elsewhere', async () => {
    const h = await harness()
    expect(h.agentsOf(await (await h.post('first')).choose())).toEqual([HOOK_B, HOOK_C])
    h.evaluate.mockResolvedValueOnce(NO_MATCH)
    const later = await (await h.post('second')).choose()
    expect(h.agentsOf(later)).toEqual([HOOK, HOOK_B, HOOK_C])
    if (later.accepted) expect(later.targets[0]!.selection.reason).toBe('otherwise')
    expect(h.evaluate).toHaveBeenCalledTimes(2)
    await h.store.close()
  })

  it('returns the stored choice to a redelivered host copy without evaluating again', async () => {
    const h = await harness()
    const event = await h.post('Fix')
    const first = await event.choose()
    h.evaluate.mockResolvedValue(NO_MATCH)
    expect(await event.choose()).toEqual(first)
    expect(h.evaluate).toHaveBeenCalledTimes(1)
    await h.store.close()
  })

  it('coalesces concurrent copies of one event onto one evaluation', async () => {
    const h = await harness()
    const event = await h.post('Fix')
    const [a, b] = await Promise.all([event.choose(), event.choose()])
    expect(a).toEqual(b)
    expect(h.evaluate).toHaveBeenCalledTimes(1)
    await h.store.close()
  })
})

describe('hook route evidence', () => {
  it('says why this agent was chosen and that others may have been too', () => {
    const text = hookRouteEvidenceText({
      routingId: ROUTING,
      decisionId: DECISION,
      reason: 'decision',
      verdictSeq: 3,
      question,
      answer: MATCH_BOTH.status === 'answered' ? MATCH_BOTH.answer : undefined,
      model: 'jev-1.13.0'
    })
    expect(text).toContain("a routing rule matched the Decision's answer and named you")
    expect(text).toContain('Question: What kind of issue?')
    expect(text).toContain('Other agents watching this repository may also have been selected')
  })
})

describe('code-host decision state', () => {
  const build = (msg: RdMsgHook, history: ChannelTextRow[], full = false) =>
    buildCodeHostHookState({ msg, current: row('Still broken?'), history, full, question, model: 'jev-1.13.0' })

  it('keeps the chat field names beside the subject, history oldest first', () => {
    const older = row('first comment', '42', 'alice')
    const newer = row('second comment', '42', 'bob')
    const built = build(fire(), [newer, older])
    if (built.unsupported) throw new Error('unsupported')
    expect(built.state).toMatchObject({
      source: 'github',
      event: { name: 'issue_comment', action: 'created' },
      repository: { fullName: 'example-org/example-repo' },
      subject: {
        kind: 'issue',
        number: 42,
        title: 'Crash on start',
        url: 'https://github.example.test/example-org/example-repo/issues/42',
        author: { login: 'reporter', type: 'User', association: 'FIRST_TIME_CONTRIBUTOR' },
        labels: ['bug'],
        state: 'open',
        body: 'It crashes.'
      },
      currentMessage: { sender: { id: 'someone', association: 'NONE' }, text: 'Still broken?' },
      history: [{ text: 'first comment' }, { text: 'second comment' }],
      context: { partial: false, reasons: [], omittedMessages: 0 }
    })
  })

  it('drops the oldest history first, then halves the subject body, and never cuts the current message', () => {
    const big = 'x'.repeat(12_000)
    const history = [row(`new ${big}`), row(`mid ${big}`), row(`old ${big}`)]
    const trimmed = build(fire(), history, true)
    if (trimmed.unsupported) throw new Error('unsupported')
    const kept = (trimmed.state.history as { text: string }[]).map((h) => h.text.slice(0, 3))
    expect(kept).toEqual(['mid', 'new'])
    expect(trimmed.reasons).toEqual(['history_limit', 'budget_trimmed'])
    const longBody = fire({
      context: { ...fire().context!, subject: { ...fire().context!.subject!, body: 'b'.repeat(40_000) } }
    })
    const halved = build(longBody, [])
    if (halved.unsupported) throw new Error('unsupported')
    const body = (halved.state.subject as { body?: string }).body ?? ''
    expect(body.length).toBeLessThan(40_000)
    expect(halved.reasons).toContain('subject_body_trimmed')
    expect((halved.state.currentMessage as { text: string }).text).toBe('Still broken?')
    const hugeCurrent = buildCodeHostHookState({
      msg: fire(),
      current: row('c'.repeat(40_000)),
      history: [],
      full: false,
      question,
      model: 'jev-1.13.0'
    })
    expect(hugeCurrent).toEqual({ unsupported: true })
  })
})

// §5.1: one builder for every provider; each normalizer supplies the subject's kind, number, draft flag and repository path.
const gitlabFire = (target: NonNullable<RdMsgHook['gitlab']>['target']): RdMsgHook =>
  fire({
    sessionKey: `gitlab:4455667:${target.kind}:${'iid' in target ? target.iid : 0}`,
    event: 'note:created',
    github: undefined,
    gitlab: { projectId: '4455667', projectPath: 'example-group/example-project', target },
    context: {
      source: 'gitlab',
      event: 'note',
      action: 'created',
      repo: 'example-group/stale-path',
      title: 'Fix the primary',
      labels: [],
      subject: { authorLogin: 'reporter', state: 'opened', body: 'Fixes it.' }
    }
  })
const giteaFire = (target: NonNullable<RdMsgHook['gitea']>['target']): RdMsgHook =>
  fire({
    sessionKey: `gitea:556677:${target.kind}:${'index' in target ? target.index : 0}`,
    event: 'note:created',
    github: undefined,
    gitea: { repoId: '556677', repoPath: 'example-org/example-repo', target },
    context: {
      source: 'gitea',
      event: 'note',
      action: 'created',
      repo: 'example-org/example-repo',
      title: 'Crash on start',
      labels: ['bug'],
      subject: { authorLogin: 'reporter', state: 'open', body: 'It crashes.' }
    }
  })

describe('code-host decision state across providers', () => {
  const build = (msg: RdMsgHook) =>
    buildCodeHostHookState({
      msg,
      current: row('Still broken?'),
      history: [],
      full: false,
      question,
      model: 'jev-1.13.0'
    })
  const stateOf = (msg: RdMsgHook) => {
    const built = build(msg)
    if (built.unsupported) throw new Error('unsupported')
    return built.state as { source: string; repository: unknown; subject: Record<string, unknown> }
  }

  it('reads a GitLab merge request and issue from the trusted target, not the envelope path', () => {
    const mr = stateOf(gitlabFire({ kind: 'merge_request', iid: 77, isDraft: true }))
    expect(mr.source).toBe('gitlab')
    expect(mr.repository).toEqual({ fullName: 'example-group/example-project' })
    expect(mr.subject).toMatchObject({ kind: 'merge_request', number: 77, draft: true, title: 'Fix the primary' })
    const issue = stateOf(gitlabFire({ kind: 'issue', iid: 5 }))
    expect(issue.subject).toMatchObject({ kind: 'issue', number: 5 })
    expect(issue.subject).not.toHaveProperty('draft')
  })

  it('reads a Gitea pull request and issue from the trusted target', () => {
    const pull = stateOf(giteaFire({ kind: 'pull', index: 12, isDraft: false }))
    expect(pull.source).toBe('gitea')
    expect(pull.repository).toEqual({ fullName: 'example-org/example-repo' })
    expect(pull.subject).toMatchObject({ kind: 'pull_request', number: 12, draft: false, labels: ['bug'] })
    expect(stateOf(giteaFire({ kind: 'issue', index: 3 })).subject).toMatchObject({ kind: 'issue', number: 3 })
  })

  it('keeps the GitHub subject: the envelope number and draft first, the trusted repository first', () => {
    const pr = fire({
      github: {
        repoId: '123',
        repoFullName: 'example-org/example-repo',
        sourceInstallationId: '456',
        subjectKind: 'pull_request',
        pullNumber: 42,
        isDraft: true
      },
      context: { ...fire().context!, repo: 'example-org/renamed', subject: { draft: false } }
    })
    const state = stateOf(pr)
    expect(state.source).toBe('github')
    expect(state.repository).toEqual({ fullName: 'example-org/example-repo' })
    expect(state.subject).toMatchObject({ kind: 'pull_request', number: 42, draft: false })
  })

  it('refuses a delivery of no code host', () => {
    expect(build(fire({ github: undefined, context: { source: 'webhook', body: '{}' } }))).toEqual({
      unsupported: true
    })
  })
})

describe('hook router for GitLab and Gitea routings', () => {
  it.each([
    {
      provider: 'gitlab' as const,
      family: 'merge_request' as const,
      msg: () => gitlabFire({ kind: 'merge_request', iid: 7 })
    },
    { provider: 'gitea' as const, family: 'issues' as const, msg: () => giteaFire({ kind: 'issue', index: 7 }) }
  ])('chooses for a $provider routing and records the host verdict', async ({ provider, family, msg }) => {
    const store = await openTestStore()
    const evaluate = vi.fn<(input: DecisionEvaluationInput) => Promise<DecisionEvaluation>>(async () => MATCH_BOTH)
    const p = { ...projection(), provider, family }
    const router = new HookRouter({
      store: () => store,
      evaluate: (input) => evaluate(input),
      now: () => Date.now(),
      ownerFence: () => 'local:test',
      currentProjection: () => p,
      log: { warn: () => {} }
    })
    const channel = HOOK
    const thread = `${provider}:x:7`
    await store.appendTranscript({
      channel,
      thread,
      ts: '1|a',
      sender: 'reporter',
      kind: 'text',
      text: 'Fix',
      orgAgentId: AGENT
    })
    const record = (await store.channelRecordRef(channel, '1|a', AGENT))!
    const outcome = await router.choose(
      { ...msg(), routing: { routingId: ROUTING, decisionId: DECISION, candidates: ALL } },
      record,
      p
    )
    expect(outcome.accepted && outcome.targets.map((t) => t.hookId)).toEqual([HOOK_B, HOOK_C])
    expect(evaluate.mock.calls[0]![0].state).toMatchObject({ source: provider, currentMessage: { text: 'Fix' } })
    const verdict = await store.getDecisionVerdict(record.seq, hookRouterSubject(ROUTING))
    expect(verdict).toMatchObject({ state: 'admitted', integrationId: ROUTING, channel })
    expect(JSON.parse(verdict!.configJson)).toMatchObject({ family })
    await store.close()
  })
})

describe('hook routing evaluation lane', () => {
  const reserve = async (s: LocalStore, ts: string, channel: string, routingId: string) => {
    await s.appendTranscript({ channel, thread: '42', ts, sender: 'u', kind: 'text', text: ts, orgAgentId: AGENT })
    const ref = (await s.channelRecordRef(channel, ts, AGENT))!
    await s.reserveDecisionVerdict({
      seq: ref.seq,
      subject: hookRouterSubject(routingId),
      orgId: ref.orgId,
      channel,
      agentId: AGENT,
      integrationId: routingId,
      decisionId: DECISION,
      configJson: '{}',
      deliveryJson: null,
      requestedModel: 'jev-1.13.0',
      deadlineAt: 1,
      ownerFence: 'f',
      createdAt: 1
    })
    await s.settleDecisionVerdict(ref.seq, hookRouterSubject(routingId), 'f', {
      disposition: 'match',
      answerJson: JSON.stringify({ routeReason: 'otherwise', matchedKeys: [] }),
      targetsJson: '[]',
      settledAt: 2
    })
    return ref.seq
  }
  const OTHER_ROUTING = '66666666-6666-4666-8666-666666666666'

  it('scopes rows to one hosted routing across threads and refuses a routing the agent does not host', async () => {
    const s = await openTestStore()
    const a = await reserve(s, '1|a', CHANNEL, ROUTING)
    const b = await reserve(s, '2|a', CHANNEL, ROUTING)
    await reserve(s, '3|a', CHANNEL, OTHER_ROUTING)
    const reader = new DecisionEvaluationReader({
      store: () => s,
      servedIntegration: async () => undefined,
      servedHookRouting: async (orgId, agentId, routingId) =>
        orgId === ORG && agentId === AGENT && routingId === ROUTING
    })
    const lane = { agentId: AGENT, integrationId: ROUTING, channel: ROUTING, source: 'hook_routing' as const }
    const page = await reader.list(ORG, { ...lane, limit: 10 })
    expect(DecisionEvaluationsReply.parse(page)).toEqual(page)
    expect(page.items.map((item) => item.seq)).toEqual([b, a])
    expect(page.items[0]).toMatchObject({ reason: 'otherwise', outcome: 'pending' })
    expect(page.conversation).toEqual({ platform: 'hook', tenantScope: null })
    expect((await reader.get(ORG, { ...lane, seq: a })).evaluation?.seq).toBe(a)
    await expect(reader.list(ORG, { ...lane, integrationId: OTHER_ROUTING, limit: 10 })).rejects.toBeInstanceOf(
      DecisionEvaluationScopeError
    )
    await expect(reader.list('org-2', { ...lane, limit: 10 })).rejects.toBeInstanceOf(DecisionEvaluationScopeError)
    // Without `source` the lane is a chat install's, which this reader does not serve.
    await expect(
      reader.list(ORG, { agentId: AGENT, integrationId: ROUTING, channel: ROUTING, limit: 10 })
    ).rejects.toBeInstanceOf(DecisionEvaluationScopeError)
    await s.close()
  })

  it('matches an answer against rules edited while the provider call was pending', async () => {
    const h = await harness()
    const event = await h.post('Please fix this')
    h.evaluate.mockImplementationOnce(async () => {
      h.live.current = projection({ rules: [], otherwise: { type: 'skip' } })
      return MATCH_BOTH
    })
    expect(h.agentsOf(await event.choose())).toEqual([])
  })

  it('cancels and fires nothing when the Decision changed or the routing stopped mid-call', async () => {
    const h = await harness()
    const first = await h.post('Please fix this')
    h.evaluate.mockImplementationOnce(async () => {
      h.live.current = null
      return MATCH_BOTH
    })
    expect(h.agentsOf(await first.choose())).toBe('config_changed')
    expect((await h.store.getDecisionVerdict(first.record.seq, 'hook-router:' + ROUTING))?.state).toBe('canceled')
    const second = await h.post('Another one', ALL, '43')
    h.evaluate.mockImplementationOnce(async () => {
      const next = projection()
      h.live.current = { ...next, definition: { ...next.definition, model: 'jev-latest' } }
      return MATCH_BOTH
    })
    expect(h.agentsOf(await second.choose())).toBe('config_changed')
  })
})
