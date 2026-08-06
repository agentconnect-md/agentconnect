/**
 * Arena case: DELEGATE AND FORWARD — the real-model half.
 *
 * The credential-free half (`delegate-and-forward.test.ts`, in
 * `pnpm eval:collab:contracts`) pins the SYSTEM affordances. This file measures the
 * BEHAVIOR they produce, and it is deliberately NOT in the CI gate: it needs a real
 * ACP runtime and provider credentials, and a model result is a rate over trials,
 * never a single pass/fail (collaboration-arena.md §8.1).
 *
 * The task is the one a user actually gave in production:
 *
 *     @agent-a send hello to agent b and forward reply
 *
 * `agent-b` is a real model too — the daemon's host seam is per-daemon, so one run
 * cannot mix a real runtime with a scripted one — but its behavior is fixed by
 * CONFIGURATION rather than by scripting: its `agent.json` description gives it a
 * responder persona and a per-trial token it must include in its reply. That token
 * is what makes "A forwarded B's ACTUAL reply" a hard assertion instead of a
 * judgement call, and A can never see it (an agent's description is its own).
 *
 * The four invariants the observed trace violated, measured per trial:
 *
 *  1. `noSameTurnPoll`    — A does not call `viewSessionStatus` in the same turn as
 *                           the `sendMessage` that started the child.
 *  2. `noPrematureClaim`  — A's first turn makes no completion claim about B, whose
 *                           report provably had not arrived when that turn ended.
 *  3. `wokenByTheReply`   — A ends its turn and a LATER turn of A carries B's token.
 *  4. `forwardedTheReply` — after that wake, A's visible post to the requester
 *                           carries B's token.
 *
 * Every trial's turn-by-turn transcript is written under
 * `.artifacts/evaluation/delegate-forward/` (mode 0600, redacted with the subject
 * template's secrets), because a behavior claim without the trace behind it is not
 * evidence.
 *
 * Run:
 *   pnpm --filter @agentconnect.md/daemon build
 *   export AGENTCONNECT_DAEMON_ENTRY="$PWD/packages/daemon/dist/index.js"
 *   export AGENTCONNECT_EVAL_SUBJECT_ROOT=/absolute/path/to/subject
 *   export AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS=<template-agent-id>
 *   npx vitest run evals/test/delegate-and-forward-real.test.ts
 *
 * The template must define an explicit runtime (local Claude Code over ACP for the
 * measured runs), pin its model, and use `permissionMode: default` — a non-prompting
 * mode makes the runtime deny every AgentConnect tool locally, before the daemon is
 * ever consulted (collaboration-arena-baseline.md §5.1).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicWrite, redactEvaluationValue } from '../../packages/daemon/src/evaluation/index.js'
import { RoutingFixture, type RoutingTurnTrace } from './routing-fixture.js'

const subjectRoot = process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()
const templateAgents = (process.env.AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
const configured = Boolean(subjectRoot) && templateAgents.length > 0
const TRIALS = Number(process.env.AGENTCONNECT_EVAL_TRIALS ?? '5')
/** One trial is two-to-four real model turns plus two cold ACP starts. */
const TRIAL_BUDGET_MS = Number(process.env.AGENTCONNECT_EVAL_TRIAL_BUDGET_MS ?? '420000')
const ARTIFACT_DIR = join(process.cwd(), '.artifacts', 'evaluation', 'delegate-forward')

/** B's persona. Configuration, not a script: it fixes WHAT B answers with, and
 *  leaves every routing and turn-shaping decision to the model and the daemon. */
const responderDescription = (token: string): string =>
  'You are a responder agent. When another agent or a person greets you or asks you something, answer them ' +
  'directly and briefly in one or two sentences. Your answer must always contain the exact marker ' +
  `${token} so the person who asked can tell your answer apart from anyone else's. Do not explain the ` +
  'marker and do not ask follow-up questions.'

/** A completion/terminal claim about the delegate — the class of sentence the
 *  observed trace ended on ("Agent B completed its turn but returned no message to
 *  forward"). Matching any of these in the FIRST turn is the violation, because at
 *  that point B provably had not reported back. */
const TERMINAL_CLAIM_PATTERNS: RegExp[] = [
  /returned no (message|reply|response|answer)/i,
  /(no|without a) (message|reply|response|answer) to forward/i,
  /(completed|finished|ended) its turn/i,
  /did not (reply|respond|return|send)/i,
  /has (not )?(replied|responded)/i,
  /nothing (came )?back/i,
  /(reply|response) was empty/i
]

interface TrialResult {
  trial: number
  seed: number
  token: string
  noSameTurnPoll: boolean
  noPrematureClaim: boolean
  wokenByTheReply: boolean
  forwardedTheReply: boolean
  /** Did the child discharge its report-back obligation with an explicit
   *  `sendMessage {sessionId}`? A postless child session is HEADLESS, so a child
   *  that answers only in prose produces nothing at all — the measured reason
   *  `wokenByTheReply` fails when it does. */
  childUsedSessionReply: boolean
  /** Which turn (1-based) issued the delegating `sendMessage`, if any. */
  delegationTurn?: number
  viewSessionStatusCalls: number
  turnsByA: number
  notes: string[]
}

let fixture: RoutingFixture | undefined

afterEach(async () => {
  await fixture?.stop()
  fixture = undefined
})

function isStatusPoll(call: { name: string; arguments: unknown }): boolean {
  return /viewSessionStatus$/.test(call.name)
}

async function runTrial(trial: number): Promise<{ result: TrialResult; transcript: unknown }> {
  const seed = 900 + trial
  const token = `B-REPLY-${seed}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  fixture = await RoutingFixture.start({
    agents: ['agent-a', 'agent-b'],
    scripts: {},
    seed,
    subject: { kind: 'real', subjectRoot: subjectRoot!, templateAgentIds: templateAgents },
    agentDescriptions: { 'agent-b': responderDescription(token) },
    settleTimeoutMs: TRIAL_BUDGET_MS
  })
  // The production phrasing, verbatim. It is synchronous-sounding on purpose:
  // that is half of what the case is about.
  const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent-a')}> send hello to agent b and forward reply`, {
    mentions: [fixture.botUserId('agent-a')]
  })
  await fixture.settle(trigger.handles)

  const turnsA = fixture.turnTraces('agent-a')
  const turnsB = fixture.turnTraces('agent-b')
  const notes: string[] = []

  // Which turn delegated, taken from the DAEMON's own delivery record rather
  // than the runtime's tool-call reporting (a runtime may announce a call before
  // its arguments are known, so the trace alone cannot prove `toAgent`).
  const wakeTurnIds = new Set(
    fixture
      .peerWakesIssued('agent-a')
      .filter((wake) => wake.admitted && wake.turnId !== undefined)
      .map((wake) => wake.turnId!)
  )
  const delegationIndex = turnsA.findIndex((turn) => turn.turnId !== undefined && wakeTurnIds.has(turn.turnId))
  const delegationTurn = delegationIndex >= 0 ? delegationIndex + 1 : undefined
  if (delegationTurn === undefined) notes.push('agent-a never delivered a peer wake')

  // 1. No busy-poll inside the delegating turn.
  const noSameTurnPoll = delegationIndex >= 0 ? !turnsA[delegationIndex]!.toolCalls.some(isStatusPoll) : false

  // 2. No completion claim in the first turn. B's report cannot have arrived
  //    yet — asserted, not assumed: the first turn's own output is checked, and
  //    a claim only counts as premature when no later turn had yet carried the
  //    token into A.
  const firstOutput = turnsA[0]?.output ?? ''
  const premature = TERMINAL_CLAIM_PATTERNS.filter((pattern) => pattern.test(firstOutput))
  const noPrematureClaim = premature.length === 0
  if (!noPrematureClaim) notes.push(`first turn asserted: ${premature.map(String).join(', ')}`)

  // 3. A ended its turn and was woken again, carrying B's actual reply.
  const wakeTurn = turnsA.findIndex((turn, index) => index > 0 && turn.input.includes(token))
  const wokenByTheReply = wakeTurn > 0
  const childUsedSessionReply = turnsB.some((turn) =>
    turn.toolCalls.some(
      (call) =>
        /sendMessage$/.test(call.name) &&
        (call.arguments as { sessionId?: unknown } | undefined)?.sessionId !== undefined
    )
  )
  if (!wokenByTheReply) {
    notes.push(
      turnsB.length === 0
        ? 'agent-b never ran a turn'
        : childUsedSessionReply
          ? `agent-b reported to the parent session but its token never reached agent-a`
          : `agent-b answered only in prose — its headless session had nowhere to put the answer`
    )
  }

  // 4. The forward itself: a visible post by A, in the requester's room, that
  //    carries B's token.
  const forwarded = fixture
    .deliveredPosts()
    .filter((post) => post.agentId !== undefined && fixture!.aliasOf(post.agentId) === 'agent-a')
    .filter((post) => post.text.includes(token))
  const forwardedTheReply = forwarded.length > 0
  if (wokenByTheReply && !forwardedTheReply) notes.push('agent-a was woken with the reply but never forwarded it')

  const result: TrialResult = {
    trial,
    seed,
    token,
    noSameTurnPoll,
    noPrematureClaim,
    wokenByTheReply,
    forwardedTheReply,
    childUsedSessionReply,
    ...(delegationTurn !== undefined ? { delegationTurn } : {}),
    viewSessionStatusCalls: turnsA.reduce((total, turn) => total + turn.toolCalls.filter(isStatusPoll).length, 0),
    turnsByA: turnsA.length,
    notes
  }
  const transcript = {
    result,
    turns: { 'agent-a': turnsA, 'agent-b': turnsB } satisfies Record<string, RoutingTurnTrace[]>,
    deliveredPosts: fixture.deliveredPosts().map((post) => ({
      author: post.agentId !== undefined ? fixture!.aliasOf(post.agentId) : undefined,
      thread: post.thread,
      text: post.text
    }))
  }
  return { result, transcript }
}

describe.skipIf(!configured)('delegate-and-forward against a real ACP runtime', () => {
  it(
    `runs ${TRIALS} trials of "send hello to agent b and forward reply" and reports each invariant as a rate`,
    async () => {
      mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 })
      const results: TrialResult[] = []
      for (let trial = 1; trial <= TRIALS; trial += 1) {
        const { result, transcript } = await runTrial(trial)
        results.push(result)
        atomicWrite(
          join(ARTIFACT_DIR, `trial-${trial}.json`),
          `${JSON.stringify(redactEvaluationValue(transcript, fixture?.secrets ?? []), null, 2)}\n`
        )
        await fixture?.stop()
        fixture = undefined
      }
      const rate = (key: keyof TrialResult) => results.filter((entry) => entry[key] === true).length
      const summary = {
        trials: results.length,
        noSameTurnPoll: rate('noSameTurnPoll'),
        noPrematureClaim: rate('noPrematureClaim'),
        wokenByTheReply: rate('wokenByTheReply'),
        forwardedTheReply: rate('forwardedTheReply'),
        childUsedSessionReply: rate('childUsedSessionReply'),
        results
      }
      atomicWrite(join(ARTIFACT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
      console.log(JSON.stringify(summary, null, 2))

      // The only hard failure is an unusable run: a model rate is reported, not
      // asserted (§8.1). A trial in which A never delegated at all measured
      // nothing about the async contract.
      expect(results.filter((entry) => entry.delegationTurn !== undefined).length).toBeGreaterThan(0)
    },
    TRIAL_BUDGET_MS * (TRIALS + 1)
  )
})
