// The organization record over REST and real Postgres (assistant-mode.md §5.16): the switch-on claim, People's readers, visibility and People's cards.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-ddddddddd1c1'
const ON = { enabled: true }

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

class QuietControl {
  async agentUpsert(): Promise<void> {}
  async integrationUpsert(): Promise<void> {}
  async agentRemove(): Promise<void> {}
  async collaborationRoutes(): Promise<void> {}
}

function app(): HttpApp {
  running = buildHttpApp(prisma, undefined, undefined, new QuietControl() as unknown as ControlSender)
  return running
}

async function agent(): Promise<string> {
  const id = randomUUID()
  await seedAgent(prisma, id, { daemonId: DAEMON, runtime: 'claude-acp', name: `agent-${id.slice(0, 8)}` })
  return id
}

type RecordBody = {
  research: { agentId: string | null; researchedAt: string | null; runningSince: string | null }
  entries: {
    id: string
    kind: string
    title: string
    visibility: string
    readers: string[]
    currentRevision: number
    content: string
  }[]
}

const record = async (a: HttpApp) =>
  (await a.app.inject({ method: 'GET', url: `${ORG}/knowledge/organization` })).json() as RecordBody
const entry = (body: RecordBody, kind: string) => body.entries.find((e) => e.kind === kind)!
const switchMode = (a: HttpApp, id: string, on: boolean) =>
  a.app.inject({ method: 'PATCH', url: `${ORG}/agents/${id}`, payload: { assistantMode: on ? ON : null } })
const onboarding = async (id: string) =>
  (await prisma.agent.findUniqueOrThrow({ where: { id } })).assistantOnboarding as { research?: boolean } | null

describe('the organization record', () => {
  it('is created by the first switch-on, which alone claims research; People follows the mode', async () => {
    await seedDaemon(prisma, DAEMON)
    const first = await agent()
    const second = await agent()
    const a = app()
    expect((await record(a)).entries).toEqual([])

    expect((await switchMode(a, first, true)).statusCode).toBe(200)
    expect((await switchMode(a, second, true)).statusCode).toBe(200)
    expect((await onboarding(first))?.research).toBe(true)
    expect((await onboarding(second))?.research).toBe(false)

    const body = await record(a)
    expect(body.research.agentId).toBe(first)
    expect(body.entries.map((e) => [e.kind, e.title, e.content, e.visibility])).toEqual(
      expect.arrayContaining([
        ['organization', 'About', '# About', 'all'],
        ['channels', 'Channels', '# Channels', 'all'],
        ['people', 'People', '# People', 'selected']
      ])
    )
    expect(new Set(entry(body, 'people').readers)).toEqual(new Set([first, second]))

    // Switching off leaves People while the list follows the mode; switching on again rejoins and claims nothing.
    expect((await switchMode(a, second, false)).statusCode).toBe(200)
    expect(entry(await record(a), 'people').readers).toEqual([first])
    expect((await switchMode(a, second, true)).statusCode).toBe(200)
    expect(new Set(entry(await record(a), 'people').readers)).toEqual(new Set([first, second]))
    expect((await onboarding(second))?.research).toBe(false)
  })

  it('stops following the mode once a person edits People, and keeps About and Channels fixed', async () => {
    await seedDaemon(prisma, DAEMON)
    const first = await agent()
    const later = await agent()
    const a = app()
    await switchMode(a, first, true)
    const body = await record(a)
    const people = entry(body, 'people')

    const about = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/knowledge/${entry(body, 'organization').id}/visibility`,
      payload: { visibility: 'selected', readers: [first] }
    })
    expect(about.statusCode).toBe(409)

    const hand = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/knowledge/${people.id}/visibility`,
      payload: { visibility: 'selected', readers: [first, randomUUID()] }
    })
    expect(hand.statusCode).toBe(200)
    expect(hand.json()).toEqual({ visibility: 'selected', readers: [first], canManage: true })

    await switchMode(a, later, true)
    expect(entry(await record(a), 'people').readers).toEqual([first])

    // Deleting an agent takes it out of every readers list.
    await new PgAgentRepo(prisma).delete(OrgId(DEFAULT_ORG_ID), AgentId(first))
    expect(entry(await record(a), 'people').readers).toEqual([])
    expect((await record(a)).research.agentId).toBeNull()
  })

  it('checks an owner edit against the shape and marks the people a clear removes', async () => {
    await seedDaemon(prisma, DAEMON)
    const first = await agent()
    const a = app()
    await switchMode(a, first, true)
    const people = entry(await record(a), 'people')
    const patch = (content: string, expectedRevision: number) =>
      a.app.inject({
        method: 'PATCH',
        url: `${ORG}/knowledge/${people.id}`,
        payload: { title: 'Ignored', content, expectedRevision, tags: [] }
      })

    const refused = await patch('# People\nRole: stray line (self, 2026-10-01)', 1)
    expect(refused.statusCode).toBe(400)
    expect(refused.json().message).toMatch(/members\.md line 2/)

    const bob = '## Bob (@bob on Slack) `slack:T0EXAMPLE:U0BOB`\nRole: on-call lead (#ops, 2026-10-03)'
    const written = await patch(`# People\n\n${bob}\n`, 1)
    expect(written.statusCode).toBe(200)
    expect(written.json()).toMatchObject({ title: 'People', currentRevision: 2 })

    expect((await patch('# People\n', 2)).statusCode).toBe(200)
    expect(await prisma.organizationPeopleOptOut.findMany({ where: { orgId: DEFAULT_ORG_ID } })).toEqual([
      expect.objectContaining({ key: 'slack:T0EXAMPLE:U0BOB' })
    ])
    // Bob stays out until he writes his entry himself.
    expect((await patch(`# People\n\n${bob}\n`, 3)).statusCode).toBe(409)
    expect((await patch('# People\n', 1)).statusCode).toBe(409)

    const archive = await a.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge/${people.id}/archive`,
      payload: { archived: true }
    })
    expect(archive.statusCode).toBe(409)
  })

  it("lets a person read, write and remove their own card, and an owner edit or clear anyone's", async () => {
    await seedDaemon(prisma, DAEMON)
    const first = await agent()
    const a = app()
    await switchMode(a, first, true)
    const people = entry(await record(a), 'people')
    const own = `user:${DEFAULT_OWNER_ID}`
    const mine = (method: 'GET' | 'PUT' | 'DELETE', payload?: object) =>
      a.app.inject({ method, url: `${ORG}/knowledge/${people.id}/people/mine`, ...(payload ? { payload } : {}) })

    expect((await mine('GET')).json()).toEqual({ revision: 1, entries: [], keys: [own] })
    const card = `## Owner (@owner on Slack) \`${own}\`\nRole: founder (self, 2026-10-01)`
    const someoneElse = '## Bob (@bob on Slack) `slack:T0EXAMPLE:U0BOB`\nRole: on-call lead (#ops, 2026-10-03)'
    expect((await mine('PUT', { text: someoneElse, expectedRevision: 1 })).statusCode).toBe(403)
    expect((await mine('PUT', { text: card, expectedRevision: 1 })).json()).toEqual({ revision: 2 })
    expect((await mine('GET')).json()).toEqual({ revision: 2, entries: [{ key: own, text: card }], keys: [own] })

    expect((await mine('DELETE')).json()).toEqual({ revision: 3, cleared: true })
    expect(
      (await prisma.organizationPeopleOptOut.findMany({ where: { orgId: DEFAULT_ORG_ID } })).map((r) => r.key)
    ).toEqual([own])
    // Their own write lifts the mark.
    expect((await mine('PUT', { text: card, expectedRevision: 3 })).json()).toEqual({ revision: 4 })
    expect(await prisma.organizationPeopleOptOut.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(0)

    const byKey = (method: 'PUT' | 'DELETE', key: string, payload?: object) =>
      a.app.inject({
        method,
        url: `${ORG}/knowledge/${people.id}/people/${encodeURIComponent(key)}`,
        ...(payload ? { payload } : {})
      })
    expect((await byKey('PUT', 'slack:T0EXAMPLE:U0BOB', { text: someoneElse, expectedRevision: 4 })).json()).toEqual({
      revision: 5
    })
    expect((await byKey('DELETE', 'slack:T0EXAMPLE:U0BOB')).json()).toEqual({ revision: 6, cleared: true })
    const audits = await prisma.auditEvent.findMany({ where: { orgId: DEFAULT_ORG_ID, frameType: 'knowledge/people' } })
    expect(audits.map((row) => (row.details as { operation: string }).operation).sort()).toEqual(['clear', 'edit'])
    expect(JSON.stringify(audits.map((row) => [row.message, row.details]))).not.toContain('on-call lead')
  })
})
