import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { loadConfig } from '../config.js'
import { AgentConnectOrgApi } from '../crd/api.js'
import type { AgentConnectOrg, Condition } from '../crd/types.js'
import { newObservations, type Observations } from './context.js'
import { buildStatus, setCondition, writeStatus } from './status.js'

afterEach(closeFakeApiServers)

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'

function orgOf(overrides: Partial<AgentConnectOrg> = {}): AgentConnectOrg {
  return { metadata: { name: 'acme', generation: 3 }, ...overrides }
}

function healthyObs(): Observations {
  const obs = newObservations()
  obs.namespaceReady = true
  obs.namespace = 'test-ac-org-acme'
  obs.daemon = { ready: true, image: 'ghcr.io/example/daemon:v1' }
  obs.credential = { status: 'True', reason: 'DaemonRunning' }
  obs.sandboxes = { total: 2, running: 1, suspended: 1 }
  return obs
}

const byType = (status: { conditions?: Condition[] }, type: string): Condition | undefined =>
  status.conditions?.find((condition) => condition.type === type)

describe('buildStatus', () => {
  it('publishes namespace atomically with NamespaceReady and reports Ready', () => {
    const status = buildStatus(orgOf(), healthyObs(), NOW)
    expect(status.namespace).toBe('test-ac-org-acme')
    expect(status.observedGeneration).toBe(3)
    expect(byType(status, 'NamespaceReady')?.status).toBe('True')
    expect(byType(status, 'Ready')?.status).toBe('True')
    expect(byType(status, 'Degraded')?.status).toBe('False')
    expect(byType(status, 'LimitsApplied')?.status).toBe('Unknown')
    expect(status.sandboxes).toEqual({ total: 2, running: 1, suspended: 1 })
  })

  it('withholds the namespace and degrades on a namespace fault', () => {
    const obs = newObservations()
    obs.degraded = { reason: 'NamespaceClaimConflict', message: 'refusing to adopt' }
    const status = buildStatus(orgOf(), obs, NOW)
    expect(status.namespace).toBeUndefined()
    expect(byType(status, 'NamespaceReady')?.status).toBe('False')
    expect(byType(status, 'NamespaceReady')?.reason).toBe('NamespaceClaimConflict')
    expect(byType(status, 'Degraded')?.status).toBe('True')
    expect(byType(status, 'Ready')?.status).toBe('False')
  })

  it('reports a suspended org as not Ready with reason Suspended', () => {
    const org = orgOf()
    org.spec = { suspend: true } as AgentConnectOrg['spec']
    const status = buildStatus(org, healthyObs(), NOW)
    expect(byType(status, 'Ready')?.status).toBe('False')
    expect(byType(status, 'Ready')?.reason).toBe('Suspended')
  })

  it('surfaces tier warnings as Degraded without blocking Ready-relevant conditions', () => {
    const obs = healthyObs()
    obs.warnings.push('master template ac-runtime-big not found')
    const status = buildStatus(orgOf(), obs, NOW)
    expect(byType(status, 'Degraded')?.status).toBe('True')
    expect(byType(status, 'Degraded')?.reason).toBe('EnvelopeWarning')
  })

  it('keeps lastTransitionTime when a condition status does not flip', () => {
    const first = buildStatus(orgOf(), healthyObs(), NOW)
    const org = orgOf({ status: first })
    const second = buildStatus(org, healthyObs(), LATER)
    expect(byType(second, 'Ready')?.lastTransitionTime).toBe(NOW)
    const degradedObs = healthyObs()
    degradedObs.daemon = { ready: false }
    const third = buildStatus(orgOf({ status: second }), degradedObs, LATER)
    expect(byType(third, 'Ready')?.status).toBe('False')
    expect(byType(third, 'Ready')?.lastTransitionTime).toBe(LATER)
  })

  it('marks Progressing during a runtime rollout and carries the rollout record', () => {
    const obs = healthyObs()
    obs.rollout = { rolloutId: 'abc123', targetImage: 'ghcr.io/example/runtime:v2', pending: ['sb-1'], failed: [] }
    const status = buildStatus(orgOf(), obs, NOW)
    expect(byType(status, 'Progressing')?.status).toBe('True')
    expect(byType(status, 'Progressing')?.reason).toBe('RuntimeRollout')
    expect(status.rollout?.pending).toEqual(['sb-1'])
  })
})

describe('writeStatus', () => {
  it('nulls every managed field this pass did not observe so merge-patch cannot go stale', async () => {
    let patched: { status?: Record<string, unknown> } | undefined
    const { config: cluster } = await fakeApiServer(({ method, body }) => {
      if (method === 'PATCH') patched = JSON.parse(body) as typeof patched
      return { json: {} }
    })
    const http = new K8sHttp(cluster)
    const ctx = {
      http,
      orgApi: new AgentConnectOrgApi(http, cluster.namespace),
      config: loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'x' }),
      controlNamespace: cluster.namespace,
      log: {}
    }
    // A pass that lost the namespace claim: previous status carried namespace + summaries.
    const org = orgOf({ status: { namespace: 'test-ac-org-acme', daemon: { ready: true } } })
    const obs = newObservations()
    obs.degraded = { reason: 'NamespaceClaimConflict', message: 'refusing to adopt' }
    await writeStatus(ctx, org, obs, NOW)
    expect(patched?.status?.namespace).toBeNull()
    expect(patched?.status?.daemon).toBeNull()
    expect(patched?.status?.sandboxes).toBeNull()
    expect(patched?.status?.rollout).toBeNull()
    expect(patched?.status?.conditions).toBeDefined()
  })

  it('keeps observed fields as values, not nulls', async () => {
    let patched: { status?: Record<string, unknown> } | undefined
    const { config: cluster } = await fakeApiServer(({ method, body }) => {
      if (method === 'PATCH') patched = JSON.parse(body) as typeof patched
      return { json: {} }
    })
    const http = new K8sHttp(cluster)
    const ctx = {
      http,
      orgApi: new AgentConnectOrgApi(http, cluster.namespace),
      config: loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'x' }),
      controlNamespace: cluster.namespace,
      log: {}
    }
    await writeStatus(ctx, orgOf(), healthyObs(), NOW)
    expect(patched?.status?.namespace).toBe('test-ac-org-acme')
    expect(patched?.status?.daemon).toEqual({ ready: true, image: 'ghcr.io/example/daemon:v1' })
    expect(patched?.status?.pools).toBeNull()
  })
})

describe('setCondition', () => {
  it('advances lastTransitionTime only on a status flip', () => {
    const start = setCondition([], { type: 'Ready', status: 'True' }, NOW)
    const same = setCondition(start, { type: 'Ready', status: 'True' }, LATER)
    expect(same[0].lastTransitionTime).toBe(NOW)
    const flipped = setCondition(same, { type: 'Ready', status: 'False' }, LATER)
    expect(flipped[0].lastTransitionTime).toBe(LATER)
  })
})
