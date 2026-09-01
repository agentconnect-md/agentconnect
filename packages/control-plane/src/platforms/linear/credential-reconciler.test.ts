/**
 * The §10.6 re-stamp in isolation: which rows it rewrites, which it leaves alone, and that a
 * rewrite always lands durably BEFORE the assignment that publishes it.
 */
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { BotId, OrgId } from '../../domain/ids.js'
import type { LinearPlatformAppConfig } from '../../config/linear-platform.js'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { LinearCredentialReconciler, type LinearCredentialReconcilerDeps } from './credential-reconciler.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const BOT = BotId('22222222-2222-4222-8222-222222222222')
const OTHER_BOT = BotId('33333333-3333-4333-8333-333333333333')

const APP = { clientId: 'lin_app', clientSecret: 'client-secret-v1', signingSecret: 'signing-secret-v1' }
const ROTATED = { clientId: 'lin_app', clientSecret: 'client-secret-v2', signingSecret: 'signing-secret-v2' }

function bot(id: BotId = BOT): BotRecord {
  return {
    id,
    orgId: ORG,
    platform: 'linear',
    name: 'acme-workspace',
    prebuilt: false,
    slackAppId: null,
    teamId: null,
    workspaceId: 'linear-org-1',
    workspaceName: 'Acme',
    botUserId: 'lin-app-user',
    revokedAt: null,
    credentialRevision: 1,
    credentialInstalledAt: null,
    grantedScopes: null,
    externalAppId: APP.clientId,
    externalTenantId: 'linear-org-1',
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
    createdAt: new Date(0)
  }
}

function stamped(app: { clientSecret: string; signingSecret: string }): BotSecretMaterial {
  return { botToken: app.clientSecret, appToken: null, signingSecret: app.signingSecret }
}

interface Harness {
  reconciler: LinearCredentialReconciler
  install: ReturnType<typeof vi.fn>
  resync: ReturnType<typeof vi.fn>
  order: string[]
}

/** The live deployment app, mutable so a test can rotate it between passes. */
type AppRef = { current: LinearPlatformAppConfig | undefined }

function harness(
  rows: BotRecord[],
  secrets: Map<string, BotSecretMaterial>,
  overrides: Partial<Omit<LinearCredentialReconcilerDeps, 'app'>> = {},
  appRef: AppRef = { current: APP }
): Harness {
  const order: string[] = []
  const install = vi.fn(async (_org: OrgId, botId: BotId, material: BotSecretMaterial) => {
    order.push(`install:${botId}`)
    secrets.set(String(botId), material)
    return 2
  })
  const resync = vi.fn(async (botId: BotId) => {
    order.push(`resync:${botId}`)
  })
  const reconciler = new LinearCredentialReconciler({
    bots: { listForPlatform: async () => rows },
    secrets: { get: async (_org, botId) => secrets.get(String(botId)) ?? null },
    credentials: { install } as unknown as LinearCredentialReconcilerDeps['credentials'],
    resync,
    clock: new FakeClock(),
    intervalMs: 60_000,
    ...overrides,
    // A getter, not a spread value: the reconciler's per-tick read is the whole
    // point, and a spread would flatten it to whatever the first read returned.
    get app() {
      return appRef.current
    }
  })
  return { reconciler, install, resync, order }
}

describe('LinearCredentialReconciler (§10.6)', () => {
  it('re-stamps both deployment slots, then re-broadcasts — in that order', async () => {
    const secrets = new Map([[String(BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })]])
    const { reconciler, install, resync, order } = harness([bot()], secrets)

    await reconciler.tick()

    expect(install).toHaveBeenCalledWith(
      ORG,
      BOT,
      { botToken: APP.clientSecret, appToken: null, signingSecret: APP.signingSecret },
      expect.any(Date)
    )
    expect(resync).toHaveBeenCalledWith(BOT)
    // A broadcast before the durable write would publish a secret nothing stored.
    expect(order).toEqual([`install:${BOT}`, `resync:${BOT}`])
  })

  it('leaves a matching row untouched, so a second pass is a no-op', async () => {
    const secrets = new Map([[String(BOT), stamped(APP)]])
    const { reconciler, install, resync } = harness([bot()], secrets)

    await reconciler.tick()
    await reconciler.tick()

    expect(install).not.toHaveBeenCalled()
    expect(resync).not.toHaveBeenCalled()
  })

  it('re-stamps a row whose client secret alone drifted', async () => {
    const secrets = new Map([
      [String(BOT), { botToken: 'old-client', appToken: null, signingSecret: APP.signingSecret }]
    ])
    const { reconciler, install } = harness([bot()], secrets)

    await reconciler.tick()

    expect(install).toHaveBeenCalledTimes(1)
  })

  it('reads the app per tick, so the pass that follows a rotation is the one that converges', async () => {
    const secrets = new Map([[String(BOT), stamped(APP)]])
    const app: AppRef = { current: APP }
    const { reconciler, install } = harness([bot()], secrets, {}, app)

    await reconciler.tick()
    expect(install).not.toHaveBeenCalled()

    app.current = ROTATED
    await reconciler.tick()
    expect(install).toHaveBeenCalledWith(
      ORG,
      BOT,
      { botToken: ROTATED.clientSecret, appToken: null, signingSecret: ROTATED.signingSecret },
      expect.any(Date)
    )

    // Converged: the third pass finds the row it just wrote.
    install.mockClear()
    await reconciler.tick()
    expect(install).not.toHaveBeenCalled()
  })

  it('writes nothing while the deployment app is absent', async () => {
    const secrets = new Map([[String(BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })]])
    const { reconciler, install } = harness([bot()], secrets, {}, { current: undefined })

    await reconciler.tick()

    expect(install).not.toHaveBeenCalled()
    expect(secrets.get(String(BOT))?.signingSecret).toBe('old-signing')
  })

  it('skips a bot with no secret row rather than stamping one the connect tail has not written', async () => {
    const { reconciler, install } = harness([bot()], new Map())

    await reconciler.tick()

    expect(install).not.toHaveBeenCalled()
  })

  it('carries on past a bot whose re-stamp throws', async () => {
    const secrets = new Map([
      [String(BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })],
      [String(OTHER_BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })]
    ])
    const { reconciler, install, resync } = harness([bot(), bot(OTHER_BOT)], secrets)
    install.mockImplementationOnce(async () => {
      throw new Error('conflict')
    })

    await reconciler.tick()

    expect(install).toHaveBeenCalledTimes(2)
    expect(resync).toHaveBeenCalledExactlyOnceWith(OTHER_BOT)
  })

  it('never arms a timer until it is started, and clears it on stop', async () => {
    const clock = new FakeClock()
    const secrets = new Map([[String(BOT), stamped(APP)]])
    const { reconciler } = harness([bot()], secrets, { clock })

    // A bare tick must not leave a live timer behind for a suite that never started it.
    await reconciler.tick()
    expect(clock.pendingTimers()).toBe(0)

    reconciler.start()
    await vi.waitFor(() => expect(clock.pendingTimers()).toBe(1))
    reconciler.stop()
    expect(clock.pendingTimers()).toBe(0)
  })
})
