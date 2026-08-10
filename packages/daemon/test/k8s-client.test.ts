import { afterEach, describe, expect, it } from 'vitest'
import { getEventListeners } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import { InClusterConfigError, loadInClusterConfig } from '../src/k8s/config.js'
import { K8sApiError, K8sHttp } from '../src/k8s/http.js'
import { OperatingModeConflictError, SandboxApi, isSandboxReady } from '../src/k8s/sandbox-api.js'
import { watchCollection, type ResourceEvent } from '../src/k8s/watch.js'
import type { InClusterConfig } from '../src/k8s/config.js'

interface Route {
  (req: { method: string; url: URL; body: string; headers: Record<string, string | string[] | undefined> }): {
    status?: number
    json?: unknown
    /** Newline-delimited JSON objects, then close — how `?watch=true` responds. */
    lines?: unknown[]
    /** Hold the stream open after the lines instead of ending it. */
    hold?: boolean
  }
}

const servers: Server[] = []

async function fakeApiServer(route: Route): Promise<{ config: InClusterConfig; requests: URL[]; tokens: string[] }> {
  const requests: URL[] = []
  const tokens: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      requests.push(url)
      const auth = req.headers.authorization
      if (typeof auth === 'string') tokens.push(auth.replace(/^Bearer /, ''))
      const result = route({ method: req.method ?? 'GET', url, body, headers: req.headers })
      res.statusCode = result.status ?? 200
      res.setHeader('content-type', 'application/json')
      if (result.lines) {
        for (const line of result.lines) res.write(`${JSON.stringify(line)}\n`)
        if (!result.hold) res.end()
        return
      }
      res.end(JSON.stringify(result.json ?? {}))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let tokenReads = 0
  return {
    config: {
      server: `http://127.0.0.1:${port}`,
      namespace: 'org-test',
      // Every read returns a distinct value, so a client that captures the token
      // once (instead of re-reading the rotating projected file) is detectable.
      token: () => `token-${++tokenReads}`
    },
    requests,
    tokens
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

/** Minimal poll helper — the abort test only needs "the snapshot arrived". */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function take<T>(source: AsyncGenerator<T>, count: number): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) {
    out.push(item)
    if (out.length === count) break
  }
  return out
}

describe('in-cluster config', () => {
  it('builds the API server URL and reads the token per call, not once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sa-'))
    writeFileSync(join(dir, 'token'), 'first\n')
    writeFileSync(join(dir, 'namespace'), 'org-abc\n')
    writeFileSync(join(dir, 'ca.crt'), '-----BEGIN CERTIFICATE-----\n')
    const config = loadInClusterConfig({ KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' }, dir)
    expect(config.server).toBe('https://10.96.0.1:443')
    expect(config.namespace).toBe('org-abc')
    expect(config.ca).toContain('BEGIN CERTIFICATE')
    expect(config.token()).toBe('first')
    // The kubelet rotates the projected token in place; a long-lived daemon must
    // observe the new value rather than a boot-time snapshot.
    writeFileSync(join(dir, 'token'), 'rotated\n')
    expect(config.token()).toBe('rotated')
  })

  it('brackets an IPv6 API server address', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sa-'))
    writeFileSync(join(dir, 'token'), 't')
    writeFileSync(join(dir, 'namespace'), 'n')
    const config = loadInClusterConfig({ KUBERNETES_SERVICE_HOST: 'fd00::1', KUBERNETES_SERVICE_PORT: '443' }, dir)
    expect(config.server).toBe('https://[fd00::1]:443')
  })

  it('names the missing piece instead of returning a half-configured client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sa-'))
    expect(() => loadInClusterConfig({}, dir)).toThrow(InClusterConfigError)
    expect(() => loadInClusterConfig({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, dir)).toThrow(/token not found/)
    writeFileSync(join(dir, 'token'), 't')
    expect(() => loadInClusterConfig({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, dir)).toThrow(/namespace not found/)
  })
})

describe('K8sHttp', () => {
  it('re-reads the bearer token for every request', async () => {
    const { config, tokens } = await fakeApiServer(() => ({ json: { ok: true } }))
    const http = new K8sHttp(config)
    await http.json({ method: 'GET', path: '/healthz' })
    await http.json({ method: 'GET', path: '/healthz' })
    expect(tokens).toEqual(['token-1', 'token-2'])
  })

  it('surfaces a Status body as a typed error callers can branch on', async () => {
    const { config } = await fakeApiServer(() => ({
      status: 409,
      json: { kind: 'Status', reason: 'AlreadyExists', message: 'sandboxclaims "agent-a" already exists' }
    }))
    const http = new K8sHttp(config)
    const error = await http.json({ method: 'POST', path: '/x' }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(K8sApiError)
    const typed = error as K8sApiError
    expect(typed.status).toBe(409)
    expect(typed.reason).toBe('AlreadyExists')
    expect(typed.isAlreadyExists).toBe(true)
    expect(typed.isConflict).toBe(true)
    expect(typed.message).toContain('already exists')
  })

  it('treats a 410 as expired regardless of which side reports it', async () => {
    expect(new K8sApiError(410, undefined, 'gone').isExpired).toBe(true)
    expect(new K8sApiError(0, 'Expired', 'too old resource version').isExpired).toBe(true)
    expect(new K8sApiError(404, 'NotFound', 'nope').isExpired).toBe(false)
  })
})

describe('watchCollection', () => {
  it('seeds the resume point from the list and resumes the watch at that version', async () => {
    const { config, requests } = await fakeApiServer(({ url }) =>
      url.searchParams.get('watch')
        ? {
            lines: [
              { type: 'ADDED', object: { metadata: { name: 'a', resourceVersion: '11' } } },
              { type: 'MODIFIED', object: { metadata: { name: 'a', resourceVersion: '12' } } }
            ]
          }
        : { json: { metadata: { resourceVersion: '10' }, items: [{ metadata: { name: 'seed' } }] } }
    )
    const clock = new FakeClock()
    const events = await take(
      watchCollection(new K8sHttp(config), {
        path: '/apis/x/claims',
        clock,
        backoff: new Backoff({ jitter: () => 0 })
      }),
      3
    )
    expect(events[0]).toEqual({ kind: 'synced', items: [{ metadata: { name: 'seed' } }] })
    expect(events[1]?.kind).toBe('added')
    expect(events[2]?.kind).toBe('modified')
    const watchRequest = requests.find((url) => url.searchParams.get('watch'))
    expect(watchRequest?.searchParams.get('resourceVersion')).toBe('10')
    // Bookmarks are what keep an idle watch's resume point fresh enough to reuse.
    expect(watchRequest?.searchParams.get('allowWatchBookmarks')).toBe('true')
  })

  it('advances the resume point on a BOOKMARK without emitting it', async () => {
    let watches = 0
    const { config, requests } = await fakeApiServer(({ url }) => {
      if (!url.searchParams.get('watch')) return { json: { metadata: { resourceVersion: '10' }, items: [] } }
      watches += 1
      return watches === 1
        ? { lines: [{ type: 'BOOKMARK', object: { metadata: { resourceVersion: '77' } } }] }
        : { lines: [{ type: 'ADDED', object: { metadata: { name: 'later', resourceVersion: '78' } } }] }
    })
    const clock = new FakeClock()
    const events = await take(
      watchCollection(new K8sHttp(config), {
        path: '/apis/x/claims',
        clock,
        backoff: new Backoff({ jitter: () => 0 })
      }),
      2
    )
    // synced, then the post-reconnect ADDED — the bookmark itself is not an event.
    expect(events.map((event) => event.kind)).toEqual(['synced', 'added'])
    const watchVersions = requests
      .filter((url) => url.searchParams.get('watch'))
      .map((url) => url.searchParams.get('resourceVersion'))
    expect(watchVersions).toEqual(['10', '77'])
  })

  it('re-lists when the resume point has expired, rather than failing the watch', async () => {
    let lists = 0
    let watches = 0
    const { config } = await fakeApiServer(({ url }) => {
      if (!url.searchParams.get('watch')) {
        lists += 1
        return { json: { metadata: { resourceVersion: lists === 1 ? '10' : '900' }, items: [] } }
      }
      watches += 1
      if (watches === 1) return { status: 410, json: { kind: 'Status', reason: 'Expired', code: 410 } }
      return { lines: [{ type: 'ADDED', object: { metadata: { name: 'fresh', resourceVersion: '901' } } }] }
    })
    const clock = new FakeClock()
    const events = await take(
      watchCollection(new K8sHttp(config), {
        path: '/apis/x/claims',
        clock,
        backoff: new Backoff({ jitter: () => 0 })
      }),
      3
    )
    // A 410 forces a fresh snapshot; the consumer sees a second `synced` and can
    // converge instead of assuming its incremental view is still valid.
    expect(events.map((event) => event.kind)).toEqual(['synced', 'synced', 'added'])
    expect(lists).toBe(2)
  })

  it('re-lists on an in-band Expired ERROR event', async () => {
    let lists = 0
    let watches = 0
    const { config } = await fakeApiServer(({ url }) => {
      if (!url.searchParams.get('watch')) {
        lists += 1
        return { json: { metadata: { resourceVersion: `${lists}0` }, items: [] } }
      }
      watches += 1
      return watches === 1
        ? { lines: [{ type: 'ERROR', object: { kind: 'Status', reason: 'Expired', code: 410 } }] }
        : { lines: [{ type: 'ADDED', object: { metadata: { name: 'after', resourceVersion: '31' } } }] }
    })
    const events = await take(
      watchCollection(new K8sHttp(config), {
        path: '/apis/x/claims',
        clock: new FakeClock(),
        backoff: new Backoff({ jitter: () => 0 })
      }),
      3
    )
    expect(events.map((event) => event.kind)).toEqual(['synced', 'synced', 'added'])
    expect(lists).toBe(2)
  })

  it('backs off a failed connection without accumulating abort listeners', async () => {
    let lists = 0
    const { config } = await fakeApiServer(() => {
      lists += 1
      return lists < 4
        ? { status: 500, json: { kind: 'Status', reason: 'InternalError', message: 'apiserver down' } }
        : { json: { metadata: { resourceVersion: '10' }, items: [] } }
    })
    const controller = new AbortController()
    const clock = new FakeClock()
    const source = watchCollection(new K8sHttp(config), {
      path: '/apis/x/claims',
      signal: controller.signal,
      clock,
      backoff: new Backoff({ jitter: () => 0 })
    })
    const collected: string[] = []
    const drain = (async () => {
      for await (const event of source) {
        collected.push(event.kind)
        break
      }
    })()
    // Each failed list parks on a clock-driven delay; advancing releases it. A retry
    // whose timer wins must unregister its listener, or a long outage grows them
    // without bound on this one long-lived signal.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitUntil(() => lists === attempt + 1)
      clock.advance(60_000)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    }
    await drain
    expect(collected).toEqual(['synced'])
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    controller.abort()
  })

  it('returns immediately from a backoff delay on an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const { config } = await fakeApiServer(() => ({ status: 500, json: { kind: 'Status' } }))
    const clock = new FakeClock()
    const collected: string[] = []
    // The loop must not park on a full backoff delay when the signal is already
    // aborted before the listener is registered.
    for await (const event of watchCollection(new K8sHttp(config), {
      path: '/apis/x/claims',
      signal: controller.signal,
      clock,
      backoff: new Backoff({ jitter: () => 0 })
    })) {
      collected.push(event.kind)
    }
    expect(collected).toEqual([])
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const { config } = await fakeApiServer(({ url }) =>
      url.searchParams.get('watch')
        ? { lines: [], hold: true }
        : { json: { metadata: { resourceVersion: '1' }, items: [] } }
    )
    const source = watchCollection(new K8sHttp(config), {
      path: '/apis/x/claims',
      signal: controller.signal,
      clock: new FakeClock()
    })
    const collected: ResourceEvent<never>[] = []
    const drain = (async () => {
      for await (const event of source) collected.push(event as ResourceEvent<never>)
    })()
    await waitUntil(() => collected.length === 1)
    controller.abort()
    await drain
    expect(collected.map((event) => event.kind)).toEqual(['synced'])
  })
})

describe('SandboxApi', () => {
  it('addresses v1beta1 collections in the pod namespace', async () => {
    const { config, requests } = await fakeApiServer(() => ({ json: { metadata: { name: 'agent-a' } } }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await api.getClaim('agent-a')
    await api.getSandbox('sb-1')
    expect(requests.map((url) => url.pathname)).toEqual([
      '/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/org-test/sandboxclaims/agent-a',
      '/apis/agents.x-k8s.io/v1beta1/namespaces/org-test/sandboxes/sb-1'
    ])
  })

  it('treats an existing claim as success so a retried create converges', async () => {
    let posts = 0
    const { config, requests } = await fakeApiServer(({ method }) => {
      if (method === 'POST') {
        posts += 1
        return { status: 409, json: { kind: 'Status', reason: 'AlreadyExists', message: 'exists' } }
      }
      return { json: { metadata: { name: 'agent-a' }, status: { sandbox: { name: 'sb-7' } } } }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const claim = await api.ensureClaim({ metadata: { name: 'agent-a' }, spec: { warmPoolRef: { name: 'pool' } } })
    expect(posts).toBe(1)
    // The claim names the bound Sandbox and nothing more; its UID comes from that
    // object's metadata, which is what the spawn record has to key on.
    expect(claim.status?.sandbox?.name).toBe('sb-7')
    expect(requests.at(-1)?.pathname).toContain('/sandboxclaims/agent-a')
  })

  it('sends a claim body carrying the pool reference and no per-agent env', async () => {
    let received: any
    const { config } = await fakeApiServer(({ body }) => {
      if (body) received = JSON.parse(body)
      return { json: {} }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await api.ensureClaim({
      metadata: { name: 'agent-a' },
      spec: {
        warmPoolRef: { name: 'ac-runtime-standard-pool' },
        additionalPodMetadata: { labels: { 'agentconnect.md/agent': 'a' } }
      }
    })
    expect(received.apiVersion).toBe('extensions.agents.x-k8s.io/v1beta1')
    expect(received.kind).toBe('SandboxClaim')
    expect(received.spec.warmPoolRef.name).toBe('ac-runtime-standard-pool')
    // A claim carrying `env` or `volumeClaimTemplates` bypasses warm-pool adoption,
    // so the shape this client sends must never grow them.
    expect(received.spec.env).toBeUndefined()
    expect(received.spec.volumeClaimTemplates).toBeUndefined()
  })

  it('treats deleting an absent claim as success', async () => {
    const { config } = await fakeApiServer(() => ({ status: 404, json: { kind: 'Status', reason: 'NotFound' } }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await expect(api.deleteClaim('gone')).resolves.toBeUndefined()
  })

  it('guards an operatingMode patch with a test op on the value it observed', async () => {
    let patch: any
    let contentType: string | undefined
    const { config } = await fakeApiServer(({ body, headers }) => {
      if (body) patch = JSON.parse(body)
      contentType = headers['content-type'] as string | undefined
      return { json: { spec: { operatingMode: 'Running' } } }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await api.setOperatingMode('sb-1', 'Running', 'Suspended')
    expect(contentType).toBe('application/json-patch+json')
    expect(patch).toEqual([
      { op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
      { op: 'replace', path: '/spec/operatingMode', value: 'Running' }
    ])
  })

  it('carries the guard on the suspend direction too — there is no unguarded path', async () => {
    let patch: any
    const { config } = await fakeApiServer(({ body }) => {
      if (body) patch = JSON.parse(body)
      return { json: {} }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await api.setOperatingMode('sb-1', 'Suspended', 'Running')
    expect(patch).toEqual([
      { op: 'test', path: '/spec/operatingMode', value: 'Running' },
      { op: 'replace', path: '/spec/operatingMode', value: 'Suspended' }
    ])
  })

  it('reports a lost race as a typed conflict, from the 422 the API server really sends', async () => {
    // A failed JSON Patch `test` comes back as 422 Invalid — never 409 — and its message
    // text comes from the patch library, so classification cannot rely on it.
    const { config, requests } = await fakeApiServer(({ method }) =>
      method === 'PATCH'
        ? {
            status: 422,
            json: {
              kind: 'Status',
              apiVersion: 'v1',
              status: 'Failure',
              code: 422,
              reason: 'Invalid',
              message: 'testing value /spec/operatingMode failed'
            }
          }
        : { json: { metadata: { name: 'sb-1' }, spec: { operatingMode: 'Running' } } }
    )
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const error = await api.setOperatingMode('sb-1', 'Suspended', 'Suspended').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OperatingModeConflictError)
    const typed = error as OperatingModeConflictError
    expect(typed.observed).toBe('Suspended')
    expect(typed.actual).toBe('Running')
    // Confirmed by re-reading the object, not by matching the message text.
    expect(requests.filter((url) => url.pathname.endsWith('/sandboxes/sb-1'))).toHaveLength(2)
  })

  it('does not dress an unrelated 422 up as a concurrency conflict', async () => {
    const { config } = await fakeApiServer(({ method }) =>
      method === 'PATCH'
        ? {
            status: 422,
            json: { kind: 'Status', code: 422, reason: 'Invalid', message: 'spec.operatingMode: Unsupported value' }
          }
        : // The guard held — the mode is still what we observed — so the 422 came from
          // something else and must surface as itself.
          { json: { metadata: { name: 'sb-1' }, spec: { operatingMode: 'Running' } } }
    )
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const error = await api.setOperatingMode('sb-1', 'Suspended', 'Running').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(K8sApiError)
    expect(error).not.toBeInstanceOf(OperatingModeConflictError)
    expect((error as K8sApiError).isUnprocessable).toBe(true)
  })

  it('surfaces the original error when the confirming read is unavailable', async () => {
    const { config } = await fakeApiServer(({ method }) =>
      method === 'PATCH'
        ? { status: 422, json: { kind: 'Status', code: 422, reason: 'Invalid', message: 'rejected' } }
        : { status: 500, json: { kind: 'Status', code: 500, reason: 'InternalError' } }
    )
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const error = await api.setOperatingMode('sb-1', 'Suspended', 'Running').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(K8sApiError)
    expect((error as K8sApiError).status).toBe(422)
  })

  it('reviews a shim token with its audience and returns the bound pod identity', async () => {
    let sent: any
    const { config, requests } = await fakeApiServer(({ body }) => {
      sent = JSON.parse(body)
      return {
        json: {
          status: {
            authenticated: true,
            user: {
              username: 'system:serviceaccount:org-test:ac-runtime',
              extra: {
                'authentication.kubernetes.io/pod-name': ['runtime-abc'],
                'authentication.kubernetes.io/pod-uid': ['uid-123']
              }
            }
          }
        }
      }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const result = await api.reviewToken('shim-token', ['ac-daemon-callback'])
    // Cluster-scoped path: no namespace segment, which is why this needs its own
    // ClusterRole rather than the per-namespace Role.
    expect(requests[0]?.pathname).toBe('/apis/authentication.k8s.io/v1/tokenreviews')
    // Without the audience the API server would accept a token minted for anything.
    expect(sent.spec.audiences).toEqual(['ac-daemon-callback'])
    expect(result).toEqual({
      authenticated: true,
      podName: 'runtime-abc',
      podUid: 'uid-123',
      username: 'system:serviceaccount:org-test:ac-runtime'
    })
  })

  it('reports an unauthenticated review with its reason and no pod identity', async () => {
    const { config } = await fakeApiServer(() => ({
      json: { status: { authenticated: false, error: 'audiences is not valid for this token' } }
    }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const result = await api.reviewToken('wrong-audience', ['ac-daemon-callback'])
    expect(result.authenticated).toBe(false)
    expect(result.podName).toBeUndefined()
    expect(result.error).toMatch(/audiences/)
  })

  it('reads Ready off the Sandbox conditions', () => {
    expect(isSandboxReady({ status: { conditions: [{ type: 'Ready', status: 'True' }] } })).toBe(true)
    expect(isSandboxReady({ status: { conditions: [{ type: 'Ready', status: 'False' }] } })).toBe(false)
    expect(isSandboxReady({})).toBe(false)
  })

  it('exposes the Sandbox UID from object metadata, the only place it exists', async () => {
    const { config } = await fakeApiServer(() => ({
      json: { metadata: { name: 'sb-7', uid: 'sandbox-uid-9' }, spec: { operatingMode: 'Running' } }
    }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const sandbox = await api.getSandbox('sb-7')
    expect(sandbox.metadata?.uid).toBe('sandbox-uid-9')
  })
})
