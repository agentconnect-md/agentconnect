// The signing-secret re-stamp in isolation: which rows it rewrites, which it leaves alone, and the write-then-broadcast order.
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { BotId, OrgId } from '../../domain/ids.js'
import type { SlackPlatformAppConfig } from '../../config/slack-platform.js'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { SlackSigningSecretReconciler, type SlackSigningSecretReconcilerDeps } from './signing-secret-reconciler.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const BOT = BotId('22222222-2222-4222-8222-222222222222')
const OTHER_BOT = BotId('33333333-3333-4333-8333-333333333333')

const APP: SlackPlatformAppConfig = {
  appId: 'A0SHARED',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  signingSecret: 'signing-secret-v2'
}

function bot(id: BotId = BOT, overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id,
    orgId: ORG,
    platform: 'slack',
    name: 'acme-workspace',
    prebuilt: true,
    slackAppId: APP.appId,
    teamId: 'T0ACME',
    workspaceId: 'T0ACME',
    workspaceName: 'Acme',
    botUserId: 'U0BOT',
    revokedAt: null,
    revokedReason: null,
    revokedEvidence: null,
    revokedCode: null,
    credentialRejectedAt: null,
    credentialRejectedCode: null,
    credentialRevision: 1,
    credentialInstalledAt: null,
    grantedScopes: null,
    externalAppId: APP.appId,
    externalTenantId: 'T0ACME',
    platformConfig: null,
    discordAppId: null,
    feishuAppId: null,
    feishuRegion: null,
    shareable: true,
    transport: 'http',
    createdBy: null,
    lastUsedAt: null,
    lastAgentName: null,
    agentIds: [],
    inUseByAgentId: null,
    createdAt: new Date(0),
    ...overrides
  }
}

function stamped(signingSecret: string | null): BotSecretMaterial {
  return { botToken: 'xoxb-workspace-token', appToken: null, signingSecret }
}

type AppRef = { current: SlackPlatformAppConfig | undefined }

function harness(rows: BotRecord[], secrets: Map<string, BotSecretMaterial>, appRef: AppRef = { current: APP }) {
  const order: string[] = []
  const install = vi.fn(async (_org: OrgId, botId: BotId, material: BotSecretMaterial) => {
    order.push(`install:${botId}`)
    secrets.set(String(botId), material)
    return 2
  })
  const resync = vi.fn(async (botId: BotId) => {
    order.push(`resync:${botId}`)
  })
  const reconciler = new SlackSigningSecretReconciler({
    bots: { listForPlatform: async () => rows },
    secrets: { get: async (_org, botId) => secrets.get(String(botId)) ?? null },
    credentials: { install } as unknown as SlackSigningSecretReconcilerDeps['credentials'],
    resync,
    clock: new FakeClock(),
    intervalMs: 60_000,
    // A getter: the per-tick read is the point, and a spread would freeze the first value.
    get app() {
      return appRef.current
    }
  })
  return { reconciler, install, resync, order }
}

describe('SlackSigningSecretReconciler', () => {
  it('rewrites a stale signing secret, keeps the bot token, then re-broadcasts', async () => {
    const secrets = new Map([[String(BOT), stamped('signing-secret-v1')]])
    const { reconciler, install, order } = harness([bot()], secrets)

    await reconciler.tick()

    expect(install).toHaveBeenCalledWith(
      ORG,
      BOT,
      { botToken: 'xoxb-workspace-token', appToken: null, signingSecret: APP.signingSecret },
      expect.any(Date)
    )
    // A broadcast before the durable write would publish a secret nothing stored.
    expect(order).toEqual([`install:${BOT}`, `resync:${BOT}`])
  })

  it('leaves a row that already matches untouched', async () => {
    const secrets = new Map([[String(BOT), stamped(APP.signingSecret)]])
    const { reconciler, install, resync } = harness([bot()], secrets)

    await reconciler.tick()

    expect(install).not.toHaveBeenCalled()
    expect(resync).not.toHaveBeenCalled()
  })

  it("leaves a workspace's own app, a revoked bot and a socket-mode bot alone", async () => {
    const ownApp = bot(BOT, { slackAppId: 'A0OWN', externalAppId: 'A0OWN', prebuilt: false })
    const revoked = bot(OTHER_BOT, { revokedAt: new Date(1) })
    const socket = bot(BotId('44444444-4444-4444-8444-444444444444'), { transport: 'socket' })
    const secrets = new Map([
      [String(ownApp.id), stamped('own-signing-secret')],
      [String(revoked.id), stamped('signing-secret-v1')],
      [String(socket.id), stamped(null)]
    ])
    const { reconciler, install, resync } = harness([ownApp, revoked, socket], secrets)

    await reconciler.tick()

    expect(install).not.toHaveBeenCalled()
    expect(resync).not.toHaveBeenCalled()
  })

  it('retries a failed broadcast on the next pass without rewriting the credential', async () => {
    const secrets = new Map([[String(BOT), stamped('signing-secret-v1')]])
    const { reconciler, install, resync } = harness([bot()], secrets)
    resync.mockImplementationOnce(async () => {
      throw new Error('broadcast failed')
    })

    await reconciler.tick()
    await reconciler.tick()

    expect(install).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it('one unreadable row does not strand the rest', async () => {
    const secrets = new Map([[String(OTHER_BOT), stamped('signing-secret-v1')]])
    const { reconciler, install } = harness([bot(), bot(OTHER_BOT)], secrets)
    install.mockImplementationOnce(async () => {
      throw new Error('write failed')
    })
    secrets.set(String(BOT), stamped('signing-secret-v1'))

    await reconciler.tick()

    expect(install).toHaveBeenCalledTimes(2)
    expect(secrets.get(String(OTHER_BOT))?.signingSecret).toBe(APP.signingSecret)
  })

  it('does nothing while the deployment app is not configured', async () => {
    const secrets = new Map([[String(BOT), stamped('signing-secret-v1')]])
    const { reconciler, install } = harness([bot()], secrets, { current: undefined })

    await reconciler.tick()

    expect(install).not.toHaveBeenCalled()
  })
})
