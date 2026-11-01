import { describe, expect, it } from 'vitest'
import { SESSION_MODE_AUTO_V1_FEATURE } from '@agentconnect.md/protocol'
import { autoConversationKinds, openConversationSessionMode, openConversationTrigger } from './conversation-defaults.js'

describe('openConversationTrigger', () => {
  it('opens a room on Mention and a 1:1 DM On', () => {
    expect(openConversationTrigger({})).toBe('mention')
    expect(openConversationTrigger({ kind: 'mpim', externalReason: null })).toBe('mention')
    expect(openConversationTrigger({ kind: 'im' })).toBe('any')
  })

  it('starts any place the platform marks external Off', () => {
    expect(openConversationTrigger({ kind: 'channel', externalReason: 'externallyShared' })).toBe('off')
    expect(openConversationTrigger({ kind: 'im', externalReason: 'externalMember' })).toBe('off')
  })
})

// auto-session-mode.md §3.2: rooms and group DMs start on Auto where the bot's daemon reads it; DMs and Linear never do.
describe('autoConversationKinds and openConversationSessionMode', () => {
  it('starts a room and a Slack group DM on Auto for a daemon that reads it, never a DM', () => {
    const kinds = autoConversationKinds('slack', [SESSION_MODE_AUTO_V1_FEATURE])
    expect(kinds).toEqual(['channel', 'mpim'])
    expect(openConversationSessionMode({}, kinds)).toBe('auto')
    expect(openConversationSessionMode({ kind: 'mpim' }, kinds)).toBe('auto')
    expect(openConversationSessionMode({ kind: 'im' }, kinds)).toBe('createNew')
  })

  it('keeps every new row Per thread for a daemon that does not read Auto, or where rooms never append', () => {
    expect(autoConversationKinds('slack', [])).toEqual([])
    expect(autoConversationKinds('slack', undefined)).toEqual([])
    expect(autoConversationKinds('linear', [SESSION_MODE_AUTO_V1_FEATURE])).toEqual([])
    expect(autoConversationKinds('telegram', [SESSION_MODE_AUTO_V1_FEATURE])).toEqual(['channel'])
    expect(openConversationSessionMode({ kind: 'channel' }, undefined)).toBe('createNew')
  })
})
