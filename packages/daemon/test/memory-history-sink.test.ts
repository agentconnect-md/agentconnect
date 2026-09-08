// The change-log sink (memory-evolution.md §3.2.1): the seam every managed-memory writer hands its records to, the
// sidecar behind it today, and `CpMemoryHistorySink` — batches under the wire's two limits, tree-relative roots, and
// best-effort delivery that warns once and never rejects.
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WireError } from '@agentconnect.md/connection'
import {
  MEMORY_HISTORY_APPEND_MAX_RECORDS,
  MemoryHistoryAppendReq,
  REPLY_BUDGET,
  type MemoryHistoryAppendOk
} from '@agentconnect.md/protocol'
import { CpMemoryFs } from '../src/cp/memory-fs.js'
import { CpMemoryHistorySink, packMemoryHistoryBatches, type CpMemoryHistoryLink } from '../src/cp/memory-history.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { resolveMemoryHomePorts } from '../src/memory/home.js'
import {
  MEMORY_HISTORY_FILENAME,
  MEMORY_INDEX,
  SidecarMemoryHistorySink,
  channelMemoryRoot,
  memoryDir,
  memoryHistoryRecord,
  writeMemoryFile,
  type MemoryHistoryRecord,
  type MemoryHistorySink
} from '../src/memory/store.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-history-sink-'))
  dirs.push(dir)
  return dir
}

function readSidecar(dir: string): MemoryHistoryRecord[] {
  return readFileSync(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MemoryHistoryRecord)
}

/** A sink that only remembers what it was handed, the way a home other than the sidecar receives records. */
function recordingSink(): MemoryHistorySink & { batches: MemoryHistoryRecord[][]; carried: string[] } {
  const batches: MemoryHistoryRecord[][] = []
  const carried: string[] = []
  return {
    batches,
    carried,
    append: async (records) => void batches.push(records),
    carryInto: async (replacement) => void carried.push(replacement)
  }
}

function record(path: string, after: string, before?: string): MemoryHistoryRecord {
  return memoryHistoryRecord(path, before, after, '2026-01-01T00:00:00.000Z', 'tool')
}

describe('the sink seam in the write path', () => {
  it('hands every write one record with the id the daemon minted, and writes no sidecar when the sink is not one', async () => {
    const dir = newDir()
    const fs = new LocalMemoryFs(dir)
    const sink = recordingSink()
    await writeMemoryFile(fs, 'notes.md', 'v1', undefined, 'console', sink)
    await writeMemoryFile(fs, 'notes.md', 'v2', undefined, 'tool', sink)
    expect(sink.batches.map((batch) => batch.length)).toEqual([1, 1])
    const [add, update] = sink.batches.map((batch) => batch[0]!)
    expect(add).toMatchObject({ path: 'notes.md', event: 'add', after: 'v1', scope: 'agent', source: 'console' })
    expect(add!.before).toBeUndefined()
    expect(update).toMatchObject({ path: 'notes.md', event: 'update', before: 'v1', after: 'v2', source: 'tool' })
    expect(add!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(update!.id).not.toBe(add!.id)
    expect(existsSync(join(memoryDir(dir), MEMORY_HISTORY_FILENAME))).toBe(false)
  })

  it('routes the regenerated index through the same sink as the topic write that caused it', async () => {
    const fs = new LocalMemoryFs(newDir())
    const sink = recordingSink()
    await writeMemoryFile(fs, 'deploys.md', '---\ndescription: how we ship\n---\nbody\n', undefined, 'tool', sink)
    expect(sink.batches.flat().map((event) => [event.path, event.source])).toEqual([
      ['deploys.md', 'tool'],
      [MEMORY_INDEX, 'tool']
    ])
  })

  it('never fails the write it describes when the sink rejects', async () => {
    const dir = newDir()
    const fs = new LocalMemoryFs(dir)
    const failing: MemoryHistorySink = {
      append: async () => {
        throw new Error('table unavailable')
      },
      carryInto: async () => {}
    }
    await expect(writeMemoryFile(fs, 'notes.md', 'kept', undefined, 'tool', failing)).resolves.toMatchObject({
      size: 4
    })
    expect(readFileSync(join(memoryDir(dir), 'notes.md'), 'utf8')).toBe('kept')
  })

  it('a `daemon` home selects the sidecar inside the store, and pages it back', async () => {
    const dir = newDir()
    const ports = resolveMemoryHomePorts({ id: 'bot-a', dir }, { log: { warn: () => {} } })
    const sink = ports.historyFor(ports.live)
    expect(sink).toBeInstanceOf(SidecarMemoryHistorySink)
    await writeMemoryFile(ports.live, 'notes.md', 'v1', undefined, 'tool', sink)
    await sink.append([record('notes.md', 'v2', 'v1')])
    expect(readSidecar(dir).map((event) => event.after)).toEqual(['v1', 'v2'])
    const page = await sink.list!('notes.md', undefined, 5)
    expect(page.events.map((event) => event.after)).toEqual(['v2', 'v1'])
    // A store swap keeps a log that lives inside the store: the carry is the canonical log, ready to append to.
    await sink.carryInto('.memory.adopting-x')
    expect(readFileSync(join(dir, '.memory.adopting-x', MEMORY_HISTORY_FILENAME), 'utf8')).toBe(
      readFileSync(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), 'utf8')
    )
  })
})

type FakeLink = CpMemoryHistoryLink & { requests: MemoryHistoryAppendReq[]; warnings: string[] }

/** The CP connection as the sink sees it: the wire's own strict parse on every request, and a log that remembers. */
function fakeLink(over: Partial<CpMemoryHistoryLink> = {}): FakeLink {
  const requests: MemoryHistoryAppendReq[] = []
  return {
    requests,
    warnings: [],
    connected: () => true,
    supportsServerFeature: (feature) => feature === 'agent-memory-store-v1',
    async memoryHistoryAppend(req): Promise<MemoryHistoryAppendOk> {
      requests.push(MemoryHistoryAppendReq.parse(req))
      return { accepted: true }
    },
    ...over
  }
}

const neverOp = (): never => {
  throw new Error('no store op belongs in this test')
}

const sinkOver = (link: FakeLink, root?: string) =>
  new CpMemoryHistorySink(link, AGENT, root, { warn: (msg) => link.warnings.push(msg) })

describe('CpMemoryHistorySink (the sink over the CP connection)', () => {
  it('names the agent and the tree-relative root — the agent tree, or a channel store in CpMemoryFs coordinates', async () => {
    const link = fakeLink()
    await sinkOver(link).append([record('notes.md', 'v1')])
    // The store's own port names the root the sink must name; its ops never run here.
    const storeLink = { connected: () => true, supportsServerFeature: () => true, memoryStore: async () => neverOp() }
    const channelStore = channelMemoryRoot(new CpMemoryFs(storeLink, AGENT), 'general-abc123')
    await sinkOver(link, channelStore.root).append([record('notes.md', 'v1')])
    expect(link.requests.map((req) => [req.agentId, req.root])).toEqual([
      [AGENT, '.'],
      [AGENT, 'channels/general-abc123']
    ])
    expect(link.warnings).toEqual([])
  })

  it('carries the ids the daemon minted, so a resend is the same rows, and carries nothing into a store swap', async () => {
    const link = fakeLink()
    // Seen as the port the writers hold: the swap hook is a no-op, and there is no local page to read back.
    const sink: MemoryHistorySink = sinkOver(link)
    const rows = [record('a.md', 'x'), record('b.md', 'y')]
    await sink.append(rows)
    await sink.append(rows)
    expect(link.requests.map((req) => req.records.map((event) => event.id))).toEqual([
      rows.map((event) => event.id),
      rows.map((event) => event.id)
    ])
    await sink.carryInto('.memory.adopting-x')
    expect(sink.list).toBeUndefined()
    expect(link.requests).toHaveLength(2)
  })

  it('splits a large set at the record cap, in order', async () => {
    const link = fakeLink()
    const rows = Array.from({ length: 150 }, (_, index) => record(`t${index}.md`, String(index)))
    await sinkOver(link).append(rows)
    expect(link.requests.map((req) => req.records.length)).toEqual([MEMORY_HISTORY_APPEND_MAX_RECORDS, 64, 22])
    expect(link.requests.flatMap((req) => req.records.map((event) => event.path))).toEqual(rows.map((r) => r.path))
    expect(link.warnings).toEqual([])
  })

  it('splits at the frame budget with multi-byte snapshots, each batch as full as the wire allows', async () => {
    // Every row carries two clamped snapshots of multi-byte text, so the byte bound trips long before the record cap.
    const rows = Array.from({ length: 80 }, (_, index) =>
      record(`t${index}.md`, 'é'.repeat(1_900) + index, '🚀'.repeat(950) + index)
    )
    const batches = packMemoryHistoryBatches(AGENT, '.', rows)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flatMap((batch) => batch.records)).toEqual(rows)
    for (const [index, batch] of batches.entries()) {
      expect(batch.records.length).toBeLessThan(MEMORY_HISTORY_APPEND_MAX_RECORDS)
      // The wire's own refinement accepts the batch as packed...
      expect(MemoryHistoryAppendReq.safeParse(batch).success).toBe(true)
      // ...and would refuse it with the next batch's first record added, so no batch was cut short.
      const next = batches[index + 1]?.records[0]
      if (!next) continue
      const overfull = { ...batch, records: [...batch.records, next] }
      expect(Buffer.byteLength(JSON.stringify(overfull))).toBeGreaterThan(REPLY_BUDGET)
      expect(MemoryHistoryAppendReq.safeParse(overfull).success).toBe(false)
    }
    const link = fakeLink()
    await sinkOver(link).append(rows)
    expect(link.requests.map((req) => req.records.length)).toEqual(batches.map((batch) => batch.records.length))
  })

  it('warns once with the reason and returns normally whatever fails — the write already happened', async () => {
    const rows = [record('a.md', 'x')]
    const closed = fakeLink({ connected: () => false })
    await sinkOver(closed).append(rows)
    expect(closed.requests).toEqual([])
    expect(closed.warnings).toEqual([expect.stringContaining('1 memory change-log record(s) for . not recorded')])
    expect(closed.warnings[0]).toContain('the connection is down')

    const older = fakeLink({ supportsServerFeature: () => false })
    await sinkOver(older).append(rows)
    expect(older.requests).toEqual([])
    expect(older.warnings).toEqual([expect.stringContaining('does not serve the memory store')])

    const rejecting = (err: Error) =>
      fakeLink({
        memoryHistoryAppend: async () => {
          throw err
        }
      })
    const denied = rejecting(new WireError('SCOPE_DENIED', 'agent is not served here', false))
    await sinkOver(denied).append(rows)
    expect(denied.warnings).toEqual([expect.stringContaining('SCOPE_DENIED: agent is not served here')])
    const timedOut = rejecting(new WireError('INTERNAL', 'no ack after 1 try', true))
    await sinkOver(timedOut).append(rows)
    expect(timedOut.warnings).toEqual([expect.stringContaining('INTERNAL: no ack after 1 try')])
    const broken = rejecting(new TypeError('boom'))
    await sinkOver(broken).append(rows)
    expect(broken.warnings).toEqual([expect.stringContaining('TypeError: boom')])

    // A failure mid-run ends the run, and the warning counts what never reached the table.
    const flaky = fakeLink()
    const delivered: number[] = []
    flaky.memoryHistoryAppend = async (req) => {
      if (delivered.length === 1) throw new WireError('INTERNAL', 'dropped', true)
      delivered.push(req.records.length)
      return { accepted: true }
    }
    await sinkOver(flaky).append(Array.from({ length: 150 }, (_, index) => record(`t${index}.md`, String(index))))
    expect(delivered).toEqual([64])
    expect(flaky.warnings).toEqual([expect.stringContaining('86 memory change-log record(s)')])

    // Nothing to send is nothing to warn about.
    const idle = fakeLink()
    await sinkOver(idle).append([])
    expect(idle.requests).toEqual([])
    expect(idle.warnings).toEqual([])
  })
})
