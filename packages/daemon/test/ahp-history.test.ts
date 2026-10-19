import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AHP_MAX_MESSAGE_BYTES } from '@agentconnect.md/protocol'
import { readAhpHistory } from '../src/ahp/history.js'
import { LocalStore, sessionKey, transcriptChannelKey, type TranscriptEntry } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

const stores: LocalStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()))
})
const scope = { orgId: 'org-a', agentId: 'agent-a', sessionId: 'outward' }
const mask = (s: string) => s.replaceAll('secret', '[REDACTED]')
async function fixture(platform = 'webchat') {
  const store = await LocalStore.open({
    database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')),
    shared: true,
    ownerId: 'daemon',
    orgForAgent: (id) => (id === 'agent-a' || id === 'peer' ? 'org-a' : id === 'agent-b' ? 'org-b' : undefined)
  })
  stores.push(store)
  const key = sessionKey(platform, 'channel', 'thread', 'agent-a', 'account')
  await store.upsertSession({
    key,
    agentId: 'agent-a',
    platform,
    channel: 'channel',
    thread: 'thread',
    transportScope: 'account',
    sessionId: 'outward',
    acpSessionId: 'runtime-private',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 1
  })
  let seq = 0
  const append = (text: string, extra: Partial<TranscriptEntry> = {}) =>
    store.appendTranscript({
      channel: transcriptChannelKey('channel', 'account'),
      thread: 'thread',
      ts: String(++seq),
      sender: 'user',
      kind: 'text',
      text,
      recipient: 'agent-a',
      admission: { agentId: 'agent-a', sessionKey: key },
      ...extra
    })
  return { store, key, append }
}
const contents = (page: Awaited<ReturnType<typeof readAhpHistory>>) =>
  page.turns.map((t) => (t.responseParts[0] as { content: string }).content)

describe('authoritative AHP historical imports', () => {
  it('paginates every scoped row, in chronology, with stable post identifiers', async () => {
    const w = await fixture()
    for (let i = 0; i < 65; i++) await w.append(`row-${i}`, { postId: `post-${i}` })
    let cursor: string | undefined
    const all: string[] = []
    const counts: number[] = []
    do {
      const page = await readAhpHistory(w.store, { ...scope, cursor }, mask)
      counts.push(page.turns.length)
      all.unshift(...contents(page))
      expect(page.turns[0]!.id).toBe(`history:post:post-${65 - all.length}`)
      cursor = page.cursor
    } while (cursor)
    expect(counts).toEqual([30, 30, 5])
    expect(all).toEqual(Array.from({ length: 65 }, (_, i) => `row-${i}`))
  })

  it('retains agent delivery, account and session isolation and rejects internal runtime identities', async () => {
    const w = await fixture()
    await w.append('visible')
    await w.append('peer private', {
      sender: 'peer',
      recipient: 'peer',
      kind: 'reasoning',
      admission: { agentId: 'peer', sessionKey: 'peer-key' }
    })
    await w.append('other account', { channel: transcriptChannelKey('channel', 'another') })
    await w.append('other thread', { thread: 'another', admission: { agentId: 'agent-a', sessionKey: 'another' } })
    await w.append('other org', { recipient: 'agent-b', admission: { agentId: 'agent-b', sessionKey: w.key } })
    expect(contents(await readAhpHistory(w.store, scope, mask))).toEqual(['visible'])
    await expect(readAhpHistory(w.store, { ...scope, sessionId: 'runtime-private' }, mask)).rejects.toThrow(
      'Unknown session'
    )
    await expect(readAhpHistory(w.store, { ...scope, agentId: 'agent-b' }, mask)).rejects.toThrow('Unknown session')
  })

  it('uses native event ordering for late backfill with a stable boundary cursor', async () => {
    const w = await fixture('slack')
    await w.append('newer', { ts: '10.000001' })
    await w.append('latest', { ts: '12.000001' })
    await w.append('late old history', { ts: '8.000001' })
    const first = await readAhpHistory(w.store, { ...scope, limit: 2 }, mask)
    expect(contents(first)).toEqual(['newer', 'latest'])
    expect(contents(await readAhpHistory(w.store, { ...scope, limit: 2, cursor: first.cursor }, mask))).toEqual([
      'late old history'
    ])
  })

  it('does not accept malformed or cross-authority cursors', async () => {
    const w = await fixture()
    await w.append('one')
    await w.append('two')
    const first = await readAhpHistory(w.store, { ...scope, limit: 1 }, mask)
    await expect(readAhpHistory(w.store, { ...scope, orgId: 'org-b', cursor: first.cursor }, mask)).rejects.toThrow(
      'scope mismatch'
    )
    for (const cursor of ['1', 'history:====', 'history:abc', 'history:' + 'x'.repeat(3000)]) {
      await expect(readAhpHistory(w.store, { ...scope, cursor }, mask)).rejects.toThrow()
    }
  })

  it('bounds UTF-8 records and pages without skipping unreturned rows', async () => {
    const w = await fixture()
    for (let i = 0; i < 15; i++) await w.append(`row${i}:` + '界'.repeat(5000))
    let cursor: string | undefined
    const ids = new Set<string>()
    do {
      const page = await readAhpHistory(w.store, { ...scope, cursor, limit: 100 }, mask)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(AHP_MAX_MESSAGE_BYTES)
      for (const turn of page.turns) {
        const text = (turn.responseParts[0] as { content: string }).content
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
        expect(text).not.toContain('\ufffd')
        expect(ids.has(turn.id)).toBe(false)
        ids.add(turn.id)
      }
      cursor = page.cursor
    } while (cursor)
    expect(ids.size).toBe(15)
  })

  it('marks imported outcomes unknown, excludes model sidecars and keeps tools inert', async () => {
    const w = await fixture()
    await w.append('visible secret', {
      body: JSON.stringify({ prompt: 'hidden model prompt', quote: 'private quote' })
    })
    await w.store.insertToolCall({
      channel: transcriptChannelKey('channel', 'account'),
      thread: 'thread',
      ts: '2',
      sender: 'agent-a',
      admission: { agentId: 'agent-a', sessionKey: w.key },
      toolCallId: 'private-runtime-tool',
      title: 'Read',
      body: JSON.stringify({
        toolCallId: 'private-runtime-tool',
        status: 'in_progress',
        rawInput: 'secret input',
        rawOutput: 'secret output'
      })
    })
    const page = await readAhpHistory(w.store, scope, mask)
    const json = JSON.stringify(page)
    for (const hidden of ['hidden model prompt', 'private quote', 'private-runtime-tool', 'secret'])
      expect(json).not.toContain(hidden)
    expect(json).toContain('[REDACTED]')
    for (const turn of page.turns) {
      expect(turn.message.origin.kind).toBe('systemNotification')
      expect(turn.message._meta).toMatchObject({ 'agentconnect.md.history': { originalOutcome: 'unknown' } })
      expect(turn.responseParts.some((p) => p.kind === 'toolCall')).toBe(false)
      expect(turn.responseParts.at(-1)).toMatchObject({ content: expect.stringContaining('outcome are unavailable') })
    }
  })
})
