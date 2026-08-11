/**
 * Tool-surface A/B — the behavioral half, against a real ACP runtime.
 *
 * The credential-free half (`tool-surface-ab.test.ts`, `post-facade.test.ts`,
 * `tool-surface-ab-fixture.test.ts`, all in the CI gates) pins the apparatus:
 * the façade's compilation, the shared classifier, and the arm-parity
 * preconditions. This file runs the pre-registered matrix — four send
 * scenarios plus the in-thread turn-taking scenario (the #801 regression
 * gate), two surfaces, three trials each — and is deliberately NOT in any CI
 * gate: it needs a real runtime and provider credentials, and a model result
 * is a rate over trials, never a single pass/fail (collaboration-arena.md §8.1).
 *
 * Success is judged from the DAEMON's own records, never the model's claims:
 * the executed product-form of each attempt (arm B scored on what its call
 * COMPILED to), the world's delivered/rejected effects, and the peer's actual
 * activations. Tokens come from the daemon's `turn.completed` usage events,
 * scoped to the subject agent and also reported for the whole run.
 *
 * Pre-registered expectations (held to in the write-up): a clear arm-B win on
 * static descriptor cost and on invalid-call rate — the latter partly BY
 * CONSTRUCTION, since arm B cannot even express most illegal combinations —
 * and little or no difference on success or efficiency. n=3 per cell screens
 * for large effects only.
 *
 * Run:
 *   pnpm --filter @agentconnect.md/daemon build
 *   export AGENTCONNECT_DAEMON_ENTRY="$PWD/packages/daemon/dist/index.js"
 *   export AGENTCONNECT_EVAL_SUBJECT_ROOT=/absolute/path/to/subject
 *   export AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS=<template-agent-id>
 *   npx vitest run evals/test/tool-surface-ab-real.test.ts
 *
 * Optional: AGENTCONNECT_EVAL_TRIALS (default 3), AGENTCONNECT_EVAL_AB_SCENARIOS
 * / AGENTCONNECT_EVAL_AB_ARMS (csv filters), AGENTCONNECT_EVAL_TRIAL_BUDGET_MS.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { atomicWrite, redactEvaluationValue } from '../../packages/daemon/src/evaluation/index.js'
import { compilePost } from '../games/post-facade.js'
import {
  AB_SCENARIOS,
  THREAD_COUNT_SCENARIO,
  classifyPostForm,
  extractTrialMetrics,
  judgeThreadCount,
  type AbScenario,
  type AbTrialMetrics,
  type SendForm,
  type ThreadCountVerdict
} from '../games/tool-surface-ab.js'
import { AbFixture, type AbArm } from '../games/tool-surface-ab-fixture.js'

const subjectRoot = process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()
const templateAgents = (process.env.AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
const configured = Boolean(subjectRoot) && templateAgents.length > 0
const TRIALS = Number(process.env.AGENTCONNECT_EVAL_TRIALS ?? '3')
const TRIAL_BUDGET_MS = Number(process.env.AGENTCONNECT_EVAL_TRIAL_BUDGET_MS ?? '420000')
const ARTIFACT_DIR = join(process.cwd(), '.artifacts', 'evaluation', 'tool-surface-ab')
const scenarioFilter = (process.env.AGENTCONNECT_EVAL_AB_SCENARIOS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
const armFilter = (process.env.AGENTCONNECT_EVAL_AB_ARMS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean) as AbArm[]

const scenarios = AB_SCENARIOS.filter((scenario) => scenarioFilter.length === 0 || scenarioFilter.includes(scenario.id))
const arms: AbArm[] = (['A', 'B'] as const).filter((arm) => armFilter.length === 0 || armFilter.includes(arm))
// Scenario 5 (in-thread turn-taking) rides the same filters; its index in the
// full matrix follows the four send scenarios, which keeps counterbalancing
// and seed derivation consistent with them.
const runThreadCount = scenarioFilter.length === 0 || scenarioFilter.includes(THREAD_COUNT_SCENARIO.id)
const THREAD_COUNT_SCENARIO_INDEX = AB_SCENARIOS.length

interface AbRunRecord {
  scenario: string
  arm: AbArm
  trial: number
  seed: number
  /** 'ok' — a scoreable trial; 'invalid' — infra/peer failure, measured nothing. */
  status: 'ok' | 'invalid'
  invalidReason?: string
  /** Overall: some attempt executed the expected product form at the right
   *  target AND the daemon's effects show the intended delivery. */
  success: boolean
  /** The FIRST attempt already satisfied the full check (no retry loop). */
  firstAttemptSuccess: boolean
  attemptsToSuccess: number
  toolCalls: number
  invalidCalls: number
  /** Sub-flag for the ask scenarios: was the answer-obligation flag set? */
  expectReplySet?: boolean
  subjectTokens: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number }
  runTokens: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number }
  subjectTurns: number
  runTurns: number
  latencyMs: number
  /** Verbatim attempts on the subject surface, plus any call the model tried
   *  to make on the OTHER arm's surface — the qualitative misuse evidence. */
  attempts: unknown[]
  crossSurfaceAttempts: unknown[]
  notes: string[]
}

interface TokenBreakdown {
  total: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One scenario-5 run: the daemon-judged verdict plus the run economics. Both
 *  agents are subjects here, so tokens are reported per participant and for
 *  the whole run — there is no single "subject agent" to scope to. */
interface ThreadCountRunRecord {
  scenario: typeof THREAD_COUNT_SCENARIO.id
  arm: AbArm
  trial: number
  seed: number
  status: 'ok' | 'invalid'
  invalidReason?: string
  verdict: ThreadCountVerdict
  runnerTokens: TokenBreakdown
  peerTokens: TokenBreakdown
  runTokens: TokenBreakdown
  runnerTurns: number
  peerTurns: number
  runTurns: number
  latencyMs: number
  notes: string[]
}

let fixture: AbFixture | undefined
const results: AbRunRecord[] = []
const threadCountResults: ThreadCountRunRecord[] = []

afterEach(async () => {
  await fixture?.stop()
  fixture = undefined
})

/** The product-level args an attempt EXECUTED as: arm A's raw input, or what
 *  the arm-B façade compiled its input into. */
function productArgs(arm: AbArm, args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined
  if (arm === 'A') return args
  try {
    return compilePost(args).args
  } catch {
    return undefined
  }
}

function toAgentIdOf(args: Record<string, unknown> | undefined): string | undefined {
  const target = args?.toAgent
  if (typeof target === 'string') return target
  if (target && typeof target === 'object') return (target as { agentId?: string }).agentId
  return undefined
}

function needsReplyOf(args: Record<string, unknown> | undefined): boolean {
  const target = args?.toAgent
  return typeof target === 'object' && target !== null && (target as { needsReply?: unknown }).needsReply === true
}

/** Does this attempt fully satisfy the scenario — right form AND right ids? */
function attemptSatisfies(
  scenario: AbScenario,
  arm: AbArm,
  attempt: { form: SendForm; failed: boolean; args?: Record<string, unknown> },
  ids: { peerAgentId: string; channel: string }
): boolean {
  if (attempt.failed || attempt.form !== scenario.expected) return false
  const args = productArgs(arm, attempt.args)
  if (!args) return false
  switch (scenario.expected) {
    case 'agent-channel':
      return args.channel === ids.channel && toAgentIdOf(args) === ids.peerAgentId
    case 'channel-bare':
      return args.channel === ids.channel
    case 'agent-postless':
      return toAgentIdOf(args) === ids.peerAgentId && args.channel === undefined
    case 'parent-session':
      return typeof args.sessionId === 'string' && args.sessionId.length > 0
    default:
      return false
  }
}

async function runTrial(scenario: AbScenario, arm: AbArm, trial: number): Promise<AbRunRecord> {
  const scenarioIndex = AB_SCENARIOS.findIndex((candidate) => candidate.id === scenario.id)
  const seed = 5000 + scenarioIndex * 100 + trial
  fixture = await AbFixture.start({
    seed,
    arm,
    subject: { kind: 'real', subjectRoot: subjectRoot!, templateAgentIds: templateAgents }
  })
  const runnerId = fixture.agentId('runner')
  const peerId = fixture.agentId('peer')
  const plaza = fixture.room('plaza')
  const ids = { peerAgentId: peerId, channel: plaza.channel, humanUserId: 'W-HUMAN' }
  const instruction = scenario.instruction(ids)
  const notes: string[] = []

  const kickoff = scenario.needsCaller
    ? // Scenario 4: a real parent session. The PEER is told to delegate the
      // quoted request to the subject and to require the answer back; the
      // subject's scored behavior is what its child session then does.
      fixture.injectHuman(
        'peer-briefing',
        `<@${fixture.botUserId('peer')}> Ask agent ${runnerId} for help with a small task. You must require ` +
          `that its answer comes back to you — not fire-and-forget — and you must pass the request through ` +
          `word-for-word, exactly as quoted, adding nothing: "${instruction}"`,
        { mentions: [fixture.botUserId('peer')] }
      )
    : fixture.injectHuman('briefing', `<@${fixture.botUserId('runner')}> ${instruction}`, {
        mentions: [fixture.botUserId('runner')]
      })
  const startedAt = Date.now()
  await fixture.settle(kickoff.handles, TRIAL_BUDGET_MS)
  const latencyMs = Date.now() - startedAt

  const runnerEvents = fixture.eventsOf('runner')
  const allEvents = [...fixture.events()]
  const toolName = arm === 'A' ? 'sendMessage' : 'post'
  const asExtractorEvents = (events: { type: string; data: Record<string, unknown> }[]) => events
  const metrics: AbTrialMetrics = extractTrialMetrics(asExtractorEvents(runnerEvents as never), {
    toolName,
    expected: scenario.expected,
    latencyMs,
    ...(arm === 'B'
      ? { classify: (args: Record<string, unknown> | undefined) => classifyPostForm(compilePost, args) }
      : {})
  })
  const runMetrics = extractTrialMetrics(asExtractorEvents(allEvents as never), {
    toolName,
    expected: scenario.expected,
    latencyMs
  })

  // ── validity: infra failures measure nothing about the surface ──
  // ANY failed or timed-out turn invalidates: unlike a long arena game that can
  // absorb one failed turn and still complete, this experiment is a single
  // explicit send — a failed turn always poisons the measurement. Measured
  // examples that must not score as behavior: an expired provider OAuth
  // (provider_auth_required) and a subscription session limit, which surfaces
  // as a generic turn_failed RequestError plus an apologetic delivered reply.
  const failedTurn = allEvents.find((event) => event.type === 'turn.failed' || event.type === 'turn.timed_out')
  let invalidReason: string | undefined
  if (failedTurn) {
    invalidReason = `turn ${failedTurn.type === 'turn.timed_out' ? 'timed out' : 'failed'} (${String(
      failedTurn.data.code ?? 'unknown'
    )})`
  }
  if (scenario.needsCaller) {
    const delegated = runnerEvents.some(
      (event) => event.type === 'turn.started' && String(event.data.input ?? '').includes('sum of 17 and 25')
    )
    if (!delegated) invalidReason = 'the caller never delegated the request to the subject'
  }

  // ── the full success check: form + ids (per attempt), then daemon effects ──
  const satisfying = metrics.attempts.map((attempt) => attemptSatisfies(scenario, arm, attempt, ids))
  const successIndex = satisfying.findIndex(Boolean)
  const deliveredInPlaza = fixture.world
    .allEffects()
    .some((effect) => effect.status === 'delivered' && effect.channel === plaza.channel && effect.agentId === runnerId)
  const peerActivated = allEvents.some((event) => event.type === 'turn.started' && event.agentId === peerId)
  const instructionLeakedToPlaza = fixture.world
    .allEffects()
    .some(
      (effect) =>
        effect.status === 'delivered' && effect.channel === plaza.channel && effect.text.includes('current status')
    )
  let effectsOk: boolean
  switch (scenario.id) {
    case 'agent-channel':
      effectsOk = deliveredInPlaza && peerActivated
      if (!deliveredInPlaza) notes.push('no delivered post by the subject in the target channel')
      if (!peerActivated) notes.push('the addressed agent was never activated')
      break
    case 'channel-bare':
      // The scenario's whole point is "visible note, nobody woken": a delivered
      // post that ALSO activated the peer is a failure, not a success.
      effectsOk = deliveredInPlaza && !peerActivated
      if (!deliveredInPlaza) notes.push('no delivered post by the subject in the target channel')
      if (peerActivated) notes.push('the bare post woke the peer — the scenario requires waking nobody')
      break
    case 'agent-postless':
      effectsOk = peerActivated && !instructionLeakedToPlaza
      if (!peerActivated) notes.push('the asked agent was never activated')
      if (instructionLeakedToPlaza) notes.push('the private ask leaked into the shared channel')
      break
    case 'parent-session': {
      // The parent (peer) must actually be woken by the reply: a later peer
      // turn whose input carries the answer.
      const parentGotAnswer = allEvents.some(
        (event) =>
          event.type === 'turn.started' && event.agentId === peerId && String(event.data.input ?? '').includes('42')
      )
      effectsOk = parentGotAnswer
      if (!parentGotAnswer) notes.push("the parent session never received the child's answer")
      break
    }
    default:
      effectsOk = false
  }

  const success = successIndex >= 0 && effectsOk
  const firstAttemptSuccess = satisfying[0] === true && effectsOk

  // Ask scenarios: was the answer-obligation flag set on the satisfying call?
  let expectReplySet: boolean | undefined
  if (scenario.id === 'agent-postless' && successIndex >= 0) {
    expectReplySet = needsReplyOf(productArgs(arm, metrics.attempts[successIndex]!.args))
  }

  // Cross-surface attempts: the model reaching for the OTHER arm's tool.
  const otherName = arm === 'A' ? 'post' : 'sendMessage'
  const crossSurfaceAttempts = runnerEvents
    .filter((event) => event.type === 'acp.update')
    .map((event) => event.data.update as { sessionUpdate?: string; title?: string; rawInput?: unknown } | undefined)
    .filter(
      (update) =>
        update?.sessionUpdate === 'tool_call' &&
        typeof update.title === 'string' &&
        update.title.toLowerCase().includes(otherName.toLowerCase())
    )
  if (crossSurfaceAttempts.length > 0) notes.push(`subject attempted the other arm's tool ${otherName}`)

  const record: AbRunRecord = {
    scenario: scenario.id,
    arm,
    trial,
    seed,
    status: invalidReason ? 'invalid' : 'ok',
    ...(invalidReason ? { invalidReason } : {}),
    success,
    firstAttemptSuccess,
    attemptsToSuccess: successIndex >= 0 ? successIndex + 1 : 0,
    toolCalls: metrics.toolCalls,
    invalidCalls: metrics.invalidCalls,
    ...(expectReplySet !== undefined ? { expectReplySet } : {}),
    subjectTokens: metrics.tokens,
    runTokens: runMetrics.tokens,
    subjectTurns: metrics.turns,
    runTurns: runMetrics.turns,
    latencyMs,
    attempts: metrics.attempts as unknown[],
    crossSurfaceAttempts: crossSurfaceAttempts as unknown[],
    notes
  }

  // ── artifacts: the daemon's own evidence, redacted, one dir per run ──
  const dir = join(ARTIFACT_DIR, `${scenario.id}-${arm}-${trial}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  fixture.eventCollector().writeJsonl(join(dir, 'events.jsonl'))
  const secrets = fixture.secrets
  atomicWrite(
    join(dir, 'world-events.jsonl'),
    fixture.world
      .events()
      .map((entry) => JSON.stringify(redactEvaluationValue(entry, secrets)))
      .join('\n') + '\n'
  )
  atomicWrite(
    join(dir, 'trial.json'),
    `${JSON.stringify(
      redactEvaluationValue(
        {
          record,
          instruction,
          facadeCalls: fixture.facadeCalls,
          effects: fixture.world.allEffects().map((effect) => ({
            status: effect.status,
            kind: effect.kind,
            channel: effect.channel,
            agentId: effect.agentId,
            ...(effect.reason !== undefined ? { reason: effect.reason } : {}),
            text: effect.text
          }))
        },
        secrets
      ),
      null,
      2
    )}\n`
  )
  return record
}

/**
 * Scenario 5 — in-thread turn-taking (the #801 regression gate). One plaza
 * thread, BOTH agents on the arm's surface, a human kickoff @-mentioning both;
 * the agents continue via ordinary replies (each delivered reply echoes back
 * and wakes the peer through the #549 continuation ladder). Judged by
 * `judgeThreadCount` from the daemon's records: the count must reach the
 * target through delivered thread replies with ZERO messaging-tool calls by
 * either participant and no lost replies.
 */
async function runThreadCountTrial(arm: AbArm, trial: number): Promise<ThreadCountRunRecord> {
  const seed = 5000 + THREAD_COUNT_SCENARIO_INDEX * 100 + trial
  fixture = await AbFixture.start({
    seed,
    arm,
    subject: { kind: 'real', subjectRoot: subjectRoot!, templateAgentIds: templateAgents }
  })
  const runnerId = fixture.agentId('runner')
  const peerId = fixture.agentId('peer')
  const plaza = fixture.room('plaza')
  const instruction = THREAD_COUNT_SCENARIO.instruction({
    first: `<@${fixture.botUserId('runner')}>`,
    second: `<@${fixture.botUserId('peer')}>`
  })
  const notes: string[] = []

  const kickoff = fixture.injectHuman('plaza', instruction, {
    mentions: [fixture.botUserId('runner'), fixture.botUserId('peer')]
  })
  const startedAt = Date.now()
  await fixture.settle(kickoff.handles, TRIAL_BUDGET_MS)
  const latencyMs = Date.now() - startedAt

  const allEvents = [...fixture.events()]
  const toolName = arm === 'A' ? 'sendMessage' : 'post'

  // ── validity: infra failures measure nothing about the prompt/surface ──
  const failedTurn = allEvents.find((event) => event.type === 'turn.failed' || event.type === 'turn.timed_out')
  let invalidReason: string | undefined
  if (failedTurn) {
    invalidReason = `turn ${failedTurn.type === 'turn.timed_out' ? 'timed out' : 'failed'} (${String(
      failedTurn.data.code ?? 'unknown'
    )})`
  }
  const anyParticipantTurn = allEvents.some(
    (event) => event.type === 'turn.started' && (event.agentId === runnerId || event.agentId === peerId)
  )
  if (!anyParticipantTurn) invalidReason ??= 'the kickoff never activated either participant'

  const verdict = judgeThreadCount({
    target: THREAD_COUNT_SCENARIO.target,
    participants: [runnerId, peerId],
    channel: plaza.channel,
    thread: kickoff.messageId,
    effects: fixture.world.allEffects(),
    events: allEvents as never
  })
  for (const failure of verdict.failures) notes.push(failure)

  // Token/turn economics per participant and for the whole run. The extractor
  // is reused for its usage folding only; scenario 5 has no expected form.
  const tokenMetrics = (events: { type: string; data: Record<string, unknown> }[]) =>
    extractTrialMetrics(events, { toolName, expected: 'unclassifiable', latencyMs })
  const runnerMetrics = tokenMetrics(fixture.eventsOf('runner') as never)
  const peerMetrics = tokenMetrics(fixture.eventsOf('peer') as never)
  const runMetrics = tokenMetrics(allEvents as never)

  const record: ThreadCountRunRecord = {
    scenario: THREAD_COUNT_SCENARIO.id,
    arm,
    trial,
    seed,
    status: invalidReason ? 'invalid' : 'ok',
    ...(invalidReason ? { invalidReason } : {}),
    verdict,
    runnerTokens: runnerMetrics.tokens,
    peerTokens: peerMetrics.tokens,
    runTokens: runMetrics.tokens,
    runnerTurns: runnerMetrics.turns,
    peerTurns: peerMetrics.turns,
    runTurns: runMetrics.turns,
    latencyMs,
    notes
  }

  // ── artifacts: same layout as the send scenarios, one dir per run ──
  const dir = join(ARTIFACT_DIR, `${THREAD_COUNT_SCENARIO.id}-${arm}-${trial}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  fixture.eventCollector().writeJsonl(join(dir, 'events.jsonl'))
  const secrets = fixture.secrets
  atomicWrite(
    join(dir, 'world-events.jsonl'),
    fixture.world
      .events()
      .map((entry) => JSON.stringify(redactEvaluationValue(entry, secrets)))
      .join('\n') + '\n'
  )
  atomicWrite(
    join(dir, 'trial.json'),
    `${JSON.stringify(
      redactEvaluationValue(
        {
          record,
          instruction,
          facadeCalls: fixture.facadeCalls,
          effects: fixture.world.allEffects().map((effect) => ({
            status: effect.status,
            kind: effect.kind,
            channel: effect.channel,
            thread: effect.thread,
            agentId: effect.agentId,
            ...(effect.reason !== undefined ? { reason: effect.reason } : {}),
            text: effect.text
          }))
        },
        secrets
      ),
      null,
      2
    )}\n`
  )
  return record
}

function aggregate(records: AbRunRecord[]) {
  const cell = (scenario: string, arm: AbArm) => {
    const rows = records.filter((row) => row.scenario === scenario && row.arm === arm && row.status === 'ok')
    const sum = (select: (row: AbRunRecord) => number) => rows.reduce((total, row) => total + select(row), 0)
    const mean = (select: (row: AbRunRecord) => number) => (rows.length === 0 ? 0 : sum(select) / rows.length)
    return {
      trials: rows.length,
      success: rows.filter((row) => row.success).length,
      firstAttempt: rows.filter((row) => row.firstAttemptSuccess).length,
      invalidCalls: sum((row) => row.invalidCalls),
      meanToolCalls: mean((row) => row.toolCalls),
      meanSubjectTokensTotal: Math.round(mean((row) => row.subjectTokens.total)),
      meanSubjectTokensInOut: Math.round(mean((row) => row.subjectTokens.input + row.subjectTokens.output)),
      meanRunTokensTotal: Math.round(mean((row) => row.runTokens.total)),
      meanRunTokensInOut: Math.round(mean((row) => row.runTokens.input + row.runTokens.output)),
      meanLatencyMs: Math.round(mean((row) => row.latencyMs))
    }
  }
  const threadCell = (arm: AbArm) => {
    const rows = threadCountResults.filter((row) => row.arm === arm && row.status === 'ok')
    const mean = (select: (row: ThreadCountRunRecord) => number) =>
      rows.length === 0 ? 0 : rows.reduce((total, row) => total + select(row), 0) / rows.length
    return {
      trials: rows.length,
      pass: rows.filter((row) => row.verdict.pass).length,
      messagingToolCalls: rows.reduce((total, row) => total + row.verdict.messagingToolCalls.length, 0),
      lostMessages: rows.reduce((total, row) => total + row.verdict.lostMessages, 0),
      meanReached: Number(mean((row) => row.verdict.reached).toFixed(2)),
      duplicates: rows.reduce((total, row) => total + row.verdict.duplicates, 0),
      skips: rows.reduce((total, row) => total + row.verdict.skips, 0),
      overshoot: rows.reduce((total, row) => total + row.verdict.overshoot, 0),
      meanBareNumberReplies: Number(mean((row) => row.verdict.bareNumberReplies).toFixed(2)),
      meanMetaNarrationReplies: Number(mean((row) => row.verdict.metaNarrationReplies).toFixed(2)),
      meanReplyChars: Number(mean((row) => row.verdict.meanReplyChars).toFixed(1)),
      meanTurnsPerNumber: Number(mean((row) => row.verdict.turnsPerNumber).toFixed(2)),
      meanRunTokensTotal: Math.round(mean((row) => row.runTokens.total)),
      meanRunTokensInOut: Math.round(mean((row) => row.runTokens.input + row.runTokens.output)),
      meanLatencyMs: Math.round(mean((row) => row.latencyMs))
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    trialsPerCell: TRIALS,
    cells: Object.fromEntries(
      scenarios.flatMap((scenario) => arms.map((arm) => [`${scenario.id}/${arm}`, cell(scenario.id, arm)] as const))
    ),
    threadCountCells: runThreadCount
      ? Object.fromEntries(arms.map((arm) => [`${THREAD_COUNT_SCENARIO.id}/${arm}`, threadCell(arm)] as const))
      : {},
    invalidTrials: [
      ...records.filter((row) => row.status === 'invalid'),
      ...threadCountResults.filter((row) => row.status === 'invalid')
    ],
    records,
    threadCountRecords: threadCountResults
  }
}

afterAll(() => {
  if (results.length === 0 && threadCountResults.length === 0) return
  mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 })
  const summary = aggregate(results)
  atomicWrite(join(ARTIFACT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ ...summary.cells, ...summary.threadCountCells }, null, 2))
})

describe.skipIf(!configured)('tool-surface A/B against a real ACP runtime', () => {
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      // Counterbalance arm order per (scenario, trial) so neither surface
      // systematically runs first within a pair.
      const ordered = (scenarioIndex + trial) % 2 === 0 ? [...arms] : [...arms].reverse()
      for (const arm of ordered) {
        it(
          `${scenario.id} arm ${arm} trial ${trial}`,
          async () => {
            const record = await runTrial(scenario, arm, trial)
            results.push(record)
            // A model result is reported, never asserted; only an unusable
            // trial (infra) is surfaced — and even that only as a soft note.
            if (record.status === 'invalid') {
              console.warn(`INVALID trial ${scenario.id}/${arm}/${trial}: ${record.invalidReason}`)
            }
            expect(true).toBe(true)
          },
          TRIAL_BUDGET_MS + 60_000
        )
      }
    }
  }

  // Scenario 5: in-thread turn-taking, same counterbalancing rule at its
  // matrix index. A model result is reported, never asserted (a hard-fail
  // verdict here IS a result — the prompt-change gate reads the summary).
  if (runThreadCount) {
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const ordered = (THREAD_COUNT_SCENARIO_INDEX + trial) % 2 === 0 ? [...arms] : [...arms].reverse()
      for (const arm of ordered) {
        it(
          `${THREAD_COUNT_SCENARIO.id} arm ${arm} trial ${trial}`,
          async () => {
            const record = await runThreadCountTrial(arm, trial)
            threadCountResults.push(record)
            if (record.status === 'invalid') {
              console.warn(`INVALID trial ${THREAD_COUNT_SCENARIO.id}/${arm}/${trial}: ${record.invalidReason}`)
            } else if (!record.verdict.pass) {
              console.warn(`FAIL ${THREAD_COUNT_SCENARIO.id}/${arm}/${trial}: ${record.verdict.failures.join('; ')}`)
            }
            expect(true).toBe(true)
          },
          TRIAL_BUDGET_MS + 60_000
        )
      }
    }
  }

  it('produced at least one scoreable trial per cell', () => {
    for (const scenario of scenarios) {
      for (const arm of arms) {
        const ok = results.filter(
          (row) => row.scenario === scenario.id && row.arm === arm && row.status === 'ok'
        ).length
        expect(ok, `${scenario.id}/${arm} has no scoreable trial`).toBeGreaterThan(0)
      }
    }
    if (runThreadCount) {
      for (const arm of arms) {
        const ok = threadCountResults.filter((row) => row.arm === arm && row.status === 'ok').length
        expect(ok, `${THREAD_COUNT_SCENARIO.id}/${arm} has no scoreable trial`).toBeGreaterThan(0)
      }
    }
  })
})
