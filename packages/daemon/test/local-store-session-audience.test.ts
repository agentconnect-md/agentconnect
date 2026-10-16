import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalStore, SCHEMA_VERSION } from '../src/store/local-store.js'

describe('Telegram/Discord audience upgrade', () => {
  it('preserves known conversations and inherited audiences without claiming synthetic or console sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-audience-'))
    const path = join(dir, 'store.sqlite')
    let store = await LocalStore.open(path)
    try {
      for (const [key, platform, channel, parent, direct] of [
        ['telegram', 'telegram', '-10042', null, false],
        ['discord', 'discord', '100000000000000004', null, false],
        ['child', 'telegram', 'a2a:parent', 'session-telegram', false],
        ['synthetic', 'discord', 'cron:example', null, false],
        ['console', 'telegram', '123', null, false],
        ['direct', 'telegram', '-10043', 'session-discord', true]
      ] as const) {
        await store.upsertSession({
          key,
          platform,
          channel,
          agentId: 'agent-1',
          thread: key === 'discord' ? '100000000000000005' : 'thread',
          transportScope: 'transport-1',
          sessionId: `session-${key}`,
          acpSessionId: `acp-${key}`,
          originSessionId: parent,
          state: 'idle',
          lastDeliveredTs: null,
          updatedAt: 1
        })
        await store.setSessionClassification(key, {
          conversationKind: 'channel',
          sourceBindingKind: 'local',
          tenantScope: platform === 'telegram' ? 'bot42' : 'mint:old',
          ...(key === 'console' ? { launchCorrelationId: 'launch-1' } : {}),
          ...(direct ? { directDestination: true } : {})
        })
      }
      await store.close()
      const old = new DatabaseSync(path)
      old.exec('PRAGMA user_version = 57')
      old.close()
      store = await LocalStore.open(path)
      expect(await store.getSession('telegram')).toMatchObject({
        acpSessionId: 'acp-telegram',
        externalProvider: 'telegram',
        externalRealmKey: 'bot42',
        externalResourceKey: '-10042',
        sourceBindingKind: 'external'
      })
      expect(await store.getSession('discord')).toMatchObject({
        acpSessionId: 'acp-discord',
        externalProvider: 'discord',
        externalRealmKey: null,
        externalResourceKey: '100000000000000005',
        sourceBindingKind: 'external'
      })
      expect(await store.getSession('child')).toMatchObject({
        externalProvider: 'telegram',
        externalRealmKey: 'bot42',
        externalResourceKey: '-10042'
      })
      expect(await store.getSession('direct')).toMatchObject({
        externalProvider: 'telegram',
        externalResourceKey: '-10043'
      })
      for (const key of ['synthetic', 'console'])
        expect(await store.getSession(key)).toMatchObject({ externalProvider: null, sourceBindingKind: 'local' })
      await store.setSessionClassification('discord', {
        externalRealmKey: 'bot100000000000000001',
        externalIntegrationId: 'integration-1'
      })
      expect(await store.getSession('discord')).toMatchObject({
        externalRealmKey: 'bot100000000000000001',
        acpSessionId: 'acp-discord'
      })
      const check = new DatabaseSync(path)
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
      check.close()
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
