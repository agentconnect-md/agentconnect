import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  listDreams,
  setAgentWorkspace,
  createGithubHook,
  createMemoryRecord,
  deleteMemoryRecord,
  deleteOrgIcon,
  fetchAllGithubRepos,
  fetchMemoryAdminSurface,
  fmtCountCompact,
  listMemoryRecordHistory,
  listMemoryRecords,
  mintWebchatToken,
  searchMemoryRecords,
  setApiOrgId,
  updateGithubHook,
  updateMemoryRecord,
  uploadMyProfilePicture,
  uploadOrgIcon
} from './api'

describe('fmtCountCompact', () => {
  it.each([
    [60, '60'],
    [45_267, '45K'],
    [101_817, '102K'],
    [2_316_000, '2.32M'],
    [2_463_144, '2.46M'],
    [undefined, '—']
  ])('formats %s as %s', (value, expected) => {
    expect(fmtCountCompact(value)).toBe(expected)
  })
})

describe('apiPost errors', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  it('surfaces the control plane message and machine-readable code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'Conflict',
              statusCode: 409,
              code: 'NO_RELAY',
              message: 'No relay is connected for this organization.'
            }),
            { status: 409, statusText: 'Conflict', headers: { 'content-type': 'application/json' } }
          )
      )
    )

    const error = await mintWebchatToken('org-1', 'agent-1').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'No relay is connected for this organization.',
      status: 409,
      code: 'NO_RELAY'
    })
  })

  it('falls back to method, path, and status when the response is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream failure', { status: 502, statusText: 'Bad Gateway' }))
    )

    const error = await mintWebchatToken('org-1', 'agent-1').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'POST /orgs/org-1/agents/agent-1/webchat/token → 502 Bad Gateway',
      status: 502,
      code: undefined
    })
  })
})

describe('raw-blob helper errors', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  const rejectWith = (status: number, statusText: string, body: { code?: string; message: string }) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            statusText,
            headers: { 'content-type': 'application/json' }
          })
      )
    )

  it('surfaces the control plane message on icon upload', async () => {
    rejectWith(413, 'Payload Too Large', {
      code: 'ICON_TOO_LARGE',
      message: 'Icon exceeds the maximum upload size.'
    })

    const error = await uploadOrgIcon(new Blob(['png'], { type: 'image/png' }), 'org-1').catch(
      (reason: unknown) => reason
    )
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'Icon exceeds the maximum upload size.',
      status: 413,
      code: 'ICON_TOO_LARGE'
    })
  })

  it('surfaces the control plane message on icon delete', async () => {
    rejectWith(409, 'Conflict', { message: 'The icon is being regenerated; retry shortly.' })

    const error = await deleteOrgIcon('org-1').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'The icon is being regenerated; retry shortly.',
      status: 409,
      code: undefined
    })
  })

  it('surfaces the control plane message on profile-picture upload', async () => {
    rejectWith(400, 'Bad Request', {
      code: 'UNSUPPORTED_MEDIA',
      message: 'Profile pictures must be PNG or JPEG.'
    })

    const error = await uploadMyProfilePicture(new Blob(['gif'], { type: 'image/gif' })).catch(
      (reason: unknown) => reason
    )
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'Profile pictures must be PNG or JPEG.',
      status: 400,
      code: 'UNSUPPORTED_MEDIA'
    })
  })

  it('falls back to method, path, and status when the response is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream failure', { status: 502, statusText: 'Bad Gateway' }))
    )

    const error = await uploadOrgIcon(new Blob(['png'], { type: 'image/png' }), 'org-1').catch(
      (reason: unknown) => reason
    )
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'PUT /orgs/org-1/icon → 502 Bad Gateway',
      status: 502,
      code: undefined
    })
  })
})

describe('apiPut errors', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  it('surfaces the control plane message instead of a bare status line', async () => {
    setApiOrgId('org-1')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'Conflict',
              statusCode: 409,
              message: 'workspace edit rejected: agent/activate: daemon capacity 14/8 is full'
            }),
            { status: 409, statusText: 'Conflict', headers: { 'content-type': 'application/json' } }
          )
      )
    )

    const error = await setAgentWorkspace('agent-1', {
      mode: 'github',
      repoFullName: 'org/repo',
      gitAccess: 'write'
    }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'workspace edit rejected: agent/activate: daemon capacity 14/8 is full',
      status: 409
    })
  })

  it('falls back to method, path, and status when the response is not JSON', async () => {
    setApiOrgId('org-1')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream failure', { status: 502, statusText: 'Bad Gateway' }))
    )

    const error = await setAgentWorkspace('agent-1', {
      mode: 'github',
      repoFullName: 'org/repo',
      gitAccess: 'write'
    }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'PUT /orgs/org-1/agents/agent-1/workspace → 502 Bad Gateway',
      status: 502,
      code: undefined
    })
  })
})

describe('GitHub hook review settings', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  it('serializes the R1/R2a fields on create and whole-definition update', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    )
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')
    const input = {
      agentId: 'agent-1',
      name: 'acme/infra',
      repoFullName: 'acme/infra',
      events: ['pull_request:*'],
      commentFamilies: ['pull_request' as const],
      labelFilter: [],
      mentionOnly: false,
      reviewPolicy: 'request_changes' as const,
      reportingMode: 'check' as const,
      gateMode: 'informational' as const
    }

    await createGithubHook(input)
    await updateGithubHook('hook-1', input)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      kind: 'github',
      reviewPolicy: 'request_changes',
      reportingMode: 'check',
      gateMode: 'informational'
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ kind: 'github', ...input })
  })
})

describe('GitHub installation repositories', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  it('loads every page so private repositories can be searched by partial name', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(String(input)).searchParams.get('page')
      const repos =
        page === '1'
          ? [{ fullName: 'acme/alpha', private: true }]
          : page === '2'
            ? [{ fullName: 'acme/beta-private', private: true }]
            : [{ fullName: 'acme/gamma', private: false }]
      return new Response(JSON.stringify({ repos, totalCount: 201 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    const repos = await fetchAllGithubRepos('installation-1')

    expect(repos.map((repo) => repo.fullName)).toEqual(['acme/alpha', 'acme/beta-private', 'acme/gamma'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('perPage'))).toEqual([
      '100',
      '100',
      '100'
    ])
  })

  it('retries transient upstream failures (502/429) before surfacing them', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'github: github error (503): ' }), {
          status: 502,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repos: [{ fullName: 'acme/recovered', private: true }], totalCount: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    await expect(fetchAllGithubRepos('installation-1')).resolves.toEqual([
      { fullName: 'acme/recovered', private: true }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a per-user authorization verdict (403)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'sign in with GitHub', code: 'GITHUB_IDENTITY_REQUIRED' }), {
          status: 403,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    const error = await fetchAllGithubRepos('installation-1').catch((reason: unknown) => reason)
    expect(error).toMatchObject({ name: 'ApiError', status: 403, code: 'GITHUB_IDENTITY_REQUIRED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('limits page requests across concurrent installations', async () => {
    let activeRequests = 0
    let maxActiveRequests = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      await new Promise((resolve) => setTimeout(resolve, 0))
      activeRequests -= 1

      const url = new URL(String(input))
      return new Response(
        JSON.stringify({
          repos: [{ fullName: `${url.pathname}-${url.searchParams.get('page')}`, private: true }],
          totalCount: 101
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    await Promise.all(Array.from({ length: 6 }, (_, index) => fetchAllGithubRepos(`installation-${index + 1}`)))

    expect(fetchMock).toHaveBeenCalledTimes(12)
    expect(maxActiveRequests).toBe(4)
  })
})

describe('external-memory record API', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  it('uses record-shaped routes and preserves cursor, metadata, and optimistic version', async () => {
    const record = {
      id: 'record-1',
      text: 'deploy in sea',
      scope: { kind: 'agent', key: 'ac:agent:agent-1' },
      version: 'v1'
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const body = path.endsWith('/memory/surface')
        ? { shape: 'records', capabilities: ['recall', 'list', 'update'] }
        : path.endsWith('/search')
          ? { records: [record], nextCursor: null }
          : path.endsWith('/history')
            ? { events: [{ id: 'event-1', event: 'update', at: '2026-07-16T00:00:00.000Z', record }], nextCursor: null }
            : init?.method === 'DELETE'
              ? { id: 'record-1', deleted: true }
              : init?.method === 'POST' || init?.method === 'PUT'
                ? { record }
                : { records: [record], nextCursor: 'next' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    await fetchMemoryAdminSurface('agent-1')
    await listMemoryRecords('agent-1', { cursor: 'first', limit: 10 })
    await searchMemoryRecords('agent-1', 'deploy safely', { topK: 3, maxBytes: 4096 })
    await createMemoryRecord('agent-1', { text: 'ship', metadata: { source: 'console' } })
    await updateMemoryRecord('agent-1', 'record-1', { text: 'ship safely', version: 'v1' })
    await deleteMemoryRecord('agent-1', 'record-1', 'v2')
    await listMemoryRecordHistory('agent-1', 'record-1', { limit: 5 })

    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      path: String(input),
      method: init?.method ?? 'GET',
      init
    }))
    expect(calls[1]?.path).toContain('/memory/records?cursor=first&limit=10')
    expect(calls[2]).toMatchObject({ path: expect.stringContaining('/memory/records/search'), method: 'POST' })
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ query: 'deploy safely', topK: 3, maxBytes: 4096 })
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ text: 'ship', metadata: { source: 'console' } })
    expect(JSON.parse(String(calls[4]?.init?.body))).toEqual({ text: 'ship safely', version: 'v1' })
    expect(calls[5]).toMatchObject({ method: 'DELETE' })
    expect(calls[5]?.path).toContain('/record-1')
    expect(JSON.parse(String(calls[5]?.init?.body))).toEqual({ version: 'v2' })
    expect(calls[6]?.path).toContain('/record-1/history?limit=5')
  })
})

describe('GET denials keep the machine-readable code', () => {
  it('surfaces the CP capability denial through listDreams (not just the status)', async () => {
    // Regression: apiGet used to build ApiError from the status alone, so the
    // console's DAEMON_FEATURE_MISSING branch was unreachable in production even
    // though a mocked ApiError made it look covered.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'Conflict',
            statusCode: 409,
            message: 'this agent version does not support memory dreaming; upgrade its daemon',
            code: 'DAEMON_FEATURE_MISSING'
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    await expect(listDreams('agent-1')).rejects.toMatchObject({
      status: 409,
      code: 'DAEMON_FEATURE_MISSING',
      message: 'this agent version does not support memory dreaming; upgrade its daemon'
    })
    await expect(listDreams('agent-1')).rejects.toBeInstanceOf(ApiError)
  })
})
