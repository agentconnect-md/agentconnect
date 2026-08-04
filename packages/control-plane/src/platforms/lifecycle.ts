/**
 * The platform slot's BACKGROUND lifecycle (integration-plugin-architecture.md
 * §9 `pendingInstalls` / `backgroundLoops`).
 *
 * `buildContainer` used to hand-list three `SlackInstallReaper` instances and
 * one reconciler by name, and `startBackground()` / `shutdown()` named each of
 * them again. The reaper CLASS and the lifecycle are core — one clock-driven
 * sweep, armed after `listen`, never in tests — but WHICH funnels have durable
 * state, what their labels are, how long their rows may linger, and which
 * convergence loops exist are the provider's declarations. So the fan-out lives
 * here, takes the registry, and names no platform.
 *
 * Extracted from the container (rather than inlined there) so it is unit
 * testable without Postgres: `lifecycle.test.ts` drives it with a FakeClock and
 * stub stores and pins that every declaration gets exactly one reaper.
 */
import { SlackInstallReaper, type ReaperLog } from '../orchestrator/slackInstallReaper.js'
import type { Clock } from '../domain/clock.js'
import type { CpBackgroundLoop, CpPlatformRegistry } from './provider.js'

/**
 * One TTL reaper per declared pending-install funnel, in registry order. Today
 * that is exactly the three the container used to construct by hand:
 * `slack-install` (a client secret + bot token must not linger past an
 * abandoned funnel), `slack-platform-install` (an abandoned "Add to Slack" tab
 * must not leave a live state nonce) and `feishu-registration` (encrypted
 * device code / app secret, deliberately short-lived).
 *
 * Returned UNARMED — the caller's `startBackground()` arms them, so no timer
 * exists under a test's FakeClock unless the test asks for one.
 */
export function buildPendingInstallReapers(
  platforms: CpPlatformRegistry,
  clock: Clock,
  log?: ReaperLog
): SlackInstallReaper[] {
  return platforms
    .all()
    .flatMap((provider) => provider.pendingInstalls ?? [])
    .map(
      (decl) =>
        new SlackInstallReaper(decl.store, clock, { ttlMs: decl.ttlMs, intervalMs: decl.intervalMs }, log, decl.label)
    )
}

/** Every provider-owned convergence loop, in registry order — today the Slack
 *  bot-identity reconciler alone. The provider was constructed with the same
 *  instance the container holds; this only collects them so the lifecycle can
 *  drive start/stop without a per-platform field. */
export function platformBackgroundLoops(platforms: CpPlatformRegistry): CpBackgroundLoop[] {
  return platforms.all().flatMap((provider) => [...(provider.backgroundLoops ?? [])])
}
