import { describe, expect, it } from 'vitest'
import type { DecisionBundleDefinition, SharedBotDecisionRouting } from '@agentconnect.md/protocol'
import {
  chooseEvaluationAgent,
  hookRoutingProjection,
  hookRoutingStatus,
  routingMembers,
  routingScopeOf,
  type HostCandidate
} from './hook-routing.js'
import { codeHostProviders } from '../codehost/registry.js'
import { AgentId, HookId, OrgId } from '../domain/ids.js'
import type { CodeHostDecisionRoutingRecord, HookRecord } from '../persistence/ports.js'
import { encodeAgentSpecForPeer } from '../domain/daemon-features.js'

const ORG = OrgId('org-example')
const DECISION = '44444444-4444-4444-8444-444444444444'
const ROUTING = '55555555-5555-4555-8555-555555555555'
const A = AgentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const B = AgentId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const definition: DecisionBundleDefinition = {
  id: DECISION,
  orgId: ORG,
  name: 'Kind',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  question: { type: 'boolean', instructions: 'Is this a bug?', criteria: { true: 'Yes', false: 'No' } }
}
const config: SharedBotDecisionRouting = {
  enabled: true,
  decisionId: DECISION,
  rules: [{ id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: A } }],
  otherwise: { type: 'default_agent' }
}
const record = (over: Partial<CodeHostDecisionRoutingRecord> = {}): CodeHostDecisionRoutingRecord => ({
  id: ROUTING,
  orgId: ORG,
  provider: 'github',
  repoId: 42n,
  repoFullName: 'example-org/example-repo',
  family: 'issues',
  enabled: true,
  decisionId: DECISION,
  config,
  needsReview: false,
  evaluationAgentId: A,
  definition,
  updatedAt: new Date(0),
  ...over
})
type Member = Pick<HookRecord, 'id' | 'agentId' | 'kind' | 'enabled' | 'repoId' | 'family'>
const hook = (id: string, agentId: AgentId, over: Partial<Member> = {}): Member => ({
  id: HookId(id),
  agentId,
  kind: 'github',
  enabled: true,
  repoId: 42n,
  family: 'issues',
  ...over
})

describe('routingMembers', () => {
  it('keeps the enabled github hooks of the scope, sorted by hook id', () => {
    const members = routingMembers(
      [
        hook('h3', B),
        hook('h1', A),
        hook('h2', A, { enabled: false }),
        hook('h4', A, { family: 'pull_request' }),
        hook('h5', A, { repoId: 7n }),
        hook('h6', A, { kind: 'gitlab' })
      ],
      { provider: 'github', repoId: 42n, family: 'issues' }
    )
    expect(members.map((m) => m.id)).toEqual(['h1', 'h3'])
  })

  it('keeps only the scope provider’s hooks, so a GitLab project and a GitHub repository with one id stay apart', () => {
    const hooks = [
      hook('h1', A, { kind: 'gitlab', family: 'merge_request' }),
      hook('h2', B, { kind: 'gitea', family: 'merge_request' }),
      hook('h3', B, { kind: 'github', family: 'merge_request' })
    ]
    expect(
      routingMembers(hooks, { provider: 'gitlab', repoId: 42n, family: 'merge_request' }).map((m) => m.id)
    ).toEqual(['h1'])
    expect(routingMembers(hooks, { provider: 'gitea', repoId: 42n, family: 'merge_request' }).map((m) => m.id)).toEqual(
      ['h2']
    )
  })
})

describe('routingScopeOf', () => {
  const row = (over: Partial<HookRecord>) =>
    ({ orgId: ORG, kind: 'github', repoId: 42n, family: 'issues', ...over }) as HookRecord
  it('names each provider’s routable families and nothing else', () => {
    expect(routingScopeOf(row({}))).toEqual({ orgId: ORG, provider: 'github', repoId: 42n, family: 'issues' })
    expect(routingScopeOf(row({ kind: 'gitlab', family: 'merge_request' }))?.provider).toBe('gitlab')
    expect(routingScopeOf(row({ kind: 'gitea', family: 'merge_request' }))?.provider).toBe('gitea')
    expect(routingScopeOf(row({ kind: 'github', family: 'merge_request' }))).toBeNull()
    expect(routingScopeOf(row({ kind: 'gitlab', family: 'pull_request' }))).toBeNull()
    expect(routingScopeOf(row({ kind: 'gitlab', family: 'push' }))).toBeNull()
    expect(routingScopeOf(row({ kind: 'webhook', repoId: null, family: null }))).toBeNull()
  })
})

describe('the providers’ Any update cadence (code-host-decisions.md §4)', () => {
  it('compiles in each provider’s stored vocabulary', () => {
    expect(codeHostProviders.github.routing.anyUpdateCadence('pull_request')).toEqual({
      events: ['pull_request:*', 'issue_comment:created'],
      commentFamilies: ['pull_request'],
      mentionOnly: false
    })
    expect(codeHostProviders.gitlab.routing.anyUpdateCadence('merge_request')).toEqual({
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      mentionOnly: false
    })
    expect(codeHostProviders.gitea.routing.anyUpdateCadence('issues')).toEqual({
      events: ['issues:*'],
      commentFamilies: ['issues'],
      mentionOnly: false
    })
  })

  it('needs the v2 routing feature for GitLab and Gitea only', () => {
    expect(codeHostProviders.github.routing.requiredFeatures).toEqual(['hook-decision-routing-v1'])
    expect(codeHostProviders.gitlab.routing.requiredFeatures).toEqual([
      'hook-decision-routing-v1',
      'hook-decision-routing-v2'
    ])
    expect(codeHostProviders.gitea.routing.requiredFeatures).toEqual(codeHostProviders.gitlab.routing.requiredFeatures)
  })
})

describe('hookRoutingStatus', () => {
  const members = new Set<string>([A, B])
  it('holds invalid child targets and omits chains from a legacy host without dropping its single-step routes', () => {
    const chained: SharedBotDecisionRouting = {
      ...config,
      rules: [{ ...config.rules[0]!, action: { type: 'decision', nextStepId: 'child' } }],
      steps: [{ id: 'child', decisionId: DECISION, rules: [{ ...config.rules[0]!, id: 'child-rule' }] }]
    }
    expect(hookRoutingStatus(record({ config: chained }), new Set([B]))).toBe('needs_review')
    const single = hookRoutingProjection(record(), [])!
    const chain = hookRoutingProjection(record({ config: chained }), [{ id: HookId('h1'), agentId: A }])!
    const spec = { hookRoutings: [single, chain] }
    expect(encodeAgentSpecForPeer(spec, ['hook-decision-routing-v1']).hookRoutings).toEqual([single])
    expect(encodeAgentSpecForPeer(spec, ['hook-decision-routing-v1', 'decision-chain-v1']).hookRoutings).toEqual([
      single,
      chain
    ])
  })

  it('is enabled for a valid routing, needs_review for a flagged or invalid one, access_revoked without its Decision', () => {
    expect(hookRoutingStatus(record(), members)).toBe('enabled')
    expect(hookRoutingStatus(record({ needsReview: true }), members)).toBe('needs_review')
    expect(hookRoutingStatus(record({ config: null }), members)).toBe('needs_review')
    // A rule whose agent no longer watches the repository.
    expect(hookRoutingStatus(record(), new Set([B]))).toBe('needs_review')
    expect(hookRoutingStatus(record({ definition: null }), members)).toBe('access_revoked')
    expect(hookRoutingStatus(record({ definition: { ...definition, orgId: 'org-other' } }), members)).toBe(
      'access_revoked'
    )
  })
})

describe('hookRoutingProjection', () => {
  const members = [
    { id: HookId('h1'), agentId: A },
    { id: HookId('h2'), agentId: B }
  ]
  it('projects the scope with its members', () => {
    expect(hookRoutingProjection(record(), members)).toEqual({
      routingId: ROUTING,
      provider: 'github',
      repoId: '42',
      repoFullName: 'example-org/example-repo',
      family: 'issues',
      config,
      definition,
      members: [
        { agentId: A, hookId: 'h1' },
        { agentId: B, hookId: 'h2' }
      ]
    })
  })

  it('projects a GitLab scope under its own provider', () => {
    expect(
      hookRoutingProjection(
        record({ provider: 'gitlab', family: 'merge_request', repoFullName: 'example-group/example-project' }),
        members
      )
    ).toMatchObject({ provider: 'gitlab', family: 'merge_request', repoFullName: 'example-group/example-project' })
  })

  it('ships a scope needing review disabled, and nothing while paused or unresolvable', () => {
    expect(hookRoutingProjection(record({ needsReview: true }), members)?.config.enabled).toBe(false)
    expect(hookRoutingProjection(record({ enabled: false }), members)).toBeNull()
    expect(hookRoutingProjection(record({ definition: null }), members)).toBeNull()
    expect(hookRoutingProjection(record({ config: null }), members)).toBeNull()
  })
})

describe('chooseEvaluationAgent', () => {
  const FEATURE = ['hook-decision-routing-v1']
  const c = (agentId: string, over: Partial<HostCandidate> = {}): HostCandidate => ({
    agentId,
    agentCreatedAt: 0,
    daemonId: `daemon-${agentId}`,
    daemonCreatedAt: 0,
    features: FEATURE,
    ...over
  })

  it('picks the member on the earliest-created supporting daemon, then the earliest agent', () => {
    expect(chooseEvaluationAgent(null, [c('b', { daemonCreatedAt: 2 }), c('a', { daemonCreatedAt: 1 })])).toBe('a')
    expect(chooseEvaluationAgent(null, [c('b', { agentCreatedAt: 1 }), c('a', { agentCreatedAt: 2 })])).toBe('b')
  })

  it('never picks an older daemon while a supporting one is placed', () => {
    expect(
      chooseEvaluationAgent(null, [c('a', { daemonCreatedAt: 1, features: [] }), c('b', { daemonCreatedAt: 2 })])
    ).toBe('b')
  })

  it('moves a chain to a host that understands child steps', () => {
    expect(
      chooseEvaluationAgent(
        'a',
        [c('a'), c('b', { features: [...FEATURE, 'decision-chain-v1'] })],
        [...FEATURE, 'decision-chain-v1']
      )
    ).toBe('b')
  })

  it('keeps a live supporting incumbent, and an offline one when nothing better is connected', () => {
    expect(chooseEvaluationAgent('b', [c('a', { daemonCreatedAt: 1 }), c('b', { daemonCreatedAt: 2 })])).toBe('b')
    expect(chooseEvaluationAgent('b', [c('a', { features: undefined }), c('b', { features: undefined })])).toBe('b')
    // An offline incumbent yields to a connected supporting member.
    expect(chooseEvaluationAgent('b', [c('a'), c('b', { features: undefined })])).toBe('a')
  })

  it('falls back to the earliest placed member, and to none when nobody is placed', () => {
    expect(
      chooseEvaluationAgent(null, [
        c('b', { features: [], daemonCreatedAt: 2 }),
        c('a', { features: [], daemonCreatedAt: 1 })
      ])
    ).toBe('a')
    expect(chooseEvaluationAgent('a', [c('a', { daemonId: null })])).toBeNull()
  })

  it('prefers a daemon advertising every feature the scope’s provider needs', () => {
    const V2 = ['hook-decision-routing-v1', 'hook-decision-routing-v2']
    const pick = (current: string | null, candidates: HostCandidate[]) => chooseEvaluationAgent(current, candidates, V2)
    expect(pick(null, [c('a', { daemonCreatedAt: 1 }), c('b', { daemonCreatedAt: 2, features: V2 })])).toBe('b')
    // A v1-only incumbent yields to a v2 member.
    expect(pick('a', [c('a', { daemonCreatedAt: 1 }), c('b', { daemonCreatedAt: 2, features: V2 })])).toBe('b')
  })
})
