import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSkillEntry } from '@agentconnect.md/protocol'
import type { ClusterSkillClient } from '../shim/skill-client.js'
import {
  GitSkillPlanSchema,
  MAX_CLUSTER_SKILL_CONTROL_BYTES,
  type ClusterSkillSkippedSource,
  type GitSkillPlan,
  type SkillWriteBackCandidate
} from '../shim/skill-protocol.js'
import { MAX_BUNDLE_BYTES } from '../shim/bundle-protocol.js'
import type { SkillSourceCachePlan, SkillWriteBackIntent } from '../source-cache/skill-write-back.js'
import { MAX_SKILL_BUNDLES } from './skill-limits.js'
import type { ClusterSkillLedger, ClusterSkillReconcileAuthority } from '../store/cluster-skill-ledger.js'
import {
  ClusterSkillCoordinator,
  isBudgetSkip,
  type ClusterSkillJournalStore,
  type ClusterSkillReconcileSource,
  type ClusterSkillSnapshotSource
} from './cluster-skill-coordinator.js'
import {
  currentGitResolutions,
  gitResolutionDigest,
  resolveTrackedCommits,
  retainedAfterTracking,
  type LocalSkillSource
} from './install-skills.js'
import { resolveSkillSelections } from './skill-cli-selection.js'
import { gitSkillRepositoryPath, resolveBoundedGitSkillSource } from './skill-git-source.js'
import type { SkillRefPlan } from './skill-ref-resolution.js'
import { GIT_SKILL_SOURCE_SNAPSHOT_LIMITS, inspectLocalSkillSource } from './skill-source-snapshot.js'

// One sandbox skill reconcile (source-cache.md §8): Git Sources acquired by the daemon, or planned for an image that clones them in-pod.

export interface SandboxSkillTarget {
  authority: Omit<ClusterSkillReconcileAuthority, 'operationId'>
  skillsAgentId: string
  shimGeneration: number
  client: ClusterSkillClient
  initialLedger?: ClusterSkillLedger
  isLaunchCurrent: () => boolean
}

/** What the in-pod path needs beyond the daemon path; present only for a pod granted `skills-git`. */
export interface InPodSkillDeps {
  /** The daemon's own resolution: a planned commit is never a pod's answer. */
  resolve(entry: AgentSkillEntry): Promise<SkillRefPlan>
  /** The pod serves the gitcred tunnel; without it, private Sources take the daemon path this reconcile. */
  servesGitcred: boolean
  /** A pod-subject credential window over exactly these private repositories, or undefined. */
  openWindow(repos: string[]): { capability: string; close(): void } | undefined
  /** Whether `openWindow` would admit this private repository; one it would not takes the daemon path. */
  windowAdmits(repo: string): boolean
  /** With a bucket: a presigned GET of the Source's own access class, and a write-back intent when `writeBack` allows one. */
  cachePlan?(
    entry: AgentSkillEntry,
    resolution: SkillRefPlan,
    options: { writeBack: boolean }
  ): Promise<SkillSourceCachePlan>
  /** A Source only the daemon path can fill, e.g. a public entry naming a repository the agent capability grants. */
  daemonOnly?(entry: AgentSkillEntry): boolean
}

export interface SandboxSkillReconcileDeps {
  store: ClusterSkillJournalStore
  log: { info(message: string): void; warn(message: string): void }
  /** The commit a tracking ref points at now, or null when unknown. */
  trackedCommit(entry: AgentSkillEntry): Promise<string | null>
  /** The daemon path: acquire a Git Source at `plannedCommit` (or its ref) under `destination`. */
  acquire(
    entry: AgentSkillEntry,
    plannedCommit: string | undefined,
    destination: string
  ): Promise<{ sourceDir: string; resolvedCommit: string }>
  inPod?: InPodSkillDeps
}

export interface SandboxSkillReconcileInput {
  agentId: string
  /** The agent's entries as replicated; one without a numeric repository id predates current admission. */
  skills: ReadonlyArray<Omit<AgentSkillEntry, 'githubRepoId'> & { githubRepoId?: string }>
  managed: LocalSkillSource[]
  dreamed: LocalSkillSource[]
  priorLedger?: ClusterSkillLedger
  target: SandboxSkillTarget
}

export type SandboxSkillReconcileResult = ClusterSkillLedger & { skipped?: ClusterSkillSkippedSource[] }

interface ConfiguredGitSource {
  index: number
  entry: AgentSkillEntry
}

/** The reconcile frame's room for everything but Git plan entries, so plans without GET URLs always fit (§13). */
const PLAN_FRAME_RESERVE_BYTES = 16 * 1024
const WIDEST_WRITE_BACK = { maxBytes: MAX_BUNDLE_BYTES, stale: true as const }

const gitSourceId = (index: number, digest: string, commit: string): string => `agent:${index}:${digest}:${commit}`

/** Install an agent's skills into a sandbox; an in-pod reconcile that fails before its ledger commits falls back to the daemon path. */
export async function reconcileSandboxSkillSources(
  deps: SandboxSkillReconcileDeps,
  input: SandboxSkillReconcileInput
): Promise<SandboxSkillReconcileResult> {
  const configured = input.skills.flatMap((entry, index) => {
    if (!entry.githubRepoId) return []
    const parsed = AgentSkillEntry.safeParse(entry)
    if (parsed.success && parsed.data.githubRepoId) return [{ index, entry: parsed.data }]
    deps.log.warn(`skills: omitted historical Git source ${index + 1}; it fails current installation admission`)
    return []
  })
  let journaled: string | undefined
  if (deps.inPod && input.target.client.gitInPod && configured.length > 0) {
    try {
      return await reconcileOnce(deps, input, configured, deps.inPod, (hash) => (journaled = hash))
    } catch (error) {
      // A stale launch fails either path alike; anything else is the image's, and older-image behavior still serves.
      if (!input.target.isLaunchCurrent()) throw error
      deps.log.warn(
        `skills: in-pod Git skill install failed for ${input.agentId}; acquiring through the daemon and re-uploading every source (${(error as Error).message})`
      )
    }
  }
  // Resuming the failed run's operation lets the shim replay whatever it already published instead of calling it foreign.
  return await reconcileOnce(deps, input, configured, undefined, undefined, journaled)
}

interface PodPlan {
  plans: Map<number, GitSkillPlan>
  /** Resolved commits the plans install, by definition digest. */
  commits: Map<string, string>
  /** Sources that neither route can install this run, named for the log. */
  unresolved: ConfiguredGitSource[]
  privateRepos: string[]
  /** The daemon's write-back intent per plan source id; a candidate for any other Source is discarded. */
  writeBacks: Map<string, SkillWriteBackIntent>
  /** Plan source ids the pod-subject window credentials. */
  privateSourceIds: string[]
}

async function reconcileOnce(
  deps: SandboxSkillReconcileDeps,
  input: SandboxSkillReconcileInput,
  configured: ConfiguredGitSource[],
  inPod: InPodSkillDeps | undefined,
  onJournaled?: (desiredHash: string) => void,
  journalAs?: string
): Promise<SandboxSkillReconcileResult> {
  const { client } = input.target
  const scratch = await mkdtemp(join(tmpdir(), 'agentconnect-cluster-skills-'))
  let window: { capability: string; close(): void } | undefined
  try {
    const pod = inPod ? await planInPod(deps, input, configured, inPod) : undefined
    const daemonRouted = configured.filter(
      ({ index }) => !pod?.plans.has(index) && !pod?.unresolved.some((u) => u.index === index)
    )
    // ONE budget for the uploaded manifest, spent in source order; a Git plan's share is charged by the pod.
    const admits = client.manifestLimits
    let admittedFiles = 0
    let admittedBytes = 0
    const admit = (fileCount: number, totalBytes: number): void => {
      if (admittedFiles + fileCount > admits.maxFiles || admittedBytes + totalBytes > admits.maxTotalBytes) {
        throw new Error(`it does not fit the remaining skill manifest budget (${fileCount} files)`)
      }
      admittedFiles += fileCount
      admittedBytes += totalBytes
    }
    const trackedCommits = await resolveTrackedCommits(
      daemonRouted.map(({ entry }) => entry),
      (entry) => deps.trackedCommit(entry)
    )
    for (const [digest, commit] of pod?.commits ?? []) trackedCommits.set(digest, commit)
    const resolutionsByDefinition = new Map(
      retainedAfterTracking(
        currentGitResolutions(
          configured.map(({ entry }) => entry),
          input.priorLedger?.gitResolutions ?? []
        ),
        trackedCommits
      ).map((resolution) => [resolution.definitionDigest, resolution.resolvedCommit])
    )
    for (const [digest, commit] of pod?.commits ?? []) resolutionsByDefinition.set(digest, commit)
    // Every daemon acquisition is its own network round trip, so they run at once; results are taken in source order.
    const acquisitions = new Map(
      daemonRouted.map(({ index, entry }) => {
        const plannedCommit =
          trackedCommits.get(gitResolutionDigest(entry)) ?? resolutionsByDefinition.get(gitResolutionDigest(entry))
        const acquiring = deps.acquire(entry, plannedCommit, join(scratch, `git-${index}`))
        // Settled here so a failed source is reported in its turn below, never as an unhandled rejection.
        return [
          index,
          acquiring.then(
            (acquired) => ({ ok: true as const, acquired, plannedCommit }),
            (error: unknown) => ({ ok: false as const, error })
          )
        ] as const
      })
    )
    await Promise.all(acquisitions.values())
    const gitSources: ClusterSkillReconcileSource[] = []
    for (const { index, entry } of configured) {
      const plan = pod?.plans.get(index)
      if (plan) {
        gitSources.push(plan)
        continue
      }
      const pending = acquisitions.get(index)
      if (!pending) continue
      try {
        const definitionDigest = gitResolutionDigest(entry)
        const outcome = await pending
        if (!outcome.ok) throw outcome.error
        const { acquired, plannedCommit } = outcome
        const resolvedCommit = acquired.resolvedCommit.toLowerCase()
        if (!/^[a-f0-9]{40}$/.test(resolvedCommit) || (plannedCommit && resolvedCommit !== plannedCommit)) {
          throw new Error(`Git source "${entry.name}" did not resolve to its planned commit`)
        }
        resolutionsByDefinition.set(definitionDigest, resolvedCommit)
        const inspected = await inspectLocalSkillSource(acquired.sourceDir, {
          limits: GIT_SKILL_SOURCE_SNAPSHOT_LIMITS
        })
        const selected = await resolveSkillSelections(entry.name, acquired.sourceDir, inspected.files, entry.skills)
        // Charged last, so a source this `try` goes on to reject never spends budget later ones need.
        admit(inspected.fileCount, inspected.totalBytes)
        gitSources.push({
          sourceId: gitSourceId(index, definitionDigest, resolvedCommit),
          sourceKind: 'agent',
          sourceDir: acquired.sourceDir,
          selections: selected.cliSelections,
          expectedLeaves: selected.expectedLeaves,
          limits: GIT_SKILL_SOURCE_SNAPSHOT_LIMITS
        })
      } catch (error) {
        deps.log.warn(`skills: Git source ${entry.name} unavailable for ${input.agentId} (${(error as Error).message})`)
      }
    }
    for (const { entry } of pod?.unresolved ?? []) {
      deps.log.warn(
        `skills: Git source ${entry.name} unresolved and not installed for ${input.agentId}; skipped this preparation`
      )
    }
    const localSource = async (source: LocalSkillSource): Promise<ClusterSkillSnapshotSource[]> => {
      try {
        const inspected = await inspectLocalSkillSource(source.sourceDir)
        admit(inspected.fileCount, inspected.totalBytes)
      } catch (error) {
        deps.log.warn(`skills: ${source.kind} source ${source.name} unavailable for ${input.agentId} (${error})`)
        return []
      }
      return [
        {
          sourceId: source.key,
          sourceKind: source.kind,
          sourceDir: source.sourceDir,
          selections: [source.name],
          expectedLeaves: [source.name]
        }
      ]
    }
    // Managed then Dream, each sorted within its group: the seam applies later-source precedence.
    const localSources: ClusterSkillSnapshotSource[] = []
    for (const group of [input.managed, input.dreamed]) {
      for (const source of [...group].sort((a, b) => a.key.localeCompare(b.key))) {
        localSources.push(...(await localSource(source)))
      }
    }
    const sources = [...gitSources, ...localSources]
    const gitResolutions = currentGitResolutions(
      configured.map(({ entry }) => entry),
      [...resolutionsByDefinition].map(([definitionDigest, resolvedCommit]) => ({ definitionDigest, resolvedCommit }))
    )
    window = pod && pod.privateRepos.length > 0 ? inPod!.openWindow(pod.privateRepos) : undefined
    const writeBacks = pod?.writeBacks
    // A private Source cloned without a window carried no credential, so it never writes back as `cred`.
    const unwritten = new Set(window ? [] : (pod?.privateSourceIds ?? []))
    for (const sourceId of unwritten) writeBacks?.delete(sourceId)
    const stager = client.writeBack
    const reconciled = await new ClusterSkillCoordinator(deps.store).reconcile({
      ...input.target,
      // Nor does the pod bundle it for nothing.
      sources: unwritten.size === 0 ? sources : sources.map((source) => withoutWriteBack(source, unwritten)),
      gitResolutions,
      ...(window ? { credentialWindow: { capability: window.capability } } : {}),
      ...(writeBacks && writeBacks.size > 0 && stager
        ? { onWriteBackCandidates: (candidates) => void writeBackInOrder(candidates, writeBacks, stager, deps.log) }
        : {}),
      ...(onJournaled ? { onJournaled } : {}),
      ...(journalAs ? { journalAs } : {})
    })
    logSkipped(deps, input, configured, sources, reconciled.skipped ?? [])
    return reconciled
  } finally {
    // The window never outlives its reconcile, whatever the outcome.
    window?.close()
    await rm(scratch, { recursive: true, force: true })
  }
}

function withoutWriteBack<T extends { sourceId: string; writeBack?: unknown }>(source: T, ids: Set<string>): T {
  if (!('writeBack' in source) || !ids.has(source.sourceId)) return source
  const { writeBack: _dropped, ...rest } = source
  return rest as T
}

// Fire-and-forget after the ledger committed, one at a time so a reconcile never crowds the writer; every handle is spent.
async function writeBackInOrder(
  candidates: SkillWriteBackCandidate[],
  intents: Map<string, SkillWriteBackIntent>,
  stager: NonNullable<ClusterSkillClient['writeBack']>,
  log: SandboxSkillReconcileDeps['log']
): Promise<void> {
  for (const candidate of candidates) {
    const intent = intents.get(candidate.sourceId)
    try {
      if (intent) await intent.write(candidate, stager)
      else await stager.discard(candidate.handle)
    } catch (error) {
      log.warn(`skills: write-back of ${candidate.sourceId} did not run (${(error as Error).message})`)
    }
  }
}

// Named per source so the operator can fix the repository; the session goes on without it.
function logSkipped(
  deps: SandboxSkillReconcileDeps,
  input: SandboxSkillReconcileInput,
  configured: ConfiguredGitSource[],
  sources: ClusterSkillReconcileSource[],
  skipped: ClusterSkillSkippedSource[]
): void {
  const sourceNames = new Map(configured.map(({ index, entry }) => [`agent:${index}:`, entry.name] as const))
  for (const entry of skipped) {
    const name =
      [...sourceNames].find(([prefix]) => entry.sourceId.startsWith(prefix))?.[1] ??
      sources.find((source) => source.sourceId === entry.sourceId)?.selections.join(',') ??
      entry.sourceId
    const outcome = isBudgetSkip(entry) ? 'not installed' : 'keeping what is installed'
    deps.log.warn(`skills: source ${name} skipped for ${input.agentId}; ${outcome} (${entry.reason})`)
  }
}

/** Resolve, route and plan the in-pod Sources: origin policy first, then the frame bound, then GET URLs. */
async function planInPod(
  deps: SandboxSkillReconcileDeps,
  input: SandboxSkillReconcileInput,
  configured: ConfiguredGitSource[],
  inPod: InPodSkillDeps
): Promise<PodPlan> {
  const routed = configured.filter(({ entry }) => {
    if (inPod.daemonOnly?.(entry)) return false
    // A pod without the gitcred tunnel, or a repo no window would admit, cannot fill a private Source; the daemon path still can.
    if (entry.private !== true) return true
    const repo = gitSkillRepositoryPath(entry)?.toLowerCase()
    return inPod.servesGitcred && repo !== undefined && inPod.windowAdmits(repo)
  })
  const resolutions = await Promise.all(routed.map(({ entry }) => inPod.resolve(entry)))
  const priorCommits = new Map(
    currentGitResolutions(
      configured.map(({ entry }) => entry),
      input.priorLedger?.gitResolutions ?? []
    ).map((resolution) => [resolution.definitionDigest, resolution.resolvedCommit])
  )
  const priorIds = new Set((input.priorLedger ?? input.target.initialLedger)?.roots.map((root) => root.sourceId) ?? [])
  const drafts: Array<{ source: ConfiguredGitSource; plan: GitSkillPlan; resolution: SkillRefPlan }> = []
  const unresolved: ConfiguredGitSource[] = []
  // Only a pod granted `skills-git-writeback`, with a bucket to write to, is asked to bundle anything.
  const writeBackPossible = input.target.client.writeBack !== undefined && inPod.cachePlan !== undefined
  for (const [position, source] of routed.entries()) {
    const { index, entry } = source
    const resolution = resolutions[position]!
    const digest = gitResolutionDigest(entry)
    let commit: string
    let keepInstalled = false
    if (resolution.ok) commit = resolution.commit
    else {
      // §5: an installed Source keeps its installed commit with no GET URL; one never installed waits for the next preparation.
      const prior = priorCommits.get(digest)
      if (prior === undefined || !priorIds.has(gitSourceId(index, digest, prior))) {
        unresolved.push(source)
        continue
      }
      commit = prior
      keepInstalled = true
    }
    // The daemon's origin policy runs here, before any URL reaches the pod.
    const parsed = resolveBoundedGitSkillSource(entry)
    const ref = resolution.ok && !resolution.pinned ? resolution.ref : undefined
    // The widest write-back request is measured with the plan; the real one, or none, replaces it below.
    const writeBack =
      writeBackPossible && !keepInstalled && ref?.startsWith('refs/heads/') ? WIDEST_WRITE_BACK : undefined
    const candidate = GitSkillPlanSchema.safeParse({
      sourceId: gitSourceId(index, digest, commit),
      sourceKind: 'git',
      url: parsed.cloneUrl,
      ...(ref ? { ref } : {}),
      plannedCommit: commit,
      ...(parsed.subDir ? { subDir: parsed.subDir } : {}),
      selections: [...entry.skills],
      ...(keepInstalled ? { keepInstalled: true } : {}),
      ...(writeBack ? { writeBack } : {})
    })
    if (!candidate.success) {
      deps.log.warn(`skills: Git source ${entry.name} cannot be planned for the sandbox; the daemon acquires it`)
      continue
    }
    drafts.push({ source, plan: candidate.data, resolution })
  }
  // Bound the plan without GET URLs, so dropping every URL always yields a frame that fits; the overflow takes the daemon path.
  let budget = MAX_CLUSTER_SKILL_CONTROL_BYTES - PLAN_FRAME_RESERVE_BYTES - otherSourcesBytes(input, configured, drafts)
  let used = 0
  const fitted: typeof drafts = []
  // A dropped plan comes back as an uploaded entry, so its uploaded form is charged too; popping converges since a plan outweighs its upload.
  const drop = (draft: (typeof drafts)[number]): void => {
    budget -= uploadedGitEntryBytes(draft.source)
  }
  for (const draft of drafts) {
    const size = planBytes(draft.plan)
    if (used + size <= budget) {
      fitted.push(draft)
      used += size
      continue
    }
    drop(draft)
    while (used > budget && fitted.length > 0) {
      const popped = fitted.pop()!
      used -= planBytes(popped.plan)
      drop(popped)
    }
  }
  if (fitted.length < drafts.length) {
    deps.log.warn(
      `skills: ${drafts.length - fitted.length} Git source(s) exceed the sandbox plan frame; the daemon acquires them`
    )
  }
  const plans = new Map<number, GitSkillPlan>()
  const commits = new Map<string, string>()
  const privateRepos = new Set<string>()
  const writeBacks = new Map<string, SkillWriteBackIntent>()
  await Promise.all(
    fitted.map(async ({ source, plan, resolution }) => {
      const { writeBack: _widest, ...planned } = plan
      const cache = plan.keepInstalled
        ? undefined
        : await inPod
            .cachePlan?.(source.entry, resolution, { writeBack: plan.writeBack !== undefined })
            .catch(() => undefined)
      const intent = plan.writeBack ? cache?.writeBack : undefined
      if (intent) writeBacks.set(plan.sourceId, intent)
      plans.set(source.index, {
        ...planned,
        ...(cache?.getUrl ? { getUrl: cache.getUrl } : {}),
        ...(intent
          ? { writeBack: { maxBytes: intent.maxBytes, ...(intent.stale ? { stale: true as const } : {}) } }
          : {})
      })
    })
  )
  const privateSourceIds: string[] = []
  for (const { source, plan } of fitted) {
    commits.set(gitResolutionDigest(source.entry), plan.plannedCommit)
    const repo = gitSkillRepositoryPath(source.entry)
    if (source.entry.private === true && !plan.keepInstalled && repo) {
      privateRepos.add(repo.toLowerCase())
      privateSourceIds.push(plan.sourceId)
    }
  }
  return { plans, commits, unresolved, privateRepos: [...privateRepos], writeBacks, privateSourceIds }
}

function planBytes(plan: GitSkillPlan): number {
  return Buffer.byteLength(JSON.stringify(plan)) + 1
}

// One Git Source's uploaded entry before dependency expansion; PLAN_FRAME_RESERVE_BYTES absorbs the expansion.
function uploadedGitEntryBytes({ index, entry }: ConfiguredGitSource): number {
  return Buffer.byteLength(JSON.stringify(uploadedGitEntry(index, entry))) + 1
}

function uploadedGitEntry(index: number, entry: ConfiguredGitSource['entry']) {
  return { sourceId: gitSourceId(index, 'f'.repeat(64), 'f'.repeat(40)), sourceKind: 'agent', selections: entry.skills }
}

// An upper bound on the uploaded sources' reconcile entries and the frame's fixed fields.
function otherSourcesBytes(
  input: SandboxSkillReconcileInput,
  configured: ConfiguredGitSource[],
  drafts: Array<{ source: ConfiguredGitSource }>
): number {
  const planned = new Set(drafts.map(({ source }) => source.index))
  const uploadedGit = configured
    .filter(({ index }) => !planned.has(index))
    .map(({ index, entry }) => uploadedGitEntry(index, entry))
  const local = [...input.managed, ...input.dreamed].map((source) => ({
    sourceId: source.key,
    sourceKind: source.kind,
    selections: [source.name]
  }))
  return Buffer.byteLength(
    JSON.stringify({
      authority: input.target.authority,
      priorRootCount: MAX_SKILL_BUNDLES,
      sources: [...uploadedGit, ...local]
    })
  )
}
