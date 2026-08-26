import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { inspectLocalSkillSource } from '../skills/skill-source-snapshot.js'
import { PINNED_SKILLS_CLI_VERSION, stageSkillsCliCell } from '../skills/skills-cli-cell.js'
import {
  reconcileSkillBundles,
  hasSkillPublicationOperation,
  skillBundleReceiptIntact,
  treeDigest,
  type CandidateSkillBundle
} from '../skills/skill-install-ledger.js'
import {
  ClusterSkillRequestSchema,
  ClusterSkillReconcileReplySchema,
  type ClusterSkillBegin,
  type ClusterSkillBeginReply,
  type ClusterSkillFile,
  type ClusterSkillReconcile,
  type ClusterSkillReconcileReply,
  type ClusterSkillUpload,
  type ClusterSkillUploadReply,
  type ClusterSkillVerifyReply
} from './skill-protocol.js'

interface Operation {
  handle: string
  operationId: string
  files: Map<string, ClusterSkillFile & { received: number; complete: boolean }>
  skillsAgentId: string
  authority: ClusterSkillBegin['authority']
  abort: AbortController
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
}

const sourceDirectory = (sourceId: string): string => createHash('sha256').update(sourceId).digest('hex')
const fileKey = (sourceId: string, path: string): string => `${sourceId}\0${path}`

export class ClusterSkillHandler {
  private readonly operations = new Map<string, Operation>()
  private readonly highestTerms = new Map<string, { term: string; daemonId: string }>()
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
  ): Promise<ClusterSkillBeginReply | ClusterSkillUploadReply | ClusterSkillReconcileReply | ClusterSkillVerifyReply> {
    const parsed = ClusterSkillRequestSchema.parse(payload)
    if (abort?.aborted) {
      if (parsed.op === 'upload') await this.discard(parsed.handle)
      throw new Error('cluster skill operation aborted')
    }
    if (parsed.op === 'begin') return await this.begin(parsed, context)
    if (parsed.op === 'upload') return await this.upload(parsed, abort)
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
    this.operations.set(handle, {
      handle,
      operationId: input.operationId,
      authority: input.authority,
      skillsAgentId: input.skillsAgentId,
      abort: new AbortController(),
      files: new Map(
        input.files.map((file) => [fileKey(file.sourceId, file.path), { ...file, received: 0, complete: false }])
      )
    })
    return { handle }
  }

  private async reconcile(
    input: ClusterSkillReconcile,
    abort?: AbortSignal,
    context?: ClusterSkillRequestContext
  ): Promise<ClusterSkillReconcileReply> {
    const operation = this.operations.get(input.handle)
    if (!operation || operation.operationId !== input.operationId)
      throw new Error('unknown cluster skill staging handle')
    this.assertBoundAuthority(input.authority, context)
    if (JSON.stringify(operation.authority) !== JSON.stringify(input.authority)) {
      throw new Error('cluster skill authority changed during staging')
    }
    const current = this.highestTerms.get(input.authority.workspaceIncarnation)
    if (!current || current.term !== input.authority.term || current.daemonId !== input.authority.daemonId) {
      throw new Error('cluster skill reconciliation lost duty authority')
    }
    if (!this.deps.workspaceRoot || !this.deps.stateRoot) throw new Error('cluster skill publication is unavailable')
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
    if (input.sources.some((source) => !declaredSources.has(source.sourceId))) {
      throw new Error('reconcile source was not declared')
    }
    const sourceMeta = new Map(input.sources.map((source) => [source.sourceId, source]))
    const candidates: CandidateSkillBundle[] = []
    const cleanups: Array<() => void> = []
    try {
      const replayingPublication = await hasSkillPublicationOperation(
        this.deps.workspaceRoot,
        this.deps.stateRoot,
        input.operationId,
        input.replayKey
      )
      for (const source of input.sources) {
        const snapshot = join(this.deps.stagingRoot, input.handle, sourceDirectory(source.sourceId))
        const cell = await stageSkillsCliCell({
          sourceSnapshot: snapshot,
          agentId: operation.skillsAgentId,
          selectedSkills: source.selections
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
          candidates.push({
            relativeRoot: bundle.relativePath,
            sourceKey: source.sourceId,
            sourceDir: bundle.absolutePath,
            files,
            treeDigest: treeDigest(files)
          })
        }
      }
      const result = await reconcileSkillBundles({
        cwd: this.deps.workspaceRoot,
        stateDir: this.deps.stateRoot,
        agentId: 'cluster-shim',
        runtime: operation.skillsAgentId,
        cliVersion: PINNED_SKILLS_CLI_VERSION,
        fingerprint: createHash('sha256').update(JSON.stringify(input.sources)).digest('hex'),
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
      const roots = result.owned.map((root) => {
        const source = sourceMeta.get(root.sourceKey)
        if (!source) throw new Error('cluster skill publisher returned an unknown source')
        return {
          path: root.relativeRoot,
          sourceId: root.sourceKey,
          sourceKind: source.sourceKind,
          digest: root.treeDigest,
          files: root.files.map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 }))
        }
      })
      await this.discard(operation.handle)
      return ClusterSkillReconcileReplySchema.parse({ roots, conflicts: result.conflicts })
    } finally {
      for (const cleanup of cleanups) cleanup()
    }
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

function compareDecimalTerms(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}
