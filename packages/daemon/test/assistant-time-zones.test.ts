// The time zone last seen from a person in each assistant-mode place (assistant-mode.md §5.4).
import { afterEach, describe, expect, it } from 'vitest'
import { ASSISTANT_TIME_ZONE_SCHEMA } from '../src/store/assistant-time-zones.js'
import type { LocalStore } from '../src/store/local-store.js'
import { canonicalColumns } from '../src/store/postgres-dialect.js'
import { openTestStore } from './store-support.js'

const DM = { platform: 'slack', channel: 'D0ALICE', transportScope: 'T0EXAMPLE' }

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

describe('the place’s last seen zone', () => {
  it('keeps the latest per agent and place, and is removed with the agent', async () => {
    store = await openTestStore()
    const zones = store.assistantTimeZones
    await zones.note('bot-a', DM, 'Asia/Shanghai', 1)
    await zones.note('bot-a', DM, 'Europe/Berlin', 2)
    await zones.note('bot-b', DM, 'America/Los_Angeles', 3)
    await zones.note('bot-a', { platform: 'webchat', channel: 'conv-1', transportScope: null }, 'Asia/Tokyo', 4)
    expect(await zones.get('bot-a', DM)).toBe('Europe/Berlin')
    expect(await zones.get('bot-a', { ...DM, transportScope: null })).toBeUndefined()
    expect(await zones.get('bot-a', { platform: 'webchat', channel: 'conv-1', transportScope: null })).toBe(
      'Asia/Tokyo'
    )
    expect(await zones.deleteForAgent('bot-a')).toBe(2)
    expect(await zones.get('bot-a', DM)).toBeUndefined()
    expect(await zones.get('bot-b', DM)).toBe('America/Los_Angeles')
  })

  it('lists every camelCase column in canonicalColumns', () => {
    const names = new Set([...ASSISTANT_TIME_ZONE_SCHEMA.matchAll(/\b[a-z]+[A-Z][A-Za-z]*\b/g)].map((m) => m[0]))
    const canonical = new Set<string>(canonicalColumns)
    expect([...names].filter((name) => !canonical.has(name))).toEqual([])
    expect([...names]).toEqual(expect.arrayContaining(['agentId', 'transportScope', 'timeZone', 'updatedAt']))
  })
})
