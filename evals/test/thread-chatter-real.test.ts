// Thread chatter on a real subject (#4186): reported, never asserted; not in CI — see evals/README.md "Real-model scenarios".
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { atomicWrite } from '../../packages/daemon/src/evaluation/index.js'
import { CHATTER_SCENARIOS, TICKETING_ROLE, runThreadChatter } from '../response-choice/thread-chatter.js'

const subjectRoot = process.env.AGENTCONNECT_EVAL_SUBJECT_ROOT?.trim()
const templateAgents = (process.env.AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
const configured = Boolean(subjectRoot) && templateAgents.length > 0
const TRIALS = Number(process.env.AGENTCONNECT_EVAL_TRIALS ?? '3')
const ARTIFACT_DIR = join(process.cwd(), '.artifacts', 'evaluation', 'thread-chatter')

interface TrialRecord {
  scenario: string
  trial: number
  status: string
  valid: boolean
  errorCode?: string
  unwantedReplies?: number
  chatterLines?: number
  missedReplies?: number
  addressedLines?: number
}

const results: TrialRecord[] = []

afterAll(() => {
  if (results.length === 0) return
  mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 })
  // Counts only: replies stay in each trial's own artifact directory.
  const summary = { generatedAt: new Date().toISOString(), trials: results.length, records: results }
  atomicWrite(join(ARTIFACT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
})

describe.skipIf(!configured)('thread chatter — real subject', () => {
  for (const [scenario, lines] of Object.entries(CHATTER_SCENARIOS)) {
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      it(
        `${scenario} · trial ${trial}`,
        async () => {
          const result = await runThreadChatter({
            seed: trial,
            lines,
            artifactDir: join(ARTIFACT_DIR, scenario, `trial-${trial}`),
            subject: { kind: 'real', subjectRoot: subjectRoot!, templateAgentIds: templateAgents },
            agentDescription: TICKETING_ROLE
          })
          const metrics = result.verdict.metrics as Record<string, number> | undefined
          results.push({
            scenario,
            trial,
            status: result.status,
            valid: result.valid && result.verdict.refereeConsistent === true,
            ...(result.error ? { errorCode: result.error.code } : {}),
            ...(metrics
              ? {
                  unwantedReplies: metrics.unwantedReplies,
                  chatterLines: metrics.chatterLines,
                  missedReplies: metrics.missedReplies,
                  addressedLines: metrics.addressedLines
                }
              : {})
          })
          // Apparatus only: every line must reach the agent, or the trial measured routing, not the model.
          expect(result.error).toBeUndefined()
          expect(result.verdict.refereeConsistent).toBe(true)
        },
        15 * 60_000 + 120_000
      )
    }
  }
})
