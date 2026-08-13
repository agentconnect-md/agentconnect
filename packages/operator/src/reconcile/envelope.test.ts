import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { CP_TOKEN_AUDIENCE } from '@agentconnect.md/protocol'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { loadConfig } from '../config.js'
import { AgentConnectOrgApi } from '../crd/api.js'
import { NAMESPACE_CLAIM_LABEL, type AgentConnectOrgSpec } from '../crd/types.js'
import { AgentConnectOrgSpecSchema } from '../crd/types.js'
import { newObservations, type ReconcileContext } from './context.js'
import { envelopeInputs, reconcileEnvelope, type EnvelopeInputs } from './envelope.js'
import { SANDBOX_EXTENSIONS_GROUP, groupPath, namespacePath } from './resources.js'

afterEach(closeFakeApiServers)

interface RecordedWrite {
  method: string
  path: string
  contentType?: string
  body?: unknown
}

/** GETs answer from a path map (404 otherwise); every write is recorded and echoed. */
function recorder() {
  const gets = new Map<string, unknown>()
  const writes: RecordedWrite[] = []
  const route: FakeRoute = ({ method, url, body, headers }) => {
    if (method === 'GET') {
      const hit = gets.get(url.pathname)
      if (hit === undefined) return { status: 404, json: { kind: 'Status', reason: 'NotFound', message: 'not found' } }
      return { json: hit }
    }
    const contentType = headers['content-type']
    writes.push({
      method,
      path: url.pathname,
      contentType: Array.isArray(contentType) ? contentType[0] : contentType,
      body: body ? JSON.parse(body) : undefined
    })
    return { json: {} }
  }
  return { gets, writes, route }
}

async function contextFor(route: FakeRoute, env: NodeJS.ProcessEnv = {}): Promise<ReconcileContext> {
  const { config: cluster } = await fakeApiServer(route)
  const http = new K8sHttp(cluster)
  return {
    http,
    orgApi: new AgentConnectOrgApi(http, cluster.namespace),
    config: loadConfig({
      AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-',
      AC_TOKENREVIEW_CLUSTERROLE: 'test-ac-tokenreview',
      AC_DAEMON_EGRESS_NAMESPACES: cluster.namespace,
      ...env
    }),
    controlNamespace: cluster.namespace,
    log: {}
  }
}

const NS = 'test-ac-org-acme'

const CP_URL = 'wss://api.example.test/daemon/ws'

function specOf(overrides: Partial<AgentConnectOrgSpec> = {}): AgentConnectOrgSpec {
  return AgentConnectOrgSpecSchema.parse({
    daemon: { image: 'ghcr.io/example/daemon:v1', tier: 'small' },
    controlPlane: { url: CP_URL },
    runtime: { image: 'ghcr.io/example/runtime:v1', tiers: [{ name: 'std', warmReplicas: 2 }] },
    ...overrides
  })
}

function inputOf(
  ctx: ReconcileContext,
  overrides: Partial<AgentConnectOrgSpec> = {},
  orgName = 'acme'
): EnvelopeInputs {
  return envelopeInputs(ctx, orgName, specOf(overrides))
}

const MASTER_TEMPLATE = {
  spec: {
    volumeClaimTemplatesPolicy: 'Disallowed',
    networkPolicy: { egress: [{ ports: [{ protocol: 'TCP', port: 1 }] }] },
    podTemplate: {
      spec: {
        containers: [
          {
            name: 'runtime',
            image: 'ghcr.io/example/runtime:v0',
            env: [{ name: 'AC_SHIM_ENDPOINT', value: 'ws://old' }]
          }
        ]
      }
    }
  }
}

function masterPath(controlNamespace: string): string {
  return groupPath(SANDBOX_EXTENSIONS_GROUP, controlNamespace, 'sandboxtemplates', 'ac-runtime-std')
}

const byPath = (writes: RecordedWrite[], suffix: string): RecordedWrite | undefined =>
  writes.find((write) => write.path.endsWith(suffix))

describe('reconcileEnvelope', () => {
  // No targetNamespace anywhere below unless a test sets one: NS is what the CR name derives.
  it('stamps the full inventory into a fresh namespace', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(ctx), obs)

    expect(obs.namespaceReady).toBe(true)
    expect(obs.namespace).toBe(NS)
    const ns = byPath(writes, `/namespaces/${NS}`)
    const nsBody = ns?.body as { metadata: { labels: Record<string, string> } }
    expect(nsBody.metadata.labels[NAMESPACE_CLAIM_LABEL]).toBe('acme')
    expect(nsBody.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('baseline')

    const runtimeSa = byPath(writes, '/serviceaccounts/ac-runtime')?.body as { automountServiceAccountToken?: boolean }
    expect(runtimeSa.automountServiceAccountToken).toBe(false)
    expect(byPath(writes, '/roles/ac-daemon')).toBeDefined()
    expect(byPath(writes, '/rolebindings/ac-daemon')).toBeDefined()

    const crb = byPath(writes, `/clusterrolebindings/ac-tokenreview-${NS}`)?.body as {
      roleRef: { name: string }
      subjects: Array<{ namespace: string }>
    }
    expect(crb.roleRef.name).toBe('test-ac-tokenreview')
    expect(crb.subjects[0].namespace).toBe(NS)

    expect(byPath(writes, '/networkpolicies/ac-daemon-egress')).toBeDefined()
    expect(byPath(writes, '/networkpolicies/ac-daemon-ingress')).toBeDefined()
    expect(
      (byPath(writes, '/networkpolicies/ac-daemon-ingress')?.body as { spec: { ingress: unknown[] } }).spec.ingress
    ).toEqual([])

    // Without this the daemon's registration WebSocket to an in-cluster control plane
    // never completes — its service port is not 443.
    const egress = byPath(writes, '/networkpolicies/ac-daemon-egress')?.body as {
      spec: { egress: Array<{ to?: Array<{ namespaceSelector?: { matchLabels: Record<string, string> } }> }> }
    }
    expect(egress.spec.egress).toContainEqual({
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': ctx.controlNamespace } } }]
    })

    // All-zero quota means unlimited: the objects are deleted, not written.
    expect(byPath(writes, '/resourcequotas/ac-quota')?.method).toBe('DELETE')
    expect(byPath(writes, '/limitranges/ac-limits')?.method).toBe('DELETE')

    const template = byPath(writes, `/namespaces/${NS}/sandboxtemplates/ac-runtime-std`)?.body as {
      spec: {
        podTemplate: {
          spec: {
            containers: Array<{
              image: string
              env: Array<{ name: string; value: string }>
              ports: Array<{ name: string; containerPort: number; protocol: string }>
            }>
          }
        }
      }
    }
    const container = template.spec.podTemplate.spec.containers[0]
    expect(container.image).toBe('ghcr.io/example/runtime:v1')
    expect(container.env.find((entry) => entry.name === 'AC_SHIM_ENDPOINT')).toBeUndefined()
    expect(container.env.find((entry) => entry.name === 'AC_SHIM_PORT')?.value).toBe('8085')
    expect(container.ports).toContainEqual({ name: 'shim', containerPort: 8085, protocol: 'TCP' })

    const pool = byPath(writes, '/sandboxwarmpools/ac-runtime-std')?.body as { spec: { replicas: number } }
    expect(pool.spec.replicas).toBe(2)

    const pvc = byPath(writes, '/persistentvolumeclaims/ac-daemon-state')?.body as {
      spec: { accessModes: string[] }
    }
    expect(pvc.spec.accessModes).toEqual(['ReadWriteOncePod'])

    const deployment = byPath(writes, '/deployments/ac-daemon')?.body as {
      spec: {
        replicas: number
        strategy: { type: string }
        template: {
          spec: {
            containers: Array<{ env: Array<{ name: string; value: string }>; args: string[] }>
            volumes: unknown[]
          }
        }
      }
    }
    expect(deployment.spec.replicas).toBe(1)
    expect(deployment.spec.strategy.type).toBe('Recreate')
    const env = deployment.spec.template.spec.containers[0].env
    expect(env.find((entry) => entry.name === 'AC_K8S_ORG_ID')?.value).toBe('acme')
    expect(env.find((entry) => entry.name === 'AC_K8S_WARM_POOL')?.value).toBe('ac-runtime-std')
    // The pod is born able to dial: the CP's own address as env, and the projected token
    // it presents instead of a credential. No Secret volume, no init container.
    expect(env.find((entry) => entry.name === 'AC_CP_URL')?.value).toBe(CP_URL)
    expect(deployment.spec.template.spec.volumes).toContainEqual({
      name: 'cp-identity',
      projected: {
        defaultMode: 0o444,
        sources: [
          {
            serviceAccountToken: {
              path: 'token',
              audience: CP_TOKEN_AUDIENCE,
              expirationSeconds: 3600
            }
          }
        ]
      }
    })
    expect(JSON.stringify(deployment.spec.template.spec)).not.toContain('install-config')
    expect(JSON.stringify(deployment.spec.template.spec.volumes)).not.toContain('secret')

    expect(byPath(writes, '/services/ac-daemon-shim')?.method).toBe('DELETE')
  })

  // A control plane in another namespace is reachable only if the policy says so, and a
  // policy selects namespaces — it cannot select the DNS name the CR carries.
  it('opens daemon egress to every namespace the install names, not just the control one', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route, { AC_DAEMON_EGRESS_NAMESPACES: 'cp-ns,relay-ns' })
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(ctx, inputOf(ctx), newObservations())

    const egress = byPath(writes, '/networkpolicies/ac-daemon-egress')?.body as {
      spec: { egress: Array<{ to?: Array<{ namespaceSelector?: { matchLabels: Record<string, string> } }> }> }
    }
    for (const namespace of ['cp-ns', 'relay-ns']) {
      expect(egress.spec.egress).toContainEqual({
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } }]
      })
    }
    expect(egress.spec.egress.filter((rule) => rule.to?.some((peer) => peer.namespaceSelector))).toHaveLength(2)
  })

  it('names no namespace at all when the install has no in-cluster peer', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route, { AC_DAEMON_EGRESS_NAMESPACES: '' })
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(ctx, inputOf(ctx), newObservations())

    const egress = byPath(writes, '/networkpolicies/ac-daemon-egress')?.body as {
      spec: { egress: Array<{ to?: unknown[]; ports?: Array<{ port: number }> }> }
    }
    expect(egress.spec.egress.every((rule) => rule.to?.every((peer) => !('namespaceSelector' in peer)) ?? true)).toBe(
      true
    )
    // A control plane outside the cluster is already covered by the 443 rule.
    expect(egress.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 443))).toBe(true)
  })

  // Nothing operator-side can invent an address, and refusing the spec would take the rest
  // of the envelope down with it — so the pod runs, does not register, and the CR says so.
  it('warns rather than fails when the resource carries no control-plane URL', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(ctx, { controlPlane: undefined }), obs)

    expect(obs.warnings.join(' ')).toContain('spec.controlPlane.url')
    const deployment = byPath(writes, '/deployments/ac-daemon')?.body as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string }> }> } } }
    }
    expect(deployment.spec.template.spec.containers[0].env.map((entry) => entry.name)).not.toContain('AC_CP_URL')
  })

  it('honours a targetNamespace override that stays inside the install prefix', async () => {
    const override = 'test-ac-org-legacy'
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(ctx, { targetNamespace: override }), obs)

    expect(obs.namespace).toBe(override)
    expect(byPath(writes, `/namespaces/${override}`)).toBeDefined()
    expect(byPath(writes, `/clusterrolebindings/ac-tokenreview-${override}`)).toBeDefined()
    expect(writes.some((write) => write.path.includes(`/namespaces/${NS}/`))).toBe(false)
  })

  it('refuses an override outside the install prefix without writing anything', async () => {
    const { writes, route } = recorder()
    const ctx = await contextFor(route)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(ctx, { targetNamespace: 'other-prefix-acme' }), obs)
    expect(obs.degraded?.reason).toBe('NamespaceOutsidePrefix')
    expect(writes).toEqual([])
  })

  // Object names are DNS subdomains, so a legal CR name can still derive an illegal namespace.
  it('refuses a CR name whose derived namespace is not a DNS label, without writing anything', async () => {
    const { writes, route } = recorder()
    const ctx = await contextFor(route)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(ctx, {}, 'acme.example'), obs)
    expect(obs.degraded?.reason).toBe('InvalidNamespaceName')
    expect(writes).toEqual([])
  })

  it('refuses a CR name whose derived namespace exceeds the DNS label length', async () => {
    const { writes, route } = recorder()
    const ctx = await contextFor(route)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(ctx, {}, 'a'.repeat(64)), obs)
    expect(obs.degraded?.reason).toBe('InvalidNamespaceName')
    expect(obs.degraded?.message).toContain('63')
    expect(writes).toEqual([])
  })

  it('never adopts an existing namespace missing this org claim label', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(namespacePath(NS), { metadata: { name: NS, labels: { [NAMESPACE_CLAIM_LABEL]: 'someone-else' } } })
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(ctx), obs)
    expect(obs.degraded?.reason).toBe('NamespaceClaimConflict')
    expect(writes).toEqual([])
  })

  it('suspend quiesces the daemon and the warm pools', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(ctx, inputOf(ctx, { suspend: true }), newObservations())
    const deployment = byPath(writes, '/deployments/ac-daemon')?.body as { spec: { replicas: number } }
    expect(deployment.spec.replicas).toBe(0)
    const pool = byPath(writes, '/sandboxwarmpools/ac-runtime-std')?.body as { spec: { replicas: number } }
    expect(pool.spec.replicas).toBe(0)
  })

  it('provisions the daemon state PVC from the install`s storage class and size', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route, { AC_DAEMON_STORAGE_CLASS: 'cluster-wide', AC_DAEMON_STORAGE_SIZE: '20Gi' })
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(ctx, inputOf(ctx), newObservations())
    const pvc = byPath(writes, '/persistentvolumeclaims/ac-daemon-state')?.body as {
      spec: { storageClassName?: string; resources: { requests: { storage: string } } }
    }
    expect(pvc.spec.storageClassName).toBe('cluster-wide')
    expect(pvc.spec.resources.requests.storage).toBe('20Gi')
  })

  it.each([
    ['no class is configured', {}],
    ['the chart renders the class blank', { AC_DAEMON_STORAGE_CLASS: '' }]
  ])('leaves the PVC on the cluster default when %s', async (_case, env) => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route, env)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(ctx, inputOf(ctx), newObservations())
    const pvc = byPath(writes, '/persistentvolumeclaims/ac-daemon-state')?.body as {
      spec: Record<string, unknown> & { resources: { requests: { storage: string } } }
    }
    // Absent, not '': an empty class asks for no provisioner at all instead of the cluster default.
    expect('storageClassName' in pvc.spec).toBe(false)
    expect(pvc.spec.resources.requests.storage).toBe('10Gi')
  })

  it('renders spec.quota into ResourceQuota hard limits plus a LimitRange', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(
      ctx,
      inputOf(ctx, { quota: { maxAgents: 5, cpu: '8', memory: '16Gi', storage: '0' } }),
      newObservations()
    )
    const quota = byPath(writes, '/resourcequotas/ac-quota')?.body as { spec: { hard: Record<string, string> } }
    expect(quota.spec.hard).toEqual({
      'count/sandboxclaims.extensions.agents.x-k8s.io': '5',
      'requests.cpu': '8',
      'requests.memory': '16Gi'
    })
    expect(byPath(writes, '/limitranges/ac-limits')?.method).toBe('PATCH')
  })

  it('skips a tier whose master template is missing but finishes the envelope', async () => {
    const { writes, route } = recorder()
    const ctx = await contextFor(route)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(ctx), obs)
    expect(obs.warnings.some((warning) => warning.includes('ac-runtime-std'))).toBe(true)
    expect(byPath(writes, '/sandboxtemplates/ac-runtime-std')).toBeUndefined()
    expect(byPath(writes, '/deployments/ac-daemon')).toBeDefined()
  })

  it('prunes operator-named tier objects that left the desired state', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    const leftovers = {
      items: [
        { metadata: { name: 'ac-runtime-old' } },
        { metadata: { name: 'ac-runtime-std' } },
        // Not operator-named: never a prune candidate even when labeled.
        { metadata: { name: 'custom-thing' } }
      ]
    }
    gets.set(groupPath(SANDBOX_EXTENSIONS_GROUP, NS, 'sandboxwarmpools'), leftovers)
    gets.set(groupPath(SANDBOX_EXTENSIONS_GROUP, NS, 'sandboxtemplates'), leftovers)
    await reconcileEnvelope(ctx, inputOf(ctx), newObservations())
    const deletes = writes.filter((write) => write.method === 'DELETE').map((write) => write.path)
    expect(deletes).toContain(groupPath(SANDBOX_EXTENSIONS_GROUP, NS, 'sandboxwarmpools', 'ac-runtime-old'))
    expect(deletes).toContain(groupPath(SANDBOX_EXTENSIONS_GROUP, NS, 'sandboxtemplates', 'ac-runtime-old'))
    expect(deletes.some((path) => path.endsWith('/ac-runtime-std') || path.endsWith('/custom-thing'))).toBe(false)
  })

  it('keeps the last-known-good objects of a still-desired tier whose master vanished', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    // No master template registered: tier std degrades, but its existing render survives.
    const existing = { items: [{ metadata: { name: 'ac-runtime-std' } }] }
    gets.set(groupPath(SANDBOX_EXTENSIONS_GROUP, NS, 'sandboxwarmpools'), existing)
    gets.set(groupPath(SANDBOX_EXTENSIONS_GROUP, NS, 'sandboxtemplates'), existing)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(ctx), obs)
    expect(obs.warnings.some((warning) => warning.includes('ac-runtime-std'))).toBe(true)
    expect(writes.filter((write) => write.method === 'DELETE' && write.path.includes('ac-runtime-std'))).toEqual([])
  })

  it('locked sandbox networking admits only daemon dial-in and DNS egress', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(ctx, inputOf(ctx, { egressPolicy: 'locked' }), newObservations())
    const template = byPath(writes, `/namespaces/${NS}/sandboxtemplates/ac-runtime-std`)?.body as {
      spec: { networkPolicy: { ingress: unknown[]; egress: unknown[] } }
    }
    expect(template.spec.networkPolicy).toEqual({
      ingress: [
        {
          from: [
            { podSelector: { matchLabels: { app: 'ac-daemon' } } },
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': ctx.controlNamespace }
              },
              podSelector: { matchLabels: { app: 'ac-daemon' } }
            }
          ],
          ports: [{ protocol: 'TCP', port: 8085 }]
        }
      ],
      egress: [
        {
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 }
          ]
        }
      ]
    })
  })
})
