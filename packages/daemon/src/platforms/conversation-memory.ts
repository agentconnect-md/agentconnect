// What a connection remembers about the conversations it reaches, kept in the daemon's store so a restart does not forget them.
import type { LocalStore } from '../store/local-store.js'

/** One connection's durable conversation facts: opaque JSON the platform module owns, never message content. */
export interface ConversationMemory {
  /** Every remembered conversation, most recently updated first. */
  load(): Promise<{ id: string; facts: unknown }[]>
  /** Remember (or refresh) one conversation's facts; the oldest beyond the bound are forgotten. */
  save(id: string, facts: unknown): Promise<void>
}

/** A connection's memory in the daemon's store, under `scope` (one bot identity), at most `max` conversations. */
export function storeConversationMemory(
  store: Pick<LocalStore, 'connectionConversations' | 'saveConnectionConversation'>,
  scope: string,
  max: number,
  now: () => number = Date.now
): ConversationMemory {
  return {
    load: async () =>
      (await store.connectionConversations(scope, max)).flatMap(({ id, facts }) => {
        try {
          return [{ id, facts: JSON.parse(facts) as unknown }]
        } catch {
          return []
        }
      }),
    save: async (id, facts) => await store.saveConnectionConversation(scope, id, JSON.stringify(facts), now(), max)
  }
}
