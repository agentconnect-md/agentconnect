'use client'

import useSWR from 'swr'
import { fetchSessionMessages, type SessionMessageDto, type SessionThreadSummaryDto } from '@/lib/api'
import { MOCK_MODE, type Session } from '@/lib/data'

// ponytail: one newest page per visible row; a daemon-side "last reply" read replaces this if Home's fan-out gets heavy.
const TAIL_LIMIT = 20
const EXCERPT_CHARS = 200

/** One line of plain text from a markdown reply: fences dropped, markers stripped, whitespace collapsed. */
export function replyExcerpt(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/[*`]/g, '')
    .replace(/^\s*(#+|>|[-+] )\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXCERPT_CHARS)
}

/** The newest non-empty reply one of `agentIds` authored, on the timeline or in a thread it answers in, as an excerpt; null when the page holds none. */
export function lastAgentReply(
  messages: SessionMessageDto[],
  agentIds: ReadonlySet<string>,
  threads: SessionThreadSummaryDto[] = []
): string | null {
  const replies = [
    ...messages
      .filter((m) => m.kind.toLowerCase() === 'text' && agentIds.has(m.sender))
      .map((m) => ({ at: Date.parse(m.ts), seq: m.seq, text: m.text })),
    // A coordinator's answer lands in the thread of the task it handed the work to, not on its own timeline.
    ...threads
      .filter((t) => t.lastReply?.excerpt && agentIds.has(t.lastReply.sender))
      .map((t) => ({ at: Date.parse(t.lastReplyAt ?? ''), seq: 0, text: t.lastReply!.excerpt! }))
  ].sort((a, b) => (b.at || 0) - (a.at || 0) || b.seq - a.seq)
  for (const reply of replies) {
    const excerpt = replyExcerpt(reply.text)
    if (excerpt) return excerpt
  }
  return null
}

/** The agent's last reply in `session`, proxied from its daemon and never stored; null while loading, offline or purged. */
export function useLastReply(session: Session, enabled: boolean): string | null {
  const agentIds = [session.agentId, ...(session.participants ?? []).map((p) => p.agentId)].filter(
    (id): id is string => !!id
  )
  const { data } = useSWR(
    enabled && !MOCK_MODE && agentIds.length > 0
      ? // ponytail: a task's reply does not move the coordinator's own stamp, so `unread` is what re-reads it; the CP's effective activity on the row if that ever misses.
        ['session-last-reply', session.id, session.lastActivityAt ?? '', agentIds.join(','), !!session.unread]
      : null,
    () =>
      fetchSessionMessages(session.id, {
        limit: TAIL_LIMIT,
        ...(session.coordinator ? { view: 'roots' as const } : {})
      })
        .then((page) => lastAgentReply(page.messages, new Set(agentIds), page.threads))
        .catch(() => null),
    { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false, keepPreviousData: true }
  )
  // Mock rows carry their transcript inline, so the preview draws the same line without a daemon.
  if (MOCK_MODE && enabled) {
    const done = [...session.steps].reverse().find((step) => step.kind === 'done' && !!step.text)
    return done?.text ? replyExcerpt(done.text) : null
  }
  return data ?? null
}
