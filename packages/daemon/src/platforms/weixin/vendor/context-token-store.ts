/**
 * iLink context_token store contract (vendored from lc-cn/onebots adapter
 * `context-token-store.ts`, trimmed: the upstream `ensure*Table` helper bound a
 * onebots SqliteDB, which does not exist here — AgentConnect supplies its own store impl).
 */
export const WECHAT_CLAWBOT_CONTEXT_TOKEN_TABLE = 'wechat_clawbot_context_token'

/** Read/write context_token per (accountKey, peerId). */
export interface ClawbotContextTokenStore {
  get(accountKey: string, ilinkBotId: string, peerId: string): string | undefined
  set(accountKey: string, ilinkBotId: string, peerId: string, token: string): void
}
