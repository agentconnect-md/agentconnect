import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { loadConfig } from '../config.js'
import { AgentConnectOrgApi } from '../crd/api.js'
import { FINALIZER, NAMESPACE_CLAIM_LABEL, type AgentConnectOrg } from '../crd/types.js'
import type { ReconcileContext } from './context.js'
import { reconcile } from './reconcile.js'
import { namespacePath } from './resources.js'

afterEach(closeFakeApiServers)

const NS = 'test-ac-org-acme'

function orgOf(suspend: boolean): AgentConnectOrg {
  return {
    metadata: { name: 'acme', resourceVersion: '1', generation: 1, finalizers: [FINALIZER] },
    spec: {
      suspend,
      daemon: { image: 'ghcr.io/example/daemon:v1', tier: 'small', credentialSecretName: 'ac-daemon-token' },
      runtime: { image: 'ghcr.io/example/runtime:v1', tiers: [] },
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

async function runPass(suspend: boolean, daemonPods = 0): Promise<Recorded[]> {
  const recorded: Recorded[] = []
  const org = orgOf(suspend)
  const route: FakeRoute = ({ method, url, body }) => {
    const path = url.pathname
    if (method === 'GET') {
      if (path.includes('/agentconnectorgs/')) return { json: org }
      if (path === namespacePath(NS))
        return { json: { metadata: { name: NS, labels: { [NAMESPACE_CLAIM_LABEL]: 'acme' } } } }
      if (path.endsWith('/sandboxes')) return { json: { items: [{ metadata: { name: 'sb-1' } }] } }
      if (path.endsWith('/pods')) {
        return { json: { items: Array.from({ length: daemonPods }, (_, i) => ({ metadata: { name: `d-${i}` } })) } }
      }
      return { status: 404, json: { kind: 'Status', reason: 'NotFound' } }
    }
    recorded.push({ method, path, body: body ? JSON.parse(body) : undefined })
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
  await reconcile(ctx, 'acme')
  return recorded
}

describe('reconcile', () => {
  it('suspend quiesces already-bound Sandboxes, not just the deployment and pools', async () => {
    const recorded = await runPass(true)
    const patch = recorded.find((entry) => entry.path.endsWith('/sandboxes/sb-1'))
    expect(patch?.body).toEqual({ spec: { operatingMode: 'Suspended' } })
  })

  it('defers sandbox suspension while the daemon pod is still draining', async () => {
    const recorded = await runPass(true, 1)
    expect(recorded.some((entry) => entry.path.endsWith('/sandboxes/sb-1'))).toBe(false)
    // The pass still publishes status; Progressing carries the deferral.
    const status = recorded.find((entry) => entry.path.endsWith('/status'))?.body as {
      status: { conditions: Array<{ type: string; status: string }> }
    }
    expect(status.status.conditions.find((c) => c.type === 'Progressing')?.status).toBe('True')
  })

  it('leaves Sandbox operating modes alone when the org is not suspended', async () => {
    const recorded = await runPass(false)
    expect(recorded.some((entry) => entry.path.endsWith('/sandboxes/sb-1'))).toBe(false)
  })
})
