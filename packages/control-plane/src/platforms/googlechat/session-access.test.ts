// Which key a Google Chat row's member checks use (google-chat-integration.md §10.10): never a deployment row's stored value.
import { describe, expect, it } from 'vitest'
import type { BotRecord } from '../../persistence/ports.js'
import { BotAccessError } from '../bot-session-access.js'
import {
  GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER,
  GOOGLE_CHAT_DEPLOYMENT_OWNER,
  GOOGLE_CHAT_ROW_OWNER_KEY
} from './deployment-app.js'
import { googleChatMembershipKey } from './session-access.js'

const PROJECT_NUMBER = '100000000000'
const APP = { projectNumber: PROJECT_NUMBER, serviceAccountKey: 'deployment-key-json' }
const OWN_KEY = 'own-key-json'

const row = (over: Partial<BotRecord> = {}) =>
  ({
    externalAppId: PROJECT_NUMBER,
    prebuilt: true,
    platformConfig: { projectId: 'example-project' },
    ...over
  }) as BotRecord

describe('googleChatMembershipKey', () => {
  it('uses the configured app’s key for its rows, whatever the slot holds', () => {
    expect(googleChatMembershipKey(row(), GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER, APP)).toBe(APP.serviceAccountKey)
    expect(googleChatMembershipKey(row(), 'a stale copy', APP)).toBe(APP.serviceAccountKey)
  })

  it('refuses a deployment row with no matching configured app, instead of reading its slot', () => {
    const owned = row({
      externalAppId: '200000000000',
      prebuilt: false,
      platformConfig: { [GOOGLE_CHAT_ROW_OWNER_KEY]: GOOGLE_CHAT_DEPLOYMENT_OWNER }
    })
    for (const [bot, stored] of [
      [row(), 'a stale copy'],
      [owned, 'a stale copy'],
      [row({ externalAppId: '200000000000', prebuilt: false }), GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER]
    ] as const) {
      expect(() => googleChatMembershipKey(bot, stored, undefined)).toThrow(BotAccessError)
    }
    expect(() => googleChatMembershipKey(owned, 'a stale copy', APP)).toThrow(BotAccessError)
  })

  it('uses an organization’s own app’s stored key', () => {
    const own = row({ externalAppId: '200000000000', prebuilt: false })
    expect(googleChatMembershipKey(own, OWN_KEY, APP)).toBe(OWN_KEY)
    expect(googleChatMembershipKey(own, OWN_KEY, undefined)).toBe(OWN_KEY)
  })
})
