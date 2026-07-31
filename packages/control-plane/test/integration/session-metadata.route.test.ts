/**
 * Session metadata sync + deep-link detail.
 *
 * Sessions are created on the Slack/Discord→daemon path; the daemon reports each
 * one via `event/session` (D→C EVT). The CP stores it in `SessionMeta` so the
 * deep-link detail page (`GET /sessions/:id`) resolves from CP metadata — even
 * when the daemon is offline. Here we dispatch the frame through the real handler
 * and read it back through the org-scoped route.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent, seedLaunch } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgSessionRepo } from '../../src/persistence/index.js'
import { handleEventSession } from '../../src/ws/handlers/index.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { InMemorySessionEventSink } from '../../src/events/sink.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LAUNCH = '10101010-1111-4111-8111-111111111111'
const SESSION = '4691f21b-3911-4d7f-a45d-28ce75d79337'

/** Dispatch an `event/session` EVT through the real handler (stores SessionMeta). */
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
    session: new PgSessionRepo(prisma),
    events: new InMemorySessionEventSink()
  } as unknown as DaemonWsDeps
  await handleEventSession(frame, { daemonId } as DaemonConnection, deps)
}

describe('event/session sync → SessionMeta → GET /sessions/:id', () => {
  it('drops a foreign daemon report before it reaches session storage', async () => {
    const otherDaemon = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, otherDaemon)
    await seedAgent(prisma, AGENT, { daemonId: otherDaemon })

    await reportSession({
      sessionId: SESSION,
      agentId: AGENT,
      phase: 'start',
      platform: 'slack',
      channel: 'C123',
      title: 'Forged',
      ts: '2026-07-05T00:00:00.000Z'
    })

    expect(await prisma.sessionMeta.findUnique({ where: { id: SESSION } })).toBeNull()
  })

  it('stores a daemon-reported session and serves it at the deep-link detail route', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    running = buildHttpApp(prisma)

    await reportSession({
      sessionId: SESSION,
      agentId: AGENT,
      launchId: LAUNCH,
      phase: 'plan',
      platform: 'slack',
      channel: 'C123',
      thread: 'T9',
      summary: 'drafted a plan',
      title: 'Roll out api@1.4.2',
      status: 'prompting',
      lastActivityAt: '2026-07-05T00:00:01.000Z',
      triggeredBy: 'U-DANA',
      channelName: 'deploys',
      triggeredByName: 'Dana Reyes',
      threadUrl: 'https://slack.example/archives/C123/pT9',
      runtime: 'claude',
      model: 'opus',
      effort: 'high',
      fastMode: true,
      permissionMode: 'acceptEdits',
      outputMode: 'medium',
      ts: '2026-07-05T00:00:00.000Z'
    })
    await prisma.sessionUsage.create({
      data: {
        agentId: AGENT,
        sessionId: SESSION,
        platform: 'slack',
        channel: 'C123',
        totalTokens: 1_200,
        inputTokens: 1_000,
        outputTokens: 200,
        costAmount: 0.012,
        costCurrency: 'USD',
        lastActivityAt: new Date('2026-07-05T00:00:01.000Z')
      }
    })

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${SESSION}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      id: string
      agentId: string
      platform: string | null
      channel: string | null
      thread: string | null
      phase: string
      summary: string | null
      runtime: string | null
      model: string | null
      effort: string | null
      fastMode: boolean | null
      permissionMode: string | null
      outputMode: string | null
      daemonId: string | null
      usage: {
        reportedAt: string
        totalTokens: number
        inputTokens: number
        outputTokens: number
        costAmount: number
        costCurrency: string
      }
    }
    expect(body.id).toBe(SESSION)
    expect(body.agentId).toBe(AGENT)
    expect(body.platform).toBe('slack')
    expect(body.channel).toBe('C123')
    expect(body.thread).toBe('T9')
    expect(body.phase).toBe('plan')
    expect(body.summary).toBe('drafted a plan')
    expect(body.runtime).toBe('claude')
    expect(body.model).toBe('opus')
    expect(body.effort).toBe('high')
    expect(body.fastMode).toBe(true)
    expect(body.permissionMode).toBe('acceptEdits')
    expect(body.outputMode).toBe('medium')
    expect(body.daemonId).toBe(DAEMON) // CP-stamped from the reporting WS connection
    expect(body.usage).toMatchObject({
      reportedAt: '2026-07-05T00:00:01.000Z',
      totalTokens: 1_200,
      inputTokens: 1_000,
      outputTokens: 200,
      costAmount: 0.012,
      costCurrency: 'USD'
    })

    const stored = await prisma.sessionMeta.findUniqueOrThrow({ where: { id: SESSION } })
    expect(stored.title).toBe('Roll out api@1.4.2')
    expect(stored.status).toBe('prompting')
    expect(stored.lastActivityAt?.toISOString()).toBe('2026-07-05T00:00:01.000Z')
    expect(stored.triggeredBy).toBe('U-DANA')
    expect(stored.channelName).toBe('deploys')
    expect(stored.triggeredByName).toBe('Dana Reyes')
    expect(stored.threadUrl).toBe('https://slack.example/archives/C123/pT9')
    expect(stored.runtime).toBe('claude')
    expect(stored.model).toBe('opus')
    expect(stored.effort).toBe('high')
    expect(stored.fastMode).toBe(true)
    expect(stored.permissionMode).toBe('acceptEdits')
    expect(stored.outputMode).toBe('medium')
    expect(stored.daemonId).toBe(DAEMON)

    // The list route carries the same execution-config snapshot.
    const list = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    expect(list.statusCode).toBe(200)
    const listBody = list.json() as {
      sessions: Array<{
        runtime: string | null
        model: string | null
        effort: string | null
        fastMode: boolean | null
        permissionMode: string | null
        outputMode: string | null
        daemonId: string | null
        usage: { reportedAt: string; totalTokens: number } | null
      }>
    }
    expect(listBody.sessions[0]!.runtime).toBe('claude')
    expect(listBody.sessions[0]!.model).toBe('opus')
    expect(listBody.sessions[0]!.effort).toBe('high')
    expect(listBody.sessions[0]!.fastMode).toBe(true)
    expect(listBody.sessions[0]!.permissionMode).toBe('acceptEdits')
    expect(listBody.sessions[0]!.outputMode).toBe('medium')
    expect(listBody.sessions[0]!.daemonId).toBe(DAEMON)
    expect(listBody.sessions[0]!.usage?.totalTokens).toBe(1_200)
    expect(listBody.sessions[0]!.usage?.reportedAt).toBe('2026-07-05T00:00:01.000Z')
  })

  it('is idempotent — a later milestone advances the same session row', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedLaunch(prisma, LAUNCH, AGENT, DAEMON)
    running = buildHttpApp(prisma)

    const base = { sessionId: SESSION, agentId: AGENT, launchId: LAUNCH, platform: 'slack', channel: 'C1' }
    await reportSession({ ...base, phase: 'start', ts: '2026-07-05T00:00:00.000Z' })
    await reportSession({ ...base, phase: 'end', ts: '2026-07-05T00:05:00.000Z' })

    expect(await prisma.sessionMeta.count()).toBe(1) // one row, upserted
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${SESSION}` })
    expect((res.json() as { phase: string; endedAt: string | null }).phase).toBe('end')
    expect((res.json() as { endedAt: string | null }).endedAt).not.toBeNull()
  })

  it('returns parent and child session links from daemon-reported lineage', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    const parent = 'acp-parent'
    const firstChild = 'acp-child-1'
    const secondChild = 'acp-child-2'
    const base = { agentId: AGENT, phase: 'start', platform: 'slack', channel: 'C1' }
    await reportSession({
      ...base,
      sessionId: parent,
      title: 'Coordinate the rollout',
      ts: '2026-07-05T00:00:00.000Z'
    })
    await reportSession({
      ...base,
      sessionId: firstChild,
      parentSessionId: parent,
      platform: 'telegram',
      title: 'Check the database',
      ts: '2026-07-05T00:01:00.000Z'
    })
    await reportSession({
      ...base,
      sessionId: secondChild,
      parentSessionId: parent,
      platform: 'discord',
      title: 'Check the API',
      ts: '2026-07-05T00:02:00.000Z'
    })

    const parentRes = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${parent}` })
    expect(parentRes.statusCode).toBe(200)
    expect(
      (
        parentRes.json() as {
          parentSession: unknown
          childSessions: Array<{ id: string; platform: string; title: string | null }>
        }
      ).childSessions
    ).toEqual([
      { id: firstChild, agentId: AGENT, platform: 'telegram', title: 'Check the database' },
      { id: secondChild, agentId: AGENT, platform: 'discord', title: 'Check the API' }
    ])
    expect((parentRes.json() as { parentSession: unknown }).parentSession).toBeNull()

    const childRes = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${firstChild}` })
    expect(childRes.statusCode).toBe(200)
    expect(
      (childRes.json() as { parentSession: { id: string; platform: string; title: string | null } | null })
        .parentSession
    ).toEqual({
      id: parent,
      agentId: AGENT,
      platform: 'slack',
      title: 'Coordinate the rollout'
    })
    expect((childRes.json() as { childSessions: unknown[] }).childSessions).toEqual([])
  })

  it('stores a Slack-path session (non-UUID ACP id, no launchId) and serves it', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    running = buildHttpApp(prisma)

    // A Slack→daemon session: the ACP session id is a free string and there is no
    // CP launch fence (launchId omitted).
    const acpSession = 'acp-sess-01H9XYZ'
    await reportSession({
      sessionId: acpSession,
      agentId: AGENT,
      phase: 'start',
      platform: 'slack',
      channel: 'C7',
      ts: '2026-07-05T00:00:00.000Z'
    })

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${acpSession}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string; launchId: string | null; channel: string | null }
    expect(body.id).toBe(acpSession)
    expect(body.launchId).toBeNull()
    expect(body.channel).toBe('C7')
  })

  it('lists hydrated hook sessions with stable source kind across hook reassignment', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const reassignedAgent = randomUUID()
    await seedAgent(prisma, reassignedAgent, { daemonId: DAEMON })
    const webhookId = randomUUID()
    await prisma.hookDef.create({
      data: {
        id: webhookId,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        kind: 'webhook',
        name: 'acme/build',
        sessionMode: 'perDelivery',
        urlToken: `whk_${randomUUID().replace(/-/g, '')}`,
        targetPlatform: 'slack'
      }
    })
    const githubId = randomUUID()
    await prisma.hookDef.create({
      data: {
        id: githubId,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        kind: 'github',
        name: 'owner/repo',
        sessionMode: 'perThread',
        repoId: 123n,
        repoFullName: 'owner/repo',
        events: ['pull_request:*'],
        targetPlatform: 'slack',
        targetChannel: 'C123'
      }
    })
    running = buildHttpApp(prisma)

    await reportSession({
      sessionId: 'acp-webhook-1',
      agentId: AGENT,
      phase: 'start',
      platform: 'hook',
      channel: webhookId,
      thread: 'delivery-1',
      title: 'Reply with a one-line hello',
      triggeredBy: `hook:${webhookId}`,
      ts: '2026-07-05T00:00:00.000Z'
    })
    await reportSession({
      sessionId: 'acp-github-1',
      agentId: AGENT,
      phase: 'start',
      platform: 'slack',
      channel: 'C123',
      channelName: 'release-events',
      thread: 'github-delivery-1',
      title: 'Review pull request',
      triggeredBy: `hook:${githubId}`,
      triggeredByName: 'owner/repo',
      ts: '2026-07-05T00:00:00.000Z'
    })
    await reportSession({
      sessionId: 'acp-github-headless',
      agentId: AGENT,
      phase: 'start',
      platform: 'hook',
      channel: githubId,
      title: 'Review pull request headlessly',
      triggeredBy: `hook:${githubId}`,
      channelName: 'owner/repo',
      triggeredByName: 'owner/repo',
      ts: '2026-07-05T00:00:00.000Z'
    })
    await prisma.hookDef.update({
      where: { id: githubId },
      data: { agentId: reassignedAgent, name: 'new-owner/repo' }
    })

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      sessions: Array<{
        sessionId: string
        sessionKey: { platform: string; channel: string; thread?: string }
        hookKind: 'webhook' | 'github' | null
        channelName: string | null
        triggeredBy: string | null
        triggeredByName: string | null
      }>
    }
    const webhook = body.sessions.find((session) => session.sessionId === 'acp-webhook-1')
    const github = body.sessions.find((session) => session.sessionId === 'acp-github-1')
    const headlessGithub = body.sessions.find((session) => session.sessionId === 'acp-github-headless')
    expect(webhook).toMatchObject({
      sessionKey: { platform: 'hook', channel: webhookId, thread: 'delivery-1' },
      hookKind: 'webhook',
      channelName: 'acme/build',
      triggeredBy: `hook:${webhookId}`,
      triggeredByName: 'acme/build'
    })
    expect(github).toMatchObject({
      sessionKey: { platform: 'slack', channel: 'C123', thread: 'github-delivery-1' },
      hookKind: 'github',
      channelName: 'release-events',
      triggeredBy: `hook:${githubId}`,
      triggeredByName: 'owner/repo'
    })
    expect(headlessGithub).toMatchObject({
      sessionKey: { platform: 'hook', channel: githubId },
      hookKind: 'github',
      channelName: 'owner/repo',
      triggeredBy: `hook:${githubId}`,
      triggeredByName: 'owner/repo'
    })

    const filtered = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?integration=github` })
    expect(filtered.statusCode).toBe(200)
    expect(
      (filtered.json() as { sessions: Array<{ sessionId: string }>; total: number }).sessions.map(
        (session) => session.sessionId
      )
    ).toEqual(['acp-github-headless'])
    expect((filtered.json() as { total: number }).total).toBe(1)

    const genericWebhook = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?integration=hook` })
    expect(genericWebhook.statusCode).toBe(200)
    expect(
      (genericWebhook.json() as { sessions: Array<{ sessionId: string }> }).sessions.map((session) => session.sessionId)
    ).toEqual(['acp-webhook-1'])

    const facets = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/facets` })
    expect(facets.statusCode).toBe(200)
    const facetBody = facets.json() as {
      integrations: string[]
      triggers: Array<{ value: string; hookKind: 'webhook' | 'github' | null }>
    }
    expect(facetBody.integrations).toEqual(expect.arrayContaining(['slack', 'hook', 'github']))
    expect(facetBody.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: `hook:${webhookId}`, hookKind: 'webhook' }),
        expect.objectContaining({ value: `hook:${githubId}`, hookKind: 'github' })
      ])
    )
  })

  it('404s for an unknown session', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${randomUUID()}` })
    expect(res.statusCode).toBe(404)
  })
})
