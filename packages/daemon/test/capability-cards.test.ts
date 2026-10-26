// The capability cards a daemon posted (capability-requests.md §4.4.6): one contract suite, on SQLite and on PostgreSQL.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CAPABILITY_CARD_RETENTION_MS } from '../src/store/capability-cards.js'
import type { LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

const view = {
  summary: 'add the MCP server "Linear"',
  reason: 'filing needs it',
  link: 'https://console.example.test/r/1',
  agentName: 'Ada'
}

function card(requestId: string, sessionKey: string, postedAt: number) {
  return {
    cardId: randomUUID(),
    requestId,
    generation: 1,
    agentId: `agent-${randomUUID()}`,
    sessionKey,
    integrationId: 'int-1',
    platform: 'slack',
    channel: 'C0GENERAL',
    thread: '1700000000.000100',
    ts: '1700000000.000200',
    view,
    postedAt
  }
}

describe('capability card ledger', () => {
  it('keeps a card whole and finds it by request and origin', async () => {
    store = await openTestStore()
    const requestId = randomUUID()
    const a = card(requestId, 'key-a', 1_000)
    const b = card(requestId, 'key-b', 2_000)
    await store.capabilityCards.record(a)
    await store.capabilityCards.record(b)
    expect(await store.capabilityCards.get(a.cardId)).toEqual({ ...a, settledAt: null })
    expect((await store.capabilityCards.forRequest(requestId)).map((row) => row.cardId)).toEqual([a.cardId, b.cardId])
    expect((await store.capabilityCards.forRequest(requestId, 'key-b')).map((row) => row.cardId)).toEqual([b.cardId])
  })

  it('finds the open cards a reply to one message may decline', async () => {
    store = await openTestStore()
    const open = card(randomUUID(), 'key-a', 1_000)
    const settled = card(randomUUID(), 'key-b', 2_000)
    await store.capabilityCards.record(open)
    await store.capabilityCards.record(settled)
    await store.capabilityCards.markSettled(settled.cardId, 3_000)
    expect((await store.capabilityCards.atMessage(open.channel, open.ts)).map((row) => row.cardId)).toEqual([
      open.cardId
    ])
    expect(await store.capabilityCards.atMessage(open.channel, 'another-message')).toEqual([])
  })

  it('marks a card settled once, and a reopen clears it with the new generation', async () => {
    store = await openTestStore()
    const a = card(randomUUID(), 'key-a', 1_000)
    await store.capabilityCards.record(a)
    await store.capabilityCards.markSettled(a.cardId, 5_000)
    await store.capabilityCards.markSettled(a.cardId, 9_000)
    expect((await store.capabilityCards.get(a.cardId))?.settledAt).toBe(5_000)
    await store.capabilityCards.setGeneration(a.cardId, 2)
    expect(await store.capabilityCards.get(a.cardId)).toMatchObject({ generation: 2, settledAt: null })
  })

  it('sweeps settled cards past the retention and leaves recent ones', async () => {
    store = await openTestStore()
    const now = 100 * CAPABILITY_CARD_RETENTION_MS
    const old = card(randomUUID(), 'key-a', now - 2 * CAPABILITY_CARD_RETENTION_MS + 10)
    const recent = card(randomUUID(), 'key-a', now - 10)
    await store.capabilityCards.record(old)
    await store.capabilityCards.record(recent)
    await store.capabilityCards.markSettled(old.cardId, now - CAPABILITY_CARD_RETENTION_MS - 1)
    await store.capabilityCards.markSettled(recent.cardId, now - 1)
    await store.capabilityCards.sweep(now)
    expect(await store.capabilityCards.get(old.cardId)).toBeUndefined()
    expect(await store.capabilityCards.get(recent.cardId)).toBeDefined()
  })
})
