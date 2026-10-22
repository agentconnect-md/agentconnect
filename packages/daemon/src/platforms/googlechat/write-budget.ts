// The per-app write budget (google-chat-integration.md §10.8): one token bucket per Chat app on this daemon, under the per-Space queue.
import type { WriteBudgetSettings } from '../write-budget.js'

// The shared bucket, one per Chat app keyed by its project number, since Google's quota is per project.
export { WriteBudget as GoogleChatWriteBudget, WriteBudgets as GoogleChatWriteBudgets } from '../write-budget.js'

/** Google's project-wide quota: message writes per minute, shared by every organization on one published app. */
export const GOOGLE_CHAT_PROJECT_WRITES_PER_MINUTE = 3_000

/** How many daemons share one app's project quota when nothing says otherwise. */
export const GOOGLE_CHAT_DEFAULT_POOL_SIZE = 4

export type GoogleChatWriteBudgetSettings = WriteBudgetSettings

/** The daemon's `googleChat` config as the budget reads it: the pool size derives the refill, and either knob may override. */
export function googleChatWriteBudgetSettings(
  config: { poolSize?: number; writesPerMinute?: number; writeBurst?: number } = {}
): GoogleChatWriteBudgetSettings {
  const poolSize = Math.max(1, Math.floor(config.poolSize ?? GOOGLE_CHAT_DEFAULT_POOL_SIZE))
  const refillPerMinute = Math.max(
    1,
    config.writesPerMinute ?? Math.floor(GOOGLE_CHAT_PROJECT_WRITES_PER_MINUTE / poolSize)
  )
  return { capacity: Math.max(1, config.writeBurst ?? refillPerMinute), refillPerMinute }
}
