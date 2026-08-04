import { describe, it, expect } from 'vitest'
import { connectionIdentityFor, tenantScopeFor, type TenantScopeHost } from '../src/platforms/transport-identity.js'
import { conversationAudienceFor } from '../src/platforms/session-audience.js'

const host = (live?: string, minted?: string): TenantScopeHost => ({
  liveWorkspaceId: () => live,
  minted: () => minted
})

describe('connection identity (transport scope)', () => {
  it('names the credential that identifies one physical connection', () => {
    // A shared Slack bot has no app token to key on; a socket integration keys on it.
    expect(
      connectionIdentityFor({ id: 'i1', platform: 'slack', slack: { mode: 'shared', botToken: 'xoxb-1' } } as never)
    ).toBe('xoxb-1')
    expect(
      connectionIdentityFor({
        id: 'i1',
        platform: 'slack',
        slack: { mode: 'socket', botToken: 'xoxb-1', appToken: 'xapp-1' }
      } as never)
    ).toBe('xapp-1')
    // The BotFather bot-id prefix survives a secret rotation…
    expect(connectionIdentityFor({ id: 'i2', platform: 'telegram', telegram: { botToken: '42:AAff' } } as never)).toBe(
      '42'
    )
    // …non-standard tokens fall back to the full credential.
    expect(
      connectionIdentityFor({ id: 'i2', platform: 'telegram', telegram: { botToken: 'test-token' } } as never)
    ).toBe('test-token')
    expect(connectionIdentityFor({ id: 'i3', platform: 'discord', discord: { botToken: 'dt' } } as never)).toBe('dt')
    expect(
      connectionIdentityFor({ id: 'i4', platform: 'feishu', feishu: { region: 'lark', appId: 'cli_1' } } as never)
    ).toBe('lark:cli_1')
  })

  it('over-isolates unknown platforms rather than over-sharing', () => {
    // Identity = the integration id: the scope never consolidates across
    // integrations, which cannot merge unrelated conversations.
    expect(connectionIdentityFor({ id: 'i9', platform: 'some-future-platform' })).toBe('i9')
  })
})

describe('tenant scope (durable owner identity)', () => {
  it('prefers the platform tenant id, falls back to the minted scope', () => {
    expect(tenantScopeFor(host('T012', 'm1'), { id: 'i1', platform: 'slack' })).toBe('T012')
    expect(tenantScopeFor(host(undefined, 'm1'), { id: 'i1', platform: 'slack' })).toBe('m1')
    expect(
      tenantScopeFor(host(undefined, 'm2'), { id: 'i2', platform: 'telegram', telegram: { botToken: '42:x' } } as never)
    ).toBe('bot42')
    expect(
      tenantScopeFor(host(undefined, 'm2'), {
        id: 'i2',
        platform: 'telegram',
        telegram: { botToken: 'weird' }
      } as never)
    ).toBe('m2')
    expect(
      tenantScopeFor(host(undefined, 'm3'), {
        id: 'i4',
        platform: 'feishu',
        feishu: { region: 'lark', appId: 'c1' }
      } as never)
    ).toBe('lark:c1')
  })

  it('mints for platforms with no durable tenant id (Discord, unknown)', () => {
    expect(tenantScopeFor(host(undefined, 'm4'), { id: 'i3', platform: 'discord' })).toBe('m4')
    expect(tenantScopeFor(host(undefined, 'm5'), { id: 'i9', platform: 'some-future-platform' })).toBe('m5')
    // No minted scope either ⇒ undefined ⇒ the CP records no owner (fail closed).
    expect(tenantScopeFor(host(undefined, undefined), { id: 'i9', platform: 'x' })).toBeUndefined()
  })
})

describe('conversation audience', () => {
  it('binds Slack channels but not Slack DMs', () => {
    const slack = conversationAudienceFor('slack')!
    expect(slack.applies({ isDm: false })).toBe(true)
    expect(slack.applies({ isDm: true })).toBe(false)
    expect(slack.realmKey({ liveWorkspaceId: () => 'T01', tenantScope: () => 'x' }, 'i1', undefined)).toBe('T01')
    // Unresolved integration ⇒ unattributable realm, not a guessed one.
    expect(
      slack.realmKey({ liveWorkspaceId: () => 'T01', tenantScope: () => 'x' }, undefined, undefined)
    ).toBeUndefined()
  })

  it('binds every Feishu conversation through the tenant anchor', () => {
    const feishu = conversationAudienceFor('feishu')!
    expect(feishu.applies({ isDm: true })).toBe(true)
    expect(
      feishu.realmKey({ liveWorkspaceId: () => undefined, tenantScope: () => 'lark:c1' }, 'i4', {
        id: 'i4',
        platform: 'feishu'
      })
    ).toBe('lark:c1')
  })

  it('binds nothing elsewhere — local classification rules alone', () => {
    for (const p of ['telegram', 'discord', 'webchat', 'hook', 'some-future-platform']) {
      expect(conversationAudienceFor(p)).toBeUndefined()
    }
  })
})
