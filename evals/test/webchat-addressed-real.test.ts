// Webchat addressing on real players (#2865): a post naming one agent is answered by it alone; reported, never asserted.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { atomicWrite } from '../../packages/daemon/src/evaluation/index.js'
import { PuppetDriver } from '../games/puppet.js'
import { preflightRealSubject } from '../games/subject.js'
import { WebchatArena, mintSeats, prepareRealWebchatRoot } from '../games/webchat-fixture.js'
import { NO_RESPONSE_SENTINEL as NO_RESPONSE } from '../../packages/daemon/src/session/no-response.js'

const subjectRoot = process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()
const templateAgents = (process.env.AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
const configured = Boolean(subjectRoot) && templateAgents.length > 0
const TRIALS = Number(process.env.AGENTCONNECT_EVAL_TRIALS ?? '3')
const TRIAL_BUDGET_MS = Number(process.env.AGENTCONNECT_EVAL_TRIAL_BUDGET_MS ?? '300000')
const ARTIFACT_DIR = join(process.cwd(), '.artifacts', 'evaluation', 'webchat-addressed')

interface Scenario {
  id: string
  text: string
  mentions?: string[]
  /** Seats that must post at least once; every other player seat must stay silent. */
  expectPosts: string[]
}

// The silent observer seat exists only because a real webchat root needs a puppet seat.
const SCENARIOS: Scenario[] = [
  {
    id: 'mentioned-one',
    text: '@a suggest one short name for our nightly evaluation bot, and say why in one sentence.',
    mentions: ['a'],
    expectPosts: ['a']
  },
  {
    id: 'addressed-all',
    text: 'Each of you, suggest one short name for our nightly evaluation bot, in one sentence.',
    expectPosts: ['a', 'b']
  }
]

interface TrialRecord {
  scenario: string
  trial: number
  status: 'ok' | 'invalid'
  invalidReason?: string
  settled: boolean
  postsBySeat: Record<string, number>
  missing: string[]
  unwanted: string[]
}

const results: TrialRecord[] = []

async function runTrial(scenario: Scenario, trial: number): Promise<TrialRecord> {
  const seats = mintSeats(['a', 'b', 'observer'])
  const driver = new PuppetDriver()
  await driver.start()
  driver.useBrain({ onPrompt: () => ({ calls: [], reply: NO_RESPONSE }) })
  const subject = prepareRealWebchatRoot(seats, {
    subjectRoot: subjectRoot!,
    templateAgentIds: templateAgents,
    refereeAlias: 'observer',
    puppetEndpoint: driver.endpoint
  })
  const arena = new WebchatArena({ root: subject.root, seats, secrets: subject.secrets })
  try {
    await preflightRealSubject(subject.root)
    await arena.start()
    await arena.postHost(scenario.text, scenario.mentions ? { mentions: scenario.mentions } : {})
    const settled = await arena.settleOrStall({ quietMs: 15_000, timeoutMs: TRIAL_BUDGET_MS })
    const failedTurn = arena.events().find((event) => event.type === 'turn.failed' || event.type === 'turn.timed_out')
    const postsBySeat: Record<string, number> = { a: 0, b: 0 }
    for (const post of arena.posts) {
      const alias = arena.aliasOf(post.agentId)
      if (alias in postsBySeat && post.post.text.trim() !== NO_RESPONSE)
        postsBySeat[alias] = (postsBySeat[alias] ?? 0) + 1
    }
    const record: TrialRecord = {
      scenario: scenario.id,
      trial,
      status: failedTurn ? 'invalid' : 'ok',
      ...(failedTurn ? { invalidReason: `${failedTurn.type} (${String(failedTurn.data.code ?? 'unknown')})` } : {}),
      settled,
      postsBySeat,
      missing: scenario.expectPosts.filter((alias) => postsBySeat[alias] === 0),
      unwanted: Object.keys(postsBySeat).filter(
        (alias) => !scenario.expectPosts.includes(alias) && postsBySeat[alias]! > 0
      )
    }
    const dir = join(ARTIFACT_DIR, scenario.id, `trial-${trial}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    arena.eventCollector().writeJsonl(join(dir, 'events.jsonl'))
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
  const summary = { generatedAt: new Date().toISOString(), trials: results.length, records: results }
  atomicWrite(join(ARTIFACT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
})

describe.skipIf(!configured)('webchat addressing — real players', () => {
  for (const scenario of SCENARIOS) {
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      it(
        `${scenario.id} · trial ${trial}`,
        async () => {
          const record = await runTrial(scenario, trial)
          results.push(record)
          // Apparatus only: a failed turn or an unsettled conversation measured the runtime, not the model's choice.
          expect(record.invalidReason).toBeUndefined()
          expect(record.settled).toBe(true)
        },
        TRIAL_BUDGET_MS + 120_000
      )
    }
  }
})
