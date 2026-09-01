/**
 * Rotating the deployment Linear app (docs/designs/linear-integration.md §10.6) over the real
 * schema and the real `rc/bot-assign` broadcast.
 *
 * The relay never reads the deployment config: it verifies `Linear-Signature` with the copy the
 * connect tail stamped into the workspace bot's `BotSecret` row and shipped in the assign's secrets
 * bag. So a rotation is only complete once every stamped row has been rewritten, its
 * `credentialRevision` advanced, and a fresh assignment fanned out — which is what the provider's
 * re-stamp loop does here, against Postgres and a recording relay channel.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../src/domain/ids.js'
import type { LinearPlatformAppConfig } from '../../src/config/linear-platform.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'

const ORG = OrgId(DEFAULT_ORG_ID)
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const WORKSPACE = 'linear-org-acme'

const APP: LinearPlatformAppConfig = {
  clientId: 'lin_deployment_app',
  clientSecret: 'linear-client-secret-v1',
  signingSecret: 'linear-signing-secret-v1'
}
/** Same app, both secrets rolled — what the operator does in the setup card. */
const ROTATED: LinearPlatformAppConfig = {
  clientId: APP.clientId,
  clientSecret: 'linear-client-secret-v2',
  signingSecret: 'linear-signing-secret-v2'
}

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

interface AssignFrame {
  botId: string
  credentialRevision?: number
  secrets?: { signingSecret?: string }
}

/** The frames a connected relay would receive, in order. */
function recordAssigns(app: HttpApp): AssignFrame[] {
  const assigns: AssignFrame[] = []
  const channel: RelayChannel = {
    relayId: 'r1',
    send(type, payload) {
      if (type === 'rc/bot-assign') assigns.push(payload as AssignFrame)
    },
    close() {}
  }
  app.relayReg.add(channel)
  return assigns
}

/**
 * What §7.1's connect tail leaves behind: an http workspace bot carrying the deployment app's D6
 * identity, its two stamped secret slots, and one member agent. The funnel that writes this lands
 * with the OAuth callback; the rows are what this loop reads either way.
 */
async function connectWorkspace(app: HttpApp, credentials: LinearPlatformAppConfig): Promise<BotId> {
  const agentId = AgentId(randomUUID())
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  const botId = BotId(randomUUID())
  await app.deps.repos.bot.create({
    id: botId,
    orgId: ORG,
    platform: 'linear',
    name: 'Acme',
    workspaceId: WORKSPACE,
    workspaceName: 'Acme',
    botUserId: 'lin-app-user',
    shareable: true,
    transport: 'http'
  })
  await app.deps.repos.botSecret.put(ORG, botId, {
    botToken: credentials.clientSecret,
    appToken: null,
    signingSecret: credentials.signingSecret
  })
  await app.deps.repos.integration.create({
    id: IntegrationId(randomUUID()),
    orgId: ORG,
    agentId,
    botId,
    platform: 'linear',
    name: 'Acme'
  })
  return botId
}

function build(): HttpApp {
  const app = buildHttpApp(prisma, { PUBLIC_RELAY_URL: 'https://relay.example.test' })
  running = app
  app.platformStubs.linearPlatformApp = APP
  return app
}

describe('linear deployment-credential re-stamp (§10.6)', () => {
  it('rewrites every workspace bot, advances the generation, and re-broadcasts the new secret', async () => {
    const app = build()
    const assigns = recordAssigns(app)
    const botId = await connectWorkspace(app, APP)

    // The connect tail's own broadcast — the baseline the rotation has to move.
    await app.deps.httpBot.syncBot(botId)
    expect(assigns.at(-1)?.secrets?.signingSecret).toBe(APP.signingSecret)
    const before = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })

    app.platformStubs.linearPlatformApp = ROTATED
    await app.linearCredentialReconciler.tick()

    const secret = await prisma.botSecret.findUniqueOrThrow({ where: { botId } })
    expect(secret.signingSecret).toBe(ROTATED.signingSecret)
    expect(secret.botToken).toBe(ROTATED.clientSecret)

    const after = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })
    expect(after.credentialRevision).toBeGreaterThan(before.credentialRevision)

    // The relay rebuilds its ingest from this frame; a stale bag here is a 401 on every delivery.
    expect(assigns.at(-1)).toMatchObject({
      botId,
      credentialRevision: after.credentialRevision,
      secrets: { signingSecret: ROTATED.signingSecret }
    })
  })

  it('is idempotent: a second pass writes nothing and broadcasts nothing', async () => {
    const app = build()
    const assigns = recordAssigns(app)
    const botId = await connectWorkspace(app, APP)

    app.platformStubs.linearPlatformApp = ROTATED
    await app.linearCredentialReconciler.tick()
    const converged = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })
    const framesAfterFirstPass = assigns.length

    await app.linearCredentialReconciler.tick()

    expect(assigns).toHaveLength(framesAfterFirstPass)
    const settled = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })
    expect(settled.credentialRevision).toBe(converged.credentialRevision)
    expect(settled.credentialInstalledAt).toEqual(converged.credentialInstalledAt)
  })

  it('leaves a bot already stamped with the current app untouched', async () => {
    const app = build()
    const assigns = recordAssigns(app)
    const botId = await connectWorkspace(app, APP)
    const before = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })

    await app.linearCredentialReconciler.tick()

    const after = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })
    expect(after.credentialRevision).toBe(before.credentialRevision)
    expect(assigns).toEqual([])
  })

  it('re-stamps a workspace whose members are all gone, so re-adding one cannot resurrect the old secret', async () => {
    const app = build()
    recordAssigns(app)
    const botId = await connectWorkspace(app, APP)
    await prisma.integration.deleteMany({ where: { botId } })

    app.platformStubs.linearPlatformApp = ROTATED
    await app.linearCredentialReconciler.tick()

    const secret = await prisma.botSecret.findUniqueOrThrow({ where: { botId } })
    expect(secret.signingSecret).toBe(ROTATED.signingSecret)
  })

  it('writes nothing while the deployment app is unconfigured', async () => {
    const app = build()
    const botId = await connectWorkspace(app, APP)
    app.platformStubs.linearPlatformApp = undefined

    await app.linearCredentialReconciler.tick()

    const secret = await prisma.botSecret.findUniqueOrThrow({ where: { botId } })
    expect(secret.signingSecret).toBe(APP.signingSecret)
  })
})
