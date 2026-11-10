import { describe, expect, it } from 'vitest'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import type {
  CreateWechatPendingLoginInput,
  WechatPendingLoginRecord,
  WechatPendingLoginStore
} from '../../persistence/ports.js'
import type { WeChatLoginClient, WeChatQrStatus } from './ilink.js'
import {
  WECHAT_LOGIN_TTL_MS,
  WECHAT_QR_TTL_MS,
  WeChatLoginConflictError,
  WeChatLoginService,
  WeChatLoginSetupError
} from './login.js'

const ORG = OrgId('org-1')
const AGENT = AgentId('00000000-0000-4000-8000-000000000001')
const API = 'https://ilinkai.weixin.qq.com'

function memoryStore(): WechatPendingLoginStore & { rows: Map<string, WechatPendingLoginRecord> } {
  const rows = new Map<string, WechatPendingLoginRecord>()
  const claims = new Map<string, { token: string; until: Date }>()
  const open = (r: WechatPendingLoginRecord) => !['completed', 'failed'].includes(r.status)
  return {
    rows,
    async create(input: CreateWechatPendingLoginInput) {
      const row: WechatPendingLoginRecord = {
        ...input,
        botId: input.botId ?? null,
        requestedName: input.requestedName ?? null,
        status: 'waiting',
        failureReason: null,
        botToken: null,
        ilinkBotId: null,
        ilinkUserId: null,
        baseUrl: null,
        integrationId: null,
        resultBotId: null,
        createdAt: new Date(),
        settledAt: null
      }
      rows.set(row.id, row)
      return row
    },
    async get(orgId, id) {
      const row = rows.get(id)
      return row && row.orgId === orgId ? { ...row } : null
    },
    async getActiveTarget(orgId, targetKey) {
      return [...rows.values()].find((r) => r.orgId === orgId && r.targetKey === targetKey) ?? null
    },
    async advance(_orgId, id, patch) {
      const row = rows.get(id)!
      if (['waiting', 'scanned', 'verify_code'].includes(row.status)) Object.assign(row, patch)
    },
    async authorize(_orgId, id, result) {
      Object.assign(rows.get(id)!, { status: 'authorized', qrcode: null, ...result })
    },
    async claim(_orgId, id, token, now, until) {
      const row = rows.get(id)!
      if (row.status !== 'authorized' || (claims.get(id) && claims.get(id)!.until > now)) return false
      claims.set(id, { token, until })
      return true
    },
    async release(_orgId, id, token) {
      if (claims.get(id)?.token === token) claims.delete(id)
    },
    async settle(_orgId, id, outcome, at) {
      const row = rows.get(id)!
      if (!open(row)) return
      Object.assign(row, { targetKey: null, qrcode: null, botToken: null, settledAt: at, status: outcome.status })
      if (outcome.status === 'completed')
        Object.assign(row, { integrationId: outcome.integrationId, resultBotId: outcome.botId })
      else row.failureReason = outcome.failureReason
    },
    async reapExpired() {
      return 0
    }
  }
}

function client(statuses: WeChatQrStatus[]): WeChatLoginClient {
  return {
    newQrCode: async () => ({ qrcode: 'qr', qrUrl: 'https://liteapp.weixin.qq.com/q/example' }),
    status: async () => statuses.shift() ?? { status: 'wait' }
  }
}

const confirmed: WeChatQrStatus = {
  status: 'confirmed',
  botToken: 'example-token',
  ilinkBotId: 'abc@im.bot',
  ilinkUserId: 'user123456@im.wechat',
  baseUrl: null
}
const installed = {
  integrationId: IntegrationId('00000000-0000-4000-8000-0000000000aa'),
  botId: BotId('00000000-0000-4000-8000-0000000000bb')
}

describe('WeChat QR login service', () => {
  it('keeps a confirmed token when the install fails transiently, and installs it on the next poll', async () => {
    const store = memoryStore()
    const service = new WeChatLoginService(store, client([confirmed]), API)
    const login = await service.start({ orgId: ORG, agentId: AGENT, createdByUserId: 'member-1' })
    let attempts = 0
    const finalize = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('placement is changing')
      return installed
    }
    await expect(service.poll(ORG, 'member-1', login.id, finalize)).resolves.toMatchObject({ status: 'scanned' })
    expect(store.rows.get(login.id)?.botToken).toBe('example-token')
    await expect(service.poll(ORG, 'member-1', login.id, finalize)).resolves.toMatchObject({
      status: 'completed',
      integrationId: installed.integrationId,
      wechatUserTail: '123456'
    })
    expect(store.rows.get(login.id)?.botToken).toBeNull()
  })

  it('ends the login when the install is refused', async () => {
    const service = new WeChatLoginService(memoryStore(), client([confirmed]), API)
    const login = await service.start({ orgId: ORG, agentId: AGENT, createdByUserId: 'member-1' })
    const refused = async () => {
      throw new WeChatLoginSetupError('agent_unavailable')
    }
    await expect(service.poll(ORG, 'member-1', login.id, refused)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'agent_unavailable'
    })
  })

  it('answers only the member who started it, and conflicts a second member', async () => {
    const service = new WeChatLoginService(memoryStore(), client([]), API)
    const login = await service.start({ orgId: ORG, agentId: AGENT, createdByUserId: 'member-1' })
    await expect(service.poll(ORG, 'member-2', login.id, async () => installed)).resolves.toBeNull()
    await expect(service.start({ orgId: ORG, agentId: AGENT, createdByUserId: 'member-2' })).rejects.toBeInstanceOf(
      WeChatLoginConflictError
    )
  })

  it('ends an unscanned code with its lifetime and frees the agent for a new login', async () => {
    let now = Date.parse('2026-11-10T00:00:00Z')
    const service = new WeChatLoginService(memoryStore(), client([]), API, () => now)
    const login = await service.start({ orgId: ORG, agentId: AGENT, createdByUserId: 'member-1' })
    expect(Date.parse(login.expiresAt) - now).toBe(WECHAT_QR_TTL_MS)
    now += WECHAT_QR_TTL_MS + 1
    await expect(service.poll(ORG, 'member-1', login.id, async () => installed)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'expired'
    })
    const next = await service.start({ orgId: ORG, agentId: AGENT, createdByUserId: 'member-2' })
    expect(next.id).not.toBe(login.id)
  })

  it('lets a scanned login outlive its code until the member confirms', async () => {
    let now = Date.parse('2026-11-10T00:00:00Z')
    const store = memoryStore()
    const service = new WeChatLoginService(store, client([{ status: 'scaned' }]), API, () => now)
    const login = await service.start({ orgId: ORG, agentId: AGENT, createdByUserId: 'member-1' })
    store.rows.get(login.id)!.createdAt = new Date(now)
    await expect(service.poll(ORG, 'member-1', login.id, async () => installed)).resolves.toMatchObject({
      status: 'scanned'
    })
    now += WECHAT_QR_TTL_MS + 1
    await expect(service.poll(ORG, 'member-1', login.id, async () => installed)).resolves.toMatchObject({
      status: 'scanned'
    })
    now += WECHAT_LOGIN_TTL_MS
    await expect(service.poll(ORG, 'member-1', login.id, async () => installed)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'expired'
    })
  })

  it('installs a confirmed login once when two polls overlap', async () => {
    const store = memoryStore()
    const service = new WeChatLoginService(store, client([confirmed, confirmed]), API)
    const login = await service.start({ orgId: ORG, agentId: AGENT, createdByUserId: 'member-1' })
    let calls = 0
    let finish!: () => void
    const finalize = async () => {
      calls += 1
      await new Promise<void>((resolve) => (finish = resolve))
      return installed
    }
    const first = service.poll(ORG, 'member-1', login.id, finalize)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(service.poll(ORG, 'member-1', login.id, finalize)).resolves.toMatchObject({ status: 'scanned' })
    finish()
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    expect(calls).toBe(1)
  })

  it('counts a scan that lands at the deadline', async () => {
    let now = Date.parse('2026-11-10T00:00:00Z')
    const service = new WeChatLoginService(memoryStore(), client([{ status: 'scaned' }]), API, () => now)
    const login = await service.start({ orgId: ORG, agentId: AGENT, createdByUserId: 'member-1' })
    now += WECHAT_QR_TTL_MS + 1
    await expect(service.poll(ORG, 'member-1', login.id, async () => installed)).resolves.toMatchObject({
      status: 'scanned'
    })
  })
})
