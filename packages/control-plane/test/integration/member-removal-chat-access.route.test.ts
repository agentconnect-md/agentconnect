// Removing a member ends the chat access that existed only because they were one (resource-visibility.md §8.3).
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { LinkedChatIdentity, LogtoIdentityService } from '../../src/github/logto-identity.js'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const WORKSPACE = 'T_EXAMPLE'

class SpyControl {
  readonly upserts: IntegrationUpsert[] = []
  readonly removes: IntegrationRemove[] = []
  async integrationUpsert(_daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async integrationRemove(_daemonId: string, r: IntegrationRemove): Promise<void> {
    this.removes.push(r)
  }
}

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function member(label: string): Promise<{ userId: string; sub: string }> {
  const sub = `${label}-${randomUUID()}`
  const email = `${sub}@example.test`
  const repo = new PgUserRepo(prisma)
  const { userId } = await repo.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await repo.addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
  return { userId, sub }
}

/** One bot with one install on `agentId`, plus the given conversation rows. */
async function install(
  agentId: string,
  bot: { platform: string; platformConfig?: Record<string, string>; workspaceId?: string },
  channels: Array<{
    channelId: string
    kind?: 'im' | 'channel'
    trigger: 'off' | 'any' | 'mention'
    dmUserId?: string
    triggerChosen?: boolean
  }> = []
): Promise<{ botId: string; integrationId: string }> {
  const botId = randomUUID()
  const integrationId = randomUUID()
  await prisma.bot.create({
    data: {
      id: botId,
      orgId: DEFAULT_ORG_ID,
      name: `bot-${botId}`,
      platform: bot.platform,
      ...(bot.workspaceId ? { workspaceId: bot.workspaceId } : {}),
      ...(bot.platformConfig ? { platformConfig: bot.platformConfig } : {}),
      secret: { create: { botToken: 'test-token', appToken: 'test-app-token' } }
    }
  })
  await prisma.integration.create({
    data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform: bot.platform, name: 'install' }
  })
  if (channels.length > 0) {
    await prisma.integrationChannel.createMany({
      data: channels.map((c) => ({ integrationId, kind: 'channel' as const, ...c }))
    })
  }
  return { botId, integrationId }
}

const fakeIdentity = (links: Record<string, LinkedChatIdentity[] | Error>) =>
  ({
    chatIdentitiesFor: async (sub: string) => {
      const linked = links[sub] ?? []
      if (linked instanceof Error) throw linked
      return linked
    }
  }) as unknown as LogtoIdentityService

const triggerOf = async (integrationId: string, channelId: string) =>
  prisma.integrationChannel.findUnique({
    where: { integrationId_channelId: { integrationId, channelId } },
    select: { trigger: true, triggerChosen: true }
  })

const preview = async (app: HttpApp, userId: string) => {
  const res = await app.app.inject({ method: 'GET', url: `${ORG}/members/${userId}/removal-preview` })
  expect(res.statusCode).toBe(200)
  return (res.json() as { chat: { bots: number; directMessages: number } }).chat
}

const remove = async (app: HttpApp, userId: string) =>
  expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/members/${userId}` })).statusCode).toBe(204)

describe('DELETE /members/:id — chat access', () => {
  it('deletes the WeChat bots the member bound and tells their daemon, leaving other members’ bots', async () => {
    const daemonId = randomUUID()
    await seedDaemon(prisma, daemonId)
    const dana = await member('dana')
    const bob = await member('bob')
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId })
    const danas = await install(agentId, { platform: 'wechat', platformConfig: { boundMemberUserId: dana.userId } })
    const bobs = await install(agentId, { platform: 'wechat', platformConfig: { boundMemberUserId: bob.userId } })
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)

    expect(await preview(running, dana.userId)).toEqual({ bots: 1, directMessages: 0 })
    await remove(running, dana.userId)

    expect(await prisma.bot.findUnique({ where: { id: danas.botId } })).toBeNull()
    expect(await prisma.integration.findUnique({ where: { id: danas.integrationId } })).toBeNull()
    expect(await prisma.botSecret.findUnique({ where: { botId: danas.botId } })).toBeNull()
    expect(spy.removes).toEqual([{ integrationId: danas.integrationId }])
    expect(await prisma.bot.findUnique({ where: { id: bobs.botId } })).not.toBeNull()
  })

  it('turns Off a restricted agent’s DMs with the member’s linked chat accounts, chosen or not, and nothing else', async () => {
    const daemonId = randomUUID()
    await seedDaemon(prisma, daemonId)
    const dana = await member('dana')
    const bob = await member('bob')
    const privateAgent = randomUUID()
    await seedAgent(prisma, privateAgent, { daemonId, visibility: 'restricted', sharedWith: [dana.userId, bob.userId] })
    const everyoneAgent = randomUUID()
    await seedAgent(prisma, everyoneAgent, { daemonId })
    const slack = await install(privateAgent, { platform: 'slack', workspaceId: WORKSPACE }, [
      { channelId: 'D_DANA', kind: 'im', trigger: 'any', dmUserId: 'U_DANA' },
      { channelId: 'D_BOB', kind: 'im', trigger: 'any', dmUserId: 'U_BOB' },
      { channelId: 'C_TEAM', trigger: 'any' }
    ])
    const telegram = await install(privateAgent, { platform: 'telegram' }, [
      { channelId: '1001', kind: 'im', trigger: 'any', dmUserId: '1001', triggerChosen: true }
    ])
    const open = await install(everyoneAgent, { platform: 'slack', workspaceId: WORKSPACE }, [
      { channelId: 'D_DANA', kind: 'im', trigger: 'any', dmUserId: 'U_DANA' }
    ])
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender, {
      logtoIdentity: fakeIdentity({
        [dana.sub]: [
          { platform: 'slack', tenant: WORKSPACE, memberId: 'U_DANA' },
          { platform: 'telegram', tenant: 'global', memberId: '1001' }
        ]
      })
    })

    expect(await preview(running, dana.userId)).toEqual({ bots: 0, directMessages: 2 })
    await remove(running, dana.userId)

    expect(await triggerOf(slack.integrationId, 'D_DANA')).toEqual({ trigger: 'off', triggerChosen: false })
    expect(await triggerOf(telegram.integrationId, '1001')).toEqual({ trigger: 'off', triggerChosen: false })
    expect(await triggerOf(slack.integrationId, 'D_BOB')).toMatchObject({ trigger: 'any' })
    expect(await triggerOf(slack.integrationId, 'C_TEAM')).toMatchObject({ trigger: 'any' })
    // An Everyone agent's DM is open to anyone in the workspace, so it does not change.
    expect(await triggerOf(open.integrationId, 'D_DANA')).toMatchObject({ trigger: 'any' })
    // The re-gated installs are pushed so their daemons stop answering now.
    const pushed = new Set(spy.upserts.map((u) => u.integrationId))
    expect(pushed.has(slack.integrationId) && pushed.has(telegram.integrationId)).toBe(true)
    expect(pushed.has(open.integrationId)).toBe(false)
  })

  it('closes a shared bot’s DM on every sibling row when its owning agent is restricted', async () => {
    const daemonId = randomUUID()
    await seedDaemon(prisma, daemonId)
    const dana = await member('dana')
    const owner = randomUUID()
    await seedAgent(prisma, owner, { daemonId, visibility: 'restricted', sharedWith: [dana.userId] })
    const sibling = randomUUID()
    await seedAgent(prisma, sibling, { daemonId })
    const botId = randomUUID()
    await prisma.bot.create({
      data: {
        id: botId,
        orgId: DEFAULT_ORG_ID,
        name: `bot-${botId}`,
        platform: 'slack',
        transport: 'http',
        workspaceId: WORKSPACE,
        secret: { create: { botToken: 'test-token' } }
      }
    })
    const rows: string[] = []
    for (const agentId of [owner, sibling]) {
      const integrationId = randomUUID()
      rows.push(integrationId)
      await prisma.integration.create({
        data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'slack', name: 'shared' }
      })
      await prisma.integrationChannel.create({
        data: {
          integrationId,
          channelId: 'D_DANA',
          kind: 'im',
          trigger: 'any',
          dmUserId: 'U_DANA',
          ...(agentId === owner ? { agentId: owner } : {})
        }
      })
    }
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender, {
      logtoIdentity: fakeIdentity({ [dana.sub]: [{ platform: 'slack', tenant: WORKSPACE, memberId: 'U_DANA' }] })
    })

    expect(await preview(running, dana.userId)).toEqual({ bots: 0, directMessages: 1 })
    await remove(running, dana.userId)

    for (const integrationId of rows) expect(await triggerOf(integrationId, 'D_DANA')).toMatchObject({ trigger: 'off' })
  })

  it('still removes the member when their linked chat accounts cannot be read', async () => {
    const daemonId = randomUUID()
    await seedDaemon(prisma, daemonId)
    const dana = await member('dana')
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId, visibility: 'restricted', sharedWith: [dana.userId] })
    const wechat = await install(agentId, { platform: 'wechat', platformConfig: { boundMemberUserId: dana.userId } })
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender, {
      logtoIdentity: fakeIdentity({ [dana.sub]: new Error('identity provider unavailable') })
    })

    expect(await preview(running, dana.userId)).toEqual({ bots: 1, directMessages: 0 })
    await remove(running, dana.userId)

    expect(await prisma.membership.findFirst({ where: { orgId: DEFAULT_ORG_ID, userId: dana.userId } })).toBeNull()
    expect(await prisma.bot.findUnique({ where: { id: wechat.botId } })).toBeNull()
  })
})
