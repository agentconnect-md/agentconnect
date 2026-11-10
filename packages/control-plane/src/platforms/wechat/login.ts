// The Control Plane's personal-WeChat QR login (wechat-integration.md §2.2): one durable row per login, one iLink status call per Console poll.
import { randomUUID } from 'node:crypto'
import type { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import type { WechatPendingLoginRecord, WechatPendingLoginStore } from '../../persistence/ports.js'
import { weChatPollHost, type WeChatLoginClient } from './ilink.js'

/** How long one QR code is offered; WeChat expires its codes after about two minutes (§2.2). */
export const WECHAT_QR_TTL_MS = 2 * 60 * 1000

/** How long one poll holds a confirmed login's install before another may take it over. */
export const WECHAT_INSTALL_CLAIM_MS = 2 * 60 * 1000

/** How long a scanned login may wait for the member's confirmation. */
export const WECHAT_LOGIN_TTL_MS = 10 * 60 * 1000

// An unscanned login ends with its code; a scanned one waits for confirmation up to the login's lifetime.
function timedOut(row: WechatPendingLoginRecord, now: Date): boolean {
  if (row.status === 'authorized') return false
  if (row.status === 'waiting') return row.expiresAt <= now
  return row.createdAt.getTime() + WECHAT_LOGIN_TTL_MS <= now.getTime()
}

export type WeChatLoginFailure = 'expired' | 'verify_code_blocked' | 'agent_unavailable' | 'setup_failed'

export interface WeChatLoginSnapshot {
  id: string
  status: 'waiting' | 'scanned' | 'verify_code' | 'completed' | 'failed'
  qrUrl: string | null
  expiresAt: string
  failureReason: WeChatLoginFailure | null
  integrationId: string | null
  botId: string | null
  wechatUserTail: string | null
}

/** The confirmed login a finalizer installs: a new bot for the agent, or new credentials for `botId`. */
export interface WeChatConfirmedLogin {
  id: string
  orgId: OrgId
  agentId: AgentId
  botId: BotId | null
  requestedName: string | null
  createdByUserId: string
  botToken: string
  ilinkBotId: string
  ilinkUserId: string
  baseUrl: string | null
}

export type WeChatFinalize = (login: WeChatConfirmedLogin) => Promise<{ integrationId: IntegrationId; botId: BotId }>

/** A finalizer refusal that ends the login; any other error keeps the token for a retry on the next poll. */
export class WeChatLoginSetupError extends Error {
  constructor(readonly reason: Exclude<WeChatLoginFailure, 'expired' | 'verify_code_blocked'>) {
    super(reason)
    this.name = 'WeChatLoginSetupError'
  }
}

export class WeChatLoginConflictError extends Error {
  constructor() {
    super('another member is already connecting WeChat to this agent; try again in a few minutes')
    this.name = 'WeChatLoginConflictError'
  }
}

export function weChatUserTail(ilinkUserId: string | null): string | null {
  if (!ilinkUserId) return null
  const local = ilinkUserId.split('@', 1)[0] ?? ilinkUserId
  return local.slice(-6)
}

const FAILURES = new Set<string>(['expired', 'verify_code_blocked', 'agent_unavailable', 'setup_failed'])

function snapshot(row: WechatPendingLoginRecord): WeChatLoginSnapshot {
  const status = row.status === 'authorized' ? 'scanned' : row.status
  return {
    id: row.id,
    status,
    qrUrl: status === 'waiting' || status === 'scanned' || status === 'verify_code' ? row.qrUrl : null,
    expiresAt: row.expiresAt.toISOString(),
    failureReason:
      status === 'failed'
        ? FAILURES.has(row.failureReason ?? '')
          ? (row.failureReason as WeChatLoginFailure)
          : 'setup_failed'
        : null,
    integrationId: status === 'completed' ? row.integrationId : null,
    botId: status === 'completed' ? row.resultBotId : null,
    wechatUserTail: status === 'completed' ? weChatUserTail(row.ilinkUserId) : null
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'P2002'
}

export class WeChatLoginService {
  constructor(
    private readonly store: WechatPendingLoginStore,
    private readonly client: WeChatLoginClient,
    private readonly apiUrl: string,
    private readonly now: () => number = Date.now
  ) {}

  async start(input: {
    orgId: OrgId
    agentId: AgentId
    botId?: BotId
    requestedName?: string
    createdByUserId: string
  }): Promise<WeChatLoginSnapshot> {
    const targetKey = input.botId ? `${input.orgId}:bot:${input.botId}` : `${input.orgId}:agent:${input.agentId}`
    const now = new Date(this.now())
    const open = await this.store.getActiveTarget(input.orgId, targetKey)
    if (open) {
      if (!timedOut(open, now)) return this.reuseOrConflict(open, input.createdByUserId)
      await this.store.settle(input.orgId, open.id, { status: 'failed', failureReason: 'expired' }, now)
    }
    const code = await this.client.newQrCode()
    try {
      const row = await this.store.create({
        id: randomUUID(),
        targetKey,
        orgId: input.orgId,
        agentId: input.agentId,
        ...(input.botId ? { botId: input.botId } : {}),
        ...(input.requestedName ? { requestedName: input.requestedName } : {}),
        createdByUserId: input.createdByUserId,
        qrcode: code.qrcode,
        qrUrl: code.qrUrl,
        pollHost: this.apiUrl,
        expiresAt: new Date(now.getTime() + WECHAT_QR_TTL_MS)
      })
      return snapshot(row)
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error
      const winner = await this.store.getActiveTarget(input.orgId, targetKey)
      if (!winner) throw error
      return this.reuseOrConflict(winner, input.createdByUserId)
    }
  }

  /** One poll: a single iLink status call, or a retried install of a confirmed login; null unless `userId` started it. */
  async poll(
    orgId: OrgId,
    userId: string,
    id: string,
    finalize: WeChatFinalize,
    verifyCode?: string
  ): Promise<WeChatLoginSnapshot | null> {
    const row = await this.store.get(orgId, id)
    if (!row || row.createdByUserId !== userId) return null
    if (row.status === 'completed' || row.status === 'failed') return snapshot(row)
    const now = new Date(this.now())
    // An unscanned code past its deadline still gets one status call, so a scan that landed at the deadline counts.
    if (row.status !== 'waiting' && timedOut(row, now)) {
      await this.store.settle(orgId, id, { status: 'failed', failureReason: 'expired' }, now)
      return this.reread(orgId, row)
    }
    if (row.status !== 'authorized') {
      const confirmed = await this.check(row, verifyCode)
      if (!confirmed) {
        const after = await this.store.get(orgId, id)
        if (after?.status === 'waiting' && timedOut(after, new Date(this.now()))) {
          await this.store.settle(orgId, id, { status: 'failed', failureReason: 'expired' }, new Date(this.now()))
        }
        return this.reread(orgId, row)
      }
    }
    return this.install(orgId, id, finalize)
  }

  // Forward one status call; true once the login is confirmed and its token kept.
  private async check(row: WechatPendingLoginRecord, verifyCode?: string): Promise<boolean> {
    if (!row.qrcode) {
      await this.store.settle(
        row.orgId,
        row.id,
        { status: 'failed', failureReason: 'setup_failed' },
        new Date(this.now())
      )
      return false
    }
    let result
    try {
      result = await this.client.status(row.pollHost, row.qrcode, verifyCode)
    } catch {
      return false
    }
    switch (result.status) {
      case 'wait':
        // Nothing moved; a scan or a verification prompt already seen stays as it is.
        return false
      case 'scaned':
        await this.store.advance(row.orgId, row.id, { status: 'scanned' })
        return false
      case 'scaned_but_redirect': {
        const pollHost = weChatPollHost(result.redirectHost)
        await this.store.advance(row.orgId, row.id, { status: 'scanned', ...(pollHost ? { pollHost } : {}) })
        return false
      }
      case 'need_verifycode':
        await this.store.advance(row.orgId, row.id, { status: 'verify_code' })
        return false
      case 'expired':
        // The member asks for a fresh code from the Console, which starts a new login.
        await this.store.settle(row.orgId, row.id, { status: 'failed', failureReason: 'expired' }, new Date(this.now()))
        return false
      case 'verify_code_blocked':
        await this.store.settle(
          row.orgId,
          row.id,
          { status: 'failed', failureReason: 'verify_code_blocked' },
          new Date(this.now())
        )
        return false
      case 'binded_redirect':
        await this.store.settle(
          row.orgId,
          row.id,
          { status: 'failed', failureReason: 'setup_failed' },
          new Date(this.now())
        )
        return false
      case 'confirmed':
        await this.store.authorize(row.orgId, row.id, {
          botToken: result.botToken,
          ilinkBotId: result.ilinkBotId,
          ilinkUserId: result.ilinkUserId,
          baseUrl: result.baseUrl
        })
        return true
      default:
        return false
    }
  }

  private async install(orgId: OrgId, id: string, finalize: WeChatFinalize): Promise<WeChatLoginSnapshot | null> {
    const row = await this.store.get(orgId, id)
    if (!row) return null
    if (row.status !== 'authorized') return snapshot(row)
    if (!row.botToken || !row.ilinkBotId || !row.ilinkUserId) {
      await this.store.settle(orgId, id, { status: 'failed', failureReason: 'setup_failed' }, new Date(this.now()))
      return this.reread(orgId, row)
    }
    // A second tab's overlapping poll finds the claim taken and reports the login as still pending.
    const token = randomUUID()
    const now = this.now()
    if (!(await this.store.claim(orgId, id, token, new Date(now), new Date(now + WECHAT_INSTALL_CLAIM_MS)))) {
      return this.reread(orgId, row)
    }
    let installed
    try {
      installed = await finalize({
        id: row.id,
        orgId,
        agentId: row.agentId,
        botId: row.botId,
        requestedName: row.requestedName,
        createdByUserId: row.createdByUserId,
        botToken: row.botToken,
        ilinkBotId: row.ilinkBotId,
        ilinkUserId: row.ilinkUserId,
        baseUrl: row.baseUrl
      })
    } catch (error) {
      if (error instanceof WeChatLoginSetupError) {
        await this.store.settle(orgId, id, { status: 'failed', failureReason: error.reason }, new Date(this.now()))
      } else {
        await this.store.release(orgId, id, token)
      }
      return this.reread(orgId, row)
    }
    await this.store.settle(orgId, id, { status: 'completed', ...installed }, new Date(this.now()))
    return this.reread(orgId, row)
  }

  private async reread(orgId: OrgId, fallback: WechatPendingLoginRecord): Promise<WeChatLoginSnapshot> {
    return snapshot((await this.store.get(orgId, fallback.id)) ?? fallback)
  }

  private reuseOrConflict(open: WechatPendingLoginRecord, createdByUserId: string): WeChatLoginSnapshot {
    if (open.createdByUserId !== createdByUserId) throw new WeChatLoginConflictError()
    return snapshot(open)
  }
}
