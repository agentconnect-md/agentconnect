// The WeChat bot state the daemon keeps across restarts (wechat-integration.md §3.3, §4.5).
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalStore } from '../src/store/local-store.js'
import { canonicalColumns } from '../src/store/postgres-dialect.js'
import { weChatStateStore } from '../src/platforms/wechat/state.js'
import { openTestStore } from './store-support.js'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

describe('WeChat bot state', () => {
  it('keeps each bot its own cursor and reply token, each written without touching the other', async () => {
    store = await openTestStore()
    const state = weChatStateStore(store)
    expect(await state.load('bot-a@im.bot')).toEqual({})
    await state.saveCursor('bot-a@im.bot', 'cursor-1')
    await state.saveContextToken('bot-a@im.bot', 'token-1')
    await state.saveCursor('bot-a@im.bot', 'cursor-2')
    await state.saveContextToken('bot-b@im.bot', 'token-b')
    expect(await state.load('bot-a@im.bot')).toEqual({ cursor: 'cursor-2', contextToken: 'token-1' })
    expect(await state.load('bot-b@im.bot')).toEqual({ contextToken: 'token-b' })
  })

  it('names only columns the PostgreSQL case restore knows', () => {
    for (const column of ['botId', 'pollCursor', 'contextToken', 'updatedAt'])
      expect(canonicalColumns).toContain(column)
  })
})

describe('WeChat message record', () => {
  it('keeps each bot its newest texts by message id, the first write winning', async () => {
    store = await openTestStore()
    for (const id of ['1', '2', '3']) await store.rememberWeChatMessage('bot-a@im.bot', id, `text ${id}`, 2)
    await store.rememberWeChatMessage('bot-a@im.bot', '3', 'rewritten', 2)
    await store.rememberWeChatMessage('bot-b@im.bot', '1', 'other bot', 2)
    expect(await store.getWeChatMessageText('bot-a@im.bot', '1')).toBeUndefined()
    expect(await store.getWeChatMessageText('bot-a@im.bot', '2')).toBe('text 2')
    expect(await store.getWeChatMessageText('bot-a@im.bot', '3')).toBe('text 3')
    expect(await store.getWeChatMessageText('bot-b@im.bot', '1')).toBe('other bot')
  })

  it('names only columns the PostgreSQL case restore knows', () => {
    for (const column of ['botId', 'messageId', 'createdAt']) expect(canonicalColumns).toContain(column)
  })
})
