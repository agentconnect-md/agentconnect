// Trusted targets and correlation markers fence model-authored reviews and recover ambiguous writes.

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
  // A replayed attempt needs marker reconciliation before its write can be retried.
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

interface GithubPullFile {
  filename: string
  patch?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_REVIEW_PAGES = 10
const REVIEWS_PER_PAGE = 100
const FILES_PER_PAGE = 100
const MAX_FILE_PAGES = 30

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
  // Validate the model-authored summary before daemon attribution is appended.
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

function diffPosition(patch: string, line: number, side: 'LEFT' | 'RIGHT') {
  let left = 0
  let right = 0
  let hunk = 0
  for (const [position, row] of patch.split('\n').entries()) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (header) {
      left = Number(header[1])
      right = Number(header[2])
      hunk++
    } else if (hunk && [' ', '-', '+'].includes(row[0] ?? '')) {
      if (side === 'LEFT' ? row[0] !== '+' && left === line : row[0] !== '-' && right === line) {
        return { hunk, position }
      }
      if (row[0] !== '+') left++
      if (row[0] !== '-') right++
    }
  }
  return undefined
}

function validateInlineComments(comments: GithubInlineReviewComment[], files: Map<string, string | undefined>) {
  for (const [index, comment] of comments.entries()) {
    const patch = files.get(comment.path)
    const end = patch && diffPosition(patch, comment.line, comment.side)
    const start =
      comment.startLine === undefined ? end : patch && diffPosition(patch, comment.startLine, comment.startSide!)
    if (!end || !start || start.hunk !== end.hunk || start.position > end.position) {
      return (
        `comments[${index}] (${comment.path}:${comment.line} ${comment.side}): ` +
        (patch ? 'the line or range is outside a single diff hunk.' : 'no text diff is available for this path.') +
        ' Use a line in the diff, or move this finding into the review body, then retry.'
      )
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

      const files = input.comments?.length ? await this.readCommentFiles(target, input.comments) : undefined
      // Recheck the revision after paginated file reads and before accepting any positions.
      const pull = await this.getPull(target.token, target.repoFullName, target.pullNumber)
      if (pull.state !== 'open' || pull.merged) {
        return {
          state: 'not_submitted',
          code: 'pull_unavailable',
          message: `pull request is ${pull.merged ? 'merged' : pull.state}`
        }
      }
      if (pull.headSha !== target.expectedHeadSha || pull.baseSha !== target.expectedBaseSha) {
        return {
          state: 'not_submitted',
          code: 'revision_changed',
          message: 'pull request head/base changed while the review was running'
        }
      }

      if (files) {
        const invalidComments = validateInlineComments(input.comments!, files)
        if (invalidComments) return { state: 'not_submitted', code: 'invalid_input', message: invalidComments }
      }

      // Share ordinary-comment attribution, with the correlation marker last.
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
        // A received 4xx proves no review was created, so the attempt reservation can be released.
        if (err instanceof GithubHttpError && err.status >= 400 && err.status < 500) {
          return { state: 'not_submitted', code: 'github_rejected', message: err.message }
        }
        // Reconcile an ambiguous timeout/disconnect/5xx by marker without blindly repeating the POST.
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

  // Recover a replayed attempt by reading its marker without issuing another mutation.
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

  private async readCommentFiles(target: GithubReviewTarget, comments: GithubInlineReviewComment[]) {
    const wanted = new Set(comments.map(({ path }) => path))
    const files = new Map<string, string | undefined>()
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const rows = await this.request<GithubPullFile[]>(
        `/repos/${target.repoFullName}/pulls/${target.pullNumber}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
        target.token,
        'GET'
      )
      for (const row of rows) {
        if (wanted.has(row.filename)) files.set(row.filename, row.patch)
      }
      if (files.size === wanted.size || rows.length < FILES_PER_PAGE) break
    }
    return files
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
        const parsed = safeJson(text) as { message?: unknown; errors?: unknown } | undefined
        const parts = typeof parsed?.message === 'string' ? [parsed.message] : []
        for (const error of Array.isArray(parsed?.errors) ? parsed.errors.slice(0, 5) : []) {
          if (typeof error === 'string') parts.push(error)
          else if (error && typeof error === 'object') {
            parts.push(
              ['resource', 'field', 'code', 'message']
                .map((field) => (error as Record<string, unknown>)[field])
                .filter((value): value is string => typeof value === 'string')
                .join(': ')
            )
          }
        }
        const message = parts.filter(Boolean).join('; ').slice(0, 2000)
        if (message) detail = `: ${message}`
      } catch {
        // Status alone is enough for a non-JSON body.
      }
      throw new GithubHttpError(response.status, `GitHub ${method} ${response.status}${detail}`)
    }
    return safeJson(text) as T
  }
}
