import { expect, it } from 'vitest'
import { sessionIntegrationId } from '../src/session/integration-scope.js'

// Scopes are `<platform>:<digest of platform + connection identity>` (daemon.ts transportScopeForIntegration).
const scopes: Record<string, string> = {
  'lead-slack': 'slack:111111111111111111111111',
  'slack-a': 'slack:aaaaaaaaaaaaaaaaaaaaaaaa',
  'slack-b': 'slack:bbbbbbbbbbbbbbbbbbbbbbbb',
  'slack-b-copy': 'slack:bbbbbbbbbbbbbbbbbbbbbbbb',
  tg: 'telegram:cccccccccccccccccccccccc'
}
const scopeOf = (integration: { id: string }): string => scopes[integration.id]!
const slackOnly = [{ id: 'lead-slack', platform: 'slack' }]
const twoWorkspaces = [
  { id: 'slack-a', platform: 'slack' },
  { id: 'slack-b', platform: 'slack' }
]
const mixed = [
  { id: 'tg', platform: 'telegram' },
  { id: 'slack-a', platform: 'slack' }
]

it('resolves a webchat a2a child minted on the fallback integration, so a nested worker can reply to it', () => {
  // A delegated parent row: webchat:a2a:<caller>:…:<lead>:slack:<lead's scope>.
  // 2.9.0 filtered by platform `webchat`, found nothing, and replyToSession returned not_found.
  expect(sessionIntegrationId(slackOnly, 'webchat', 'slack:111111111111111111111111', scopeOf)).toBe('lead-slack')
})

it('resolves exactly the integration the scope names among several, never the first by default', () => {
  expect(sessionIntegrationId(twoWorkspaces, 'webchat', 'slack:bbbbbbbbbbbbbbbbbbbbbbbb', scopeOf)).toBe('slack-b')
  expect(sessionIntegrationId(mixed, 'webchat', 'slack:aaaaaaaaaaaaaaaaaaaaaaaa', scopeOf)).toBe('slack-a')
  expect(sessionIntegrationId(mixed, 'webchat', 'telegram:cccccccccccccccccccccccc', scopeOf)).toBe('tg')
})

it('prefers a same-platform owner when two integrations share one connection scope', () => {
  const shared = [
    { id: 'slack-b-copy', platform: 'slack' },
    { id: 'slack-b', platform: 'slack' }
  ]
  expect(sessionIntegrationId(shared, 'slack', 'slack:bbbbbbbbbbbbbbbbbbbbbbbb', scopeOf)).toBe('slack-b-copy')
  expect(sessionIntegrationId(shared, 'webchat', 'slack:bbbbbbbbbbbbbbbbbbbbbbbb', scopeOf)).toBe('slack-b-copy')
})

it('keeps a scope no integration of this agent owns fail-closed', () => {
  // Another agent's or a removed connection's scope: only the session's own agent's integrations are searched.
  expect(sessionIntegrationId(slackOnly, 'webchat', 'slack:aaaaaaaaaaaaaaaaaaaaaaaa', scopeOf)).toBeUndefined()
  expect(sessionIntegrationId(slackOnly, 'slack', 'slack:aaaaaaaaaaaaaaaaaaaaaaaa', scopeOf)).toBeUndefined()
  expect(sessionIntegrationId(slackOnly, 'webchat', 'telegram:cccccccccccccccccccccccc', scopeOf)).toBeUndefined()
  expect(sessionIntegrationId([], 'webchat', 'slack:111111111111111111111111', scopeOf)).toBeUndefined()
  expect(sessionIntegrationId(undefined, 'webchat', 'slack:111111111111111111111111', scopeOf)).toBeUndefined()
})

it('keeps the platform-filtered choice for real platforms and unscoped rows', () => {
  expect(sessionIntegrationId(mixed, 'slack', 'slack:aaaaaaaaaaaaaaaaaaaaaaaa', scopeOf)).toBe('slack-a')
  expect(sessionIntegrationId(mixed, 'slack', undefined, scopeOf)).toBe('slack-a')
  expect(sessionIntegrationId(mixed, 'telegram', null, scopeOf)).toBe('tg')
  expect(sessionIntegrationId(slackOnly, 'webchat', undefined, scopeOf)).toBeUndefined()
})

it.each(['hook', 'dream'])('keeps the %s cross-integration lookup', (platform) => {
  expect(sessionIntegrationId(mixed, platform, 'slack:aaaaaaaaaaaaaaaaaaaaaaaa', scopeOf)).toBe('slack-a')
  expect(sessionIntegrationId(mixed, platform, undefined, scopeOf)).toBe('tg')
  expect(sessionIntegrationId(mixed, platform, 'slack:bbbbbbbbbbbbbbbbbbbbbbbb', scopeOf)).toBeUndefined()
  expect(sessionIntegrationId([], platform, undefined, scopeOf)).toBeUndefined()
})
