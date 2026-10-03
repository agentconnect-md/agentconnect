import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  CodeHostRepository,
  SOURCE_CACHE_RESOLUTION_TTL_MS,
  type CodeHostCredentialRequest,
  type Source
} from '../src/source-cache/code-host-repository.js'

const GITHUB_SHA = 'a'.repeat(40)
const NEXT_SHA = 'b'.repeat(40)
const GITLAB_SHA = 'c'.repeat(40)
const GITHUB_HEAD = 'https://api.github.com/repositories/42'
const GITHUB_COMMIT = 'https://api.github.com/repos/acme/repo/commits/main'
const GITLAB_PROJECT = 'https://gitlab.com/api/v4/projects/4455667'
const GITLAB_COMMIT = 'https://gitlab.com/api/v4/projects/4455667/repository/commits/main'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function rawJson(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function githubSource(overrides: Partial<Source> = {}): Source {
  return {
    cloneUrl: 'https://github.com/acme/repo.git',
    ref: 'main',
    credential: { provider: 'github' },
    codeHostRepository: { provider: 'github', externalId: '42', path: 'acme/repo' },
    ...overrides
  }
}

function gitlabSource(overrides: Partial<Source> = {}): Source {
  return {
    cloneUrl: 'https://gitlab.com/group/project.git',
    ref: 'main',
    credential: { provider: 'gitlab', projectId: '4455667' },
    codeHostRepository: { provider: 'gitlab', externalId: '4455667', path: 'group/project' },
    ...overrides
  }
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>
    })
    return await handler(url)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function successfulGithubFetch(): ReturnType<typeof fakeFetch> {
  return fakeFetch((url) => {
    if (url === GITHUB_HEAD) return json({ id: '42', full_name: 'acme/repo' })
    if (url === GITHUB_COMMIT) return new Response(GITHUB_SHA)
    throw new Error(`unexpected GitHub request: ${url}`)
  })
}

function successfulGitlabFetch(): ReturnType<typeof fakeFetch> {
  return fakeFetch((url) => {
    if (url === GITLAB_PROJECT) return json({ id: 4_455_667, path_with_namespace: 'group/project' })
    if (url === GITLAB_COMMIT) return json({ id: GITLAB_SHA, project_id: 4_455_667 })
    throw new Error(`unexpected GitLab request: ${url}`)
  })
}

describe('CodeHostRepository.resolveRef', () => {
  it('resolves GitHub through the numeric identity fence and commit lookup', async () => {
    const { fetchImpl, calls } = successfulGithubFetch()
    const credentialProvider = vi.fn(async (_request: CodeHostCredentialRequest) => 'ghs_installation')
    const repository = new CodeHostRepository({ fetch: fetchImpl, credentialProvider })

    const resolved = await repository.resolveRef(githubSource(), { agentId: 'agent-a' })

    expect(resolved).toMatchObject({
      commit: GITHUB_SHA,
      ref: 'main',
      accessClass: 'cred',
      agentId: 'agent-a',
      repository: { provider: 'github', externalId: '42', path: 'acme/repo' }
    })
    expect(calls.map((call) => call.url)).toEqual([GITHUB_HEAD, GITHUB_COMMIT, GITHUB_HEAD])
    expect(calls.every((call) => call.headers.authorization === 'Bearer ghs_installation')).toBe(true)
    expect(credentialProvider).toHaveBeenCalledTimes(1)
  })

  it('resolves GitLab through its project identity and project commit API', async () => {
    const { fetchImpl, calls } = successfulGitlabFetch()
    const credentialProvider = vi.fn(async (_request: CodeHostCredentialRequest) => 'glpat-read')
    const repository = new CodeHostRepository({ fetch: fetchImpl, credentialProvider })

    const resolved = await repository.resolveRef(gitlabSource(), { agentId: 'agent-a' })

    expect(resolved).toMatchObject({
      commit: GITLAB_SHA,
      ref: 'main',
      accessClass: 'cred',
      agentId: 'agent-a',
      repository: { provider: 'gitlab', externalId: '4455667', path: 'group/project' }
    })
    expect(calls.map((call) => call.url)).toEqual([GITLAB_PROJECT, GITLAB_COMMIT])
    expect(calls.every((call) => call.headers['private-token'] === 'glpat-read')).toBe(true)
  })

  it('resolves a pinned commit through the identity fence without a commit lookup', async () => {
    const { fetchImpl, calls } = successfulGithubFetch()
    const repository = new CodeHostRepository({ fetch: fetchImpl })

    const resolved = await repository.resolveRef(githubSource({ ref: GITHUB_SHA, credential: undefined }), {
      agentId: 'agent-a'
    })

    expect(resolved.commit).toBe(GITHUB_SHA)
    expect(resolved.accessClass).toBe('anon')
    expect(calls.map((call) => call.url)).toEqual([GITHUB_HEAD])
  })

  it('fails closed on a missing GitHub repository and does not cache the failure', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url === GITHUB_HEAD) return new Response('', { status: 404 })
      throw new Error(`unexpected GitHub request: ${url}`)
    })
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'ghs_installation'
    })

    await expect(repository.resolveRef(githubSource(), { agentId: 'agent-a' })).rejects.toThrow(/status 404/)
    expect(calls.map((call) => call.url)).toEqual([GITHUB_HEAD])
  })

  it('fails closed on a GitHub numeric identity mismatch', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url === GITHUB_HEAD) {
        return rawJson('{"id":9007199254740993,"full_name":"acme/repo"}')
      }
      throw new Error(`unexpected GitHub request: ${url}`)
    })
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'ghs_installation'
    })

    await expect(repository.resolveRef(githubSource(), { agentId: 'agent-a' })).rejects.toThrow(
      /identity does not match/
    )
    expect(calls.map((call) => call.url)).toEqual([GITHUB_HEAD])
  })

  it('rechecks GitHub numeric identity after the commit lookup', async () => {
    let identityCalls = 0
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url === GITHUB_HEAD) {
        identityCalls += 1
        return identityCalls === 1 ? json({ id: '42', full_name: 'acme/repo' }) : new Response('', { status: 404 })
      }
      if (url === GITHUB_COMMIT) return new Response(GITHUB_SHA)
      throw new Error(`unexpected GitHub request: ${url}`)
    })
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'ghs_installation'
    })

    await expect(repository.resolveRef(githubSource(), { agentId: 'agent-a' })).rejects.toThrow(/status 404/)
    expect(calls.map((call) => call.url)).toEqual([GITHUB_HEAD, GITHUB_COMMIT, GITHUB_HEAD])
  })

  it('fails closed on a GitHub commit HTTP error', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url === GITHUB_HEAD) return json({ id: '42', full_name: 'acme/repo' })
      if (url === GITHUB_COMMIT) return new Response('', { status: 500 })
      throw new Error(`unexpected GitHub request: ${url}`)
    })
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'ghs_installation'
    })

    await expect(repository.resolveRef(githubSource(), { agentId: 'agent-a' })).rejects.toThrow(/status 500/)
    expect(calls.map((call) => call.url)).toEqual([GITHUB_HEAD, GITHUB_COMMIT])
  })

  it('fails closed on a GitLab project not found', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('', { status: 404 }))
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'glpat-read'
    })

    await expect(repository.resolveRef(gitlabSource(), { agentId: 'agent-a' })).rejects.toThrow(/status 404/)
    expect(calls.map((call) => call.url)).toEqual([GITLAB_PROJECT])
  })

  it('fails closed on a GitLab project identity mismatch', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ id: 4_455_668, path_with_namespace: 'group/project' }))
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'glpat-read'
    })

    await expect(repository.resolveRef(gitlabSource(), { agentId: 'agent-a' })).rejects.toThrow(
      /identity does not match/
    )
    expect(calls.map((call) => call.url)).toEqual([GITLAB_PROJECT])
  })

  it('fails closed when a GitLab commit names another project', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url === GITLAB_PROJECT) return json({ id: 4_455_667, path_with_namespace: 'group/project' })
      if (url === GITLAB_COMMIT) return json({ id: GITLAB_SHA, project_id: 4_455_668 })
      throw new Error(`unexpected GitLab request: ${url}`)
    })
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'glpat-read'
    })

    await expect(repository.resolveRef(gitlabSource(), { agentId: 'agent-a' })).rejects.toThrow(/different project/)
    expect(calls.map((call) => call.url)).toEqual([GITLAB_PROJECT, GITLAB_COMMIT])
  })

  it('fails closed on a GitLab commit HTTP error', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url === GITLAB_PROJECT) return json({ id: 4_455_667, path_with_namespace: 'group/project' })
      if (url === GITLAB_COMMIT) return new Response('', { status: 503 })
      throw new Error(`unexpected GitLab request: ${url}`)
    })
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'glpat-read'
    })

    await expect(repository.resolveRef(gitlabSource(), { agentId: 'agent-a' })).rejects.toThrow(/status 503/)
    expect(calls.map((call) => call.url)).toEqual([GITLAB_PROJECT, GITLAB_COMMIT])
  })

  it('fails closed when the transport itself fails', async () => {
    const repository = new CodeHostRepository({
      fetch: (async () => {
        throw new Error('socket hang up')
      }) as typeof fetch,
      credentialProvider: async () => 'ghs_installation'
    })

    await expect(repository.resolveRef(githubSource(), { agentId: 'agent-a' })).rejects.toThrow(/request failed/)
  })

  it('does not request a credential for an anonymous GitLab Source', async () => {
    const { fetchImpl, calls } = successfulGitlabFetch()
    const credentialProvider = vi.fn(async () => 'must-not-be-used')
    const repository = new CodeHostRepository({ fetch: fetchImpl, credentialProvider })

    await repository.resolveRef(gitlabSource({ credential: undefined }), { agentId: 'agent-a' })

    expect(credentialProvider).not.toHaveBeenCalled()
    expect(calls.every((call) => call.headers['private-token'] === undefined)).toBe(true)
  })

  it('does not request a credential for an anonymous Source, even when it looks private', async () => {
    const { fetchImpl, calls } = successfulGithubFetch()
    const credentialProvider = vi.fn(async () => 'must-not-be-used')
    const repository = new CodeHostRepository({ fetch: fetchImpl, credentialProvider })

    await repository.resolveRef(githubSource({ credential: undefined }), { agentId: 'agent-a' })

    expect(credentialProvider).not.toHaveBeenCalled()
    expect(calls.every((call) => call.headers.authorization === undefined)).toBe(true)
  })

  it('caches a trusted result for 60 seconds and refreshes it when stale', async () => {
    let now = 1_000
    let calls = 0
    const { fetchImpl } = fakeFetch((url) => {
      calls += 1
      if (url === GITHUB_HEAD) return json({ id: '42', full_name: 'acme/repo' })
      if (url === GITHUB_COMMIT) return new Response(calls < 4 ? GITHUB_SHA : NEXT_SHA)
      throw new Error(`unexpected GitHub request: ${url}`)
    })
    const credentialProvider = vi.fn(async () => 'ghs_installation')
    const repository = new CodeHostRepository({ fetch: fetchImpl, credentialProvider, now: () => now })
    const ask = () => repository.resolveRef(githubSource(), { agentId: 'agent-a' })

    expect((await ask()).commit).toBe(GITHUB_SHA)
    now += SOURCE_CACHE_RESOLUTION_TTL_MS - 1
    expect((await ask()).commit).toBe(GITHUB_SHA)
    expect(calls).toBe(3)
    expect(credentialProvider).toHaveBeenCalledTimes(1)

    now += 1
    expect((await ask()).commit).toBe(NEXT_SHA)
    expect(calls).toBe(6)
    expect(credentialProvider).toHaveBeenCalledTimes(2)
  })

  it('revalidates a stale GitHub commit with its ETag and keeps it on 304', async () => {
    let now = 1_000
    let commitCalls = 0
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url === GITHUB_HEAD) return json({ id: '42', full_name: 'acme/repo' })
      if (url === GITHUB_COMMIT) {
        commitCalls += 1
        return commitCalls === 1
          ? new Response(GITHUB_SHA, { headers: { etag: 'W/\"one\"' } })
          : new Response(null, { status: 304 })
      }
      throw new Error(`unexpected GitHub request: ${url}`)
    })
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'ghs_installation',
      now: () => now
    })
    const ask = () => repository.resolveRef(githubSource(), { agentId: 'agent-a' })

    expect((await ask()).commit).toBe(GITHUB_SHA)
    now += SOURCE_CACHE_RESOLUTION_TTL_MS
    expect((await ask()).commit).toBe(GITHUB_SHA)

    const commitRequests = calls.filter((call) => call.url === GITHUB_COMMIT)
    expect(commitRequests).toHaveLength(2)
    expect(commitRequests[1]!.headers['if-none-match']).toBe('W/\"one\"')
    expect(calls.map((call) => call.url)).toEqual([
      GITHUB_HEAD,
      GITHUB_COMMIT,
      GITHUB_HEAD,
      GITHUB_HEAD,
      GITHUB_COMMIT,
      GITHUB_HEAD
    ])
  })

  it('isolates credentialed resolutions by agent', async () => {
    const { fetchImpl, calls } = successfulGithubFetch()
    const seenAgents: string[] = []
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async (request) => {
        seenAgents.push(request.agentId)
        return `ghs_${request.agentId}`
      }
    })

    await repository.resolveRef(githubSource(), { agentId: 'agent-a' })
    await repository.resolveRef(githubSource(), { agentId: 'agent-b' })

    expect(seenAgents).toEqual(['agent-a', 'agent-b'])
    expect(calls).toHaveLength(6)
    expect(calls[0]!.headers.authorization).toBe('Bearer ghs_agent-a')
    expect(calls[3]!.headers.authorization).toBe('Bearer ghs_agent-b')
  })

  it('gates cred reads on a successful, unexpired resolution for the same agent and Source', async () => {
    let now = 1_000
    const { fetchImpl } = successfulGithubFetch()
    const repository = new CodeHostRepository({
      fetch: fetchImpl,
      credentialProvider: async () => 'ghs_installation',
      now: () => now
    })
    const read = vi.fn(async () => 'presigned-cred-url')
    const source = githubSource()

    await expect(repository.authorizeCredRead(undefined, source, 'agent-a', read)).rejects.toThrow(
      /successful credentialed resolveRef/
    )
    expect(read).not.toHaveBeenCalled()

    const resolution = await repository.resolveRef(source, { agentId: 'agent-a' })
    await expect(repository.authorizeCredRead(resolution, source, 'agent-b', read)).rejects.toThrow(
      /successful credentialed resolveRef/
    )
    expect(read).not.toHaveBeenCalled()

    const forged = { ...resolution } as typeof resolution
    await expect(repository.authorizeCredRead(forged, source, 'agent-a', read)).rejects.toThrow(
      /successful credentialed resolveRef/
    )
    await expect(
      repository.authorizeCredRead(resolution, { ...source, ref: 'release' }, 'agent-a', read)
    ).rejects.toThrow(/successful credentialed resolveRef/)
    expect(read).not.toHaveBeenCalled()

    await expect(repository.authorizeCredRead(resolution, source, 'agent-a', read)).resolves.toBe('presigned-cred-url')
    expect(read).toHaveBeenCalledTimes(1)

    now += SOURCE_CACHE_RESOLUTION_TTL_MS
    await expect(repository.authorizeCredRead(resolution, source, 'agent-a', read)).rejects.toThrow(
      /successful credentialed resolveRef/
    )
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('refuses to authorize a cred read with an anonymous resolution', async () => {
    const { fetchImpl } = successfulGithubFetch()
    const repository = new CodeHostRepository({ fetch: fetchImpl })
    const source = githubSource({ credential: undefined })
    const resolution = await repository.resolveRef(source, { agentId: 'agent-a' })
    const read = vi.fn(async () => 'must-not-be-read')

    await expect(repository.authorizeCredRead(resolution, source, 'agent-a', read)).rejects.toThrow(
      /successful credentialed resolveRef/
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('runs the GitLab adapter against a real loopback HTTP server', async () => {
    const seen: Array<{ path: string; token?: string }> = []
    const server = createServer((request, response) => {
      const path = request.url ?? ''
      seen.push({ path, token: request.headers['private-token'] as string | undefined })
      if (path === '/api/v4/projects/4455667') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ id: 4_455_667, path_with_namespace: 'group/project' }))
        return
      }
      if (path === '/api/v4/projects/4455667/repository/commits/main') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ id: GITLAB_SHA, project_id: 4_455_667 }))
        return
      }
      response.statusCode = 404
      response.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server did not expose a TCP address')
    const base = `http://127.0.0.1:${address.port}`
    try {
      const repository = new CodeHostRepository({
        fetch: globalThis.fetch,
        gitlabApiBaseUrl: `${base}/api/v4`,
        credentialProvider: async () => 'glpat-loopback'
      })
      const source: Source = {
        cloneUrl: `${base}/group/project.git`,
        ref: 'main',
        credential: { provider: 'gitlab', projectId: '4455667' },
        codeHostRepository: { provider: 'gitlab', externalId: '4455667', path: 'group/project' }
      }

      const resolved = await repository.resolveRef(source, { agentId: 'agent-a' })

      expect(resolved.commit).toBe(GITLAB_SHA)
      expect(seen).toEqual([
        { path: '/api/v4/projects/4455667', token: 'glpat-loopback' },
        { path: '/api/v4/projects/4455667/repository/commits/main', token: 'glpat-loopback' }
      ])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
