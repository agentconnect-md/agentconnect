import {
  CODE_HOST_PROVIDERS,
  DecisionQuestion,
  isCodeHostProvider,
  REPO_CANDIDATE_DESCRIPTION_MAX,
  REPO_CANDIDATES_MAX,
  type DecisionEvaluation,
  type RepoCandidatesReply
} from '@agentconnect.md/protocol'
import { z } from 'zod'
import { DECISION_REQUEST_MAX_BYTES, decisionRequestBody } from './evaluator.js'

/** At most this many selected repositories are materialized for one session (multi-repository-workspaces.md decision 17). */
export const REPO_SELECTION_MAX = 5
/** Candidates per Choice question: the 32-option limit less the `none` option (decision 15). */
export const REPO_SELECTION_CHUNK = 31
/** Chunks evaluated at once — the evaluator's own active cap, so a batch never answers `capacity` to itself. */
export const REPO_SELECTION_CONCURRENCY = 4
/** A roster reply serves this long, the CP page cache's own TTL, unless the agent's authorizations change first. */
export const REPO_CANDIDATES_CACHE_MS = 5 * 60_000
/** The option that says the request is about none of the chunk's repositories. */
export const REPO_SELECTION_NONE = 'none'
const INSTRUCTIONS =
  'Choose the repositories this request is about: each option whose repository the request concerns, or none when it is about none of these.'
const NONE_TEXT = 'None of these repositories: the request is not about any of them.'

/** One repository the selector chose for a session, as the session's snapshot records it (decision 19). */
export const SelectedRepository = z.object({
  provider: z.enum(CODE_HOST_PROVIDERS),
  repoFullName: z.string().min(1),
  repoId: z.string().min(1)
})
export type SelectedRepository = z.infer<typeof SelectedRepository>
export const SelectedRepositories = z.array(SelectedRepository)

/** One candidate as the question offers it: a `decision` row of the spec, or a roster entry the CP answered. */
export interface RepoSelectionCandidate extends SelectedRepository {
  description?: string
}

/** One Choice question and the candidates its `r1…rN` keys stand for, in that order. */
export interface RepoSelectionChunk {
  candidates: readonly RepoSelectionCandidate[]
  question: DecisionQuestion
}

export type RepoSelectionResult =
  { selected: SelectedRepository[] } | { unavailable: Extract<DecisionEvaluation, { status: 'unavailable' }>['reason'] }

type AuthorizationRow = { repoFullName: string; repoId: string; provider?: string; materialize?: string }
type InstallationGrant = { accountLogin: string; provider?: string; materialize?: string }
type SelectorAgent = {
  workspace: { additionalRepos?: readonly AuthorizationRow[]; additionalInstallations?: readonly InstallationGrant[] }
  repositorySelector?: { providerId: string; model: string } | null
}

/** Whether any authorization asks for the selector (decision 13): a row or a grant marked `decision`. */
export function hasDecisionAuthorizations(agent: SelectorAgent): boolean {
  return (
    (agent.workspace.additionalRepos ?? []).some((row) => row.materialize === 'decision') || hasDecisionGrants(agent)
  )
}

/** Whether an installation grant is marked `decision`, which is what makes the roster a candidate source. */
export function hasDecisionGrants(agent: SelectorAgent): boolean {
  return (agent.workspace.additionalInstallations ?? []).some((grant) => grant.materialize === 'decision')
}

/** What a cached roster depends on, so a reply is dropped once the spec's authorizations or selector change. */
export function repoSelectionConfiguration(agent: SelectorAgent): string {
  return JSON.stringify([
    (agent.workspace.additionalRepos ?? []).map((row) => [
      row.provider ?? 'github',
      row.repoId,
      row.repoFullName,
      row.materialize ?? 'always'
    ]),
    (agent.workspace.additionalInstallations ?? []).map((grant) => [
      grant.provider ?? 'github',
      grant.accountLogin,
      grant.materialize ?? 'on-demand'
    ]),
    agent.repositorySelector ?? null
  ])
}

/** The session's candidates (decision 15): the `decision` rows first, then the roster, deduplicated by host and id and cut to the reply's own bound. */
export function repoSelectionCandidates(
  rows: readonly AuthorizationRow[],
  roster: RepoCandidatesReply | undefined
): { candidates: RepoSelectionCandidate[]; partial: boolean } {
  const seen = new Set<string>()
  const candidates: RepoSelectionCandidate[] = []
  let partial = roster?.partial ?? false
  // False only when the cap cut this entry; a host this build has no module for, or a repeat, is skipped.
  const add = (entry: { provider: string; repoFullName: string; repoId: string; description?: string }): boolean => {
    const { provider } = entry
    if (!isCodeHostProvider(provider) || seen.has(`${provider}:${entry.repoId}`)) return true
    if (candidates.length >= REPO_CANDIDATES_MAX) return false
    seen.add(`${provider}:${entry.repoId}`)
    const description = entry.description?.trim()
    candidates.push({
      provider,
      repoFullName: entry.repoFullName,
      repoId: entry.repoId,
      ...(description ? { description } : {})
    })
    return true
  }
  for (const row of rows) {
    if (row.materialize !== 'decision') continue
    if (!add({ ...row, provider: row.provider ?? 'github' })) {
      partial = true
      break
    }
  }
  for (const entry of roster?.candidates ?? []) {
    if (!add(entry)) {
      partial = true
      break
    }
  }
  return { candidates, partial }
}

/** One Choice question per chunk of at most {@link REPO_SELECTION_CHUNK} candidates plus `none`, keyed `r1…rN` since a full name can exceed the key limit, each trimmed until the whole question fits its limit. */
export function repoSelectionChunks(candidates: readonly RepoSelectionCandidate[]): RepoSelectionChunk[] {
  const chunks: RepoSelectionChunk[] = []
  for (let start = 0; start < candidates.length; start += REPO_SELECTION_CHUNK) {
    const chunk = candidates.slice(start, start + REPO_SELECTION_CHUNK)
    chunks.push({ candidates: chunk, question: questionFor(chunk) })
  }
  return chunks
}

function questionFor(chunk: readonly RepoSelectionCandidate[]): DecisionQuestion {
  // Descriptions are halved until the question parses (its refine is the 16 KiB limit); names alone always fit.
  for (let max = REPO_CANDIDATE_DESCRIPTION_MAX; ; max = Math.floor(max / 2)) {
    const criteria: Record<string, string> = {}
    chunk.forEach((candidate, index) => {
      const description = candidate.description?.slice(0, max).trim()
      criteria[`r${index + 1}`] = description ? `${candidate.repoFullName}: ${description}` : candidate.repoFullName
    })
    criteria[REPO_SELECTION_NONE] = NONE_TEXT
    const question = DecisionQuestion.safeParse({ type: 'choice', instructions: INSTRUCTIONS, criteria })
    if (question.success) return question.data
    if (max === 0) throw new Error(`repository selection question is invalid: ${question.error.message}`)
  }
}

/** The state the selector sends (decision 16): the model-selection state plus `workspace.primary` and the candidates' own partial mark, or the opening alone when the largest question would not leave it within the request bound. */
export function repoSelectionState(
  base: Record<string, unknown>,
  opening: Record<string, unknown>,
  options: { primary?: string; partial: boolean },
  decision: { model: string; question: DecisionQuestion }
): Record<string, unknown> {
  const withWorkspace = (state: Record<string, unknown>): Record<string, unknown> => {
    const context = record(state.context)
    const reasons = Array.isArray(context?.reasons) ? [...(context.reasons as unknown[])] : []
    if (options.partial && !reasons.includes('candidates_truncated')) reasons.push('candidates_truncated')
    const partial = context?.partial === true || options.partial
    return {
      ...state,
      workspace: options.primary === undefined ? {} : { primary: options.primary },
      ...(context || options.partial ? { context: { ...context, partial, reasons } } : {})
    }
  }
  const full = withWorkspace(base)
  const bytes = Buffer.byteLength(decisionRequestBody({ decision, state: full }), 'utf8')
  return bytes <= DECISION_REQUEST_MAX_BYTES ? full : withWorkspace(opening)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Evaluate every chunk, at most {@link REPO_SELECTION_CONCURRENCY} at once, answering in chunk order. */
export async function evaluateChunks<C, T>(
  chunks: readonly C[],
  evaluate: (chunk: C, index: number) => Promise<T>
): Promise<T[]> {
  const results: T[] = new Array<T>(chunks.length)
  const pending = chunks.entries()
  await Promise.all(
    Array.from({ length: Math.min(REPO_SELECTION_CONCURRENCY, chunks.length) }, async () => {
      for (const [index, chunk] of pending) results[index] = await evaluate(chunk, index)
    })
  )
  return results
}

/** How long one chunk waits out the evaluator's shared slots before `capacity` fails the start (decision 18). */
export const REPO_SELECTION_CAPACITY_WAIT_MS = 15_000

/** Evaluate once, retrying only the evaluator's own `capacity` answer with backoff until the wait runs out: other Decision consumers share its slots, and no other refusal is retried. */
export async function evaluateWithCapacityWait(
  evaluate: () => Promise<DecisionEvaluation>,
  deps: { now: () => number; sleep: (ms: number) => Promise<void>; waitMs?: number }
): Promise<DecisionEvaluation> {
  const deadline = deps.now() + (deps.waitMs ?? REPO_SELECTION_CAPACITY_WAIT_MS)
  for (let attempt = 0; ; attempt++) {
    const evaluation = await evaluate()
    if (evaluation.status !== 'unavailable' || evaluation.reason !== 'capacity') return evaluation
    const remaining = deadline - deps.now()
    if (remaining <= 0) return evaluation
    await deps.sleep(Math.min(250 * 2 ** attempt, 2_000, remaining))
  }
}

/** Decision 17: within a chunk every option that beats `none` is a hit, hits are ordered by probability across chunks, and at most {@link REPO_SELECTION_MAX} are selected; any chunk without an answer makes the whole selection unavailable (decision 18). */
export function selectRepositories(
  chunks: readonly RepoSelectionChunk[],
  evaluations: readonly DecisionEvaluation[]
): RepoSelectionResult {
  const hits: { repo: SelectedRepository; probability: number; order: number }[] = []
  for (const [index, chunk] of chunks.entries()) {
    const evaluation = evaluations[index]
    if (evaluation === undefined) return { unavailable: 'invalid_response' }
    if (evaluation.status === 'unavailable') return { unavailable: evaluation.reason }
    const { answer } = evaluation
    if (answer.type !== 'choice') return { unavailable: 'invalid_response' }
    const none = answer.probabilities[REPO_SELECTION_NONE]
    if (none === undefined) return { unavailable: 'invalid_response' }
    chunk.candidates.forEach(({ provider, repoFullName, repoId }, position) => {
      const probability = answer.probabilities[`r${position + 1}`]
      if (probability !== undefined && probability > none)
        hits.push({ repo: { provider, repoFullName, repoId }, probability, order: hits.length })
    })
  }
  hits.sort((a, b) => b.probability - a.probability || a.order - b.order)
  return { selected: hits.slice(0, REPO_SELECTION_MAX).map((hit) => hit.repo) }
}

/** A session's recorded selection, or undefined when the row has none or it is unreadable. */
export function parseSelectedRepositories(snapshot: string | null | undefined): SelectedRepository[] | undefined {
  if (!snapshot) return undefined
  try {
    const parsed = SelectedRepositories.safeParse(JSON.parse(snapshot))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Whether two selections name the same repositories, whatever their order. */
export function sameSelection(a: readonly SelectedRepository[], b: readonly SelectedRepository[]): boolean {
  const identity = (repo: SelectedRepository): string => `${repo.provider}:${repo.repoId}`
  return a.length === b.length && a.every((repo) => b.some((other) => identity(other) === identity(repo)))
}

/** The identity a candidate, a root and a snapshot entry are compared by: the numeric id under its host. */
export function selectedRepoIdentity(repo: { provider: string; repoId: string }): string {
  return `${repo.provider}:${repo.repoId}`
}
