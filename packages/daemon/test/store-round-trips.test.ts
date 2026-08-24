import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { LocalStore, type StoreDatabase } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

/**
 * Round trips, not statements. A pool member's store is one worker thread holding one
 * PostgreSQL client, and every call blocks the daemon's event loop until it answers — so the
 * cost of a turn is how many times the store is asked, and these are the numbers that pin it.
 * A change that reintroduces per-chunk chatter fails here instead of quietly costing latency.
 */
async function countingStore(): Promise<{
  store: LocalStore
  roundTrips: () => number
  reset: () => void
}> {
  const backing = SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:'))
  let count = 0
  // A transaction is one round trip's worth of pinned client, but each statement inside it
  // still asks the database, so they are counted the same as an unwrapped one.
  const counting: StoreDatabase = {
    exec: (sql) => {
      count++
      return backing.exec(sql)
    },
    query: (sql, params) => {
      count++
      return backing.query(sql, params)
    },
    batch: (statements) => {
      count++
      return backing.batch(statements)
    },
    transaction: (fn) =>
      backing.transaction((tx) =>
        fn({
          exec: (sql) => {
            count++
            return tx.exec(sql)
          },
          query: (sql, params) => {
            count++
            return tx.query(sql, params)
          },
          batch: (statements) => {
            count++
            return tx.batch(statements)
          }
        })
      ),
    close: () => backing.close()
  }
  return {
    store: await LocalStore.open({ database: counting }),
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

async function seeded(): Promise<Awaited<ReturnType<typeof countingStore>>> {
  const counting = await countingStore()
  await counting.store.insertToolCall({
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

const toolRow = async (store: LocalStore): Promise<{ text: string; body: string }> =>
  (await store.threadTranscript(CHANNEL, THREAD)).find((row) => row.kind === 'tool') as unknown as {
    text: string
    body: string
  }

describe('store round trips per streaming turn', () => {
  it('costs one round trip to append a transcript row, its delivery, and read the thread revision', async () => {
    const { store, roundTrips, reset } = await countingStore()
    reset()
    await store.appendTranscript({
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

  it('costs one round trip to insert a tool row and read the thread revision', async () => {
    const { store, roundTrips, reset } = await countingStore()
    reset()
    await store.insertToolCall({
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

  it('costs one round trip for a whole tool_call_update burst, not two per chunk', async () => {
    const { store, roundTrips } = await seeded()
    for (let chunk = 1; chunk <= 12; chunk++) {
      await store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(chunk) })
    }
    // Nothing has been asked of the store yet: the burst is still one buffered row.
    expect(roundTrips()).toBe(0)
    await store.flushToolCallWrites()
    // The coalesced write and the revision the mutation notice carries ride the same batch.
    expect(roundTrips()).toBe(1)
    expect((await toolRow(store)).body).toBe(body(12))
  })

  it('keeps the buffer bounded: a burst past the row bound flushes instead of growing', async () => {
    const { store, roundTrips, reset } = await seeded()
    for (let call = 0; call < 200; call++) {
      await store.insertToolCall({
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
      await store.updateToolCall(CHANNEL, THREAD, AGENT, `tc-${call}`, { title: 'Bash', body: body(call + 1) })
    }
    // Bounded at 64 rows, so 200 tool calls in flight flush three times — one round trip each —
    // and the last 8 stay buffered for the next flush point.
    expect(roundTrips()).toBe(3)
  })

  it('flushes early when the buffered bodies outgrow the byte bound, not just the row bound', async () => {
    const { store, roundTrips, reset } = await seeded()
    // Eight rows is far under the 64-row bound, but 8 MiB of bodies is over the byte bound.
    for (let call = 0; call < 8; call++) {
      await store.insertToolCall({
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
      await store.updateToolCall(CHANNEL, THREAD, AGENT, `big-${call}`, { title: 'Bash', body: megabyte })
    }
    expect(roundTrips()).toBeGreaterThan(0)
  })
})

describe('the coalescing buffer is invisible to a reader', () => {
  it('serves the latest body to a read that lands mid-burst', async () => {
    const { store } = await seeded()
    await store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(1) })
    await store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(2) })
    // No explicit flush: the read itself drains the buffer.
    expect((await toolRow(store)).body).toBe(body(2))
    await store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Ripgrep', body: body(3) })
    expect(await toolRow(store)).toMatchObject({ text: 'Ripgrep', body: body(3) })
  })

  it('lets another transcript write pass only after the buffered one has landed', async () => {
    const { store } = await seeded()
    await store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(9) })
    await store.appendTranscript({
      channel: CHANNEL,
      thread: THREAD,
      ts: '2',
      sender: AGENT,
      kind: 'text',
      text: 'done'
    })
    const rows = await store.threadTranscript(CHANNEL, THREAD)
    // Ordering is preserved: the tool row still precedes the reply it ran for.
    expect(rows.map((row) => row.kind)).toEqual(['tool', 'text'])
    expect((await toolRow(store)).body).toBe(body(9))
  })

  it('raises one mutation notice per flush, carrying the revision the flushed row landed on', async () => {
    const { store } = await seeded()
    const seen: { revision: number; agentIds: string[] }[] = []
    store.setTranscriptMutationListener((mutation) => {
      seen.push(mutation)
    })
    for (let chunk = 1; chunk <= 5; chunk++) {
      await store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(chunk) })
    }
    expect(seen).toEqual([])
    // The notice is dispatched post-commit, never inline: exactly one per flush.
    await store.flushToolCallWrites()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]!.agentIds).toEqual([AGENT])
    expect(seen[0]!.revision).toBe(await store.currentTranscriptRevision())
  })

  it('never lets a listener observe a half-applied write: the notice fires after the row has landed', async () => {
    const { store } = await seeded()
    const observed: { rows: number; body: string | null }[] = []
    let notices = 0
    store.setTranscriptMutationListener(async () => {
      notices++
      const rows = await store.threadTranscript(CHANNEL, THREAD)
      observed.push({ rows: rows.length, body: (await toolRow(store)).body ?? null })
    })
    await store.appendTranscript({ channel: CHANNEL, thread: THREAD, ts: '9', sender: AGENT, kind: 'text', text: 'hi' })
    await store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(11) })
    await store.flushToolCallWrites()
    // Both notices ran after their write committed: the reads see the appended row and the
    // flushed body, never an intermediate state.
    await vi.waitFor(() => expect(observed).toHaveLength(2))
    expect(notices).toBe(2)
    expect(observed[0]!.rows).toBe(2)
    expect(observed[1]!.body).toBe(body(11))
  })

  it('lands a buffered body on close, so a drain cannot lose it', async () => {
    const backing = SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:'))
    // A store closing over a borrowed database: `close` must flush without ending the backend.
    const borrowed: StoreDatabase = {
      exec: (sql) => backing.exec(sql),
      query: (sql, params) => backing.query(sql, params),
      batch: (statements) => backing.batch(statements),
      transaction: (fn) => backing.transaction(fn),
      close: async () => undefined
    }
    const first = await LocalStore.open({ database: borrowed })
    await first.insertToolCall({
      channel: CHANNEL,
      thread: THREAD,
      ts: '1',
      sender: AGENT,
      toolCallId: 'tc-1',
      title: 'Bash',
      body: body(0)
    })
    await first.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(7) })
    await first.close()
    expect((await toolRow(await LocalStore.open({ database: borrowed }))).body).toBe(body(7))
  })

  it('writes a buffered body on its own timer when nothing else touches the store', async () => {
    vi.useFakeTimers()
    try {
      const { store, roundTrips } = await seeded()
      await store.updateToolCall(CHANNEL, THREAD, AGENT, 'tc-1', { title: 'Bash', body: body(4) })
      expect(roundTrips()).toBe(0)
      await vi.advanceTimersByTimeAsync(1_000)
      // The round trip proves the timer wrote; a read here would have drained it either way.
      expect(roundTrips()).toBe(1)
      expect((await toolRow(store)).body).toBe(body(4))
    } finally {
      vi.useRealTimers()
    }
  })

  it('never re-issues a revision after a flush that spanned several threads', async () => {
    const { store } = await countingStore()
    const rows: { thread: string; id: string }[] = [
      { thread: 'T1', id: 'tc-a' },
      { thread: 'T2', id: 'tc-b' },
      { thread: 'T1', id: 'tc-c' }
    ]
    for (const { thread, id } of rows) {
      await store.insertToolCall({
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
      await store.updateToolCall(CHANNEL, thread, AGENT, id, { title: 'Bash', body: body(1) })
    }
    await store.flushToolCallWrites()
    const issued: number[] = []
    for (const thread of ['T1', 'T2'])
      issued.push(...(await store.threadTranscript(CHANNEL, thread)).map((row) => Number(row.revision)))
    await store.appendTranscript({
      channel: CHANNEL,
      thread: 'T2',
      ts: 'next',
      sender: AGENT,
      kind: 'text',
      text: 'done'
    })
    const after = (await store.threadTranscript(CHANNEL, 'T2')).map((row) => Number(row.revision))
    // The allocator spans every partition: the next row must outrank every revision already out.
    expect(Math.max(...after)).toBeGreaterThan(Math.max(...issued))
    expect(new Set(issued).size).toBe(issued.length)
  })

  it('refuses an unattributable agent at the call that enqueued it, not at the flush', async () => {
    const backing = SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:'))
    const shared = await LocalStore.open({
      database: backing,
      shared: true,
      ownerId: 'member-1',
      orgForAgent: (id) => (id === AGENT ? 'org-a' : undefined)
    })
    await expect(
      shared.updateToolCall(CHANNEL, THREAD, 'stranger', 'tc-1', { title: 'Bash', body: body(1) })
    ).rejects.toThrow(/cannot resolve the transcript organization/)
    await shared.close()
  })
})

describe('the batch statement seam', () => {
  it('returns one result per statement, in order, with reads and writes told apart', async () => {
    const backing = SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:'))
    const store = await LocalStore.open({ database: backing })
    await store.appendTranscript({ channel: CHANNEL, thread: THREAD, ts: '1', sender: 'U1', kind: 'text', text: 'one' })
    const results = await backing.batch([
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
    await store.close()
  })
})
