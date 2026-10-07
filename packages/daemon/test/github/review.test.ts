import { describe, expect, it, vi } from 'vitest'
import { GithubReviewClient, type GithubReviewTarget, type SubmitGithubReviewInput } from '../../src/github/review.js'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const target: GithubReviewTarget = {
  token: 'ghs_review',
  repoFullName: 'acme/infra',
  pullNumber: 42,
  expectedHeadSha: 'a'.repeat(40),
  expectedBaseSha: 'b'.repeat(40),
  hookId: '11111111-1111-4111-8111-111111111111',
  deliveryKey: 'delivery-1',
  attemptId: '22222222-2222-4222-8222-222222222222'
}

const comment: SubmitGithubReviewInput = {
  event: 'COMMENT',
  verdict: 'neutral',
  body: 'Looks good overall.',
  comments: [{ path: 'src/index.ts', body: 'Please rename this.', line: 12, side: 'RIGHT' }]
}

const pullFiles = [
  {
    filename: 'src/index.ts',
    patch: '@@ -10,3 +10,4 @@\n before\n-old\n+new\n+added\n after\n@@ -30 +31 @@\n-old\n+new'
  },
  { filename: 'image.png' }
]

const attribution = {
  agentName: 'review-bot',
  agentUrl: 'https://app.example.test/acme/agents/review-bot',
  runtime: 'Codex',
  model: 'gpt-5.6-luna',
  sessionUrl: 'https://app.example.test/acme/sessions/session-1'
}

describe('GithubReviewClient', () => {
  it('returns the merge revision GitHub associates with the current pull', async () => {
    const mergeCommitSha = 'c'.repeat(40)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json(200, {
        state: 'open',
        merged: false,
        draft: false,
        head: { sha: target.expectedHeadSha },
        base: { sha: target.expectedBaseSha },
        merge_commit_sha: mergeCommitSha
      })
    )
    const client = new GithubReviewClient({ fetchImpl })

    await expect(client.getPull(target.token, target.repoFullName, target.pullNumber)).resolves.toMatchObject({
      headSha: target.expectedHeadSha,
      baseSha: target.expectedBaseSha,
      mergeCommitSha
    })
  })

  it('validates event/verdict before any network effect', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new GithubReviewClient({ fetchImpl })

    await expect(client.submit(target, { event: 'APPROVE', verdict: 'fail', body: '' })).resolves.toMatchObject({
      state: 'not_submitted',
      code: 'invalid_input'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires a model-authored body for APPROVE before daemon attribution is added', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new GithubReviewClient({ fetchImpl })

    await expect(
      client.submit(target, { event: 'APPROVE', verdict: 'pass', body: '  ' }, attribution)
    ).resolves.toEqual({
      state: 'not_submitted',
      code: 'invalid_input',
      message: 'APPROVE requires a non-empty body'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('submits a self-contained attributed review with the hidden marker last', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, []))
      .mockResolvedValueOnce(json(200, pullFiles))
      .mockResolvedValueOnce(
        json(200, {
          state: 'open',
          merged: false,
          draft: false,
          head: { sha: target.expectedHeadSha },
          base: { sha: target.expectedBaseSha }
        })
      )
      .mockResolvedValueOnce(
        new Response(`{"id":90071992547409999,"commit_id":"${target.expectedHeadSha}"}`, {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    const client = new GithubReviewClient({ fetchImpl })

    await expect(client.submit(target, comment, attribution)).resolves.toEqual({
      state: 'submitted',
      reviewId: '90071992547409999',
      event: 'COMMENT',
      verdict: 'neutral',
      commitId: target.expectedHeadSha
    })

    const [, init] = fetchImpl.mock.calls[3]!
    const body = JSON.parse(String(init?.body)) as {
      commit_id: string
      body: string
      comments: Array<Record<string, unknown>>
    }
    expect(body.commit_id).toBe(target.expectedHeadSha)
    const footerAt = body.body.indexOf('sent by [review-bot]')
    const markerAt = body.body.indexOf('<!-- agentconnect-review:')
    expect(body.body.startsWith('Looks good overall.')).toBe(true)
    expect(footerAt).toBeGreaterThan(0)
    expect(body.body).toContain(
      '[review-bot](<https://app.example.test/acme/agents/review-bot>) (Codex · gpt-5.6-luna) · ' +
        '[open in session](<https://app.example.test/acme/sessions/session-1>)'
    )
    expect(markerAt).toBeGreaterThan(footerAt)
    expect(body.body.slice(markerAt)).toMatch(/^<!-- agentconnect-review:[^>]+-->$/)
    expect(body.body.match(/sent by/g)).toHaveLength(1)
    expect(body.comments).toEqual([{ path: 'src/index.ts', body: 'Please rename this.', line: 12, side: 'RIGHT' }])
    expect(body.comments[0]!.body).not.toContain('sent by')
  })

  it('closes an unclosed model fence before attribution and the hidden marker', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, []))
      .mockResolvedValueOnce(
        json(200, {
          state: 'open',
          merged: false,
          draft: false,
          head: { sha: target.expectedHeadSha },
          base: { sha: target.expectedBaseSha }
        })
      )
      .mockResolvedValueOnce(json(200, { id: '123', commit_id: target.expectedHeadSha }))
    const client = new GithubReviewClient({ fetchImpl })
    const fence = String.fromCharCode(96).repeat(3)

    await expect(
      client.submit(
        target,
        { event: 'APPROVE', verdict: 'pass', body: `Validated:\n\n${fence}ts\nconst answer = 42` },
        attribution
      )
    ).resolves.toMatchObject({ state: 'submitted' })

    const [, init] = fetchImpl.mock.calls[2]!
    const body = (JSON.parse(String(init?.body)) as { body: string }).body
    const footerAt = body.indexOf('sent by [review-bot]')
    const markerAt = body.indexOf('<!-- agentconnect-review:')
    expect(body).toContain(`const answer = 42\n${fence}\n\n<sub>sent by `)
    expect(body.split(fence)).toHaveLength(3)
    expect(markerAt).toBeGreaterThan(footerAt)
  })

  it('submits a formal review for an open draft pull request', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, []))
      .mockResolvedValueOnce(
        json(200, {
          state: 'open',
          merged: false,
          draft: true,
          head: { sha: target.expectedHeadSha },
          base: { sha: target.expectedBaseSha }
        })
      )
      .mockResolvedValueOnce(json(200, { id: '456', commit_id: target.expectedHeadSha }))
    const client = new GithubReviewClient({ fetchImpl })

    await expect(
      client.submit(target, { event: 'APPROVE', verdict: 'pass', body: 'No changes are needed.' })
    ).resolves.toMatchObject({
      state: 'submitted',
      event: 'APPROVE',
      verdict: 'pass',
      commitId: target.expectedHeadSha
    })
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('refuses a head changed during file reads without issuing the review POST', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, []))
      .mockResolvedValueOnce(json(200, pullFiles))
      .mockResolvedValueOnce(
        json(200, {
          state: 'open',
          merged: false,
          draft: false,
          head: { sha: 'c'.repeat(40) },
          base: { sha: target.expectedBaseSha }
        })
      )
    const client = new GithubReviewClient({ fetchImpl })

    await expect(client.submit(target, comment)).resolves.toMatchObject({
      state: 'not_submitted',
      code: 'revision_changed'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('/files?')
    expect(String(fetchImpl.mock.calls[2]![0])).toMatch(/\/pulls\/42$/)
  })

  it('recovers an ambiguous POST by listing the correlation marker instead of retrying', async () => {
    let marker = ''
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        marker = (JSON.parse(String(init?.body)) as { body: string }).body.match(
          /<!-- agentconnect-review:[^>]+-->/
        )![0]
        throw new Error('socket reset')
      }
      const url = String(_url)
      if (url.includes('/reviews?')) {
        return marker
          ? json(200, [{ id: '12345678901234567', body: marker, commit_id: target.expectedHeadSha }])
          : json(200, [])
      }
      if (url.includes('/files?')) return json(200, pullFiles)
      return json(200, {
        state: 'open',
        merged: false,
        draft: false,
        head: { sha: target.expectedHeadSha },
        base: { sha: target.expectedBaseSha }
      })
    })
    const client = new GithubReviewClient({ fetchImpl })

    await expect(client.submit(target, comment)).resolves.toMatchObject({
      state: 'submitted',
      reviewId: '12345678901234567'
    })
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it.each([
    ['a 5xx', () => json(502, { message: 'Bad Gateway' }), 'GitHub POST 502: Bad Gateway'],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('read'), { code: 'ECONNRESET' }) })
      },
      'GitHub request failed: fetch failed (ECONNRESET)'
    ]
  ])('names the cause of an unrecovered ambiguous POST after %s', async (_, post, cause) => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') return post()
      if (String(url).includes('/reviews?')) return json(200, [])
      if (String(url).includes('/files?')) return json(200, pullFiles)
      return json(200, {
        state: 'open',
        merged: false,
        draft: false,
        head: { sha: target.expectedHeadSha },
        base: { sha: target.expectedBaseSha }
      })
    })
    const client = new GithubReviewClient({ fetchImpl })

    await expect(client.submit(target, comment)).resolves.toEqual({
      state: 'ambiguous',
      code: 'ambiguous_write',
      message: `GitHub review outcome is unknown (${cause}); automatic retry is blocked`
    })
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('fails closed when a recovered attempt cannot read its marker', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('GitHub unavailable'))
    const client = new GithubReviewClient({ fetchImpl })

    await expect(client.submit({ ...target, recovering: true }, comment)).resolves.toEqual({
      state: 'ambiguous',
      code: 'ambiguous_write',
      message: 'cannot reconcile the prior formal review attempt; automatic retry is blocked'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('reconciles a later-visible marker through GETs only', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new GithubReviewClient({ fetchImpl })
    // Capture a real submission marker without depending on its encoding.
    let marker = ''
    const capture = new GithubReviewClient({
      fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === 'POST') {
          marker = (JSON.parse(String(init.body)) as { body: string }).body.match(
            /<!-- agentconnect-review:[^>]+-->/
          )![0]
          return json(200, { id: '1', commit_id: target.expectedHeadSha })
        }
        if (String(_url).includes('/reviews?')) return json(200, [])
        if (String(_url).includes('/files?')) return json(200, pullFiles)
        return json(200, {
          state: 'open',
          merged: false,
          draft: false,
          head: { sha: target.expectedHeadSha },
          base: { sha: target.expectedBaseSha }
        })
      })
    })
    await capture.submit(target, comment)
    fetchImpl.mockResolvedValue(json(200, [{ id: '123', body: marker, commit_id: target.expectedHeadSha }]))

    await expect(client.reconcile(target, 'COMMENT', 'neutral')).resolves.toMatchObject({
      state: 'submitted',
      reviewId: '123',
      event: 'COMMENT',
      verdict: 'neutral'
    })
    expect(fetchImpl.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true)
  })

  it('preserves GitHub validation details in a definite no-effect rejection', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, []))
      .mockResolvedValueOnce(json(200, pullFiles))
      .mockResolvedValueOnce(
        json(200, {
          state: 'open',
          merged: false,
          draft: false,
          head: { sha: target.expectedHeadSha },
          base: { sha: target.expectedBaseSha }
        })
      )
      .mockResolvedValueOnce(
        json(422, {
          message: 'Validation Failed',
          errors: [
            'Review comments is invalid',
            {
              resource: 'PullRequestReviewComment',
              field: 'line',
              code: 'invalid',
              message: 'Line must be part of the diff',
              value: 'unrelated provider data'
            }
          ]
        })
      )
    const client = new GithubReviewClient({ fetchImpl })

    await expect(client.submit(target, comment)).resolves.toEqual({
      state: 'not_submitted',
      code: 'github_rejected',
      message:
        'GitHub POST 422: Validation Failed; Review comments is invalid; ' +
        'PullRequestReviewComment: line: invalid: Line must be part of the diff'
    })
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it.each([
    { line: 15, side: 'RIGHT' as const },
    { line: 13, side: 'LEFT' as const },
    { line: 31, side: 'RIGHT' as const, startLine: 13, startSide: 'RIGHT' as const },
    { line: 12, side: 'RIGHT' as const, startLine: 9, startSide: 'RIGHT' as const },
    { path: 'missing.ts', line: 12, side: 'RIGHT' as const },
    { path: 'image.png', line: 1, side: 'RIGHT' as const }
  ])('refuses an inline comment outside the available diff: %j', async (position) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, []))
      .mockResolvedValueOnce(json(200, pullFiles))
      .mockResolvedValueOnce(
        json(200, {
          state: 'open',
          head: { sha: target.expectedHeadSha },
          base: { sha: target.expectedBaseSha }
        })
      )
    const client = new GithubReviewClient({ fetchImpl })

    await expect(
      client.submit(target, { ...comment, comments: [{ ...comment.comments![0]!, ...position }] })
    ).resolves.toMatchObject({
      state: 'not_submitted',
      code: 'invalid_input',
      message: expect.stringMatching(/comments\[0\].*review body, then retry/)
    })
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('finds renamed files on later pages and submits valid additions, deletions and ranges', async () => {
    const files = [
      { ...pullFiles[0], previous_filename: 'src/old.ts' },
      { filename: 'removed.ts', patch: '@@ -1,2 +0,0 @@\n-first\n-last' },
      { filename: 'added.ts', patch: '@@ -0,0 +1 @@\n+first\n\\ No newline at end of file' }
    ]
    const comments: NonNullable<SubmitGithubReviewInput['comments']> = [
      { path: 'src/index.ts', body: 'Addition', line: 12, side: 'RIGHT' },
      { path: 'src/index.ts', body: 'Deletion', line: 11, side: 'LEFT' },
      { path: 'src/index.ts', body: 'Range', line: 13, side: 'RIGHT', startLine: 10, startSide: 'RIGHT' },
      { path: 'removed.ts', body: 'Removed file', line: 2, side: 'LEFT' },
      { path: 'added.ts', body: 'Added file', line: 1, side: 'RIGHT' }
    ]
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, []))
      .mockResolvedValueOnce(
        json(
          200,
          Array.from({ length: 100 }, (_, i) => ({ filename: `other-${i}.ts` }))
        )
      )
      .mockResolvedValueOnce(json(200, files))
      .mockResolvedValueOnce(
        json(200, {
          state: 'open',
          head: { sha: target.expectedHeadSha },
          base: { sha: target.expectedBaseSha }
        })
      )
      .mockResolvedValueOnce(json(200, { id: '456', commit_id: target.expectedHeadSha }))
    const client = new GithubReviewClient({ fetchImpl })

    await expect(client.submit(target, { ...comment, comments })).resolves.toMatchObject({ state: 'submitted' })
    expect(String(fetchImpl.mock.calls[2]![0])).toContain('/files?per_page=100&page=2')
    const submitted = JSON.parse(String(fetchImpl.mock.calls[4]![1]?.body))
    expect(submitted.comments[2]).toMatchObject({ line: 13, start_line: 10, start_side: 'RIGHT' })
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
})
