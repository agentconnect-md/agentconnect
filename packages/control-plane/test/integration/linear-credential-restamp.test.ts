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
import { systemClock } from '../../src/domain/clock.js'
import { LinearCredentialReconciler } from '../../src/platforms/linear/credential-reconciler.js'
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
/** A DIFFERENT app: the setup card also permits changing the client id (§7.1). */
const PREVIOUS_APP: LinearPlatformAppConfig = {
  clientId: 'lin_previous_app',
  clientSecret: 'previous-client-secret',
  signingSecret: 'previous-signing-secret'
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
 *
 * `credentials` is the app that was configured AT CONNECT TIME, so the projected `externalAppId`
 * and the stamped secrets agree — which is what makes a workspace connected under a previous app
 * representable here at all.
 */
async function connectWorkspace(
  app: HttpApp,
  credentials: LinearPlatformAppConfig,
  workspaceId = WORKSPACE
): Promise<BotId> {
  const agentId = AgentId(randomUUID())
  // One daemon serves every workspace a test connects; `seedDaemon` would throw on the second call.
  const seeded = await prisma.daemon.findUnique({ where: { id: DAEMON } })
  if (!seeded) await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  const botId = BotId(randomUUID())
  // The D6 projection reads the CURRENTLY configured app, so connect under the one being simulated.
  const configured = app.platformStubs.linearPlatformApp
  app.platformStubs.linearPlatformApp = credentials
  try {
    await app.deps.repos.bot.create({
      id: botId,
      orgId: ORG,
      platform: 'linear',
      name: 'Acme',
      workspaceId,
      workspaceName: 'Acme',
      botUserId: 'lin-app-user',
      shareable: true,
      transport: 'http'
    })
  } finally {
    app.platformStubs.linearPlatformApp = configured
  }
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

  it('leaves a workspace installed under a previous client id for the operator to reconnect', async () => {
    const app = build()
    const assigns = recordAssigns(app)
    const botId = await connectWorkspace(app, PREVIOUS_APP)
    const before = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })
    expect(before.externalAppId).toBe(PREVIOUS_APP.clientId)

    // A rotation of the CURRENT app says nothing about a workspace that authorized a different one.
    app.platformStubs.linearPlatformApp = ROTATED
    await app.linearCredentialReconciler.tick()

    const secret = await prisma.botSecret.findUniqueOrThrow({ where: { botId } })
    expect(secret.signingSecret).toBe(PREVIOUS_APP.signingSecret)
    expect(secret.botToken).toBe(PREVIOUS_APP.clientSecret)
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })
    expect(after.credentialRevision).toBe(before.credentialRevision)
    expect(assigns).toEqual([])
  })

  it('never re-stamps a revoked workspace, so a rotation cannot resurrect a dead grant', async () => {
    const app = build()
    const assigns = recordAssigns(app)
    const botId = await connectWorkspace(app, APP)
    const revokedAt = new Date('2026-09-01T00:00:00.000Z')
    await prisma.bot.update({ where: { id: botId }, data: { revokedAt } })
    const before = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })

    app.platformStubs.linearPlatformApp = ROTATED
    await app.linearCredentialReconciler.tick()

    // `install` would have cleared `revokedAt` on its way through `bumpCredential`.
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })
    expect(after.revokedAt).toEqual(revokedAt)
    expect(after.credentialRevision).toBe(before.credentialRevision)
    const secret = await prisma.botSecret.findUniqueOrThrow({ where: { botId } })
    expect(secret.signingSecret).toBe(APP.signingSecret)
    expect(assigns).toEqual([])
  })

  it('re-stamps the live workspace in a fleet that also holds a previous-app and a revoked one', async () => {
    const app = build()
    const assigns = recordAssigns(app)
    const live = await connectWorkspace(app, APP, 'linear-org-live')
    const foreign = await connectWorkspace(app, PREVIOUS_APP, 'linear-org-foreign')
    const revoked = await connectWorkspace(app, APP, 'linear-org-revoked')
    await prisma.bot.update({ where: { id: revoked }, data: { revokedAt: new Date('2026-09-01T00:00:00.000Z') } })

    app.platformStubs.linearPlatformApp = ROTATED
    await app.linearCredentialReconciler.tick()

    const secrets = await prisma.botSecret.findMany({ where: { botId: { in: [live, foreign, revoked] } } })
    const byBot = new Map(secrets.map((s) => [s.botId, s]))
    expect(byBot.get(live)?.signingSecret).toBe(ROTATED.signingSecret)
    expect(byBot.get(foreign)?.signingSecret).toBe(PREVIOUS_APP.signingSecret)
    expect(byBot.get(revoked)?.signingSecret).toBe(APP.signingSecret)
    // Exactly one workspace was published, and it is the live one.
    expect(assigns.map((frame) => frame.botId)).toEqual([live])
  })

  it('retries a failed broadcast against the already-correct row, then settles', async () => {
    // The same graph, but with a resync that fails once: after it does, the row is already current,
    // so nothing in the database could tell a later pass that its relays are still on the old key.
    const app = build()
    const botId = await connectWorkspace(app, APP)
    const resynced: string[] = []
    let failNext = true
    const reconciler = new LinearCredentialReconciler({
      bots: app.deps.repos.bot,
      secrets: app.deps.repos.botSecret,
      credentials: app.deps.repos.botCredential,
      resync: async (id) => {
        if (failNext) {
          failNext = false
          throw new Error('no connected relay')
        }
        resynced.push(id)
      },
      app: ROTATED,
      clock: systemClock,
      intervalMs: 60_000
    })

    await reconciler.tick()
    const written = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })
    expect(resynced).toEqual([])

    await reconciler.tick()
    expect(resynced).toEqual([botId])
    // The credential was written once; the second pass owed only the broadcast.
    const settled = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })
    expect(settled.credentialRevision).toBe(written.credentialRevision)
    expect(settled.credentialInstalledAt).toEqual(written.credentialInstalledAt)

    await reconciler.tick()
    expect(resynced).toEqual([botId])
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
