// `/agents/:agentId/api` — the chat APIs an agent accepts calls on (shared-bot-relay.md §10.4).
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const AGENT = 'a9a9a9a9-aaaa-4aaa-8aaa-a9a9a9a9a9a9'

type HttpApp = ReturnType<typeof buildHttpApp>
const opened: HttpApp[] = []
afterEach(async () => {
  for (const a of opened.splice(0)) await a.close()
})
function open(over?: Parameters<typeof buildHttpApp>[1]): HttpApp {
  const a = buildHttpApp(prisma, over)
  opened.push(a)
  return a
}

async function makeUser(sub: string, role: 'collaborator' | 'viewer'): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@example.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

const list = (a: HttpApp, agentId = AGENT) => a.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/api` })
const add = (a: HttpApp, protocol = 'ai-sdk-ui', agentId = AGENT) =>
  a.app.inject({ method: 'PUT', url: `${ORG}/agents/${agentId}/api/${protocol}` })
const remove = (a: HttpApp, protocol = 'ai-sdk-ui', agentId = AGENT) =>
  a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}/api/${protocol}` })

describe('agent chat APIs', () => {
  it('adds idempotently, lists, removes, and audits each change once', async () => {
    await seedAgent(prisma, AGENT)
    const a = open()
    expect((await list(a)).json()).toEqual({ entries: [] })

    const first = await add(a)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ protocol: 'ai-sdk-ui' })
    const again = await add(a)
    expect(again.json()).toEqual(first.json())
    expect(((await list(a)).json() as { entries: unknown[] }).entries).toEqual([first.json()])

    expect((await remove(a)).statusCode).toBe(204)
    expect((await list(a)).json()).toEqual({ entries: [] })
    expect((await remove(a)).statusCode).toBe(404)

    const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_api_change', agentId: AGENT } })
    expect(audits.map((e) => (e.details as { enabled: boolean }).enabled).sort()).toEqual([false, true])
  })

  it('rejects an unknown protocol and an unknown agent', async () => {
    await seedAgent(prisma, AGENT)
    const a = open()
    expect((await add(a, 'acp-2')).statusCode).toBe(400)
    expect((await add(a, 'ai-sdk-ui', 'b8b8b8b8-bbbb-4bbb-8bbb-b8b8b8b8b8b8')).statusCode).toBe(404)
  })

  it('reads 404 for an agent the caller cannot see, and refuses writes from a viewer', async () => {
    const other = await makeUser('api-other', 'collaborator')
    const viewer = await makeUser('api-viewer', 'viewer')
    await seedAgent(prisma, AGENT, { visibility: 'restricted', sharedWith: [viewer] })

    const asOther = open({ DEFAULT_OWNER_ID: other })
    expect((await list(asOther)).statusCode).toBe(404)
    expect((await add(asOther)).statusCode).toBe(404)

    const asViewer = open({ DEFAULT_OWNER_ID: viewer })
    expect((await list(asViewer)).statusCode).toBe(200)
    expect((await add(asViewer)).statusCode).toBe(403)
    expect((await remove(asViewer)).statusCode).toBe(403)
  })

  it('goes with its agent', async () => {
    await seedAgent(prisma, AGENT)
    const a = open()
    await add(a)
    await prisma.agent.delete({ where: { id: AGENT } })
    expect(await prisma.agentApiEntry.count()).toBe(0)
  })
})
