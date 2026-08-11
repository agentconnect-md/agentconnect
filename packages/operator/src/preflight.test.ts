import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { AgentConnectOrgApi } from './crd/api.js'
import { preflightUninstall } from './preflight.js'

afterEach(closeFakeApiServers)

/** A control namespace holding these orgs, plus the URLs the guard actually asked for. */
async function apiFor(names: string[]): Promise<{ api: AgentConnectOrgApi; requests: URL[] }> {
  const route: FakeRoute = () => ({ json: { items: names.map((name) => ({ metadata: { name } })) } })
  const { config, requests } = await fakeApiServer(route)
  return { api: new AgentConnectOrgApi(new K8sHttp(config), config.namespace), requests }
}

describe('preflightUninstall', () => {
  it('clears the uninstall when the control namespace holds no orgs', async () => {
    const { api } = await apiFor([])
    const result = await preflightUninstall(api)
    expect(result.remaining).toEqual([])
    expect(result.message).toContain('can be removed')
  })

  it('blocks and names every org that remains, so the hook log is the diagnosis', async () => {
    const { api } = await apiFor(['zeta', 'acme'])
    const result = await preflightUninstall(api)
    expect(result.remaining).toEqual(['acme', 'zeta'])
    expect(result.message).toContain('refusing to uninstall: 2 AgentConnectOrg(s)')
    expect(result.message).toContain('acme, zeta')
  })

  it('asks only about its own control namespace', async () => {
    const { api, requests } = await apiFor(['acme'])
    await preflightUninstall(api)
    expect(requests.map((url) => url.pathname)).toEqual([
      '/apis/agentconnect.md/v1alpha1/namespaces/org-test/agentconnectorgs'
    ])
  })

  it('surfaces an API failure instead of reporting a clear namespace', async () => {
    const { config } = await fakeApiServer(() => ({ status: 500, json: { kind: 'Status', message: 'boom' } }))
    const api = new AgentConnectOrgApi(new K8sHttp(config), config.namespace)
    await expect(preflightUninstall(api)).rejects.toThrow()
  })
})
