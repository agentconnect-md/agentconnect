import type { EventEmitter } from 'node:events'
import type { IlinkBotEvents, IlinkInboundEventName } from './ilink-events.js'
import type { NormalizedChatEvent } from './protocol/chat-event.js'
import type { OnTextListener } from './protocol/chat-event.js'
import { mapInboundWirePacket } from './protocol/inbound-mapper.js'
import { GatewayFault } from './internal/errors.js'
import { AuthorKind, type InboundWirePacket } from './protocol/wire-models.js'

export interface RegexBinding {
  pattern: RegExp
  listener: OnTextListener
}

/** SDK 边界只接受可定位、可回复的真实私聊消息，避免污染上下文与媒体缓存。 */
export function assertInboundWirePacket(value: unknown): asserts value is InboundWirePacket {
  if (!value || typeof value !== 'object') {
    throw new GatewayFault('INVALID_EVENT', 'iLink 事件必须是对象')
  }
  const event = value as Record<string, unknown>
  if (event.message_type !== AuthorKind.Human && event.message_type !== AuthorKind.Bot) {
    throw new GatewayFault('INVALID_EVENT', 'iLink 事件 message_type 必须是 USER 或 BOT')
  }
  if (
    event.message_type === AuthorKind.Human &&
    (typeof event.from_user_id !== 'string' || !event.from_user_id.trim())
  ) {
    throw new GatewayFault('INVALID_EVENT', 'iLink 用户事件缺少 from_user_id')
  }
  const hasNumericId =
    (typeof event.message_id === 'number' && Number.isFinite(event.message_id)) ||
    (typeof event.seq === 'number' && Number.isFinite(event.seq))
  const hasClientId = typeof event.client_id === 'string' && Boolean(event.client_id.trim())
  if (!hasNumericId && !hasClientId) {
    throw new GatewayFault('INVALID_EVENT', 'iLink 事件缺少 message_id、seq 或 client_id')
  }
  if (event.item_list !== undefined && !Array.isArray(event.item_list)) {
    throw new GatewayFault('INVALID_EVENT', 'iLink 事件 item_list 必须是数组')
  }
  if (
    Array.isArray(event.item_list) &&
    event.item_list.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new GatewayFault('INVALID_EVENT', 'iLink 事件 item_list 只能包含对象')
  }
  if (event.group_id !== undefined && (typeof event.group_id !== 'string' || !event.group_id.trim())) {
    throw new GatewayFault('INVALID_EVENT', 'iLink 事件 group_id 必须是非空字符串')
  }
  if (event.context_token !== undefined && typeof event.context_token !== 'string') {
    throw new GatewayFault('INVALID_EVENT', 'iLink 事件 context_token 必须是字符串')
  }
}

/**
 * 生成一条入站事件在当前机器人会话内稳定的投递键。
 *
 * iLink 在不同消息形态下可能只提供 message_id、seq 或 client_id 之一；优先采用
 * 服务端标识，并把发送方纳入键空间，避免不同会话之间的局部序号相互碰撞。
 */
export function inboundEventKey(event: InboundWirePacket): string {
  const sender = event.from_user_id ?? 'unknown'
  if (typeof event.message_id === 'number') return `message:${sender}:${event.message_id}`
  if (typeof event.seq === 'number') return `sequence:${sender}:${event.seq}`
  if (typeof event.client_id === 'string') return `client:${sender}:${event.client_id}`
  throw new GatewayFault('INVALID_EVENT', '入站事件缺少可用于确认投递的标识')
}

/** 维护有界事件缓存，供媒体下载动作按 message_id 定位原始句柄。 */
export function rememberRecentMessage(cache: Map<string, NormalizedChatEvent>, event: NormalizedChatEvent): void {
  const messageId = String(event.id ?? event.seq ?? '')
  if (!messageId) return
  cache.set(messageId, event)
  if (cache.size <= 256) return
  const oldest = cache.keys().next().value
  if (oldest) cache.delete(oldest)
}

export function resolveRecentMedia(
  cache: ReadonlyMap<string, NormalizedChatEvent>,
  messageId: string,
  itemIndex?: number
): NormalizedChatEvent {
  const message = cache.get(messageId)
  if (!message) throw new GatewayFault('MESSAGE_NOT_CACHED', `最近事件缓存中不存在消息 ${messageId}`)
  if (itemIndex === undefined) return message
  const item = message.raw.item_list?.[itemIndex]
  if (!item) throw new GatewayFault('MESSAGE_ITEM_NOT_FOUND', `消息 ${messageId} 不存在 item ${itemIndex}`)
  return mapInboundWirePacket({ ...message.raw, item_list: [item] })
}

/** 逐个等待 canonical 监听器；失败会报告诊断事件并阻止上游确认。 */
export async function emitInbound(
  emitter: EventEmitter<IlinkBotEvents>,
  eventName: IlinkInboundEventName,
  event: NormalizedChatEvent
): Promise<void> {
  for (const listener of emitter.rawListeners(eventName)) {
    try {
      await Reflect.apply(listener, emitter, [event])
    } catch (error) {
      reportListenerError(emitter, eventName, error)
      throw new GatewayFault('EVENT_DELIVERY_FAILED', 'iLink 事件监听器执行失败', {
        operation: eventName,
        cause: error
      })
    }
  }
}

export function reportListenerError(emitter: EventEmitter<IlinkBotEvents>, eventName: string, error: unknown): void {
  try {
    emitter.emit('listener_error', { event: eventName, error })
  } catch {
    // listener_error 本身不得再次破坏消息接收；宿主应注册可靠的日志监听器。
  }
}

export async function runTextBindings(
  emitter: EventEmitter<IlinkBotEvents>,
  bindings: readonly RegexBinding[],
  event: NormalizedChatEvent
): Promise<void> {
  if (!event.text) return
  for (const { pattern, listener } of bindings) {
    const match = pattern.exec(event.text)
    pattern.lastIndex = 0
    if (!match) continue
    try {
      await listener(event, match)
    } catch (error) {
      reportListenerError(emitter, 'text_match', error)
      throw new GatewayFault('EVENT_DELIVERY_FAILED', 'iLink 文本绑定执行失败', {
        operation: 'text_match',
        cause: error
      })
    }
  }
}
