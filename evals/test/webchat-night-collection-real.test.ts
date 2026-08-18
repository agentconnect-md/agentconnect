/**
 * Night collection against REAL local players — the behavioral half of the
 * webchat night-1 scenario (`evals/games/night-collection.ts`).
 *
 * The referee stays SCRIPTED (the puppet ACP adapter runs the same brain as
 * the CI variant, acting through the real tool surface); the CHILDREN are real
 * local Claude Code over ACP. What is measured — never asserted — is the
 * reply-loss rate: a child that reports with `sendMessage {sessionId}` wakes
 * the referee; one that answers in prose is LOST (the delegate-and-forward
 * finding; PR #905 is parked pending exactly this coverage, so the loss rate
 * measured here IS the pre-#905 baseline, historically 2/5–3/5).
 *
 * Deliberately NOT in any CI gate: needs a real runtime + credentials, and a
 * model result is a rate over trials (collaboration-arena.md §8.1).
 *
 * Run:
 *   pnpm --filter @agentconnect.md/daemon build
 *   export AGENTCONNECT_DAEMON_ENTRY="$PWD/packages/daemon/dist/index.js"
 *   export AGENTCONNECT_EVAL_SUBJECT_ROOT=/absolute/path/to/subject
 *   export AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS=<template-agent-id>
 *   npx vitest run evals/test/webchat-night-collection-real.test.ts
 * Optional: AGENTCONNECT_EVAL_TRIALS (default 3), AGENTCONNECT_EVAL_TRIAL_BUDGET_MS.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { atomicWrite, redactEvaluationValue } from '../../packages/daemon/src/evaluation/index.js'
import {
  NIGHT_ALIASES,
  NIGHT_START_TEXT,
  NightCollectionReferee,
  scoreNightCollection,
  type NightCollectionScore
} from '../games/night-collection.js'
import { PuppetDriver } from '../games/puppet.js'
import { preflightRealSubject } from '../games/subject.js'
import { WebchatArena, mintSeats, prepareRealWebchatRoot } from '../games/webchat-fixture.js'

const subjectRoot = process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()
const templateAgents = (process.env.AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
const configured = Boolean(subjectRoot) && templateAgents.length > 0
const TRIALS = Number(process.env.AGENTCONNECT_EVAL_TRIALS ?? '3')
const TRIAL_BUDGET_MS = Number(process.env.AGENTCONNECT_EVAL_TRIAL_BUDGET_MS ?? '480000')
const ARTIFACT_DIR = join(process.cwd(), '.artifacts', 'evaluation', 'night-collection')

const ALIASES = NIGHT_ALIASES

interface TrialRecord {
  trial: number
  status: 'ok' | 'invalid'
  invalidReason?: string
  settled: boolean
  issuedCalls: { to: string; purpose: string; delivered: boolean }[]
  score: NightCollectionScore
  lostReplies: string[]
  latencyMs: number
}

const results: TrialRecord[] = []

async function runTrial(trial: number): Promise<TrialRecord> {
  const seats = mintSeats([...ALIASES])
  const seat = (alias: (typeof ALIASES)[number]) => seats.find((candidate) => candidate.alias === alias)!
  const aliasOf = (agentId: string) => seats.find((candidate) => candidate.agentId === agentId)?.alias ?? agentId
  const driver = new PuppetDriver()
  await driver.start()
  const referee = new NightCollectionReferee({
    wolfA: seat('wolf-a'),
    wolfB: seat('wolf-b'),
    seer: seat('seer'),
    doctor: seat('doctor')
  })
  driver.useBrain(referee)
  const subject = prepareRealWebchatRoot(seats, {
    subjectRoot: subjectRoot!,
    templateAgentIds: templateAgents,
    refereeAlias: 'referee',
    puppetEndpoint: driver.endpoint
  })
  const arena = new WebchatArena({ root: subject.root, seats, secrets: subject.secrets })
  const startedAt = Date.now()
  try {
    await preflightRealSubject(subject.root)
    await arena.start()
    await arena.postHost(NIGHT_START_TEXT)
    const settled = await arena.settleOrStall({ quietMs: 15_000, timeoutMs: TRIAL_BUDGET_MS })
    const latencyMs = Date.now() - startedAt
    const events = arena.events()
    const failedTurn = events.find((event) => event.type === 'turn.failed' || event.type === 'turn.timed_out')
    const score = scoreNightCollection({
      events,
      refereePrompts: driver.promptLog.map((entry) => entry.text),
      posts: arena.posts,
      refereeAgentId: seat('referee').agentId,
      children: [
        { alias: 'wolf-a', marker: 'proposal' },
        { alias: 'seer', marker: 'seer' },
        { alias: 'doctor', marker: 'doctor' },
        { alias: 'wolf-b', marker: 'verdict' }
      ]
    })
    // The wolf-B relay only exists once wolf-A's reply arrived; score rows for
    // children the referee never called are not losses, they are unreached.
    const calledAgents = new Set(referee.issued.map((call) => call.to))
    const lostReplies = score.replies
      .filter((reply) => {
        const child = seats.find((candidate) => candidate.alias === reply.child)
        return reply.mode === 'lost' && child !== undefined && calledAgents.has(child.agentId)
      })
      .map((reply) => reply.child)
    const record: TrialRecord = {
      trial,
      status: failedTurn ? 'invalid' : 'ok',
      ...(failedTurn
        ? { invalidReason: `turn ${failedTurn.type} (${String(failedTurn.data.code ?? 'unknown')})` }
        : {}),
      settled,
      issuedCalls: referee.issued.map((call) => ({
        to: aliasOf(call.to),
        purpose: call.purpose,
        delivered: call.delivered
      })),
      score,
      lostReplies,
      latencyMs
    }
    const dir = join(ARTIFACT_DIR, `trial-${trial}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    arena.eventCollector().writeJsonl(join(dir, 'events.jsonl'))
    atomicWrite(
      join(dir, 'trial.json'),
      `${JSON.stringify(
        redactEvaluationValue(
          {
            record,
            refereePrompts: driver.promptLog,
            posts: arena.posts.map((post) => ({ author: aliasOf(post.agentId), text: post.post.text }))
          },
          subject.secrets
        ),
        null,
        2
      )}\n`
    )
    return record
  } finally {
    await arena.stop().catch(() => {})
    await driver.stop().catch(() => {})
    subject.cleanup()
  }
}

afterAll(() => {
  if (results.length === 0) return
  mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 })
  const summary = {
    generatedAt: new Date().toISOString(),
    trials: results.length,
    scoreable: results.filter((row) => row.status === 'ok').length,
    replyLossByTrial: results.map((row) => ({
      trial: row.trial,
      status: row.status,
      lost: row.lostReplies,
      modes: Object.fromEntries(row.score.replies.map((reply) => [reply.child, reply.mode]))
    })),
    records: results
  }
  atomicWrite(join(ARTIFACT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary.replyLossByTrial, null, 2))
})

describe.skipIf(!configured)('webchat night collection — real players, scripted referee', () => {
  for (let trial = 1; trial <= TRIALS; trial += 1) {
    it(
      `trial ${trial}`,
      async () => {
        const record = await runTrial(trial)
        results.push(record)
        if (record.status === 'invalid') {
          console.warn(`INVALID trial ${trial}: ${record.invalidReason}`)
        }
        // A model result is reported, never asserted (§8.1). Only apparatus
        // failures fail the test — e.g. the referee's own calls not delivering.
        expect(record.issuedCalls.filter((call) => call.purpose !== 'verdict').length).toBe(3)
        expect(record.issuedCalls.every((call) => call.delivered)).toBe(true)
      },
      TRIAL_BUDGET_MS + 120_000
    )
  }

  it('produced at least one scoreable trial', () => {
    expect(results.filter((row) => row.status === 'ok').length).toBeGreaterThan(0)
  })
})
