/**
 * Session views — DB-backed metadata list + daemon-local transcript pulls.
 *
 * - `GET /sessions` reads CP-stored metadata synced from daemon `event/session`
 *   snapshots; transcript bodies remain daemon-local.
 * - `GET /sessions/:id/messages` resolves and authorizes the owning agent from
 *   SessionMeta, then proxies one history page; 404 unknown/hidden session,
 *   503 unplaced/offline.
 *
 * Driven with `app.inject`, a spy `ControlSender`, and a liveness override that
 * marks the seeded daemon connected.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { SessionListReq, SessionListPage, SessionHistoryReq, SessionHistoryPage } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION = '50505050-5555-4555-8555-555555555555'

/** Marks DAEMON connected so history pulls can reach it. */
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

/** A ControlSender spy answering sessionList + sessionHistory with canned data. */
class SpyControl {
  listCalls: Array<{ daemonId: string; req: SessionListReq }> = []
  histCalls: Array<{ daemonId: string; req: SessionHistoryReq }> = []
  constructor(
    private readonly list: SessionListPage,
    private readonly hist: SessionHistoryPage
  ) {}
  async sessionList(daemonId: string, req: SessionListReq): Promise<SessionListPage> {
    this.listCalls.push({ daemonId, req })
    return this.list
  }
  async sessionHistory(daemonId: string, req: SessionHistoryReq): Promise<SessionHistoryPage> {
    this.histCalls.push({ daemonId, req })
    return this.hist
  }
}

const emptyHist: SessionHistoryPage = { sessionId: SESSION, messages: [] }

async function seedSession(agentId = AGENT): Promise<void> {
  await prisma.sessionMeta.create({
    data: {
      id: SESSION,
      agentId,
      orgId: DEFAULT_ORG_ID,
      platform: 'slack',
      channel: '#deploys',
      phase: 'start',
      lastActivityAt: new Date('2026-07-05T08:00:00.000Z')
    }
  })
}

describe('GET /sessions (metadata list from CP DB)', () => {
  it('lists CP-stored session metadata and maps the row shape', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON }) // sessions filter by owning-agent visibility
    await prisma.sessionMeta.create({
      data: {
        id: SESSION,
        agentId: AGENT,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        channel: '#deploys',
        thread: 'T1',
        phase: 'end',
        title: 'Roll out api@1.4.2',
        status: 'idle',
        lastActivityAt: new Date('2026-07-05T10:51:00.000Z'),
        triggeredBy: 'U-DANA',
        channelName: 'deploys',
        triggeredByName: 'Dana Reyes',
        threadUrl: 'https://slack.example/archives/C1/p1'
      }
    })
    await prisma.sessionUsage.create({
      data: {
        agentId: AGENT,
        sessionId: SESSION,
        platform: 'slack',
        channel: '#deploys',
        lastActivityAt: new Date('2026-07-05T10:51:00.000Z'),
        totalTokens: 4820,
        inputTokens: 3600,
        outputTokens: 1220
      }
    })
    running = buildHttpApp(prisma)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      sessions: Array<{
        sessionId: string
        sessionKey: { platform: string; channel: string; thread?: string }
        title: string | null
        status: string | null
        lastActivityAt: string
        usage: { totalTokens?: number; inputTokens?: number } | null
        triggeredBy: string | null
        channelName: string | null
        triggeredByName: string | null
        threadUrl: string | null
      }>
      nextCursor: string | null
    }
    expect(body.sessions).toHaveLength(1)
    expect(body.nextCursor).toBeNull()
    expect(body.sessions[0]!.sessionId).toBe(SESSION)
    expect(body.sessions[0]!.sessionKey.channel).toBe('#deploys')
    expect(body.sessions[0]!.sessionKey.thread).toBe('T1')
    expect(body.sessions[0]!.title).toBe('Roll out api@1.4.2')
    expect(body.sessions[0]!.status).toBe('idle')
    expect(body.sessions[0]!.lastActivityAt).toBe('2026-07-05T10:51:00.000Z')
    expect(body.sessions[0]!.usage?.totalTokens).toBe(4820)
    expect(body.sessions[0]!.usage?.inputTokens).toBe(3600)
    expect(body.sessions[0]!.triggeredBy).toBe('U-DANA')
    expect(body.sessions[0]!.channelName).toBe('deploys')
    expect(body.sessions[0]!.triggeredByName).toBe('Dana Reyes')
    expect(body.sessions[0]!.threadUrl).toBe('https://slack.example/archives/C1/p1')
  })

  it('returns DB sessions even when the owning daemon is offline', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.sessionMeta.create({
      data: {
        id: SESSION,
        agentId: AGENT,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        channel: '#deploys',
        phase: 'start',
        title: 'offline-visible',
        lastActivityAt: new Date('2026-07-05T08:00:00.000Z')
      }
    })
    running = buildHttpApp(prisma) // default liveness: nothing connected
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)).toEqual([
      SESSION
    ])
  })

  it('sorts DB metadata by last activity descending', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const older = randomUUID()
    const newer = randomUUID()
    await prisma.sessionMeta.createMany({
      data: [
        {
          id: older,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: '#ops',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T08:08:00.000Z')
        },
        {
          id: newer,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: '#ops',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T10:51:00.000Z')
        }
      ]
    })
    running = buildHttpApp(prisma)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { sessions: Array<{ sessionId: string }> }
    expect(body.sessions.map((s) => s.sessionId)).toEqual([newer, older])
  })

  it('paginates DB metadata with a stable cursor', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const oldest = 'cursor-oldest'
    const tieA = 'cursor-tie-a'
    const tieM = 'cursor-tie-m'
    const tieZ = 'cursor-tie-z'
    const tiedActivity = new Date('2026-07-05T10:10:00.000Z')
    await prisma.sessionMeta.createMany({
      data: [
        {
          id: oldest,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: '#ops',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T08:08:00.000Z')
        },
        {
          id: tieA,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: '#ops',
          phase: 'start',
          lastActivityAt: tiedActivity,
          startedAt: tiedActivity
        },
        {
          id: tieM,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: '#ops',
          phase: 'start',
          lastActivityAt: tiedActivity,
          startedAt: tiedActivity
        },
        {
          id: tieZ,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: '#ops',
          phase: 'start',
          lastActivityAt: tiedActivity,
          startedAt: tiedActivity
        }
      ]
    })
    running = buildHttpApp(prisma)

    const first = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?limit=2` })
    expect(first.statusCode).toBe(200)
    const firstBody = first.json() as { sessions: Array<{ sessionId: string }>; nextCursor: string | null }
    expect(firstBody.sessions.map((s) => s.sessionId)).toEqual([tieZ, tieM])
    expect(firstBody.nextCursor).toEqual(expect.any(String))

    const second = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`
    })
    expect(second.statusCode).toBe(200)
    const secondBody = second.json() as {
      sessions: Array<{ sessionId: string }>
      total: number | null
      nextCursor: string | null
    }
    expect(secondBody.sessions.map((s) => s.sessionId)).toEqual([tieA, oldest])
    expect(secondBody.total).toBeNull()
    expect(secondBody.nextCursor).toBeNull()
  })

  it('filters before pagination and returns independent facets from every visible session', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const older = randomUUID()
    const newer = randomUUID()
    await prisma.sessionMeta.createMany({
      data: [
        {
          id: older,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: 'C-OLDER',
          channelName: 'older',
          triggeredBy: 'U-OLDER',
          triggeredByName: 'Older User',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T08:00:00.000Z')
        },
        {
          id: newer,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: 'C-NEWER',
          channelName: 'newer',
          triggeredBy: 'U-NEWER',
          triggeredByName: 'Newer User',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T09:00:00.000Z')
        }
      ]
    })
    running = buildHttpApp(prisma)

    const first = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?limit=1` })
    expect(first.statusCode).toBe(200)
    const firstBody = first.json() as {
      sessions: Array<{ sessionId: string }>
      total: number
    }
    expect(firstBody.sessions.map((session) => session.sessionId)).toEqual([newer])
    expect(firstBody.total).toBe(2)

    const facets = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/facets` })
    expect(facets.statusCode).toBe(200)
    const facetsBody = facets.json() as {
      channels: Array<{ value: string }>
      triggers: Array<{ value: string }>
    }
    expect(facetsBody.channels.map((channel) => channel.value)).toEqual(['C-NEWER', 'C-OLDER'])
    expect(facetsBody.triggers.map((trigger) => trigger.value)).toEqual(['U-NEWER', 'U-OLDER'])

    const filtered = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?limit=1&channel=C-OLDER&triggeredBy=U-OLDER`
    })
    expect(filtered.statusCode).toBe(200)
    const filteredBody = filtered.json() as {
      sessions: Array<{ sessionId: string }>
      total: number
      nextCursor: string | null
    }
    expect(filteredBody.sessions.map((session) => session.sessionId)).toEqual([older])
    expect(filteredBody.total).toBe(1)
    expect(filteredBody.nextCursor).toBeNull()
  })

  it('cascades each facet through the other active filters while keeping its own alternatives', async () => {
    const secondAgent = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, secondAgent, { daemonId: DAEMON })
    await prisma.sessionMeta.createMany({
      data: [
        {
          id: randomUUID(),
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: 'C-A-SLACK',
          triggeredBy: 'U-A-SLACK',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T10:00:00.000Z')
        },
        {
          id: randomUUID(),
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'discord',
          channel: 'C-A-DISCORD',
          triggeredBy: 'U-A-DISCORD',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T09:00:00.000Z')
        },
        {
          id: randomUUID(),
          agentId: secondAgent,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: 'C-B-SLACK',
          triggeredBy: 'U-B-SLACK',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T08:00:00.000Z')
        }
      ]
    })
    running = buildHttpApp(prisma)

    type Facets = {
      agents: string[]
      integrations: string[]
      channels: Array<{ value: string }>
      triggers: Array<{ value: string }>
    }
    const facetsFor = async (query: string): Promise<Facets> => {
      const response = await running!.app.inject({ method: 'GET', url: `${ORG}/sessions/facets?${query}` })
      expect(response.statusCode).toBe(200)
      return response.json() as Facets
    }

    const byAgentAndIntegration = await facetsFor(`agentId=${AGENT}&integration=slack`)
    expect(byAgentAndIntegration.agents).toEqual(expect.arrayContaining([AGENT, secondAgent]))
    expect(byAgentAndIntegration.integrations).toEqual(expect.arrayContaining(['slack', 'discord']))
    expect(byAgentAndIntegration.channels.map((channel) => channel.value)).toEqual(['C-A-SLACK'])
    expect(byAgentAndIntegration.triggers.map((trigger) => trigger.value)).toEqual(['U-A-SLACK'])

    const byAgentAndChannel = await facetsFor(`agentId=${AGENT}&channel=C-A-SLACK`)
    expect(byAgentAndChannel.agents).toEqual([AGENT])
    expect(byAgentAndChannel.integrations).toEqual(['slack'])
    expect(byAgentAndChannel.channels.map((channel) => channel.value)).toEqual(['C-A-SLACK', 'C-A-DISCORD'])
    expect(byAgentAndChannel.triggers.map((trigger) => trigger.value)).toEqual(['U-A-SLACK'])

    const byAgentAndTrigger = await facetsFor(`agentId=${AGENT}&triggeredBy=U-A-SLACK`)
    expect(byAgentAndTrigger.agents).toEqual([AGENT])
    expect(byAgentAndTrigger.integrations).toEqual(['slack'])
    expect(byAgentAndTrigger.channels.map((channel) => channel.value)).toEqual(['C-A-SLACK'])
    expect(byAgentAndTrigger.triggers.map((trigger) => trigger.value)).toEqual(['U-A-SLACK', 'U-A-DISCORD'])
  })

  it('groups same-repository GitHub triggers and filters sessions from every matching hook', async () => {
    const secondAgent = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const firstHook = randomUUID()
    const secondHook = randomUUID()
    const otherHook = randomUUID()
    const firstSession = randomUUID()
    const secondSession = randomUUID()
    const otherSession = randomUUID()
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, secondAgent, { daemonId: DAEMON })
    await prisma.hookDef.createMany({
      data: [
        {
          id: firstHook,
          orgId: DEFAULT_ORG_ID,
          agentId: AGENT,
          kind: 'github',
          name: 'acme/infra',
          sessionMode: 'perThread',
          repoId: 123n,
          repoFullName: 'acme/infra'
        },
        {
          id: secondHook,
          orgId: DEFAULT_ORG_ID,
          agentId: secondAgent,
          kind: 'github',
          name: 'acme/infra',
          sessionMode: 'perThread',
          repoId: 123n,
          repoFullName: 'acme/infra'
        },
        {
          id: otherHook,
          orgId: DEFAULT_ORG_ID,
          agentId: AGENT,
          kind: 'github',
          name: 'acme/other',
          sessionMode: 'perThread',
          repoId: 456n,
          repoFullName: 'acme/other'
        }
      ]
    })
    await prisma.sessionMeta.createMany({
      data: [
        {
          id: firstSession,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: 'C-FIRST',
          triggeredBy: `hook:${firstHook}`,
          triggeredByName: 'acme/infra',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T08:00:00.000Z')
        },
        {
          id: secondSession,
          agentId: secondAgent,
          orgId: DEFAULT_ORG_ID,
          platform: 'hook',
          channel: secondHook,
          triggeredBy: `hook:${secondHook}`,
          triggeredByName: 'acme/infra',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T09:00:00.000Z')
        },
        {
          id: otherSession,
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'hook',
          channel: otherHook,
          triggeredBy: `hook:${otherHook}`,
          triggeredByName: 'acme/other',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T10:00:00.000Z')
        }
      ]
    })
    running = buildHttpApp(prisma)

    const facets = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/facets` })
    expect(facets.statusCode, facets.body).toBe(200)
    const repoFacets = (
      facets.json() as {
        triggers: Array<{ name: string | null; hookKind: string | null; githubRepoId: string | null }>
      }
    ).triggers.filter((trigger) => trigger.githubRepoId === '123')
    expect(repoFacets).toHaveLength(2)
    expect(repoFacets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'acme/infra',
          hookKind: 'github',
          githubRepoId: '123'
        })
      ])
    )

    const filtered = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?githubRepoId=123` })
    expect(filtered.statusCode).toBe(200)
    const filteredBody = filtered.json() as { sessions: Array<{ sessionId: string }>; total: number }
    expect(filteredBody.sessions.map((session) => session.sessionId)).toEqual([secondSession, firstSession])
    expect(filteredBody.total).toBe(2)
  })

  it('filters the metadata set by channel', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON }) // sessions filter by owning-agent visibility
    await prisma.sessionMeta.createMany({
      data: [
        {
          id: randomUUID(),
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: '#deploys',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T08:00:00.000Z')
        },
        {
          id: randomUUID(),
          agentId: AGENT,
          orgId: DEFAULT_ORG_ID,
          platform: 'slack',
          channel: '#ops',
          phase: 'start',
          lastActivityAt: new Date('2026-07-05T09:00:00.000Z')
        }
      ]
    })
    running = buildHttpApp(prisma)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?channel=%23ops` })
    const body = res.json() as { sessions: Array<{ sessionKey: { channel: string } }> }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]!.sessionKey.channel).toBe('#ops')
  })

  it('400s on an invalid pagination cursor', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?cursor=not-a-cursor` })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /sessions/:id/messages (history pull via the owning agent)', () => {
  it('resolves the owner from SessionMeta and proxies a page', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedSession()
    const spy = new SpyControl(
      { sessions: [] },
      {
        sessionId: SESSION,
        messages: [
          {
            seq: 1,
            sender: '@dana',
            trustedAgentBot: true,
            ts: '1718000000.000100',
            kind: 'text',
            text: 'ship it',
            attachments: [{ name: 'screen.webp', mimeType: 'image/webp', data: 'aW1hZ2U=' }]
          }
        ],
        nextCursor: 'c-50',
        liveCursor: '77',
        liveMore: true
      }
    )
    running = buildHttpApp(prisma, undefined, LIVE, spy as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${SESSION}/messages?cursor=c-100&limit=25`
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      messages: Array<{ text: string; trustedAgentBot?: boolean; attachments?: Array<{ name: string }> }>
      nextCursor: string | null
      liveCursor: string | null
      liveMore: boolean
    }
    expect(body.messages[0]!.text).toBe('ship it')
    expect(body.messages[0]!.trustedAgentBot).toBe(true)
    expect(body.messages[0]!.attachments?.[0]?.name).toBe('screen.webp')
    expect(body.nextCursor).toBe('c-50')
    expect(body.liveCursor).toBe('77')
    expect(body.liveMore).toBe(true)
    expect(spy.histCalls[0]!.daemonId).toBe(DAEMON)
    expect(spy.histCalls[0]!.req).toEqual({ agentId: AGENT, sessionId: SESSION, cursor: 'c-100', limit: 25 })

    const tail = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${SESSION}/messages?after=77&limit=200`
    })
    expect(tail.statusCode).toBe(200)
    expect(spy.histCalls[1]!.req).toEqual({ agentId: AGENT, sessionId: SESSION, after: '77', limit: 200 })

    const conflicting = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${SESSION}/messages?cursor=older&after=77`
    })
    expect(conflicting.statusCode).toBe(400)
  })

  it('404s for an unknown session', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${SESSION}/messages`
    })
    expect(res.statusCode).toBe(404)
  })

  it('503s when the agent is unplaced (no live daemon)', async () => {
    await seedAgent(prisma, AGENT) // no daemonId
    await seedSession()
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${SESSION}/messages` })
    expect(res.statusCode).toBe(503)
  })

  it('503s when the owning daemon is offline (NoConnection → 503)', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedSession()
    const offline = new ControlSender(
      { get: () => undefined } as unknown as ConstructorParameters<typeof ControlSender>[0],
      { currentLaunch: async () => undefined } as unknown as ConstructorParameters<typeof ControlSender>[1]
    )
    running = buildHttpApp(prisma, undefined, undefined, offline)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${SESSION}/messages` })
    expect(res.statusCode).toBe(503)
  })
})
