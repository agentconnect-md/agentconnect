import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { inspectLocalSkillSource } from '../skills/skill-source-snapshot.js'
import { PINNED_SKILLS_CLI_VERSION, stageSkillsCliCell } from '../skills/skills-cli-cell.js'
import {
  readSkillLedger,
  reconcileSkillBundles,
  skillLedgerLocation,
  treeDigest,
  type CandidateSkillBundle
} from '../skills/skill-install-ledger.js'
import {
  ClusterSkillRequestSchema,
  type ClusterSkillBegin,
  type ClusterSkillBeginReply,
  type ClusterSkillFile,
  type ClusterSkillReconcile,
  type ClusterSkillReconcileReply,
  type ClusterSkillUpload,
  type ClusterSkillUploadReply
} from './skill-protocol.js'

interface Operation {
  handle: string
  operationId: string
  files: Map<string, ClusterSkillFile & { received: number; complete: boolean }>
  skillsAgentId: string
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
  private readonly inactiveMs: number
  private readonly now: () => number

  constructor(private readonly deps: ClusterSkillHandlerDeps) {
    this.inactiveMs = deps.inactiveMs ?? 30 * 60_000
    this.now = deps.now ?? Date.now
  }

  async handle(
    payload: unknown,
    abort?: AbortSignal
  ): Promise<ClusterSkillBeginReply | ClusterSkillUploadReply | ClusterSkillReconcileReply> {
    const parsed = ClusterSkillRequestSchema.parse(payload)
    if (abort?.aborted) {
      if (parsed.op === 'upload') await this.discard(parsed.handle)
      throw new Error('cluster skill operation aborted')
    }
    if (parsed.op === 'begin') return await this.begin(parsed)
    if (parsed.op === 'upload') return await this.upload(parsed, abort)
    return await this.reconcile(parsed, abort)
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

  private async begin(input: ClusterSkillBegin): Promise<ClusterSkillBeginReply> {
    await mkdir(this.deps.stagingRoot, { recursive: true, mode: 0o700 })
    const handle = randomBytes(24).toString('hex')
    await mkdir(join(this.deps.stagingRoot, handle), { mode: 0o700 })
    this.operations.set(handle, {
      handle,
      operationId: input.operationId,
      skillsAgentId: input.skillsAgentId,
      files: new Map(
        input.files.map((file) => [fileKey(file.sourceId, file.path), { ...file, received: 0, complete: false }])
      )
    })
    return { handle }
  }

  private async reconcile(input: ClusterSkillReconcile, abort?: AbortSignal): Promise<ClusterSkillReconcileReply> {
    const operation = this.operations.get(input.handle)
    if (!operation || operation.operationId !== input.operationId)
      throw new Error('unknown cluster skill staging handle')
    if (!this.deps.workspaceRoot || !this.deps.stateRoot) throw new Error('cluster skill publication is unavailable')
    if ([...operation.files.values()].some((file) => !file.complete))
      throw new Error('cluster skill snapshot is incomplete')
    if (abort?.aborted) return await this.fail(operation, 'cluster skill operation aborted')
    const declaredSources = new Set([...operation.files.values()].map((file) => file.sourceId))
    if (input.sources.some((source) => !declaredSources.has(source.sourceId))) {
      throw new Error('reconcile source was not declared')
    }
    const sourceMeta = new Map(input.sources.map((source) => [source.sourceId, source]))
    const candidates: CandidateSkillBundle[] = []
    const cleanups: Array<() => void> = []
    try {
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
        candidates
      })
      const location = await skillLedgerLocation(this.deps.workspaceRoot, this.deps.stateRoot)
      const ledger = await readSkillLedger(location)
      if (!ledger || ledger.phase !== 'ready') throw new Error('cluster skill publisher did not produce a ready ledger')
      const roots = ledger.owned.map((root) => {
        const source = sourceMeta.get(root.sourceKey)
        if (!source) throw new Error('cluster skill publisher returned an unknown source')
        return {
          path: root.relativeRoot,
          sourceId: root.sourceKey,
          sourceKind: source.sourceKind,
          digest: root.treeDigest
        }
      })
      await this.discard(operation.handle)
      return { roots, conflicts: result.conflicts }
    } finally {
      for (const cleanup of cleanups) cleanup()
    }
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
