import { describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import type { MemoryTransactionCommit, MemoryTransactionResult } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEF_ORG, seedAgent, seedDaemon } from '../fixtures/seed.js'
import { systemClock } from '../../src/domain/clock.js'
import { AgentId } from '../../src/domain/ids.js'
import {
  PgAgentMemoryFileRepo,
  PgAgentMemoryHistoryRepo
} from '../../src/persistence/repositories/agent-memory.repo.js'
import { PgAgentMemoryTransactionRepo } from '../../src/persistence/repositories/agent-memory-transaction.repo.js'
import { AgentMemoryTransactionService } from '../../src/agent-memory/transaction.service.js'

const NOW = new Date('2026-09-09T13:00:00Z')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const daemonId = randomUUID()
  await seedDaemon(prisma, daemonId)
  const agentId = AgentId(randomUUID())
  await seedAgent(prisma, agentId, {
    daemonId,
    runtimeOverrides: { memory: { provider: 'managed', home: 'control-plane' } }
  })
  const files = new PgAgentMemoryFileRepo(prisma)
  const repo = new PgAgentMemoryTransactionRepo(prisma)
  const service = new AgentMemoryTransactionService(repo, {
    now: () => NOW.getTime(),
    setTimeout: systemClock.setTimeout.bind(systemClock),
    clearTimeout: systemClock.clearTimeout.bind(systemClock)
  })
  const apply = (req: Parameters<typeof service.apply>[1]) => service.apply({ id: agentId, orgId: DEF_ORG }, req)
  const snapshot = async () => {
    const result = await apply({ agentId, root: 'memory', operation: 'snapshot' })
    if (result.operation !== 'snapshot') throw new Error(JSON.stringify(result))
    return result.revision
  }
  const stage = async (path: string, text: string, expectedRevision: string | null = null) => {
    const temp = `.agentconnect-memory-${randomUUID()}.tmp`
    await files.append(agentId, DEF_ORG, `memory/${temp}`, Buffer.from(text), true, NOW)
    return { action: 'put' as const, path, temp, stagedRevision: hash(text), expectedRevision }
  }
  const request = async (changes: MemoryTransactionCommit['changes']): Promise<MemoryTransactionCommit> => ({
    operation: 'commit',
    agentId,
    root: 'memory',
    operationId: randomUUID(),
    expectedRevision: await snapshot(),
    source: 'console',
    changes
  })
  const read = async (path: string) => {
    const row = await files.read(agentId, `memory/${path}`, 0, 256000)
    return row ? Buffer.from(row.slice).toString('utf8') : null
  }
  return { agentId, apply, snapshot, stage, request, read, files }
}
function receipt(result: MemoryTransactionResult) {
  if (result.operation !== 'commit') throw new Error(JSON.stringify(result))
  return result.receipt
}

describe('atomic memory home publication', () => {
  it('publishes topic, index, history and receipt together, with no staging rows left', async () => {
    const f = await fixture()
    const req = await f.request([await f.stage('topic.md', 'hello'), await f.stage('MEMORY.md', '[topic](topic.md)')])
    const done = receipt(await f.apply(req))
    expect(await f.read('topic.md')).toBe('hello')
    expect(await f.read('MEMORY.md')).toBe('[topic](topic.md)')
    expect(done.revision).toBe(await f.snapshot())
    expect(await prisma.agentMemoryFile.count({ where: { agentId: f.agentId, stagedAt: { not: null } } })).toBe(0)
    const history = await prisma.agentMemoryHistory.findMany({ where: { agentId: f.agentId } })
    expect(history.map((row) => row.path).sort()).toEqual(['MEMORY.md', 'topic.md'])
    expect(history.every((row) => row.source === 'console')).toBe(true)
    const ledger = await prisma.agentMemoryMutation.findMany({ where: { agentId: f.agentId } })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.receipt).toEqual(done)
    expect(JSON.stringify(ledger)).not.toContain('hello')
  })

  it('allows one competing snapshot commit and never combines independently prepared indexes', async () => {
    const f = await fixture()
    const a = await f.request([await f.stage('a.md', 'a'), await f.stage('MEMORY.md', 'index-a')])
    const b = await f.request([await f.stage('b.md', 'b'), await f.stage('MEMORY.md', 'index-b')])
    const results = await Promise.all([f.apply(a), f.apply(b)])
    expect(results.filter((result) => result.operation === 'commit')).toHaveLength(1)
    expect(results.filter((result) => result.operation === 'error')).toEqual([
      { operation: 'error', code: 'CONFLICT', message: 'memory tree changed while the mutation was prepared' }
    ])
    const winner = results[0]!.operation === 'commit' ? 'a' : 'b'
    expect(await f.read('MEMORY.md')).toBe(`index-${winner}`)
    expect(await f.read(`${winner}.md`)).toBe(winner)
    expect(await f.read(`${winner === 'a' ? 'b' : 'a'}.md`)).toBeNull()
  })

  it('replays the identical operation across repo instances even after history is removed', async () => {
    const f = await fixture()
    const req = await f.request([await f.stage('topic.md', '')])
    const results = await Promise.all([
      f.apply(req),
      new PgAgentMemoryTransactionRepo(prisma).apply(f.agentId, DEF_ORG, req, NOW)
    ])
    expect(results.map((result) => result.operation === 'commit' && result.replayed).sort()).toEqual([false, true])
    expect(receipt(results[0]!)).toEqual(receipt(results[1]!))
    await new PgAgentMemoryHistoryRepo(prisma).deleteTree(f.agentId)
    expect(receipt(await f.apply(req))).toEqual(receipt(results[0]!))
    expect(await f.read('topic.md')).toBe('')
    expect(await prisma.agentMemoryHistory.count({ where: { agentId: f.agentId } })).toBe(0)
    expect(await f.apply({ ...req, source: 'tool' })).toMatchObject({ operation: 'error', code: 'CONFLICT' })
  })

  it('rejects stale targets, changed staging and legacy mutations without partial publication', async () => {
    const f = await fixture()
    const a = await f.stage('a.md', 'a')
    const b = await f.stage('b.md', 'b')
    const req = await f.request([a, { ...b, stagedRevision: hash('wrong') }])
    expect(await f.apply(req)).toMatchObject({ operation: 'error', code: 'CONFLICT' })
    expect(await f.read('a.md')).toBeNull()
    expect(await prisma.agentMemoryHistory.count({ where: { agentId: f.agentId } })).toBe(0)
    const valid = { ...req, changes: [a, b] }
    const other = await f.stage('legacy.md', 'legacy')
    await f.files.commit(f.agentId, 'memory/legacy.md', `memory/${other.temp}`, undefined, NOW)
    expect(await f.apply(valid)).toMatchObject({ operation: 'error', code: 'CONFLICT' })
    const fresh = await f.request([{ ...a, expectedRevision: hash('absent') }])
    expect(await f.apply(fresh)).toMatchObject({ operation: 'error', code: 'CONFLICT' })
  })

  it('rolls back file and staging changes if history insertion fails', async () => {
    const f = await fixture()
    const req = await f.request([await f.stage('topic.md', 'new'), await f.stage('MEMORY.md', 'index')])
    await prisma.$executeRawUnsafe(
      `ALTER TABLE agent_memory_history ADD CONSTRAINT memory_test_history_failure CHECK (source <> 'console')`
    )
    try {
      await expect(f.apply(req)).rejects.toThrow()
      expect(await f.read('topic.md')).toBeNull()
      expect(await f.read('MEMORY.md')).toBeNull()
      expect(await prisma.agentMemoryMutation.count({ where: { agentId: f.agentId } })).toBe(0)
      expect(await prisma.agentMemoryFile.count({ where: { agentId: f.agentId, stagedAt: { not: null } } })).toBe(2)
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE agent_memory_history DROP CONSTRAINT memory_test_history_failure')
    }
    expect((await f.apply(req)).operation).toBe('commit')
  })

  it('atomically deletes a topic and updates its index, preserving deletion provenance', async () => {
    const f = await fixture()
    receipt(await f.apply(await f.request([await f.stage('topic.md', 'old'), await f.stage('MEMORY.md', 'old index')])))
    const done = await f.apply(
      await f.request([
        { action: 'delete', path: 'topic.md', expectedRevision: hash('old') },
        await f.stage('MEMORY.md', '', hash('old index'))
      ])
    )
    expect(receipt(done).files[0]).toEqual({ path: 'topic.md', revision: null, mtime: null })
    expect(await f.read('topic.md')).toBeNull()
    expect(await f.read('MEMORY.md')).toBe('')
    expect(await prisma.agentMemoryHistory.findFirst({ where: { agentId: f.agentId, event: 'delete' } })).toMatchObject(
      { before: 'old', after: '', source: 'console' }
    )
  })

  it('refuses escaped roots and a binding that moved away from the CP home', async () => {
    const f = await fixture()
    expect(await f.apply({ agentId: f.agentId, root: '../memory', operation: 'snapshot' })).toMatchObject({
      operation: 'error',
      code: 'INVALID_ARGUMENT'
    })
    const req = await f.request([await f.stage('topic.md', 'new')])
    await prisma.agent.update({
      where: { id: f.agentId },
      data: { runtimeOverrides: { memory: { provider: 'managed', home: 'daemon' } } }
    })
    expect(await f.apply(req)).toMatchObject({ operation: 'error', code: 'FORBIDDEN' })
    expect(await f.read('topic.md')).toBeNull()
  })
})
