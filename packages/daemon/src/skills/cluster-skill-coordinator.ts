import { createHash, randomUUID } from 'node:crypto'
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
}

export interface ClusterSkillJournalStore {
  beginClusterSkillReconcile(
    input: ClusterSkillReconcileAuthority & { desiredHash: string }
  ): Promise<
    | { ok: true; operationId: string; priorRevision: number; priorLedger: ClusterSkillLedger }
    | { ok: false; reason: 'lost_authority' }
  >
  commitClusterSkillReconcile(
    input: ClusterSkillReconcileAuthority & { priorRevision: number; ledger: ClusterSkillLedger }
  ): Promise<{ ok: true; revision: number } | { ok: false; reason: 'lost_authority' }>
}

export class ClusterSkillCoordinator {
  constructor(private readonly store: ClusterSkillJournalStore) {}

  async reconcile(input: {
    authority: Omit<ClusterSkillReconcileAuthority, 'operationId'>
    skillsAgentId: string
    sources: ClusterSkillSnapshotSource[]
    client: ClusterSkillClient
  }): Promise<ClusterSkillLedger> {
    const operationId = randomUUID()
    const sources = [...input.sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId))
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
    const begun = await this.store.beginClusterSkillReconcile({ ...input.authority, operationId, desiredHash })
    if (!begun.ok) throw new Error('cluster skill reconciliation lost duty authority')
    const authority = { ...input.authority, operationId: begun.operationId }
    const { handle } = await input.client.begin({
      operationId: authority.operationId,
      workspaceIncarnation: authority.workspaceIncarnation,
      skillsAgentId: input.skillsAgentId,
      files
    })
    for (const file of files)
      await input.client.upload(authority.operationId, handle, file, contents.get(`${file.sourceId}\0${file.path}`)!)
    const reply = ClusterSkillReconcileReplySchema.parse(
      await input.client.reconcile({
        operationId: authority.operationId,
        handle,
        sources: sources.map((source) => ({
          sourceId: source.sourceId,
          sourceKind: source.sourceKind,
          selections: source.selections
        }))
      })
    )
    if (reply.conflicts.length > 0) throw new Error('cluster skill ownership conflict')
    const ledger = { roots: reply.roots }
    const committed = await this.store.commitClusterSkillReconcile({
      ...authority,
      priorRevision: begun.priorRevision,
      ledger
    })
    if (!committed.ok) throw new Error('cluster skill reconciliation lost duty authority')
    return ledger
  }
}
