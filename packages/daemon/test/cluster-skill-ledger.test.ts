import { describe, expect, it } from 'vitest'
import { LocalStore } from '../src/store/local-store.js'
import { memoryStoreDatabase } from './store-support.js'

const groupId = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'

describe('cluster skill ledger fencing', () => {
  it('commits only while the same daemon still owns the projected duty term', async () => {
    const database = memoryStoreDatabase()
    const first = await LocalStore.open({ database, shared: true, ownerId: 'member-a', orgForAgent: () => 'org' })

    expect(await first.projectDutyWriteFence({ groupId, term: '7', daemonId: 'member-a' })).toBe(true)
    const begun = await first.beginClusterSkillReconcile({
      groupId,
      term: '7',
      daemonId: 'member-a',
      agentId: 'agent-a',
      workspaceIncarnation: 'claim-uid-1',
      operationId,
      desiredHash: 'a'.repeat(64)
    })
    expect(begun).toMatchObject({ ok: true, priorRevision: 0, priorLedger: { roots: [] } })

    expect(await first.projectDutyWriteFence({ groupId, term: '8', daemonId: 'member-b' })).toBe(true)
    expect(
      await first.commitClusterSkillReconcile({
        groupId,
        term: '7',
        daemonId: 'member-a',
        agentId: 'agent-a',
        workspaceIncarnation: 'claim-uid-1',
        operationId,
        priorRevision: 0,
        ledger: { roots: [] }
      })
    ).toEqual({ ok: false, reason: 'lost_authority' })
    const adopted = await first.beginClusterSkillReconcile({
      groupId,
      term: '8',
      daemonId: 'member-b',
      agentId: 'agent-a',
      workspaceIncarnation: 'claim-uid-1',
      operationId: '33333333-3333-4333-8333-333333333333',
      desiredHash: 'a'.repeat(64)
    })
    expect(adopted).toMatchObject({ ok: true, operationId })
  })

  it('isolates ownership by SandboxClaim uid', async () => {
    const store = await LocalStore.open({
      database: memoryStoreDatabase(),
      shared: true,
      ownerId: 'member-a',
      orgForAgent: () => 'org'
    })
    await store.projectDutyWriteFence({ groupId, term: '1', daemonId: 'member-a' })
    await store.beginClusterSkillReconcile({
      groupId,
      term: '1',
      daemonId: 'member-a',
      agentId: 'agent-a',
      workspaceIncarnation: 'claim-uid-1',
      operationId,
      desiredHash: 'a'.repeat(64)
    })
    expect(
      await store.commitClusterSkillReconcile({
        groupId,
        term: '1',
        daemonId: 'member-a',
        agentId: 'agent-a',
        workspaceIncarnation: 'claim-uid-1',
        operationId,
        priorRevision: 0,
        ledger: { roots: [] }
      })
    ).toEqual({ ok: true, revision: 1 })
    expect(await store.clusterSkillLedger('agent-a', 'claim-uid-1')).toMatchObject({ revision: 1 })
    expect(await store.clusterSkillLedger('agent-a', 'claim-uid-2')).toBeUndefined()
  })
})
