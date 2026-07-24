import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { BotId, OrgId } from '../domain/ids.js'
import type { BotRecord, BotRepo, BotSecretStore } from '../persistence/ports.js'
import { SlackBotIdentityReconciler } from './slackBotIdentityReconciler.js'

const BOT = BotId('22222222-2222-4222-8222-222222222222')

function bot(): BotRecord {
  return {
    id: BOT,
    orgId: OrgId('11111111-1111-4111-8111-111111111111'),
    platform: 'slack',
    name: 'legacy-http',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    shareable: false,
    transport: 'http',
    createdBy: null,
    lastUsedAt: null,
    lastAgentName: null,
    agentIds: [],
    inUseByAgentId: null,
    createdAt: new Date(0)
  }
}

describe('SlackBotIdentityReconciler', () => {
  it('resolves and backfills a missing HTTP Slack app id without exposing the token', async () => {
    const setSlackAppIdIfMissing = vi.fn(async () => true)
    const bots = {
      listHttpMissingSlackAppId: async () => [bot()],
      setSlackAppIdIfMissing
    } as unknown as BotRepo
    const secrets = {
      get: async () => ({ botToken: 'xoxb-secret', appToken: null, signingSecret: 'signing-secret' })
    } as unknown as BotSecretStore
    const resolve = vi.fn(async () => 'AHTTPBOT')
    const info = vi.fn()

    await new SlackBotIdentityReconciler(
      bots,
      secrets,
      resolve,
      new FakeClock(),
      { intervalMs: 60_000 },
      {
        info,
        warn() {},
        error() {}
      }
    ).tick()

    expect(resolve).toHaveBeenCalledWith('xoxb-secret')
    expect(setSlackAppIdIfMissing).toHaveBeenCalledWith(BOT, 'AHTTPBOT')
    expect(JSON.stringify(info.mock.calls)).not.toContain('xoxb-secret')
  })

  it('keeps unresolved rows retryable and never stores a malformed id', async () => {
    const setSlackAppIdIfMissing = vi.fn(async () => true)
    const bots = {
      listHttpMissingSlackAppId: async () => [bot()],
      setSlackAppIdIfMissing
    } as unknown as BotRepo
    const secrets = {
      get: async () => ({ botToken: 'xoxb-secret', appToken: null, signingSecret: 'signing-secret' })
    } as unknown as BotSecretStore

    await new SlackBotIdentityReconciler(bots, secrets, async () => 'not-an-app-id', new FakeClock(), {
      intervalMs: 60_000
    }).tick()

    expect(setSlackAppIdIfMissing).not.toHaveBeenCalled()
  })

  it('runs immediately on start and re-arms the retry interval', async () => {
    const clock = new FakeClock()
    const list = vi.fn(async () => [])
    const reconciler = new SlackBotIdentityReconciler(
      { listHttpMissingSlackAppId: list } as unknown as BotRepo,
      {} as BotSecretStore,
      async () => null,
      clock,
      { intervalMs: 60_000 }
    )

    reconciler.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(list).toHaveBeenCalledTimes(1)
    expect(clock.pendingTimers()).toBe(1)

    reconciler.stop()
    expect(clock.pendingTimers()).toBe(0)
  })
})
