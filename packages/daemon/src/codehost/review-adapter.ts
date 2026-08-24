/**
 * The daemon's formal-review contract member (gitlab-com-integration.md §6.5, §15).
 *
 * `submitCodeReview` is provider-routed: core computes the logical session key and
 * hands the call to whichever registered adapter owns that key's active review
 * turn. No provider name is compared outside a registry entry, so adding a code
 * host is registering one more adapter — GitHub's is the existing review
 * orchestrator, GitLab's is the §15 thirteen-step adapter.
 */
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import { sessionKey } from '../store/local-store.js'

export type CodeReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'
export type CodeReviewVerdict = 'pass' | 'fail' | 'neutral'

export interface CodeReviewInlineComment {
  path: string
  body: string
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
}

/** The §15 common input schema — unchanged from `submitGithubReview`. */
export interface CodeReviewInput {
  event: CodeReviewEvent
  verdict: CodeReviewVerdict
  body: string
  comments?: CodeReviewInlineComment[]
}

/** One review request with its caller identity filled from the trusted MCP SessionContext. */
export interface SubmitCodeReviewReq extends CodeReviewInput {
  agentId: string
  platform: string
  channel: string
  thread: string
  transportScope?: string
}

/** One provider's publication steps behind the seam. */
export interface CodeHostReviewAdapter {
  readonly provider: CodeHostProvider
  /** True only when THIS provider owns the active review turn for that logical session key. */
  owns(key: string, agentId: string): boolean
  submit(key: string, req: SubmitCodeReviewReq): Promise<unknown>
}

export const NO_ACTIVE_REVIEW_TURN =
  'a formal code review is only available during an authorized active pull/merge request hook turn'

/** `REQUEST_CHANGES` requires `fail` and `APPROVE` requires `pass` (§15). */
export function codeReviewVerdictMatches(event: CodeReviewEvent, verdict: CodeReviewVerdict): boolean {
  if (event === 'APPROVE') return verdict === 'pass'
  if (event === 'REQUEST_CHANGES') return verdict === 'fail'
  return true
}

/** Shared pre-effect validation: an incompatible pair or an unusable body never reaches a provider. */
export function validateCodeReviewInput(input: CodeReviewInput): string | undefined {
  if (!codeReviewVerdictMatches(input.event, input.verdict)) {
    return input.event === 'APPROVE' ? 'APPROVE requires verdict=pass' : 'REQUEST_CHANGES requires verdict=fail'
  }
  if (!input.body.trim()) return `${input.event} requires a non-empty body`
  for (const [index, comment] of (input.comments ?? []).entries()) {
    if (!comment.path.trim()) return `comments[${index}].path is required`
    if (!comment.body.trim()) return `comments[${index}].body is required`
    if (!Number.isInteger(comment.line) || comment.line <= 0) return `comments[${index}].line must be positive`
    if (comment.startLine !== undefined) {
      if (!Number.isInteger(comment.startLine) || comment.startLine <= 0 || comment.startLine > comment.line) {
        return `comments[${index}].startLine must be positive and no greater than line`
      }
      if (!comment.startSide) return `comments[${index}].startSide is required with startLine`
    }
  }
  return undefined
}

/** The one dispatch point core knows; registration order is resolution order. */
export class CodeHostReviewRouter {
  private readonly adapters: CodeHostReviewAdapter[] = []

  register(adapter: CodeHostReviewAdapter): void {
    this.adapters.push(adapter)
  }

  submit(req: SubmitCodeReviewReq): Promise<unknown> {
    const key = sessionKey(req.platform, req.channel, req.thread, req.agentId, req.transportScope)
    const adapter = this.adapters.find((candidate) => candidate.owns(key, req.agentId))
    if (!adapter) return Promise.reject(new Error(NO_ACTIVE_REVIEW_TURN))
    return adapter.submit(key, req)
  }
}
