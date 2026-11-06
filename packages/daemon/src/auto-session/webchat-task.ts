// A task of a member's webchat coordinator, recognized by the task index rather than its coordinate (webchat-threads.md §5.4).
import { isDelegatedTaskCoordinate } from '@agentconnect.md/protocol'
import { isAppendCoordinate } from '../session/append-coordinate.js'
import { isSubsessionCoordinate } from '../session/subsession-coordinate.js'
import type { AssistantSubsessionIndex } from '../store/assistant-subsessions.js'

/** The index reads the recognition needs, so a caller's narrow store fake satisfies it. */
export interface WebchatTaskStore {
  assistantSubsessions: Pick<AssistantSubsessionIndex, 'get' | 'threadsOf'>
}

/** What a webchat coordinator's task is known by: the coordinator it belongs to, and whether it is a legacy page task. */
export interface WebchatCoordinatorTask {
  /** The coordinator session's outward id, the parent the task reports. */
  parentSessionId: string
  parentSessionKey: string
  /** A legacy page task on a `subsession:` coordinate (auto-session-mode.md §10), not one keyed on its thread. */
  page: boolean
}

/** The coordinator `key` is a live webchat task of: a work row holding a webchat thread, which only a coordinator opens; undefined for any other session. */
export async function webchatCoordinatorTask(
  store: WebchatTaskStore,
  agentId: string,
  key: string,
  thread: string
): Promise<WebchatCoordinatorTask | undefined> {
  // A conversation's own coordinate, a follow-up's check, an approved proposal and research are never a coordinator's task.
  if (isAppendCoordinate(thread) || (isSubsessionCoordinate(thread) && !isDelegatedTaskCoordinate(thread)))
    return undefined
  const index = store.assistantSubsessions
  const row = await index.get(agentId, key)
  if (row === undefined || row.mode === 'watch') return undefined
  const threads = await index.threadsOf(agentId, key)
  if (!threads.some((held) => held.platform === 'webchat')) return undefined
  return {
    parentSessionId: row.parentSessionId,
    parentSessionKey: row.parentSessionKey,
    page: isSubsessionCoordinate(thread)
  }
}
