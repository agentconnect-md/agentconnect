// `PUT /sessions/read-state` → `session_read_state` → `GET /sessions` `unread`.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent, seedLaunch } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgHookRepo, PgSessionRepo, PgWebchatConversationRepo } from '../../src/persistence/index.js'
import { handleEventSession } from '../../src/ws/handlers/index.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { InMemorySessionEventSink } from '../../src/events/sink.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { ConnectionRegistry } from '../../src/ws/registry.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LAUNCH = '10101010-1111-4111-8111-111111111111'
const WEBCHAT = '4691f21b-3911-4d7f-a45d-28ce75d79337'
const SLACK = '5791f21b-3911-4d7f-a45d-28ce75d79338'
const PAST = '2026-07-05T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function report(sessionId: string, platform: string, lastActivityAt: string) {
  await handleEventSession(
    {
      v: 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'event/session',
      payload: {
        sessionId,
        agentId: AGENT,
        launchId: LAUNCH,
        phase: 'start',
        platform,
        channel: `C-${sessionId.slice(0, 4)}`,
        title: 'Roll out the release',
        lastActivityAt,
        ts: PAST
      }
    } as AnyFrame,
    { daemonId: DAEMON, orgId: DEFAULT_ORG_ID } as DaemonConnection,
    {
      connReg: new ConnectionRegistry(),
      agent: new PgAgentRepo(prisma),
      agentMutations: new AgentMutationGate(),
      hook: new PgHookRepo(prisma),
      session: new PgSessionRepo(prisma),
      webchatConversation: new PgWebchatConversationRepo(prisma),
      events: new InMemorySessionEventSink()
    } as unknown as DaemonWsDeps
  )
}

async function unreadIds(app: HttpApp): Promise<string[]> {
  const res = await app.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat&limit=50` })
  expect(res.statusCode).toBe(200)
  return (res.json() as { sessions: Array<{ sessionId: string; unread?: boolean }> }).sessions
    .filter((s) => s.unread)
    .map((s) => s.sessionId)
}

const markRead = (app: HttpApp, sessionIds: string[]) =>
  app.app.inject({ method: 'PUT', url: `${ORG}/sessions/read-state`, payload: { sessionIds } })

describe('session read state', () => {
  it('lists a webchat session as unread only for activity after the member last had it open', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    running = buildHttpApp(prisma)
    await report(WEBCHAT, 'webchat', PAST)
    await report(SLACK, 'slack', PAST)
    // An ownerless webchat row is ingested private; the caller has to be able to view it.
    await prisma.sessionMeta.update({ where: { id: WEBCHAT }, data: { visibility: 'org' } })

    // Never opened: nothing to compare against, so nothing is unread.
    expect(await unreadIds(running)).toEqual([])

    expect((await markRead(running, [WEBCHAT, SLACK, 'no-such-session'])).statusCode).toBe(204)
    expect(await unreadIds(running)).toEqual([])
    // An id the caller cannot resolve leaves no row behind.
    expect(await prisma.sessionReadState.count()).toBe(2)

    await report(WEBCHAT, 'webchat', FUTURE)
    await report(SLACK, 'slack', FUTURE)
    // A channel session is read on its own platform, whatever happened after the mark.
    expect(await unreadIds(running)).toEqual([WEBCHAT])

    // The grouped list carries the same flag on the member row.
    const grouped = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?limit=50` })
    const members = (
      grouped.json() as { conversations: Array<{ sessions: Array<{ sessionId: string; unread?: boolean }> }> }
    ).conversations.flatMap((c) => c.sessions)
    expect(members.filter((s) => s.unread).map((s) => s.sessionId)).toEqual([WEBCHAT])
  })

  it('never moves a watermark back', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    await report(WEBCHAT, 'webchat', PAST)
    const repo = new PgSessionRepo(prisma)
    const user = (await prisma.user.findFirstOrThrow()).id
    await repo.markRead(user, [WEBCHAT as never], new Date(FUTURE))
    await repo.markRead(user, [WEBCHAT as never], new Date(PAST))
    expect((await repo.readAtFor(user, [WEBCHAT])).get(WEBCHAT)?.toISOString()).toBe(FUTURE)
  })

  it('rejects an empty or oversized batch', async () => {
    running = buildHttpApp(prisma)
    expect((await markRead(running, [])).statusCode).toBe(400)
    expect(
      (
        await markRead(
          running,
          Array.from({ length: 51 }, (_, i) => `s${i}`)
        )
      ).statusCode
    ).toBe(400)
  })
})
