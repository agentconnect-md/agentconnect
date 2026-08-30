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
import { seedDaemon, seedAgent, defaultAgentName } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgHookRepo, PgSessionRepo, PgWebchatConversationRepo } from '../../src/persistence/index.js'
import { AgentId, OrgId, SessionId } from '../../src/domain/ids.js'
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
  await handleEventSession(frame, { daemonId, orgId: DEFAULT_ORG_ID } as DaemonConnection, deps)
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
    sessions: Array<{ sessionId: string; agentId: string; contentPurgedAt?: string | null }>
    memberSessionIds: string[]
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

  it('includes Session-audience members even when their Agent is hidden', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    // Restricted Agent owned by another user — invisible to the caller. The
    // channel Session still follows its own org audience and remains readable.
    const stranger = await prisma.user.create({
      data: { id: randomUUID(), email: `stranger-${randomUUID().slice(0, 8)}@example.com`, displayName: 'Stranger' }
    })
    await seedAgent(prisma, AGENT_B, {
      daemonId: DAEMON,
      visibility: 'restricted',
      sharedWith: [stranger.id]
    })
    running = buildHttpApp(prisma)

    await slackReport('sess-vis', AGENT_A, 1_000)
    await slackReport('sess-hidden', AGENT_B, 2_000)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    const body = res.json() as ConversationsBody
    expect((await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT_B}` })).statusCode).toBe(404)
    expect(body.conversations).toHaveLength(1)
    const conv = body.conversations[0]!
    expect(conv.sessions.map((s) => s.sessionId)).toEqual(['sess-hidden', 'sess-vis'])
    expect(JSON.stringify(body)).toContain(AGENT_B)

    const facets = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/facets` })
    expect(facets.statusCode).toBe(200)
    expect(facets.json()).toMatchObject({
      agents: expect.arrayContaining([AGENT_A, AGENT_B]),
      agentNames: { [AGENT_A]: defaultAgentName(AGENT_A), [AGENT_B]: defaultAgentName(AGENT_B) }
    })
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
        // The daemon's real thread shape — the msgId form, not the bare id.
        thread: `webchat:${CONVO}`,
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

/**
 * Multi-agent filter: a repeated `agentId` asks for the conversations every
 * listed agent took part in. No single row is owned by two agents, so the
 * predicate is asked of the row's conversation; the rows returned stay scoped
 * to the selected agents, which is what keeps the one-agent form unchanged.
 */
describe('GET /sessions — multi-agent conversation filter', () => {
  const AGENT_C = 'c3c3c3c3-cccc-4ccc-8ccc-cccccccccccc'

  it('keeps only the threads both agents worked in, and only their rows', async () => {
    await seedDaemon(prisma, DAEMON)
    for (const agent of [AGENT_A, AGENT_B, AGENT_C]) await seedAgent(prisma, agent, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    // T-1: A, B and C. T-2: A alone. T-3: B alone.
    await slackReport('sess-shared-a', AGENT_A, 1_000)
    await slackReport('sess-shared-b', AGENT_B, 2_000)
    await slackReport('sess-shared-c', AGENT_C, 3_000)
    await slackReport('sess-a-only', AGENT_A, 4_000, { thread: 'T-2' })
    await slackReport('sess-b-only', AGENT_B, 5_000, { thread: 'T-3' })

    const flat = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?view=flat&agentId=${AGENT_A}&agentId=${AGENT_B}`
    })
    expect(flat.statusCode).toBe(200)
    const flatBody = flat.json() as { sessions: Array<{ sessionId: string }>; total: number | null }
    // The solo threads drop out; C's row stays out because it is not selected,
    // even though its conversation qualifies.
    expect(flatBody.sessions.map((s) => s.sessionId).sort()).toEqual(['sess-shared-a', 'sess-shared-b'])
    expect(flatBody.total).toBe(2)

    const grouped = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?agentId=${AGENT_A}&agentId=${AGENT_B}`
    })
    const groupedBody = grouped.json() as ConversationsBody
    expect(groupedBody.conversations).toHaveLength(1)
    expect(groupedBody.conversations[0]!.thread).toBe('T-1')
    expect(groupedBody.conversations[0]!.sessions.map((s) => s.sessionId)).toEqual(['sess-shared-b', 'sess-shared-a'])
    expect(groupedBody.total).toBe(1)

    // One agent is the pre-existing question and must answer it unchanged.
    const single = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat&agentId=${AGENT_A}` })
    expect((single.json() as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)).toEqual([
      'sess-a-only',
      'sess-shared-a'
    ])
  })

  it('names every visible member even when the filter returns one of them', async () => {
    await seedDaemon(prisma, DAEMON)
    for (const agent of [AGENT_A, AGENT_B]) await seedAgent(prisma, agent, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    await slackReport('sess-a-old', AGENT_A, 1_000)
    await slackReport('sess-a', AGENT_A, 2_000)
    await slackReport('sess-b', AGENT_B, 3_000)

    // Filtered to A: the ROWS are A's, but who took part is a property of the
    // conversation. A client that read membership off `sessions` would lose B —
    // and with it any way to keep following this conversation once B is the
    // newest member it is named after.
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?agentId=${AGENT_A}` })
    const conv = (res.json() as ConversationsBody).conversations[0]!
    expect(conv.sessions.map((s) => s.sessionId)).toEqual(['sess-a'])
    expect(conv.memberSessionIds).toEqual(['sess-b', 'sess-a'])

    // Unfiltered, membership and rows are the same set — superseded rows are
    // history in both.
    const all = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    const unfiltered = (all.json() as ConversationsBody).conversations[0]!
    expect(unfiltered.memberSessionIds).toEqual(unfiltered.sessions.map((s) => s.sessionId))
    expect(unfiltered.memberSessionIds).toEqual(['sess-b', 'sess-a'])
  })

  it('reports Session membership independently from Agent visibility', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    const stranger = await prisma.user.create({
      data: { id: randomUUID(), email: `stranger-${randomUUID().slice(0, 8)}@example.com`, displayName: 'Stranger' }
    })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON, visibility: 'restricted', sharedWith: [stranger.id] })
    running = buildHttpApp(prisma)

    await slackReport('sess-vis', AGENT_A, 1_000)
    await slackReport('sess-hidden', AGENT_B, 2_000)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?agentId=${AGENT_A}` })
    const body = res.json() as ConversationsBody
    expect((await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT_B}` })).statusCode).toBe(404)
    expect(body.conversations[0]!.sessions.map((session) => session.sessionId)).toEqual(['sess-vis'])
    expect(body.conversations[0]!.memberSessionIds).toEqual(['sess-hidden', 'sess-vis'])
  })

  it("lets a hidden Agent's visible Session qualify a conversation", async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    const stranger = await prisma.user.create({
      data: { id: randomUUID(), email: `stranger-${randomUUID().slice(0, 8)}@example.com`, displayName: 'Stranger' }
    })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON, visibility: 'restricted', sharedWith: [stranger.id] })
    running = buildHttpApp(prisma)

    await slackReport('sess-vis', AGENT_A, 1_000)
    await slackReport('sess-hidden', AGENT_B, 2_000)

    // Agent filters identify Session owners but do not grant Agent access. The
    // two visible Sessions qualify their shared conversation even though B's
    // Agent resource remains hidden.
    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?view=flat&agentId=${AGENT_A}&agentId=${AGENT_B}`
    })
    expect(res.statusCode).toBe(200)
    expect((await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT_B}` })).statusCode).toBe(404)
    const body = res.json() as { sessions: Array<{ sessionId: string }>; total: number | null }
    expect(body.sessions.map((session) => session.sessionId).sort()).toEqual(['sess-hidden', 'sess-vis'])
    expect(body.total).toBe(2)
  })

  it('excludes rows with no groupable key — a conversation of one holds no second agent', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    // A row with no thread has no groupable key, so it is a conversation of
    // one however many of them share a channel.
    await slackReport('sess-cron-a', AGENT_A, 1_000, { thread: undefined })
    await slackReport('sess-cron-b', AGENT_B, 2_000, { thread: undefined })

    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?view=flat&agentId=${AGENT_A}&agentId=${AGENT_B}`
    })
    expect((res.json() as { sessions: unknown[] }).sessions).toHaveLength(0)

    // Each is still its own conversation when the filter does not pair them.
    const solo = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat&agentId=${AGENT_A}` })
    expect((solo.json() as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)).toEqual([
      'sess-cron-a'
    ])
  })

  it('holds the key-addressed resolver to the same question as the list', async () => {
    await seedDaemon(prisma, DAEMON)
    for (const agent of [AGENT_A, AGENT_B]) await seedAgent(prisma, agent, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    await slackReport('sess-shared-a', AGENT_A, 1_000)
    await slackReport('sess-shared-b', AGENT_B, 2_000)
    await slackReport('sess-a-only', AGENT_A, 3_000, { thread: 'T-2' })

    const keyOf = (thread: string) =>
      encodeURIComponent(encodeConversationKey({ platform: 'slack', tenantScope: 'TEAM-1', channel: 'C-OPS', thread })!)
    const pair = `agentId=${AGENT_A}&agentId=${AGENT_B}`

    const shared = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?conversationKey=${keyOf('T-1')}&${pair}`
    })
    expect((shared.json() as ConversationsBody).conversations[0]!.sessions.map((s) => s.sessionId)).toEqual([
      'sess-shared-b',
      'sess-shared-a'
    ])

    // T-2 holds A but not B. Addressing it by key must not fall back to an `IN`
    // filter and answer with A's members — that is the wider "either agent"
    // question, under the very same query string.
    const soloByKey = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?conversationKey=${keyOf('T-2')}&${pair}`
    })
    expect(soloByKey.statusCode).toBe(200)
    expect((soloByKey.json() as ConversationsBody).conversations).toHaveLength(0)

    // …while the one-agent form still resolves it.
    const soloAlone = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?conversationKey=${keyOf('T-2')}&agentId=${AGENT_A}`
    })
    expect((soloAlone.json() as ConversationsBody).conversations[0]!.sessions.map((s) => s.sessionId)).toEqual([
      'sess-a-only'
    ])

    // Membership is the conversation's, not the query's, here too — the key form
    // and the grouped page must not disagree about who took part.
    const filtered = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?conversationKey=${keyOf('T-1')}&agentId=${AGENT_A}`
    })
    const conv = (filtered.json() as ConversationsBody).conversations[0]!
    expect(conv.sessions.map((s) => s.sessionId)).toEqual(['sess-shared-a'])
    expect(conv.memberSessionIds).toEqual(['sess-shared-b', 'sess-shared-a'])
  })

  it('answers empty when any requested agent does not belong to the organization', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    running = buildHttpApp(prisma)
    await slackReport('sess-a', AGENT_A, 1_000)
    const missingAgent = randomUUID()

    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?view=flat&agentId=${AGENT_A}&agentId=${missingAgent}`
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { sessions: unknown[]; total: number | null }).sessions).toHaveLength(0)

    const facets = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/facets?agentId=${missingAgent}`
    })
    expect(facets.statusCode).toBe(200)
    expect(facets.json()).toMatchObject({ agents: [], agentNames: {} })
  })

  it('pages the grouped list without re-emitting a filtered conversation', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    // Two qualifying threads, each with an old A row and a newer B row, so the
    // emit-at-max probe has to run under the participant predicate as well.
    await slackReport('sess-1-a', AGENT_A, 1_000)
    await slackReport('sess-1-b', AGENT_B, 10_000)
    await slackReport('sess-2-a', AGENT_A, 2_000, { thread: 'T-2' })
    await slackReport('sess-2-b', AGENT_B, 20_000, { thread: 'T-2' })

    const first = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?limit=1&agentId=${AGENT_A}&agentId=${AGENT_B}`
    })
    const firstBody = first.json() as ConversationsBody
    expect(firstBody.conversations.map((c) => c.thread)).toEqual(['T-2'])
    expect(firstBody.total).toBe(2)

    const second = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?limit=1&agentId=${AGENT_A}&agentId=${AGENT_B}&cursor=${encodeURIComponent(
        firstBody.nextCursor!
      )}`
    })
    const secondBody = second.json() as ConversationsBody
    expect(secondBody.conversations.map((c) => c.thread)).toEqual(['T-1'])
    expect(secondBody.nextCursor).toBeNull()
  })
})

describe('GET /sessions — retention-purge mark on conversation members (#485)', () => {
  it("reports each member's own mark, so a purged peer is visible to the console", async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON })
    await slackReport('s-a', AGENT_A, 1_000)
    await slackReport('s-b', AGENT_B, 2_000)

    // Only the NON-representative member is purged. The console derives its
    // partial-history notice from these per-member marks, so the route must carry
    // them rather than the representative's alone.
    const purgedAt = new Date('2026-08-04T09:00:00.000Z')
    await new PgSessionRepo(prisma).markContentPurged(AgentId(AGENT_A), [SessionId('s-a')], 'retention', purgedAt)

    running = await buildHttpApp(prisma)
    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?conversationKey=${encodeURIComponent(
        encodeConversationKey({ platform: 'slack', tenantScope: 'TEAM-1', channel: 'C-OPS', thread: 'T-1' })!
      )}`
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ConversationsBody
    const members = body.conversations[0]!.sessions
    // s-b is the representative (newer activity) and is NOT purged.
    expect(members[0]!.sessionId).toBe('s-b')
    expect(members[0]!.contentPurgedAt).toBeNull()
    expect(members.find((m) => m.sessionId === 's-a')!.contentPurgedAt).toBe(purgedAt.toISOString())
  })
})
