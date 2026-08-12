import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { loadConfig } from '../config.js'
import { AgentConnectOrgApi } from '../crd/api.js'
import { FINALIZER, NAMESPACE_CLAIM_LABEL, ORG_LABEL, type AgentConnectOrg } from '../crd/types.js'
import type { ReconcileContext } from './context.js'
import { reconcileDeletion } from './finalizer.js'
import { namespacePath } from './resources.js'

afterEach(closeFakeApiServers)

const NS = 'test-ac-org-acme'

function orgOf(name = 'acme', targetNamespace?: string): AgentConnectOrg {
  return {
    metadata: { name, resourceVersion: '1', deletionTimestamp: 'now', finalizers: [FINALIZER] },
    spec: {
      ...(targetNamespace ? { targetNamespace } : {}),
      daemon: { image: 'x', tier: 'small', credentialSecretName: 'ac-daemon-token' },
      runtime: { image: 'x', tiers: [] },
      suspend: false,
      quota: { maxAgents: 0, cpu: '0', memory: '0', storage: '0' },
      egressPolicy: 'curated',
      deletionPolicy: 'Delete'
    }
  }
}

interface Recorded {
  method: string
  path: string
  body?: unknown
}

interface RunOptions {
  org: AgentConnectOrg
  namespaceLabels?: Record<string, string>
  sandboxes?: string[]
  daemonPods?: number
  crbLabels?: Record<string, string>
  sandboxPatchStatus?: number
}

async function run(options: RunOptions): Promise<{ recorded: Recorded[]; error?: unknown }> {
  const recorded: Recorded[] = []
  let org = options.org
  const route: FakeRoute = ({ method, url, body }) => {
    const path = url.pathname
    if (method === 'GET') {
      if (path.includes('/agentconnectorgs/')) return { json: org }
      if (path === namespacePath(NS)) {
        if (!options.namespaceLabels) return { status: 404, json: { kind: 'Status', reason: 'NotFound' } }
        return { json: { metadata: { name: NS, labels: options.namespaceLabels } } }
      }
      if (path.endsWith('/pods')) {
        return {
          json: { items: Array.from({ length: options.daemonPods ?? 0 }, (_, i) => ({ metadata: { name: `d-${i}` } })) }
        }
      }
      if (path.endsWith('/sandboxes')) {
        return { json: { items: (options.sandboxes ?? []).map((name) => ({ metadata: { name } })) } }
      }
      if (path.includes('/clusterrolebindings/')) {
        if (!options.crbLabels) return { status: 404, json: { kind: 'Status', reason: 'NotFound' } }
        return { json: { metadata: { name: `ac-tokenreview-${NS}`, labels: options.crbLabels } } }
      }
      return { status: 404, json: { kind: 'Status', reason: 'NotFound' } }
    }
    recorded.push({ method, path, body: body ? JSON.parse(body) : undefined })
    if (method === 'PATCH' && path.includes('/sandboxes/') && options.sandboxPatchStatus) {
      return { status: options.sandboxPatchStatus, json: { kind: 'Status', reason: 'InternalError' } }
    }
    if (method === 'PATCH' && path.includes('/agentconnectorgs/')) {
      const patch = JSON.parse(body) as { metadata?: { finalizers?: string[] } }
      org = { ...org, metadata: { ...org.metadata, resourceVersion: '2', finalizers: patch.metadata?.finalizers } }
      return { json: org }
    }
    return { json: {} }
  }
  const { config: cluster } = await fakeApiServer(route)
  const http = new K8sHttp(cluster)
  const ctx: ReconcileContext = {
    http,
    orgApi: new AgentConnectOrgApi(http, cluster.namespace),
    config: loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'x' }),
    controlNamespace: cluster.namespace,
    log: {}
  }
  try {
    await reconcileDeletion(ctx, options.org)
    return { recorded }
  } catch (error) {
    return { recorded, error }
  }
}

const finalizerWrites = (recorded: Recorded[]): Recorded[] =>
  recorded.filter((entry) => entry.path.includes('/agentconnectorgs/'))

describe('reconcileDeletion', () => {
  it('quiesces, deletes the envelope, the claimed namespace, the CRB, then the finalizer', async () => {
    const { recorded } = await run({
      org: orgOf(),
      namespaceLabels: { [NAMESPACE_CLAIM_LABEL]: 'acme' },
      sandboxes: ['sb-1']
    })
    const paths = recorded.map((entry) => `${entry.method} ${entry.path}`)
    expect(paths).toContain(`PATCH /apis/apps/v1/namespaces/${NS}/deployments/ac-daemon`)
    expect(paths).toContain(`PATCH /apis/agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxes/sb-1`)
    expect(paths).toContain(`DELETE /apis/apps/v1/namespaces/${NS}/deployments/ac-daemon`)
    expect(paths).toContain(`DELETE /api/v1/namespaces/${NS}/services/ac-daemon-shim`)
    expect(paths).toContain(`DELETE /api/v1/namespaces/${NS}/persistentvolumeclaims/ac-daemon-state`)
    expect(paths).toContain(`DELETE /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxclaims`)
    expect(paths).toContain(`DELETE /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxwarmpools`)
    expect(paths).toContain(`DELETE /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxtemplates`)
    expect(paths).toContain(`DELETE /apis/rbac.authorization.k8s.io/v1/clusterrolebindings/ac-tokenreview-${NS}`)
    expect(paths).toContain(`DELETE /api/v1/namespaces/${NS}`)
    // The finalizer removal is the very last write.
    const last = recorded[recorded.length - 1]
    expect(last.path.includes('/agentconnectorgs/')).toBe(true)
    expect((last.body as { metadata: { finalizers: string[] } }).metadata.finalizers).toEqual([])
  })

  it('defers all teardown and keeps the finalizer while the daemon pod is still draining', async () => {
    const { recorded } = await run({
      org: orgOf(),
      namespaceLabels: { [NAMESPACE_CLAIM_LABEL]: 'acme' },
      sandboxes: ['sb-1'],
      daemonPods: 1
    })
    // Only the scale-to-zero patch happened: no suspension, no deletes, finalizer intact.
    expect(recorded).toHaveLength(1)
    expect(recorded[0].path.endsWith('/deployments/ac-daemon')).toBe(true)
    expect(finalizerWrites(recorded)).toEqual([])
  })

  it('writes nothing into a namespace claimed by another org, not even quiesce', async () => {
    const { recorded } = await run({
      org: orgOf(),
      namespaceLabels: { [NAMESPACE_CLAIM_LABEL]: 'someone-else' },
      sandboxes: ['their-sandbox']
    })
    // The claimant's envelope survives untouched: the only write is our own finalizer removal.
    expect(recorded).toHaveLength(1)
    expect(recorded[0].path.includes('/agentconnectorgs/')).toBe(true)
  })

  it('still reclaims a provably ours CRB when the namespace claim drifted', async () => {
    const { recorded } = await run({
      org: orgOf(),
      namespaceLabels: { [NAMESPACE_CLAIM_LABEL]: 'someone-else' },
      crbLabels: { [ORG_LABEL]: 'acme' }
    })
    const deletes = recorded.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path)
    expect(deletes).toEqual([`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/ac-tokenreview-${NS}`])
    expect(finalizerWrites(recorded)).toHaveLength(1)
  })

  it('leaves a CRB with a foreign org label alone', async () => {
    const { recorded } = await run({
      org: orgOf(),
      namespaceLabels: { [NAMESPACE_CLAIM_LABEL]: 'someone-else' },
      crbLabels: { [ORG_LABEL]: 'someone-else' }
    })
    expect(recorded.filter((entry) => entry.method === 'DELETE')).toEqual([])
    expect(finalizerWrites(recorded)).toHaveLength(1)
  })

  it('surfaces a sandbox suspension failure instead of completing the deletion', async () => {
    const { recorded, error } = await run({
      org: orgOf(),
      namespaceLabels: { [NAMESPACE_CLAIM_LABEL]: 'acme' },
      sandboxes: ['sb-1'],
      sandboxPatchStatus: 500
    })
    expect(error).toBeDefined()
    expect(finalizerWrites(recorded)).toEqual([])
  })

  it('touches nothing outside the install prefix except the finalizer', async () => {
    const { recorded } = await run({ org: orgOf('acme', 'other-prefix-acme') })
    expect(recorded).toHaveLength(1)
    expect(recorded[0].path.includes('/agentconnectorgs/')).toBe(true)
  })

  // A CR name is a DNS subdomain, so dots are legal on the object and illegal in the namespace it derives.
  it('touches nothing but the finalizer when the name derives no legal namespace', async () => {
    const { recorded } = await run({ org: orgOf('acme.example') })
    expect(recorded).toHaveLength(1)
    expect(recorded[0].path.includes('/agentconnectorgs/')).toBe(true)
  })
})
