// What a WeChat bot keeps across restarts: the poll cursor, the latest reply token, and recent message texts for quotes (§3.3, §4.3, §4.5).

/** Recent message texts kept per bot, so a quote naming an older one finds nothing rather than growing without bound. */
export const WECHAT_MESSAGE_RECORD_LIMIT = 2000

export interface WeChatBotState {
  cursor?: string
  contextToken?: string
}

/** The daemon store's slice the connection reads and writes, keyed by `ilink_bot_id`. */
export interface WeChatStatePort {
  load(botId: string): Promise<WeChatBotState>
  saveCursor(botId: string, cursor: string): Promise<void>
  saveContextToken(botId: string, token: string): Promise<void>
  rememberMessage(botId: string, messageId: string, text: string): Promise<void>
  messageText(botId: string, messageId: string): Promise<string | undefined>
}

/** The port over the daemon's local store. */
export function weChatStateStore(store: {
  getWeChatBotState(botId: string): Promise<WeChatBotState>
  setWeChatPollCursor(botId: string, cursor: string): Promise<void>
  setWeChatContextToken(botId: string, token: string): Promise<void>
  rememberWeChatMessage(botId: string, messageId: string, text: string, keep: number): Promise<void>
  getWeChatMessageText(botId: string, messageId: string): Promise<string | undefined>
}): WeChatStatePort {
  return {
    load: (botId) => store.getWeChatBotState(botId),
    saveCursor: (botId, cursor) => store.setWeChatPollCursor(botId, cursor),
    saveContextToken: (botId, token) => store.setWeChatContextToken(botId, token),
    rememberMessage: (botId, messageId, text) =>
      store.rememberWeChatMessage(botId, messageId, text, WECHAT_MESSAGE_RECORD_LIMIT),
    messageText: (botId, messageId) => store.getWeChatMessageText(botId, messageId)
  }
}

/** A process-local port, for a daemon without a store and for tests. */
export function memoryWeChatState(): WeChatStatePort & {
  readonly rows: Map<string, WeChatBotState>
  readonly messages: Map<string, string>
} {
  const rows = new Map<string, WeChatBotState>()
  const messages = new Map<string, string>()
  return {
    rows,
    messages,
    load: async (botId) => ({ ...rows.get(botId) }),
    saveCursor: async (botId, cursor) => void rows.set(botId, { ...rows.get(botId), cursor }),
    saveContextToken: async (botId, contextToken) => void rows.set(botId, { ...rows.get(botId), contextToken }),
    rememberMessage: async (botId, messageId, text) => {
      const key = `${botId}:${messageId}`
      if (!messages.has(key)) messages.set(key, text)
      while (messages.size > WECHAT_MESSAGE_RECORD_LIMIT) messages.delete(messages.keys().next().value!)
    },
    messageText: async (botId, messageId) => messages.get(`${botId}:${messageId}`)
  }
}
