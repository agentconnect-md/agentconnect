import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClusterSkillReconcileAuthority, ClusterSkillLedger } from '../store/cluster-skill-ledger.js'
import type { ClusterSkillClient } from '../shim/skill-client.js'
import {
  ClusterSkillReconcileResultSchema,
  type ClusterSkillFile,
  type ClusterSkillSkippedSource,
  type GitSkillPlan,
  type SkillCredentialWindowGrant,
  type SkillWriteBackCandidate
} from '../shim/skill-protocol.js'
import { inspectLocalSkillSource, type SkillSourceSnapshotLimits } from './skill-source-snapshot.js'

export interface ClusterSkillSnapshotSource {
  sourceId: string
  sourceKind: 'agent' | 'managed' | 'dream'
  sourceDir: string
  selections: string[]
  expectedLeaves: string[]
  /** Admission for THIS source — a Git collection needs the wide profile, a lone bundle the default. */
  limits?: Partial<SkillSourceSnapshotLimits>
}

/** What one reconcile installs: a source the daemon uploads, or a Git plan entry the pod clones itself. */
export type ClusterSkillReconcileSource = ClusterSkillSnapshotSource | GitSkillPlan

/** A source the manifest budget dropped is pruned, not preserved, so it keeps its resolution and is not re-acquired next time. */
export function isBudgetSkip(entry: Pick<ClusterSkillSkippedSource, 'code'>): boolean {
  return entry.code === 'limits_exceeded'
}

const isGitPlan = (source: ClusterSkillReconcileSource): source is GitSkillPlan => source.sourceKind === 'git'

export function clusterSkillSupportRequired(input: {
  configuredSources: number
  managedBindings: number
  acceptedDreamSources: number
  priorRoots: number
}): boolean {
  return (
    input.configuredSources > 0 || input.managedBindings > 0 || input.acceptedDreamSources > 0 || input.priorRoots > 0
  )
}

export interface ClusterSkillJournalStore {
  beginClusterSkillReconcile(
    input: ClusterSkillReconcileAuthority & { desiredHash: string; replayKey: string }
  ): Promise<
    | {
        ok: true
        operationId: string
        replayKey: string
        priorRevision: number
        priorLedger: ClusterSkillLedger
        resumed: boolean
      }
    | { ok: false; reason: 'lost_authority' }
  >
  commitClusterSkillReconcile(
    input: ClusterSkillReconcileAuthority & { priorRevision: number; ledger: ClusterSkillLedger }
  ): Promise<{ ok: true; revision: number } | { ok: false; reason: 'lost_authority' }>
  authorizeClusterSkillMutation(input: ClusterSkillReconcileAuthority & { priorRevision: number }): Promise<boolean>
}

export class ClusterSkillCoordinator {
  constructor(private readonly store: ClusterSkillJournalStore) {}

  async reconcile(input: {
    authority: Omit<ClusterSkillReconcileAuthority, 'operationId'>
    skillsAgentId: string
    shimGeneration: number
    sources: ClusterSkillReconcileSource[]
    gitResolutions?: NonNullable<ClusterSkillLedger['gitResolutions']>
    client: ClusterSkillClient
    initialLedger?: ClusterSkillLedger
    isLaunchCurrent?: () => boolean
    /** The pod-subject window a Git plan's private Sources fill through; only its capability is sent. */
    credentialWindow?: SkillCredentialWindowGrant
    /** Told the usable write-back candidates once the ledger commits; every other offered handle is discarded here. */
    onWriteBackCandidates?: (candidates: SkillWriteBackCandidate[]) => void
    /** Told the journaled desired hash once the run is journaled, so a fallback can resume this operation. */
    onJournaled?: (desiredHash: string) => void
    /** Journal under a failed run's desired hash: the store resumes its operation and the shim replays its own publication. */
    journalAs?: string
  }): Promise<ClusterSkillLedger & { skipped?: ClusterSkillSkippedSource[] }> {
    if (input.isLaunchCurrent && !input.isLaunchCurrent()) {
      throw new Error('cluster skill reconciliation targets a stale sandbox launch')
    }
    const operationId = randomUUID()
    const sources = [...input.sources]
    if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) {
      throw new Error('cluster skill sources contain duplicate identities')
    }
    // Descriptors only: buffering a widened source here would strain a 2 GiB pool daemon, so each body is re-read at upload.
    const files: ClusterSkillFile[] = []
    const uploaded = sources.filter((source): source is ClusterSkillSnapshotSource => !isGitPlan(source))
    const plans = new Map(sources.filter(isGitPlan).map((plan) => [plan.sourceId, plan]))
    const sourceDirs = new Map(uploaded.map((source) => [source.sourceId, source.sourceDir]))
    for (const source of uploaded) {
      const inspected = await inspectLocalSkillSource(source.sourceDir, { limits: source.limits })
      for (const file of inspected.files) {
        files.push({
          sourceId: source.sourceId,
          path: file.path.replaceAll('\\', '/'),
          size: file.size,
          sha256: file.sha256.replace(/^sha256:/, ''),
          ...(input.client.fileModes ? { executable: (file.mode & 0o111) !== 0 } : {})
        })
      }
    }
    const desiredHash = createHash('sha256')
      .update(
        JSON.stringify({
          // A presigned GET or a write-back request changes per run but not what installs; a planned commit does.
          sources: sources.map((source) => {
            if (isGitPlan(source)) {
              const { getUrl: _getUrl, writeBack: _writeBack, ...plan } = source
              return plan
            }
            const { sourceDir: _sourceDir, limits: _limits, ...rest } = source
            return rest
          }),
          files
        })
      )
      .digest('hex')
    const begun = await this.store.beginClusterSkillReconcile({
      ...input.authority,
      operationId,
      desiredHash: input.journalAs ?? desiredHash,
      replayKey: randomBytes(32).toString('hex')
    })
    if (!begun.ok) throw new Error('cluster skill reconciliation lost duty authority')
    input.onJournaled?.(input.journalAs ?? desiredHash)
    const authority = { ...input.authority, operationId: begun.operationId }
    const { handle } = await input.client.begin({
      operationId: authority.operationId,
      authority: { ...input.authority, shimGeneration: input.shimGeneration },
      skillsAgentId: input.skillsAgentId,
      files
    })
    // Re-read at upload time. A body that changed since inspection fails the shim's own digest
    // check against this descriptor, so streaming costs no safety.
    for (const file of files) {
      const body = await readFile(join(sourceDirs.get(file.sourceId)!, ...file.path.split('/')))
      await input.client.upload(authority.operationId, handle, file, body)
    }
    if (!(await this.store.authorizeClusterSkillMutation({ ...authority, priorRevision: begun.priorRevision }))) {
      throw new Error('cluster skill reconciliation lost duty authority')
    }
    const reply = ClusterSkillReconcileResultSchema.parse(
      await input.client.reconcile({
        operationId: authority.operationId,
        handle,
        authority: { ...input.authority, shimGeneration: input.shimGeneration },
        priorRoots:
          begun.priorRevision === 0 ? (input.initialLedger ?? begun.priorLedger).roots : begun.priorLedger.roots,
        replayKey: begun.replayKey,
        allowDesiredAdoption: false,
        sources: sources.map((source) =>
          isGitPlan(source)
            ? source
            : { sourceId: source.sourceId, sourceKind: source.sourceKind, selections: source.selections }
        ),
        ...(input.credentialWindow && plans.size > 0 ? { credentialWindow: input.credentialWindow } : {})
      })
    )
    // Every offered handle is either handed on after the commit or discarded, whatever happens below.
    const offered = reply.writeBackCandidates ?? []
    const discard = (candidates: SkillWriteBackCandidate[]): void => {
      for (const { handle } of candidates) void input.client.writeBack?.discard(handle).catch(() => undefined)
    }
    let handedOn: SkillWriteBackCandidate[] = []
    try {
      const result = await this.settle(input, { reply, sources, plans, begun, authority })
      handedOn = result.writeBack
      return result.ledger
    } finally {
      discard(offered.filter((candidate) => !handedOn.includes(candidate)))
    }
  }

  private async settle(
    input: Parameters<ClusterSkillCoordinator['reconcile']>[0],
    run: {
      reply: ReturnType<typeof ClusterSkillReconcileResultSchema.parse>
      sources: ClusterSkillReconcileSource[]
      plans: Map<string, GitSkillPlan>
      begun: { priorRevision: number; priorLedger: ClusterSkillLedger }
      authority: ClusterSkillReconcileAuthority
    }
  ): Promise<{
    ledger: ClusterSkillLedger & { skipped?: ClusterSkillSkippedSource[] }
    writeBack: SkillWriteBackCandidate[]
  }> {
    const { reply, sources, plans, begun, authority } = run
    if (reply.conflicts.length > 0) throw new Error('cluster skill ownership conflict')
    if (input.isLaunchCurrent && !input.isLaunchCurrent()) {
      throw new Error('cluster skill reconciliation targets a stale sandbox launch')
    }
    // A Git plan Source installs under the ledger kind `agent`, as the daemon path records it.
    const expectedKinds = new Map(
      sources.map((source) => [source.sourceId, isGitPlan(source) ? ('agent' as const) : source.sourceKind])
    )
    // The daemon's planned commit is the ledger's authority; a pod that reports another one has its Source treated as skipped.
    const gitResults = new Map<string, { leaves: string[] }>()
    const mismatched: ClusterSkillSkippedSource[] = []
    for (const result of reply.gitSources ?? []) {
      const plan = plans.get(result.sourceId)
      if (!plan || gitResults.has(result.sourceId))
        throw new Error('cluster skill shim reported an unexpected Git source')
      gitResults.set(result.sourceId, { leaves: result.leaves })
      if (result.resolvedCommit !== plan.plannedCommit) {
        mismatched.push({
          sourceId: result.sourceId,
          reason: 'the sandbox reported a commit other than the planned one',
          code: 'commit_unavailable'
        })
      }
    }
    // A skipped source must be one this run asked for; its untouched prior roots skip the selection check.
    const skipped = [...(reply.skipped ?? [])]
    const skippedIds = new Set<string>()
    for (const entry of skipped) {
      if (!expectedKinds.has(entry.sourceId) || skippedIds.has(entry.sourceId)) {
        throw new Error('cluster skill shim skipped an unexpected source')
      }
      skippedIds.add(entry.sourceId)
    }
    for (const entry of mismatched) {
      if (skippedIds.has(entry.sourceId)) throw new Error('cluster skill shim skipped an unexpected source')
      skipped.push(entry)
      skippedIds.add(entry.sourceId)
    }
    // With a skip the shim preserves prior roots, admitted only exactly as the prior ledger recorded them.
    const priorRoots =
      begun.priorRevision === 0 ? (input.initialLedger ?? begun.priorLedger).roots : begun.priorLedger.roots
    const preservedPrior = new Set(
      skipped.length > 0 ? priorRoots.map((root) => `${root.path}\0${root.sourceId}\0${root.sourceKind}`) : []
    )
    const returnedSelections = new Map<string, Set<string>>()
    for (const root of reply.roots) {
      const expected = expectedKinds.get(root.sourceId)
      if (expected === undefined || expected !== root.sourceKind) {
        if (preservedPrior.has(`${root.path}\0${root.sourceId}\0${root.sourceKind}`)) continue
        throw new Error('cluster skill shim returned an unexpected source receipt')
      }
      const selected = returnedSelections.get(root.sourceId) ?? new Set<string>()
      selected.add(root.path.split('/').at(-1)!)
      returnedSelections.set(root.sourceId, selected)
    }
    const leavesMatch = (sourceId: string, leaves: readonly string[]): boolean => {
      const returned = returnedSelections.get(sourceId) ?? new Set<string>()
      return leaves.every((leaf) => returned.has(leaf)) && returned.size === new Set(leaves).size
    }
    for (const source of sources) {
      if (skippedIds.has(source.sourceId)) continue
      if (isGitPlan(source)) {
        // The pod resolved the selections, so its reported leaves are what the receipt must hold.
        const result = gitResults.get(source.sourceId)
        if (!result || !leavesMatch(source.sourceId, result.leaves)) {
          throw new Error('cluster skill shim returned an incomplete Git source receipt')
        }
        continue
      }
      if (source.expectedLeaves.length === 0) continue
      if (!leavesMatch(source.sourceId, source.expectedLeaves)) {
        throw new Error('cluster skill shim returned an incomplete selection receipt')
      }
    }
    if (reply.writeBackCandidates?.some((candidate) => !plans.has(candidate.sourceId))) {
      throw new Error('cluster skill shim offered write-back for an unexpected source')
    }
    // Usable only for an installed Source whose plan asked, at exactly the planned branch and commit; the rest are discarded.
    const offeredOnce = new Set<string>()
    const usable = (reply.writeBackCandidates ?? []).filter((candidate) => {
      const plan = plans.get(candidate.sourceId)!
      if (offeredOnce.has(candidate.sourceId)) return false
      offeredOnce.add(candidate.sourceId)
      return (
        plan.writeBack !== undefined &&
        !skippedIds.has(candidate.sourceId) &&
        candidate.branch === plan.ref &&
        candidate.commit === plan.plannedCommit
      )
    })
    // A skipped Git source loses its resolution so it is retried; a budget drop was pruned and keeps it, so it is not re-acquired.
    const skippedGitPrefixes = skipped
      .filter((entry) => !isBudgetSkip(entry))
      .map((entry) => /^agent:\d+:([0-9a-f]+):/.exec(entry.sourceId)?.[1])
      .filter((digest): digest is string => digest !== undefined)
    const gitResolutions = (input.gitResolutions ?? []).filter(
      (resolution) => !skippedGitPrefixes.includes(resolution.definitionDigest)
    )
    const ledger = { roots: reply.roots, gitResolutions }
    const committed = await this.store.commitClusterSkillReconcile({
      ...authority,
      priorRevision: begun.priorRevision,
      ledger
    })
    if (!committed.ok) throw new Error('cluster skill reconciliation lost duty authority')
    if (input.isLaunchCurrent && !input.isLaunchCurrent()) {
      throw new Error('cluster skill reconciliation targets a stale sandbox launch')
    }
    let writeBack = input.onWriteBackCandidates ? usable : []
    try {
      if (writeBack.length > 0) input.onWriteBackCandidates!(writeBack)
    } catch {
      // Write-back never fails a committed reconcile; its handles are discarded instead.
      writeBack = []
    }
    // `skipped` only when something was: the committed ledger and the returned value stay equal otherwise.
    return { ledger: skipped.length > 0 ? { ...ledger, skipped } : ledger, writeBack }
  }
}
