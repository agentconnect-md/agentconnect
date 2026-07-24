import { resolve } from 'node:path'
import type { AfterAllExtensionHookContext, EvaluateResult } from 'promptfoo'
import { atomicWrite } from '../../packages/daemon/src/evaluation/index.js'

export const EVALUATION_SUMMARY_SCHEMA_VERSION = 'agentconnect.eval-summary/v1' as const

interface TrialEvidence {
  provider: string
  treatment: string
  status: string
  score?: number
  runId?: string
  artifacts?: Record<string, string>
}

interface TreatmentSummary {
  meanScore?: number
  validTrials: number
  statuses: Record<string, number>
  trials: TrialEvidence[]
}

function finiteScore(result: EvaluateResult): number | undefined {
  const score = result.namedScores.outcome ?? result.score
  return Number.isFinite(score) ? score : undefined
}

function treatmentOf(result: EvaluateResult): string | undefined {
  const treatment = result.response?.metadata?.treatment
  return treatment && typeof treatment === 'object' && typeof treatment.name === 'string' ? treatment.name : undefined
}

function caseOf(result: EvaluateResult): string | undefined {
  return typeof result.response?.metadata?.caseId === 'string' ? result.response.metadata.caseId : undefined
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
}

function delta(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : roundMetric(left - right)
}

function roundMetric(value: number): number {
  return Number(value.toFixed(12))
}

/** Write one compact, content-free paired report next to the restricted run
 * artifacts. Raw prompts and outputs remain in the per-trial evidence only. */
export async function afterAll(context: AfterAllExtensionHookContext): Promise<void> {
  const grouped = new Map<string, Map<string, TrialEvidence[]>>()
  for (const result of context.results) {
    const caseId = caseOf(result)
    const treatment = treatmentOf(result)
    if (!caseId || !treatment) continue
    const status =
      typeof result.response?.metadata?.status === 'string'
        ? result.response.metadata.status
        : result.error
          ? 'grader_error'
          : 'passed'
    const artifacts = result.response?.metadata?.artifacts
    const evidence: TrialEvidence = {
      provider: result.provider.label ?? result.provider.id ?? 'unknown',
      treatment,
      status,
      ...(finiteScore(result) !== undefined ? { score: finiteScore(result) } : {}),
      ...(typeof result.response?.metadata?.runId === 'string' ? { runId: result.response.metadata.runId } : {}),
      ...(artifacts && typeof artifacts === 'object' ? { artifacts: artifacts as Record<string, string> } : {})
    }
    const byTreatment = grouped.get(caseId) ?? new Map<string, TrialEvidence[]>()
    const trials = byTreatment.get(treatment) ?? []
    trials.push(evidence)
    byTreatment.set(treatment, trials)
    grouped.set(caseId, byTreatment)
  }
  if (grouped.size === 0) return

  const cases = Object.fromEntries(
    [...grouped.entries()].map(([caseId, treatmentTrials]) => {
      const treatments = Object.fromEntries(
        [...treatmentTrials.entries()].map(([treatment, trials]) => {
          const validScores = trials
            .filter((trial) => trial.status === 'passed' && trial.score !== undefined)
            .map((trial) => trial.score!)
          const statuses: Record<string, number> = {}
          for (const trial of trials) statuses[trial.status] = (statuses[trial.status] ?? 0) + 1
          const summary: TreatmentSummary = {
            ...(mean(validScores) !== undefined ? { meanScore: mean(validScores) } : {}),
            validTrials: validScores.length,
            statuses,
            trials
          }
          return [treatment, summary]
        })
      )
      const score = (name: string) => (treatments[name] as TreatmentSummary | undefined)?.meanScore
      const deltas = {
        core: delta(score('daemon-core'), score('raw-acp')),
        memory: delta(score('memory-only'), score('daemon-core')),
        collaboration: delta(score('collaboration-only'), score('daemon-core')),
        interaction:
          score('both') === undefined ||
          score('memory-only') === undefined ||
          score('collaboration-only') === undefined ||
          score('daemon-core') === undefined
            ? undefined
            : roundMetric(score('both')! - score('memory-only')! - score('collaboration-only')! + score('daemon-core')!)
      }
      return [
        caseId,
        {
          treatments,
          deltas: Object.fromEntries(Object.entries(deltas).filter(([, value]) => value !== undefined))
        }
      ]
    })
  )
  const defaultPath = resolve(
    process.env.AGENTCONNECT_EVAL_ARTIFACT_ROOT?.trim() || '.artifacts/evaluation',
    'promptfoo',
    context.evalId,
    'paired-summary.json'
  )
  const outputPath = resolve(process.env.AGENTCONNECT_EVAL_SUMMARY_PATH?.trim() || defaultPath)
  atomicWrite(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: EVALUATION_SUMMARY_SCHEMA_VERSION,
        evalId: context.evalId,
        generatedAt: new Date().toISOString(),
        cases
      },
      null,
      2
    )}\n`
  )
  console.log(`AgentConnect paired summary: ${outputPath}`)
}
