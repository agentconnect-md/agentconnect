import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { loadConfig } from './config.js'
import { Controller } from './controller.js'
import { AgentConnectOrgApi } from './crd/api.js'
import { ORG_LABEL } from './crd/types.js'

afterEach(closeFakeApiServers)

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Routes the three watched collections; workload watches stay open and empty by default. */
function controlPlaneRoute(options: {
  orgs: { name: string }[]
  deploymentEvents?: unknown[]
  podEvents?: unknown[]
}): FakeRoute {
  return ({ url }) => {
    const watching = Boolean(url.searchParams.get('watch'))
    if (url.pathname.includes('/agentconnectorgs')) {
      if (!watching) {
        return {
          json: {
            metadata: { resourceVersion: '10' },
            items: options.orgs.map((org) => ({ metadata: { name: org.name, resourceVersion: '1' } }))
          }
        }
      }
      return { lines: [], hold: true }
    }
    const events = url.pathname.includes('/deployments') ? options.deploymentEvents : options.podEvents
    if (!watching) return { json: { metadata: { resourceVersion: '10' }, items: [] } }
    return { lines: events ?? [], hold: true }
  }
}

function build(route: FakeRoute, config: ReturnType<typeof loadConfig>, clock: FakeClock, reconciled: string[]) {
  return (async () => {
    const { config: cluster } = await fakeApiServer(route)
    const http = new K8sHttp(cluster)
    const orgApi = new AgentConnectOrgApi(http, cluster.namespace)
    const controller = new Controller({
      http,
      orgApi,
      config,
      clock,
      reconcile: async (name) => {
        reconciled.push(name)
      }
    })
    return controller
  })()
}

const config = loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-' })

describe('Controller', () => {
  it('reconciles nothing before leadership starts', async () => {
    const reconciled: string[] = []
    const controller = await build(controlPlaneRoute({ orgs: [{ name: 'acme' }] }), config, new FakeClock(), reconciled)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(controller.isRunning).toBe(false)
    expect(reconciled).toEqual([])
  })

  it('enqueues every org from the synced snapshot on becoming leader', async () => {
    const reconciled: string[] = []
    const controller = await build(
      controlPlaneRoute({ orgs: [{ name: 'acme' }, { name: 'globex' }] }),
      config,
      new FakeClock(),
      reconciled
    )
    controller.onStartedLeading()
    await waitUntil(() => reconciled.length === 2)
    expect(reconciled.sort()).toEqual(['acme', 'globex'])
    await controller.onStoppedLeading()
  })

  it('maps labeled workload events back to known orgs only', async () => {
    const reconciled: string[] = []
    const controller = await build(
      controlPlaneRoute({
        orgs: [{ name: 'acme' }],
        podEvents: [
          {
            type: 'ADDED',
            object: { metadata: { name: 'p1', resourceVersion: '2', labels: { [ORG_LABEL]: 'acme' } } }
          },
          // Another install's workload: same label key, unknown org — must not enqueue.
          {
            type: 'ADDED',
            object: { metadata: { name: 'p2', resourceVersion: '3', labels: { [ORG_LABEL]: 'other' } } }
          }
        ]
      }),
      config,
      new FakeClock(),
      reconciled
    )
    controller.onStartedLeading()
    await waitUntil(() => reconciled.filter((name) => name === 'acme').length >= 2)
    expect(reconciled).not.toContain('other')
    await controller.onStoppedLeading()
  })

  it('re-enqueues all known orgs on the resync tick', async () => {
    const reconciled: string[] = []
    const clock = new FakeClock()
    const controller = await build(controlPlaneRoute({ orgs: [{ name: 'acme' }] }), config, clock, reconciled)
    controller.onStartedLeading()
    await waitUntil(() => reconciled.length === 1)
    clock.advance(config.resyncIntervalMs)
    await waitUntil(() => reconciled.length === 2)
    expect(reconciled).toEqual(['acme', 'acme'])
    await controller.onStoppedLeading()
  })

  it('losing leadership aborts the watches and stops the term', async () => {
    const reconciled: string[] = []
    const controller = await build(controlPlaneRoute({ orgs: [{ name: 'acme' }] }), config, new FakeClock(), reconciled)
    controller.onStartedLeading()
    await waitUntil(() => reconciled.length === 1)
    await controller.onStoppedLeading()
    expect(controller.isRunning).toBe(false)
  })
})
