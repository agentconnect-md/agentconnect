/**
 * Structured GitHub pull-request review client (R1).
 *
 * The target is daemon-trusted metadata plus a one-action purpose token minted
 * by the control plane. The model supplies only the semantic review payload;
 * it can never choose the repository, pull number, or commit. A hidden marker
 * makes an ambiguous POST recoverable without blindly submitting twice.
 */

import { appendGithubMarkdownChrome, githubAttributionFooter, type GithubCommentAttribution } from './poster.js'

export type GithubReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'
export type GithubReviewVerdict = 'pass' | 'fail' | 'neutral'

export interface GithubInlineReviewComment {
  path: string
  body: string
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
}

export interface SubmitGithubReviewInput {
  event: GithubReviewEvent
  verdict: GithubReviewVerdict
  body: string
  comments?: GithubInlineReviewComment[]
}

export interface GithubReviewTarget {
  token: string
  repoFullName: string
  pullNumber: number
  expectedHeadSha: string
  expectedBaseSha: string
  hookId: string
  deliveryKey: string
  attemptId: string
  /** This attempt id came from durable inbox state after a daemon restart; a
   * failed marker read is therefore ambiguous, not proof of no effect. */
  recovering?: boolean
}

export interface GithubPullRevision {
  headSha: string
  baseSha: string
  mergeCommitSha?: string
  draft: boolean
  state: string
  merged: boolean
}

export type GithubReviewEffect =
  | {
      state: 'submitted'
      reviewId: string
      event: GithubReviewEvent
      verdict: GithubReviewVerdict
      commitId: string
    }
  | {
      state: 'not_submitted'
      code: 'invalid_input' | 'revision_changed' | 'pull_unavailable' | 'github_rejected'
      message: string
    }
  | {
      state: 'ambiguous'
      code: 'ambiguous_write'
      message: string
    }

export interface GithubReviewClientDeps {
  fetchImpl?: typeof fetch
  baseUrl?: string
  timeoutMs?: number
}

interface GithubPullResponse {
  state?: string
  merged?: boolean
  draft?: boolean
  head?: { sha?: string }
  base?: { sha?: string }
  merge_commit_sha?: string | null
}

interface GithubReviewResponse {
  id?: string | number
  body?: string | null
  commit_id?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_REVIEW_PAGES = 10
const REVIEWS_PER_PAGE = 100

class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'GithubHttpError'
  }
}

function markerFor(target: GithubReviewTarget): string {
  const encoded = Buffer.from(
    JSON.stringify({
      v: 1,
      hookId: target.hookId,
      deliveryKey: target.deliveryKey,
      attemptId: target.attemptId,
      headSha: target.expectedHeadSha
    }),
    'utf8'
  ).toString('base64url')
  return `<!-- agentconnect-review:${encoded} -->`
}

function validateInput(input: SubmitGithubReviewInput): string | undefined {
  if (input.event === 'APPROVE' && input.verdict !== 'pass') return 'APPROVE requires verdict=pass'
  if (input.event === 'REQUEST_CHANGES' && input.verdict !== 'fail') {
    return 'REQUEST_CHANGES requires verdict=fail'
  }
  // Validate the model-authored body before daemon attribution is appended. An
  // APPROVE is the sole public response too, so its summary cannot be empty.
  if (!input.body.trim()) {
    return `${input.event} requires a non-empty body`
  }
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

function safeJson(text: string): unknown {
  if (!text) return undefined
  // Review ids are opaque 64-bit values. Preserve them as strings before parse.
  return JSON.parse(text.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"'))
}

/** One lexical-scope client; it never caches tokens or targets. */
export class GithubReviewClient {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(deps: GithubReviewClientDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.baseUrl = (deps.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async getPull(token: string, repoFullName: string, pullNumber: number): Promise<GithubPullRevision> {
    const pull = await this.request<GithubPullResponse>(`/repos/${repoFullName}/pulls/${pullNumber}`, token, 'GET')
    const headSha = pull.head?.sha
    const baseSha = pull.base?.sha
    if (!headSha || !baseSha) throw new GithubHttpError(502, 'GitHub pull response omitted head/base SHA')
    return {
      headSha,
      baseSha,
      ...(pull.merge_commit_sha ? { mergeCommitSha: pull.merge_commit_sha } : {}),
      draft: pull.draft === true,
      state: pull.state ?? 'unknown',
      merged: pull.merged === true
    }
  }

  async submit(
    target: GithubReviewTarget,
    input: SubmitGithubReviewInput,
    attribution?: GithubCommentAttribution
  ): Promise<GithubReviewEffect> {
    const invalid = validateInput(input)
    if (invalid) return { state: 'not_submitted', code: 'invalid_input', message: invalid }

    const marker = markerFor(target)
    try {
      let existing: GithubReviewResponse | undefined
      try {
        existing = await this.findByMarker(target, marker)
      } catch (err) {
        if (target.recovering) {
          return {
            state: 'ambiguous',
            code: 'ambiguous_write',
            message: 'cannot reconcile the prior formal review attempt; automatic retry is blocked'
          }
        }
        throw err
      }
      if (existing) return this.submitted(existing, target, input)

      const pull = await this.getPull(target.token, target.repoFullName, target.pullNumber)
      if (pull.state !== 'open' || pull.merged || pull.draft) {
        return {
          state: 'not_submitted',
          code: 'pull_unavailable',
          message: `pull request is ${pull.merged ? 'merged' : pull.draft ? 'draft' : pull.state}`
        }
      }
      if (pull.headSha !== target.expectedHeadSha || pull.baseSha !== target.expectedBaseSha) {
        return {
          state: 'not_submitted',
          code: 'revision_changed',
          message: 'pull request head/base changed while the review was running'
        }
      }

      // Keep the visible review self-contained. Attribution is shared with the
      // ordinary poster, while the correlation marker remains the final chrome.
      const body = appendGithubMarkdownChrome(input.body, `${githubAttributionFooter(attribution)}\n\n${marker}`)
      try {
        const created = await this.request<GithubReviewResponse>(
          `/repos/${target.repoFullName}/pulls/${target.pullNumber}/reviews`,
          target.token,
          'POST',
          {
            commit_id: target.expectedHeadSha,
            event: input.event,
            body,
            ...(input.comments?.length
              ? {
                  comments: input.comments.map((comment) => ({
                    path: comment.path,
                    body: comment.body,
                    line: comment.line,
                    side: comment.side,
                    ...(comment.startLine !== undefined ? { start_line: comment.startLine } : {}),
                    ...(comment.startSide !== undefined ? { start_side: comment.startSide } : {})
                  }))
                }
              : {})
          }
        )
        return this.submitted(created, target, input)
      } catch (err) {
        // A received 4xx is a definite rejection: GitHub did not create the
        // review, so the CP may release this attempt reservation.
        if (err instanceof GithubHttpError && err.status >= 400 && err.status < 500) {
          return { state: 'not_submitted', code: 'github_rejected', message: err.message }
        }
        // Timeout/disconnect/5xx is ambiguous. Reconcile by the hidden marker;
        // never blindly retry the POST.
        const recovered = await this.findByMarker(target, marker).catch(() => undefined)
        if (recovered) return this.submitted(recovered, target, input)
        return {
          state: 'ambiguous',
          code: 'ambiguous_write',
          message: 'GitHub review outcome is unknown; automatic retry is blocked'
        }
      }
    } catch (err) {
      // Everything before POST is a definite no-effect failure.
      return {
        state: 'not_submitted',
        code: 'github_rejected',
        message: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /** Read-only recovery for an attempt whose POST outcome was ambiguous. This
   * is safe to run automatically before a replayed model turn: it can converge
   * a now-visible marker, but never issues a second review mutation. */
  async reconcile(
    target: GithubReviewTarget,
    event: GithubReviewEvent,
    verdict: GithubReviewVerdict
  ): Promise<GithubReviewEffect> {
    const marker = markerFor(target)
    try {
      const existing = await this.findByMarker(target, marker)
      if (existing) {
        return this.submitted(existing, target, { event, verdict, body: '' })
      }
      return {
        state: 'ambiguous',
        code: 'ambiguous_write',
        message: 'the prior formal review marker is not visible yet; automatic mutation retry is blocked'
      }
    } catch {
      return {
        state: 'ambiguous',
        code: 'ambiguous_write',
        message: 'cannot reconcile the prior formal review attempt; automatic mutation retry is blocked'
      }
    }
  }

  private submitted(
    review: GithubReviewResponse,
    target: GithubReviewTarget,
    input: SubmitGithubReviewInput
  ): GithubReviewEffect {
    if (review.id === undefined || review.id === null) {
      return {
        state: 'ambiguous',
        code: 'ambiguous_write',
        message: 'GitHub created/recovered a review without an id'
      }
    }
    if (!review.commit_id) {
      return {
        state: 'ambiguous',
        code: 'ambiguous_write',
        message: 'GitHub created/recovered a review without its commit id'
      }
    }
    const commitId = review.commit_id
    if (commitId !== target.expectedHeadSha) {
      return {
        state: 'ambiguous',
        code: 'ambiguous_write',
        message: 'recovered review is anchored to an unexpected commit'
      }
    }
    return {
      state: 'submitted',
      reviewId: String(review.id),
      event: input.event,
      verdict: input.verdict,
      commitId
    }
  }

  private async findByMarker(target: GithubReviewTarget, marker: string): Promise<GithubReviewResponse | undefined> {
    for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
      const rows = await this.request<GithubReviewResponse[]>(
        `/repos/${target.repoFullName}/pulls/${target.pullNumber}/reviews?per_page=${REVIEWS_PER_PAGE}&page=${page}`,
        target.token,
        'GET'
      )
      const hit = rows.find((review) => review.body?.includes(marker))
      if (hit) return hit
      if (rows.length < REVIEWS_PER_PAGE) return undefined
    }
    throw new Error('review marker reconciliation exceeded pagination bound')
  }

  private async request<T>(path: string, token: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const text = await response.text()
    if (!response.ok) {
      let detail = ''
      try {
        const parsed = safeJson(text) as { message?: string } | undefined
        detail = parsed?.message ? `: ${parsed.message}` : ''
      } catch {
        // Status alone is enough for a non-JSON body.
      }
      throw new GithubHttpError(response.status, `GitHub ${method} ${response.status}${detail}`)
    }
    return safeJson(text) as T
  }
}
