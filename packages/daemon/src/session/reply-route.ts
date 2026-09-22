import { isCodeHostProvider } from '@agentconnect.md/protocol'
import type { SessionRecord } from '../store/local-store.js'
import type { CodeHostReplyTarget } from '../codehost/reply-target.js'

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
