/**
 * Discord's control-plane platform provider (integration-plugin-architecture.md
 * §9, stage S3) — built against the merged contract (`../provider.ts`) beside
 * the Telegram provider, the two simplest platform shapes.
 *
 * Like Telegram, Discord has no install funnel (the whole install is the
 * create-DTO path), no pending-install state, no env keys, and no HTTP
 * callback ingress. It differs in two audited ways (Appendix C §1.1):
 *
 *  - `validateConfig` owns TWO provider round-trips, not one: the
 *    `users/@me` token check AND the Message-Content intent enablement.
 *    The intent flip mutates provider state BEFORE anything is stored
 *    (`integrations.ts:478-496`), which is exactly why the contract places
 *    every pre-persistence provider call in `validateConfig`, never in
 *    `sideEffects` — modeling it post-create would reorder observable
 *    behavior.
 *  - The bot's application (client) id is DECODED from the token
 *    (`discordAppIdFromBotToken`), not fetched — public metadata surfaced as
 *    the validated identity's `externalAppId` (persisted by today's create
 *    tail as `Bot.discordAppId` for the console's invite URL).
 *
 * Every behavioral member delegates to the SAME functions the live create
 * route calls today (`integrations.ts:467-536` via `deps.verifyDiscordBot` /
 * `deps.ensureDiscordMessageContentIntent` / `deps.syncDiscordBotProfile`),
 * injected through {@link DiscordCpProviderDeps} so tests stay offline.
 *
 * ADOPTION SEQUENCING: `POST /integrations` now reads this provider through the
 * registry — its {@link DiscordCreateCredentials} block is folded into the
 * create body and {@link CpPlatformProvider.validateConfig} IS the route's live
 * token check + intent enablement, and spec assembly (`placement.ts`) awaits
 * {@link CpPlatformProvider.projectIntegrationConfig} for the §6.4 payload.
 * {@link discordIntegrationConfig} stays exported as the ONE implementation
 * behind that projector and the equivalence tests.
 */
import { z } from 'zod'
import type { IntegrationCoreEnvelope, IntegrationDiscordConfig } from '@agentconnect.md/protocol'
import type { BotSecretMaterial } from '../../persistence/ports.js'
import {
  discordAppIdFromBotToken,
  type DiscordBotVerifier,
  type DiscordMessageContentIntentEnsurer
} from '../../http/discord-identity.js'
import type { DiscordBotProfileSyncer } from '../../http/discord-bot-profile.js'
import type { CpConfigValidation, CpPlatformProvider } from '../provider.js'

/** The `discord` credential block of the `POST /integrations` create body —
 *  relocated from `http/dto/index.ts`, which imports it back (one
 *  implementation for the live route and the provider's
 *  {@link CpPlatformProvider.credentialBodySchema}). A single Gateway bot
 *  token; the optional `applicationId` is the public client id for the
 *  invite URL. */
export const DiscordCreateCredentials = z.object({
  botToken: z.string().min(1),
  applicationId: z.string().min(1).optional()
})
export type DiscordCreateCredentials = z.infer<typeof DiscordCreateCredentials>

/**
 * The §6.4 opaque `IntegrationSpec.config` payload for one Discord
 * integration — the body of `integrationToSpec`'s discord arm
 * (`orchestrator/placement.ts`), extracted so the live placement path and the
 * provider's projector share ONE implementation. Discord authenticates the
 * Gateway with the single bot token (no appToken); the wire schema's optional
 * `applicationId` is deliberately NOT emitted — today's spec assembly never
 * ships it, and the daemon does not read it. Token-bearing — NEVER log.
 */
export function discordIntegrationConfig(
  core: IntegrationCoreEnvelope,
  secret: Pick<BotSecretMaterial, 'botToken'>
): IntegrationDiscordConfig {
  return { botToken: secret.botToken, bindRules: core.bindRules, mutedChannels: core.mutedChannels, gated: core.gated }
}

/** The provider's injected seams — the same functions `container.ts` wires
 *  into the route deps today, with the same optionality (`http/deps.ts`):
 *  `verifyBot` and `syncBotProfile` are optional so test composition stays
 *  offline; the intent ensurer is required (tests inject an offline success
 *  stub, exactly as they do for the route). */
export interface DiscordCpProviderDeps {
  /** Live `users/@me` token check (`http/discord-identity.ts`). Absent ⇒ no
   *  token validation (the route's own fallback: name derivation is skipped
   *  and the create tail falls back to the agent name). */
  verifyBot?: DiscordBotVerifier
  /** Idempotent Message-Content intent enablement (`http/discord-identity.ts`). */
  ensureMessageContentIntent: DiscordMessageContentIntentEnsurer
  /** Cosmetic avatar/description push (`http/discord-bot-profile.ts`). Absent ⇒
   *  no icon-sync capability — presence of `sideEffects.syncBotProfileIcon` is
   *  the capability probe (`http/agent-bot-icon-sync.ts`). */
  syncBotProfile?: DiscordBotProfileSyncer
}

export function createDiscordCpProvider(deps: DiscordCpProviderDeps): CpPlatformProvider<DiscordCreateCredentials> {
  const { verifyBot, ensureMessageContentIntent, syncBotProfile } = deps
  return {
    platformId: 'discord',

    // No install funnel: no org-scoped wizard routes, no public OAuth
    // callbacks. The whole install is the create-DTO path (contract §9 note).
    installRoutes: () => [],

    credentialBodySchema: DiscordCreateCredentials,

    /**
     * `users/@me` + Message-Content intent enablement — the live checks the
     * create route runs before anything is stored (`integrations.ts:467-505`),
     * with the route's statuses, codes, and user-facing copy verbatim (the
     * token rejection carries no machine code today — neither does this).
     * Reachability is best-effort: an unreachable `users/@me` does NOT refuse
     * (the route proceeds with no derived name), while the intent ensure is
     * the gating call — its definitive rejection is 400, its network blip 503.
     */
    async validateConfig(credentials): Promise<CpConfigValidation> {
      const check = verifyBot ? await verifyBot(credentials.botToken) : null
      if (check?.status === 'invalid') {
        return {
          ok: false,
          status: 400,
          message:
            'Discord rejected the bot token — check you pasted the Bot token from the Developer Portal (Bot → Reset Token).'
        }
      }
      const intentSetup = await ensureMessageContentIntent(credentials.botToken)
      if (intentSetup === 'rejected') {
        return {
          ok: false,
          status: 400,
          code: 'DISCORD_MESSAGE_CONTENT_INTENT_SETUP_FAILED',
          message:
            'AgentConnect could not enable Message Content Intent automatically. Open the Discord Developer Portal → Bot → Privileged Gateway Intents, turn on Message Content Intent, save, then try again.'
        }
      }
      if (intentSetup === 'unreachable') {
        return {
          ok: false,
          status: 503,
          code: 'DISCORD_MESSAGE_CONTENT_INTENT_CHECK_UNAVAILABLE',
          message:
            'AgentConnect could not reach Discord to check or enable Message Content Intent. Try installing again in a moment.'
        }
      }
      // `name` is the middle rung of the create tail's name ladder (operator →
      // users/@me-derived, best-effort → owning agent); `externalAppId` is the
      // application id decoded from the token (public metadata — persisted by
      // the create tail as `Bot.discordAppId` for the console's invite URL).
      const name = check?.status === 'ok' ? check.name : null
      const externalAppId = discordAppIdFromBotToken(credentials.botToken)
      return {
        ok: true,
        identity: { ...(name ? { name } : {}), ...(externalAppId ? { externalAppId } : {}) }
      }
    },

    // One-slot packing of the shared two-slot bot_secret row
    // (`integrations.ts:515`: appToken/signingSecret stored null). No slot
    // gates an http assign — Discord has no HTTP callback ingress at all.
    secretShape: {
      slots: { botToken: 'Discord bot token (Developer Portal → Bot)' },
      httpAssignRequires: []
    },

    // No pending-install funnel state, no env keys, no per-user provider
    // tooling credentials, no background loops (contract optionality).

    // Post-create profile push (avatar + application icon/description) and
    // ongoing icon convergence — both are today's `syncDiscordBotProfile`
    // (`integrations.ts:526-535`, `http/agent-bot-icon-sync.ts:101-102`).
    // Best-effort by contract: the CALLER logs a failure and keeps the
    // install. The route additionally skips the post-create push when the
    // token check came back unreachable — a create-tail optimization that
    // stays with the caller (the verification outcome is not part of the
    // side-effect input).
    ...(syncBotProfile
      ? {
          sideEffects: {
            postCreate: ({ secrets, agent }) => syncBotProfile(secrets.botToken, agent),
            syncBotProfileIcon: (bot, secrets, agent) => syncBotProfile(secrets.botToken, agent)
          }
        }
      : {}),

    // §6.4 projection: same body as the live `integrationToSpec` discord arm
    // (both call {@link discordIntegrationConfig}). Async by contract; Discord
    // maintains no additional secret store to load from. Token-bearing — NEVER log.
    async projectIntegrationConfig(integration, bot, core, secrets) {
      return discordIntegrationConfig(core, secrets)
    }

    // `projectBotAssign` is DELIBERATELY absent: Discord has no HTTP callback
    // ingress — the create route refuses `transport: 'http'` for it
    // (`integrations.ts:392-400`), so no Discord bot row can carry the http
    // transport and core's assign builder (`orchestrator/httpBot.ts`) never
    // sees one. Absence IS the "no relay path" signal (S3 contract erratum).
  }
}
