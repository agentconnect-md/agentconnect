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

/**
 * Park the DELETE inside its serialized reference check by intercepting the FIRST
 * `agent.list` call (that check is the first caller during the delete; later calls —
 * e.g. pushUnassign's daemon fan-out — pass through). Returns a release() that lets
 * the delete proceed, plus a promise that resolves once the delete is parked.
 */
function parkDeleteAtReferenceCheck(app: HttpApp) {
  const repo = app.deps.repos.agent
  const realList = repo.list.bind(repo)
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let notifyParked!: () => void
  const parked = new Promise<void>((r) => (notifyParked = r))
  let intercepted = false
  repo.list = async (orgId) => {
    if (!intercepted) {
      intercepted = true
      notifyParked()
      await gate
    }
    return realList(orgId)
  }
  return { release, parked }
}

const settleTick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('DELETE /mcp-providers/:id — serialized against agent enable-list writes', () => {
  it('an agent CREATE adding the name waits out the delete instead of slipping into its check→drop window', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const { release, parked } = parkDeleteAtReferenceCheck(app)

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    await parked

    // Regression (the pre-fix bug): with the check outside the chain, this create
    // completed DURING the parked window and the delete still returned 204, leaving
    // the dangling selector. Now the write joins the provider's chain and must block.
    const create = app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'racer', runtime: 'claude', mcpServers: ['linear'] }
    })
    const winner = await Promise.race([
      create.then(() => 'created' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked')

    release()
    // The delete saw no reference (the write was queued behind it) — it completes;
    // the create then lands with 'linear' as a plain daemon-local name (no registry row).
    expect((await del).statusCode).toBe(204)
    expect((await create).statusCode).toBe(201)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${providerId}` })).statusCode).toBe(404)
  })

  it('an agent PATCH adding the name waits out the delete the same way', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const agentId = await createAgent(app, 'patch-racer', [])
    const { release, parked } = parkDeleteAtReferenceCheck(app)

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    await parked

    const patch = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['linear'] }
    })
    const winner = await Promise.race([
      patch.then(() => 'patched' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked')

    release()
    expect((await del).statusCode).toBe(204)
    expect((await patch).statusCode).toBe(200)
  })
})
