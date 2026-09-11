/**
 * The review-delivery correlation rule (gitea-integration.md §8, §16).
 *
 * A Gitea review delivery is lossy: it carries the summary in `review.content` and nothing about
 * the inline comments — no path, line, hunk, body, or review id. So the turn lists the pull
 * request's reviews and reads the inline comments of the review the delivery describes. A candidate
 * is a review by the delivery's sender whose state matches the event type and whose body equals the
 * delivered summary. Exactly one candidate is the review; several — the same person submitting
 * twice with identical summaries before the first delivery is processed — cannot be told apart, so
 * every candidate's comments are read, labeled by review id; none is a summary-only trigger. The
 * delivery's top-level `commit_id` is never assigned for review events and `pull_request.head.sha`
 * is the branch tip at delivery time, so neither is compared.
 */
import { giteaRepoPath, giteaRequest, type GiteaApiClient } from './api.js'

export type GiteaReviewState = 'COMMENT' | 'APPROVED' | 'REQUEST_CHANGES'

/** The normalized review event (§8) and the submitted state it names — a Map, since the key arrives off the wire. */
const REVIEW_EVENT_STATES: ReadonlyMap<string, GiteaReviewState> = new Map([
  ['review:commented', 'COMMENT'],
  ['review:approved', 'APPROVED'],
  ['review:changes_requested', 'REQUEST_CHANGES']
])

/** The review state a normalized event names, or undefined when the delivery is not a review submission. */
export function giteaReviewEventState(event: string | undefined): GiteaReviewState | undefined {
  return event !== undefined ? REVIEW_EVENT_STATES.get(event) : undefined
}

export interface GiteaReviewDelivery {
  repoPath: string
  index: number
  state: GiteaReviewState
  /** `sender.login` as the relay forwarded it; a Gitea login is unique per instance and matched case-insensitively. */
  senderLogin: string
  /** `review.content` as the relay excerpted it; a truncated excerpt matches a review body by prefix. */
  summary: string
  truncated?: boolean
}

export interface GiteaInlineComment {
  id: string
  path: string
  /** The commented line, on the new side (`position`) or the old side (`original_position`). */
  line?: number
  side?: 'new' | 'old'
  diffHunk?: string
  body: string
}

export interface GiteaCorrelatedReview {
  id: string
  comments: GiteaInlineComment[]
}

export type GiteaReviewCorrelation =
  /** `omitted` counts older candidates beyond the read budget whose comments were NOT read, so the prompt can say the match is incomplete. */
  | { kind: 'matched'; reviews: GiteaCorrelatedReview[]; omitted?: number }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }

/** Bounds on what one correlation may carry into the model's context. */
const PAGE_SIZE = 50
const MAX_REVIEW_PAGES = 5
const MAX_CANDIDATES = 5
export const MAX_INLINE_COMMENTS = 50
export const MAX_INLINE_BODY_CHARS = 4000
export const MAX_DIFF_HUNK_CHARS = 2000

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined
}

function line(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

/** The §8 candidate rule over one listed review. */
function isCandidate(review: Record<string, unknown>, delivery: GiteaReviewDelivery): boolean {
  const login = record(review.user).login
  if (typeof login !== 'string' || login.toLowerCase() !== delivery.senderLogin.toLowerCase()) return false
  if (review.state !== delivery.state) return false
  const body = normalizeBody(typeof review.body === 'string' ? review.body : '')
  const summary = normalizeBody(delivery.summary)
  return delivery.truncated ? body.startsWith(summary) : body === summary
}

function inlineComment(raw: unknown): GiteaInlineComment | undefined {
  const comment = record(raw)
  const id = idOf(comment.id)
  const path = str(comment.path, 500)
  if (id === undefined || path === undefined) return undefined
  const newLine = line(comment.position)
  const oldLine = line(comment.original_position)
  const diffHunk = str(comment.diff_hunk, MAX_DIFF_HUNK_CHARS)
  return {
    id,
    path,
    ...(newLine !== undefined
      ? { line: newLine, side: 'new' }
      : oldLine !== undefined
        ? { line: oldLine, side: 'old' }
        : {}),
    ...(diffHunk !== undefined ? { diffHunk } : {}),
    body: str(comment.body, MAX_INLINE_BODY_CHARS) ?? ''
  }
}

/** List every review of the pull request, newest pages included, bounded. */
async function listReviews(client: GiteaApiClient, path: string): Promise<Record<string, unknown>[]> {
  const reviews: Record<string, unknown>[] = []
  for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
    const parsed = await giteaRequest(client, {
      method: 'GET',
      path: `${path}/reviews`,
      query: { page: String(page), limit: String(PAGE_SIZE) }
    })
    const batch = Array.isArray(parsed) ? parsed.map(record) : []
    reviews.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return reviews
}

/** Resolve the review(s) a delivery describes and read their inline comments; never throws. */
export async function correlateGiteaReview(
  client: GiteaApiClient,
  delivery: GiteaReviewDelivery
): Promise<GiteaReviewCorrelation> {
  try {
    const path = `${giteaRepoPath(delivery.repoPath)}/pulls/${delivery.index}`
    const candidates = (await listReviews(client, path))
      .filter((review) => isCandidate(review, delivery))
      .map((review) => idOf(review.id))
      .filter((id): id is string => id !== undefined)
    if (candidates.length === 0) return { kind: 'none' }
    // Gitea lists oldest first and the delivery is the newest submission, so past the read budget the
    // NEWEST candidates are read and the rest are counted, never silently presented as the whole match.
    const omitted = Math.max(0, candidates.length - MAX_CANDIDATES)
    const reviews: GiteaCorrelatedReview[] = []
    for (const id of candidates.slice(omitted)) {
      const parsed = await giteaRequest(client, { method: 'GET', path: `${path}/reviews/${id}/comments` })
      const comments = (Array.isArray(parsed) ? parsed : [])
        .map(inlineComment)
        .filter((comment): comment is GiteaInlineComment => comment !== undefined)
        .slice(0, MAX_INLINE_COMMENTS)
      reviews.push({ id, comments })
    }
    return { kind: 'matched', reviews, ...(omitted > 0 ? { omitted } : {}) }
  } catch (err) {
    return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
  }
}
