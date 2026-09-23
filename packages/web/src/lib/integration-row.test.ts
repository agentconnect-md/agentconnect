import { describe, expect, it } from 'vitest'
import { integrationRowFromDto } from './data-context'
import type { BotDto, IntegrationDto } from './api'

/** A field the projection forgets reads as its default, so the console shows a state the server does not have. */
const dto = (over: Partial<IntegrationDto['channels'][number]> = {}, status = 'active'): IntegrationDto =>
  ({
    id: 'int-1',
    agentId: 'agent-1',
    botId: 'bot-1',
    platform: 'slack',
    name: 'test',
    status,
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

  it('carries a By decision binding and its readiness, and null stays null', () => {
    const decisionBinding = {
      type: 'gate' as const,
      decisionId: 'dec-1',
      when: { type: 'boolean' as const, values: [true] }
    }
    const decision = { id: 'dec-1', name: 'Needs a response', enabled: true, readiness: { status: 'ready' as const } }
    const row = integrationRowFromDto(dto({ trigger: 'decision', decisionBinding, decision }), new Map(), new Map())
    expect(row.channels[0]).toMatchObject({ trigger: 'decision', decisionBinding, decision })
    const plain = integrationRowFromDto(dto(), new Map(), new Map()).channels[0]!
    expect(plain.decisionBinding).toBeNull()
    expect(plain.decision).toBeNull()
  })

  it('marks a revoked integration as revoked, and only that status', () => {
    expect(integrationRowFromDto(dto({}, 'revoked'), new Map(), new Map()).revoked).toBe(true)
    expect(integrationRowFromDto(dto({}, 'active'), new Map(), new Map()).revoked).toBe(false)
  })

  it('takes the rejected mark from its bot, and the code that matches the row’s state', () => {
    const bot = {
      id: 'bot-1',
      revokedCode: 'token_revoked',
      credentialRejectedAt: '2026-09-01T00:00:00.000Z',
      credentialRejectedCode: 'invalid_auth'
    } as BotDto
    const bots = new Map([['bot-1', bot]])

    expect(integrationRowFromDto(dto(), new Map(), bots)).toMatchObject({
      revoked: false,
      rejected: true,
      credentialCode: 'invalid_auth'
    })
    expect(integrationRowFromDto(dto({}, 'revoked'), new Map(), bots)).toMatchObject({
      revoked: true,
      credentialCode: 'token_revoked'
    })
    const live = new Map([['bot-1', { id: 'bot-1', credentialRejectedAt: null } as BotDto]])
    expect(integrationRowFromDto(dto(), new Map(), live)).toMatchObject({ rejected: false, credentialCode: null })
  })
})
