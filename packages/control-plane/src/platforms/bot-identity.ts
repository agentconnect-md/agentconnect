/**
 * The D6 identity projection, read through the platform registry
 * (integration-plugin-architecture.md §9/§11; audit F13).
 *
 * `PgBotRepo.create` performs the generic identity dual-write for EVERY caller —
 * the shared create tail (`http/install-bot.ts`), the Feishu one-click funnel
 * (`http/install-feishu.ts`), and anything added later. It used to decide WHAT
 * to write with a four-arm `switch (input.platform)`: per-platform knowledge in
 * shared persistence, the exact shape §12 names ("if you find yourself editing a
 * `switch` in core, the seam is missing a member"). The member is now
 * {@link CpPlatformProvider.projectBotIdentity}; this is the one adapter between
 * it and the repository's {@link BotIdentityProjector} port.
 *
 * TOTAL AND FAIL-SAFE. An unregistered platform, or a registered one that
 * declares no projection (Telegram — a bot token and nothing else), projects
 * `{}`: the row carries no generic identity, which is what "this platform has no
 * external app identity" means. It is NOT a licence to skip the projector —
 * `PgBotRepo` throws when it was never wired, so a composition that forgets this
 * fails loudly rather than writing the NULLs §11 reserves for legacy rows.
 */
import type { BotIdentityProjector } from '../persistence/ports.js'
import type { CpPlatformRegistry } from './provider.js'

/** Bind `platforms` as the repository's identity projector. Every read runs at
 *  bot-row WRITE time, so a late-bound registry façade is a valid argument. */
export function botIdentityProjector(platforms: CpPlatformRegistry): BotIdentityProjector {
  return (input) => platforms.get(input.platform)?.projectBotIdentity?.(input) ?? {}
}
