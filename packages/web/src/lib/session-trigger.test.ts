import { describe, expect, it } from 'vitest'
import { CODE_HOST_PROVIDERS, GENERIC_HOOK_KIND, HOOK_KINDS, isCodeHostHookKind } from '@agentconnect.md/protocol'
import {
  mergeSessionDetailUsage,
  sessionFromDetailDto,
  sessionFromDto,
  type SessionDetailDto,
  type SessionDto
} from './api'
import { isSelfSender, platName, sessionPlatform } from './data'
import {
  githubRepoIdFromSessionTriggerFilter,
  sessionAttributionAgentAuthors,
  sessionAttributionAgentId,
  sessionSenderLabel,
  sessionTranscriptAgentIds,
  sessionTriggerFilterValue,
  sessionTriggerKind,
  hookKindFromIntegration,
  hookSourceLabel,
  primaryHookKind,
  HOOK_KIND_GROUP_LABEL,
  HOOK_KIND_LABEL,
  HOOK_TRIGGER_KINDS
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

  it('renders an unknown platform id as itself, not as Slack (S1a: the narrowPlatform mirror)', () => {
    expect(platName('slack')).toBe('Slack')
    expect(platName('')).toBe('Slack')
    expect(platName('teams-x')).toBe('Teams-x')
  })

  // The chat arms are now an exact-id lookup into the shared label table while the
  // core kinds stay an ORDERED substring chain — 'webhook' must not read as
  // "Playground" via the `web` arm, and 'webchat' must.
  it('names the chat platforms and the core kinds, in that order', () => {
    expect(platName('telegram')).toBe('Telegram')
    expect(platName('discord')).toBe('Discord')
    expect(platName('lark')).toBe('Lark')
    expect(platName('github')).toBe('GitHub')
    expect(platName('schedule')).toBe('Schedule')
    expect(platName('dream')).toBe('Memory dream')
    expect(platName('webhook')).toBe('Webhook')
    expect(platName('hook')).toBe('Webhook')
    expect(platName('webchat')).toBe('Playground')
    expect(platName('playground')).toBe('Playground')
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

  it('hydrates hook source identity and usage from a direct session-detail response', () => {
    const detail: SessionDetailDto = {
      id: 'github-session-1',
      parentSession: null,
      siblingSessions: [],
      childSessions: [],
      agentId: 'target-agent',
      platform: 'hook',
      channel: 'github-hook-1',
      thread: 'delivery-1',
      title: 'Review pull request',
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
      triggeredBy: 'hook:github-hook-1',
      hookKind: 'github',
      channelName: 'owner/repo',
      triggeredByName: 'owner/repo',
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
      platform: 'hook',
      hookKind: 'github',
      channel: 'owner/repo',
      tokens: '12K',
      cost: '$0.12',
      usage: { inputTokens: 10_000, outputTokens: 2_400 }
    })
    expect(sessionPlatform(hydrated)).toBe('github')

    const staleListRow = sessionFromDto(
      sessionDto({
        sessionId: detail.id,
        sessionKey: { platform: 'hook', channel: 'github-hook-1' },
        hookKind: 'github',
        channelName: 'owner/repo',
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
        sessionKey: { platform: 'hook', channel: 'github-hook-1' },
        hookKind: 'github',
        channelName: 'owner/repo',
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

  it('labels the viewer "You" on a legacy webchat row keyed by their display name', () => {
    const agents = new Map([['agent-id', 'Release agent']])
    const members = new Map([['member-id', 'Ada']])
    const me = { userId: 'me', email: 'me@example.test', name: 'Phil Z' }

    // The row a pre-fix daemon wrote records the handle, not the principal.
    expect(sessionSenderLabel('Phil Z', 'Phil Z', agents, members, me)).toBe('You')
    // Another member's row still resolves through the directory, never to "You".
    expect(sessionSenderLabel('member-id', 'member-id', agents, members, me)).toBe('Ada')
  })
})

describe('isSelfSender', () => {
  it('recognizes the live Playground viewer marker before /me is available', () => {
    expect(isSelfSender('@you', null)).toBe(true)
  })

  it('matches the CP principal a webchat row records, and the email an older row used', () => {
    const me = { userId: 'user-1', email: 'ada@example.test', name: 'Ada Lovelace' }

    expect(isSelfSender('user-1', me)).toBe(true)
    expect(isSelfSender('ada@example.test', me)).toBe(true)
    expect(isSelfSender('U0SLACK', me)).toBe(false)
    expect(isSelfSender('other-user', me)).toBe(false)
  })

  it('falls back to the display name, for rows written before the principal was carried', () => {
    const me = { userId: 'user-1', email: 'ada@example.test', name: 'Ada Lovelace' }

    expect(isSelfSender('Ada Lovelace', me)).toBe(true)
    // A viewer with no display name must not match on a null/absent name.
    expect(isSelfSender('Ada Lovelace', { userId: 'user-1', email: 'ada@example.test', name: null })).toBe(false)
    expect(isSelfSender('Ada Lovelace', { userId: 'user-1', email: 'ada@example.test' })).toBe(false)
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

  it('finds visible transcript authors from direct ids and trusted Slack attribution', () => {
    const agents = new Set(['direct-id', 'review-id'])
    const reviewFooter =
      'done\nsent by <https://test.example.test/team/agents/review-id|review-bot> (Codex) · <https://test.example.test/sessions/1|open in session>'

    expect([
      ...sessionTranscriptAgentIds(
        'slack',
        [
          { sender: 'direct-id', text: 'Direct A2A reply' },
          { sender: 'B0REVIEW', text: reviewFooter, trustedAgentBot: true },
          { sender: 'hidden-id', text: 'Not in the visible Agent directory' }
        ],
        agents
      )
    ]).toEqual(['direct-id', 'review-id'])
  })
})

describe('retention-GC purge mark (#485)', () => {
  it('carries contentPurgedAt from the list row and the detail response', () => {
    const purged = sessionFromDto(sessionDto({ contentPurgedAt: '2026-08-04T09:00:00.000Z' }))
    expect(purged.contentPurgedAt).toBe('2026-08-04T09:00:00.000Z')

    // A live row must not look purged: the views read presence, not a value.
    expect(sessionFromDto(sessionDto({})).contentPurgedAt).toBeUndefined()
    expect(sessionFromDto(sessionDto({ contentPurgedAt: null })).contentPurgedAt).toBeUndefined()
  })

  it('overlays the detail mark onto a stale local row (30s detail vs 60s list refresh)', () => {
    // The list row predates the purge. mergeSessionDetailUsage is the path the
    // detail view takes whenever the list/rail already supplied the session, so
    // dropping the mark here would keep showing the unexplained empty state.
    const stale = sessionFromDto(sessionDto({ sessionId: 's1' }))
    expect(stale.contentPurgedAt).toBeUndefined()
    const purgedDetail = sessionFromDto(sessionDto({ sessionId: 's1', contentPurgedAt: '2026-08-04T09:00:00.000Z' }))

    // No usage on either side — the early-return path, which is the common one.
    expect(mergeSessionDetailUsage(stale, purgedDetail).contentPurgedAt).toBe('2026-08-04T09:00:00.000Z')

    // ...and on the path that does merge usage.
    const withUsage = sessionFromDto(
      sessionDto({
        sessionId: 's1',
        contentPurgedAt: '2026-08-04T09:00:00.000Z',
        usage: { reportedAt: '2026-08-04T10:00:00.000Z', totalTokens: 10, costAmount: 0.01, costCurrency: 'USD' }
      })
    )
    expect(mergeSessionDetailUsage(stale, withUsage)).toMatchObject({
      contentPurgedAt: '2026-08-04T09:00:00.000Z',
      usage: { totalTokens: 10 }
    })

    // A detail response with no mark never clears one the local row already has.
    const purgedLocal = sessionFromDto(sessionDto({ sessionId: 's1', contentPurgedAt: '2026-08-04T09:00:00.000Z' }))
    expect(mergeSessionDetailUsage(purgedLocal, stale).contentPurgedAt).toBe('2026-08-04T09:00:00.000Z')
  })

  it('carries contentPurgedAt through the detail hydration path too', () => {
    const detail = {
      id: 'purged-session',
      parentSession: null,
      siblingSessions: [],
      childSessions: [],
      agentId: 'target-agent',
      platform: 'slack',
      channel: 'C123',
      thread: null,
      title: 'expired review',
      status: 'completed',
      lastActivityAt: '2026-07-01T00:00:00.000Z',
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
      contentPurgedAt: '2026-08-04T09:00:00.000Z',
      contentPurgedReason: 'retention'
    } satisfies SessionDetailDto

    expect(sessionFromDetailDto(detail).contentPurgedAt).toBe('2026-08-04T09:00:00.000Z')
  })
})

/**
 * The session source taxonomy, walked over the WHOLE hook-kind vocabulary rather than
 * the hosts that exist today. GitLab regressed because the console kept its own copy of
 * the union and a code host could be left out of it: the row then folded into the
 * generic webhook rendering and dropped out of the trigger filter entirely. Every
 * assertion here is derived, so a new code host has to earn its own mapping.
 */
describe('hook-kind taxonomy', () => {
  const agents = { has: () => false }

  it('makes every hook kind its own trigger kind', () => {
    for (const kind of HOOK_KINDS) {
      expect(sessionTriggerKind({ triggeredBy: 'hook:h1', hookKind: kind }, agents)).toBe(kind)
    }
    // The generic kind is the mapping for an UNRESOLVED hook, not a catch-all for
    // kinds nobody mapped — that distinction is the whole fix.
    expect(sessionTriggerKind({ triggeredBy: 'hook:h1' }, agents)).toBe(GENERIC_HOOK_KIND)
  })

  it('gives every code-host kind a distinct, non-generic label, group and platform', () => {
    for (const provider of CODE_HOST_PROVIDERS) {
      expect(isCodeHostHookKind(provider)).toBe(true)
      expect(HOOK_KIND_LABEL[provider]).not.toBe(HOOK_KIND_LABEL[GENERIC_HOOK_KIND])
      expect(HOOK_KIND_GROUP_LABEL[provider]).not.toBe(HOOK_KIND_GROUP_LABEL[GENERIC_HOOK_KIND])
      expect(sessionPlatform({ platform: 'hook', hookKind: provider })).toBe(provider)
    }
    // Only the generic kind keeps the raw routing platform.
    expect(sessionPlatform({ platform: 'hook', hookKind: GENERIC_HOOK_KIND })).toBe('hook')
    expect(new Set(HOOK_KINDS.map((kind) => HOOK_KIND_LABEL[kind])).size).toBe(HOOK_KINDS.length)
    expect(new Set(HOOK_KINDS.map((kind) => HOOK_KIND_GROUP_LABEL[kind])).size).toBe(HOOK_KINDS.length)
  })

  it('keeps the hook-kind labels in step with the platform label chain', () => {
    for (const kind of HOOK_KINDS) expect(HOOK_KIND_LABEL[kind]).toBe(platName(kind))
  })

  it('names an unnamed hook by its source', () => {
    expect(hookSourceLabel('gitlab')).toBe('GitLab')
    expect(hookSourceLabel('github')).toBe('GitHub')
    // A hook the CP could not resolve carries no kind, so generic is all it can say.
    expect(hookSourceLabel(null)).toBe('Webhook')
  })

  it('orders the trigger groups code hosts first and covers the vocabulary exactly', () => {
    expect([...HOOK_TRIGGER_KINDS]).toEqual([...CODE_HOST_PROVIDERS, GENERIC_HOOK_KIND])
    expect([...HOOK_TRIGGER_KINDS].sort()).toEqual([...HOOK_KINDS].sort())
  })

  it('reads a hook kind back off the integration facet the server promoted', () => {
    for (const provider of CODE_HOST_PROVIDERS) expect(hookKindFromIntegration(provider)).toBe(provider)
    expect(hookKindFromIntegration('hook')).toBe(GENERIC_HOOK_KIND)
    expect(hookKindFromIntegration('slack')).toBeUndefined()
  })

  it('represents a mixed trigger set by its code host, never by the generic mark', () => {
    for (const provider of CODE_HOST_PROVIDERS) {
      expect(primaryHookKind([GENERIC_HOOK_KIND, provider])).toBe(provider)
    }
    expect(primaryHookKind([GENERIC_HOOK_KIND])).toBe(GENERIC_HOOK_KIND)
    expect(primaryHookKind([])).toBeUndefined()
  })

  it('carries the kind onto the session row so a GitLab delivery never reads as a webhook', () => {
    const row = sessionFromDto(
      sessionDto({
        sessionKey: { platform: 'hook', channel: 'gitlab-hook-1' },
        triggeredBy: 'hook:gitlab-hook-1',
        hookKind: 'gitlab'
      })
    )

    expect(row.hookKind).toBe('gitlab')
    expect(sessionPlatform(row)).toBe('gitlab')
    // Negative control: both cells named the generic endpoint before the fix.
    expect(row.channel).toBe('GitLab')
    expect(row.user).toBe('GitLab')
  })
})
