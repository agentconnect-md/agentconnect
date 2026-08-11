import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { loadConfig } from '../config.js'
import { AgentConnectOrgApi } from '../crd/api.js'
import { NAMESPACE_CLAIM_LABEL, type AgentConnectOrgSpec } from '../crd/types.js'
import { AgentConnectOrgSpecSchema } from '../crd/types.js'
import { newObservations, type ReconcileContext } from './context.js'
import { reconcileEnvelope, type EnvelopeInputs } from './envelope.js'
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

async function contextFor(route: FakeRoute): Promise<ReconcileContext> {
  const { config: cluster } = await fakeApiServer(route)
  const http = new K8sHttp(cluster)
  return {
    http,
    orgApi: new AgentConnectOrgApi(http, cluster.namespace),
    config: loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'test-ac-tokenreview' }),
    controlNamespace: cluster.namespace,
    log: {}
  }
}

const NS = 'test-ac-org-acme'

function specOf(overrides: Partial<AgentConnectOrgSpec> = {}): AgentConnectOrgSpec {
  return AgentConnectOrgSpecSchema.parse({
    targetNamespace: NS,
    daemon: { image: 'ghcr.io/example/daemon:v1', tier: 'small' },
    runtime: { image: 'ghcr.io/example/runtime:v1', tiers: [{ name: 'std', warmReplicas: 2 }] },
    ...overrides
  })
}

function inputOf(overrides: Partial<AgentConnectOrgSpec> = {}): EnvelopeInputs {
  return { orgName: 'acme', spec: specOf(overrides) }
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
  it('stamps the full inventory into a fresh namespace', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(), obs)

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

    // All-zero quota means unlimited: the objects are deleted, not written.
    expect(byPath(writes, '/resourcequotas/ac-quota')?.method).toBe('DELETE')
    expect(byPath(writes, '/limitranges/ac-limits')?.method).toBe('DELETE')

    const template = byPath(writes, `/namespaces/${NS}/sandboxtemplates/ac-runtime-std`)?.body as {
      spec: {
        podTemplate: { spec: { containers: Array<{ image: string; env: Array<{ name: string; value: string }> }> } }
      }
    }
    const container = template.spec.podTemplate.spec.containers[0]
    expect(container.image).toBe('ghcr.io/example/runtime:v1')
    expect(container.env.find((entry) => entry.name === 'AC_SHIM_ENDPOINT')?.value).toBe(
      `ws://ac-daemon-shim.${NS}.svc.cluster.local:8085`
    )

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
        template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }>; volumes: unknown[] } }
      }
    }
    expect(deployment.spec.replicas).toBe(1)
    expect(deployment.spec.strategy.type).toBe('Recreate')
    const env = deployment.spec.template.spec.containers[0].env
    expect(env.find((entry) => entry.name === 'AC_K8S_ORG_ID')?.value).toBe('acme')
    expect(env.find((entry) => entry.name === 'AC_K8S_WARM_POOL')?.value).toBe('ac-runtime-std')
    expect(deployment.spec.template.spec.volumes).toContainEqual({
      name: 'config',
      secret: { secretName: 'ac-daemon-token', optional: false }
    })

    expect(byPath(writes, '/services/ac-daemon-shim')).toBeDefined()
  })

  it('refuses a namespace outside the install prefix without writing anything', async () => {
    const { writes, route } = recorder()
    const ctx = await contextFor(route)
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf({ targetNamespace: 'other-prefix-acme' }), obs)
    expect(obs.degraded?.reason).toBe('NamespaceOutsidePrefix')
    expect(writes).toEqual([])
  })

  it('never adopts an existing namespace missing this org claim label', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(namespacePath(NS), { metadata: { name: NS, labels: { [NAMESPACE_CLAIM_LABEL]: 'someone-else' } } })
    const obs = newObservations()
    await reconcileEnvelope(ctx, inputOf(), obs)
    expect(obs.degraded?.reason).toBe('NamespaceClaimConflict')
    expect(writes).toEqual([])
  })

  it('suspend quiesces the daemon and the warm pools', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(ctx, inputOf({ suspend: true }), newObservations())
    const deployment = byPath(writes, '/deployments/ac-daemon')?.body as { spec: { replicas: number } }
    expect(deployment.spec.replicas).toBe(0)
    const pool = byPath(writes, '/sandboxwarmpools/ac-runtime-std')?.body as { spec: { replicas: number } }
    expect(pool.spec.replicas).toBe(0)
  })

  it('renders spec.quota into ResourceQuota hard limits plus a LimitRange', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(
      ctx,
      inputOf({ quota: { maxAgents: 5, cpu: '8', memory: '16Gi', storage: '0' } }),
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
    await reconcileEnvelope(ctx, inputOf(), obs)
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
    await reconcileEnvelope(ctx, inputOf(), newObservations())
    const deletes = writes.filter((write) => write.method === 'DELETE').map((write) => write.path)
    expect(deletes).toContain(groupPath(SANDBOX_EXTENSIONS_GROUP, NS, 'sandboxwarmpools', 'ac-runtime-old'))
    expect(deletes).toContain(groupPath(SANDBOX_EXTENSIONS_GROUP, NS, 'sandboxtemplates', 'ac-runtime-old'))
    expect(deletes.some((path) => path.endsWith('/ac-runtime-std') || path.endsWith('/custom-thing'))).toBe(false)
  })

  it('locked egress restricts the sandbox template to daemon and DNS', async () => {
    const { gets, writes, route } = recorder()
    const ctx = await contextFor(route)
    gets.set(masterPath(ctx.controlNamespace), MASTER_TEMPLATE)
    await reconcileEnvelope(ctx, inputOf({ egressPolicy: 'locked' }), newObservations())
    const template = byPath(writes, `/namespaces/${NS}/sandboxtemplates/ac-runtime-std`)?.body as {
      spec: { networkPolicy: { egress: unknown[] } }
    }
    expect(template.spec.networkPolicy.egress).toHaveLength(2)
  })
})
