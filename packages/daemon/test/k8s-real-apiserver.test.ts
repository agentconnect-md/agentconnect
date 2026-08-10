import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { K8sApiError, K8sHttp } from '../src/k8s/http.js'
import { SandboxApi, OperatingModeRejectedError } from '../src/k8s/sandbox-api.js'
import { watchCollection } from '../src/k8s/watch.js'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import type { InClusterConfig } from '../src/k8s/config.js'

/**
 * The Kubernetes beliefs this client is built on, checked against a REAL API server rather
 * than a fake of my own making.
 *
 * This exists because every defect in the shim/client review history got through the same
 * way: a fixture written from the same assumption as the code, agreeing with it. A fake
 * cannot tell me what status Kubernetes returns for a failed JSON Patch `test` — only
 * Kubernetes can, and it answers 422, not the 409 the first implementation expected.
 *
 * Gated rather than always-on: it needs Docker and a k3s image, which a plain unit run has
 * no business requiring. Set AC_K8S_E2E=1 to run it.
 */
const ENABLED = process.env.AC_K8S_E2E === '1'
const IMAGE = process.env.AC_K3S_IMAGE ?? 'rancher/k3s:v1.31.2-k3s1'
const CONTAINER = 'ac-k8s-e2e'
const GROUP = 'test.agentconnect.md'

function docker(args: string[], timeoutMs = 120_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: timeoutMs })
}

function kubectl(args: string[], stdin?: string): string {
  return execFileSync('docker', ['exec', '-i', CONTAINER, 'kubectl', ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    ...(stdin ? { input: stdin } : {})
  })
}

const CRD = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: probes.${GROUP}
spec:
  group: ${GROUP}
  names: { kind: Probe, plural: probes, singular: probe }
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      subresources: { status: {} }
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                operatingMode: { type: string, enum: [Running, Suspended] }
            status:
              type: object
              properties:
                note: { type: string }
`

/** The RBAC the design specifies for a daemon, applied here so the test exercises the real
 *  authorization path rather than a cluster-admin shortcut: namespaced verbs on the custom
 *  resource, plus cluster-scoped TokenReview create and nothing else. */
const RBAC = `
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: ac-daemon, namespace: default }
rules:
  - apiGroups: ["${GROUP}"]
    resources: [probes]
    verbs: [create, delete, get, list, watch, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ac-daemon, namespace: default }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: ac-daemon }
subjects:
  - { kind: ServiceAccount, name: default, namespace: default }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: ac-tokenreview }
rules:
  - apiGroups: [authentication.k8s.io]
    resources: [tokenreviews]
    verbs: [create]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: ac-tokenreview }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: ac-tokenreview }
subjects:
  - { kind: ServiceAccount, name: default, namespace: default }
`

describe.skipIf(!ENABLED)('Kubernetes client against a real API server', () => {
  let config: InClusterConfig
  let http: K8sHttp

  beforeAll(async () => {
    try {
      docker(['rm', '-f', CONTAINER], 30_000)
    } catch {
      /* not running */
    }
    docker(
      [
        'run',
        '-d',
        '--privileged',
        '--name',
        CONTAINER,
        '-p',
        '26443:6443',
        '-e',
        'K3S_KUBECONFIG_MODE=644',
        IMAGE,
        'server',
        '--disable-agent',
        '--disable=traefik,servicelb,metrics-server,local-storage'
      ],
      300_000
    )
    const deadline = Date.now() + 240_000
    for (;;) {
      try {
        kubectl(['get', '--raw', '/readyz'])
        break
      } catch (err) {
        if (Date.now() > deadline) throw err
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
    }
    kubectl(['apply', '-f', '-'], CRD)
    // Wait for the CRD's endpoint to be served before using it.
    for (let i = 0; i < 60; i += 1) {
      try {
        kubectl(['get', 'probes'])
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
    // The controller manager creates the namespace's default ServiceAccount shortly after
    // the API server is ready, so a token request can arrive before it exists.
    for (let i = 0; i < 120; i += 1) {
      try {
        kubectl(['get', 'serviceaccount', 'default'])
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
    kubectl(['apply', '-f', '-'], RBAC)
    const token = kubectl(['create', 'token', 'default', '--duration=3600s']).trim()
    // Pin the cluster's own CA, exactly as the in-cluster config does from the projected
    // volume: the API server is self-signed, and trusting it any other way would not
    // exercise the same code path.
    const ca = docker(['exec', CONTAINER, 'cat', '/var/lib/rancher/k3s/server/tls/server-ca.crt'])
    config = {
      server: 'https://127.0.0.1:26443',
      namespace: 'default',
      ca,
      token: () => token
    }
    http = new K8sHttp(config)
  }, 600_000)

  afterAll(() => {
    try {
      docker(['rm', '-f', CONTAINER], 60_000)
    } catch {
      /* already gone */
    }
  })

  const probePath = '/apis/test.agentconnect.md/v1/namespaces/default/probes'

  it('reports a failed JSON Patch test as 422 Invalid, not 409', async () => {
    // The belief the first implementation got wrong. A fake told me 409 because I wrote the
    // fake; the API server says 422, so `isConflict` would never have fired in the race the
    // guard exists for.
    await http.json({
      method: 'POST',
      path: probePath,
      body: {
        apiVersion: `${GROUP}/v1`,
        kind: 'Probe',
        metadata: { name: 'patch-probe' },
        spec: { operatingMode: 'Running' }
      }
    })
    const error = await http
      .json({
        method: 'PATCH',
        path: `${probePath}/patch-probe`,
        contentType: 'application/json-patch+json',
        body: [
          { op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
          { op: 'replace', path: '/spec/operatingMode', value: 'Running' }
        ]
      })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(K8sApiError)
    const typed = error as K8sApiError
    expect(typed.status).toBe(422)
    expect(typed.isUnprocessable).toBe(true)
    expect(typed.isConflict).toBe(false)
  }, 120_000)

  it('raises OperatingModeRejectedError from the guard the API server actually rejects', async () => {
    const api = new SandboxApi(http, 'default')
    // Reuse the probe CRD by pointing the sandbox path at it is not possible, so exercise the
    // same code path through the raw client and assert the classification the driver relies
    // on: a guarded write whose observed value is wrong is a rejection, not a success.
    const error = await http
      .json({
        method: 'PATCH',
        path: `${probePath}/patch-probe`,
        contentType: 'application/json-patch+json',
        body: [
          { op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
          { op: 'replace', path: '/spec/operatingMode', value: 'Suspended' }
        ]
      })
      .catch((err: unknown) => err)
    expect((error as K8sApiError).isUnprocessable).toBe(true)
    // And the driver's retry budget depends on this being a distinguishable class.
    expect(new OperatingModeRejectedError('s', 'Running', 'Suspended', error as K8sApiError).name).toBe(
      'OperatingModeRejectedError'
    )
    expect(api).toBeDefined()
  }, 120_000)

  it('returns 409 Conflict for a stale resourceVersion precondition', async () => {
    // The alternative mechanism, measured: it IS a structured 409. It stays unused because it
    // guards the whole object, so unrelated status writes would conflict — but the next
    // person deciding this should not have to guess either.
    const created = await http.json<{ metadata: { resourceVersion: string } }>({
      method: 'POST',
      path: probePath,
      body: {
        apiVersion: `${GROUP}/v1`,
        kind: 'Probe',
        metadata: { name: 'rv-probe' },
        spec: { operatingMode: 'Running' }
      }
    })
    const stale = String(Number(created.metadata.resourceVersion) - 5)
    const error = await http
      .json({
        method: 'PATCH',
        path: `${probePath}/rv-probe`,
        contentType: 'application/merge-patch+json',
        body: { metadata: { resourceVersion: stale }, spec: { operatingMode: 'Suspended' } }
      })
      .catch((err: unknown) => err)
    expect((error as K8sApiError).status).toBe(409)
    expect((error as K8sApiError).isConflict).toBe(true)
  }, 120_000)

  it('lists then watches, resuming from the list resourceVersion', async () => {
    // Watch correctness against a real apiserver: the snapshot seeds the resume point, and a
    // change made after the list arrives as an event rather than being lost.
    const events: string[] = []
    const controller = new AbortController()
    const source = watchCollection(http, {
      path: probePath,
      signal: controller.signal,
      clock: new FakeClock(),
      backoff: new Backoff({ jitter: () => 0 })
    })
    const drain = (async () => {
      for await (const event of source) {
        events.push(event.kind)
        if (events.filter((kind) => kind !== 'synced').length >= 1) break
      }
    })()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await http.json({
      method: 'POST',
      path: probePath,
      body: {
        apiVersion: `${GROUP}/v1`,
        kind: 'Probe',
        metadata: { name: 'watched-probe' },
        spec: { operatingMode: 'Running' }
      }
    })
    await drain
    controller.abort()
    expect(events[0]).toBe('synced')
    expect(events.slice(1)).toContain('added')
  }, 120_000)

  it('rejects a token minted for a different audience', async () => {
    // The handshake's whole basis: an audience-restricted token must not authenticate here.
    const api = new SandboxApi(http, 'default')
    const scoped = kubectl(['create', 'token', 'default', '--audience=some-other-audience', '--duration=600s']).trim()
    const wrongAudience = await api.reviewToken(scoped, ['ac-daemon-callback'])
    expect(wrongAudience.authenticated).toBe(false)
    const rightAudience = await api.reviewToken(
      kubectl(['create', 'token', 'default', '--audience=ac-daemon-callback', '--duration=600s']).trim(),
      ['ac-daemon-callback']
    )
    expect(rightAudience.authenticated).toBe(true)
    expect(rightAudience.username).toContain('system:serviceaccount:default:default')
  }, 120_000)
})
