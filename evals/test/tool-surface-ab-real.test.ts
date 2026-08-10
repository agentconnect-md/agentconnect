/**
 * Tool-surface A/B — the behavioral half, against a real ACP runtime.
 *
 * The credential-free half (`tool-surface-ab.test.ts`, `post-facade.test.ts`,
 * `tool-surface-ab-fixture.test.ts`, all in the CI gates) pins the apparatus:
 * the façade's compilation, the shared classifier, and the arm-parity
 * preconditions. This file runs the pre-registered 4×2×3 matrix — four send
 * scenarios, two surfaces, three trials — and is deliberately NOT in any CI
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
  classifyPostForm,
  extractTrialMetrics,
  type AbScenario,
  type AbTrialMetrics,
  type SendForm
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

let fixture: AbFixture | undefined
const results: AbRunRecord[] = []

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
  return {
    generatedAt: new Date().toISOString(),
    trialsPerCell: TRIALS,
    cells: Object.fromEntries(
      scenarios.flatMap((scenario) => arms.map((arm) => [`${scenario.id}/${arm}`, cell(scenario.id, arm)] as const))
    ),
    invalidTrials: records.filter((row) => row.status === 'invalid'),
    records
  }
}

afterAll(() => {
  if (results.length === 0) return
  mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 })
  const summary = aggregate(results)
  atomicWrite(join(ARTIFACT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary.cells, null, 2))
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

  it('produced at least one scoreable trial per cell', () => {
    for (const scenario of scenarios) {
      for (const arm of arms) {
        const ok = results.filter(
          (row) => row.scenario === scenario.id && row.arm === arm && row.status === 'ok'
        ).length
        expect(ok, `${scenario.id}/${arm} has no scoreable trial`).toBeGreaterThan(0)
      }
    }
  })
})
