// The task a coordinator's post links to (auto-session-mode.md §10), as the daemon marks the post: the console draws it as a card.

import { TaskLinkFacts } from '@agentconnect.md/protocol/user-turn-body'

export type TaskLink = TaskLinkFacts

/** The task a recorded post's body names, or null for any other row; a malformed mark leaves the row as text. */
export function taskLinkOfBody(body: string | undefined): TaskLink | null {
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const facts = TaskLinkFacts.safeParse((parsed as { taskLink?: unknown }).taskLink)
  return facts.success ? facts.data : null
}
