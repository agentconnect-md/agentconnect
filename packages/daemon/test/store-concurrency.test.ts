/**
 * What the sync bridge used to give the store for free.
 *
 * Blocking the main thread made every multi-statement `LocalStore` method atomic against all
 * other daemon JavaScript; awaiting lets two turns interleave between a method's statements.
 * These cases drive that interleaving on purpose, one per treatment the design records: the
 * usage compare-and-set, the transcript mutex, and an explicit transaction site. The last case
 * covers the other half of that shift: a shutdown now has to await what it used to preempt.
 */
import { describe, expect, it } from 'vitest'
import { sessionKey, type LocalStore } from '../src/store/local-store.js'
import { openTestStore, tempStorePath } from './store-support.js'

const seedSession = async (s: LocalStore, key: string, agentId: string, acpSessionId: string | null) =>
  await s.upsertSession({
    key,
    agentId,
    platform: 'slack',
    channel: 'C1',
    thread: key,
    acpSessionId,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 1
  })

describe('LocalStore under interleaved turns', () => {
  it('keeps every concurrent token increment through the usage compare-and-set', async () => {
    const s = await openTestStore()
    const key = sessionKey('slack', 'C1', 'T-usage', 'bot-a')
    await seedSession(s, key, 'bot-a', 'acp-usage')

    // Four writers, not forty: each losing CAS costs one of the five merge attempts, and the
    // last attempt writes unconditionally — the floor this test must stay above.
    await Promise.all(
      [1, 2, 3, 4].map((n) => s.addTokenUsage(key, { totalTokens: n, inputTokens: 1, cachedReadTokens: 2 }))
    )

    expect(await s.getUsage(key)).toMatchObject({ totalTokens: 10, inputTokens: 4, cachedReadTokens: 8 })
    await s.close()
  })

  it('hands interleaved transcript writers distinct, monotonic revisions', async () => {
    const s = await openTestStore()
    const channel = 'C1'
    const thread = 'T-transcript'
    // Eight turns racing through the transcript path: appends, a tool insert, and the buffered
    // tool update, all in flight at once against one thread.
    const turn = async (n: number) => {
      await s.appendTranscript({ channel, thread, ts: `${n}.100`, sender: `U${n}`, kind: 'text', text: `ask ${n}` })
      await s.insertToolCall({
        channel,
        thread,
        ts: `${n}.200`,
        sender: 'bot-a',
        toolCallId: `tc-${n}`,
        title: 'Bash',
        body: '{"status":"pending"}'
      })
      await s.updateToolCall(channel, thread, 'bot-a', `tc-${n}`, {
        title: 'Bash',
        body: `{"status":"completed","turn":${n}}`
      })
      await s.appendTranscript({
        channel,
        thread,
        ts: `${n}.300`,
        sender: 'bot-a',
        recipient: `U${n}`,
        kind: 'text',
        text: `answer ${n}`
      })
    }
    await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(turn))
    await s.flushToolCallWrites()

    const rows = await s.threadTranscript(channel, thread)
    expect(rows).toHaveLength(24)
    const revisions = rows.map((row) => Number(row.revision))
    // No two rows share a revision, and the thread revision a reader polls is the highest one.
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(Math.max(...revisions)).toBe(await s.threadTranscriptRevision(channel, thread))
    // Every tool row carries its own turn's final body: no flush wrote another turn's overlay.
    for (const row of rows.filter((entry) => entry.kind === 'tool')) {
      expect(row.body).toBe(`{"status":"completed","turn":${row.tool_call_id?.slice('tc-'.length)}}`)
    }
    await s.close()
  })

  it('keeps a transaction site whole while other turns write around it', async () => {
    const s = await openTestStore()
    const keys = [1, 2, 3, 4, 5, 6].map((n) => sessionKey('slack', 'C1', `T-tx-${n}`, 'bot-a'))
    for (const [index, key] of keys.entries()) await seedSession(s, key, 'bot-a', `acp-tx-${index}`)

    const deletedOutwardIds = await Promise.all(keys.slice(3).map(async (key) => (await s.getSession(key))!.sessionId!))

    // Mutes and deletes, each a BEGIN…COMMIT block, all in flight against one store.
    await Promise.all([
      ...keys.slice(0, 3).map((key) => s.setSessionMuted(key, true)),
      ...keys.slice(3).map((key) => s.deleteSession(key, { reason: 'retention', at: 1_000 }))
    ])

    // The mute's two statements either both landed or neither did — never the tombstone alone.
    for (const key of keys.slice(0, 3)) {
      expect(await s.isSessionMuted(key)).toBe(true)
      expect((await s.getSession(key))?.muted).toBe(1)
    }
    // The delete's receipt is written in the same transaction as the row it reports.
    for (const key of keys.slice(3)) {
      expect(await s.getSession(key)).toBeUndefined()
      expect(await s.isSessionMuted(key)).toBe(false)
    }
    const purged = await s.listSessionPurges(10, 1_500, 'daemon-a', ['bot-a'])
    // Receipts name their sessions the outward way (session-concept.md §1.1), so compare against
    // the ids the store minted for the three deleted slots.
    expect(purged.map((row) => row.sessionId).sort()).toEqual(deletedOutwardIds.sort())
    await s.close()
  })

  it('drains a buffered tool body and an in-flight write when a store closes mid-activity', async () => {
    const rejections: unknown[] = []
    const capture = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', capture)
    // One path, opened twice: the second open is what proves the shutdown wrote rather than dropped.
    const path = tempStorePath()
    const s = await openTestStore(path)
    const channel = 'C1'
    const thread = 'T-shutdown'
    try {
      await s.appendTranscript({ channel, thread, ts: '1.100', sender: 'U1', kind: 'text', text: 'ask' })
      await s.insertToolCall({
        channel,
        thread,
        ts: '1.200',
        sender: 'bot-a',
        toolCallId: 'tc-stop',
        title: 'Bash',
        body: '{"status":"pending"}'
      })
      // Buffered, never flushed: only `close()` can still make this body durable.
      await s.updateToolCall(channel, thread, 'bot-a', 'tc-stop', {
        title: 'Bash',
        body: '{"status":"completed"}'
      })
      // The stop arrives while this append is still on the transcript mutex.
      const inFlight = s.appendTranscript({
        channel,
        thread,
        ts: '1.300',
        sender: 'bot-a',
        recipient: 'U1',
        kind: 'text',
        text: 'answer'
      })
      await Promise.all([inFlight, s.close()])

      const reopened = await openTestStore(path)
      const rows = await reopened.threadTranscript(channel, thread)
      expect(rows.map((row) => row.ts)).toEqual(['1.100', '1.200', '1.300'])
      expect(rows.find((row) => row.kind === 'tool')?.body).toBe('{"status":"completed"}')
      await reopened.close()
      // A drained shutdown leaves nothing to reject after the fact.
      await new Promise((resolve) => setImmediate(resolve))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', capture)
    }
  })
})
