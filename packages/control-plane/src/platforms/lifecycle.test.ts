/**
 * The provider-driven background lifecycle (§9 `pendingInstalls` /
 * `backgroundLoops`).
 *
 * `buildContainer` used to name four instances in three places each
 * (construction, `startBackground()`, `shutdown()`), which is exactly the shape
 * where a fifth funnel gets constructed and then never armed — or armed twice.
 * These tests assert the fan-out against the PRODUCTION provider set: one reaper
 * per declaration, each driving its own store on its own TTL, and every loop
 * started and stopped exactly once.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildPendingInstallReapers, platformBackgroundLoops } from './lifecycle.js'
import { buildCpPlatformRegistry } from './registry.js'
import { createTelegramCpProvider } from './telegram/provider.js'
import { createDiscordCpProvider } from './discord/provider.js'
import { createSlackCpProvider } from './slack/provider.js'
import { createFeishuCpProvider, FEISHU_REGISTRATION_TTL_MS } from './feishu/provider.js'
import type { CpPlatformProvider } from './provider.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const SLACK_TTL_MS = 3600 * 1000
const SWEEP_MS = 600 * 1000

function reapSpy() {
  return { reapExpired: vi.fn<(staleBefore: Date) => Promise<number>>(async () => 0) }
}

/** The four providers exactly as `buildContainer` composes them: the Slack
 *  funnels' two stores + TTL knobs, the Feishu registration store, and the
 *  bot-identity reconciler instance. */
function productionRegistry() {
  const installs = reapSpy()
  const platformInstalls = reapSpy()
  const registrations = reapSpy()
  const identityReconciler = { start: vi.fn(), stop: vi.fn() }
  const registry = buildCpPlatformRegistry([
    createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
    createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
    createSlackCpProvider({
      pendingInstalls: { installs, platformInstalls, ttlMs: SLACK_TTL_MS, intervalMs: SWEEP_MS },
      identityReconciler
    }),
    createFeishuCpProvider({ pendingInstalls: { registrations, intervalMs: SWEEP_MS } })
  ])
  return { registry, installs, platformInstalls, registrations, identityReconciler }
}

describe('platform pending-install reapers', () => {
  it('builds exactly one reaper per declaration, unarmed', () => {
    const { registry } = productionRegistry()
    const clock = new FakeClock(1_000_000)
    const reapers = buildPendingInstallReapers(registry, clock)

    // Today: slack-install, slack-platform-install, feishu-registration.
    expect(reapers).toHaveLength(3)
    // Nothing is armed until `startBackground()` — no timer exists yet, which is
    // why a test that never calls it never sees a sweep.
    expect(clock.pendingTimers()).toBe(0)
  })

  it('drives each declared store on its own TTL, once per interval', async () => {
    const { registry, installs, platformInstalls, registrations } = productionRegistry()
    const clock = new FakeClock(10_000_000)
    const reapers = buildPendingInstallReapers(registry, clock)
    for (const reaper of reapers) reaper.start()
    expect(clock.pendingTimers()).toBe(3)

    const sweepAt = clock.now() + SWEEP_MS
    clock.advance(SWEEP_MS)
    await Promise.resolve()

    // Each store swept exactly once, with ITS OWN ttl — the Slack pair share the
    // env knob; the Feishu registration uses its funnel-appropriate constant.
    expect(installs.reapExpired).toHaveBeenCalledTimes(1)
    expect(platformInstalls.reapExpired).toHaveBeenCalledTimes(1)
    expect(registrations.reapExpired).toHaveBeenCalledTimes(1)
    expect(installs.reapExpired.mock.calls[0]![0]).toEqual(new Date(sweepAt - SLACK_TTL_MS))
    expect(platformInstalls.reapExpired.mock.calls[0]![0]).toEqual(new Date(sweepAt - SLACK_TTL_MS))
    expect(registrations.reapExpired.mock.calls[0]![0]).toEqual(new Date(sweepAt - FEISHU_REGISTRATION_TTL_MS))

    for (const reaper of reapers) reaper.stop()
    expect(clock.pendingTimers()).toBe(0)
  })

  it('a provider that declares no funnel state contributes no reaper', () => {
    const registry = buildCpPlatformRegistry([
      createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
      createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
      // The same two funnel-bearing platforms, composed WITHOUT their stores
      // (the focused-test composition): no declaration ⇒ no reaper.
      createSlackCpProvider({}),
      createFeishuCpProvider({})
    ])
    expect(buildPendingInstallReapers(registry, new FakeClock())).toEqual([])
  })
})

describe('platform background loops', () => {
  it('collects each provider loop once, and start/stop reach it exactly once', () => {
    const { registry, identityReconciler } = productionRegistry()
    const loops = platformBackgroundLoops(registry)

    expect(loops.map((loop) => loop.label)).toEqual(['slack-bot-identity'])
    for (const loop of loops) loop.start()
    for (const loop of loops) loop.stop()
    expect(identityReconciler.start).toHaveBeenCalledTimes(1)
    expect(identityReconciler.stop).toHaveBeenCalledTimes(1)
  })

  it('is empty when no provider declares one', () => {
    const registry = buildCpPlatformRegistry([createSlackCpProvider({}), createFeishuCpProvider({})])
    expect(platformBackgroundLoops(registry)).toEqual([])
  })

  it('extends to a newly registered platform with no core edit', () => {
    const started: string[] = []
    const extra: CpPlatformProvider = {
      ...createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
      platformId: 'mastodon',
      pendingInstalls: [
        { model: 'MastodonInstall', label: 'mastodon-install', store: reapSpy(), ttlMs: 60_000, intervalMs: 5_000 }
      ],
      backgroundLoops: [{ label: 'mastodon-sync', start: () => started.push('mastodon-sync'), stop: () => undefined }]
    }
    const { registry: production } = productionRegistry()
    const registry = buildCpPlatformRegistry([...production.all(), extra])

    expect(buildPendingInstallReapers(registry, new FakeClock())).toHaveLength(4)
    const loops = platformBackgroundLoops(registry)
    expect(loops.map((loop) => loop.label)).toEqual(['slack-bot-identity', 'mastodon-sync'])
    for (const loop of loops) loop.start()
    expect(started).toEqual(['mastodon-sync'])
  })
})
