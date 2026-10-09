import { GatewayFault } from './internal/errors.js'
import { TypingPhase } from './protocol/wire-models.js'
import type { IlinkJsonTransport } from './transport/ilink-json-transport.js'

const TYPING_TICKET_TTL_MS = 24 * 60 * 60_000

/** 管理按会话隔离的 typing ticket、24 小时 TTL 与失效后单次刷新。 */
export class IlinkTypingRuntime {
  private readonly tickets = new Map<string, { ticket: string; expiresAt: number }>()

  constructor(private readonly transport: IlinkJsonTransport) {}

  clear(): void {
    this.tickets.clear()
  }

  async send(chatId: string, contextToken: string, status: 'active' | 'idle'): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ticket = await this.getTicket(chatId, contextToken)
      try {
        await this.transport.signalTypingState({
          ilink_user_id: chatId,
          typing_ticket: ticket,
          status: status === 'idle' ? TypingPhase.Idle : TypingPhase.Active
        })
        return
      } catch (error) {
        this.tickets.delete(chatId)
        if (!(error instanceof GatewayFault) || error.code !== 'API_ERROR' || attempt > 0) {
          throw error
        }
      }
    }
    throw new GatewayFault('TYPING_FAILED', `发送输入状态失败：${chatId}`)
  }

  private async getTicket(chatId: string, contextToken: string): Promise<string> {
    const cached = this.tickets.get(chatId)
    if (cached && cached.expiresAt > Date.now()) return cached.ticket
    this.tickets.delete(chatId)
    const config = await this.transport.loadPeerTypingConfig({
      ilinkUserId: chatId,
      contextToken
    })
    if (!config.typing_ticket) {
      throw new GatewayFault('TYPING_TICKET_UNAVAILABLE', `未拿到 typing_ticket：${chatId}`)
    }
    this.tickets.set(chatId, {
      ticket: config.typing_ticket,
      expiresAt: Date.now() + TYPING_TICKET_TTL_MS
    })
    return config.typing_ticket
  }
}
