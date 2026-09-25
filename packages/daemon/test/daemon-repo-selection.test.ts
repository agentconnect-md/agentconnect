import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REPO_CANDIDATES_V1_FEATURE,
  REPO_SELECTOR_V1_FEATURE,
  type DecisionEvaluation,
  type RepoCandidatesReply
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { EvaluationEventCollector } from '../src/evaluation/index.js'
import type { DecisionEvaluator } from '../src/decisions/evaluator.js'
import { REPO_CANDIDATES_CACHE_MS } from '../src/decisions/repo-selection.js'
import { fakeCpClient } from './webchat-continuation-fixture.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { FakeClock } from './cp/fake-clock.js'

/**
 * multi-repository-workspaces.md decisions 15–19 at the daemon boundary: a new session's `decision`
 * repositories are chosen once, before its host starts, from the spec's rows and the CP's roster,
 * pinned on its row, and never re-chosen; a missing precondition fails the start visibly (decision 18).
 * Which roots preparation then checks out is the workspace manager's, proven in its own suites.
 */

const agentId = 'example-agent'
const roots: string[] = []
const daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ROWS = [
  { repoFullName: 'acme/infra', repoId: '42', materialize: 'decision' },
  { repoFullName: 'example-co/shared-library', repoId: '815', materialize: 'decision' }
]
const ROSTER: RepoCandidatesReply = {
  candidates: [{ provider: 'github', repoFullName: 'example-co/tools', repoId: '900', description: 'Build tooling' }],
  partial: false
}
const INFRA = { provider: 'github', repoFullName: 'acme/infra', repoId: '42' }
const TOOLS = { provider: 'github', repoFullName: 'example-co/tools', repoId: '900' }

function scaffold(workspace: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-repo-selection-'))
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
      workspace: {
        mode: 'from-scratch',
        path: join(dir, 'workspace'),
        additionalRepos: ROWS,
        additionalInstallations: [{ accountLogin: 'example-co', access: 'read', materialize: 'decision' }],
        ...workspace
      },
      integrations: [],
      memory: { provider: 'none' },
      repositorySelector: { providerId: 'typesafe', model: 'jev-latest' }
    })
  )
  return root
}

/** A Choice answer over one chunk's keys: `hits` beat `none`, everything else scores nothing. */
function choice(keys: string[], hits: Record<string, number>): DecisionEvaluation {
  const probabilities: Record<string, number> = {}
  for (const key of keys) probabilities[key] = hits[key] ?? 0
  const spent = Object.values(hits).reduce((sum, p) => sum + p, 0)
  probabilities.none = Math.max(0, 1 - spent)
  const value = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]
  return {
    status: 'answered',
    model: 'jev-latest',
    usage: { inputTokens: 1, outputTokens: 1 },
    answer: { type: 'choice', value, probabilities, confidence: 0.9 }
  }
}

async function start(root: string) {
  const clock = new FakeClock()
  const timeline: string[] = []
  const daemon = new Daemon({
    root,
    clock,
    slackAppFactory: fakeSlackAppFactory(),
    evaluation: { observer: new EvaluationEventCollector(), runId: 'repo-selection' },
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
  const repoCandidates = vi.fn(async () => ROSTER)
  internal.cpClient = {
    ...fakeCpClient(),
    emitEventSession: vi.fn(),
    emitIntegrationChannels: vi.fn(),
    supportsServerFeature: (feature: string) => feature === REPO_CANDIDATES_V1_FEATURE,
    repoCandidates
  }
  // No remote to clone from here: a root that cannot be prepared is omitted, which is the workspace manager's own rule.
  vi.spyOn(internal.workspaces, 'prepareSecondaryRoot').mockResolvedValue(undefined)
  const evaluate = vi
    .spyOn(internal.decisionEvaluator as DecisionEvaluator, 'evaluate')
    .mockImplementation(async (input) => {
      timeline.push('evaluate')
      return choice(Object.keys(input.decision.question.criteria), { r1: 0.5, r3: 0.3 })
    })
  const select = vi.spyOn(internal.workspaces, 'setSessionSelection')
  const turn = async (conversationId: string, text = 'Please update the infrastructure tooling') => {
    const result = await daemon.runEvaluationTurn({ agentId, conversationId, text })
    await daemon.waitForEvaluationIdle()
    return result
  }
  /** A cold start's `openSession` inputs, for the stage under test alone. */
  const run = (key: string, plan: Record<string, unknown> = {}) => ({
    key,
    plan,
    entry: {
      agentId,
      initAbort: new AbortController(),
      msg: { source: 'agent', text: 'Please update the infrastructure tooling' }
    }
  })
  return { daemon, internal, clock, evaluate, repoCandidates, select, timeline, turn, run }
}

describe('a new session selects its repositories once, before its host starts (decisions 15, 16, 19)', () => {
  it('asks one Choice question over the rows and the roster, pins the hits on the row, and never asks again', async () => {
    const { internal, evaluate, repoCandidates, timeline, turn } = await start(scaffold())
    expect(internal.registrationFeatures()).toContain(REPO_SELECTOR_V1_FEATURE)

    expect(await turn('first')).toMatchObject({ sessionId: 'acp-1', output: 'Done' })

    expect(evaluate).toHaveBeenCalledOnce()
    const input = evaluate.mock.calls[0]![0]
    expect(input.decision).toMatchObject({ providerId: 'typesafe', model: 'jev-latest' })
    expect(input.decision.question).toMatchObject({
      type: 'choice',
      criteria: { r1: 'acme/infra', r2: 'example-co/shared-library', r3: 'example-co/tools: Build tooling' }
    })
    expect(Object.keys(input.decision.question.criteria)).toEqual(['r1', 'r2', 'r3', 'none'])
    expect(input.state).toMatchObject({
      source: 'chat',
      currentMessage: { text: 'Please update the infrastructure tooling' },
      workspace: {}
    })
    expect(input.evaluationId).toMatch(/:0$/)
    // Selected before the runtime existed, so its directories could be the selected ones.
    expect(timeline).toEqual(['evaluate', 'host.start', 'session/new'])
    const [row] = await internal.store.listSessions(agentId)
    expect(JSON.parse(row.selectedRepos)).toEqual([INFRA, TOOLS])

    expect(await turn('first', 'And now the shared library')).toMatchObject({ output: 'Done' })
    expect(evaluate).toHaveBeenCalledOnce()
    // Another conversation is another selection, from the roster already read.
    expect(await turn('second')).toMatchObject({ output: 'Done' })
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(repoCandidates).toHaveBeenCalledOnce()
  })

  it('reuses a session’s snapshot without evaluating, and selects nothing for a session whose runtime session exists', async () => {
    const { internal, evaluate, select, run } = await start(scaffold())
    const saved = [INFRA]

    await internal.selectSessionRepositories(run('resumed'), { selectedRepos: JSON.stringify(saved) })
    expect(evaluate).not.toHaveBeenCalled()
    expect(select).toHaveBeenCalledWith('resumed', saved)
    expect(internal.sessionRepoSelections.has('resumed')).toBe(false)

    await internal.selectSessionRepositories(run('older'), { acpSessionId: 'acp-older' })
    expect(evaluate).not.toHaveBeenCalled()
    expect(select).toHaveBeenLastCalledWith('older', [])
    expect(internal.sessionRepoSelections.get('older')).toEqual([])

    await internal.selectSessionRepositories(run('seed', { initializeOnly: true }), undefined)
    expect(evaluate).not.toHaveBeenCalled()
    expect(internal.sessionRepoSelections.get('seed')).toEqual([])
  })

  it('does nothing for an agent with no authorization marked by decision', async () => {
    const { internal, evaluate, repoCandidates, select, run } = await start(
      scaffold({
        additionalRepos: [{ repoFullName: 'acme/infra', repoId: '42', materialize: 'on-demand' }],
        additionalInstallations: [{ accountLogin: 'example-co', access: 'read', materialize: 'on-demand' }]
      })
    )
    expect(internal.agents.get(agentId).workspace.additionalRepos).toHaveLength(1)
    internal.sessionRepoSelections.set('plain', [INFRA])
    await internal.selectSessionRepositories(run('plain'), undefined)
    expect(evaluate).not.toHaveBeenCalled()
    expect(repoCandidates).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(internal.sessionRepoSelections.has('plain')).toBe(false)
  })

  it('restores a pinned selection after its last by-decision authorization became on demand', async () => {
    // Decision 19: a restart must hand the resumed session the roots it was pinned to, whatever the rows say now.
    const { internal, evaluate, repoCandidates, select, run } = await start(
      scaffold({
        additionalRepos: [{ repoFullName: 'acme/infra', repoId: '42', materialize: 'on-demand' }],
        additionalInstallations: [{ accountLogin: 'example-co', access: 'read', materialize: 'on-demand' }]
      })
    )
    await internal.selectSessionRepositories(run('resumed-after-change'), { selectedRepos: JSON.stringify([INFRA]) })
    expect(select).toHaveBeenCalledWith('resumed-after-change', [INFRA])
    expect(evaluate).not.toHaveBeenCalled()
    expect(repoCandidates).not.toHaveBeenCalled()
  })

  it('keeps a roster for the cache’s TTL and drops it when the agent’s authorizations change', async () => {
    const { internal, clock, repoCandidates, run } = await start(scaffold())
    await internal.selectSessionRepositories(run('a'), undefined)
    await internal.selectSessionRepositories(run('b'), undefined)
    expect(repoCandidates).toHaveBeenCalledOnce()

    internal.agents.get(agentId).workspace.additionalInstallations.push({
      provider: 'github',
      accountLogin: 'acme',
      access: 'read',
      materialize: 'decision'
    })
    await internal.selectSessionRepositories(run('c'), undefined)
    expect(repoCandidates).toHaveBeenCalledTimes(2)

    clock.advance(REPO_CANDIDATES_CACHE_MS - 1)
    await internal.selectSessionRepositories(run('d'), undefined)
    expect(repoCandidates).toHaveBeenCalledTimes(2)
    clock.advance(1)
    await internal.selectSessionRepositories(run('e'), undefined)
    expect(repoCandidates).toHaveBeenCalledTimes(3)
  })
})

describe('no fallback (decision 18)', () => {
  it.each([
    [
      'the agent has no repository selector',
      (internal: any) => {
        internal.agents.get(agentId).repositorySelector = undefined
      },
      /no repository selector/
    ],
    [
      'the selector names an evaluator that cannot answer a Choice question',
      (internal: any) => {
        internal.agents.get(agentId).repositorySelector = { providerId: 'typesafe', model: 'example-model' }
      },
      /does not answer Choice questions/
    ],
    [
      'the control plane does not answer repository candidates while a grant is marked by decision',
      (internal: any) => {
        internal.cpClient.supportsServerFeature = () => false
      },
      /does not answer repository candidates/
    ],
    [
      'a chunk’s evaluation is unavailable',
      (internal: any) => {
        internal.decisionEvaluator.evaluate.mockResolvedValue({ status: 'unavailable', reason: 'credentials' })
      },
      /unavailable \(credentials\)/
    ]
  ])('fails the start when %s', async (_cause, arrange, message) => {
    const { internal, select, run } = await start(scaffold())
    arrange(internal)
    await expect(internal.selectSessionRepositories(run('failing'), undefined)).rejects.toThrow(message)
    // Never a silent downgrade to on demand: nothing was primed for the session.
    expect(select).not.toHaveBeenCalled()
    expect(internal.sessionRepoSelections.has('failing')).toBe(false)
  })

  it('surfaces the failure through the ordinary startup-failure path, with no host started', async () => {
    const { internal, timeline, turn } = await start(scaffold())
    internal.agents.get(agentId).repositorySelector = undefined
    const surfaced = vi.spyOn(internal, 'surfaceTurnFailure')
    await expect(turn('failing')).rejects.toThrow(/no repository selector/)
    // The same notice a runtime that cannot start gets, and nothing of the session was made.
    expect(surfaced).toHaveBeenCalledOnce()
    expect((surfaced.mock.calls[0]![0] as Error).message).toMatch(/no repository selector/)
    expect(timeline).toEqual([])
    expect(await internal.store.listSessions(agentId)).toEqual([])
  })
})
