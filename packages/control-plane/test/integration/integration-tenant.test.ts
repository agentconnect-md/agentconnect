// `integration/tenant` end to end on the CP: a serving daemon's DingTalk socket names its organization, which names the integration.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgBotRepo, PgIntegrationRepo } from '../../src/persistence/index.js'
import { handleIntegrationTenant } from '../../src/ws/handlers/index.js'
import { createSocketBotTenant } from '../../src/orchestrator/socketBotTenant.js'
import { DINGTALK_TOKEN_URLS } from '../../src/platforms/dingtalk/provider.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const CLIENT_ID = 'dingexampleclient'
const SECRET = 'example-client-secret'
const CORP = 'dingexamplecorp'
const ORG_NAME = 'Example Org'
const AUTH_INFOS = 'https://api.dingtalk.com/v1.0/contact/organizations/authInfos'

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

/** DingTalk's token endpoint and organization read; `orgName` null answers as an app without Contact.Org.Read does. */
function fakeDingTalk(state: { orgName: string | null; reads: string[] }): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    if (Object.values(DINGTALK_TOKEN_URLS).includes(url)) {
      const body = JSON.parse(String(init.body)) as { appKey: string; appSecret: string }
      return body.appKey === CLIENT_ID && body.appSecret === SECRET
        ? Response.json({ accessToken: 'example-access-token', expireIn: 7200 })
        : Response.json({ code: 'invalidClientIdOrSecret' }, { status: 400 })
    }
    if (url.startsWith(AUTH_INFOS)) {
      state.reads.push(new URL(url).searchParams.get('targetCorpId') ?? '')
      return state.orgName
        ? Response.json({ orgName: state.orgName, orgFullName: state.orgName })
        : Response.json({ code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied' }, { status: 403 })
    }
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
}

async function install(orgName: string | null = ORG_NAME) {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['dingtalk'], runtimes: ['claude'], acp: true, features: [] }
  })
  await seedDaemon(prisma, OTHER_DAEMON)
  const state = { orgName, reads: [] as string[] }
  const control = { integrationUpsert: async () => {}, integrationRemove: async () => {} }
  const app = buildHttpApp(prisma, {}, undefined, control as unknown as ControlSender, {
    dingTalkFetch: fakeDingTalk(state)
  })
  running = app
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: { platform: 'dingtalk', agentId, dingtalk: { clientId: CLIENT_ID, clientSecret: SECRET } }
  })
  expect(res.statusCode).toBe(201)
  const { id: integrationId, botId } = res.json() as { id: string; botId: string }
  return { app, state, integrationId, botId }
}

/** Dispatch one `integration/tenant` EVT through the real handler, as `daemonId`. */
async function report(
  app: HttpApp,
  integrationId: string,
  opts: { daemonId?: string; botUserId?: string; tenantId?: string } = {}
): Promise<unknown[]> {
  const refusals: unknown[] = []
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'integration/tenant',
    payload: {
      integrationIds: [integrationId],
      botUserId: opts.botUserId ?? CLIENT_ID,
      tenantId: opts.tenantId ?? CORP
    }
  } as AnyFrame
  const conn = { daemonId: opts.daemonId ?? DAEMON, orgId: DEFAULT_ORG_ID } as unknown as DaemonConnection
  const log = { error: () => {}, warn: (o: unknown) => void refusals.push(o) }
  const deps = {
    log,
    integration: new PgIntegrationRepo(prisma),
    agent: new PgAgentRepo(prisma),
    bot: new PgBotRepo(prisma),
    socketBotTenant: createSocketBotTenant({
      bots: app.deps.repos.bot,
      secrets: app.deps.repos.botSecret,
      integrations: app.deps.repos.integration,
      platforms: app.deps.platforms,
      log
    })
  } as unknown as DaemonWsDeps
  await handleIntegrationTenant(frame, conn, deps)
  return refusals
}

const names = async (integrationId: string, botId: string) => ({
  integration: (await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } })).name,
  bot: await prisma.bot.findUniqueOrThrow({
    where: { id: botId },
    select: { workspaceId: true, workspaceName: true }
  })
})

describe('integration/tenant → DingTalk organization name', () => {
  it('records the organization and names the integration after it', async () => {
    const { app, state, integrationId, botId } = await install()

    expect(await report(app, integrationId)).toEqual([])

    expect(state.reads).toEqual([CORP])
    expect(await names(integrationId, botId)).toEqual({
      integration: `DingTalk · ${ORG_NAME}`,
      bot: { workspaceId: CORP, workspaceName: ORG_NAME }
    })
    // A named organization is settled: a later report reads nothing.
    await report(app, integrationId)
    expect(state.reads).toEqual([CORP])
  })

  it('keeps the organization id without a name and retries the read on the next report', async () => {
    const { app, state, integrationId, botId } = await install(null)

    // A report the CP accepts but cannot name logs DingTalk's code, so a missing permission is visible.
    expect(await report(app, integrationId)).toEqual([
      expect.objectContaining({ reason: 'Forbidden.AccessDenied.AccessTokenPermissionDenied' })
    ])
    expect(await names(integrationId, botId)).toEqual({
      integration: `DingTalk · ${CLIENT_ID}`,
      bot: { workspaceId: CORP, workspaceName: null }
    })

    state.orgName = ORG_NAME
    await report(app, integrationId)
    expect(state.reads).toEqual([CORP, CORP])
    expect((await names(integrationId, botId)).integration).toBe(`DingTalk · ${ORG_NAME}`)
  })

  it('leaves a name someone changed', async () => {
    const { app, integrationId, botId } = await install()
    await prisma.integration.update({ where: { id: integrationId }, data: { name: 'support-bot' } })

    await report(app, integrationId)
    expect(await names(integrationId, botId)).toEqual({
      integration: 'support-bot',
      bot: { workspaceId: CORP, workspaceName: ORG_NAME }
    })
  })

  it('refuses a daemon that does not serve the integration, another app, and another organization', async () => {
    const { app, state, integrationId, botId } = await install()

    await report(app, integrationId, { daemonId: OTHER_DAEMON })
    expect(await report(app, integrationId, { botUserId: 'dingotherclient' })).toHaveLength(1)
    expect(state.reads).toEqual([])
    expect((await names(integrationId, botId)).bot).toEqual({ workspaceId: null, workspaceName: null })

    await report(app, integrationId)
    expect(await report(app, integrationId, { tenantId: 'dingothercorp' })).toHaveLength(2)
    expect((await names(integrationId, botId)).bot).toEqual({ workspaceId: CORP, workspaceName: ORG_NAME })
  })
})
