/**
 * Where one code-host delivery's ordinary end-of-turn reply goes
 * (gitlab-com-integration.md §14.1, §6.5).
 *
 * The coordinates are shared because the durable hook row carries them: a delivery admitted
 * before a restart is replayed from exactly these fields, so the names stay stable and each
 * provider says what it means by them. `provider` is the discriminator every turn-final
 * member resolves on.
 */
import type { CodeHostProvider } from '@agentconnect.md/protocol'

export interface CodeHostReplyTarget {
  hookId: string
  /** The code host whose coordinates these are, and which owns this turn's one public reply. */
  provider: CodeHostProvider
  /** GitLab names its subject (§14.1); GitHub reads the kind off its own trusted metadata. */
  subjectKind?: 'issue' | 'merge_request'
  /** GitHub: `owner/repo`. GitLab: the numeric project id — both are what the effect lease is scoped to. */
  repo: string
  /** GitHub: the issue/pull-request number. GitLab: the subject IID. */
  number: number
  /** The review-comment delivery that triggered this turn (diagnostic identity). */
  reviewCommentId?: string
  /** The comment that FIRED this turn, as the acknowledgement reaction targets it. Absent ⇒
   *  the subject itself fired, so the subject is what carries the reaction. Distinct from
   *  `reviewThreadRootCommentId`, which names where the ANSWER goes: a reply lands on the
   *  thread root, while the acknowledgement belongs on the exact comment a human wrote. */
  triggerComment?: { kind: 'issue_comment' | 'review_comment' | 'note'; id: string }
  /** Stable root of the GitHub inline-review thread; replies must target this id. */
  reviewThreadRootCommentId?: string
}

/** The provider a target names. A row persisted before the member became explicit named GitHub, and a replay must still reach its poster. */
export function replyTargetProvider(target: Pick<CodeHostReplyTarget, 'provider'>): CodeHostProvider {
  return target.provider ?? 'github'
}
