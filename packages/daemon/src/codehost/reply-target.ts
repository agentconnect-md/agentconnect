import type { CodeHostProvider, CodeHostReplyTarget as WireReplyTarget } from '@agentconnect.md/protocol'

/** Locally supported ordinary output coordinates, captured from trusted ingress. */
export type CodeHostReplyTarget = Omit<WireReplyTarget, 'provider'> & { provider: CodeHostProvider }

/** The provider a target names. A row persisted before the member became explicit named GitHub, and a replay must still reach its poster. */
export function replyTargetProvider(target: Pick<CodeHostReplyTarget, 'provider'>): CodeHostProvider {
  return target.provider ?? 'github'
}
