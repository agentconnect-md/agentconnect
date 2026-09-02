/**
 * The §10.6 re-stamp in isolation: which rows it rewrites, which it leaves alone, and that a
 * rewrite always lands durably BEFORE the assignment that publishes it.
 */
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { BotId, OrgId } from '../../domain/ids.js'
import type { LinearPlatformAppConfig } from '../../config/linear-platform.js'
import type { AgentRecord, BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { LinearCredentialReconciler, type LinearCredentialReconcilerDeps } from './credential-reconciler.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const BOT = BotId('22222222-2222-4222-8222-222222222222')
const OTHER_BOT = BotId('33333333-3333-4333-8333-333333333333')

const APP = { clientId: 'lin_app', clientSecret: 'client-secret-v1', signingSecret: 'signing-secret-v1' }
const ROTATED = { clientId: 'lin_app', clientSecret: 'client-secret-v2', signingSecret: 'signing-secret-v2' }

function bot(id: BotId = BOT, overrides: Partial<BotRecord> = {}): BotRecord {
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
    createdAt: new Date(0),
    ...overrides
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

  it('retries a failed broadcast on the next pass WITHOUT rewriting the credential', async () => {
    // The row is already correct by then, so the drift check alone would skip the bot forever
    // while its relays kept verifying with the old key. The retry is remembered, not re-derived.
    const secrets = new Map([[String(BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })]])
    const { reconciler, install, resync } = harness([bot()], secrets)
    resync.mockImplementationOnce(async () => {
      throw new Error('no connected relay')
    })

    await reconciler.tick()
    expect(install).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledTimes(1)

    await reconciler.tick()
    expect(install).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledTimes(2)
    expect(resync).toHaveBeenLastCalledWith(BOT)
  })

  it('clears the debt once the broadcast succeeds, so later passes go quiet', async () => {
    const secrets = new Map([[String(BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })]])
    const { reconciler, install, resync } = harness([bot()], secrets)
    resync.mockImplementationOnce(async () => {
      throw new Error('no connected relay')
    })

    await reconciler.tick()
    await reconciler.tick()
    await reconciler.tick()

    expect(install).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it('publishes once for a bot that both drifted and owed a retry', async () => {
    const app: AppRef = { current: APP }
    const secrets = new Map([[String(BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })]])
    const { reconciler, install, resync } = harness([bot()], secrets, {}, app)
    resync.mockImplementationOnce(async () => {
      throw new Error('no connected relay')
    })

    await reconciler.tick()
    // A second rotation lands before the owed broadcast was ever delivered.
    app.current = ROTATED
    await reconciler.tick()

    expect(install).toHaveBeenCalledTimes(2)
    // One broadcast for the pass, not one per reason.
    expect(resync).toHaveBeenCalledTimes(2)
    expect(secrets.get(String(BOT))?.signingSecret).toBe(ROTATED.signingSecret)
  })

  it('drops a pending retry when the row leaves this loop’s standing', async () => {
    const secrets = new Map([[String(BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })]])
    const rows = [bot()]
    const { reconciler, resync } = harness(rows, secrets)
    resync.mockImplementationOnce(async () => {
      throw new Error('no connected relay')
    })

    await reconciler.tick()
    expect(resync).toHaveBeenCalledTimes(1)

    // Revoked between passes: publishing it is now the revoke path's business, not this loop's.
    rows[0] = bot(BOT, { revokedAt: new Date(1) })
    await reconciler.tick()
    await reconciler.tick()

    expect(resync).toHaveBeenCalledTimes(1)
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

  it('leaves a bot installed under a PREVIOUS client id alone — it is another app, not stale', async () => {
    // Its workspace authorized that app and its `linear_token` row is keyed by it, so today's
    // secrets on that row would serve neither app. Only an operator reconnect re-proves the grant.
    const stale = stamped({ clientSecret: 'previous-client-secret', signingSecret: 'previous-signing-secret' })
    const secrets = new Map([[String(BOT), stale]])
    const { reconciler, install, resync } = harness([bot(BOT, { externalAppId: 'lin_previous_app' })], secrets)

    await reconciler.tick()

    expect(install).not.toHaveBeenCalled()
    expect(resync).not.toHaveBeenCalled()
    expect(secrets.get(String(BOT))).toEqual(stale)
  })

  it('treats an unattributed row as not ours rather than adopting it', async () => {
    const secrets = new Map([[String(BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })]])
    const { reconciler, install } = harness([bot(BOT, { externalAppId: null })], secrets)

    await reconciler.tick()

    expect(install).not.toHaveBeenCalled()
  })

  it('never re-stamps a revoked workspace, because install would clear its revocation', async () => {
    const secrets = new Map([[String(BOT), stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })]])
    const { reconciler, install, resync } = harness([bot(BOT, { revokedAt: new Date(1) })], secrets)

    await reconciler.tick()

    expect(install).not.toHaveBeenCalled()
    expect(resync).not.toHaveBeenCalled()
  })

  it('re-stamps the live same-app bot in a fleet that also holds a foreign-app and a revoked one', async () => {
    const live = BOT
    const foreign = BotId('44444444-4444-4444-8444-444444444444')
    const revoked = OTHER_BOT
    const drifted = () => stamped({ clientSecret: 'old-client', signingSecret: 'old-signing' })
    const secrets = new Map([
      [String(live), drifted()],
      [String(foreign), drifted()],
      [String(revoked), drifted()]
    ])
    const { reconciler, install, resync } = harness(
      [bot(foreign, { externalAppId: 'lin_previous_app' }), bot(revoked, { revokedAt: new Date(1) }), bot(live)],
      secrets
    )

    await reconciler.tick()

    expect(install).toHaveBeenCalledExactlyOnceWith(ORG, live, expect.anything(), expect.any(Date))
    expect(resync).toHaveBeenCalledExactlyOnceWith(live)
    expect(secrets.get(String(live))?.signingSecret).toBe(APP.signingSecret)
    expect(secrets.get(String(foreign))).toEqual(drifted())
    expect(secrets.get(String(revoked))).toEqual(drifted())
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

/**
 * Which member the tick's late-team seed NAMES as the row's owner (§15, §6.2's backstop).
 *
 * The stub harness is the point: at this seam the seed's own write is visible, before the route
 * compile's generic converger gets a say about an ownerless row.
 */
describe('LinearCredentialReconciler — the late-team seed (§15)', () => {
  const ALICE = '44444444-4444-4444-8444-444444444444'
  const BOB = '55555555-5555-4555-8555-555555555555'
  const TEAM = { id: 'team_ops', key: 'OPS', name: 'Operations' }

  interface SeedHarness {
    reconciler: LinearCredentialReconciler
    upsertConversation: ReturnType<typeof vi.fn>
    upsertAgent: ReturnType<typeof vi.fn>
  }

  const agent = (id: string, visibility: 'org' | 'restricted' = 'org') =>
    ({ id, visibility, name: `agent-${id.slice(0, 4)}` }) as unknown as AgentRecord

  /** `installs` is createdAt-ordered, exactly as `listForBot` answers. `routable` is the set of
   *  agents a daemon is currently serving. */
  function seedHarness(
    installs: { id: string; agentId: string }[],
    agents: AgentRecord[],
    routable: Set<string>,
    botOverrides: Partial<BotRecord> = {}
  ) {
    const upsertConversation = vi.fn(async () => ({}) as never)
    const upsertAgent = vi.fn(async () => ({}) as never)
    const teams: LinearCredentialReconcilerDeps['teams'] = {
      integrations: { listForBot: async () => installs as never },
      agents: { getUnscoped: async (agentId: string) => agents.find((a) => a.id === agentId) ?? null } as never,
      channels: { listForBot: async () => [], upsertConversation, upsertAgent } as never,
      tokens: {
        accessToken: async () => ({ ok: true as const, accessToken: 'tok', expiresAt: new Date(), rotated: false }),
        teams: async () => ({ ok: true as const, result: [TEAM] })
      } as never,
      routableDaemon: async (a: AgentRecord) => (routable.has(a.id) ? 'daemon-1' : null)
    }
    const secrets = new Map([[String(BOT), stamped(APP)]])
    const { reconciler } = harness([bot(BOT, botOverrides)], secrets, { teams })
    return { reconciler, upsertConversation, upsertAgent } satisfies SeedHarness
  }

  it('names the earliest ROUTABLE non-gated member, not the earliest install', async () => {
    // The compile drops an unroutable member from its placed set and then mutes any conversation
    // whose persisted owner is missing from it — so seeding the earliest install here would turn
    // the freshly discovered team off and suppress the routable member's own fallback with it.
    const h = seedHarness(
      [
        { id: 'i-alice', agentId: ALICE },
        { id: 'i-bob', agentId: BOB }
      ],
      [agent(ALICE), agent(BOB)],
      new Set([BOB])
    )

    await h.reconciler.tick()

    expect(h.upsertAgent).toHaveBeenCalledWith('i-bob', TEAM.id, BOB, { defaultTrigger: 'mention', kind: 'channel' })
    expect(h.upsertAgent).toHaveBeenCalledTimes(1)
  })

  it('skips a routable GATED member for the seat, since it can never be the fallback', async () => {
    const h = seedHarness(
      [
        { id: 'i-alice', agentId: ALICE },
        { id: 'i-bob', agentId: BOB }
      ],
      [agent(ALICE, 'restricted'), agent(BOB)],
      new Set([ALICE, BOB])
    )

    await h.reconciler.tick()

    expect(h.upsertAgent).toHaveBeenCalledWith('i-bob', TEAM.id, BOB, { defaultTrigger: 'mention', kind: 'channel' })
  })

  it('names NOBODY when no member is both routable and unrestricted', async () => {
    // An ownerless row is a state the compile tolerates — no default, no route — and what happens
    // to it next is the generic converger's business, not a choice this seed had any basis to make.
    const h = seedHarness([{ id: 'i-alice', agentId: ALICE }], [agent(ALICE)], new Set())

    await h.reconciler.tick()

    expect(h.upsertConversation).toHaveBeenCalledWith(
      'i-alice',
      { id: TEAM.id, name: 'Acme / Operations', kind: 'channel' },
      { defaultTrigger: 'mention' }
    )
    expect(h.upsertAgent).not.toHaveBeenCalled()
  })

  it('labels the seeded row with the workspace and the team NAME, never the issue prefix', async () => {
    // The bot row IS the workspace, so its stored name is the label's first half — the same
    // string the daemon's spec carries, which is what keeps the two writers of this row agreeing.
    const h = seedHarness([{ id: 'i-alice', agentId: ALICE }], [agent(ALICE)], new Set([ALICE]))

    await h.reconciler.tick()

    const [, conversation] = h.upsertConversation.mock.calls[0] as unknown as [string, { name: string }]
    expect(conversation.name).toBe('Acme / Operations')
    expect(conversation.name).not.toContain(TEAM.key)
  })

  it('falls back to the team name alone when the bot carries no workspace name', async () => {
    const h = seedHarness([{ id: 'i-alice', agentId: ALICE }], [agent(ALICE)], new Set([ALICE]), {
      workspaceName: null
    })

    await h.reconciler.tick()

    const [, conversation] = h.upsertConversation.mock.calls[0] as unknown as [string, { name: string }]
    expect(conversation.name).toBe('Operations')
  })

  it('seeds an ALL-GATED bot Off — the §14 arm, asked of the members that could own the row', async () => {
    const h = seedHarness([{ id: 'i-alice', agentId: ALICE }], [agent(ALICE, 'restricted')], new Set([ALICE]))

    await h.reconciler.tick()

    expect(h.upsertConversation).toHaveBeenCalledWith('i-alice', expect.anything(), { defaultTrigger: 'off' })
    expect(h.upsertAgent).not.toHaveBeenCalled()
  })
})
