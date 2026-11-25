// MCP provider tool catalog routes: relay-fetched snapshots, failure recording, RBAC and refresh triggers (mcp-tool-permissions.md §4).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MCP_TOOL_POLICY_V1_FEATURE, type McpCatalogTool, type RcMcpCatalogOk } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const TOOLS: McpCatalogTool[] = [
  { name: 'list_issues', readOnlyHint: true, interactive: false },
  { name: 'create_issue', readOnlyHint: false, destructiveHint: false, interactive: false },
  { name: 'triage', interactive: true }
]

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

type Answer = (providerId: string) => Promise<RcMcpCatalogOk>

/** An app whose devAuth principal is `userId`, with one capable relay answering catalog requests through `answer`. */
function makeApp(opts: { userId?: string; answer?: Answer | null } = {}) {
  const app = buildHttpApp(prisma, opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : {})
  opened.push(app)
  const answer = opts.answer === undefined ? async () => ({ tools: TOOLS }) : opts.answer
  const request = vi.fn(async (_type: string, payload: { providerId: string }) => answer!(payload.providerId))
  if (answer !== null) {
    app.relayReg.add({
      relayId: `relay-${randomUUID()}`,
      features: [MCP_TOOL_POLICY_V1_FEATURE],
      send: () => {},
      close: () => {},
      request: request as never
    })
  }
  return { app, request }
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@example.test`
  const users = new PgUserRepo(prisma)
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function createProvider(app: HttpApp, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/mcp-providers`,
    payload: { name, url: 'https://mcp.example.com/mcp', ...extra }
  })
  expect(res.statusCode).toBe(201)
  await app.deps.mcpToolCatalog!.settle()
  return res.json().id as string
}

const refresh = (app: HttpApp, id: string) =>
  app.app.inject({ method: 'POST', url: `${ORG}/mcp-providers/${id}/tools/refresh` })
const read = (app: HttpApp, id: string) => app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${id}/tools` })

describe('MCP provider tool catalog routes', () => {
  it('reads an empty catalog before any fetch', async () => {
    const { app } = makeApp()
    const id = await createProvider(app, 'docs', { auth: 'oauth2' })
    const res = await read(app, id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      tools: [],
      fetchedAt: null,
      failure: null,
      groups: { readOnly: 0, write: 0, other: 0 }
    })
  })

  it('refreshes through a capable relay and returns each tool with its group', async () => {
    const { app, request } = makeApp()
    const id = await createProvider(app, 'docs')
    request.mockClear()
    const res = await refresh(app, id)
    expect(res.statusCode).toBe(200)
    expect(request).toHaveBeenCalledWith('rc/mcp-catalog', { providerId: id })
    const body = res.json()
    expect(body.tools.map((t: { name: string; group: string }) => [t.name, t.group])).toEqual([
      ['list_issues', 'readOnly'],
      ['create_issue', 'write'],
      ['triage', 'other']
    ])
    expect(body.groups).toEqual({ readOnly: 1, write: 1, other: 1 })
    expect(body.failure).toBeNull()
    expect(typeof body.fetchedAt).toBe('string')
    expect((await read(app, id)).json()).toEqual(body)
  })

  it('keeps the previous snapshot and records the failure code when a fetch fails', async () => {
    let answer: RcMcpCatalogOk = { tools: TOOLS }
    const { app } = makeApp({ answer: async () => answer })
    const id = await createProvider(app, 'docs')
    const before = (await read(app, id)).json()
    answer = { failure: 'unreachable' }
    const res = await refresh(app, id)
    expect(res.json()).toEqual({ ...before, failure: 'unreachable' })
    expect(await prisma.mcpToolCatalog.findUnique({ where: { mcpProviderId: id } })).toMatchObject({
      failure: 'unreachable',
      fetchedAt: new Date(before.fetchedAt)
    })
  })

  it('records relay_unavailable when no capable relay is connected', async () => {
    const { app } = makeApp({ answer: null })
    const id = await createProvider(app, 'docs')
    const res = await refresh(app, id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      tools: [],
      fetchedAt: null,
      failure: 'relay_unavailable',
      groups: { readOnly: 0, write: 0, other: 0 }
    })
  })

  it('lets a viewer read but not refresh, and hides a provider the caller cannot see', async () => {
    const { app: owner } = makeApp()
    const id = await createProvider(owner, 'docs')
    const hidden = await createProvider(owner, 'secret-docs', {
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID]
    })

    const { app: viewer, request } = makeApp({ userId: await makeUser('catalog-viewer', 'viewer') })
    expect((await read(viewer, id)).statusCode).toBe(200)
    expect((await refresh(viewer, id)).statusCode).toBe(403)
    expect(request).not.toHaveBeenCalled()

    const { app: member } = makeApp({ userId: await makeUser('catalog-member', 'collaborator') })
    expect((await refresh(member, id)).statusCode).toBe(200)
    expect((await read(member, hidden)).statusCode).toBe(404)
    expect((await refresh(member, hidden)).statusCode).toBe(404)
    expect((await read(member, randomUUID())).statusCode).toBe(404)
  })

  it('refreshes after a provider is created and after its url changes, without waiting on the relay', async () => {
    const replies: Array<(r: RcMcpCatalogOk) => void> = []
    const { app, request } = makeApp({ answer: () => new Promise((resolve) => replies.push(resolve)) })
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: { name: 'docs', url: 'https://mcp.example.com/mcp' }
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id as string
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('rc/mcp-catalog', { providerId: id }))
    replies.shift()!({ tools: TOOLS })
    await app.deps.mcpToolCatalog!.settle()
    expect((await read(app, id)).json().groups).toEqual({ readOnly: 1, write: 1, other: 1 })

    const patched = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/mcp-providers/${id}`,
      payload: { url: 'https://mcp2.example.com/mcp' }
    })
    expect(patched.statusCode).toBe(200)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    replies.shift()!({ tools: [TOOLS[0]!] })
    await app.deps.mcpToolCatalog!.settle()
    expect((await read(app, id)).json().tools.map((t: { name: string }) => t.name)).toEqual(['list_issues'])
  })

  it('does not fetch an oauth2 provider before it is connected', async () => {
    const { app, request } = makeApp()
    await createProvider(app, 'oauth-docs', { auth: 'oauth2' })
    expect(request).not.toHaveBeenCalled()
  })
})
