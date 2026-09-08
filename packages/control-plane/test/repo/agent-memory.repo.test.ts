/**
 * The two ★ constraints of the CP memory home (memory-evolution.md §3.2.1) at the table:
 *
 *  - the `mtime` a commit stamps is strictly monotonic per (agentId, path) — two commits inside one
 *    millisecond, or a clock that stands still, never hand out the same token;
 *  - staged rows an abandoned append sequence left behind are swept once old enough, and never the
 *    published files or a sequence still in flight;
 *
 * plus the change log's retention as a delete: newest N per file, then the store's byte cap, oldest first.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEF_ORG, seedAgent, seedDaemon } from '../fixtures/seed.js'
import {
  PgAgentMemoryFileRepo,
  PgAgentMemoryHistoryRepo
} from '../../src/persistence/repositories/agent-memory.repo.js'
import { AgentId } from '../../src/domain/ids.js'
import type { AgentMemoryHistoryInput } from '../../src/persistence/ports.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const NOW = new Date('2026-09-08T12:00:00.000Z')

async function agent(): Promise<AgentId> {
  await seedDaemon(prisma, DAEMON)
  const id = randomUUID()
  await seedAgent(prisma, id, { daemonId: DAEMON })
  return AgentId(id)
}

async function publish(
  repo: PgAgentMemoryFileRepo,
  agentId: AgentId,
  path: string,
  text: string,
  now: Date
): Promise<Date> {
  const temp = `${path}.tmp-${randomUUID()}`
  expect(await repo.append(agentId, DEF_ORG, temp, Buffer.from(text), true, now)).toEqual({
    ok: true,
    size: text.length
  })
  const outcome = await repo.commit(agentId, path, temp, undefined, now)
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.mtime
}

describe('agent_memory_file (real Postgres)', () => {
  it('★ commit stamps a strictly monotonic mtime per path, even under a clock that does not move', async () => {
    const repo = new PgAgentMemoryFileRepo(prisma)
    const agentId = await agent()
    const first = await publish(repo, agentId, 'memory/MEMORY.md', 'one', NOW)
    const second = await publish(repo, agentId, 'memory/MEMORY.md', 'two', NOW)
    const third = await publish(repo, agentId, 'memory/MEMORY.md', 'three', new Date(NOW.getTime() - 60_000)) // clock went backwards
    expect(first.toISOString()).toBe(NOW.toISOString())
    expect(second.getTime()).toBe(NOW.getTime() + 1)
    expect(third.getTime()).toBe(NOW.getTime() + 2)
    // A later clock wins outright; another path is its own sequence.
    const later = new Date(NOW.getTime() + 5_000)
    expect((await publish(repo, agentId, 'memory/MEMORY.md', 'four', later)).getTime()).toBe(later.getTime())
    expect((await publish(repo, agentId, 'memory/other.md', 'x', NOW)).getTime()).toBe(NOW.getTime())
  })

  it('a precondition compares the exact token, and a miss leaves the file and drops the temp', async () => {
    const repo = new PgAgentMemoryFileRepo(prisma)
    const agentId = await agent()
    const mtime = await publish(repo, agentId, 'memory/MEMORY.md', 'one', NOW)
    await repo.append(agentId, DEF_ORG, 'memory/.t1', Buffer.from('two'), true, NOW)
    expect(await repo.commit(agentId, 'memory/MEMORY.md', 'memory/.t1', mtime.toISOString(), NOW)).toMatchObject({
      ok: true,
      size: 3
    })
    await repo.append(agentId, DEF_ORG, 'memory/.t2', Buffer.from('three'), true, NOW)
    expect(await repo.commit(agentId, 'memory/MEMORY.md', 'memory/.t2', mtime.toISOString(), NOW)).toEqual({
      ok: false,
      reason: 'conflict'
    })
    expect((await prisma.agentMemoryFile.findMany({ where: { agentId } })).map((r) => [r.path, r.size])).toEqual([
      ['memory/MEMORY.md', 3]
    ])
    expect(await repo.commit(agentId, 'memory/MEMORY.md', 'memory/.gone', undefined, NOW)).toEqual({
      ok: false,
      reason: 'temp-missing'
    })
  })

  it('★ the sweep removes only staged rows older than the cutoff, bounded per call', async () => {
    const repo = new PgAgentMemoryFileRepo(prisma)
    const agentId = await agent()
    const old = new Date(NOW.getTime() - 3 * 60 * 60 * 1000)
    await publish(repo, agentId, 'memory/MEMORY.md', 'kept', old) // published: never swept, however old
    await repo.append(agentId, DEF_ORG, 'memory/.abandoned-1', Buffer.from('a'), true, old)
    await repo.append(agentId, DEF_ORG, 'memory/.abandoned-2', Buffer.from('b'), true, old)
    await repo.append(agentId, DEF_ORG, 'memory/.in-flight', Buffer.from('c'), true, NOW)
    const cutoff = new Date(NOW.getTime() - 60 * 60 * 1000)
    expect(await repo.sweepStaged(cutoff, 1)).toBe(1)
    expect(await repo.sweepStaged(cutoff, 1000)).toBe(1)
    expect(await repo.sweepStaged(cutoff, 1000)).toBe(0)
    expect(
      (await prisma.agentMemoryFile.findMany({ where: { agentId }, orderBy: { path: 'asc' } })).map((r) => r.path)
    ).toEqual(['memory/.in-flight', 'memory/MEMORY.md'])
    // The in-flight one is still a normal row a commit publishes; commit clears the staged mark.
    expect(await repo.commit(agentId, 'memory/new.md', 'memory/.in-flight', undefined, NOW)).toMatchObject({ ok: true })
    expect(await prisma.agentMemoryFile.count({ where: { agentId, stagedAt: { not: null } } })).toBe(0)
  })

  it('a read slice is the requested byte window, and stat/listUnder never touch content', async () => {
    const repo = new PgAgentMemoryFileRepo(prisma)
    const agentId = await agent()
    await publish(repo, agentId, 'memory/MEMORY.md', 'hello world', NOW)
    const slice = await repo.read(agentId, 'memory/MEMORY.md', 6, 3)
    expect(slice && [slice.size, Buffer.from(slice.slice).toString()]).toEqual([11, 'wor'])
    expect(Buffer.from((await repo.read(agentId, 'memory/MEMORY.md', 50, 3))!.slice).length).toBe(0)
    expect(await repo.read(agentId, 'memory/none.md', 0, 3)).toBeNull()
    expect(await repo.stat(agentId, 'memory')).toBe('dir')
    expect((await repo.listUnder(agentId, '')).map((e) => [e.path, e.size, e.staged])).toEqual([
      ['memory/MEMORY.md', 11, false]
    ])
  })
})

describe('agent_memory_history (real Postgres)', () => {
  function record(path: string, atMs: number, bytes = 100): AgentMemoryHistoryInput {
    return { id: randomUUID(), path, event: 'update', after: 'x', at: new Date(atMs), source: 'tool', bytes }
  }

  it('keeps the newest N versions per file, then evicts the oldest past the byte cap, per store', async () => {
    const repo = new PgAgentMemoryHistoryRepo(prisma)
    const agentId = await agent()
    const t = NOW.getTime()
    const a = [record('a.md', t + 1), record('a.md', t + 2), record('a.md', t + 3)]
    const b = [record('b.md', t + 1), record('b.md', t + 4)]
    await repo.append(agentId, DEF_ORG, 'memory', [...a, ...b], { maxVersionsPerFile: 2, maxBytesPerRoot: 10_000 })
    const kept = async () =>
      (await prisma.agentMemoryHistory.findMany({ where: { agentId, root: 'memory' }, orderBy: { at: 'asc' } })).map(
        (r) => r.id
      )
    expect(await kept()).toEqual([b[0]!.id, a[1]!.id, a[2]!.id, b[1]!.id]) // a.md lost its oldest version

    // The byte cap counts the store as a whole and evicts the oldest first: 400 bytes stored, cap 250 keeps the newest two.
    await repo.append(agentId, DEF_ORG, 'memory', [record('c.md', t + 5)], {
      maxVersionsPerFile: 2,
      maxBytesPerRoot: 250
    })
    expect((await kept()).length).toBe(2)
    expect(
      (await prisma.agentMemoryHistory.findMany({ where: { agentId }, orderBy: { at: 'asc' } })).map((r) => r.path)
    ).toEqual(['b.md', 'c.md'])

    // Another store of the same agent is its own ledger: a channel's `a.md` does not count against the agent store's.
    const channel = [record('a.md', t + 1), record('a.md', t + 2)]
    await repo.append(agentId, DEF_ORG, 'channels/x/memory', channel, {
      maxVersionsPerFile: 2,
      maxBytesPerRoot: 10_000
    })
    expect(await prisma.agentMemoryHistory.count({ where: { agentId } })).toBe(4)
    // Re-sending a batch is idempotent on the record id.
    await repo.append(agentId, DEF_ORG, 'channels/x/memory', channel, {
      maxVersionsPerFile: 2,
      maxBytesPerRoot: 10_000
    })
    expect(await prisma.agentMemoryHistory.count({ where: { agentId } })).toBe(4)
  })
})
