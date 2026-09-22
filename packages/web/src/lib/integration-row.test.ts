import { describe, expect, it } from 'vitest'
import { integrationRowFromDto } from './data-context'
import type { IntegrationDto } from './api'

/**
 * The DTO → row projection. A per-conversation field that this map forgets does not fail
 * loudly: the row reads as its default, so the console shows a state the server does not
 * have and silently reverts a choice on the next refetch. That is exactly what happened to
 * `sessionMode`, and it survived tests that built the row object directly.
 */
const dto = (over: Partial<IntegrationDto['channels'][number]> = {}): IntegrationDto =>
  ({
    id: 'int-1',
    agentId: 'agent-1',
    botId: 'bot-1',
    platform: 'slack',
    name: 'test',
    status: 'active',
    channels: [
      {
        channelId: 'C1',
        name: 'deploys',
        spaceId: null,
        space: null,
        icon: null,
        color: null,
        key: null,
        url: null,
        isPrivate: false,
        kind: 'channel',
        trigger: 'mention',
        sessionMode: 'createNew',
        agentId: null,
        ...over
      }
    ]
  }) as unknown as IntegrationDto

describe('integrationRowFromDto', () => {
  it('carries the conversation session mode through to the row', () => {
    const row = integrationRowFromDto(dto({ sessionMode: 'append' }), new Map(), new Map())
    expect(row.channels[0]?.sessionMode).toBe('append')
  })

  it('carries the default just as literally, rather than leaving it undefined', () => {
    const row = integrationRowFromDto(dto(), new Map(), new Map())
    expect(row.channels[0]?.sessionMode).toBe('createNew')
  })

  it('still carries the trigger and the owner beside it', () => {
    const row = integrationRowFromDto(dto({ trigger: 'any', agentId: 'agent-2' }), new Map(), new Map())
    expect(row.channels[0]).toMatchObject({ trigger: 'any', agentId: 'agent-2' })
  })
})
