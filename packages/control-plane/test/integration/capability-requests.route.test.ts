import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPABILITY_REQUESTS_FEATURE,
  type CapabilityForward,
  type CapabilityReopened,
  type CapabilityRequestReq
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG } from '../../prisma/seed.js'
import { CapabilityRequestService } from '../../src/capability/capability-request.service.js'
import { systemClock } from '../../src/domain/clock.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgCapabilityRequestRepo } from '../../src/persistence/repositories/capability-request.repo.js'
import { PgMcpProviderRepo } from '../../src/persistence/repositories/mcp.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd7d7d7d7-dddd-4ddd-8ddd-dddddddddddd'

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

async function member(role: 'collaborator' | 'viewer', name: string): Promise<string> {
  const email = `${randomUUID()}@example.test`
  const users = new PgUserRepo(prisma)
  const { userId } = await users.provisionOidcUser({ oidcSubject: email, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  await prisma.user.update({ where: { id: userId }, data: { displayName: name } })
  return userId
}

function service(sent: { reopened: CapabilityReopened[]; forwarded: CapabilityForward[] }) {
  return new CapabilityRequestService({
    clock: systemClock,
    requests: new PgCapabilityRequestRepo(prisma),
    agents: new PgAgentRepo(prisma),
    mcpProviders: new PgMcpProviderRepo(prisma),
    skillSources: { getByName: async () => null },
    orgs: new PgOrgRepo(prisma),
    facts: {
      load: async () => ({ mcpProvider: { providerId: null, connected: false, headerPresent: false } }),
      unknownTarget: async () => undefined
    },
    webAppUrl: 'https://console.example.test',
    placement: { dispatchDaemon: async () => DAEMON as never },
    daemon: () => ({ state: 'READY', capabilities: { features: [CAPABILITY_REQUESTS_FEATURE] } }),
    sendSettled: async () => ({ accepted: true }),
    sendReopened: async (_d, _o, frame) => void sent.reopened.push(frame),
    sendForward: async (_d, _o, frame) => {
      sent.forwarded.push(frame)
      return { delivered: true }
    },
    log: { debug: () => undefined, warn: () => undefined }
  })
}

const ask = (agentId: string, want: Record<string, unknown>): CapabilityRequestReq => ({
  agentId,
  sessionId: 's1',
  sessionKey: 'slack:C1:1.0',
  ask: { kind: 'agent-settings', want } as CapabilityRequestReq['ask'],
  reason: 'the task needs a stronger model',
  askers: {
    people: [{ kind: 'member', platform: 'slack', integrationId: 'i-1', userId: 'U1', name: 'Ana' }],
    nobody: false
  },
  platform: 'slack',
  placeLabel: '#bugs'
})

describe('capability request routes', () => {
  it('shows a request to whoever sees the agent and lets only an editor settle, decline and reopen it', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, runtime: 'claude-acp' })
    const editor = await member('collaborator', 'Ana')
    const viewer = await member('viewer', 'Vic')
    const sent = { reopened: [] as CapabilityReopened[], forwarded: [] as CapabilityForward[] }
    const capabilityRequests = service(sent)
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const asked = await capabilityRequests.request(agent, ask(agentId, { permissionMode: 'bypassPermissions' }))
    expect(asked.status).toBe('pending')
    const id = asked.requestId!

    const asViewer = buildHttpApp(prisma, { DEFAULT_OWNER_ID: viewer }, undefined, undefined, { capabilityRequests })
    const asEditor = buildHttpApp(prisma, { DEFAULT_OWNER_ID: editor }, undefined, undefined, { capabilityRequests })
    running.push(asViewer, asEditor)

    const page = await asViewer.app.inject({ method: 'GET', url: `${ORG}/capability-requests/${id}` })
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json()).toMatchObject({
      kind: 'agent-settings',
      summary: 'set the permission mode to "bypassPermissions"',
      status: 'open',
      current: { permissionMode: null },
      warnings: [expect.stringContaining('never asks')],
      origins: [{ sessionId: 's1', placeLabel: '#bugs', askers: [{ kind: 'member', name: 'Ana', platform: 'slack' }] }],
      viewer: {
        canComplete: false,
        canDecline: false,
        canForward: true,
        whoCan: expect.arrayContaining([{ userId: editor, name: 'Ana' }])
      }
    })
    const listed = await asViewer.app.inject({
      method: 'GET',
      url: `${ORG}/capability-requests?agentId=${agentId}&status=open`
    })
    expect(listed.json().requests.map((r: { id: string }) => r.id)).toEqual([id])

    const refused = await asViewer.app.inject({
      method: 'POST',
      url: `${ORG}/capability-requests/${id}/decline`,
      payload: {}
    })
    expect(refused.statusCode).toBe(403)

    const forward = await asViewer.app.inject({
      method: 'POST',
      url: `${ORG}/capability-requests/${id}/forward`,
      payload: { userId: editor }
    })
    expect(forward.json()).toEqual({ forwarded: 'dm' })
    expect(sent.forwarded).toEqual([
      expect.objectContaining({ consoleUserId: editor, forwardedBy: 'Vic', requestId: id })
    ])
    // Forwarding to the same person again within the hour sends nothing more.
    const repeated = await asViewer.app.inject({
      method: 'POST',
      url: `${ORG}/capability-requests/${id}/forward`,
      payload: { userId: editor }
    })
    expect(repeated.json()).toEqual({ forwarded: 'dm' })
    expect(sent.forwarded).toHaveLength(1)
    const forwardToViewer = await asViewer.app.inject({
      method: 'POST',
      url: `${ORG}/capability-requests/${id}/forward`,
      payload: { userId: viewer }
    })
    expect(forwardToViewer.statusCode).toBe(400)

    const declined = await asEditor.app.inject({
      method: 'POST',
      url: `${ORG}/capability-requests/${id}/decline`,
      payload: { note: 'too risky' }
    })
    expect(declined.statusCode, declined.body).toBe(200)
    expect(declined.json()).toMatchObject({
      status: 'declined',
      note: 'too risky',
      settledBy: { kind: 'console', name: 'Ana' },
      viewer: { canReopen: true }
    })
    expect(
      (await asEditor.app.inject({ method: 'POST', url: `${ORG}/capability-requests/${id}/decline`, payload: {} }))
        .statusCode
    ).toBe(409)

    const reopened = await asEditor.app.inject({ method: 'POST', url: `${ORG}/capability-requests/${id}/reopen` })
    expect(reopened.json()).toMatchObject({ status: 'open', generation: 2 })
    expect(sent.reopened).toEqual([
      expect.objectContaining({
        requestId: id,
        generation: 2,
        link: `https://console.example.test/${DEFAULT_ORG_SLUG}/requests/${id}`
      })
    ])

    // Only a scheduled-task request takes the task it was saved as.
    const notCron = await asEditor.app.inject({
      method: 'POST',
      url: `${ORG}/capability-requests/${id}/settle`,
      payload: { cronId: randomUUID() }
    })
    expect(notCron.statusCode, notCron.body).toBe(400)
    const settled = await asEditor.app.inject({ method: 'POST', url: `${ORG}/capability-requests/${id}/settle` })
    expect(settled.statusCode, settled.body).toBe(200)
    expect(settled.json()).toMatchObject({ status: 'completed', differs: true, settledBy: { name: 'Ana' } })
    // The save usually completes the request itself, so settling a completed one still answers with it.
    const again = await asEditor.app.inject({ method: 'POST', url: `${ORG}/capability-requests/${id}/settle` })
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json()).toMatchObject({ status: 'completed' })
  })

  it('answers 404 for a request on an agent the caller cannot see', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    const owner = await member('collaborator', 'Ana')
    const outsider = await member('collaborator', 'Oz')
    await seedAgent(prisma, agentId, {
      daemonId: DAEMON,
      visibility: 'restricted',
      sharedWith: [owner],
      createdByUserId: owner
    })
    await new PgMcpProviderRepo(prisma).create({
      orgId: OrgId(DEFAULT_ORG_ID),
      name: 'Linear',
      url: 'https://mcp.example.test/linear'
    })
    const capabilityRequests = service({ reopened: [], forwarded: [] })
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const asked = await capabilityRequests.request(agent, {
      ...ask(agentId, {}),
      ask: { kind: 'mcp-server', want: { server: 'Linear' } }
    })
    const asOutsider = buildHttpApp(prisma, { DEFAULT_OWNER_ID: outsider }, undefined, undefined, {
      capabilityRequests
    })
    const asOwner = buildHttpApp(prisma, { DEFAULT_OWNER_ID: owner }, undefined, undefined, { capabilityRequests })
    running.push(asOutsider, asOwner)
    expect(
      (await asOutsider.app.inject({ method: 'GET', url: `${ORG}/capability-requests/${asked.requestId}` })).statusCode
    ).toBe(404)
    expect((await asOutsider.app.inject({ method: 'GET', url: `${ORG}/capability-requests` })).json().requests).toEqual(
      []
    )
    const page = await asOwner.app.inject({ method: 'GET', url: `${ORG}/capability-requests/${asked.requestId}` })
    expect(page.json()).toMatchObject({
      kind: 'mcp-server',
      current: { attached: false, exists: true },
      viewer: { canComplete: true }
    })
  })

  it('lets only an editor of the MCP server complete a request for its header, and forwards to one', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const keeper = await member('collaborator', 'Kay')
    const other = await member('collaborator', 'Oz')
    await new PgMcpProviderRepo(prisma).create({
      orgId: OrgId(DEFAULT_ORG_ID),
      name: 'Grafana',
      url: 'https://mcp.example.test/grafana',
      visibility: 'restricted',
      sharedWith: [keeper],
      createdByUserId: keeper
    })
    const sent = { reopened: [] as CapabilityReopened[], forwarded: [] as CapabilityForward[] }
    const capabilityRequests = service(sent)
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const asked = await capabilityRequests.request(agent, {
      ...ask(agentId, {}),
      ask: {
        kind: 'secret',
        want: { name: 'X-Api-Key', description: 'the Grafana key', use: { route: 'mcp-header', server: 'Grafana' } }
      }
    })
    expect(asked).toMatchObject({
      status: 'pending',
      summary: 'set the header "X-Api-Key" of the MCP server "Grafana"'
    })
    const asOther = buildHttpApp(prisma, { DEFAULT_OWNER_ID: other }, undefined, undefined, { capabilityRequests })
    const asKeeper = buildHttpApp(prisma, { DEFAULT_OWNER_ID: keeper }, undefined, undefined, { capabilityRequests })
    running.push(asOther, asKeeper)

    const seen = await asOther.app.inject({ method: 'GET', url: `${ORG}/capability-requests/${asked.requestId}` })
    expect(seen.json()).toMatchObject({
      kind: 'secret',
      current: { present: false },
      viewer: {
        canComplete: false,
        canDecline: true,
        missing: expect.stringContaining('"Grafana"'),
        whoCan: expect.arrayContaining([{ userId: keeper, name: 'Kay' }])
      }
    })
    expect(seen.json().viewer.whoCan.map((m: { userId: string }) => m.userId)).not.toContain(other)
    const refused = await asOther.app.inject({
      method: 'POST',
      url: `${ORG}/capability-requests/${asked.requestId}/settle`
    })
    expect(refused.statusCode).toBe(403)
    expect(
      (await asKeeper.app.inject({ method: 'GET', url: `${ORG}/capability-requests/${asked.requestId}` })).json().viewer
        .canComplete
    ).toBe(true)
    const toOther = await asOther.app.inject({
      method: 'POST',
      url: `${ORG}/capability-requests/${asked.requestId}/forward`,
      payload: { userId: other }
    })
    expect(toOther.statusCode).toBe(400)
    const forwarded = await asOther.app.inject({
      method: 'POST',
      url: `${ORG}/capability-requests/${asked.requestId}/forward`,
      payload: { userId: keeper }
    })
    expect(forwarded.json()).toEqual({ forwarded: 'dm' })
    expect(sent.forwarded).toEqual([expect.objectContaining({ consoleUserId: keeper })])
  })
})
