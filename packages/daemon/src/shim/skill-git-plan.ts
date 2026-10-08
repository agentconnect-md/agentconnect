import { mkdir } from 'node:fs/promises'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV, GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { GITCRED_HOSTS_ENV, GITHUB_MANAGED_HOST, encodeManagedHostTable } from '../gitcred/managed-hosts.js'
import { resolveSkillSelections } from '../skills/skill-cli-selection.js'
import type { SkillSourceSnapshotLimits } from '../skills/skill-source-snapshot.js'
import {
  SkillGitAbortedError,
  acquireSkillGitSource,
  type SkillGitBundleOutcome,
  type SkillGitCredential,
  type SkillGitRunner
} from './skill-git-acquire.js'
import type { ClusterSkillSource, GitSkillPlan, SkillCredentialWindowGrant, SkillSkipCode } from './skill-protocol.js'

// The shim side of a Git plan reconcile (source-cache.md §8): acquire each Git Source in-pod, then charge one manifest budget.

/** In-pod Git clones at once per reconcile: each is a network round trip, but each also holds a staging tree on disk. */
export const SKILL_GIT_PLAN_CONCURRENCY = 4
/** One Git spawn's deadline in-pod, far below S4's default so a stalled remote costs minutes, not the reconcile. */
export const SKILL_GIT_PLAN_SPAWN_TIMEOUT_MS = 2 * 60_000
/** One Source's whole acquisition (clone, fetch, read-tree); its expiry skips that Source as `fetch_failed`. */
export const SKILL_GIT_PLAN_SOURCE_TIMEOUT_MS = 4 * 60_000
/** Every Source's acquisition together; well under SKILLS_RECONCILE_TIMEOUT_MS so the CLI stage and receipt still fit. */
export const SKILL_GIT_PLAN_DEADLINE_MS = 8 * 60_000

export interface SkillGitPlanDeps {
  /** The in-pod gitcred helper Git runs for a credentialed Source. */
  credentialHelper: string
  /** The gitcred tunnel socket that helper dials. */
  credentialSocket: string
  git?: SkillGitRunner
  shimEnv?: Record<string, string | undefined>
  /** Per spawn; defaults to {@link SKILL_GIT_PLAN_SPAWN_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Per Source; defaults to {@link SKILL_GIT_PLAN_SOURCE_TIMEOUT_MS}. */
  sourceTimeoutMs?: number
  /** Whole acquisition phase; defaults to {@link SKILL_GIT_PLAN_DEADLINE_MS}. */
  deadlineMs?: number
  limits?: Partial<SkillSourceSnapshotLimits>
  /** Test only: admit `file://` beside https. */
  allowFileProtocol?: boolean
  log?: { warn(message: string): void }
}

export type GitPlanOutcome =
  | {
      kind: 'acquired'
      plan: GitSkillPlan
      root: string
      commit: string
      fileCount: number
      totalBytes: number
      cliSelections: string[]
      expectedLeaves: string[]
      /** The clone's work tree and how it read the cache, kept until the reconcile ends for a write-back bundle. */
      repo: string
      bundle: SkillGitBundleOutcome
      writeBackRef?: string
    }
  | { kind: 'keep'; plan: GitSkillPlan }
  | { kind: 'skipped'; plan: GitSkillPlan; code: SkillSkipCode; reason: string }

export interface AcquireGitPlanInput {
  plans: GitSkillPlan[]
  /** The private 0700 directory a Source's acquisition stages under; the caller removes it. */
  stagingFor(sourceId: string): string
  agentId: string
  window?: SkillCredentialWindowGrant
  deps: SkillGitPlanDeps
  abort: AbortSignal
}

const shellQuoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** The credential a Source's Git child gets: only with a window and only for github.com, the one P2 host. */
export function skillGitCredentialFor(
  plan: GitSkillPlan,
  window: SkillCredentialWindowGrant | undefined,
  agentId: string,
  deps: Pick<SkillGitPlanDeps, 'credentialHelper' | 'credentialSocket'>
): SkillGitCredential | undefined {
  if (!window || new URL(plan.url).origin !== GITHUB_MANAGED_HOST.baseUrl) return undefined
  return {
    host: GITHUB_MANAGED_HOST.baseUrl,
    helper: `!sh ${shellQuoted(deps.credentialHelper)} ${shellQuoted(agentId)}`,
    env: {
      [GITCRED_CAPABILITY_ENV]: window.capability,
      [GITCRED_AGENT_ENV]: agentId,
      [GITCRED_SOCKET_ENV]: deps.credentialSocket,
      [GITCRED_HOSTS_ENV]: encodeManagedHostTable([GITHUB_MANAGED_HOST])
    }
  }
}

const isAbort = (err: unknown): boolean =>
  err instanceof SkillGitAbortedError || (err instanceof Error && err.name === 'AbortError')

const timedOut = (plan: GitSkillPlan): GitPlanOutcome => ({
  kind: 'skipped',
  plan,
  code: 'fetch_failed',
  reason: 'fetching the repository timed out'
})

async function acquireOne(input: AcquireGitPlanInput, plan: GitSkillPlan, phase: AbortSignal): Promise<GitPlanOutcome> {
  if (plan.keepInstalled) return { kind: 'keep', plan }
  if (input.abort.aborted) throw new SkillGitAbortedError('skill Git acquisition was cancelled')
  if (phase.aborted) return timedOut(plan)
  const { deps } = input
  const stagingRoot = input.stagingFor(plan.sourceId)
  const credential = skillGitCredentialFor(plan, input.window, input.agentId, deps)
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), deps.sourceTimeoutMs ?? SKILL_GIT_PLAN_SOURCE_TIMEOUT_MS)
  const signal = AbortSignal.any([input.abort, phase, deadline.signal])
  try {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
    const acquired = await acquireSkillGitSource({
      plan,
      stagingRoot,
      abort: signal,
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.shimEnv ? { shimEnv: deps.shimEnv } : {}),
      ...(credential ? { credential } : {}),
      timeoutMs: deps.timeoutMs ?? SKILL_GIT_PLAN_SPAWN_TIMEOUT_MS,
      ...(deps.limits ? { limits: deps.limits } : {}),
      ...(deps.allowFileProtocol ? { allowFileProtocol: true } : {}),
      ...(deps.log ? { log: deps.log } : {})
    })
    if (acquired.kind === 'skipped') return { kind: 'skipped', plan, code: acquired.code, reason: acquired.reason }
    // Defense in depth (S4 already installs only plannedCommit): a pod-local commit is never trusted beyond the plan.
    if (acquired.commit !== plan.plannedCommit) {
      return { kind: 'skipped', plan, code: 'commit_unavailable', reason: 'the acquired commit is not the planned one' }
    }
    try {
      const selected = await resolveSkillSelections(
        plan.sourceId,
        acquired.root,
        acquired.snapshot.files,
        plan.selections
      )
      return {
        kind: 'acquired',
        plan,
        root: acquired.root,
        commit: acquired.commit,
        fileCount: acquired.snapshot.fileCount,
        totalBytes: acquired.snapshot.totalBytes,
        cliSelections: selected.cliSelections,
        expectedLeaves: selected.expectedLeaves,
        repo: acquired.repo,
        bundle: acquired.bundle,
        ...(acquired.writeBackRef ? { writeBackRef: acquired.writeBackRef } : {})
      }
    } catch (err) {
      deps.log?.warn(`skill git ${plan.sourceId}: selection failed: ${(err as Error).message}`)
      return { kind: 'skipped', plan, code: 'cli_failed', reason: 'the selected skills could not be resolved' }
    }
  } catch (err) {
    if (input.abort.aborted) throw err
    // A Source or phase deadline aborts only this Source's spawns: it is skipped, never the reconcile.
    if (signal.aborted) {
      deps.log?.warn(`skill git ${plan.sourceId}: acquisition timed out`)
      return timedOut(plan)
    }
    if (isAbort(err)) throw err
    deps.log?.warn(`skill git ${plan.sourceId}: acquisition failed: ${(err as Error).message}`)
    return { kind: 'skipped', plan, code: 'fetch_failed', reason: 'fetching the repository failed' }
  } finally {
    clearTimeout(timer)
  }
}

/** Acquire every Git plan Source, a few at once; outcomes come back in plan order and a failure costs only its Source. */
export async function acquireGitPlanSources(input: AcquireGitPlanInput): Promise<GitPlanOutcome[]> {
  const outcomes: GitPlanOutcome[] = new Array(input.plans.length)
  const phase = new AbortController()
  const timer = setTimeout(() => phase.abort(), input.deps.deadlineMs ?? SKILL_GIT_PLAN_DEADLINE_MS)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < input.plans.length) {
      const index = next++
      outcomes[index] = await acquireOne(input, input.plans[index]!, phase.signal)
    }
  }
  try {
    // Every lane settles before the caller removes staging, so none recreates a directory after that.
    const lanes = await Promise.allSettled(
      Array.from({ length: Math.min(SKILL_GIT_PLAN_CONCURRENCY, input.plans.length) }, worker)
    )
    const failed = lanes.find((lane): lane is PromiseRejectedResult => lane.status === 'rejected')
    if (failed) throw failed.reason
    return outcomes
  } finally {
    clearTimeout(timer)
  }
}

export interface SkillBudgetCharge {
  sourceId: string
  sourceKind: ClusterSkillSource['sourceKind']
  fileCount: number
  totalBytes: number
}

// The daemon path's order (daemon.ts reconcileSandboxSkills): Git Sources first, then managed, then Dream.
const budgetRank = (kind: ClusterSkillSource['sourceKind']): number =>
  kind === 'git' || kind === 'agent' ? 0 : kind === 'managed' ? 1 : 2

/** Charge ONE manifest budget in the daemon path's order; returns the source ids that did not fit. */
export function chargeSkillManifestBudget(
  charges: SkillBudgetCharge[],
  limits: { maxFiles: number; maxTotalBytes: number }
): Set<string> {
  let files = 0
  let bytes = 0
  const dropped = new Set<string>()
  const ordered = charges.map((charge, index) => ({ charge, index }))
  ordered.sort((a, b) => budgetRank(a.charge.sourceKind) - budgetRank(b.charge.sourceKind) || a.index - b.index)
  for (const { charge } of ordered) {
    if (files + charge.fileCount > limits.maxFiles || bytes + charge.totalBytes > limits.maxTotalBytes) {
      dropped.add(charge.sourceId)
      continue
    }
    files += charge.fileCount
    bytes += charge.totalBytes
  }
  return dropped
}
