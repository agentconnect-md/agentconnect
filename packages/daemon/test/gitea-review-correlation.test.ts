/**
 * The review-delivery correlation rule (gitea-integration.md §8, §16): a candidate is a review by the
 * sender in the delivered state with the delivered summary; one is read, several are all read and
 * labeled, none is a summary-only trigger, and the empty `commit_id` is never compared.
 */
import { describe, expect, it } from 'vitest'
import {
  correlateGiteaReview,
  giteaReviewEventState,
  MAX_INLINE_BODY_CHARS,
  MAX_INLINE_COMMENTS,
  type GiteaReviewDelivery
} from '../src/gitea/review-correlation.js'

const BASE = 'https://gitea.example.test/api/v1'
const PREFIX = `${BASE}/repos/example-org/example-repo/pulls/12`

interface Route {
  /** Matched against the request URL by prefix. */
  url: string
  status?: number
  body: unknown
}

function fakeFetch(routes: Route[]) {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(url)
    const route = routes.find((candidate) => url.startsWith(candidate.url))
    if (!route) return new Response('{"message":"not found"}', { status: 404 })
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls, client: { apiBaseUrl: BASE, token: 'tok', fetchImpl } }
}

const review = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  user: { id: 7, login: 'Alice' },
  state: 'COMMENT',
  body: 'looks mostly fine',
  // Never assigned on a review delivery and never compared: a candidate is not filtered by any commit.
  commit_id: `commit-${id}`,
  ...extra
})

const delivery: GiteaReviewDelivery = {
  repoPath: 'example-org/example-repo',
  index: 12,
  state: 'COMMENT',
  senderLogin: 'alice',
  summary: 'looks mostly fine'
}

describe('giteaReviewEventState', () => {
  it('maps the three review event types to the submitted state, and nothing else', () => {
    expect(giteaReviewEventState('pull_request_review_comment')).toBe('COMMENT')
    expect(giteaReviewEventState('pull_request_review_approved')).toBe('APPROVED')
    expect(giteaReviewEventState('pull_request_review_rejected')).toBe('REQUEST_CHANGES')
    expect(giteaReviewEventState('pull_request_comment')).toBeUndefined()
    expect(giteaReviewEventState(undefined)).toBeUndefined()
  })
})

describe('correlateGiteaReview', () => {
  it('reads the inline comments of the one review by the sender, in state, with the summary', async () => {
    const { client, calls } = fakeFetch([
      {
        url: `${PREFIX}/reviews?`,
        body: [
          review(1, { user: { id: 9, login: 'bob' } }),
          review(2, { state: 'APPROVED' }),
          review(3, { body: 'a different summary' }),
          review(4, { state: 'PENDING' }),
          review(5, { state: 'REQUEST_REVIEW', body: '' }),
          review(6)
        ]
      },
      {
        url: `${PREFIX}/reviews/6/comments`,
        body: [
          {
            id: 50,
            path: 'src/a.ts',
            position: 12,
            original_position: 0,
            diff_hunk: '@@ -1 +1 @@',
            body: 'rename this'
          },
          { id: 51, path: 'src/b.ts', position: 0, original_position: 3, body: 'old side' },
          { id: 52, path: 'src/c.ts', body: 'file-level' },
          { path: 'no-id.ts', body: 'skipped' }
        ]
      }
    ])
    await expect(correlateGiteaReview(client, delivery)).resolves.toEqual({
      kind: 'matched',
      reviews: [
        {
          id: '6',
          comments: [
            { id: '50', path: 'src/a.ts', line: 12, side: 'new', diffHunk: '@@ -1 +1 @@', body: 'rename this' },
            { id: '51', path: 'src/b.ts', line: 3, side: 'old', body: 'old side' },
            { id: '52', path: 'src/c.ts', body: 'file-level' }
          ]
        }
      ]
    })
    expect(calls).toEqual([`${PREFIX}/reviews?page=1&limit=50`, `${PREFIX}/reviews/6/comments`])
  })

  it('reads every candidate when several cannot be told apart, keeping the listed order', async () => {
    const { client } = fakeFetch([
      { url: `${PREFIX}/reviews?`, body: [review(6), review(7)] },
      { url: `${PREFIX}/reviews/6/comments`, body: [{ id: 1, path: 'a', body: 'first' }] },
      { url: `${PREFIX}/reviews/7/comments`, body: [] }
    ])
    await expect(correlateGiteaReview(client, delivery)).resolves.toEqual({
      kind: 'matched',
      reviews: [
        { id: '6', comments: [{ id: '1', path: 'a', body: 'first' }] },
        { id: '7', comments: [] }
      ]
    })
  })

  it('is a summary-only trigger when no review matches, reading no comments at all', async () => {
    const { client, calls } = fakeFetch([
      { url: `${PREFIX}/reviews?`, body: [review(1, { user: { id: 9, login: 'bob' } })] }
    ])
    await expect(correlateGiteaReview(client, delivery)).resolves.toEqual({ kind: 'none' })
    expect(calls).toHaveLength(1)
  })

  it('matches a truncated summary by prefix and a whole one exactly, line endings normalized', async () => {
    const { client } = fakeFetch([
      { url: `${PREFIX}/reviews?`, body: [review(6, { body: 'looks mostly fine\r\nbut see below' })] },
      { url: `${PREFIX}/reviews/6/comments`, body: [] }
    ])
    await expect(correlateGiteaReview(client, delivery)).resolves.toEqual({ kind: 'none' })
    await expect(correlateGiteaReview(client, { ...delivery, truncated: true })).resolves.toMatchObject({
      kind: 'matched'
    })
    await expect(
      correlateGiteaReview(client, { ...delivery, summary: 'looks mostly fine\nbut see below\n' })
    ).resolves.toMatchObject({ kind: 'matched' })
  })

  it('pages the review list until a short page, and bounds what it carries', async () => {
    const firstPage = Array.from({ length: 50 }, (_unused, index) =>
      review(index + 1, { user: { id: 9, login: 'bob' } })
    )
    const comments = Array.from({ length: MAX_INLINE_COMMENTS + 5 }, (_unused, index) => ({
      id: index + 1,
      path: 'a',
      body: 'x'.repeat(MAX_INLINE_BODY_CHARS + 10)
    }))
    const { client, calls } = fakeFetch([
      { url: `${PREFIX}/reviews?page=1`, body: firstPage },
      { url: `${PREFIX}/reviews?page=2`, body: [review(60)] },
      { url: `${PREFIX}/reviews/60/comments`, body: comments }
    ])
    const result = await correlateGiteaReview(client, delivery)
    expect(calls.slice(0, 2)).toEqual([`${PREFIX}/reviews?page=1&limit=50`, `${PREFIX}/reviews?page=2&limit=50`])
    if (result.kind !== 'matched') throw new Error('expected a match')
    expect(result.reviews[0]!.comments).toHaveLength(MAX_INLINE_COMMENTS)
    expect(result.reviews[0]!.comments[0]!.body).toHaveLength(MAX_INLINE_BODY_CHARS)
  })

  it('never throws: a failed lookup is unavailable with the bounded reason', async () => {
    const { client } = fakeFetch([{ url: `${PREFIX}/reviews?`, status: 401, body: { message: 'token expired' } }])
    await expect(correlateGiteaReview(client, delivery)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Gitea GET failed with 401: token expired'
    })
    await expect(correlateGiteaReview(client, { ...delivery, repoPath: 'not/a/repo' })).resolves.toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('exactly owner/repo')
    })
  })
})
