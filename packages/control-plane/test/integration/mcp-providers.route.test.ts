/**
 * MCP provider routes — the referenced-guard on DELETE. Agents bind a provider by
 * NAME (`runtimeOverrides.mcpServers`), so deleting a provider that agents still
 * enable would leave dangling selectors that silently re-bind to any future provider
 * recreated under the same name. DELETE must 409 while referenced (same rule as
 * skill-source delete) and go through once every agent has unselected it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

function makeApp(): HttpApp {
  const app = buildHttpApp(prisma)
  opened.push(app)
  return app
}

async function createProvider(app: HttpApp, name: string): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/mcp-providers`,
    payload: { name, url: 'https://mcp.example.com/mcp' }
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

async function createAgent(app: HttpApp, name: string, mcpServers: string[]): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: { name, runtime: 'claude', mcpServers }
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

describe('DELETE /mcp-providers/:id — referenced-guard', () => {
  it('409s while an agent still enables the provider; deletes once unselected', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const agentId = await createAgent(app, 'enabler', ['linear'])

    const blocked = await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().message).toBe('mcp provider is still enabled by one or more agents; unselect it there first')

    // The row survives the refused delete — nothing was unbound or cascade-dropped.
    const still = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${providerId}` })
    expect(still.statusCode).toBe(200)

    // Unselect from the agent, then the delete goes through.
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: [] }
    })
    expect(patch.statusCode).toBe(200)

    const freed = await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    expect(freed.statusCode).toBe(204)
    const gone = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${providerId}` })
    expect(gone.statusCode).toBe(404)
  })

  it('only an exact name match blocks — daemon-local server names on agents do not', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    // A daemon-configured (non-registry) MCP name carries no provider visibility and
    // must not pin an unrelated provider's lifetime.
    await createAgent(app, 'other-enabler', ['local-tools'])

    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    expect(res.statusCode).toBe(204)
  })

  it('deleting an agent releases its reference', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'notion')
    const agentId = await createAgent(app, 'short-lived', ['notion'])

    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })).statusCode).toBe(409)

    const drop = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })
    expect(drop.statusCode).toBe(204)

    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })).statusCode).toBe(204)
  })
})
