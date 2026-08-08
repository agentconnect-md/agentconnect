import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AfterAllExtensionHookContext, EvaluateResult } from 'promptfoo'
import { afterAll, EVALUATION_SUMMARY_SCHEMA_VERSION } from '../extensions/paired-summary.js'
import outcome from '../assertions/outcome.js'
import { describe, expect, it } from 'vitest'

function evalResult(treatment: string, score: number): EvaluateResult {
  return {
    promptIdx: 0,
    testIdx: 0,
    testCase: {},
    promptId: 'prompt',
    provider: { id: `provider-${treatment}`, label: treatment },
    prompt: { label: 'case', raw: '{{case}}' },
    vars: {},
    response: {
      output: 'safe output',
      metadata: {
        caseId: 'memory-collab-handoff',
        treatment: { name: treatment },
        runId: `run-${treatment}`,
        status: 'passed',
        artifacts: { manifest: `/restricted/${treatment}/run.json` }
      }
    },
    failureReason: 0,
    success: true,
    score,
    latencyMs: 1,
    namedScores: { outcome: score }
  }
}

describe('Promptfoo paired evaluation reporting', () => {
  it('writes treatment means, paired deltas, statuses, and evidence paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-evaluation-summary-'))
    const outputPath = join(root, 'paired-summary.json')
    const previous = process.env.AGENTCONNECT_EVAL_SUMMARY_PATH
    process.env.AGENTCONNECT_EVAL_SUMMARY_PATH = outputPath
    const failed = evalResult('failed-control', 0)
    failed.response!.metadata!.status = 'infra_error'
    failed.error = 'SENSITIVE RAW PROVIDER OUTPUT'
    try {
      await afterAll({
        evalId: 'eval-7319',
        results: [evalResult('raw-acp', 0.3), evalResult('daemon-core', 0.2), evalResult('memory-only', 0.6), failed],
        prompts: [],
        suite: {} as AfterAllExtensionHookContext['suite'],
        config: {}
      })
    } finally {
      if (previous === undefined) delete process.env.AGENTCONNECT_EVAL_SUMMARY_PATH
      else process.env.AGENTCONNECT_EVAL_SUMMARY_PATH = previous
    }

    const summary = JSON.parse(readFileSync(outputPath, 'utf8'))
    expect(summary).toMatchObject({
      schemaVersion: EVALUATION_SUMMARY_SCHEMA_VERSION,
      evalId: 'eval-7319',
      cases: {
        'memory-collab-handoff': {
          treatments: {
            'memory-only': { meanScore: 0.6, validTrials: 1, statuses: { passed: 1 } }
          },
          deltas: {
            core: -0.1,
            memory: 0.4
          }
        }
      }
    })
    expect(statSync(outputPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(outputPath, 'utf8')).not.toContain('SENSITIVE RAW PROVIDER OUTPUT')
  })

  it('scores expected-low controls without failing the Promptfoo assertion', async () => {
    expect(
      await outcome('no remembered value', {
        prompt: undefined,
        vars: { expected: 'COBALT-HARBOR-7319' },
        test: {},
        logProbs: undefined,
        provider: undefined,
        providerResponse: undefined
      })
    ).toMatchObject({ pass: true, score: 0 })
  })
})
