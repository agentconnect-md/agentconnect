import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { AgentConnectOrgApi } from './api.js'
import { FINALIZER } from './types.js'

afterEach(closeFakeApiServers)

interface StoredOrg {
  metadata: { name: string; resourceVersion: string; finalizers?: string[] }
}

/** Stateful CR endpoint with resourceVersion-guarded merge patches. */
function orgStore(initial: string[] = [], onPatch?: () => void): { route: FakeRoute; current: () => StoredOrg } {
  let org: StoredOrg = { metadata: { name: 'acme', resourceVersion: '1', finalizers: [...initial] } }
  let version = 1
  const route: FakeRoute = ({ method, body }) => {
    if (method === 'GET') return { json: org }
    const patch = JSON.parse(body) as { metadata?: { resourceVersion?: string; finalizers?: string[] } }
    onPatch?.()
    if (patch.metadata?.resourceVersion && patch.metadata.resourceVersion !== org.metadata.resourceVersion) {
      return { status: 409, json: { kind: 'Status', reason: 'Conflict', message: 'the object has been modified' } }
    }
    org = {
      metadata: {
        name: 'acme',
        resourceVersion: `${++version}`,
        finalizers: patch.metadata?.finalizers ?? org.metadata.finalizers
      }
    }
    return { json: org }
  }
  return { route, current: () => org }
}

async function apiFor(route: FakeRoute): Promise<AgentConnectOrgApi> {
  const { config } = await fakeApiServer(route)
  return new AgentConnectOrgApi(new K8sHttp(config), config.namespace)
}

describe('AgentConnectOrgApi.updateFinalizer', () => {
  it('adds ours while preserving finalizers already on the object', async () => {
    const { route, current } = orgStore(['other.example/keep'])
    const api = await apiFor(route)
    await api.updateFinalizer('acme', FINALIZER, 'add')
    expect(current().metadata.finalizers).toEqual(['other.example/keep', FINALIZER])
  })

  it('removes only ours', async () => {
    const { route, current } = orgStore(['other.example/keep', FINALIZER])
    const api = await apiFor(route)
    await api.updateFinalizer('acme', FINALIZER, 'remove')
    expect(current().metadata.finalizers).toEqual(['other.example/keep'])
  })

  it('is a no-op write when the desired state already holds', async () => {
    let patches = 0
    const { route } = orgStore([FINALIZER], () => (patches += 1))
    const api = await apiFor(route)
    await api.updateFinalizer('acme', FINALIZER, 'add')
    expect(patches).toBe(0)
  })

  it('re-reads on conflict so a concurrently added finalizer survives', async () => {
    // Another controller writes its finalizer between our read and our patch:
    // the first attempt 409s, the retry must reapply onto the NEW list.
    let org: StoredOrg = { metadata: { name: 'acme', resourceVersion: '1', finalizers: [] } }
    let patches = 0
    const route: FakeRoute = ({ method, body }) => {
      if (method === 'GET') return { json: org }
      const patch = JSON.parse(body) as { metadata?: { resourceVersion?: string; finalizers?: string[] } }
      patches += 1
      if (patches === 1) {
        org = { metadata: { name: 'acme', resourceVersion: '2', finalizers: ['other.example/late'] } }
        return { status: 409, json: { kind: 'Status', reason: 'Conflict' } }
      }
      org = {
        metadata: { name: 'acme', resourceVersion: '3', finalizers: patch.metadata?.finalizers ?? [] }
      }
      return { json: org }
    }
    const api = await apiFor(route)
    await api.updateFinalizer('acme', FINALIZER, 'add')
    expect(patches).toBe(2)
    expect(org.metadata.finalizers).toEqual(['other.example/late', FINALIZER])
  })

  it('sends the observed resourceVersion as the precondition', async () => {
    let sent: { metadata?: { resourceVersion?: string } } | undefined
    const { route } = orgStore([])
    const api = await apiFor(({ method, body, url, headers }) => {
      if (method === 'PATCH') sent = JSON.parse(body) as typeof sent
      return route({ method, body, url, headers })
    })
    await api.updateFinalizer('acme', FINALIZER, 'add')
    expect(sent?.metadata?.resourceVersion).toBe('1')
  })
})
