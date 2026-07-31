import { describe, expect, it } from 'vitest'
import {
  mergeSessionDetailUsage,
  sessionFromDetailDto,
  sessionFromDto,
  type SessionDetailDto,
  type SessionDto
} from './api'
import { platName, sessionPlatform } from './data'
import {
  githubRepoIdFromSessionTriggerFilter,
  sessionAttributionAgentAuthors,
  sessionAttributionAgentId,
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
    expect(platName(sessionPlatform({ platform: 'feishu' }))).toBe('Lark')
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

  it('hydrates token and cost usage from a direct session-detail response', () => {
    const detail: SessionDetailDto = {
      id: 'dream-session-1',
      parentSession: null,
      childSessions: [],
      agentId: 'target-agent',
      platform: 'dream',
      channel: 'memory',
      thread: 'drm-1',
      title: 'Memory dream',
      status: 'completed',
      lastActivityAt: '2026-07-27T00:00:00.000Z',
      usage: {
        reportedAt: '2026-07-27T00:02:00.000Z',
        totalTokens: 12_400,
        inputTokens: 10_000,
        outputTokens: 2_400,
        costAmount: 0.12,
        costCurrency: 'USD'
      },
      triggeredBy: 'manual',
      channelName: null,
      triggeredByName: null,
      threadUrl: null,
      runtime: 'codex',
      model: 'gpt-5.6',
      effort: null,
      fastMode: null,
      permissionMode: 'read-only',
      outputMode: null,
      daemonId: 'daemon-1'
    }

    const hydrated = sessionFromDetailDto(detail)
    expect(hydrated).toMatchObject({
      platform: 'dream',
      tokens: '12K',
      cost: '$0.12',
      usage: { inputTokens: 10_000, outputTokens: 2_400 }
    })

    const staleListRow = sessionFromDto(
      sessionDto({
        sessionId: detail.id,
        sessionKey: { platform: 'dream', channel: 'memory' },
        usage: {
          reportedAt: '2026-07-27T00:03:00.000Z',
          totalTokens: 20_000,
          costAmount: 0.2,
          costCurrency: 'USD'
        }
      })
    )
    expect(mergeSessionDetailUsage(staleListRow, hydrated)).toMatchObject({
      tokens: '20K',
      cost: '$0.20',
      usage: { totalTokens: 20_000 }
    })

    const freshDetail = {
      ...hydrated,
      tokens: '30K',
      cost: '$0.30',
      usage: {
        ...hydrated.usage!,
        reportedAt: '2026-07-27T00:04:00.000Z',
        totalTokens: 30_000,
        costAmount: 0.3
      }
    }
    expect(mergeSessionDetailUsage(staleListRow, freshDetail)).toMatchObject({
      tokens: '30K',
      cost: '$0.30',
      usage: { totalTokens: 30_000 }
    })

    const unmeteredListRow = sessionFromDto(
      sessionDto({
        sessionId: detail.id,
        sessionKey: { platform: 'dream', channel: 'memory' },
        usage: null
      })
    )
    expect(mergeSessionDetailUsage(unmeteredListRow, hydrated)).toMatchObject({
      tokens: '12K',
      cost: '$0.12',
      usage: { totalTokens: 12_400 }
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

describe('legacy Slack Agent attribution', () => {
  it('recovers only visible, unambiguous Agent authors', () => {
    const agents = new Set(['review-id', 'test-id'])
    const reviewFooter =
      'done\nsent by <https://test.example.test/team/agents/review-id|review-bot> (Codex) · <https://test.example.test/sessions/1|open in session>'

    expect(sessionAttributionAgentId('slack', { text: reviewFooter, trustedAgentBot: true }, agents)).toBe('review-id')
    expect(
      sessionAttributionAgentId(
        'slack',
        { text: 'sent by <https://other.test/agents/private-id|private>', trustedAgentBot: true },
        agents
      )
    ).toBeUndefined()
    expect(sessionAttributionAgentId('slack', { text: reviewFooter }, agents)).toBeUndefined()
    expect(sessionAttributionAgentId('webchat', { text: reviewFooter, trustedAgentBot: true }, agents)).toBeUndefined()

    const authors = sessionAttributionAgentAuthors(
      'slack',
      [
        { sender: 'B0REVIEW', text: reviewFooter, trustedAgentBot: true },
        { sender: 'B0REVIEW', text: 'an older row without a footer' },
        { sender: 'U0BOTUSER', text: reviewFooter, trustedAgentBot: true },
        { sender: 'B0SHARED', text: reviewFooter, trustedAgentBot: true },
        {
          sender: 'B0SHARED',
          text: 'sent by <https://test.example.test/team/agents/test-id|test> (Claude)',
          trustedAgentBot: true
        },
        { sender: 'B0UNTRUSTED', text: reviewFooter }
      ],
      agents
    )
    expect(authors.get('B0REVIEW')).toBe('review-id')
    expect(authors.get('U0BOTUSER')).toBe('review-id')
    expect(authors.has('B0SHARED')).toBe(false)
    expect(authors.has('B0UNTRUSTED')).toBe(false)
  })
})
