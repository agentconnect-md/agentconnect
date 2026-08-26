import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClusterSkillReconcileAuthority, ClusterSkillLedger } from '../store/cluster-skill-ledger.js'
import type { ClusterSkillClient } from '../shim/skill-client.js'
import { ClusterSkillReconcileReplySchema, type ClusterSkillFile } from '../shim/skill-protocol.js'
import { inspectLocalSkillSource } from './skill-source-snapshot.js'

export interface ClusterSkillSnapshotSource {
  sourceId: string
  sourceKind: 'agent' | 'managed' | 'dream'
  sourceDir: string
  selections: string[]
  expectedLeaves: string[]
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
    const files: ClusterSkillFile[] = []
    const contents = new Map<string, Buffer>()
    for (const source of sources) {
      const inspected = await inspectLocalSkillSource(source.sourceDir)
      for (const file of inspected.files) {
        const path = file.path.replaceAll('\\', '/')
        const content = await readFile(join(source.sourceDir, ...path.split('/')))
        const descriptor = {
          sourceId: source.sourceId,
          path,
          size: content.length,
          sha256: file.sha256.replace(/^sha256:/, '')
        }
        files.push(descriptor)
        contents.set(`${source.sourceId}\0${path}`, content)
      }
    }
    const desiredHash = createHash('sha256')
      .update(JSON.stringify({ sources: sources.map(({ sourceDir: _sourceDir, ...source }) => source), files }))
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
    for (const file of files)
      await input.client.upload(authority.operationId, handle, file, contents.get(`${file.sourceId}\0${file.path}`)!)
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
