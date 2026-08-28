import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClusterSkillReconcileAuthority, ClusterSkillLedger } from '../store/cluster-skill-ledger.js'
import type { ClusterSkillClient } from '../shim/skill-client.js'
import { ClusterSkillReconcileReplySchema, type ClusterSkillFile } from '../shim/skill-protocol.js'
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
    sources: ClusterSkillSnapshotSource[]
    gitResolutions?: NonNullable<ClusterSkillLedger['gitResolutions']>
    client: ClusterSkillClient
    isLaunchCurrent?: () => boolean
  }): Promise<ClusterSkillLedger> {
    if (input.isLaunchCurrent && !input.isLaunchCurrent()) {
      throw new Error('cluster skill reconciliation targets a stale sandbox launch')
    }
    const operationId = randomUUID()
    const sources = [...input.sources]
    if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) {
      throw new Error('cluster skill sources contain duplicate identities')
    }
    // Descriptors only. Buffering every body here would hold a whole widened source — up to the
    // aggregate envelope — in a 2 GiB pool daemon; each is re-read just before its own upload.
    const files: ClusterSkillFile[] = []
    const sourceDirs = new Map(sources.map((source) => [source.sourceId, source.sourceDir]))
    for (const source of sources) {
      const inspected = await inspectLocalSkillSource(source.sourceDir, { limits: source.limits })
      for (const file of inspected.files) {
        files.push({
          sourceId: source.sourceId,
          path: file.path.replaceAll('\\', '/'),
          size: file.size,
          sha256: file.sha256.replace(/^sha256:/, '')
        })
      }
    }
    const desiredHash = createHash('sha256')
      .update(
        JSON.stringify({
          sources: sources.map(({ sourceDir: _sourceDir, limits: _limits, ...source }) => source),
          files
        })
      )
      .digest('hex')
    const begun = await this.store.beginClusterSkillReconcile({
      ...input.authority,
      operationId,
      desiredHash,
      replayKey: randomBytes(32).toString('hex')
    })
    if (!begun.ok) throw new Error('cluster skill reconciliation lost duty authority')
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
    const reply = ClusterSkillReconcileReplySchema.parse(
      await input.client.reconcile({
        operationId: authority.operationId,
        handle,
        authority: { ...input.authority, shimGeneration: input.shimGeneration },
        priorRoots: begun.priorLedger.roots,
        replayKey: begun.replayKey,
        allowDesiredAdoption: false,
        sources: sources.map((source) => ({
          sourceId: source.sourceId,
          sourceKind: source.sourceKind,
          selections: source.selections
        }))
      })
    )
    if (reply.conflicts.length > 0) throw new Error('cluster skill ownership conflict')
    if (input.isLaunchCurrent && !input.isLaunchCurrent()) {
      throw new Error('cluster skill reconciliation targets a stale sandbox launch')
    }
    const expectedSources = new Map(sources.map((source) => [source.sourceId, source]))
    const returnedSelections = new Map<string, Set<string>>()
    for (const root of reply.roots) {
      const expected = expectedSources.get(root.sourceId)
      if (!expected || expected.sourceKind !== root.sourceKind) {
        throw new Error('cluster skill shim returned an unexpected source receipt')
      }
      const selected = returnedSelections.get(root.sourceId) ?? new Set<string>()
      selected.add(root.path.split('/').at(-1)!)
      returnedSelections.set(root.sourceId, selected)
    }
    for (const source of sources) {
      if (source.expectedLeaves.length === 0) continue
      const returned = returnedSelections.get(source.sourceId) ?? new Set<string>()
      if (
        source.expectedLeaves.some((selection) => !returned.has(selection)) ||
        returned.size !== source.expectedLeaves.length
      ) {
        throw new Error('cluster skill shim returned an incomplete selection receipt')
      }
    }
    const ledger = { roots: reply.roots, gitResolutions: input.gitResolutions ?? [] }
    const committed = await this.store.commitClusterSkillReconcile({
      ...authority,
      priorRevision: begun.priorRevision,
      ledger
    })
    if (!committed.ok) throw new Error('cluster skill reconciliation lost duty authority')
    if (input.isLaunchCurrent && !input.isLaunchCurrent()) {
      throw new Error('cluster skill reconciliation targets a stale sandbox launch')
    }
    return ledger
  }
}
