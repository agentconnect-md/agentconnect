import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  listDreams,
  setAgentWorkspace,
  createGithubHook,
  disconnectLinearWorkspace,
  leaveIntegrationConversation,
  reconnectLinearWorkspace,
  createMemoryRecord,
  deleteMemoryRecord,
  deleteOrgIcon,
  fetchAllGithubRepos,
  fetchGatewayAttribution,
  fetchConversations,
  fetchConversationByKey,
  fetchSessionFacets,
  fetchGithubRepoRoster,
  fetchMySessionIdentity,
  fetchMemoryAdminSurface,
  fmtCountCompact,
  invalidateGithubRepoRosterCache,
  putSessionVisibility,
  listMemoryRecordHistory,
  listMemoryFileHistory,
  listMemoryRecords,
  listOrganizationKnowledge,
  listOrganizationKnowledgeRevisions,
  listManagedSkills,
  listManagedSkillRevisions,
  listOrganizationSuggestions,
  fetchOrganizationSuggestionContent,
  createOrganizationKnowledge,
  updateOrganizationKnowledge,
  setOrganizationKnowledgeArchived,
  reviewOrganizationSuggestion,
  mintWebchatToken,
  searchMemoryRecords,
  setApiOrgId,
  updateGithubHook,
  updateMemoryRecord,
  uploadMyProfilePicture,
  uploadOrgIcon,
  usageWindow,
  fetchUsage
} from './api'

describe('session facet Agent labels', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps Session-scoped labels for Agents outside the visible Agent roster', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              agents: ['agent-hidden'],
              agentNames: { 'agent-hidden': 'Payments Agent' },
              integrations: [],
              channels: [],
              triggers: []
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    )

    await expect(fetchSessionFacets('org-1')).resolves.toEqual({
      agentIds: ['agent-hidden'],
      agentNames: { 'agent-hidden': 'Payments Agent' },
      integrations: [],
      channels: [],
      triggers: []
    })
  })
})

describe('fmtCountCompact', () => {
  it.each([
    [60, '60'],
    [45_267, '45K'],
    [101_817, '102K'],
    [2_316_000, '2.32M'],
    [2_463_144, '2.46M'],
    [1_234_567_890, '1.23B'],
    [45_600_000_000, '46B'],
    [2_500_000_000_000, '2,500B'],
    [undefined, '—']
  ])('formats %s as %s', (value, expected) => {
    expect(fmtCountCompact(value)).toBe(expected)
  })
})

describe('session profile identity hints', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('checks Lark and Feishu as distinct linked social targets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              identities: [{ target: 'lark' }],
              hasSecurityVerificationMethod: true
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    )

    await expect(fetchMySessionIdentity('lark')).resolves.toEqual({ linked: true })
    await expect(fetchMySessionIdentity('feishu')).resolves.toEqual({ linked: false })
  })
})

describe('fetchGatewayAttribution', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  const usage = (extra: Record<string, unknown>) => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return new Response(
          JSON.stringify({
            from: 'x',
            to: 'y',
            totals: { sessions: 0, totalTokens: 0, costAmount: '0', costCurrency: null },
            agents: [{ agentId: 'agt_1', costAmount: '1' }],
            models: [],
            sources: [],
            series: { bucket: 'day', points: [] },
            ...extra
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    return calls
  }

  it('scopes the read to the gateway ingress a charge settles from', async () => {
    const calls = usage({})
    await fetchGatewayAttribution('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'org-1')
    expect(calls[0]).toContain('source=gateway')
  })

  it('returns projection MEMBERSHIP, unaffected by a withheld residual', async () => {
    // The billing exception (`session-visibility.md` §5): an id in `/usage.agents` is one
    // Analytics already names to this viewer, and that alone gates naming on the ledger —
    // a period-completeness gate was tried and blanked every org with one private session.
    const window = ['2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'org-1'] as const

    usage({ unattributed: { sessions: 2, totalTokens: 40, costAmount: '99' } })
    expect(await fetchGatewayAttribution(...window)).toEqual(new Set(['agt_1']))
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

describe('putSessionVisibility', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  it('PUTs the tier to the org-scoped session route and returns the cutover state', async () => {
    setApiOrgId('org-1')
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: 'acp-1',
            visibility: 'private',
            visibilityRev: 3,
            cascadedSessionIds: ['acp-child'],
            state: 'pending'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await putSessionVisibility('acp-1', 'private')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/orgs/org-1/sessions/acp-1/visibility')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({ visibility: 'private' })
    // `state: 'pending'` is what the detail view renders as "Applying…": the CP
    // read gates already apply, but no daemon has acked the capture change yet.
    expect(result).toMatchObject({ visibility: 'private', visibilityRev: 3, state: 'pending' })
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
      mode: 'git',
      gitRepo: 'org/repo',
      access: 'write'
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
      mode: 'git',
      gitRepo: 'org/repo',
      access: 'write'
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

    // The family is create-only: it discriminates the row, and the update body
    // must not carry it (the row's family is immutable).
    await createGithubHook({ ...input, family: 'pull_request' })
    await updateGithubHook('hook-1', input)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      kind: 'github',
      family: 'pull_request',
      reviewPolicy: 'request_changes',
      reportingMode: 'check',
      gateMode: 'informational'
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ kind: 'github', ...input })
  })
})

describe('GitHub installation repositories', () => {
  afterEach(() => {
    invalidateGithubRepoRosterCache()
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  it('publishes pages progressively and reuses the completed roster', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const page = new URL(String(input)).searchParams.get('page')
      const repos =
        page === '1'
          ? [{ fullName: 'acme/alpha', private: true }]
          : page === '2'
            ? [{ fullName: 'acme/beta-private', private: true }]
            : [{ fullName: 'acme/gamma', private: false }]
      return new Response(JSON.stringify({ repos, totalCount: 101, privateReposHidden: page === '2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    const progress: string[][] = []
    const result = await fetchAllGithubRepos('installation-1', undefined, (partial) => {
      progress.push(partial.map((repo) => repo.fullName))
    })

    expect(result.repos.map((repo) => repo.fullName)).toEqual(['acme/alpha', 'acme/beta-private', 'acme/gamma'])
    expect(result.privateReposHidden).toBe(true)
    expect(progress[0]).toEqual(['acme/alpha'])
    expect(progress.at(-1)).toEqual(['acme/alpha', 'acme/beta-private', 'acme/gamma'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('perPage'))).toEqual([
      '50',
      '50',
      '50'
    ])

    await expect(fetchAllGithubRepos('installation-1')).resolves.toEqual(result)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('merges repository progress across installations', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const installationId = new URL(String(input)).pathname.split('/').at(-2)
      return new Response(
        JSON.stringify({
          repos: [{ fullName: `${installationId}/repo`, private: true }],
          totalCount: 1,
          privateReposHidden: false
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')
    const progress: string[][] = []

    const result = await fetchGithubRepoRoster(
      [{ id: 'installation-1' }, { id: 'installation-2' }],
      undefined,
      (repos) => progress.push(repos.map((repo) => repo.installationId))
    )

    expect(result).toMatchObject({ privateReposHidden: false, failed: false })
    expect(result.repos.map((repo) => repo.installationId)).toEqual(['installation-1', 'installation-2'])
    expect(progress.at(-1)).toEqual(['installation-1', 'installation-2'])
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
        new Response(
          JSON.stringify({
            repos: [{ fullName: 'acme/recovered', private: true }],
            totalCount: 1,
            privateReposHidden: false
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      )
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    await expect(fetchAllGithubRepos('installation-1')).resolves.toEqual({
      repos: [{ fullName: 'acme/recovered', private: true }],
      privateReposHidden: false
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a legacy identity denial as private repositories hidden without retrying', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'sign in with GitHub', code: 'GITHUB_IDENTITY_REQUIRED' }), {
          status: 403,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    await expect(fetchGithubRepoRoster([{ id: 'installation-1' }])).resolves.toEqual({
      repos: [],
      privateReposHidden: true,
      failed: false
    })
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
          totalCount: 51,
          privateReposHidden: false
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

describe('managed-memory history API', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  it('encodes the selected file and opaque pagination cursor', async () => {
    const cursor = '11111111-1111-4111-8111-111111111111'
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ events: [], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    await listMemoryFileHistory('agent-1', 'release notes.md', { cursor, limit: 5 })

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/orgs/org-1/agents/agent-1/memory/history?path=release+notes.md&cursor=${cursor}&limit=5`
    )
  })
})

describe('organization knowledge API', () => {
  afterEach(() => {
    setApiOrgId(null)
    vi.unstubAllGlobals()
  })

  it('uses the organization-scoped library, suggestion, and review routes', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    await listOrganizationKnowledge(true)
    await listManagedSkills(false)
    await listOrganizationSuggestions({ kind: 'skill', state: 'pending', query: 'deploy now' })

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/orgs/org-1/knowledge?includeArchived=true')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/orgs/org-1/managed-skills?includeArchived=false')
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      '/orgs/org-1/knowledge-suggestions?kind=skill&state=pending&query=deploy+now'
    )
  })

  it('sends immutable revision and review bodies without losing optional fields', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input)
      const body = path.endsWith('/content')
        ? {
            kind: 'knowledge',
            digest: `sha256:${'a'.repeat(64)}`,
            snapshotToken: `sha256:${'b'.repeat(64)}`,
            content: '# Safe',
            summary: null,
            tags: []
          }
        : {
            id: '11111111-1111-4111-8111-111111111111',
            title: 'Safe deploy',
            content: '# Safe',
            summary: null,
            tags: [],
            currentRevision: 1
          }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    setApiOrgId('org-1')

    await createOrganizationKnowledge({ title: 'Safe deploy', content: '# Safe', tags: ['deploy'] })
    await updateOrganizationKnowledge('knowledge one', {
      title: 'Safe deploy',
      content: '# Safer',
      summary: 'Runbook',
      tags: ['deploy'],
      expectedRevision: 3
    })
    await setOrganizationKnowledgeArchived('knowledge one', true)
    await listOrganizationKnowledgeRevisions('knowledge one')
    await listManagedSkillRevisions('skill one')
    await fetchOrganizationSuggestionContent('suggestion one')
    await reviewOrganizationSuggestion('suggestion one', 'reject', 'Duplicates the runbook')

    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      path: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }))
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { title: 'Safe deploy', content: '# Safe', tags: ['deploy'] }
    })
    expect(calls[1]).toMatchObject({
      path: expect.stringContaining('/knowledge/knowledge%20one'),
      method: 'PATCH',
      body: expect.objectContaining({ expectedRevision: 3, summary: 'Runbook' })
    })
    expect(calls[2]).toMatchObject({ method: 'POST', body: { archived: true } })
    expect(calls[3]).toMatchObject({
      path: expect.stringContaining('/knowledge/knowledge%20one/revisions'),
      method: 'GET'
    })
    expect(calls[4]).toMatchObject({
      path: expect.stringContaining('/managed-skills/skill%20one/revisions'),
      method: 'GET'
    })
    expect(calls[5]).toMatchObject({
      path: expect.stringContaining('/knowledge-suggestions/suggestion%20one/content'),
      method: 'GET'
    })
    expect(calls[6]).toMatchObject({
      method: 'POST',
      body: { decision: 'reject', reason: 'Duplicates the runbook' }
    })
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

describe('retention-purge projection (#485)', () => {
  afterEach(() => vi.unstubAllGlobals())

  const memberDto = (sessionId: string, agentId: string, contentPurgedAt: string | null) => ({
    sessionId,
    sessionKey: { platform: 'slack', channel: 'C1', thread: 'T1' },
    agentId,
    title: sessionId,
    status: null,
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    usage: null,
    triggeredBy: null,
    hookKind: null,
    channelName: null,
    triggeredByName: null,
    threadUrl: null,
    runtime: null,
    model: null,
    effort: null,
    fastMode: null,
    permissionMode: null,
    outputMode: null,
    daemonId: null,
    visibility: 'org',
    externalProvider: null,
    externalResolution: null,
    contentPurgedAt
  })

  const stubConversations = (sessions: unknown[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              conversations: [
                {
                  key: 'slack:C1:T1',
                  platform: 'slack',
                  channel: 'C1',
                  thread: 'T1',
                  sessions,
                  memberSessionIds: sessions.map((s) => (s as { sessionId: string }).sessionId)
                }
              ],
              total: 1,
              nextCursor: null
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    )

  it('marks a grouped row when a NON-representative member was purged', async () => {
    // The representative is intact; without projecting across members the purged
    // peer would be invisible in the list.
    stubConversations([memberDto('rep', 'agent-a', null), memberDto('peer', 'agent-b', '2026-08-04T09:00:00.000Z')])

    const page = await fetchConversations(undefined, 50, 'org-1')
    expect(page.sessions[0]).toMatchObject({
      id: 'rep',
      contentPurgedAt: '2026-08-04T09:00:00.000Z',
      contentPurgedPartial: true
    })
  })

  it('reports the earliest member purge and drops `partial` once every member is gone', async () => {
    stubConversations([
      memberDto('rep', 'agent-a', '2026-08-06T09:00:00.000Z'),
      memberDto('peer', 'agent-b', '2026-08-04T09:00:00.000Z')
    ])

    const page = await fetchConversations(undefined, 50, 'org-1')
    expect(page.sessions[0]!.contentPurgedAt).toBe('2026-08-04T09:00:00.000Z')
    expect(page.sessions[0]!.contentPurgedPartial).toBeUndefined()
  })

  it('leaves an intact conversation unmarked', async () => {
    stubConversations([memberDto('rep', 'agent-a', null), memberDto('peer', 'agent-b', null)])

    const page = await fetchConversations(undefined, 50, 'org-1')
    expect(page.sessions[0]!.contentPurgedAt).toBeUndefined()
  })
})

// The resolver's empty answer is the console's "not visible to you" verdict, so
// the flag that says the CP could not actually CHECK has to survive the call.
// The CP fails external access checks closed — an unverifiable member is simply
// omitted — which is what made a Slack blip read as a permanent denial.
describe('fetchConversationByKey degradation', () => {
  afterEach(() => vi.unstubAllGlobals())

  const respond = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    )

  it('keeps a degraded empty answer distinguishable from a real absence', async () => {
    respond({ conversations: [], total: 0, nextCursor: null, accessSyncDegraded: true, accessIssues: [] })

    await expect(fetchConversationByKey('k', 'org-1')).resolves.toEqual({
      conversation: null,
      accessSyncDegraded: true,
      accessIssues: []
    })
  })

  it('reports a healthy empty answer as a real absence', async () => {
    respond({ conversations: [], total: 0, nextCursor: null })

    await expect(fetchConversationByKey('k', 'org-1')).resolves.toEqual({
      conversation: null,
      accessSyncDegraded: false,
      accessIssues: []
    })
  })

  it('carries the issues through so the notice can name the cause', async () => {
    const issues = [{ provider: 'feishu', reason: 'quota', region: 'lark' }]
    respond({ conversations: [], total: 0, nextCursor: null, accessSyncDegraded: true, accessIssues: issues })

    await expect(fetchConversationByKey('k', 'org-1')).resolves.toMatchObject({ accessIssues: issues })
  })
})

describe('usage window', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('turns a console preset into the half-open window the route takes', () => {
    const now = new Date('2026-08-18T12:00:00.000Z')
    expect(usageWindow('d1', now)).toEqual({ from: '2026-08-17T12:00:00.000Z', to: '2026-08-18T12:00:00.000Z' })
    expect(usageWindow('d30', now).from).toBe('2026-07-19T12:00:00.000Z')
    expect(usageWindow('d90', now).from).toBe('2026-05-20T12:00:00.000Z')
  })

  it('sends from/to (and only sends source when scoped)', async () => {
    const urls: string[] = []
    const stub = () =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          urls.push(url)
          return new Response(
            JSON.stringify({
              from: 'x',
              to: 'y',
              totals: { sessions: 0, totalTokens: 0, costAmount: '0', costCurrency: null },
              agents: [],
              models: [],
              sources: [],
              series: { bucket: 'day', points: [] }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        })
      )
    stub()
    await fetchUsage('d7', 'org-1')
    await fetchUsage('d7', 'org-1', 'gateway')

    // The preset never reaches the wire — the window does.
    expect(urls[0]).not.toContain('range=')
    expect(urls[0]).toContain('from=')
    expect(urls[0]).toContain('to=')
    expect(urls[0]).not.toContain('source=')
    expect(urls[1]).toContain('source=gateway')
  })
})

describe('a POST that commands rather than creates', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stub = (res: () => Response) => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return res()
      })
    )
    return calls
  }

  it('resolves on 204 No Content instead of failing on the body it does not have', async () => {
    // The CP answers a no-content write with 204 (`response: { 204: z.null() }`) — the
    // convention across two dozen of its routes. Parsing that unconditionally threw a
    // SyntaxError on SUCCESS, so the caller reported a failure for work the server had
    // already committed and its retry hit an already-deleted row.
    stub(() => new Response(null, { status: 204 }))
    await expect(disconnectLinearWorkspace('bot-9')).resolves.toBeUndefined()
    await expect(
      leaveIntegrationConversation('int-1', { kind: 'conversation', channel: 'C1' })
    ).resolves.toBeUndefined()
  })

  it('still parses the body of a POST that returns a row', async () => {
    stub(
      () =>
        new Response(JSON.stringify({ id: 'c1', connectUrl: 'https://linear.app/oauth/authorize' }), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        })
    )
    await expect(reconnectLinearWorkspace('bot-9')).resolves.toEqual({
      id: 'c1',
      connectUrl: 'https://linear.app/oauth/authorize'
    })
  })

  it('still surfaces a refusal, with the server’s own sentence', async () => {
    stub(
      () =>
        new Response(JSON.stringify({ message: 'only a connected Linear workspace can be disconnected' }), {
          status: 409,
          headers: { 'content-type': 'application/json' }
        })
    )
    await expect(disconnectLinearWorkspace('bot-9')).rejects.toThrow(/only a connected Linear workspace/)
  })
})
