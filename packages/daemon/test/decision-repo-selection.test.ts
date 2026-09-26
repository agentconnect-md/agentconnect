import { describe, expect, it } from 'vitest'
import { DecisionQuestion, REPO_CANDIDATES_MAX, type DecisionEvaluation } from '@agentconnect.md/protocol'
import { DECISION_REQUEST_MAX_BYTES, decisionRequestBody } from '../src/decisions/evaluator.js'
import { modelSelectionState } from '../src/decisions/model-selection.js'
import { fitCodeHostDecisionState } from '../src/codehost/decision-state.js'
import {
  evaluateChunks,
  evaluateWithCapacityWait,
  hasDecisionAuthorizations,
  hasDecisionGrants,
  parseSelectedRepositories,
  repoSelectionCandidates,
  repoSelectionChunks,
  repoSelectionConfiguration,
  repoSelectionState,
  sameSelection,
  selectRepositories,
  REPO_SELECTION_CHUNK,
  REPO_SELECTION_CONCURRENCY,
  REPO_SELECTION_MAX,
  type RepoSelectionCandidate
} from '../src/decisions/repo-selection.js'

const candidate = (n: number, over: Partial<RepoSelectionCandidate> = {}): RepoSelectionCandidate => ({
  provider: 'github',
  repoFullName: `example-co/repo-${n}`,
  repoId: String(1000 + n),
  ...over
})
const many = (count: number): RepoSelectionCandidate[] => Array.from({ length: count }, (_, i) => candidate(i + 1))

const answered = (probabilities: Record<string, number>): DecisionEvaluation => ({
  status: 'answered',
  model: 'jev-latest',
  usage: { inputTokens: 1, outputTokens: 1 },
  answer: {
    type: 'choice',
    value: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0],
    probabilities,
    confidence: 0.9
  }
})

describe('candidates (decision 15)', () => {
  const rows = [
    { repoFullName: 'acme/infra', repoId: '42', materialize: 'decision' },
    { repoFullName: 'acme/always', repoId: '43', materialize: 'always' },
    { repoFullName: 'acme/later', repoId: '44', materialize: 'on-demand' },
    { repoFullName: 'example-group/tools', repoId: '7', provider: 'gitlab', materialize: 'decision' }
  ]

  it('puts the `decision` rows first, then the roster, deduplicated by host and id', () => {
    const roster = {
      candidates: [
        { provider: 'github', repoFullName: 'example-co/shared-library', repoId: '815', description: ' Shared code ' },
        // The same repository under another host's numbering is a different repository.
        { provider: 'gitlab', repoFullName: 'example-group/mirror', repoId: '815' },
        // A row's own repository, however the CP named it, follows the row.
        { provider: 'github', repoFullName: 'acme/infra-renamed', repoId: '42' },
        { provider: 'example-host', repoFullName: 'acme/elsewhere', repoId: '1' }
      ],
      partial: false
    }
    expect(repoSelectionCandidates(rows, roster)).toEqual({
      candidates: [
        { provider: 'github', repoFullName: 'acme/infra', repoId: '42' },
        { provider: 'gitlab', repoFullName: 'example-group/tools', repoId: '7' },
        { provider: 'github', repoFullName: 'example-co/shared-library', repoId: '815', description: 'Shared code' },
        { provider: 'gitlab', repoFullName: 'example-group/mirror', repoId: '815' }
      ],
      partial: false
    })
  })

  it('carries the reply’s partial mark, and sets it itself when the cap cuts the roster', () => {
    expect(repoSelectionCandidates(rows, { candidates: [], partial: true })).toMatchObject({ partial: true })
    expect(repoSelectionCandidates(rows, undefined)).toMatchObject({ partial: false })
    const roster = {
      candidates: Array.from({ length: REPO_CANDIDATES_MAX }, (_, i) => ({
        provider: 'github',
        repoFullName: `example-co/roster-${i}`,
        repoId: String(5000 + i)
      })),
      partial: false
    }
    const { candidates, partial } = repoSelectionCandidates(rows, roster)
    expect(candidates).toHaveLength(REPO_CANDIDATES_MAX)
    expect(candidates.slice(0, 2).map((c) => c.repoFullName)).toEqual(['acme/infra', 'example-group/tools'])
    expect(partial).toBe(true)
  })

  it('knows which authorizations ask for the selector, and what a cached roster depends on', () => {
    const agent = {
      workspace: {
        additionalRepos: rows,
        additionalInstallations: [{ accountLogin: 'acme', materialize: 'on-demand' }]
      },
      repositorySelector: { providerId: 'typesafe', model: 'jev-latest' }
    }
    expect(hasDecisionAuthorizations(agent)).toBe(true)
    expect(hasDecisionGrants(agent)).toBe(false)
    expect(hasDecisionAuthorizations({ workspace: { additionalRepos: rows.slice(1, 3) } })).toBe(false)
    expect(
      hasDecisionGrants({ workspace: { additionalInstallations: [{ accountLogin: 'acme', materialize: 'decision' }] } })
    ).toBe(true)
    const before = repoSelectionConfiguration(agent)
    expect(repoSelectionConfiguration({ ...agent, repositorySelector: null })).not.toBe(before)
    expect(
      repoSelectionConfiguration({
        ...agent,
        workspace: { ...agent.workspace, additionalInstallations: [{ accountLogin: 'acme', materialize: 'decision' }] }
      })
    ).not.toBe(before)
    expect(repoSelectionConfiguration({ ...agent, workspace: { ...agent.workspace } })).toBe(before)
  })
})

describe('questions (decision 15)', () => {
  it('asks one Choice question per chunk of 31, keyed r1…r31 plus none, naming each repository with its description', () => {
    const candidates = [candidate(1, { description: 'Infrastructure' }), ...many(70).slice(1)]
    const chunks = repoSelectionChunks(candidates)
    expect(chunks.map((chunk) => chunk.candidates.length)).toEqual([REPO_SELECTION_CHUNK, REPO_SELECTION_CHUNK, 8])
    expect(Object.keys(chunks[0]!.question.criteria)).toEqual([
      ...Array.from({ length: REPO_SELECTION_CHUNK }, (_, i) => `r${i + 1}`),
      'none'
    ])
    expect(Object.keys(chunks[2]!.question.criteria)).toHaveLength(9)
    expect(chunks[0]!.question).toMatchObject({
      type: 'choice',
      criteria: { r1: 'example-co/repo-1: Infrastructure', r2: 'example-co/repo-2' }
    })
    expect((chunks[1]!.question.criteria as Record<string, string>).r1).toBe('example-co/repo-32')
    for (const { question } of chunks) expect(DecisionQuestion.safeParse(question).success).toBe(true)
  })

  it('trims descriptions until the whole question fits the 16 KiB limit, keeping every name', () => {
    const candidates = Array.from({ length: REPO_SELECTION_CHUNK }, (_, i) =>
      candidate(i + 1, { repoFullName: `example-co/${'r'.repeat(240)}-${i}`, description: 'd'.repeat(350) })
    )
    const [chunk] = repoSelectionChunks(candidates)
    const bytes = new TextEncoder().encode(JSON.stringify(chunk!.question)).byteLength
    expect(bytes).toBeLessThanOrEqual(16 * 1024)
    expect(DecisionQuestion.safeParse(chunk!.question).success).toBe(true)
    const criteria = chunk!.question.criteria as Record<string, string>
    const texts = Object.values(criteria)
    candidates.forEach((c, i) => expect(texts[i]).toMatch(new RegExp(`^${c.repoFullName}`)))
    // Something of the descriptions survived: the trim halves rather than dropping them outright.
    expect(criteria.r1).toMatch(/: d+$/)
    expect(criteria.r1!.length).toBeLessThan(candidates[0]!.repoFullName.length + 2 + 350)
  })

  it('asks nothing for no candidates', () => {
    expect(repoSelectionChunks([])).toEqual([])
  })
})

describe('state (decision 16)', () => {
  const question = repoSelectionChunks(many(3))[0]!.question
  const decision = { model: 'jev-latest', question }

  it('keeps the code-host trim order when workspace context pushes a fitted state over budget', () => {
    const base = {
      source: 'github',
      currentMessage: { text: '' },
      history: [],
      pullRequest: { diff: 'd'.repeat(12_000), commitMessages: 'c'.repeat(4_000) },
      subject: { body: 's'.repeat(8_000) },
      context: { partial: false, reasons: [], omittedMessages: 0 }
    }
    base.currentMessage.text = 't'.repeat(31_999 - Buffer.byteLength(decisionRequestBody({ decision, state: base })))
    const state = repoSelectionState(
      base,
      { primary: 'example-org/primary-service', partial: false },
      decision,
      fitCodeHostDecisionState
    )!
    expect(Buffer.byteLength(decisionRequestBody({ decision, state }))).toBeLessThanOrEqual(32_000)
    expect(state).toMatchObject({
      currentMessage: base.currentMessage,
      subject: base.subject,
      pullRequest: { commitMessages: base.pullRequest.commitMessages },
      context: { partial: true, reasons: ['budget_trimmed', 'diff_truncated'], omittedMessages: 0 }
    })
    expect((state.pullRequest as { diff: string }).diff.length).toBeLessThan(base.pullRequest.diff.length)
    expect(base.pullRequest.diff).toHaveLength(12_000)
    expect(base.context.reasons).toEqual([])
  })

  it('keeps closing attribution when workspace context forces another subject-body reduction', () => {
    const base = {
      source: 'github',
      currentMessage: { text: '' },
      history: [],
      subject: { body: `Summary\n${'界'.repeat(2600)}\nCreated by Example Agent` },
      context: { partial: false, reasons: [], omittedMessages: 0 }
    }
    base.currentMessage.text = 't'.repeat(31_999 - Buffer.byteLength(decisionRequestBody({ decision, state: base })))
    const state = repoSelectionState(
      base,
      { primary: 'example-org/primary-service', partial: false },
      decision,
      fitCodeHostDecisionState
    )!
    const body = (state.subject as { body: string }).body
    expect(Buffer.byteLength(decisionRequestBody({ decision, state }))).toBeLessThanOrEqual(32_000)
    expect(Buffer.byteLength(body)).toBeLessThan(Buffer.byteLength(base.subject.body))
    expect(body).toMatch(/^Summary\n/)
    expect(body).toMatch(/Created by Example Agent$/)
    expect(body).not.toContain('�')
    expect(state.context).toMatchObject({ partial: true, reasons: ['budget_trimmed', 'subject_body_trimmed'] })
    expect(state.currentMessage).toEqual(base.currentMessage)
    expect(base.subject.body).not.toContain('[... content omitted ...]')
  })

  it('adds the primary and the candidates’ partial mark to the model-selection state', () => {
    const base = { source: 'chat', currentMessage: { text: 'Fix the deploy' }, history: [], truncated: false }
    expect(repoSelectionState(base, { primary: 'acme/primary-service', partial: false }, decision)).toEqual({
      ...base,
      workspace: { primary: 'acme/primary-service' },
      context: { partial: false, reasons: [], omittedMessages: 0 }
    })
    const chat = { ...base, context: { partial: false, reasons: [], omittedMessages: 0 } }
    expect(repoSelectionState(chat, { partial: true }, decision)).toEqual({
      ...chat,
      workspace: {},
      context: { partial: true, reasons: ['candidates_truncated'], omittedMessages: 0 }
    })
    expect(repoSelectionState(base, { partial: true }, decision)).toMatchObject({
      context: { partial: true, reasons: ['candidates_truncated'] }
    })
  })

  it('trims history while preserving identity and reports input that cannot fit', () => {
    const opening = modelSelectionState('chat', 'Fix the deploy')
    const oversized = { ...opening, history: [{ text: 'x'.repeat(DECISION_REQUEST_MAX_BYTES) }] }
    const state = repoSelectionState(oversized, { primary: 'acme/primary-service', partial: false }, decision)
    expect(state).toEqual({
      ...opening,
      workspace: { primary: 'acme/primary-service' },
      context: { partial: true, reasons: ['budget_trimmed'], omittedMessages: 1 }
    })
    expect(Buffer.byteLength(decisionRequestBody({ decision, state: state! }))).toBeLessThanOrEqual(32_000)
    expect(
      repoSelectionState({ ...opening, currentMessage: { text: 'x'.repeat(32_000) } }, { partial: false }, decision)
    ).toBeUndefined()
  })
})

describe('selection (decision 17)', () => {
  it('takes every option that beats none within a chunk, ordered by probability across chunks, at most five', () => {
    const chunks = repoSelectionChunks(many(40))
    const first: Record<string, number> = { none: 0.1 }
    for (let i = 1; i <= REPO_SELECTION_CHUNK; i += 1) first[`r${i}`] = 0
    Object.assign(first, { r1: 0.3, r2: 0.05, r3: 0.2, r4: 0.15, r5: 0.11, r6: 0.09 })
    const second: Record<string, number> = {
      none: 0.2,
      r1: 0.5,
      r2: 0.25,
      r3: 0.05,
      r4: 0,
      r5: 0,
      r6: 0,
      r7: 0,
      r8: 0,
      r9: 0
    }
    const result = selectRepositories(chunks, [answered(first), answered(second)])
    expect(result).toEqual({
      selected: [candidate(32), candidate(1), candidate(33), candidate(3), candidate(4)].map(
        ({ provider, repoFullName, repoId }) => ({ provider, repoFullName, repoId })
      )
    })
    expect('selected' in result && result.selected).toHaveLength(REPO_SELECTION_MAX)
  })

  it('selects nothing from a chunk none leads, and nothing at all when every chunk says none', () => {
    const chunks = repoSelectionChunks(many(3))
    expect(selectRepositories(chunks, [answered({ none: 0.5, r1: 0.3, r2: 0.1, r3: 0.1 })])).toEqual({ selected: [] })
    // A tie with none is not beating it.
    expect(selectRepositories(chunks, [answered({ none: 0.4, r1: 0.4, r2: 0.1, r3: 0.1 })])).toEqual({ selected: [] })
  })

  it('is unavailable when any chunk is, naming the reason, and on an answer of the wrong shape', () => {
    const chunks = repoSelectionChunks(many(40))
    const ok = answered({ none: 0.1, r1: 0.9, r2: 0, r3: 0, r4: 0, r5: 0, r6: 0, r7: 0, r8: 0, r9: 0 })
    expect(selectRepositories(chunks, [ok, { status: 'unavailable', reason: 'timeout' }])).toEqual({
      unavailable: 'timeout'
    })
    expect(selectRepositories(chunks, [ok])).toEqual({ unavailable: 'invalid_response' })
    const boolean: DecisionEvaluation = {
      status: 'answered',
      model: 'jev-latest',
      usage: { inputTokens: 1, outputTokens: 1 },
      answer: { type: 'boolean', value: true, probability: 0.9 }
    }
    expect(selectRepositories(chunks.slice(0, 1), [boolean])).toEqual({ unavailable: 'invalid_response' })
  })
})

describe('evaluating chunks', () => {
  it('runs at most four at once and answers in chunk order', async () => {
    let active = 0
    let peak = 0
    const results = await evaluateChunks(
      Array.from({ length: 7 }, (_, i) => i),
      async (chunk) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return chunk * 10
      }
    )
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60])
    expect(peak).toBe(REPO_SELECTION_CONCURRENCY)
  })
})

describe('the snapshot (decision 19)', () => {
  it('reads back what was pinned and nothing else', () => {
    const selected = [{ provider: 'github' as const, repoFullName: 'acme/infra', repoId: '42' }]
    expect(parseSelectedRepositories(JSON.stringify(selected))).toEqual(selected)
    expect(parseSelectedRepositories('[]')).toEqual([])
    expect(parseSelectedRepositories(null)).toBeUndefined()
    expect(parseSelectedRepositories('not json')).toBeUndefined()
    expect(
      parseSelectedRepositories(JSON.stringify([{ provider: 'other', repoFullName: 'x', repoId: '1' }]))
    ).toBeUndefined()
    expect(sameSelection(selected, [{ ...selected[0]!, repoFullName: 'acme/renamed' }])).toBe(true)
    expect(sameSelection(selected, [])).toBe(false)
  })
})

describe('evaluateWithCapacityWait', () => {
  const capacity: DecisionEvaluation = { status: 'unavailable', reason: 'capacity' }
  // A fake clock the sleeps advance, so the wait's deadline is exercised without real time.
  const clock = () => {
    let now = 0
    const sleeps: number[] = []
    return {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        now += ms
      },
      sleeps
    }
  }

  it('waits out the shared slots and returns the answer once one is free', async () => {
    const deps = clock()
    const answers = [capacity, capacity, answered({ r1: 0.7, none: 0.3 })]
    const result = await evaluateWithCapacityWait(async () => answers.shift()!, deps)
    expect(result.status).toBe('answered')
    expect(deps.sleeps).toEqual([250, 500])
  })

  it('gives up with capacity once the wait runs out', async () => {
    const deps = clock()
    const result = await evaluateWithCapacityWait(async () => capacity, { ...deps, waitMs: 1_000 })
    expect(result).toEqual(capacity)
    expect(deps.sleeps.reduce((a, b) => a + b, 0)).toBe(1_000)
  })

  it('never retries any other refusal', async () => {
    const deps = clock()
    let calls = 0
    const result = await evaluateWithCapacityWait(async () => {
      calls++
      return { status: 'unavailable', reason: 'credentials' }
    }, deps)
    expect(result).toEqual({ status: 'unavailable', reason: 'credentials' })
    expect(calls).toBe(1)
    expect(deps.sleeps).toEqual([])
  })
})
