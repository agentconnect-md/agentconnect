import { describe, expect, it } from 'vitest'
import { sessionFromDto, type SessionDto } from './api'
import { sessionPlatform } from './data'
import {
  githubRepoIdFromSessionTriggerFilter,
  sessionSenderLabel,
  sessionTriggerFilterValue,
  sessionTriggerKind
} from './session-trigger'

const sessionDto = (overrides: Partial<SessionDto>): SessionDto => ({
  sessionId: 'session-id',
  sessionKey: { platform: 'slack', channel: 'C123' },
  agentId: 'target-agent',
  title: null,
  status: null,
  lastActivityAt: null,
  usage: null,
  triggeredBy: null,
  channelName: null,
  triggeredByName: null,
  threadUrl: null,
  runtime: null,
  model: null,
  effort: null,
  fastMode: null,
  permissionMode: null,
  outputMode: null,
  daemonId: null,
  ...overrides
})

describe('sessionTriggerFilterValue', () => {
  it('groups distinct GitHub hooks for one repository under its stable repo id', () => {
    const first = sessionTriggerFilterValue({ value: 'hook:first', hookKind: 'github', githubRepoId: '123' })
    const second = sessionTriggerFilterValue({ value: 'hook:second', hookKind: 'github', githubRepoId: '123' })

    expect(first).toBe(second)
    expect(githubRepoIdFromSessionTriggerFilter(first)).toBe('123')
    expect(sessionTriggerFilterValue({ value: 'hook:webhook', hookKind: 'webhook' })).toBe('hook:webhook')
  })
})

describe('sessionTriggerKind', () => {
  const agents = new Set(['agent-id'])

  it('recognizes a visible agent trigger', () => {
    expect(sessionTriggerKind({ triggeredBy: 'agent-id' }, agents)).toBe('agent')
  })

  it('uses stable hook kind after session hydration, independent of delivery platform or display name', () => {
    const anchoredGithub = sessionFromDto(
      sessionDto({
        sessionKey: { platform: 'slack', channel: 'C123' },
        triggeredBy: 'hook:github-id',
        hookKind: 'github',
        channelName: 'release-events',
        triggeredByName: 'owner/repo'
      })
    )
    const slashNamedWebhook = sessionFromDto(
      sessionDto({
        sessionKey: { platform: 'hook', channel: 'webhook-id' },
        triggeredBy: 'hook:webhook-id',
        hookKind: 'webhook',
        channelName: 'acme/build',
        triggeredByName: 'acme/build'
      })
    )

    expect(anchoredGithub).toMatchObject({ platform: 'slack', channel: '#release-events', hookKind: 'github' })
    expect(sessionTriggerKind(anchoredGithub, agents)).toBe('github')
    expect(slashNamedWebhook).toMatchObject({ platform: 'hook', channel: 'acme/build', hookKind: 'webhook' })
    expect(sessionTriggerKind(slashNamedWebhook, agents)).toBe('webhook')
    expect(sessionPlatform(anchoredGithub)).toBe('slack')
    expect(sessionPlatform(slashNamedWebhook)).toBe('hook')
    expect(sessionPlatform({ platform: 'hook', hookKind: 'github' })).toBe('github')
    expect(sessionPlatform({ platform: 'playground' })).toBe('webchat')
  })

  it('labels dream execution sessions without exposing their synthetic routing key', () => {
    const dream = sessionFromDto(
      sessionDto({
        sessionId: 'dream-session-1',
        sessionKey: { platform: 'dream', channel: 'memory' },
        title: 'Memory dream',
        triggeredBy: 'schedule',
        runtime: 'codex',
        model: 'gpt-5.6',
        usage: { totalTokens: 120, costAmount: 0.012, costCurrency: 'USD' }
      })
    )

    expect(dream).toMatchObject({
      platform: 'dream',
      channel: 'Memory',
      user: 'Scheduled',
      runtime: 'codex',
      model: 'gpt-5.6',
      tokens: '120',
      cost: '$0.01'
    })
  })
})

describe('sessionSenderLabel', () => {
  it('prefers visible agent and member names over raw sender fallbacks', () => {
    const agents = new Map([['agent-id', 'Release agent']])
    const members = new Map([['member-id', 'Ada']])
    const me = { userId: 'me', email: 'me@example.test' }

    expect(sessionSenderLabel('agent-id', 'agent-id', agents, members, me)).toBe('Release agent')
    expect(sessionSenderLabel('member-id', 'member-id', agents, members, me)).toBe('Ada')
    expect(sessionSenderLabel('me', 'me', agents, members, me)).toBe('You')
  })
})
