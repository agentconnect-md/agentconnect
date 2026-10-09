import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { inspectLocalSkillSource } from '../skills/skill-source-snapshot.js'
import { ClusterSkillLedgerSchema } from '../store/cluster-skill-ledger.js'
import { PINNED_SKILLS_CLI_VERSION, stageSkillsCliCell } from '../skills/skills-cli-cell.js'
import {
  reconcileSkillBundles,
  hasSkillPublicationOperation,
  publishedSkillSetUnchanged,
  skillBundleReceiptIntact,
  treeDigest,
  type CandidateSkillBundle
} from '../skills/skill-install-ledger.js'
import {
  ClusterSkillRequestSchema,
  ClusterSkillReconcileReplySchema,
  ClusterSkillReconcileResultSchema,
  isGitPlanReconcile,
  skillReceiptPage,
  skillReplyFor,
  MAX_CLUSTER_SKILL_FILES,
  MAX_CLUSTER_SKILL_SOURCES,
  MAX_CLUSTER_SKILL_TOTAL_BYTES,
  type ClusterSkillBegin,
  type ClusterSkillBeginReply,
  type ClusterSkillFile,
  type ClusterSkillManifest,
  type ClusterSkillManifestReply,
  type ClusterSkillReconcile,
  type ClusterSkillReconcileReply,
  type ClusterSkillUpload,
  type ClusterSkillUploadReply,
  type ClusterSkillVerifyReply,
  type ClusterSkillPrior,
  type ClusterSkillPriorReply,
  type ClusterSkillReceipt,
  type ClusterSkillReceiptPage,
  type ClusterSkillSkippedSource,
  type GitSkillPlan,
  type GitSkillSourceResult,
  type SkillWriteBackCandidate
} from './skill-protocol.js'
import {
  acquireGitPlanSources,
  chargeSkillManifestBudget,
  type GitPlanOutcome,
  type SkillGitPlanDeps
} from './skill-git-plan.js'
import { stageSkillWriteBacks, type SkillWriteBackStaging } from './skill-git-writeback.js'
import { DEFAULT_SHIM_PATHS } from './sandbox-paths.js'
import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'

interface Operation {
  handle: string
  operationId: string
  files: Map<string, ClusterSkillFile & { received: number; complete: boolean }>
  /** Set until the last manifest page lands; uploads and reconcile refuse a partial declaration. */
  pendingManifest: boolean
  declaredBytes: number
  skillsAgentId: string
  authority: ClusterSkillBegin['authority']
  abort: AbortController
  priorRoots: ClusterSkillReconcile['priorRoots']
  result?: ClusterSkillReconcileReply
}

export interface ClusterSkillRequestContext {
  agentId: string
  generation: number
}

export interface ClusterSkillHandlerDeps {
  stagingRoot: string
  workspaceRoot?: string
  stateRoot?: string
  inactiveMs?: number
  now?: () => number
  /** How a Git plan Source is cloned in-pod; the helper and socket default to the image's. */
  git?: Partial<SkillGitPlanDeps>
  /** The one manifest budget a Git plan reconcile charges; defaults to what a paging shim admits. */
  manifestLimits?: { maxFiles: number; maxTotalBytes: number }
  /** The bundle handler's staging, present only when this shim advertises `skill-git-writeback-v1`. */
  writeBack?: SkillWriteBackStaging
}

/** What this shim last published in full for its workspace; held in memory because the state dir is agent-writable. */
interface PublishedPlan {
  agentId: string
  skillsAgentId: string
  fingerprint: string
  uploads: string
  roots: ClusterSkillReconcile['priorRoots']
}

const sourceDirectory = (sourceId: string): string => createHash('sha256').update(sourceId).digest('hex')
const fileKey = (sourceId: string, path: string): string => `${sourceId}\0${path}`

export class ClusterSkillHandler {
  private readonly operations = new Map<string, Operation>()
  private readonly highestTerms = new Map<string, { term: string; daemonId: string }>()
  private published?: PublishedPlan
  private readonly inactiveMs: number
  private readonly now: () => number

  constructor(private readonly deps: ClusterSkillHandlerDeps) {
    this.inactiveMs = deps.inactiveMs ?? 30 * 60_000
    this.now = deps.now ?? Date.now
  }

  async handle(
    payload: unknown,
    abort?: AbortSignal,
    context?: ClusterSkillRequestContext
  ): Promise<
    | ClusterSkillBeginReply
    | ClusterSkillManifestReply
    | ClusterSkillUploadReply
    | ClusterSkillReconcileReply
    | ClusterSkillVerifyReply
    | ClusterSkillPriorReply
    | ClusterSkillReceiptPage
  > {
    const parsed = ClusterSkillRequestSchema.parse(payload)
    if (abort?.aborted) {
      if (parsed.op === 'upload') await this.discard(parsed.handle)
      throw new Error('cluster skill operation aborted')
    }
    if (parsed.op === 'begin') return await this.begin(parsed, context)
    if (parsed.op === 'manifest') return this.manifest(parsed)
    if (parsed.op === 'upload') return await this.upload(parsed, abort)
    if (parsed.op === 'prior') return this.prior(parsed, context)
    if (parsed.op === 'receipt') return this.receipt(parsed, context)
    if (parsed.op === 'verify') {
      if (!this.deps.workspaceRoot) throw new Error('cluster skill verification is unavailable')
      return {
        intact: await Promise.all(
          parsed.roots.map((root) =>
            skillBundleReceiptIntact(this.deps.workspaceRoot!, {
              relativeRoot: root.path,
              sourceKey: root.sourceId,
              treeDigest: root.digest,
              files: root.files
            })
          )
        )
      }
    }
    return await this.reconcile(parsed, abort, context)
  }

  stagedFile(handle: string, sourceId: string, path: string): string {
    return join(this.deps.stagingRoot, handle, sourceDirectory(sourceId), ...path.replaceAll('\\', '/').split('/'))
  }

  async gcInactive(): Promise<number> {
    await mkdir(this.deps.stagingRoot, { recursive: true, mode: 0o700 })
    let removed = 0
    for (const entry of await readdir(this.deps.stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(this.deps.stagingRoot, entry.name)
      const info = await stat(path)
      if (this.now() - info.mtimeMs <= this.inactiveMs) continue
      await this.discard(entry.name)
      removed++
    }
    return removed
  }

  private async begin(input: ClusterSkillBegin, context?: ClusterSkillRequestContext): Promise<ClusterSkillBeginReply> {
    this.assertBoundAuthority(input.authority, context)
    const current = this.highestTerms.get(input.authority.workspaceIncarnation)
    if (current && compareDecimalTerms(input.authority.term, current.term) < 0) {
      throw new Error('stale cluster skill duty term')
    }
    if (!current || compareDecimalTerms(input.authority.term, current.term) > 0) {
      for (const operation of this.operations.values()) {
        if (
          operation.authority.workspaceIncarnation === input.authority.workspaceIncarnation &&
          compareDecimalTerms(operation.authority.term, input.authority.term) < 0
        ) {
          operation.abort.abort()
        }
      }
      this.highestTerms.set(input.authority.workspaceIncarnation, {
        term: input.authority.term,
        daemonId: input.authority.daemonId
      })
    } else if (current.daemonId !== input.authority.daemonId) {
      throw new Error('cluster skill duty term belongs to another daemon')
    }
    await mkdir(this.deps.stagingRoot, { recursive: true, mode: 0o700 })
    const handle = randomBytes(24).toString('hex')
    await mkdir(join(this.deps.stagingRoot, handle), { mode: 0o700 })
    const operation: Operation = {
      handle,
      operationId: input.operationId,
      authority: input.authority,
      skillsAgentId: input.skillsAgentId,
      abort: new AbortController(),
      files: new Map(),
      pendingManifest: input.moreFiles === true,
      declaredBytes: 0,
      priorRoots: []
    }
    this.operations.set(handle, operation)
    this.declare(operation, input.files)
    return { handle }
  }

  /** Append one manifest page. Splitting it is what lets a whole collection repo be declared:
   *  every page is its own frame, and only the assembled set is bounded by the wire totals. */
  private manifest(input: ClusterSkillManifest): ClusterSkillManifestReply {
    const operation = this.operations.get(input.handle)
    if (!operation || operation.operationId !== input.operationId) {
      throw new Error('unknown cluster skill staging handle')
    }
    if (!operation.pendingManifest) throw new Error('cluster skill manifest is already complete')
    this.declare(operation, input.files)
    operation.pendingManifest = input.moreFiles
    return { declared: operation.files.size }
  }

  /** Enforce the totals no single page can see — count, bytes, sources, and duplicate paths. */
  private declare(operation: Operation, files: ClusterSkillFile[]): void {
    for (const file of files) {
      const key = fileKey(file.sourceId, file.path)
      if (operation.files.has(key)) throw new Error('duplicate cluster skill manifest file')
      operation.files.set(key, { ...file, received: 0, complete: false })
      operation.declaredBytes += file.size
    }
    if (operation.files.size > MAX_CLUSTER_SKILL_FILES) throw new Error('cluster skill manifest has too many files')
    if (operation.declaredBytes > MAX_CLUSTER_SKILL_TOTAL_BYTES) {
      throw new Error('cluster skill manifest exceeds its byte limit')
    }
    if (new Set([...operation.files.values()].map((file) => file.sourceId)).size > MAX_CLUSTER_SKILL_SOURCES) {
      throw new Error('cluster skill manifest has too many sources')
    }
  }

  private operationFor(
    input: { handle: string; operationId: string },
    context?: ClusterSkillRequestContext
  ): Operation {
    const operation = this.operations.get(input.handle)
    if (!operation || operation.operationId !== input.operationId)
      throw new Error('unknown cluster skill staging handle')
    this.assertBoundAuthority(operation.authority, context)
    const current = this.highestTerms.get(operation.authority.workspaceIncarnation)
    if (
      operation.abort.signal.aborted ||
      current?.term !== operation.authority.term ||
      current.daemonId !== operation.authority.daemonId
    )
      throw new Error('cluster skill reconciliation lost duty authority')
    return operation
  }

  private prior(input: ClusterSkillPrior, context?: ClusterSkillRequestContext): ClusterSkillPriorReply {
    const operation = this.operationFor(input, context)
    if (operation.result || input.offset !== operation.priorRoots.length)
      throw new Error('unexpected prior skill receipt offset')
    const roots = ClusterSkillLedgerSchema.parse({ roots: [...operation.priorRoots, ...input.roots] }).roots
    if (new Set(roots.map((root) => root.path)).size !== roots.length)
      throw new Error('duplicate prior skill receipt root')
    operation.priorRoots = roots
    return { received: roots.length }
  }

  private async receipt(
    input: ClusterSkillReceipt,
    context?: ClusterSkillRequestContext
  ): Promise<ClusterSkillReceiptPage> {
    const operation = this.operationFor(input, context)
    if (!operation.result) throw new Error('cluster skill receipt is not ready')
    const page = skillReceiptPage(operation.result, input.offset)
    if (page.nextOffset === undefined) await this.discard(input.handle)
    return page
  }

  private async reconcile(
    input: ClusterSkillReconcile,
    abort?: AbortSignal,
    context?: ClusterSkillRequestContext
  ): Promise<ClusterSkillReceiptPage> {
    const operation = this.operationFor(input, context)
    if (operation.result) throw new Error('cluster skill reconciliation is already complete')
    if (JSON.stringify(operation.authority) !== JSON.stringify(input.authority)) {
      throw new Error('cluster skill authority changed during staging')
    }
    if (input.priorRootCount !== undefined) {
      const roots = ClusterSkillLedgerSchema.parse({ roots: [...operation.priorRoots, ...input.priorRoots] }).roots
      if (roots.length !== input.priorRootCount) throw new Error('cluster skill prior receipt is incomplete')
      if (new Set(roots.map((root) => root.path)).size !== roots.length)
        throw new Error('duplicate prior skill receipt root')
      input = { ...input, priorRoots: roots }
    } else if (operation.priorRoots.length) {
      throw new Error('cluster skill prior receipt count is missing')
    }
    if (!this.deps.workspaceRoot || !this.deps.stateRoot) throw new Error('cluster skill publication is unavailable')
    if (operation.pendingManifest) throw new Error('cluster skill manifest is incomplete')
    if ([...operation.files.values()].some((file) => !file.complete))
      throw new Error('cluster skill snapshot is incomplete')
    if (abort?.aborted) return await this.fail(operation, 'cluster skill operation aborted')
    const mutationSignal = abort ? AbortSignal.any([abort, operation.abort.signal]) : operation.abort.signal
    const assertMutationAuthority = (): void => {
      const latest = this.highestTerms.get(input.authority.workspaceIncarnation)
      if (
        mutationSignal.aborted ||
        !latest ||
        latest.term !== input.authority.term ||
        latest.daemonId !== input.authority.daemonId
      ) {
        throw new Error('cluster skill reconciliation lost duty authority')
      }
    }
    const declaredSources = new Set([...operation.files.values()].map((file) => file.sourceId))
    if (input.sources.some((source) => source.sourceKind !== 'git' && !declaredSources.has(source.sourceId))) {
      throw new Error('reconcile source was not declared')
    }
    // A Git plan Source is cloned here, so uploaded files under its id would share its staging directory.
    if (input.sources.some((source) => source.sourceKind === 'git' && declaredSources.has(source.sourceId))) {
      throw new Error('a Git plan source must not be uploaded')
    }
    const gitPlan = isGitPlanReconcile(input)
    // A Git plan Source installs as the agent's own Git source, the kind the daemon path records.
    const sourceMeta = new Map(
      input.sources.map(
        (source) =>
          [source.sourceId, { sourceKind: source.sourceKind === 'git' ? 'agent' : source.sourceKind }] as const
      )
    )
    // A preserved prior root may carry an earlier revision's source id, so its kind comes from the prior receipt.
    const priorKinds = new Map(input.priorRoots.map((root) => [`${root.path}\0${root.sourceId}`, root.sourceKind]))
    const ownedRoot = (root: Omit<CandidateSkillBundle, 'sourceDir'>) => {
      const sourceKind =
        sourceMeta.get(root.sourceKey)?.sourceKind ?? priorKinds.get(`${root.relativeRoot}\0${root.sourceKey}`)
      if (!sourceKind) throw new Error('cluster skill publisher returned an unknown source')
      return {
        path: root.relativeRoot,
        sourceId: root.sourceKey,
        sourceKind,
        digest: root.treeDigest,
        files: root.files.map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 }))
      }
    }
    const candidates: CandidateSkillBundle[] = []
    const cleanups: Array<() => void> = []
    // Sources whose CLI stage failed: reported, and their prior roots left exactly as they are.
    const skipped: ClusterSkillSkippedSource[] = []
    // Sources the manifest budget dropped: reported, but pruned like the daemon path prunes them.
    const budgetDropped: ClusterSkillSkippedSource[] = []
    const gitSources: GitSkillSourceResult[] = []
    const gitStaging = (sourceId: string): string =>
      join(this.deps.stagingRoot, input.handle, sourceDirectory(sourceId))
    // Handles staged for write-back; dropped again unless the reply that names them is built.
    let writeBackCandidates: SkillWriteBackCandidate[] = []
    let replied = false
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(fingerprintSources(input.sources)))
      .digest('hex')
    const uploads = uploadsDigest(operation)
    try {
      const replayingPublication = await hasSkillPublicationOperation(
        this.deps.workspaceRoot,
        this.deps.stateRoot,
        input.operationId,
        input.replayKey
      )
      // An unchanged plan over an intact published set answers from its receipts: no clone, no CLI, no write-back.
      // The ledger keeps naming the last full publication on purpose: a lost reply retried here short-circuits again.
      if (gitPlan && !replayingPublication && (await this.unchanged(input, operation, fingerprint, uploads))) {
        assertMutationAuthority()
        const gitSources = input.sources
          .filter((source): source is GitSkillPlan => source.sourceKind === 'git')
          .map((plan) =>
            gitResult(
              plan,
              input.priorRoots
                .filter((root) => root.sourceId === plan.sourceId)
                .map((root) => root.path.split('/').at(-1)!)
            )
          )
        const reply = ClusterSkillReconcileResultSchema.parse(
          skillReplyFor(input, { roots: input.priorRoots, conflicts: [], gitSources })
        )
        return await this.answer(input, operation, reply, context)
      }
      // Cleared until this run publishes its whole plan again.
      this.published = undefined
      const git = gitPlan
        ? await this.acquireGitPlan(input, operation, mutationSignal)
        : new Map<string, GitPlanOutcome>()
      const dropped = gitPlan ? this.chargeBudget(input, operation, git) : new Set<string>()
      const kept: string[] = []
      const staging: Array<{
        source: ClusterSkillReconcile['sources'][number]
        snapshot: string
        selections: string[]
      }> = []
      for (const source of input.sources) {
        const outcome = git.get(source.sourceId)
        if (dropped.has(source.sourceId)) {
          budgetDropped.push({
            sourceId: source.sourceId,
            reason: 'it does not fit the remaining skill manifest budget',
            code: 'limits_exceeded'
          })
        } else if (!outcome) {
          staging.push({ source, snapshot: gitStaging(source.sourceId), selections: source.selections })
        } else if (outcome.kind === 'skipped') {
          skipped.push({ sourceId: source.sourceId, reason: outcome.reason, code: outcome.code })
        } else if (outcome.kind === 'keep') {
          // Resolution failed on an installed Source: its roots stay exactly as the prior receipt has them.
          const roots = input.priorRoots.filter((root) => root.sourceId === source.sourceId)
          if (roots.length === 0) {
            skipped.push({
              sourceId: source.sourceId,
              reason: 'no installed revision to keep',
              code: 'commit_unavailable'
            })
            continue
          }
          kept.push(...roots.map((root) => root.path))
          gitSources.push(
            gitResult(
              outcome.plan,
              roots.map((root) => root.path.split('/').at(-1)!)
            )
          )
        } else {
          staging.push({ source, snapshot: outcome.root, selections: outcome.cliSelections })
        }
      }
      // Each source stages in its own disposable CLI cell, so the cells run at once; results are taken in source order.
      const stagings = await Promise.all(
        staging.map(async ({ source, snapshot, selections }) => {
          const staged: CandidateSkillBundle[] = []
          try {
            const cell = await stageSkillsCliCell({
              sourceSnapshot: snapshot,
              agentId: operation.skillsAgentId,
              selectedSkills: selections
            })
            cleanups.push(cell.cleanup)
            for (const bundle of cell.bundles) {
              const inspected = await inspectLocalSkillSource(bundle.absolutePath)
              const files = inspected.files.map((file) => ({
                path: file.path,
                mode: file.mode & 0o111 ? 0o700 : 0o600,
                size: file.size,
                sha256: file.sha256.replace(/^sha256:/, '')
              }))
              staged.push({
                relativeRoot: bundle.relativePath,
                sourceKey: source.sourceId,
                sourceDir: bundle.absolutePath,
                files,
                treeDigest: treeDigest(files)
              })
            }
            const outcome = git.get(source.sourceId)
            if (outcome?.kind === 'acquired') {
              const leaves = staged.map((bundle) => bundle.relativeRoot.split('/').at(-1)!)
              const expected = outcome.expectedLeaves
              if (
                expected.length > 0 &&
                (leaves.length !== expected.length || expected.some((l) => !leaves.includes(l)))
              )
                throw new Error('the skills CLI did not install the selected skills')
              gitSources.push(gitResult(outcome.plan, leaves))
            }
            return { source, staged }
          } catch (error) {
            return { source, error }
          }
        })
      )
      for (const outcome of stagings) {
        // A failed CLI stage costs that source this run, never the session: the others publish and it keeps what it had.
        if ('error' in outcome) {
          if (mutationSignal.aborted) throw outcome.error
          const reason = outcome.error instanceof Error ? outcome.error.message : 'unknown skills CLI error'
          skipped.push({ sourceId: outcome.source.sourceId, reason: reason.slice(0, 1024), code: 'cli_failed' })
          continue
        }
        candidates.push(...outcome.staged)
      }
      // A run that skipped anything says nothing about intent, so every prior root not rebuilt stays (shared-skills.md §6.3).
      const preserveOwned = skipped.length > 0 ? input.priorRoots.map((root) => root.path) : kept
      // Validate the largest possible result before publication; conflicts and installed roots are subsets of this set.
      const desiredRoots = [
        ...new Map(candidates.map((candidate) => [candidate.relativeRoot, ownedRoot(candidate)])).values()
      ]
      const desired = ClusterSkillReconcileResultSchema.parse({
        roots: desiredRoots,
        conflicts: desiredRoots.map((root) => root.path)
      })
      if (input.priorRootCount === undefined) ClusterSkillReconcileReplySchema.parse(desired)
      else {
        let offset = 0
        do {
          const page = skillReceiptPage(desired, offset)
          if (page.nextOffset === undefined) break
          offset = page.nextOffset
        } while (true)
      }
      const result = await reconcileSkillBundles({
        cwd: this.deps.workspaceRoot,
        stateDir: this.deps.stateRoot,
        agentId: 'cluster-shim',
        runtime: operation.skillsAgentId,
        cliVersion: PINNED_SKILLS_CLI_VERSION,
        // A run that skipped a source has not met its plan, so its fingerprint never short-circuits the retry.
        fingerprint: skipped.length > 0 ? `failed:${randomBytes(16).toString('hex')}` : fingerprint,
        ...(preserveOwned.length > 0 ? { preserveOwned } : {}),
        ...(replayingPublication
          ? {}
          : {
              trustedPrior: input.priorRoots.map((root) => ({
                relativeRoot: root.path,
                sourceKey: root.sourceId,
                treeDigest: root.digest,
                files: root.files
              }))
            }),
        allowDesiredAdoption: false,
        assertMutationAuthority,
        mutationSignal,
        publicationOperationId: input.operationId,
        publicationKey: input.replayKey,
        candidates
      })
      // Bundled before the clones go, and only for a Source this run installed; a plan without `writeBack` stages nothing.
      const notInstalled = new Set([...skipped, ...budgetDropped].map((entry) => entry.sourceId))
      if (gitPlan && this.deps.writeBack) {
        writeBackCandidates = await stageSkillWriteBacks({
          outcomes: [...git.values()].filter(
            (outcome): outcome is Extract<GitPlanOutcome, { kind: 'acquired' }> =>
              outcome.kind === 'acquired' && !notInstalled.has(outcome.plan.sourceId)
          ),
          staging: this.deps.writeBack,
          abort: mutationSignal,
          ...(this.deps.git?.log ? { log: this.deps.git.log } : {})
        })
      }
      const reply = ClusterSkillReconcileResultSchema.parse(
        skillReplyFor(input, {
          roots: result.owned.map(ownedRoot),
          conflicts: result.conflicts,
          ...(skipped.length + budgetDropped.length > 0
            ? { skipped: inSourceOrder(input, [...skipped, ...budgetDropped]) }
            : {}),
          ...(gitPlan ? { gitSources: inSourceOrder(input, gitSources) } : {}),
          ...(writeBackCandidates.length > 0 ? { writeBackCandidates: inSourceOrder(input, writeBackCandidates) } : {})
        })
      )
      if (skipped.length + budgetDropped.length + result.conflicts.length === 0) {
        this.published = {
          agentId: operation.authority.agentId,
          skillsAgentId: operation.skillsAgentId,
          fingerprint,
          uploads,
          roots: reply.roots
        }
      }
      // The receipt path holds the reply, candidates included, until its last page is read.
      if (input.priorRootCount !== undefined) replied = true
      const sent = await this.answer(input, operation, reply, context)
      replied = true
      return sent
    } finally {
      if (!replied) for (const candidate of writeBackCandidates) this.deps.writeBack?.discard(candidate.handle)
      for (const cleanup of cleanups) cleanup()
      // A Git Source's clone never outlives its reconcile, whatever the outcome.
      await Promise.all(
        input.sources
          .filter((source) => source.sourceKind === 'git')
          .map((source) => rm(gitStaging(source.sourceId), { recursive: true, force: true }))
      )
    }
  }

  private async answer(
    input: ClusterSkillReconcile,
    operation: Operation,
    reply: ClusterSkillReconcileReply,
    context?: ClusterSkillRequestContext
  ): Promise<ClusterSkillReceiptPage> {
    if (input.priorRootCount !== undefined) {
      operation.result = reply
      return await this.receipt(
        { op: 'receipt', handle: input.handle, operationId: input.operationId, offset: 0 },
        context
      )
    }
    await this.discard(operation.handle)
    return ClusterSkillReconcileReplySchema.parse(reply)
  }

  // The daemon's prior receipts must be exactly what this shim last published for the same plan and uploads, and the ledger must agree.
  private async unchanged(
    input: ClusterSkillReconcile,
    operation: Operation,
    fingerprint: string,
    uploads: string
  ): Promise<boolean> {
    const published = this.published
    if (
      !published ||
      published.agentId !== operation.authority.agentId ||
      published.skillsAgentId !== operation.skillsAgentId ||
      published.fingerprint !== fingerprint ||
      published.uploads !== uploads ||
      canonicalRoots(published.roots) !== canonicalRoots(input.priorRoots)
    )
      return false
    return await publishedSkillSetUnchanged({
      cwd: this.deps.workspaceRoot!,
      stateDir: this.deps.stateRoot!,
      agentId: 'cluster-shim',
      runtime: operation.skillsAgentId,
      cliVersion: PINNED_SKILLS_CLI_VERSION,
      fingerprint,
      roots: input.priorRoots.map((root) => ({
        relativeRoot: root.path,
        sourceKey: root.sourceId,
        treeDigest: root.digest,
        files: root.files
      }))
    })
  }

  // The window capability lives only in this call's arguments and the Git child's env.
  private async acquireGitPlan(
    input: ClusterSkillReconcile,
    operation: Operation,
    abort: AbortSignal
  ): Promise<Map<string, GitPlanOutcome>> {
    const plans = input.sources.filter((source): source is GitSkillPlan => source.sourceKind === 'git')
    const outcomes = await acquireGitPlanSources({
      plans,
      stagingFor: (sourceId) => join(this.deps.stagingRoot, input.handle, sourceDirectory(sourceId)),
      agentId: operation.authority.agentId,
      ...(input.credentialWindow ? { window: input.credentialWindow } : {}),
      deps: {
        credentialHelper: DEFAULT_SHIM_PATHS.gitCredentialHelper,
        credentialSocket: process.env[GITCRED_SOCKET_ENV]?.trim() || DEFAULT_SHIM_PATHS.tunnels.gitcred,
        ...this.deps.git
      },
      abort
    })
    return new Map(outcomes.map((outcome) => [outcome.plan.sourceId, outcome]))
  }

  // One budget over what this pod would install: a Git Source's clone, a kept Source's prior roots, an uploaded source's manifest.
  private chargeBudget(
    input: ClusterSkillReconcile,
    operation: Operation,
    git: Map<string, GitPlanOutcome>
  ): Set<string> {
    const declared = [...operation.files.values()]
    const charges = input.sources.flatMap((source) => {
      const outcome = git.get(source.sourceId)
      // A skipped Source spends nothing, as a failed acquisition spends nothing on the daemon path.
      if (outcome?.kind === 'skipped') return []
      const { sourceId, sourceKind } = source
      if (outcome?.kind === 'acquired')
        return [{ sourceId, sourceKind, fileCount: outcome.fileCount, totalBytes: outcome.totalBytes }]
      const files =
        outcome?.kind === 'keep'
          ? input.priorRoots.filter((root) => root.sourceId === sourceId).flatMap((root) => root.files)
          : declared.filter((file) => file.sourceId === sourceId)
      return [
        {
          sourceId,
          sourceKind,
          fileCount: files.length,
          totalBytes: files.reduce((total, file) => total + file.size, 0)
        }
      ]
    })
    return chargeSkillManifestBudget(
      charges,
      this.deps.manifestLimits ?? { maxFiles: MAX_CLUSTER_SKILL_FILES, maxTotalBytes: MAX_CLUSTER_SKILL_TOTAL_BYTES }
    )
  }

  private assertBoundAuthority(authority: ClusterSkillBegin['authority'], context?: ClusterSkillRequestContext): void {
    if (!context) return
    if (authority.shimGeneration !== context.generation) throw new Error('stale cluster skill shim generation')
    if (context.agentId !== authority.agentId) throw new Error('cluster skill request targets another agent')
  }

  private async upload(input: ClusterSkillUpload, abort?: AbortSignal): Promise<ClusterSkillUploadReply> {
    const operation = this.operations.get(input.handle)
    if (!operation || operation.operationId !== input.operationId)
      throw new Error('unknown cluster skill staging handle')
    const declared = operation.files.get(fileKey(input.sourceId, input.path))
    if (!declared) throw new Error('upload file was not declared')
    const data = Buffer.from(input.data, 'base64')
    const destination = this.stagedFile(input.handle, input.sourceId, input.path)
    if (declared.complete) {
      const existing = await readFile(destination)
      if (input.final && input.offset === 0 && existing.equals(data))
        return { received: declared.received, complete: true }
      throw new Error('upload file is already complete')
    }
    if (input.offset !== declared.received)
      throw new Error(`upload offset ${input.offset} does not match ${declared.received}`)
    if (declared.received + data.length > declared.size)
      return await this.fail(operation, 'upload exceeds declared size')
    try {
      await this.ensureSafeParents(destination, join(this.deps.stagingRoot, input.handle))
      const file = await open(destination, declared.received === 0 ? 'wx' : 'a')
      try {
        if (abort?.aborted) throw new Error('cluster skill operation aborted')
        await file.write(data, 0, data.length, null)
        if (input.final && declared.executable !== undefined) await file.chmod(declared.executable ? 0o700 : 0o600)
        await file.sync()
      } finally {
        await file.close()
      }
      declared.received += data.length
      if (!input.final) return { received: declared.received, complete: false }
      if (declared.received !== declared.size)
        return await this.fail(operation, 'upload final size does not match declaration')
      const digest = createHash('sha256')
        .update(await readFile(destination))
        .digest('hex')
      if (digest !== declared.sha256) return await this.fail(operation, 'upload digest does not match declaration')
      declared.complete = true
      return { received: declared.received, complete: true }
    } catch (error) {
      if (abort?.aborted) {
        await this.discard(operation.handle)
        throw new Error('cluster skill operation aborted')
      }
      throw error
    }
  }

  private async ensureSafeParents(destination: string, operationRoot: string): Promise<void> {
    const relative = dirname(destination)
      .slice(operationRoot.length + 1)
      .split('/')
      .filter(Boolean)
    let current = operationRoot
    for (const part of relative) {
      current = join(current, part)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new Error('symlink refused in cluster skill staging path')
        if (!info.isDirectory()) throw new Error('non-directory refused in cluster skill staging path')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(current, { mode: 0o700 })
      }
    }
    try {
      if ((await lstat(destination)).isSymbolicLink()) throw new Error('symlink refused as cluster skill staging file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async fail(operation: Operation, message: string): Promise<never> {
    await this.discard(operation.handle)
    throw new Error(message)
  }

  private async discard(handle: string): Promise<void> {
    this.operations.delete(handle)
    await rm(join(this.deps.stagingRoot, handle), { recursive: true, force: true })
  }
}

const gitResult = (plan: GitSkillPlan, leaves: string[]): GitSkillSourceResult => ({
  sourceId: plan.sourceId,
  resolvedCommit: plan.plannedCommit,
  leaves
})

const inSourceOrder = <T extends { sourceId: string }>(input: ClusterSkillReconcile, rows: T[]): T[] => {
  const order = new Map(input.sources.map((source, index) => [source.sourceId, index]))
  return [...rows].sort((a, b) => order.get(a.sourceId)! - order.get(b.sourceId)!)
}

// A presigned GET URL or a write-back request changes per run but not what installs, so neither moves the fingerprint.
const fingerprintSources = (sources: ClusterSkillReconcile['sources']): unknown[] =>
  sources.map((source) => {
    if (source.sourceKind !== 'git') return source
    const { getUrl: _getUrl, writeBack: _writeBack, ...rest } = source
    return rest
  })

// The uploaded snapshot this run staged, so an unchanged plan over changed uploaded bytes still takes the full path.
const uploadsDigest = (operation: Operation): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [...operation.files.values()]
          .map(({ sourceId, path, size, sha256, executable }) =>
            JSON.stringify([sourceId, path, size, sha256, executable ?? null])
          )
          .sort()
      )
    )
    .digest('hex')

const canonicalRoots = (roots: ClusterSkillReconcile['priorRoots']): string =>
  JSON.stringify(
    [...roots]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ path, sourceId, sourceKind, digest, files }) => [path, sourceId, sourceKind, digest, files])
  )

function compareDecimalTerms(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}
