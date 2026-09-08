/**
 * `memory/store` and `memory/history/append` (D→C REQ → REP) end to end on the CP side, over the real
 * table (memory-evolution.md §3.2.1):
 *
 *  - every memory-fs op, observably the pod executor except for implicit directories;
 *  - a read is one budgeted slice that never splits a UTF-8 character;
 *  - a write is appends into a staged row plus one commit, whose `ifMatchMtime` miss is the typed
 *    `conflict` refusal, not an error REP;
 *  - the fence: an agent the connection does not serve, or whose home is not the CP, is `SCOPE_DENIED`,
 *    and an agent in another org is invisible.
 */
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { REPLY_BUDGET, type AnyFrame, type MemoryFsPayload, type MemoryFsReply } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedDutyGroup } from '../fixtures/seed.js'
import { poolSetId, seedPoolMember } from '../fakes/member-set.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import {
  PgAgentMemoryFileRepo,
  PgAgentMemoryHistoryRepo
} from '../../src/persistence/repositories/agent-memory.repo.js'
import { AgentMemoryStoreService } from '../../src/agent-memory/store.service.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { systemClock } from '../../src/domain/clock.js'
import { handleMemoryHistoryAppend, handleMemoryStore } from '../../src/ws/handlers/index.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const POOL_MEMBER = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'

const CP_HOME = { memory: { provider: 'managed', home: 'control-plane' } }

const clock = new FakeClock(Date.parse('2026-09-08T12:00:00.000Z'))

function deps(): DaemonWsDeps {
  return {
    log: { error: vi.fn() },
    agent: new PgAgentRepo(prisma),
    placementResolver: new PlacementResolver({ duties: new PgDutyGroupRepo(prisma), clock: systemClock }),
    agentMemoryStore: new AgentMemoryStoreService(new PgAgentMemoryFileRepo(prisma), clock),
    agentMemoryHistory: new PgAgentMemoryHistoryRepo(prisma)
  } as unknown as DaemonWsDeps
}

type Answer = { reply: MemoryFsReply } | { error: { code: string; message: string } }

/** One `memory/store` REQ through the real handler, as a daemon serving `orgId` would send it. */
async function store(
  daemonId: string,
  agentId: string,
  op: MemoryFsPayload,
  orgId: string = DEFAULT_ORG_ID
): Promise<Answer> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'memory/store',
    orgId,
    payload: { agentId, op }
  } as AnyFrame
  const replyTo = vi.fn()
  const sendError = vi.fn()
  await handleMemoryStore(frame, { daemonId, orgId: null, replyTo, sendError } as unknown as DaemonConnection, deps())
  if (sendError.mock.calls.length > 0) {
    const [, code, message] = sendError.mock.calls[0] as [string, string, string]
    return { error: { code, message } }
  }
  expect(replyTo).toHaveBeenCalledWith(frame, 'memory/store/ok', expect.anything())
  return { reply: replyTo.mock.calls[0]![2] as MemoryFsReply }
}

/** The op's value, asserting the reply was neither a refusal nor an error. */
async function ok<T = unknown>(daemonId: string, agentId: string, op: MemoryFsPayload): Promise<T> {
  const answer = await store(daemonId, agentId, op)
  if ('error' in answer) throw new Error(`error REP ${answer.error.code}: ${answer.error.message}`)
  if (!answer.reply.ok) throw new Error(`refusal ${answer.reply.refusal.kind}: ${answer.reply.refusal.message}`)
  return answer.reply.value as T
}

async function refusal(daemonId: string, agentId: string, op: MemoryFsPayload): Promise<'path' | 'conflict'> {
  const answer = await store(daemonId, agentId, op)
  if ('error' in answer || answer.reply.ok) throw new Error('expected a refusal')
  return answer.reply.refusal.kind
}

/** The daemon's whole-file write: chunks appended into a sibling temp, then one commit. */
async function write(
  agentId: string,
  root: string,
  rel: string,
  content: string,
  opts: { ifMatchMtime?: string; chunk?: number; daemonId?: string } = {}
): Promise<{ size: number; mtime: string }> {
  const daemonId = opts.daemonId ?? DAEMON
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
  const temp = `${dir}.agentconnect-memory-${randomUUID()}.tmp`
  const bytes = Buffer.from(content, 'utf8')
  const step = opts.chunk ?? Math.max(1, bytes.length)
  for (let offset = 0, create = true; offset < bytes.length || create; offset += step, create = false) {
    const slice = bytes.subarray(offset, offset + step)
    await ok(daemonId, agentId, {
      op: 'memory-append',
      root,
      rel: temp,
      content: slice.toString('base64'),
      encoding: 'base64',
      create
    })
  }
  return ok(daemonId, agentId, {
    op: 'memory-commit',
    root,
    rel,
    temp,
    ...(opts.ifMatchMtime ? { ifMatchMtime: opts.ifMatchMtime } : {})
  })
}

async function seedHomedAgent(opts: { daemonId?: string; setId?: string; orgId?: string } = {}): Promise<string> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, {
    ...(opts.daemonId ? { daemonId: opts.daemonId } : {}),
    ...(opts.setId ? { setId: opts.setId } : {}),
    ...(opts.orgId ? { orgId: opts.orgId } : {}),
    runtimeOverrides: CP_HOME
  })
  return agentId
}

describe('memory/store — the op set over the table', () => {
  it('appends into a staged row, commits it into place, and reads it back whole', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await seedHomedAgent({ daemonId: DAEMON })
    const stat = await write(agentId, 'memory', 'MEMORY.md', '# Index\n\nhello wörld')
    expect(stat.size).toBe(Buffer.byteLength('# Index\n\nhello wörld'))
    expect(stat.mtime).toBe(new Date(clock.now()).toISOString())

    const read = await ok<{ exists: true; content: string; size: number; mtime: string; nextOffset: number }>(
      DAEMON,
      agentId,
      { op: 'memory-read', root: 'memory', rel: 'MEMORY.md', offset: 0, limit: REPLY_BUDGET }
    )
    expect(read).toEqual({
      exists: true,
      size: stat.size,
      mtime: stat.mtime,
      content: '# Index\n\nhello wörld',
      nextOffset: stat.size
    })
    // The temp is gone: the store holds exactly the published file, marked as such.
    const rows = await prisma.agentMemoryFile.findMany({ where: { agentId } })
    expect(rows.map((r) => [r.path, r.stagedAt])).toEqual([['memory/MEMORY.md', null]])
    expect(rows[0]!.orgId).toBe(DEFAULT_ORG_ID)
    expect(
      await ok(DAEMON, agentId, { op: 'memory-read', root: 'memory', rel: 'absent.md', offset: 0, limit: 10 })
    ).toEqual({
      exists: false
    })
  })

  it('chunked appends land in order, and base64 bytes round-trip', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await seedHomedAgent({ daemonId: DAEMON })
    const text = 'αβγδε'.repeat(100)
    await write(agentId, 'memory', 'topics/greek.md', text, { chunk: 7 }) // 7 bytes: never a whole character
    const read = await ok<{ content: string }>(DAEMON, agentId, {
      op: 'memory-read',
      root: 'memory',
      rel: 'topics/greek.md',
      offset: 0,
      limit: REPLY_BUDGET,
      encoding: 'base64'
    })
    expect(Buffer.from(read.content, 'base64').toString('utf8')).toBe(text)
  })

  it('a read slice ends on a UTF-8 boundary and under the frame budget; nextOffset resumes it', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await seedHomedAgent({ daemonId: DAEMON })
    await write(agentId, 'memory', 'MEMORY.md', 'ééé') // 6 bytes, three 2-byte characters
    const first = await ok<{ content: string; nextOffset: number }>(DAEMON, agentId, {
      op: 'memory-read',
      root: 'memory',
      rel: 'MEMORY.md',
      offset: 0,
      limit: 3
    })
    expect(first).toMatchObject({ content: 'é', nextOffset: 2 })
    const second = await ok<{ content: string; nextOffset: number }>(DAEMON, agentId, {
      op: 'memory-read',
      root: 'memory',
      rel: 'MEMORY.md',
      offset: first.nextOffset,
      limit: 3
    })
    expect(second).toMatchObject({ content: 'é', nextOffset: 4 })

    // Escape-heavy text: 200 000 raw bytes encode past the budget, so the slice shrinks and the read continues.
    const newlines = '\n'.repeat(200_000)
    await write(agentId, 'memory', 'lines.md', newlines, { chunk: 100_000 })
    const parts: string[] = []
    let offset = 0
    let mtime: string | undefined
    for (let i = 0; i < 5 && offset < newlines.length; i++) {
      const slice = await ok<{ exists: true; content: string; nextOffset: number; size: number; mtime: string }>(
        DAEMON,
        agentId,
        { op: 'memory-read', root: 'memory', rel: 'lines.md', offset, limit: REPLY_BUDGET }
      )
      expect(Buffer.byteLength(JSON.stringify(slice.content))).toBeLessThanOrEqual(REPLY_BUDGET)
      expect(slice.nextOffset).toBeGreaterThan(offset)
      mtime ??= slice.mtime
      expect(slice.mtime).toBe(mtime)
      parts.push(slice.content)
      offset = slice.nextOffset
    }
    expect(parts.join('')).toBe(newlines)
    expect(parts.length).toBeGreaterThan(1)
  })

  it('a stale ifMatchMtime is the conflict refusal and drops the temp; a fresh one publishes', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await seedHomedAgent({ daemonId: DAEMON })
    const v1 = await write(agentId, 'memory', 'MEMORY.md', 'one')
    const v2 = await write(agentId, 'memory', 'MEMORY.md', 'two', { ifMatchMtime: v1.mtime })
    expect(v2.mtime > v1.mtime).toBe(true)

    const temp = '.agentconnect-memory-stale.tmp'
    await ok(DAEMON, agentId, { op: 'memory-append', root: 'memory', rel: temp, content: 'three', create: true })
    expect(
      await refusal(DAEMON, agentId, {
        op: 'memory-commit',
        root: 'memory',
        rel: 'MEMORY.md',
        temp,
        ifMatchMtime: v1.mtime
      })
    ).toBe('conflict')
    expect(await prisma.agentMemoryFile.count({ where: { agentId } })).toBe(1) // the temp is gone too
    expect(
      (
        await ok<{ content: string }>(DAEMON, agentId, {
          op: 'memory-read',
          root: 'memory',
          rel: 'MEMORY.md',
          offset: 0,
          limit: 10
        })
      ).content
    ).toBe('two')

    // A brand-new target never matches a non-empty precondition.
    await ok(DAEMON, agentId, { op: 'memory-append', root: 'memory', rel: temp, content: 'new', create: true })
    expect(
      await refusal(DAEMON, agentId, {
        op: 'memory-commit',
        root: 'memory',
        rel: 'fresh.md',
        temp,
        ifMatchMtime: v1.mtime
      })
    ).toBe('conflict')
  })

  it('directories are implicit: stat, readdir, mkdir, rmdir, rm and rename over a prefix', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await seedHomedAgent({ daemonId: DAEMON })
    const at = (rel: string) => ({ root: 'memory', rel })
    expect(await ok(DAEMON, agentId, { op: 'memory-stat', ...at('') })).toBe('missing')
    expect(await ok(DAEMON, agentId, { op: 'memory-mkdir', ...at('topics') })).toBeNull()
    expect(await ok(DAEMON, agentId, { op: 'memory-stat', ...at('topics') })).toBe('missing') // an empty directory does not exist
    expect(await ok(DAEMON, agentId, { op: 'memory-rmdir', ...at('topics') })).toBe(true)

    await write(agentId, 'memory', 'MEMORY.md', 'index')
    await write(agentId, 'memory', 'topics/a.md', 'A')
    await write(agentId, 'memory', 'topics/deep/b.md', 'B')
    expect(await ok(DAEMON, agentId, { op: 'memory-stat', ...at('') })).toBe('dir')
    expect(await ok(DAEMON, agentId, { op: 'memory-stat', ...at('topics') })).toBe('dir')
    expect(await ok(DAEMON, agentId, { op: 'memory-stat', ...at('topics/a.md') })).toBe('file')
    expect(await ok(DAEMON, agentId, { op: 'memory-stat', ...at('topics/a') })).toBe('missing') // a prefix, not a directory
    expect(await ok(DAEMON, agentId, { op: 'memory-readdir', ...at('') })).toEqual([
      { name: 'MEMORY.md', kind: 'file', size: 5, mtime: expect.any(String) },
      { name: 'topics', kind: 'dir' }
    ])
    expect(await ok(DAEMON, agentId, { op: 'memory-readdir', ...at('topics') })).toEqual([
      { name: 'a.md', kind: 'file', size: 1, mtime: expect.any(String) },
      { name: 'deep', kind: 'dir' }
    ])
    expect(await ok(DAEMON, agentId, { op: 'memory-readdir', ...at('nowhere') })).toEqual([])
    expect(await ok(DAEMON, agentId, { op: 'memory-rmdir', ...at('topics') })).toBe(false)
    expect(await ok(DAEMON, agentId, { op: 'memory-rmdir', ...at('topics/a.md') })).toBe(false)

    // Renaming a directory rewrites the prefix of every row beneath it, and the tree root sees the move.
    expect(
      await ok(DAEMON, agentId, { op: 'memory-rename', root: '.', from: 'memory', to: 'memory-backups/pre-dream' })
    ).toBe(true)
    expect(await ok(DAEMON, agentId, { op: 'memory-stat', ...at('') })).toBe('missing')
    expect(
      (await prisma.agentMemoryFile.findMany({ where: { agentId }, orderBy: { path: 'asc' } })).map((r) => r.path)
    ).toEqual([
      'memory-backups/pre-dream/MEMORY.md',
      'memory-backups/pre-dream/topics/a.md',
      'memory-backups/pre-dream/topics/deep/b.md'
    ])
    expect(await ok(DAEMON, agentId, { op: 'memory-rename', root: '.', from: 'memory', to: 'elsewhere' })).toBe(false)
    // A file rename overwrites its target; a rename onto an occupied directory is refused as disk refuses it.
    await write(agentId, 'memory-backups/pre-dream', 'topics/c.md', 'C')
    expect(
      await ok(DAEMON, agentId, {
        op: 'memory-rename',
        root: 'memory-backups/pre-dream',
        from: 'topics/c.md',
        to: 'topics/a.md'
      })
    ).toBe(true)
    expect(
      (
        await ok<{ content: string }>(DAEMON, agentId, {
          op: 'memory-read',
          root: 'memory-backups/pre-dream',
          rel: 'topics/a.md',
          offset: 0,
          limit: 10
        })
      ).content
    ).toBe('C')
    expect(
      await refusal(DAEMON, agentId, {
        op: 'memory-rename',
        root: 'memory-backups/pre-dream',
        from: 'topics/a.md',
        to: 'topics/deep'
      })
    ).toBe('path')

    // rm takes the row or the whole prefix; absence is fine.
    expect(await ok(DAEMON, agentId, { op: 'memory-rm', root: 'memory-backups/pre-dream', rel: 'topics' })).toBeNull()
    expect(await ok(DAEMON, agentId, { op: 'memory-rm', root: 'memory-backups/pre-dream', rel: 'topics' })).toBeNull()
    expect((await prisma.agentMemoryFile.findMany({ where: { agentId } })).map((r) => r.path)).toEqual([
      'memory-backups/pre-dream/MEMORY.md'
    ])
    expect(await ok(DAEMON, agentId, { op: 'memory-rmdir', root: 'memory-backups/pre-dream', rel: 'topics' })).toBe(
      true
    )
  })

  it('utimes sets the token a later precondition compares', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await seedHomedAgent({ daemonId: DAEMON })
    await write(agentId, 'memory', 'MEMORY.md', 'x')
    const kept = '2026-01-01T00:00:00.000Z'
    expect(await ok(DAEMON, agentId, { op: 'memory-utimes', root: 'memory', rel: 'MEMORY.md', mtime: kept })).toBeNull()
    expect(await ok(DAEMON, agentId, { op: 'memory-utimes', root: 'memory', rel: 'absent.md', mtime: kept })).toBeNull()
    const read = await ok<{ mtime: string }>(DAEMON, agentId, {
      op: 'memory-read',
      root: 'memory',
      rel: 'MEMORY.md',
      offset: 0,
      limit: 10
    })
    expect(read.mtime).toBe(kept)
    expect((await write(agentId, 'memory', 'MEMORY.md', 'y', { ifMatchMtime: kept })).size).toBe(1)
  })

  it('refuses what the daemon refuses: escapes, absolute paths, a temp away from its target, the tree root as a file', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await seedHomedAgent({ daemonId: DAEMON })
    const read = (root: string, rel: string): MemoryFsPayload => ({
      op: 'memory-read',
      root,
      rel,
      offset: 0,
      limit: 10
    })
    expect(await refusal(DAEMON, agentId, read('memory', '../agent.json'))).toBe('path')
    expect(await refusal(DAEMON, agentId, read('memory', '/etc/passwd'))).toBe('path')
    expect(await refusal(DAEMON, agentId, read('/abs', 'MEMORY.md'))).toBe('path')
    expect(await refusal(DAEMON, agentId, read('memory', 'a\0b'))).toBe('path')
    expect(await refusal(DAEMON, agentId, read('.', ''))).toBe('path')
    expect(await refusal(DAEMON, agentId, { op: 'memory-rm', root: '.', rel: '' })).toBe('path')
    expect(
      await refusal(DAEMON, agentId, { op: 'memory-commit', root: 'memory', rel: 'MEMORY.md', temp: 'elsewhere/.tmp' })
    ).toBe('path')
    expect(
      await refusal(DAEMON, agentId, { op: 'memory-commit', root: 'memory', rel: 'MEMORY.md', temp: '.gone.tmp' })
    ).toBe('path')
    expect(
      await refusal(DAEMON, agentId, {
        op: 'memory-append',
        root: 'memory',
        rel: '.gone.tmp',
        content: 'x',
        create: false
      })
    ).toBe('path')
    expect(await prisma.agentMemoryFile.count({ where: { agentId } })).toBe(0)
  })

  it('answers the per-file cap as BAD_PAYLOAD, never a refusal', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await seedHomedAgent({ daemonId: DAEMON })
    await ok(DAEMON, agentId, {
      op: 'memory-append',
      root: 'memory',
      rel: '.big.tmp',
      content: 'x'.repeat(200_000),
      create: true
    })
    const answer = await store(DAEMON, agentId, {
      op: 'memory-append',
      root: 'memory',
      rel: '.big.tmp',
      content: 'y'.repeat(56_001),
      create: false
    })
    expect(answer).toEqual({ error: { code: 'BAD_PAYLOAD', message: 'memory file exceeds the 256000-byte limit' } })
    expect(
      await ok(DAEMON, agentId, {
        op: 'memory-append',
        root: 'memory',
        rel: '.big.tmp',
        content: 'y'.repeat(56_000),
        create: false
      })
    ).toEqual({
      size: 256_000
    })
  })
})

describe('memory/store — the fence', () => {
  it('SCOPE_DENIED for a daemon that does not serve the agent, by placement or by duty', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    await seedPoolMember(prisma, POOL_MEMBER)
    const placed = await seedHomedAgent({ daemonId: DAEMON })
    const op: MemoryFsPayload = { op: 'memory-stat', root: 'memory', rel: '' }
    expect(await store(OTHER_DAEMON, placed, op)).toEqual({
      error: { code: 'SCOPE_DENIED', message: 'agent is not served by this daemon' }
    })
    expect(await store(DAEMON, placed, op)).toEqual({ reply: { ok: true, value: 'missing' } })

    const pooled = await seedHomedAgent({ setId: await poolSetId(prisma) })
    expect((await store(POOL_MEMBER, pooled, op)) as Answer).toMatchObject({ error: { code: 'SCOPE_DENIED' } })
    await seedDutyGroup(prisma, randomUUID(), POOL_MEMBER, [pooled])
    expect(await store(POOL_MEMBER, pooled, op)).toEqual({ reply: { ok: true, value: 'missing' } })
    expect((await store(OTHER_DAEMON, pooled, op)) as Answer).toMatchObject({ error: { code: 'SCOPE_DENIED' } })
  })

  it('SCOPE_DENIED for an agent whose home is still the daemon', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      daemonId: DAEMON,
      runtimeOverrides: { memory: { provider: 'managed', home: 'daemon' } }
    })
    expect(await store(DAEMON, agentId, { op: 'memory-stat', root: 'memory', rel: '' })).toEqual({
      error: { code: 'SCOPE_DENIED', message: 'the agent memory home is not the Control Plane' }
    })
  })

  it('org fencing: an agent in another org is invisible, and rows carry their org', async () => {
    await seedDaemon(prisma, DAEMON)
    const foreignOrg = `org-${randomUUID().slice(0, 8)}`
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    const foreign = await seedHomedAgent({ daemonId: DAEMON, orgId: foreignOrg })
    const local = await seedHomedAgent({ daemonId: DAEMON })
    const op: MemoryFsPayload = { op: 'memory-stat', root: 'memory', rel: '' }
    expect(await store(DAEMON, foreign, op, DEFAULT_ORG_ID)).toMatchObject({ error: { code: 'SCOPE_DENIED' } })
    expect(await store(DAEMON, local, op, foreignOrg)).toMatchObject({ error: { code: 'SCOPE_DENIED' } })

    await write(local, 'memory', 'MEMORY.md', 'mine')
    expect(await store(DAEMON, foreign, op, foreignOrg)).toEqual({ reply: { ok: true, value: 'missing' } })
    expect(await prisma.agentMemoryFile.findMany({ where: { orgId: foreignOrg } })).toEqual([])
    expect((await prisma.agentMemoryFile.findMany({ where: { agentId: local } })).map((r) => r.orgId)).toEqual([
      DEFAULT_ORG_ID
    ])
  })
})

describe('memory/history/append', () => {
  async function append(daemonId: string, agentId: string, root: string, records: unknown[]): Promise<Answer> {
    const frame = {
      v: 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'memory/history/append',
      orgId: DEFAULT_ORG_ID,
      payload: { agentId, root, records }
    } as AnyFrame
    const replyTo = vi.fn()
    const sendError = vi.fn()
    await handleMemoryHistoryAppend(
      frame,
      { daemonId, orgId: null, replyTo, sendError } as unknown as DaemonConnection,
      deps()
    )
    if (sendError.mock.calls.length > 0) {
      const [, code, message] = sendError.mock.calls[0] as [string, string, string]
      return { error: { code, message } }
    }
    return { reply: replyTo.mock.calls[0]![2] as MemoryFsReply }
  }

  const record = (path: string, at: string, id?: string) => ({
    ...(id ? { id } : {}),
    path,
    event: 'update',
    before: 'a',
    after: 'b',
    at,
    scope: 'agent',
    source: 'tool'
  })

  it('stores the batch idempotently under the same fence', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    const agentId = await seedHomedAgent({ daemonId: DAEMON })
    const id = randomUUID()
    const batch = [
      record('MEMORY.md', '2026-09-08T10:00:00.000Z', id),
      record('topics/a.md', '2026-09-08T10:00:01.000Z')
    ]
    expect(await append(OTHER_DAEMON, agentId, 'memory', batch)).toMatchObject({ error: { code: 'SCOPE_DENIED' } })
    expect(await append(DAEMON, agentId, 'memory', batch)).toEqual({ reply: { accepted: true } })
    expect(await append(DAEMON, agentId, 'memory', [batch[0]!])).toEqual({ reply: { accepted: true } })
    const rows = await prisma.agentMemoryHistory.findMany({ where: { agentId }, orderBy: { at: 'asc' } })
    expect(rows.map((r) => [r.id === id, r.root, r.path, r.event, r.before, r.after, r.source, r.orgId])).toEqual([
      [true, 'memory', 'MEMORY.md', 'update', 'a', 'b', 'tool', DEFAULT_ORG_ID],
      [false, 'memory', 'topics/a.md', 'update', 'a', 'b', 'tool', DEFAULT_ORG_ID]
    ])
    expect(rows[0]!.bytes).toBe(Buffer.byteLength(JSON.stringify({ ...batch[0], id }) + '\n'))
  })
})
