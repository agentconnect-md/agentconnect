/**
 * SessionRepo.recordMilestone — converged milestones, NO bodies (design §3.8, §6 Phase 1).
 *
 * One row per ACP session, storing ONLY the converged milestone + list/detail
 * metadata — never the message stream. Body-locality is enforced structurally:
 * there is no text/content/messages/body column to write.
 * `recordMilestone` is an upsert keyed on sessionId so repeated `event/session`
 * frames advance the same row's phase.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { DEF_ORG, seedAgent, seedDaemon, seedLaunch } from '../fixtures/seed.js'
import { DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { AgentId, BotId, DaemonId, LaunchId, SessionId } from '../../src/domain/ids.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const OTHER_DAEMON = 'd2222222-2222-4222-8222-222222222222'
const LAUNCH = '11111111-1111-4111-8111-111111111111'
const SESSION = '55555555-5555-4555-8555-555555555555'

async function fixtures(): Promise<void> {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT)
  await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
}

function ev(phase: 'start' | 'plan' | 'problem' | 'end', extra: Record<string, unknown> = {}) {
  return {
    sessionId: SessionId(SESSION),
    agentId: AgentId(AGENT),
    launchId: LaunchId(LAUNCH),
    phase,
    platform: 'slack' as const,
    channel: 'C1',
    thread: 'T1',
    at: new Date(),
    ...extra
  }
}

describe('SessionRepo.recordMilestone — milestone-only (real Postgres)', () => {
  const CONVERSATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  async function webchatFixture(): Promise<void> {
    await fixtures()
    await prisma.webchatConversation.create({
      data: { id: CONVERSATION, orgId: DEF_ORG, agentId: AGENT, userId: DEFAULT_OWNER_ID }
    })
  }

  function webchatEv(sessionId: string, phase: 'start' | 'end', at: Date) {
    return {
      sessionId: SessionId(sessionId),
      agentId: AgentId(AGENT),
      phase,
      platform: 'webchat' as const,
      channel: CONVERSATION,
      thread: '',
      at,
      classification: {
        visibility: 'private' as const,
        ownerIdentity: `user:${DEFAULT_OWNER_ID}`,
        source: 'default' as const
      }
    }
  }

  it('authorizes the current webchat session even after per-turn end milestones stamp endedAt', async () => {
    await webchatFixture()
    const repo = new PgSessionRepo(prisma)
    await repo.recordMilestone(webchatEv('acp-current', 'start', new Date('2026-07-05T10:00:00.000Z')))
    // The daemon emits phase 'end' after EVERY turn; an idle-between-turns
    // session (endedAt set) is still the currently installed one.
    await repo.recordMilestone(webchatEv('acp-current', 'end', new Date('2026-07-05T10:05:00.000Z')))

    const row = await prisma.sessionMeta.findUnique({ where: { id: 'acp-current' } })
    expect(row?.endedAt).not.toBeNull()
    expect(row?.visibility).toBe('private')
    expect(await repo.hasPrivateWebchatSession(CONVERSATION, AgentId(AGENT))).toBe(true)
  })

  it('never lets an old private row authorize once the pointer moved to a widened replacement', async () => {
    await webchatFixture()
    const repo = new PgSessionRepo(prisma)
    await repo.recordMilestone(webchatEv('acp-old-private', 'start', new Date('2026-07-05T10:00:00.000Z')))
    await repo.recordMilestone(webchatEv('acp-old-private', 'end', new Date('2026-07-05T10:05:00.000Z')))
    // Session rebuild: a replacement session becomes current and is widened.
    await repo.recordMilestone(webchatEv('acp-replacement', 'start', new Date('2026-07-05T11:00:00.000Z')))
    await prisma.sessionMeta.update({ where: { id: 'acp-replacement' }, data: { visibility: 'org' } })

    const conversation = await prisma.webchatConversation.findUnique({ where: { id: CONVERSATION } })
    expect(conversation?.currentSessionId).toBe('acp-replacement')
    expect(await repo.hasPrivateWebchatSession(CONVERSATION, AgentId(AGENT))).toBe(false)

    // A late re-emit from the OLD session must not steal the pointer back.
    await repo.recordMilestone(webchatEv('acp-old-private', 'end', new Date('2026-07-05T11:30:00.000Z')))
    const after = await prisma.webchatConversation.findUnique({ where: { id: CONVERSATION } })
    expect(after?.currentSessionId).toBe('acp-replacement')
    expect(await repo.hasPrivateWebchatSession(CONVERSATION, AgentId(AGENT))).toBe(false)
  })

  it('fails closed when the conversation has no current-session pointer', async () => {
    await webchatFixture()
    const repo = new PgSessionRepo(prisma)
    // Historical rows exist, but nothing maintained the pointer (e.g. the
    // session row was deleted → FK SetNull).
    await prisma.sessionMeta.create({
      data: {
        id: 'orphan-private',
        agentId: AGENT,
        platform: 'webchat',
        channel: CONVERSATION,
        phase: 'start',
        orgId: DEF_ORG,
        ownerIdentity: `user:${DEFAULT_OWNER_ID}`,
        visibility: 'private',
        visibilitySource: 'default',
        lastActivityAt: new Date(),
        startedAt: new Date()
      }
    })
    expect(await repo.hasPrivateWebchatSession(CONVERSATION, AgentId(AGENT))).toBe(false)
  })

  it('creates a session row on the first milestone with the launch tie', async () => {
    await fixtures()
    const repo = new PgSessionRepo(prisma)

    const lastActivityAt = new Date('2026-07-05T10:51:00.000Z')
    await repo.recordMilestone(
      ev('start', {
        summary: 'kickoff',
        link: 'https://x/y',
        title: 'Roll out api@1.4.2',
        status: 'prompting',
        lastActivityAt,
        triggeredBy: 'U-DANA',
        channelName: 'deploys',
        triggeredByName: 'Dana Reyes',
        threadUrl: 'https://slack.example/archives/C1/p1',
        runtime: 'claude',
        model: 'opus',
        effort: 'high',
        fastMode: false,
        permissionMode: 'acceptEdits',
        outputMode: 'medium',
        daemonId: DaemonId(DAEMON)
      })
    )

    const got = await repo.get(SessionId(SESSION))
    expect(got).not.toBeNull()
    expect(got?.phase).toBe('start')
    expect(got?.launchId).toBe(LAUNCH)
    expect(got?.summary).toBe('kickoff')
    expect(got?.link).toBe('https://x/y')
    expect(got?.platform).toBe('slack')
    expect(got?.title).toBe('Roll out api@1.4.2')
    expect(got?.status).toBe('prompting')
    expect(got?.lastActivityAt?.toISOString()).toBe(lastActivityAt.toISOString())
    expect(got?.triggeredBy).toBe('U-DANA')
    expect(got?.channelName).toBe('deploys')
    expect(got?.triggeredByName).toBe('Dana Reyes')
    expect(got?.threadUrl).toBe('https://slack.example/archives/C1/p1')
    expect(got?.runtime).toBe('claude')
    expect(got?.model).toBe('opus')
    expect(got?.effort).toBe('high')
    expect(got?.fastMode).toBe(false) // an explicit false roundtrips (≠ null/unset)
    expect(got?.permissionMode).toBe('acceptEdits')
    expect(got?.outputMode).toBe('medium')
    expect(got?.daemonId).toBe(DAEMON)
  })

  it('keeps the recorded execution config when a later milestone omits it', async () => {
    await fixtures()
    const repo = new PgSessionRepo(prisma)

    await repo.recordMilestone(
      ev('start', { runtime: 'claude', model: 'opus', effort: 'high', fastMode: true, daemonId: DaemonId(DAEMON) })
    )
    await repo.recordMilestone(ev('end')) // e.g. an old daemon's refresh — no exec-config echo

    const got = await repo.get(SessionId(SESSION))
    expect(got?.runtime).toBe('claude')
    expect(got?.model).toBe('opus')
    expect(got?.effort).toBe('high')
    expect(got?.fastMode).toBe(true)
    expect(got?.daemonId).toBe(DAEMON)

    // A later snapshot CAN move them (e.g. in-session model switch on the next turn).
    await repo.recordMilestone(ev('end', { model: 'sonnet', fastMode: false }))
    const moved = await repo.get(SessionId(SESSION))
    expect(moved?.model).toBe('sonnet')
    expect(moved?.fastMode).toBe(false)
  })

  it('advances phase on subsequent milestones (upsert on sessionId)', async () => {
    await fixtures()
    const repo = new PgSessionRepo(prisma)

    await repo.recordMilestone(ev('start'))
    await repo.recordMilestone(ev('plan', { summary: 'planning' }))
    await repo.recordMilestone(ev('end', { link: 'https://done' }))

    const got = await repo.get(SessionId(SESSION))
    expect(got?.phase).toBe('end')
    expect(got?.summary).toBe('planning') // last non-empty summary retained
    expect(got?.link).toBe('https://done')
    expect(got?.endedAt).not.toBeNull() // end phase stamps endedAt

    // still exactly one row — it's an upsert, not an append
    const all = await repo.list({ agentId: AgentId(AGENT) })
    expect(all).toHaveLength(1)
  })

  it('never rebinds an existing session id to another agent', async () => {
    await fixtures()
    await seedAgent(prisma, OTHER_AGENT, { daemonId: DAEMON })
    const repo = new PgSessionRepo(prisma)

    expect((await repo.recordMilestone(ev('start', { title: 'Original', daemonId: DaemonId(DAEMON) }))).recorded).toBe(
      true
    )
    expect(
      (
        await repo.recordMilestone(
          ev('end', {
            agentId: AgentId(OTHER_AGENT),
            launchId: undefined,
            title: 'Forged',
            daemonId: DaemonId(DAEMON)
          })
        )
      ).recorded
    ).toBe(false)

    const got = await repo.get(SessionId(SESSION))
    expect(got?.agentId).toBe(AGENT)
    expect(got?.title).toBe('Original')
    expect(got?.phase).toBe('start')
  })

  it('atomically assigns a concurrently reported session id to only one agent', async () => {
    await fixtures()
    await seedAgent(prisma, OTHER_AGENT, { daemonId: DAEMON })
    const repo = new PgSessionRepo(prisma)

    const accepted = await Promise.all([
      repo.recordMilestone(ev('start', { title: 'Agent A', daemonId: DaemonId(DAEMON) })),
      repo.recordMilestone(
        ev('end', {
          agentId: AgentId(OTHER_AGENT),
          launchId: undefined,
          title: 'Agent B',
          daemonId: DaemonId(DAEMON)
        })
      )
    ])

    expect(accepted.filter((result) => result.recorded)).toHaveLength(1)
    const got = await repo.get(SessionId(SESSION))
    if (accepted[0]!.recorded) {
      expect(got).toMatchObject({ agentId: AGENT, title: 'Agent A', phase: 'start' })
    } else {
      expect(got).toMatchObject({ agentId: OTHER_AGENT, title: 'Agent B', phase: 'end' })
    }
  })

  it('does not regress a terminal phase on later metadata refreshes', async () => {
    await fixtures()
    const repo = new PgSessionRepo(prisma)

    await repo.recordMilestone(ev('start', { title: 'fallback', status: 'prompting' }))
    await repo.recordMilestone(ev('end', { status: 'idle' }))
    await repo.recordMilestone(ev('plan', { title: 'Runtime title', status: 'idle', channelName: 'deploys' }))

    const got = await repo.get(SessionId(SESSION))
    expect(got?.phase).toBe('end')
    expect(got?.title).toBe('Runtime title')
    expect(got?.status).toBe('idle')
    expect(got?.channelName).toBe('deploys')
    expect(got?.endedAt).not.toBeNull()
  })

  it('stores NO message body — the schema has only milestone metadata', async () => {
    await fixtures()
    const repo = new PgSessionRepo(prisma)
    await repo.recordMilestone(ev('plan', { summary: 's' }))

    // Assert structurally: the session_meta table has no text/content/messages column.
    const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'session_meta'`
    )
    const names = cols.map((c) => c.column_name)
    expect(names).not.toContain('text')
    expect(names).not.toContain('content')
    expect(names).not.toContain('messages')
    expect(names).not.toContain('body')
    // it DOES have the converged-milestone fields
    expect(names).toContain('phase')
    expect(names).toContain('summary')
  })

  it('filters by platform/channel in list()', async () => {
    await fixtures()
    const repo = new PgSessionRepo(prisma)
    await repo.recordMilestone(ev('start'))

    expect(await repo.list({ platform: 'slack', channel: 'C1' })).toHaveLength(1)
    expect(await repo.list({ platform: 'telegram' })).toHaveLength(0)
  })

  it("scopes shared-bot thread fallback to the bot's active, currently placed agent", async () => {
    await fixtures()
    await seedDaemon(prisma, OTHER_DAEMON)
    await seedAgent(prisma, OTHER_AGENT, { daemonId: OTHER_DAEMON })
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: DAEMON, status: 'active' } })
    const repo = new PgSessionRepo(prisma)
    const botId = '22222222-2222-4222-8222-222222222221'
    const otherBotId = '22222222-2222-4222-8222-222222222222'
    const integrationId = '66666666-6666-4666-8666-666666666661'

    await prisma.bot.createMany({
      data: [
        { id: botId, orgId: DEF_ORG, platform: 'slack', name: 'requested-bot' },
        { id: otherBotId, orgId: DEF_ORG, platform: 'slack', name: 'other-bot' }
      ]
    })
    await prisma.integration.createMany({
      data: [
        { id: integrationId, orgId: DEF_ORG, agentId: AGENT, botId, name: 'requested-bot' },
        {
          id: '66666666-6666-4666-8666-666666666662',
          orgId: DEF_ORG,
          agentId: OTHER_AGENT,
          botId: otherBotId,
          name: 'other-bot'
        }
      ]
    })
    await repo.recordMilestone(
      ev('start', {
        sessionId: SessionId('requested-bot-session'),
        daemonId: DaemonId(DAEMON),
        lastActivityAt: new Date('2026-07-05T08:08:00.000Z')
      })
    )
    await repo.recordMilestone(
      ev('start', {
        sessionId: SessionId('other-bot-session'),
        agentId: AgentId(OTHER_AGENT),
        launchId: undefined,
        daemonId: DaemonId(OTHER_DAEMON),
        lastActivityAt: new Date('2026-07-05T10:51:00.000Z')
      })
    )

    expect(await repo.findThreadOwner(BotId(botId), 'C1', 'T1')).toEqual({
      agentId: AGENT,
      daemonId: DAEMON
    })
    expect(await repo.findThreadOwner(BotId(otherBotId), 'C1', 'T1')).toEqual({
      agentId: OTHER_AGENT,
      daemonId: OTHER_DAEMON
    })

    await prisma.integration.update({ where: { id: integrationId }, data: { status: 'revoked' } })
    expect(await repo.findThreadOwner(BotId(botId), 'C1', 'T1')).toBeNull()

    await prisma.integration.update({ where: { id: integrationId }, data: { status: 'active' } })
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: OTHER_DAEMON } })
    expect(await repo.findThreadOwner(BotId(botId), 'C1', 'T1')).toEqual({
      agentId: AGENT,
      daemonId: OTHER_DAEMON
    })

    await prisma.daemon.delete({ where: { id: DAEMON } })
    expect(await repo.findThreadOwner(BotId(botId), 'C1', 'T1')).toEqual({
      agentId: AGENT,
      daemonId: OTHER_DAEMON
    })

    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: null, status: 'inactive' } })
    expect(await repo.findThreadOwner(BotId(botId), 'C1', 'T1')).toBeNull()
  })

  it('joins usage into list() and sorts by latest activity', async () => {
    await fixtures()
    const repo = new PgSessionRepo(prisma)
    const older = SessionId('older-session')
    const newer = SessionId('newer-session')
    await repo.recordMilestone(
      ev('start', {
        sessionId: older,
        lastActivityAt: new Date('2026-07-05T08:08:00.000Z')
      })
    )
    await repo.recordMilestone(
      ev('start', {
        sessionId: newer,
        lastActivityAt: new Date('2026-07-05T10:51:00.000Z')
      })
    )
    await prisma.sessionUsage.create({
      data: {
        agentId: AGENT,
        sessionId: newer,
        platform: 'slack',
        channel: 'C1',
        lastActivityAt: new Date('2026-07-05T10:51:00.000Z'),
        totalTokens: 123,
        inputTokens: 100,
        outputTokens: 23
      }
    })

    const list = await repo.list({ agentId: AgentId(AGENT) })
    expect(list.map((s) => s.id)).toEqual([newer, older])
    expect(list[0]!.usage?.totalTokens).toBe(123)
    expect(list[0]!.usage?.inputTokens).toBe(100)
    expect(list[1]!.usage).toBeNull()
  })
})

describe('SessionRepo.markContentPurged — retention-GC receipt (#485)', () => {
  const OTHER_SESSION = '66666666-6666-4666-8666-666666666666'

  it("stamps the reporting agent's rows, keeps the metadata, and is first-wins", async () => {
    await fixtures()
    await seedAgent(prisma, OTHER_AGENT)
    const repo = new PgSessionRepo(prisma)
    await repo.recordMilestone(ev('end', { title: 'nightly review' }))
    await repo.recordMilestone(ev('end', { sessionId: SessionId(OTHER_SESSION), agentId: AgentId(OTHER_AGENT) }))

    const purgedAt = new Date('2026-08-04T09:00:00.000Z')
    const first = await repo.markContentPurged(
      AgentId(AGENT),
      // The foreign row is claimed too: a session id is only a purge claim for the
      // agent it is bound to, so it must be skipped rather than stamped.
      [SessionId(SESSION), SessionId(OTHER_SESSION)],
      'retention',
      purgedAt
    )
    expect(first.marked).toEqual([SessionId(SESSION)])
    expect(first.alreadyPurged).toBe(1)

    const row = await repo.get(SessionId(SESSION))
    expect(row?.contentPurgedAt).toEqual(purgedAt)
    expect(row?.contentPurgedReason).toBe('retention')
    // The metadata row survives the purge — it is the whole remaining record.
    expect(row?.title).toBe('nightly review')
    expect((await repo.get(SessionId(OTHER_SESSION)))?.contentPurgedAt).toBeNull()

    // At-least-once redelivery must not move the date the content went away.
    const again = await repo.markContentPurged(
      AgentId(AGENT),
      [SessionId(SESSION)],
      'retention',
      new Date('2026-09-01T00:00:00.000Z')
    )
    expect(again.marked).toEqual([])
    expect((await repo.get(SessionId(SESSION)))?.contentPurgedAt).toEqual(purgedAt)
  })

  it('is a no-op for an unknown session and for an empty report', async () => {
    await fixtures()
    const repo = new PgSessionRepo(prisma)
    expect(await repo.markContentPurged(AgentId(AGENT), [], 'retention', new Date())).toEqual({
      marked: [],
      alreadyPurged: 0
    })
    const unknown = await repo.markContentPurged(AgentId(AGENT), [SessionId(OTHER_SESSION)], 'retention', new Date())
    expect(unknown.marked).toEqual([])
  })
})
