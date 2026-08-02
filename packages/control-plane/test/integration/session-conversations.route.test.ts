/**
 * Grouped sessions list (merged-conversation-view.md §5.2).
 *
 * `GET /sessions` returns one row per CONVERSATION by default — sessions
 * sharing `(platform, tenantScope, channel, thread)` group, collapsed to the
 * current session per agent — with emit-at-max pagination and the
 * `conversationKey` member resolver. `view=flat` keeps the pre-grouped shape
 * (covered by the pre-existing suites, now pinned to that view).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgHookRepo, PgSessionRepo, PgWebchatConversationRepo } from '../../src/persistence/index.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { handleEventSession } from '../../src/ws/handlers/index.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { InMemorySessionEventSink } from '../../src/events/sink.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { encodeConversationKey } from '../../src/http/conversation-key.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const AGENT_A = 'a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT_B = 'b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function reportSession(payload: Record<string, unknown>, daemonId = DAEMON): Promise<void> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'event/session',
    payload
  } as AnyFrame
  const deps = {
    agent: new PgAgentRepo(prisma),
    agentMutations: new AgentMutationGate(),
    hook: new PgHookRepo(prisma),
    session: new PgSessionRepo(prisma),
    webchatConversation: new PgWebchatConversationRepo(prisma),
    events: new InMemorySessionEventSink()
  } as unknown as DaemonWsDeps
  await handleEventSession(frame, { daemonId } as DaemonConnection, deps)
}

/** A Slack thread milestone at a given activity instant. */
function slackReport(sessionId: string, agentId: string, atMs: number, extra: Record<string, unknown> = {}) {
  const at = new Date(atMs).toISOString()
  return reportSession({
    sessionId,
    agentId,
    phase: 'start',
    platform: 'slack',
    channel: 'C-OPS',
    thread: 'T-1',
    transportScope: 'TEAM-1',
    lastActivityAt: at,
    ts: at,
    ...extra
  })
}

type ConversationsBody = {
  conversations: Array<{
    key: string | null
    platform: string | null
    channel: string | null
    thread: string | null
    sessions: Array<{ sessionId: string; agentId: string }>
  }>
  total: number | null
  nextCursor: string | null
}

describe('GET /sessions — grouped conversations', () => {
  it('groups a thread into one conversation, collapsed to the current session per agent', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    // Agent A: a superseded ACP session, then its replacement. Agent B: one.
    await slackReport('sess-a-old', AGENT_A, 1_000)
    await slackReport('sess-a-new', AGENT_A, 3_000)
    await slackReport('sess-b', AGENT_B, 2_000)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ConversationsBody
    expect(body.conversations).toHaveLength(1)
    expect(body.total).toBe(1)
    const conv = body.conversations[0]!
    expect(conv.platform).toBe('slack')
    expect(conv.channel).toBe('C-OPS')
    expect(conv.thread).toBe('T-1')
    expect(conv.key).toBe(
      encodeConversationKey({ platform: 'slack', tenantScope: 'TEAM-1', channel: 'C-OPS', thread: 'T-1' })
    )
    // Representative first (A's newest), one row per agent, superseded row gone.
    expect(conv.sessions.map((s) => s.sessionId)).toEqual(['sess-a-new', 'sess-b'])

    // The flat escape hatch still lists every row.
    const flat = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })
    expect((flat.json() as { sessions: unknown[] }).sessions).toHaveLength(3)
  })

  it('splits identical coordinates by tenant scope; null-scope legacy rows stand apart', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    await slackReport('sess-t1', AGENT_A, 1_000)
    await slackReport('sess-t2', AGENT_A, 2_000, { transportScope: 'TEAM-2' })
    await slackReport('sess-legacy', AGENT_A, 3_000, { transportScope: undefined })

    const stored = await prisma.sessionMeta.findUniqueOrThrow({ where: { id: 'sess-t2' } })
    expect(stored.tenantScope).toBe('TEAM-2')

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    const body = res.json() as ConversationsBody
    expect(body.conversations).toHaveLength(3)
    expect(body.total).toBe(3)
    expect(body.conversations.map((c) => c.sessions[0]!.sessionId)).toEqual(['sess-legacy', 'sess-t2', 'sess-t1'])
  })

  it('emit-at-max never re-emits a conversation across page boundaries', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    // Conversation X straddles the page cursor: members at t=100s and t=1s.
    // Conversation Y (different thread) sits between them at t=90s.
    await slackReport('sess-x-idle', AGENT_B, 1_000)
    await slackReport('sess-x-active', AGENT_A, 100_000)
    await slackReport('sess-y', AGENT_A, 90_000, { thread: 'T-2' })

    const first = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?limit=1` })
    const firstBody = first.json() as ConversationsBody
    expect(firstBody.conversations.map((c) => c.thread)).toEqual(['T-1'])
    expect(firstBody.total).toBe(2)
    expect(firstBody.nextCursor).not.toBeNull()

    const second = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`
    })
    const secondBody = second.json() as ConversationsBody
    // X's idle member row falls after the cursor but fails the emit-at-max
    // probe — X must NOT reappear; the page holds Y alone and the scan ends.
    expect(secondBody.conversations.map((c) => c.thread)).toEqual(['T-2'])
    expect(secondBody.nextCursor).toBeNull()
  })

  it('omits invisible members with no count or placeholder', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    // Restricted agent owned by another user — invisible to the caller. Its
    // participation must leave NO trace on the grouped row (§7: hidden
    // sessions' existence is itself hidden).
    const stranger = await prisma.user.create({
      data: { id: randomUUID(), email: `stranger-${randomUUID().slice(0, 8)}@example.com`, displayName: 'Stranger' }
    })
    await seedAgent(prisma, AGENT_B, {
      daemonId: DAEMON,
      visibility: 'restricted',
      ownerUserId: stranger.id
    })
    running = buildHttpApp(prisma)

    await slackReport('sess-vis', AGENT_A, 1_000)
    await slackReport('sess-hidden', AGENT_B, 2_000)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    const body = res.json() as ConversationsBody
    expect(body.conversations).toHaveLength(1)
    const conv = body.conversations[0]!
    expect(conv.sessions.map((s) => s.sessionId)).toEqual(['sess-vis'])
    expect(JSON.stringify(body)).not.toContain('sess-hidden')
    expect(JSON.stringify(body)).not.toContain(AGENT_B)
  })

  it('resolves one conversation by key, and a webchat conversation by its id', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON })
    const CONVO = 'c2c2c2c2-cccc-4ccc-8ccc-cccccccccccc'
    const conversations = new PgWebchatConversationRepo(prisma)
    await conversations.create(
      { conversationId: CONVO, orgId: OrgId(DEFAULT_ORG_ID), agentId: AgentId(AGENT_A), userId: DEFAULT_OWNER_ID },
      [AgentId(AGENT_B)]
    )
    running = buildHttpApp(prisma)

    await slackReport('sess-k1', AGENT_A, 1_000)
    await slackReport('sess-k2', AGENT_B, 2_000)
    for (const [session, agent, at] of [
      ['sess-wc-a', AGENT_A, 3_000],
      ['sess-wc-b', AGENT_B, 4_000]
    ] as const) {
      await reportSession({
        sessionId: session,
        agentId: agent,
        phase: 'start',
        platform: 'webchat',
        channel: CONVO,
        thread: CONVO,
        lastActivityAt: new Date(at).toISOString(),
        ts: new Date(at).toISOString()
      })
    }

    const imKey = encodeConversationKey({ platform: 'slack', tenantScope: 'TEAM-1', channel: 'C-OPS', thread: 'T-1' })!
    const im = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?conversationKey=${encodeURIComponent(imKey)}`
    })
    expect(im.statusCode).toBe(200)
    const imBody = im.json() as ConversationsBody
    expect(imBody.conversations).toHaveLength(1)
    expect(imBody.conversations[0]!.sessions.map((s) => s.sessionId)).toEqual(['sess-k2', 'sess-k1'])

    const wc = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?conversationKey=${CONVO}` })
    const wcBody = wc.json() as ConversationsBody
    expect(wcBody.conversations).toHaveLength(1)
    expect(wcBody.conversations[0]!.key).toBe(CONVO)
    expect(wcBody.conversations[0]!.sessions.map((s) => s.sessionId)).toEqual(['sess-wc-b', 'sess-wc-a'])

    const missing = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?conversationKey=${encodeURIComponent(
        encodeConversationKey({ platform: 'slack', tenantScope: null, channel: 'C-NONE', thread: 'T-0' })!
      )}`
    })
    expect((missing.json() as ConversationsBody).conversations).toHaveLength(0)

    const invalid = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?conversationKey=%21%21%21` })
    expect(invalid.statusCode).toBe(400)
  })
})
