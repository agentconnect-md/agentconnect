import { afterEach, describe, expect, it } from 'vitest'
import { K8sApiError, K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import {
  GuardedResumeRejectedError,
  OperatingModeRejectedError,
  SandboxApi,
  isSandboxReady
} from '../src/k8s/sandbox-api.js'

// Generic config/http/watch coverage lives in packages/k8s-client; this file
// covers the daemon-owned agent-sandbox verb surface only.
afterEach(closeFakeApiServers)

describe('SandboxApi', () => {
  it('addresses v1beta1 collections in the pod namespace', async () => {
    const { config, requests } = await fakeApiServer(() => ({ json: { metadata: { name: 'agent-a' } } }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await api.getClaim('agent-a')
    await api.getSandbox('sb-1')
    await api.getWarmPool('runtime-pool')
    await api.getSandboxTemplate('runtime-template')
    expect(requests.map((url) => url.pathname)).toEqual([
      '/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/org-test/sandboxclaims/agent-a',
      '/apis/agents.x-k8s.io/v1beta1/namespaces/org-test/sandboxes/sb-1',
      '/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/org-test/sandboxwarmpools/runtime-pool',
      '/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/org-test/sandboxtemplates/runtime-template'
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
    const ensured = await api.ensureClaim({ metadata: { name: 'agent-a' }, spec: { warmPoolRef: { name: 'pool' } } })
    expect(posts).toBe(1)
    // The claim names the bound Sandbox and nothing more; its UID comes from that
    // object's metadata, which is what the spawn record has to key on.
    expect(ensured.claim.status?.sandbox?.name).toBe('sb-7')
    expect(requests.at(-1)?.pathname).toContain('/sandboxclaims/agent-a')
    // AlreadyExists is NOT a cold start: this launch pays no PVC provisioning and no image
    // pull, and reporting it as one would put resume latencies in the cold-start distribution.
    expect(ensured.created).toBe(false)
  })

  it('WRITES the annotations onto a claim that already exists, so its version moves', async () => {
    // The reuse path is what an orphan sweep races: it lists a claim, proves the session gone, and
    // deletes on the version it listed. A reuse that only READ would leave that version standing and
    // let the delete take a live pod — the merge patch here is what makes the admission win instead.
    const requests: Array<{ method: string; contentType?: string; body?: unknown }> = []
    const { config } = await fakeApiServer(({ method, headers, body }) => {
      const contentType = headers['content-type']
      requests.push({
        method,
        ...(typeof contentType === 'string' ? { contentType } : {}),
        ...(body ? { body: JSON.parse(body) } : {})
      })
      if (method === 'POST')
        return { status: 409, json: { kind: 'Status', reason: 'AlreadyExists', message: 'exists' } }
      return { json: { metadata: { name: 'agent-a', resourceVersion: 'rv-2' } } }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const ensured = await api.ensureClaim({
      metadata: { name: 'agent-a', annotations: { 'agentconnect.md/last-admitted-at': '2026-08-14T10:00:00.000Z' } },
      spec: { warmPoolRef: { name: 'pool' } }
    })
    expect(ensured.created).toBe(false)
    expect(ensured.claim.metadata?.resourceVersion).toBe('rv-2')
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PATCH'])
    // A merge patch of the annotations alone: labels, spec and status are the caller's to leave alone.
    expect(requests[1]).toMatchObject({
      contentType: 'application/merge-patch+json',
      body: { metadata: { annotations: { 'agentconnect.md/last-admitted-at': '2026-08-14T10:00:00.000Z' } } }
    })
    expect(Object.keys((requests[1]!.body as { metadata: object }).metadata)).toEqual(['annotations'])
  })

  it('reports a first claim as CREATED, which is the cold-start signal', async () => {
    // The cold/resume split has to come from a fact, not from elapsed time — a latency metric
    // whose own bucketing is inferred from latency cannot settle a latency target.
    const { config } = await fakeApiServer(({ method }) =>
      method === 'POST'
        ? { status: 201, json: { metadata: { name: 'agent-b', uid: 'claim-uid' } } }
        : { json: { metadata: { name: 'agent-b' } } }
    )
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const ensured = await api.ensureClaim({ metadata: { name: 'agent-b' }, spec: { warmPoolRef: { name: 'pool' } } })
    expect(ensured.created).toBe(true)
    expect(ensured.claim.metadata?.uid).toBe('claim-uid')
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

  it('fences a GC delete to the listed claim incarnation', async () => {
    let received: any
    const { config } = await fakeApiServer(({ body }) => {
      received = JSON.parse(body)
      return { json: {} }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await expect(api.deleteClaimIfCurrent('probe-old', { uid: 'uid-old', resourceVersion: '17' })).resolves.toBe(true)
    expect(received).toEqual({
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: 'uid-old', resourceVersion: '17' }
    })
  })

  it('does not delete a replacement claim after the listed UID goes stale', async () => {
    const { config } = await fakeApiServer(() => ({
      status: 409,
      json: { kind: 'Status', reason: 'Conflict', message: 'UID precondition failed' }
    }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await expect(api.deleteClaimIfCurrent('probe-replaced', { uid: 'uid-old' })).resolves.toBe(false)
  })

  it('lists claims with a server-side label selector', async () => {
    const { config, requests } = await fakeApiServer(() => ({
      json: { items: [{ metadata: { name: 'agent-ac-runtime-probe-old' } }] }
    }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await expect(api.listClaims('agentconnect.md/runtime-probe=true')).resolves.toHaveLength(1)
    expect(requests[0]?.searchParams.get('labelSelector')).toBe('agentconnect.md/runtime-probe=true')
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

  it('guards a resume with the observed runtime name and image before replacing either state', async () => {
    let patch: any
    let contentType: string | undefined
    const { config } = await fakeApiServer(({ body, headers }) => {
      if (body) patch = JSON.parse(body)
      contentType = headers['content-type'] as string | undefined
      return { json: { spec: { operatingMode: 'Running' } } }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await api.resumeWithRuntimeImage('sb-1', {
      containerIndex: 1,
      observedName: 'runtime',
      observedImage: 'runtime:old',
      targetImage: 'runtime:new'
    })
    expect(contentType).toBe('application/json-patch+json')
    expect(patch).toEqual([
      { op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
      { op: 'test', path: '/spec/podTemplate/spec/containers/1/name', value: 'runtime' },
      { op: 'test', path: '/spec/podTemplate/spec/containers/1/image', value: 'runtime:old' },
      { op: 'replace', path: '/spec/podTemplate/spec/containers/1/image', value: 'runtime:new' },
      { op: 'replace', path: '/spec/operatingMode', value: 'Running' }
    ])
  })

  it('keeps the runtime guards when a resume image already matches', async () => {
    let patch: any
    const { config } = await fakeApiServer(({ body }) => {
      if (body) patch = JSON.parse(body)
      return { json: { spec: { operatingMode: 'Running' } } }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    await api.resumeWithRuntimeImage('sb-1', {
      containerIndex: 1,
      observedName: 'runtime',
      observedImage: 'runtime:new',
      targetImage: 'runtime:new'
    })
    expect(patch).toEqual([
      { op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
      { op: 'test', path: '/spec/podTemplate/spec/containers/1/name', value: 'runtime' },
      { op: 'test', path: '/spec/podTemplate/spec/containers/1/image', value: 'runtime:new' },
      { op: 'replace', path: '/spec/operatingMode', value: 'Running' }
    ])
  })

  it('reports a guarded resume rejection without guessing which precondition failed', async () => {
    const { config } = await fakeApiServer(() => ({
      status: 422,
      json: { kind: 'Status', code: 422, reason: 'Invalid', message: 'test failed' }
    }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const error = await api
      .resumeWithRuntimeImage('sb-1', {
        containerIndex: 1,
        observedName: 'runtime',
        observedImage: 'runtime:old',
        targetImage: 'runtime:new'
      })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(GuardedResumeRejectedError)
    expect((error as GuardedResumeRejectedError).cause.isUnprocessable).toBe(true)
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

  it('reports a rejected guarded write from the 422 the API server really sends', async () => {
    // A failed JSON Patch `test` comes back as 422 Invalid — never 409 — and its message
    // text comes from the patch library, so classification cannot rely on it either.
    const { config, requests } = await fakeApiServer(() => ({
      status: 422,
      json: {
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        code: 422,
        reason: 'Invalid',
        message: 'testing value /spec/operatingMode failed'
      }
    }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const error = await api.setOperatingMode('sb-1', 'Running', 'Suspended').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OperatingModeRejectedError)
    const typed = error as OperatingModeRejectedError
    expect(typed.observed).toBe('Suspended')
    expect(typed.requested).toBe('Running')
    expect(typed.cause.isUnprocessable).toBe(true)
    // No confirming read: a later snapshot is not evidence about why the patch failed.
    expect(requests).toHaveLength(1)
  })

  it('reports the same rejection when the mode changes away and back before any re-read', async () => {
    // The sequence that defeats confirm-by-read: we observed Suspended, another actor
    // set Running (so the guard correctly failed), then set it back to Suspended. A
    // post-failure read would see Suspended, match `observed`, and wrongly conclude the
    // guard held. Reporting the rejection without inferring state is immune to it.
    let patched = false
    const { config } = await fakeApiServer(({ method }) => {
      if (method === 'PATCH') {
        patched = true
        return { status: 422, json: { kind: 'Status', code: 422, reason: 'Invalid', message: 'test failed' } }
      }
      return { json: { metadata: { name: 'sb-1' }, spec: { operatingMode: 'Suspended' } } }
    })
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const error = await api.setOperatingMode('sb-1', 'Running', 'Suspended').catch((err: unknown) => err)
    expect(patched).toBe(true)
    expect(error).toBeInstanceOf(OperatingModeRejectedError)
  })

  it('passes through a rejection that is not a patch rejection', async () => {
    const { config } = await fakeApiServer(() => ({
      status: 403,
      json: { kind: 'Status', code: 403, reason: 'Forbidden', message: 'admission policy denied the update' }
    }))
    const api = new SandboxApi(new K8sHttp(config), 'org-test')
    const error = await api.setOperatingMode('sb-1', 'Suspended', 'Running').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(K8sApiError)
    expect(error).not.toBeInstanceOf(OperatingModeRejectedError)
    expect((error as K8sApiError).status).toBe(403)
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
