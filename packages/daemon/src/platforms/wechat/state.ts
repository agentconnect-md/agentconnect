// What a WeChat bot keeps across restarts: the poll cursor and the latest reply token, never message content (wechat-integration.md §3.3, §4.5).

export interface WeChatBotState {
  cursor?: string
  contextToken?: string
}

/** The daemon store's slice the connection reads and writes, keyed by `ilink_bot_id`. */
export interface WeChatStatePort {
  load(botId: string): Promise<WeChatBotState>
  saveCursor(botId: string, cursor: string): Promise<void>
  saveContextToken(botId: string, token: string): Promise<void>
}

/** The port over the daemon's local store. */
export function weChatStateStore(store: {
  getWeChatBotState(botId: string): Promise<WeChatBotState>
  setWeChatPollCursor(botId: string, cursor: string): Promise<void>
  setWeChatContextToken(botId: string, token: string): Promise<void>
}): WeChatStatePort {
  return {
    load: (botId) => store.getWeChatBotState(botId),
    saveCursor: (botId, cursor) => store.setWeChatPollCursor(botId, cursor),
    saveContextToken: (botId, token) => store.setWeChatContextToken(botId, token)
  }
}

/** A process-local port, for a daemon without a store and for tests. */
export function memoryWeChatState(): WeChatStatePort & { readonly rows: Map<string, WeChatBotState> } {
  const rows = new Map<string, WeChatBotState>()
  return {
    rows,
    load: async (botId) => ({ ...rows.get(botId) }),
    saveCursor: async (botId, cursor) => void rows.set(botId, { ...rows.get(botId), cursor }),
    saveContextToken: async (botId, contextToken) => void rows.set(botId, { ...rows.get(botId), contextToken })
  }
}
