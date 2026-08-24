import { describe, it, expect } from 'vitest'
import { connectionIdentityFor, tenantScopeFor, type TenantScopeHost } from '../src/platforms/transport-identity.js'
import { conversationAudienceFor } from '../src/platforms/session-audience.js'

const host = (live?: string, minted?: string): TenantScopeHost => ({
  liveWorkspaceId: () => live,
  minted: async () => minted
})

describe('connection identity (transport scope)', () => {
  it('names the credential that identifies one physical connection', () => {
    // A shared Slack bot has no app token to key on; a socket integration keys on it.
    expect(
      connectionIdentityFor({
        id: 'i1',
        platform: 'slack',
        core: { mode: 'shared' },
        config: { botToken: 'xoxb-1' }
      } as never)
    ).toBe('xoxb-1')
    expect(
      connectionIdentityFor({
        id: 'i1',
        platform: 'slack',
        core: { mode: 'socket' },
        config: { botToken: 'xoxb-1', appToken: 'xapp-1' }
      } as never)
    ).toBe('xapp-1')
    // The BotFather bot-id prefix survives a secret rotation…
    expect(connectionIdentityFor({ id: 'i2', platform: 'telegram', config: { botToken: '42:AAff' } } as never)).toBe(
      '42'
    )
    // …non-standard tokens fall back to the full credential.
    expect(connectionIdentityFor({ id: 'i2', platform: 'telegram', config: { botToken: 'test-token' } } as never)).toBe(
      'test-token'
    )
    expect(connectionIdentityFor({ id: 'i3', platform: 'discord', config: { botToken: 'dt' } } as never)).toBe('dt')
    expect(
      connectionIdentityFor({
        id: 'i4',
        platform: 'feishu',
        config: { region: 'lark', appId: 'cli_1', appSecret: 's' }
      } as never)
    ).toBe('lark:cli_1')
    // The schema default supplies the region a hand-authored payload omitted.
    expect(
      connectionIdentityFor({ id: 'i4', platform: 'feishu', config: { appId: 'cli_1', appSecret: 's' } } as never)
    ).toBe('feishu:cli_1')
  })

  it('fails CLOSED (integration-id isolation) on a payload the module schema refuses — never a throw', () => {
    // The payload is opaque `unknown` on the entry: a malformed value must not
    // reach `.split()` etc. through an unchecked cast (it used to throw here).
    expect(connectionIdentityFor({ id: 'i2', platform: 'telegram', config: { botToken: 42 } } as never)).toBe('i2')
    expect(connectionIdentityFor({ id: 'i1', platform: 'slack', config: {} } as never)).toBe('i1')
    expect(connectionIdentityFor({ id: 'i4', platform: 'feishu', config: { appId: 'cli_1' } } as never)).toBe('i4')
    // A config-less entry (a pre-S3 nested-shape leftover) isolates the same way.
    expect(connectionIdentityFor({ id: 'i5', platform: 'discord' } as never)).toBe('i5')
    // Prototype-name platform ids read as unregistered, not as inherited values.
    for (const platform of ['constructor', 'toString', '__proto__']) {
      expect(connectionIdentityFor({ id: 'i6', platform, config: { botToken: 'x' } } as never)).toBe('i6')
    }
  })

  it('over-isolates unknown platforms rather than over-sharing', () => {
    // Identity = the integration id: the scope never consolidates across
    // integrations, which cannot merge unrelated conversations.
    expect(connectionIdentityFor({ id: 'i9', platform: 'some-future-platform' } as never)).toBe('i9')
  })
})

describe('tenant scope (durable owner identity)', () => {
  it('prefers the platform tenant id, falls back to the minted scope', async () => {
    expect(await tenantScopeFor(host('T012', 'm1'), { id: 'i1', platform: 'slack' } as never)).toBe('T012')
    expect(await tenantScopeFor(host(undefined, 'm1'), { id: 'i1', platform: 'slack' } as never)).toBe('m1')
    expect(
      await tenantScopeFor(host(undefined, 'm2'), {
        id: 'i2',
        platform: 'telegram',
        config: { botToken: '42:x' }
      } as never)
    ).toBe('bot42')
    expect(
      await tenantScopeFor(host(undefined, 'm2'), {
        id: 'i2',
        platform: 'telegram',
        config: { botToken: 'weird' }
      } as never)
    ).toBe('m2')
    expect(
      await tenantScopeFor(host(undefined, 'm3'), {
        id: 'i4',
        platform: 'feishu',
        config: { region: 'lark', appId: 'c1', appSecret: 's' }
      } as never)
    ).toBe('lark:c1')
  })

  it('falls back to the minted scope on a payload the module schema refuses — never a throw', async () => {
    expect(
      await tenantScopeFor(host(undefined, 'm6'), { id: 'i2', platform: 'telegram', config: { botToken: 42 } } as never)
    ).toBe('m6')
    expect(
      await tenantScopeFor(host(undefined, 'm7'), { id: 'i4', platform: 'feishu', config: { appId: 'c1' } } as never)
    ).toBe('m7')
  })

  it('mints for platforms with no durable tenant id (Discord, unknown)', async () => {
    expect(await tenantScopeFor(host(undefined, 'm4'), { id: 'i3', platform: 'discord' } as never)).toBe('m4')
    expect(await tenantScopeFor(host(undefined, 'm5'), { id: 'i9', platform: 'some-future-platform' } as never)).toBe(
      'm5'
    )
    // No minted scope either ⇒ undefined ⇒ the CP records no owner (fail closed).
    expect(await tenantScopeFor(host(undefined, undefined), { id: 'i9', platform: 'x' } as never)).toBeUndefined()
  })
})

describe('conversation audience', () => {
  it('binds Slack channels but not Slack DMs', async () => {
    const slack = conversationAudienceFor('slack')!
    expect(slack.applies({ isDm: false })).toBe(true)
    expect(slack.applies({ isDm: true })).toBe(false)
    expect(await slack.realmKey({ liveWorkspaceId: () => 'T01', tenantScope: async () => 'x' }, 'i1', undefined)).toBe(
      'T01'
    )
    // Unresolved integration ⇒ unattributable realm, not a guessed one.
    expect(
      await slack.realmKey({ liveWorkspaceId: () => 'T01', tenantScope: async () => 'x' }, undefined, undefined)
    ).toBeUndefined()
  })

  it('binds every Feishu conversation through the tenant anchor', async () => {
    const feishu = conversationAudienceFor('feishu')!
    expect(feishu.applies({ isDm: true })).toBe(true)
    expect(
      await feishu.realmKey({ liveWorkspaceId: () => undefined, tenantScope: async () => 'lark:c1' }, 'i4', {
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
