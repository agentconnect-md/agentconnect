import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { LocalStore, sqliteStoreDatabase, type StoreDatabase } from '../src/store/local-store.js'

/**
 * Round trips, not statements. A pool member's store is one worker thread holding one
 * PostgreSQL client, and every call blocks the daemon's event loop until it answers — so the
 * cost of a turn is how many times the store is asked, and these are the numbers that pin it.
 * A change that reintroduces per-chunk chatter fails here instead of quietly costing latency.
 */
function countingStore(): {
  store: LocalStore
  roundTrips: () => number
  reset: () => void
} {
  const backing = sqliteStoreDatabase(new DatabaseSync(':memory:'))
  let count = 0
  const counting: StoreDatabase = {
    exec: (sql) => {
      count++
      backing.exec(sql)
    },
    batch: (statements) => {
      count++
      return backing.batch(statements)
    },
    close: () => backing.close(),
    prepare: (sql) => {
      const statement = backing.prepare(sql)
      return {
        run: (...params) => {
          count++
          return statement.run(...params)
        },
        get: (...params) => {
          count++
          return statement.get(...params)
        },
        all: (...params) => {
          count++
          return statement.all(...params)
        }
      }
    }
  }
  return {
    store: new LocalStore({ database: counting }),
    roundTrips: () => count,
    reset: () => {
      count = 0
    }
  }
}

const CHANNEL = 'C1'
const THREAD = 'T1'
const AGENT = 'bot-a'

const body = (n: number): string => JSON.stringify({ toolCallId: 'tc-1', status: 'in_progress', chunk: n })

function seeded(): ReturnType<typeof countingStore> {
  const counting = countingStore()
  counting.store.insertToolCall({
    channel: CHANNEL,
    thread: THREAD,
    ts: '1',
    sender: AGENT,
    toolCallId: 'tc-1',
    title: 'Bash',
    body: body(0)
  })
  counting.reset()
  return counting
}

const toolRow = (store: LocalStore): { text: string; body: string } =>
  store.threadTranscript(CHANNEL, THREAD).find((row) => row.kind === 'tool') as unknown as {
    text: string
    body: string
  }

describe('store round trips per streaming turn', () => {
  it('costs one round trip to append a transcript row, its delivery, and read the thread revision', () => {
    const { store, roundTrips, reset } = countingStore()
    reset()
    store.appendTranscript({
      channel: CHANNEL,
      thread: THREAD,
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'question?'
    })
    expect(roundTrips()).toBe(1)
  })

  it('costs one round trip to insert a tool row and read the thread revision', () => {
    const { store, roundTrips, reset } = countingStore()
    reset()
    store.insertToolCall({
      channel: CHANNEL,
      thread: THREAD,
      ts: '1',
      sender: AGENT,
      toolCallId: 'tc-1',
      title: 'Bash',
      body: body(0)
    })
    expect(roundTrips()).toBe(1)
  })

  it('costs one round trip for a whole tool_call_update burst, not two per chunk', () => {
    const { store, roundTrips } = seeded()
    for (let chunk = 1; chunk <= 12; chunk++) {
      store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(chunk) })
    }
    // Nothing has been asked of the store yet: the burst is still one buffered row.
    expect(roundTrips()).toBe(0)
    store.flushToolCallWrites()
    // The coalesced write and the revision the mutation notice carries ride the same batch.
    expect(roundTrips()).toBe(1)
    expect(toolRow(store).body).toBe(body(12))
  })

  it('keeps the buffer bounded: a burst past the row bound flushes instead of growing', () => {
    const { store, roundTrips, reset } = seeded()
    for (let call = 0; call < 200; call++) {
      store.insertToolCall({
        channel: CHANNEL,
        thread: THREAD,
        ts: '1',
        sender: AGENT,
        toolCallId: `tc-${call}`,
        title: 'Bash',
        body: body(0)
      })
    }
    reset()
    for (let call = 0; call < 200; call++) {
      store.updateToolCall(CHANNEL, THREAD, AGENT, `tc-${call}`, { title: 'Bash', body: body(call + 1) })
    }
    // Bounded at 64 rows, so 200 tool calls in flight flush three times — one round trip each —
    // and the last 8 stay buffered for the next flush point.
    expect(roundTrips()).toBe(3)
  })

  it('flushes early when the buffered bodies outgrow the byte bound, not just the row bound', () => {
    const { store, roundTrips, reset } = seeded()
    // Eight rows is far under the 64-row bound, but 8 MiB of bodies is over the byte bound.
    for (let call = 0; call < 8; call++) {
      store.insertToolCall({
        channel: CHANNEL,
        thread: THREAD,
        ts: '1',
        sender: AGENT,
        toolCallId: `big-${call}`,
        title: 'Bash',
        body: body(0)
      })
    }
    reset()
    const megabyte = 'x'.repeat(1024 * 1024)
    for (let call = 0; call < 8; call++) {
      store.updateToolCall(CHANNEL, THREAD, AGENT, `big-${call}`, { title: 'Bash', body: megabyte })
    }
    expect(roundTrips()).toBeGreaterThan(0)
  })
})

describe('the coalescing buffer is invisible to a reader', () => {
  it('serves the latest body to a read that lands mid-burst', () => {
    const { store } = seeded()
    store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(1) })
    store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(2) })
    // No explicit flush: the read itself drains the buffer.
    expect(toolRow(store).body).toBe(body(2))
    store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Ripgrep', body: body(3) })
    expect(toolRow(store)).toMatchObject({ text: 'Ripgrep', body: body(3) })
  })

  it('lets another transcript write pass only after the buffered one has landed', () => {
    const { store } = seeded()
    store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(9) })
    store.appendTranscript({ channel: CHANNEL, thread: THREAD, ts: '2', sender: AGENT, kind: 'text', text: 'done' })
    const rows = store.threadTranscript(CHANNEL, THREAD)
    // Ordering is preserved: the tool row still precedes the reply it ran for.
    expect(rows.map((row) => row.kind)).toEqual(['tool', 'text'])
    expect(toolRow(store).body).toBe(body(9))
  })

  it('raises one mutation notice per flush, carrying the revision the flushed row landed on', () => {
    const { store } = seeded()
    const seen: { revision: number; agentIds: string[] }[] = []
    store.setTranscriptMutationListener((mutation) => seen.push(mutation))
    for (let chunk = 1; chunk <= 5; chunk++) {
      store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(chunk) })
    }
    expect(seen).toEqual([])
    store.flushToolCallWrites()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.agentIds).toEqual([AGENT])
    expect(seen[0]!.revision).toBe(store.currentTranscriptRevision())
  })

  it('lands a buffered body on close, so a drain cannot lose it', () => {
    const backing = sqliteStoreDatabase(new DatabaseSync(':memory:'))
    // A store closing over a borrowed database: `close` must flush without ending the backend.
    const borrowed: StoreDatabase = { ...backing, close: () => undefined }
    const first = new LocalStore({ database: borrowed })
    first.insertToolCall({
      channel: CHANNEL,
      thread: THREAD,
      ts: '1',
      sender: AGENT,
      toolCallId: 'tc-1',
      title: 'Bash',
      body: body(0)
    })
    first.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(7) })
    first.close()
    expect(toolRow(new LocalStore({ database: borrowed })).body).toBe(body(7))
  })

  it('writes a buffered body on its own timer when nothing else touches the store', async () => {
    vi.useFakeTimers()
    try {
      const { store, roundTrips } = seeded()
      store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(4) })
      expect(roundTrips()).toBe(0)
      await vi.advanceTimersByTimeAsync(1_000)
      // The round trip proves the timer wrote; a read here would have drained it either way.
      expect(roundTrips()).toBe(1)
      expect(toolRow(store).body).toBe(body(4))
    } finally {
      vi.useRealTimers()
    }
  })

  it('never re-issues a revision after a flush that spanned several threads', () => {
    const { store } = countingStore()
    const rows: { thread: string; id: string }[] = [
      { thread: 'T1', id: 'tc-a' },
      { thread: 'T2', id: 'tc-b' },
      { thread: 'T1', id: 'tc-c' }
    ]
    for (const { thread, id } of rows) {
      store.insertToolCall({
        channel: CHANNEL,
        thread,
        ts: id,
        sender: AGENT,
        toolCallId: id,
        title: 'Bash',
        body: body(0)
      })
    }
    // Interleaved threads, so the thread read last is NOT the one holding the highest revision.
    for (const { thread, id } of rows) {
      store.updateToolCall(CHANNEL, thread, AGENT, id, { title: 'Bash', body: body(1) })
    }
    store.flushToolCallWrites()
    const issued = ['T1', 'T2'].flatMap((thread) =>
      store.threadTranscript(CHANNEL, thread).map((row) => Number(row.revision))
    )
    store.appendTranscript({ channel: CHANNEL, thread: 'T2', ts: 'next', sender: AGENT, kind: 'text', text: 'done' })
    const after = store.threadTranscript(CHANNEL, 'T2').map((row) => Number(row.revision))
    // The allocator spans every partition: the next row must outrank every revision already out.
    expect(Math.max(...after)).toBeGreaterThan(Math.max(...issued))
    expect(new Set(issued).size).toBe(issued.length)
  })

  it('refuses an unattributable agent at the call that enqueued it, not at the flush', () => {
    const backing = sqliteStoreDatabase(new DatabaseSync(':memory:'))
    const shared = new LocalStore({
      database: backing,
      shared: true,
      ownerId: 'member-1',
      orgForAgent: (id) => (id === AGENT ? 'org-a' : undefined)
    })
    expect(() => shared.updateToolCall(CHANNEL, THREAD, 'stranger', 'tc-1', { title: 'Bash', body: body(1) })).toThrow(
      /cannot resolve the transcript organization/
    )
    shared.close()
  })
})

describe('the batch statement seam', () => {
  it('returns one result per statement, in order, with reads and writes told apart', () => {
    const backing = sqliteStoreDatabase(new DatabaseSync(':memory:'))
    const store = new LocalStore({ database: backing })
    store.appendTranscript({ channel: CHANNEL, thread: THREAD, ts: '1', sender: 'U1', kind: 'text', text: 'one' })
    const results = backing.batch([
      {
        kind: 'run',
        sql: "UPDATE transcript SET text = 'two' WHERE channel = ? AND thread = ?",
        params: [CHANNEL, THREAD]
      },
      { kind: 'read', sql: 'SELECT text FROM transcript WHERE channel = ? AND thread = ?', params: [CHANNEL, THREAD] }
    ])
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ changes: 1, rows: [] })
    expect(results[1]!.rows).toEqual([{ text: 'two' }])
    store.close()
  })
})
