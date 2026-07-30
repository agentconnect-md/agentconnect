import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../src/domain/ids.js'
import type { IconStore } from '../../src/icons/icon-store.js'
import type { BotProfileIconAgent } from '../../src/http/bot-profile-icon.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
  0, 0, 0
])

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

describe('Agent icon bot profile fan-out', () => {
  it('syncs dedicated Telegram/Discord/Feishu bots only when the Agent icon changes', async () => {
    const store: IconStore = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
      publicUrl: vi.fn((key, version) => `https://images.example.test/${key}?v=${version}`)
    }
    const telegramSync = vi.fn(async (_botToken: string, _agent: BotProfileIconAgent) => {})
    const discordSync = vi.fn(async (_botToken: string, _agent: BotProfileIconAgent) => {})
    const feishuSync = vi.fn(
      async (_appId: string, _appSecret: string, _region: 'feishu' | 'lark', _agent: BotProfileIconAgent) => {}
    )
    running = buildHttpApp(prisma, { S3_PUBLIC_BASE_URL: 'https://images.example.test' }, undefined, undefined, {
      iconStore: store,
      syncTelegramBotIcon: telegramSync,
      syncDiscordBotIcon: discordSync,
      syncFeishuAppIcon: feishuSync
    })

    const create = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'profile-sync', runtime: 'codex' }
    })
    expect(create.statusCode).toBe(201)
    const agentId = AgentId((create.json() as { id: string }).id)
    const orgId = OrgId(DEFAULT_ORG_ID)

    for (const [platform, token] of [
      ['telegram', 'telegram-token'],
      ['discord', 'discord-token'],
      ['feishu', 'feishu-secret']
    ] as const) {
      const botId = BotId(randomUUID())
      await running.deps.repos.bot.create({
        id: botId,
        orgId,
        platform,
        name: `${platform}-bot`,
        ...(platform === 'feishu' ? { feishuAppId: 'cli_feishu', feishuRegion: 'lark' } : {})
      })
      await running.deps.repos.botSecret.put(botId, {
        botToken: token,
        appToken: platform === 'feishu' ? 'cli_feishu' : null,
        signingSecret: null
      })
      await running.deps.repos.integration.create({
        id: IntegrationId(randomUUID()),
        orgId,
        agentId,
        botId,
        platform,
        name: `${platform}-bot`
      })
    }

    const ordinaryEdit = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { description: 'ordinary edit' }
    })
    expect(ordinaryEdit.statusCode).toBe(200)
    expect(telegramSync).not.toHaveBeenCalled()
    expect(discordSync).not.toHaveBeenCalled()
    expect(feishuSync).not.toHaveBeenCalled()

    const glyphEdit = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { icon: { kind: 'glyph', glyph: 'bot', color: '#2563eb' } }
    })
    expect(glyphEdit.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(telegramSync).toHaveBeenCalledTimes(1)
      expect(discordSync).toHaveBeenCalledTimes(1)
      expect(feishuSync).toHaveBeenCalledTimes(1)
    })

    const upload = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/icon`,
      headers: { 'content-type': 'image/png' },
      payload: PNG
    })
    expect(upload.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(telegramSync).toHaveBeenCalledTimes(2)
      expect(discordSync).toHaveBeenCalledTimes(2)
      expect(feishuSync).toHaveBeenCalledTimes(2)
    })
    expect(telegramSync.mock.calls[1]?.[1].icon).toEqual({
      kind: 'image',
      generation: expect.any(String)
    })
    expect(discordSync.mock.calls[1]?.[1].icon).toEqual({
      kind: 'image',
      generation: expect.any(String)
    })
    expect(feishuSync.mock.calls[1]?.[3].icon).toEqual({
      kind: 'image',
      generation: expect.any(String)
    })

    const remove = await running.app.inject({
      method: 'DELETE',
      url: `${ORG}/agents/${agentId}/icon`
    })
    expect(remove.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(telegramSync).toHaveBeenCalledTimes(3)
      expect(discordSync).toHaveBeenCalledTimes(3)
      expect(feishuSync).toHaveBeenCalledTimes(3)
    })
    expect(telegramSync.mock.calls[2]?.[1].icon?.kind).toBe('glyph')
    expect(discordSync.mock.calls[2]?.[1].icon?.kind).toBe('glyph')
    expect(feishuSync.mock.calls[2]?.[3].icon?.kind).toBe('glyph')
    expect(feishuSync).toHaveBeenCalledWith('cli_feishu', 'feishu-secret', 'lark', expect.any(Object))
  })
})
