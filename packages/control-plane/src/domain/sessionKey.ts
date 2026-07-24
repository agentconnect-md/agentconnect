/**
 * `SessionKey` + its canonical string form (design §2 `domain/sessionKey.ts`).
 *
 * A session is keyed by `(platform, channel, thread?)`. `thread` absent means
 * the channel root. The canonical string `${platform}:${channel}:${thread ?? "-"}`
 * is the in-memory map key used everywhere a `SessionKey` is indexed
 * (ConnectionRegistry). The PERSISTENCE layer keys on the
 * `threadKey` generated column (`COALESCE(thread,'')`) instead — see §3.7.
 */
import type { Platform } from '@agentconnect.md/protocol'

export interface SessionKey {
  platform: Platform
  channel: string
  thread?: string
}

/** Canonical, collision-free string for indexing a SessionKey in a Map/Set. */
export function sessionKeyStr(key: SessionKey): string {
  return `${key.platform}:${key.channel}:${key.thread ?? '-'}`
}

/** Parse a canonical string back into a SessionKey (inverse of `sessionKeyStr`). */
export function parseSessionKey(s: string): SessionKey {
  const first = s.indexOf(':')
  const last = s.lastIndexOf(':')
  const platform = s.slice(0, first) as Platform
  const channel = s.slice(first + 1, last)
  const threadPart = s.slice(last + 1)
  return {
    platform,
    channel,
    ...(threadPart === '-' ? {} : { thread: threadPart })
  }
}
