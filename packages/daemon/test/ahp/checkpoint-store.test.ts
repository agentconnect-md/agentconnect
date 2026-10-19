import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore } from '../../src/store/local-store.js'
import { openTestStore } from '../store-support.js'

const stores: LocalStore[] = []
const paths: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})
async function open() {
  const dir = mkdtempSync(join(tmpdir(), 'ahp-store-'))
  paths.push(dir)
  const store = await openTestStore({ path: join(dir, 'local.sqlite') })
  stores.push(store)
  return store
}
const scope = { orgId: 'org', agentId: 'agent', sessionId: 'session' }

describe('durable AHP storage', () => {
  it('reads a canonical pre-runtime slot without minting or accepting another agent', async () => {
    const store = await open()
    expect(await store.outwardSessionIdFor('slot', 'agent')).toBeUndefined()
    const minted = await store.ensureOutwardSessionId('slot', 'agent', 1)
    expect(await store.outwardSessionIdFor('slot', 'agent')).toBe(minted)
    expect(await store.outwardSessionIdFor('slot', 'other-agent')).toBeUndefined()
    await store.upsertSession({
      key: 'slot',
      agentId: 'agent',
      platform: 'webchat',
      channel: 'conversation',
      thread: 'thread',
      state: 'idle',
      acpSessionId: 'runtime',
      lastDeliveredTs: null,
      updatedAt: 2
    })
    expect(await store.outwardSessionIdFor('slot', 'agent')).toBe(minted)
  })

  it('atomically reserves nonoverlapping sequence blocks and isolates agents', async () => {
    const store = await open()
    const ranges = await Promise.all(Array.from({ length: 8 }, () => store.reserveAhpSequenceBlock('org', 'agent', 4)))
    expect(new Set(ranges.flatMap((range) => [range.start, range.end])).size).toBe(16)
    expect(Math.max(...ranges.map((range) => range.end))).toBe(32)
    expect(await store.reserveAhpSequenceBlock('other-org', 'agent', 4)).toEqual({ start: 1, end: 4 })
  })

  it('preserves sequence high water and checkpoints across reopen', async () => {
    const store = await open()
    await store.reserveAhpSequenceBlock('org', 'agent', 16)
    await store.saveAhpCheckpoint({ ...scope, epoch: 1, revision: 1, value: 'saved', now: 1 })
    await stores.pop()!.close()
    const reopened = await openTestStore({ path: join(paths.at(-1)!, 'local.sqlite') })
    stores.push(reopened)
    expect(await reopened.reserveAhpSequenceBlock('org', 'agent', 16)).toEqual({ start: 17, end: 32 })
    expect(await reopened.loadAhpCheckpoint('org', 'agent', 'session')).toBe('saved')
  })

  it('fences old checkpoints and archives final turns in the same transaction', async () => {
    const store = await open()
    await store.saveAhpCheckpoint({
      ...scope,
      epoch: 5,
      revision: 1,
      value: 'first',
      now: 1,
      turns: [{ turnId: 'one', value: '1' }]
    })
    await store.saveAhpCheckpoint({
      ...scope,
      epoch: 6,
      revision: 1,
      value: 'new',
      now: 2,
      turns: [{ turnId: 'two', value: '2' }]
    })
    await expect(
      store.saveAhpCheckpoint({
        ...scope,
        epoch: 5,
        revision: 999,
        value: 'stale',
        now: 3,
        turns: [{ turnId: 'stale', value: '3' }]
      })
    ).rejects.toThrow('Stale')
    expect(await store.loadAhpCheckpoint('org', 'agent', 'session')).toBe('new')
    expect(await store.ahpTurnPage('org', 'agent', 'session', 'two')).toEqual({ values: ['1'] })
    await expect(store.ahpTurnPage('org', 'agent', 'session', 'stale')).rejects.toThrow('Unknown')
    expect(await store.loadAhpCheckpoint('other-org', 'agent', 'session')).toBeUndefined()
  })

  it('keeps immutable chronological history and bounds every page', async () => {
    const store = await open()
    const turns = Array.from({ length: 80 }, (_, index) => ({
      turnId: String(index),
      value: JSON.stringify({ id: index, text: 'x'.repeat(1024) })
    }))
    await store.saveAhpCheckpoint({ ...scope, epoch: 1, revision: 1, value: 'checkpoint', now: 1, turns })
    await store.saveAhpCheckpoint({ ...scope, epoch: 1, revision: 2, value: 'checkpoint', now: 2, turns: [turns[0]!] })
    const seen: number[] = []
    let cursor: string | undefined = '79'
    while (cursor) {
      const page = await store.ahpTurnPage('org', 'agent', 'session', cursor)
      expect(Buffer.byteLength(`[${page.values.join(',')}]`)).toBeLessThanOrEqual(32 * 1024)
      seen.unshift(...page.values.map((value) => JSON.parse(value).id as number))
      cursor = page.nextCursor
    }
    expect(seen).toEqual(Array.from({ length: 79 }, (_, index) => index))
    await expect(store.ahpTurnPage('org', 'agent', 'other-session', '79')).rejects.toThrow('Unknown')
  })
})
