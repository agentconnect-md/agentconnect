import { isCodeHostProvider } from '@agentconnect.md/protocol'
import type { SessionRecord } from '../store/local-store.js'
import type { CodeHostReplyTarget } from '../codehost/reply-target.js'
import { wakeThreadFields, type NormalizedMessage } from '../messages/normalized.js'
import { isCoordinatorCoordinate } from './append-coordinate.js'

export interface SessionReplyRoute {
  integrationId?: string
  codeHostReply?: CodeHostReplyTarget
}

function isCodeHostSession(session: SessionRecord): boolean {
  return session.platform === 'hook' && isCodeHostProvider(session.transportScope?.split(':', 1)[0])
}

/** Snapshot only this turn's output, including an explicit private route for Console continuations. */
export function codeHostReplySnapshot(
  session: SessionRecord | undefined,
  target: CodeHostReplyTarget | undefined
): CodeHostReplyTarget | null | undefined {
  return session && isCodeHostSession(session) ? structuredClone(target ?? null) : undefined
}

/** Resolve chat transport independently from identity; code-host returns require their origin snapshot. */
export function sessionReplyRoute(
  session: SessionRecord,
  integrationForSession: (agentId: string, platform: string, scope?: string | null) => string | undefined,
  codeHostReply?: CodeHostReplyTarget | null
): SessionReplyRoute | undefined {
  if (isCodeHostSession(session)) return codeHostReply ? { codeHostReply } : {}
  const integrationId = integrationForSession(session.agentId, session.platform, session.transportScope)
  if (session.transportScope && !integrationId) return undefined
  return integrationId ? { integrationId } : {}
}

/** A saved delivery target never changes the session a continuation belongs to. */
export function sessionWakeFields(
  session: SessionRecord,
  target?: { replyChannel?: string | null; replyThread?: string | null }
): Pick<NormalizedMessage, 'channel' | 'thread' | 'sessionChannel' | 'sessionThread' | 'isDm' | 'isGroupDm'> {
  // A coordinator's turns answer many threads, so its latest one says nothing about a wake with no target: that lands at the root.
  const latest = isCoordinatorCoordinate(session.thread) ? undefined : session
  const channel = target?.replyChannel ?? latest?.replyChannel ?? session.channel
  const thread = target?.replyChannel != null ? target.replyThread : latest?.replyThread
  const sameChannel = channel === session.channel
  return {
    channel,
    ...wakeThreadFields(session.thread, thread ?? undefined),
    ...(thread === null && (target?.replyChannel != null || latest?.replyChannel != null)
      ? { thread: undefined, sessionThread: session.thread }
      : {}),
    ...(!sameChannel ? { sessionChannel: session.channel, sessionThread: session.thread } : {}),
    isDm: sameChannel && session.conversationKind === 'dm',
    ...(sameChannel && session.conversationKind === 'group_dm' ? { isGroupDm: true } : {})
  }
}
