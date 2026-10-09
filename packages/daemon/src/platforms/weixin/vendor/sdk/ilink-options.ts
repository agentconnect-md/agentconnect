import type { ClawbotContextTokenStore } from '../context-token-store.js'
import type { CredentialBlob, PollingOptions, SessionStore } from './protocol/chat-event.js'

export type OutboundTextFormat = 'plain' | 'markdown'

export interface IlinkBotOptions {
  session?: Partial<CredentialBlob> | null
  sessionStore?: SessionStore | string
  token?: string
  accountId?: string
  baseUrl?: string
  cdnBaseUrl?: string
  routeTag?: string
  polling?: boolean | PollingOptions
  /** 出站文本格式；plain 去除 Markdown 标记但保留换行，markdown 原样透传。 */
  outboundTextFormat?: OutboundTextFormat
  /** context_token 由宿主统一存储时注入；SDK 不再把它写入会话 JSON。 */
  contextTokenStore?: ClawbotContextTokenStore
  /** 宿主中的稳定账号键，与 contextTokenStore 成对使用。 */
  contextTokenAccountKey?: string
}

/** 清除会话凭证时对 context_token 的处理方式。 */
export interface ClearSessionOptions {
  /** 无宿主存储时保留内存中的 context_token，以便扫码重登后继续回复。 */
  preserveContextTokens?: boolean
}
