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
import { seedDaemon, seedAgent, seedLaunch, defaultAgentName } from '../fixtures/seed.js'
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
    hook: new PgHookRepo(prisma),
    session: new PgSessionRepo(prisma),
    // Resolves the private-session owner for webchat reports (session-visibility
    // §4.2) — without it a webchat session stores ownerless and no caller can view it.
    webchatConversation: new PgWebchatConversationRepo(prisma),
    events: new InMemorySessionEventSink()
  } as unknown as DaemonWsDeps
  await handleEventSession(frame, { daemonId, orgId: DEFAULT_ORG_ID } as DaemonConnection, deps)
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
      workspaceIsolation: 'session',
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
      workspaceIsolation: 'shared' | 'session' | null
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
    expect(body.workspaceIsolation).toBe('session')
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
    expect(stored.workspaceIsolation).toBe('session')
    expect(stored.daemonId).toBe(DAEMON)

    // The list route carries the same execution-config snapshot.
    const list = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })
    expect(list.statusCode).toBe(200)
    const listBody = list.json() as {
      sessions: Array<{
        runtime: string | null
        model: string | null
        effort: string | null
        fastMode: boolean | null
        permissionMode: string | null
        outputMode: string | null
        workspaceIsolation: 'shared' | 'session' | null
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
    expect(listBody.sessions[0]!.workspaceIsolation).toBe('session')
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

  it('returns parent, sibling, and child session links from daemon-reported lineage', async () => {
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
          siblingSessions: unknown[]
          childSessions: Array<{ id: string; platform: string; title: string | null }>
        }
      ).childSessions
    ).toEqual([
      {
        id: firstChild,
        agentId: AGENT,
        agentName: defaultAgentName(AGENT),
        platform: 'telegram',
        title: 'Check the database'
      },
      {
        id: secondChild,
        agentId: AGENT,
        agentName: defaultAgentName(AGENT),
        platform: 'discord',
        title: 'Check the API'
      }
    ])
    expect((parentRes.json() as { parentSession: unknown }).parentSession).toBeNull()
    expect((parentRes.json() as { siblingSessions: unknown[] }).siblingSessions).toEqual([])

    const childRes = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${firstChild}` })
    expect(childRes.statusCode).toBe(200)
    expect(
      (childRes.json() as { parentSession: { id: string; platform: string; title: string | null } | null })
        .parentSession
    ).toEqual({
      id: parent,
      agentId: AGENT,
      agentName: defaultAgentName(AGENT),
      platform: 'slack',
      title: 'Coordinate the rollout'
    })
    expect((childRes.json() as { siblingSessions: unknown[] }).siblingSessions).toEqual([
      {
        id: secondChild,
        agentId: AGENT,
        agentName: defaultAgentName(AGENT),
        platform: 'discord',
        title: 'Check the API'
      }
    ])
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

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })
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

    const webhookDetail = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/acp-webhook-1` })
    expect(webhookDetail.statusCode).toBe(200)
    expect(webhookDetail.json()).toMatchObject({
      hookKind: 'webhook',
      channelName: 'acme/build',
      triggeredByName: 'acme/build'
    })
    const githubDetail = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/acp-github-headless` })
    expect(githubDetail.statusCode).toBe(200)
    expect(githubDetail.json()).toMatchObject({
      hookKind: 'github',
      channelName: 'owner/repo',
      triggeredByName: 'owner/repo'
    })

    const filtered = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat&integration=github` })
    expect(filtered.statusCode).toBe(200)
    expect(
      (filtered.json() as { sessions: Array<{ sessionId: string }>; total: number }).sessions.map(
        (session) => session.sessionId
      )
    ).toEqual(['acp-github-headless'])
    expect((filtered.json() as { total: number }).total).toBe(1)

    const genericWebhook = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?view=flat&integration=hook`
    })
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

  it('gives gitlab hook sessions their own integration facet and filter', async () => {
    // GitLab rows carry platform 'hook' like every other hook session, so without the
    // per-host promotion they were counted as generic webhooks — and the webhook filter
    // returned them, mixing two unrelated sources under one entry.
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
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
    const gitlabId = randomUUID()
    await prisma.hookDef.create({
      data: {
        id: gitlabId,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        kind: 'gitlab',
        name: 'acme/platform',
        sessionMode: 'perThread',
        repoId: 4210n,
        repoFullName: 'acme/platform',
        events: ['merge_request:*'],
        targetPlatform: 'slack'
      }
    })
    running = buildHttpApp(prisma)

    await reportSession({
      sessionId: 'acp-webhook-gl',
      agentId: AGENT,
      phase: 'start',
      platform: 'hook',
      channel: webhookId,
      thread: 'delivery-1',
      title: 'Reply with a one-line hello',
      triggeredBy: `hook:${webhookId}`,
      ts: '2026-08-22T00:00:00.000Z'
    })
    await reportSession({
      sessionId: 'acp-gitlab-1',
      agentId: AGENT,
      phase: 'start',
      platform: 'hook',
      channel: gitlabId,
      title: 'Answer the merge request',
      triggeredBy: `hook:${gitlabId}`,
      channelName: 'acme/platform',
      triggeredByName: 'acme/platform',
      ts: '2026-08-22T00:00:00.000Z'
    })

    const facets = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/facets` })
    expect(facets.statusCode).toBe(200)
    const facetBody = facets.json() as {
      integrations: string[]
      triggers: Array<{ value: string; integration: string; hookKind: string | null }>
    }
    expect([...facetBody.integrations].sort()).toEqual(['gitlab', 'hook'])
    expect(facetBody.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: `hook:${gitlabId}`, integration: 'gitlab', hookKind: 'gitlab' }),
        expect.objectContaining({ value: `hook:${webhookId}`, integration: 'hook', hookKind: 'webhook' })
      ])
    )

    const gitlabOnly = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?view=flat&integration=gitlab`
    })
    expect(gitlabOnly.statusCode).toBe(200)
    expect((gitlabOnly.json() as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)).toEqual([
      'acp-gitlab-1'
    ])
    expect((gitlabOnly.json() as { total: number }).total).toBe(1)

    const genericOnly = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat&integration=hook` })
    expect(genericOnly.statusCode).toBe(200)
    expect((genericOnly.json() as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)).toEqual(
      ['acp-webhook-gl']
    )
  })

  it('keeps a code-host session on its own source after the hook is deleted and recreated', async () => {
    // Found in live testing: a hook can be deleted and recreated, which leaves its past
    // sessions pointing at an id that resolves to nothing. Reading the kind live then
    // rewrote their history as generic webhooks. The kind is snapshotted at creation, so
    // the source of a session that already ran cannot change afterwards.
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const gitlabId = randomUUID()
    await prisma.hookDef.create({
      data: {
        id: gitlabId,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        kind: 'gitlab',
        name: 'acme/platform',
        sessionMode: 'perThread',
        repoId: 4210n,
        repoFullName: 'acme/platform',
        events: ['merge_request:*'],
        targetPlatform: 'slack'
      }
    })
    running = buildHttpApp(prisma)

    // No triggeredByName: the unnamed case is exactly where the label used to read "Webhook".
    await reportSession({
      sessionId: 'acp-gitlab-orphan',
      agentId: AGENT,
      phase: 'start',
      platform: 'hook',
      channel: gitlabId,
      title: 'Answer the merge request',
      triggeredBy: `hook:${gitlabId}`,
      ts: '2026-08-22T00:00:00.000Z'
    })
    // A legacy row: written before the snapshot column existed, so it has no kind of its own.
    await reportSession({
      sessionId: 'acp-gitlab-legacy',
      agentId: AGENT,
      phase: 'start',
      platform: 'hook',
      channel: gitlabId,
      title: 'An older merge request',
      triggeredBy: `hook:${gitlabId}`,
      ts: '2026-08-22T00:01:00.000Z'
    })
    await prisma.sessionMeta.update({ where: { id: 'acp-gitlab-legacy' }, data: { hookKind: null } })

    expect((await prisma.sessionMeta.findUnique({ where: { id: 'acp-gitlab-orphan' } }))?.hookKind).toBe('gitlab')

    await prisma.hookDef.delete({ where: { id: gitlabId } })

    const rows = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })
    expect(rows.statusCode).toBe(200)
    const byId = new Map(
      (
        rows.json() as { sessions: Array<{ sessionId: string; hookKind: string | null; triggeredByName: string }> }
      ).sessions.map((session) => [session.sessionId, session])
    )
    // The snapshot survives the definition; the pre-snapshot row degrades as it always did.
    expect(byId.get('acp-gitlab-orphan')?.hookKind).toBe('gitlab')
    expect(byId.get('acp-gitlab-orphan')?.triggeredByName).toBe('GitLab')
    expect(byId.get('acp-gitlab-legacy')?.hookKind).toBeNull()
    expect(byId.get('acp-gitlab-legacy')?.triggeredByName).toBe('Webhook')

    // The facet list still promotes it out of the generic bucket with no hook to read.
    const facets = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/facets` })
    expect(facets.statusCode).toBe(200)
    expect((facets.json() as { integrations: string[] }).integrations).toEqual(expect.arrayContaining(['gitlab']))

    const gitlabOnly = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions?view=flat&integration=gitlab`
    })
    expect(gitlabOnly.statusCode).toBe(200)
    expect((gitlabOnly.json() as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)).toEqual([
      'acp-gitlab-orphan'
    ])

    // And it is no longer double-counted: the generic filter returns only the legacy row.
    const genericOnly = await running.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat&integration=hook` })
    expect(genericOnly.statusCode).toBe(200)
    expect((genericOnly.json() as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)).toEqual(
      ['acp-gitlab-legacy']
    )
  })

  it('serves the multi-agent webchat roster on the detail route; single-agent stays null', async () => {
    // An adopted/refreshed webchat session has no relay socket to deliver the
    // verified roster — the composer/header read it from this DTO field instead.
    const AGENT2 = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CONVO = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'
    const SOLO = 'c1c1c1c1-cccc-4ccc-8ccc-cccccccccccc'
    const SESSION2 = '5691f21b-3911-4d7f-a45d-28ce75d79338'
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, name: 'answer-bot' })
    await seedAgent(prisma, AGENT2, { daemonId: DAEMON, name: 'peer-bot' })
    const conversations = new PgWebchatConversationRepo(prisma)
    await conversations.create(
      { conversationId: CONVO, orgId: OrgId(DEFAULT_ORG_ID), agentId: AgentId(AGENT), userId: DEFAULT_OWNER_ID },
      [AgentId(AGENT2)]
    )
    await conversations.create({
      conversationId: SOLO,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(AGENT),
      userId: DEFAULT_OWNER_ID
    })
    running = buildHttpApp(prisma)

    await reportSession({
      sessionId: SESSION,
      agentId: AGENT,
      phase: 'start',
      platform: 'webchat',
      channel: CONVO,
      ts: '2026-07-05T00:00:00.000Z'
    })
    await reportSession({
      sessionId: SESSION2,
      agentId: AGENT,
      phase: 'start',
      platform: 'webchat',
      channel: SOLO,
      ts: '2026-07-05T00:00:00.000Z'
    })

    const multi = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${SESSION}` })
    expect(multi.statusCode).toBe(200)
    expect((multi.json() as { participants: unknown }).participants).toEqual([
      { agentId: AGENT, name: 'answer-bot', primary: true },
      { agentId: AGENT2, name: 'peer-bot', primary: false }
    ])

    const solo = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${SESSION2}` })
    expect(solo.statusCode).toBe(200)
    expect((solo.json() as { participants: unknown }).participants).toBeNull()
  })

  it('404s for an unknown session', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${randomUUID()}` })
    expect(res.statusCode).toBe(404)
  })
})
