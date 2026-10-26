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
