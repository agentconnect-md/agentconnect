import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { BotId, OrgId } from '../domain/ids.js'
import type { SessionAccessViewer } from '../http/session-access-plugin.js'
import type { BotRecord, ExternalScopeRecord } from '../persistence/ports.js'
import { createTelegramSessionAccess } from './telegram/session-access.js'
import { createDiscordSessionAccess } from './discord/session-access.js'

const VIEW = 1n << 10n
const HISTORY = 1n << 16n
const MANAGE_THREADS = 1n << 34n
const BOT_ID = '100000000000000001'
const MEMBER_ID = '100000000000000002'
const GUILD_ID = '100000000000000003'
const CHANNEL_ID = '100000000000000004'
const ROLE_ID = '100000000000000005'

function fixture(provider: 'telegram' | 'discord', respond: (url: string, init?: RequestInit) => Response) {
  const clock = new FakeClock(Date.UTC(2026, 0, 1))
  const bot = {
    id: BotId('bot-1'),
    orgId: OrgId('org-1'),
    platform: provider,
    revokedAt: null,
    credentialRevision: 1
  } as BotRecord
  const token =
    provider === 'telegram' ? '42:synthetic-token' : `${Buffer.from(BOT_ID).toString('base64url')}.synthetic.token`
  const member = provider === 'telegram' ? '123' : MEMBER_ID
  const realm = provider === 'telegram' ? 'bot42' : `bot${BOT_ID}`
  const identity = {
    chatIdentitiesFor: vi.fn(async () => [{ platform: provider, tenant: 'global', memberId: member }])
  }
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => respond(String(url), init))
  const deps = {
    clock,
    configured: true,
    identity,
    bots: { getUnscoped: async () => bot, listForOrg: async () => [bot] },
    botSecrets: { get: async () => ({ botToken: token, appToken: null, signingSecret: null }) }
  }
  const service =
    provider === 'telegram' ? createTelegramSessionAccess(deps, fetchImpl) : createDiscordSessionAccess(deps, fetchImpl)
  const viewer = {
    orgId: bot.orgId,
    userId: 'user-1',
    request: { oidcSubject: 'sub-1' },
    identitySet: new Set<string>()
  } as SessionAccessViewer
  const scope = {
    id: 'scope-1',
    orgId: bot.orgId,
    provider,
    realmKey: realm,
    resourceKind: 'conversation',
    resourceKey: provider === 'telegram' ? '-10042' : CHANNEL_ID,
    credentialKind: 'bot',
    credentialId: bot.id,
    revokedAt: null,
    aclRevision: 1n
  } as ExternalScopeRecord
  const resolve = async () => {
    viewer.identitySet.clear()
    await service.addViewerIdentities(viewer)
    return service.resolve([scope], viewer)
  }
  return { service, viewer, scope, bot, clock, identity, fetchImpl, resolve }
}

describe('Telegram permission sync', () => {
  const response =
    (status: string, admin = true) =>
    (_url: string, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body)).user_id as number
      return Response.json({
        ok: true,
        result: {
          user: { id },
          status: id === 42 ? (admin ? 'administrator' : 'member') : status,
          is_member: status === 'restricted'
        }
      })
    }

  it.each(['member', 'administrator', 'creator', 'restricted'])(
    'admits a current %s through a verified identity',
    async (status) => {
      const f = fixture('telegram', response(status))
      expect((await f.resolve()).allowedScopes).toEqual([{ id: f.scope.id, aclRevision: 1n }])
      expect(f.viewer.identitySet).toContain('telegram:bot42:123')
    }
  )

  it('expires membership and never retains an allow after an API failure', async () => {
    let status = 'member'
    const f = fixture('telegram', (url, init) =>
      status === 'error' ? new Response('', { status: 503 }) : response(status)(url, init)
    )
    expect((await f.resolve()).allowedScopes).toHaveLength(1)
    status = 'left'
    f.clock.advance(120_001)
    expect((await f.resolve()).allowedScopes).toHaveLength(0)
    status = 'error'
    f.clock.advance(30_001)
    expect(await f.resolve()).toMatchObject({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ provider: 'telegram', reason: 'unavailable' }]
    })
  })

  it('requires bot administration for groups, and the exact participant for DMs', async () => {
    const f = fixture('telegram', response('member', false))
    expect(await f.resolve()).toMatchObject({ allowedScopes: [], accessIssues: [{ reason: 'app_authorization' }] })
    f.scope.resourceKey = '123'
    f.scope.aclRevision++
    expect((await f.resolve()).allowedScopes).toHaveLength(1)
    f.scope.resourceKey = '456'
    f.scope.aclRevision++
    expect((await f.resolve()).allowedScopes).toHaveLength(0)
  })

  it('fences unlinked viewers, revoked credentials, foreign organizations and mismatched bot realms', async () => {
    const f = fixture('telegram', response('member'))
    expect((await f.resolve()).allowedScopes).toHaveLength(1)
    f.identity.chatIdentitiesFor.mockResolvedValue([])
    expect((await f.resolve()).allowedScopes).toHaveLength(0)
    f.identity.chatIdentitiesFor.mockResolvedValue([{ platform: 'telegram', tenant: 'global', memberId: '123' }])
    f.bot.revokedAt = new Date()
    expect((await f.resolve()).allowedScopes).toHaveLength(0)
    f.bot.revokedAt = null
    f.scope.orgId = OrgId('another-org')
    expect((await f.resolve()).allowedScopes).toHaveLength(0)
    f.scope.orgId = f.bot.orgId
    f.scope.realmKey = 'bot99'
    expect((await f.resolve()).allowedScopes).toHaveLength(0)
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('Discord permission sync', () => {
  function discord() {
    const channel = {
      id: CHANNEL_ID,
      type: 0,
      guild_id: GUILD_ID,
      permission_overwrites: [] as { id: string; type: number; allow: string; deny: string }[]
    }
    const member = { user: { id: MEMBER_ID }, roles: [ROLE_ID] }
    const roles = [
      { id: GUILD_ID, permissions: String(VIEW | HISTORY) },
      { id: ROLE_ID, permissions: '0' }
    ]
    const state = { member: true, threadMember: false, threadType: 0 }
    const f = fixture('discord', (url) => {
      const path = new URL(url).pathname.replace('/api/v10', '')
      if (path === `/channels/${CHANNEL_ID}`)
        return Response.json(
          state.threadType ? { ...channel, type: state.threadType, parent_id: '100000000000000006' } : channel
        )
      if (path === '/channels/100000000000000006') return Response.json({ ...channel, id: '100000000000000006' })
      if (path === `/guilds/${GUILD_ID}`) return Response.json({ id: GUILD_ID, owner_id: '100000000000000007' })
      if (path === `/guilds/${GUILD_ID}/members/${MEMBER_ID}`)
        return state.member ? Response.json(member) : new Response('', { status: 404 })
      if (path === `/guilds/${GUILD_ID}/roles`) return Response.json(roles)
      if (path === `/channels/${CHANNEL_ID}/thread-members/${MEMBER_ID}`)
        return state.threadMember ? Response.json({ user_id: MEMBER_ID }) : new Response('', { status: 404 })
      throw new Error(`Unexpected endpoint: ${path}`)
    })
    const refresh = () => {
      f.scope.aclRevision++
      return f.resolve()
    }
    return { ...f, channel, roles, member, state, refresh }
  }

  it('applies everyone, role, then member overwrites in order', async () => {
    const f = discord()
    f.channel.permission_overwrites.push(
      { id: GUILD_ID, type: 0, allow: '0', deny: String(VIEW) },
      { id: ROLE_ID, type: 0, allow: String(VIEW), deny: '0' }
    )
    expect((await f.resolve()).allowedScopes).toHaveLength(1)
    f.channel.permission_overwrites.push({ id: MEMBER_ID, type: 1, allow: '0', deny: String(HISTORY) })
    expect((await f.refresh()).allowedScopes).toHaveLength(0)
    f.roles[1]!.permissions = String(1n << 3n)
    expect((await f.refresh()).allowedScopes).toHaveLength(1)
  })

  it('requires membership for private threads and parent visibility even for thread members', async () => {
    const f = discord()
    f.state.threadType = 12
    expect((await f.resolve()).allowedScopes).toHaveLength(0)
    f.state.threadMember = true
    expect((await f.refresh()).allowedScopes).toHaveLength(1)
    f.channel.permission_overwrites.push({ id: MEMBER_ID, type: 1, allow: '0', deny: String(VIEW) })
    expect((await f.refresh()).allowedScopes).toHaveLength(0)
    f.channel.permission_overwrites = []
    f.state.threadMember = false
    f.roles[1]!.permissions = String(MANAGE_THREADS)
    expect((await f.refresh()).allowedScopes).toHaveLength(1)
  })

  it('denies departed members and does not treat API authorization failures as membership', async () => {
    const f = discord()
    f.state.member = false
    expect(await f.resolve()).toMatchObject({ allowedScopes: [], degraded: false })
    const failed = fixture('discord', () => new Response('', { status: 403 }))
    expect(await failed.resolve()).toMatchObject({
      allowedScopes: [],
      degraded: true,
      accessIssues: [{ reason: 'app_authorization' }]
    })
  })
})
