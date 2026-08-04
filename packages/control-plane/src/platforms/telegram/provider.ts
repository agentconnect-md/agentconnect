/**
 * Telegram's control-plane platform provider (integration-plugin-architecture.md
 * §9, stage S3) — the first {@link CpPlatformProvider} instance, built against
 * the merged contract (`../provider.ts`).
 *
 * Telegram is the SIMPLEST provider shape the audit found (Appendix C §1.1):
 * one BotFather token, no install funnel (the whole install is the create-DTO
 * path), no pending-install state, no env keys, no HTTP callback ingress, and
 * one cosmetic side effect (the post-create avatar push). Every behavioral
 * member below delegates to the SAME function the live create route calls
 * today (`http/routes/integrations.ts:405-461` via `deps.verifyTelegramBot` /
 * `deps.syncTelegramBotIcon`), injected through {@link TelegramCpProviderDeps}
 * so tests fake the provider round-trips exactly like the route tests do.
 *
 * ADOPTION SEQUENCING: `POST /integrations` now reads this provider through the
 * registry end to end — its {@link TelegramCreateCredentials} block is folded
 * into the create body, {@link CpPlatformProvider.validateConfig} IS the route's
 * live token check, {@link CpPlatformProvider.buildNewBotInstall} maps the rows,
 * the avatar push runs as the tail's `sideEffects.postCreate`, and spec assembly
 * (`placement.ts`) awaits {@link CpPlatformProvider.projectIntegrationConfig}
 * for the §6.4 payload. {@link telegramIntegrationConfig} stays exported as the
 * ONE implementation behind that projector and the equivalence tests.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { IntegrationTelegramConfig } from '@agentconnect.md/protocol'
import type { BotSecretMaterial } from '../../persistence/ports.js'
import type { TelegramBotVerifier } from '../../http/telegram-identity.js'
import type { TelegramBotIconSyncer } from '../../http/telegram-bot-profile.js'
import type { CpConfigValidation, CpPlatformProvider } from '../provider.js'

/** The `telegram` credential block of the `POST /integrations` create body —
 *  relocated from `http/dto/index.ts`, which imports it back (one
 *  implementation for the live route and the provider's
 *  {@link CpPlatformProvider.credentialBodySchema}). A single BotFather token;
 *  Telegram has no app-level token and no signing secret. */
export const TelegramCreateCredentials = z.object({
  botToken: z.string().min(1)
})
export type TelegramCreateCredentials = z.infer<typeof TelegramCreateCredentials>

/**
 * The §6.4 opaque `IntegrationSpec.config` payload for one Telegram
 * integration — the body of `integrationToSpec`'s telegram arm
 * (`orchestrator/placement.ts`), extracted so the live placement path and the
 * provider's projector share ONE implementation. The routing knobs are
 * deliberately DUPLICATED from the core envelope: today's daemon readers still
 * take them from the opaque config (§6.4 tolerant-reader window).
 * Token-bearing — NEVER log the result.
 */
export function telegramIntegrationConfig(secret: Pick<BotSecretMaterial, 'botToken'>): IntegrationTelegramConfig {
  return { botToken: secret.botToken }
}

/** The provider's injected seams — the same functions `container.ts` wires
 *  into the route deps today (`verifyTelegramBot`, `syncTelegramBotIcon`), so
 *  the live route and the provider share one implementation and tests stay
 *  offline by faking exactly these. */
export interface TelegramCpProviderDeps {
  /** Live `getMe` check (`http/telegram-identity.ts`). */
  verifyBot: TelegramBotVerifier
  /** Cosmetic avatar push (`http/telegram-bot-profile.ts`). Absent ⇒ the
   *  platform reports no icon-sync capability (test composition, no icon
   *  pipeline) — presence of `sideEffects.syncBotProfileIcon` is the
   *  capability probe (`http/agent-bot-icon-sync.ts`). */
  syncBotIcon?: TelegramBotIconSyncer
  /**
   * Route plugins per mount scope, injected PRE-BOUND to the route deps
   * (`telegramCheckRoutes` at `'org'`; no public callback — Telegram's inbound
   * transport is the daemon's own long-lived connection). Injected rather than
   * imported for the same reason as Slack's: the route module consumes the
   * create-DTO module, which imports this provider's credential block, so
   * importing the factory here would close a runtime import cycle. Absent ⇒ no
   * contributed routes (focused tests).
   */
  funnelRoutes?: {
    org: FastifyPluginAsync[]
    publicCallback: FastifyPluginAsync[]
  }
}

export function createTelegramCpProvider(deps: TelegramCpProviderDeps): CpPlatformProvider<TelegramCreateCredentials> {
  const { syncBotIcon, funnelRoutes } = deps
  return {
    platformId: 'telegram',

    // No install FUNNEL — the whole install is the create-DTO path, and there is
    // no public OAuth callback (contract §9 note). One org-scoped route all the
    // same: the pre-install credential probe `POST /integrations/telegram/check`,
    // which surfaces Group Privacy Mode while the operator is still typing.
    installRoutes: (scope) => (scope === 'org' ? (funnelRoutes?.org ?? []) : (funnelRoutes?.publicCallback ?? [])),

    credentialBodySchema: TelegramCreateCredentials,

    /**
     * `getMe` + the Group-Privacy-Mode gate — the live checks the create route
     * runs before anything is stored (`integrations.ts:405-432`), with the
     * route's statuses, codes, and user-facing copy verbatim. Reachability is
     * best-effort by contract: only Telegram's definitive rejection refuses
     * with 400; a network blip is 503, never proof the token is bad.
     */
    async validateConfig(credentials): Promise<CpConfigValidation> {
      const checked = await deps.verifyBot(credentials.botToken)
      if (checked.status === 'invalid') {
        return {
          ok: false,
          status: 400,
          code: 'TELEGRAM_BOT_TOKEN_INVALID',
          message: 'Telegram rejected the bot token — copy it again from @BotFather.'
        }
      }
      if (checked.status === 'unreachable') {
        return {
          ok: false,
          status: 503,
          code: 'TELEGRAM_BOT_CHECK_UNAVAILABLE',
          message: 'AgentConnect could not reach Telegram to check this bot. Try again in a moment.'
        }
      }
      if (!checked.privacyModeDisabled) {
        return {
          ok: false,
          status: 400,
          code: 'TELEGRAM_PRIVACY_MODE_ENABLED',
          message:
            'Privacy Mode is still on. In @BotFather, send /setprivacy, select this bot, choose Disable, then try again.'
        }
      }
      // `name` is the middle rung of the create tail's name ladder
      // (operator-typed → getMe-derived → owning agent's name).
      return { ok: true, identity: { ...(checked.name ? { name: checked.name } : {}) } }
    },

    // The create tail's platform half (§9): one token into the shared row, no
    // extra bot/integration columns, no D6 identity to fence — the same rows
    // the route's telegram arm wrote inline before adoption. Telegram cannot
    // share a bot across agents, so the requested `shareable` is dropped.
    buildNewBotInstall: ({ credentials }) => ({
      secrets: { botToken: credentials.botToken, appToken: null, signingSecret: null }
    }),

    // One-slot packing of the shared two-slot bot_secret row
    // (`integrations.ts:443`: appToken/signingSecret stored null). No slot
    // gates an http assign — Telegram has no HTTP callback ingress at all.
    secretShape: {
      slots: { botToken: 'Telegram bot token (from @BotFather)' },
      httpAssignRequires: []
    },

    // No pending-install funnel state, no env keys, no per-user provider
    // tooling credentials, no background loops (contract optionality).

    // Post-create avatar push + ongoing icon convergence — both are today's
    // `syncTelegramBotIcon` (`integrations.ts:454-460`,
    // `http/agent-bot-icon-sync.ts:99-100`). Best-effort by contract: the
    // CALLER logs a failure and keeps the install; member presence is the
    // capability signal, so an icon-less composition omits the whole facet.
    ...(syncBotIcon
      ? {
          sideEffects: {
            postCreate: ({ secrets, agent }) => syncBotIcon(secrets.botToken, agent),
            syncBotProfileIcon: (bot, secrets, agent) => syncBotIcon(secrets.botToken, agent)
          }
        }
      : {}),

    // §6.4 projection: same body as the live `integrationToSpec` telegram arm
    // (both call {@link telegramIntegrationConfig}). Async by contract; Telegram
    // maintains no additional secret store to load from. Token-bearing — NEVER log.
    async projectIntegrationConfig(integration, bot, _core, secrets) {
      return telegramIntegrationConfig(secrets)
    }

    // `projectBotAssign` is DELIBERATELY absent: Telegram has no HTTP callback
    // ingress — the create route refuses `transport: 'http'` for it
    // (`integrations.ts:392-400`), so no telegram bot row can carry the http
    // transport and core's assign builder (`orchestrator/httpBot.ts`) never
    // sees one. Absence IS the "no relay path" signal (S3 contract erratum).
  }
}
