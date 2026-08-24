/**
 * Feishu / Lark's control-plane platform provider (integration-plugin-
 * architecture.md §9, stage S3) — built against the merged contract
 * (`../provider.ts`) beside the Slack provider, the second funnel-bearing
 * shape: a one-click device-registration funnel (`FeishuAppRegistration` +
 * TTL reaper), provider env keys (the platform-owned regional apps), an icon
 * side effect, and an HTTP/relay path (`projectBotAssign`).
 *
 * Every behavioral member delegates to the SAME functions the live paths call
 * today, injected through {@link FeishuCpProviderDeps} so tests stay offline:
 *
 *  - `validateConfig` → `deps.verifyBot` (the tenant-access-token exchange +
 *    `bot/v3/info`, `http/feishu-identity.ts`) — the exact checks of the
 *    create route's feishu arm (`http/routes/integrations.ts`), statuses and
 *    user-facing copy verbatim, including the http-transport `openId`
 *    resolution the relay needs for @-mention demux;
 *  - `installRoutes` → the registration funnel plugin, injected PRE-BOUND to
 *    the route deps by the composition root (not imported here: provider
 *    construction stays one-directional, which is what keeps the create route
 *    free to fold this provider's credential block into its body schema);
 *  - the wire projections → {@link feishuIntegrationConfig} /
 *    {@link feishuSharedIntegrationConfig} / {@link feishuBotAssignBags},
 *    called by BOTH the live paths (`orchestrator/placement.ts`,
 *    `orchestrator/httpBot.ts`) and the provider (one implementation).
 *
 * ADOPTION SEQUENCING: core now reads this provider through the registry end to
 * end — `server.ts` mounts the registration funnel from
 * {@link CpPlatformProvider.installRoutes}, `POST /integrations` folds
 * {@link FeishuCreateCredentials} + {@link refineFeishuCreateBody} into its body
 * and runs {@link CpPlatformProvider.validateConfig} +
 * {@link CpPlatformProvider.buildNewBotInstall} (D6 fence included) as its tail,
 * `config/env.ts` folds {@link FeishuCpEnvSchema}, the container's background
 * lifecycle drives the declared registration reaper, and spec assembly
 * (`placement.ts`) / `rc/bot-assign` (`httpBot.ts`) await
 * {@link CpPlatformProvider.projectIntegrationConfig} /
 * {@link CpPlatformProvider.projectBotAssign}. The helpers below stay exported
 * as the ONE implementation both the projectors and the equivalence tests call.
 */
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import { FeishuRegion } from '@agentconnect.md/protocol'
import type { IntegrationFeishuConfig } from '@agentconnect.md/protocol'
import type { BotRecord, BotSecretMaterial, IntegrationRecord } from '../../persistence/ports.js'
import { TENANTLESS_SENTINEL } from '../../persistence/ports.js'
import type { FeishuAppTenantGuard, FeishuBotVerifier } from '../../http/feishu-identity.js'
import type { FeishuAppIconSyncer } from '../../http/feishu-app-icon.js'
import type { CpConfigValidation, CpInstallTransport, CpPlatformProvider } from '../provider.js'

/** The `feishu` credential block of the `POST /integrations` create body —
 *  relocated from `http/dto/index.ts`, which imports it back (one
 *  implementation for the live route and the provider's
 *  {@link CpPlatformProvider.credentialBodySchema}). An appId + appSecret
 *  pair; `region` picks the open-platform gateway (feishu.cn vs
 *  larksuite.com) and defaults to international Lark for new create requests.
 *  The http-transport requirement (`verificationToken`) lives in
 *  {@link refineFeishuCreateBody}. */
export const FeishuCreateCredentials = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  region: FeishuRegion.default('lark'),
  verificationToken: z.string().min(1).optional(),
  encryptKey: z.string().min(1).optional()
})
export type FeishuCreateCredentials = z.infer<typeof FeishuCreateCredentials>

/**
 * Transport-conditional credential requirements the flat schema cannot express
 * (§9 `refineCreateBody`) — the feishu arm of the create DTO's `superRefine`,
 * extracted so `http/dto/index.ts` and the provider share ONE implementation:
 * callback (http) ingress needs the event-subscription verification token the
 * relay authenticates inbound POSTs with; `encryptKey` stays optional (Feishu
 * apps may post plaintext events).
 */
export function refineFeishuCreateBody(
  body: { credentials: FeishuCreateCredentials; transport: CpInstallTransport },
  addIssue: (message: string) => void
): void {
  if (body.transport === 'http' && !body.credentials.verificationToken) {
    addIssue('http transport requires feishu.verificationToken')
  }
}

/**
 * Credentials for the regional Login Apps configured in Logto. The Control
 * Plane mirrors them so it can resolve the deployment tenant and reject Bot
 * Apps created in another organization. They are static App credentials, not
 * human access or refresh tokens. Each regional all-or-none check lives in
 * `config/feishu-platform.ts`.
 */
export const FeishuCpEnvSchema = {
  FEISHU_PLATFORM_APP_ID: z.string().optional(),
  FEISHU_PLATFORM_APP_SECRET: z.string().optional(),
  LARK_PLATFORM_APP_ID: z.string().optional(),
  LARK_PLATFORM_APP_SECRET: z.string().optional()
} satisfies ZodRawShape

/** How long an unfinished one-click registration row may linger. Device code /
 *  App Secret are encrypted but deliberately short-lived: a terminal status is
 *  retained briefly for the browser's poll, then the durable row is cleared.
 *  A funnel-appropriate constant, not an env knob (contract §9) — shared by
 *  the provider's declaration and the container's live reaper. */
export const FEISHU_REGISTRATION_TTL_MS = 10 * 60 * 1000

/**
 * The §6.4 opaque `IntegrationSpec.config` payload for a DIRECT (socket)
 * Feishu integration — the body of `integrationToSpec`'s feishu arm
 * (`orchestrator/placement.ts`), extracted so the live placement path and the
 * provider's projector share ONE implementation. Feishu authenticates the
 * WSClient with an appId + appSecret pair, stored in the two-slot
 * `bot_secret`: `botToken` = appSecret (the secret), `appToken` = appId. The
 * region (feishu.cn vs larksuite.com) rides on the integration row; NULL ⇒
 * 'feishu'. Token-bearing — NEVER log the result.
 */
export function feishuIntegrationConfig(
  secret: Pick<BotSecretMaterial, 'botToken' | 'appToken'>,
  integration: Pick<IntegrationRecord, 'feishuRegion'>
): IntegrationFeishuConfig {
  return {
    appId: secret.appToken ?? '',
    appSecret: secret.botToken,
    region: integration.feishuRegion ?? 'feishu'
  }
}

/**
 * The §6.4 payload for a SHARED (http/relay) Feishu integration — the feishu
 * arm of `httpIntegrationToSpec` (`orchestrator/placement.ts`), extracted for
 * the same one-implementation reason. The daemon keeps the authenticated REST
 * client for send/download; callbacks arrive through the relay pre-addressed.
 * `botUserId` is the bot's own open_id (from the bot row), shipped as
 * `botOpenId` so the daemon can skip a `bot/info` round-trip.
 * Token-bearing — NEVER log.
 */
export function feishuSharedIntegrationConfig(
  secret: Pick<BotSecretMaterial, 'botToken' | 'appToken'>,
  integration: Pick<IntegrationRecord, 'feishuRegion'>,
  botUserId?: string
): IntegrationFeishuConfig {
  return {
    appId: secret.appToken ?? '',
    appSecret: secret.botToken,
    ...(botUserId ? { botOpenId: botUserId } : {}),
    region: integration.feishuRegion ?? 'feishu'
  }
}

/**
 * The two opaque `rc/bot-assign` bags for a Feishu HTTP bot (§6.7) — the
 * feishu fork of `buildAssign` (`orchestrator/httpBot.ts`), extracted so the
 * live frame assembly and the provider's
 * {@link CpPlatformProvider.projectBotAssign} share ONE implementation.
 *
 *  - ingress `apiAppId` — the Feishu app id, read from the SECRET row's
 *    `appToken` slot (the two-slot overloading above); O(1) inbound demux.
 *    (The pre-extraction inline chain nominally fell through to
 *    `bot.slackAppId` when the slot was empty — unreachable for a feishu row,
 *    which never persists one, so the fork is per-platform here.)
 *  - ingress `teamId` / `botUserId` — tenant + bot open_id demux identity from
 *    the bot row, when persisted.
 *  - secrets — the event-subscription verification token (+ optional encrypt
 *    key); core's completeness gate requires the verification token AND the
 *    app id before an assign is built (`secretShape.httpAssignRequires`).
 *    The daemon-only appSecret deliberately does NOT ride to the relay.
 *
 * Token-bearing — NEVER log the result.
 */
export function feishuBotAssignBags(
  bot: Pick<BotRecord, 'teamId' | 'botUserId'>,
  secret: Pick<BotSecretMaterial, 'appToken' | 'verificationToken' | 'encryptKey'>
): { secrets: Record<string, unknown>; ingress: Record<string, unknown> } {
  return {
    secrets: {
      verificationToken: secret.verificationToken ?? '',
      ...(secret.encryptKey ? { encryptKey: secret.encryptKey } : {})
    },
    ingress: {
      ...(secret.appToken ? { apiAppId: secret.appToken } : {}),
      ...(bot.teamId ? { teamId: bot.teamId } : {}),
      ...(bot.botUserId ? { botUserId: bot.botUserId } : {})
    }
  }
}

/** The provider's injected seams — the same functions/objects `container.ts`
 *  wires into the route deps today, so the live paths and the provider share
 *  one implementation and tests stay offline by faking exactly these. */
export interface FeishuCpProviderDeps {
  /** Live tenant-access-token exchange + `bot/v3/info` name/open_id derivation
   *  (`http/feishu-identity.ts`). Absent ⇒ no credential validation (the
   *  route's own fallback — except http transport, which then cannot resolve
   *  the bot identity and refuses with the route's 503). */
  verifyBot?: FeishuBotVerifier
  /** Enforces that installed Apps share the configured Login App's tenant. */
  tenantGuard?: FeishuAppTenantGuard
  /**
   * The registration funnel's Fastify plugin, injected PRE-BOUND to the route
   * deps (`feishuRegistrationRoutes` at `'org'`; Feishu has no browser OAuth
   * callback — the device flow polls server-side, so `'public-callback'` is
   * empty). Injected rather than imported (see the module doc: DTO import
   * cycle). Absent ⇒ no funnel routes (focused tests).
   */
  funnelRoutes?: {
    org: FastifyPluginAsync[]
    publicCallback: FastifyPluginAsync[]
  }
  /** Cosmetic app icon push + version submit (`http/feishu-app-icon.ts`).
   *  Absent ⇒ no icon-sync capability — presence of
   *  `sideEffects.syncBotProfileIcon` is the capability probe
   *  (`http/agent-bot-icon-sync.ts`). */
  syncAppIcon?: FeishuAppIconSyncer
  /** Pending-registration funnel state (§9 `pendingInstalls`): the store's
   *  reap slice + the sweep interval (shared with the Slack reapers' env
   *  knob today). The TTL is {@link FEISHU_REGISTRATION_TTL_MS}. Absent ⇒ no
   *  funnel state declared (focused tests). */
  pendingInstalls?: {
    registrations: { reapExpired(staleBefore: Date): Promise<number> }
    intervalMs: number
  }
}

export function createFeishuCpProvider(deps: FeishuCpProviderDeps): CpPlatformProvider<FeishuCreateCredentials> {
  const { verifyBot, tenantGuard, funnelRoutes, syncAppIcon, pendingInstalls } = deps
  return {
    platformId: 'feishu',

    // The one-click registration funnel rides here (contract §9): org-scoped
    // start/poll only — no unauthenticated browser callback (device flow).
    installRoutes: (scope) => (scope === 'org' ? (funnelRoutes?.org ?? []) : (funnelRoutes?.publicCallback ?? [])),

    credentialBodySchema: FeishuCreateCredentials,

    refineCreateBody: refineFeishuCreateBody,

    envSchema: FeishuCpEnvSchema,

    /**
     * The tenant-access-token exchange (validates BOTH credentials in one
     * call) + the http-transport `openId` resolution — the live checks the
     * create route runs before anything is stored (`integrations.ts` feishu
     * arm), statuses and user-facing copy verbatim (none carries a machine
     * code today). Reachability is best-effort for the socket transport (an
     * unreachable Feishu refuses nothing — the create tail falls back to the
     * agent name); the http transport REQUIRES a resolved bot open_id (the
     * relay uses it to distinguish @bot from ordinary-user mentions), so an
     * inconclusive check refuses with the route's 503 — never a 400, an
     * unreachable provider is not proof the credentials are bad. The
     * http-transport relay-availability check is a 409 and stays core, as do
     * the D6 identity fence's 409s (contract §9).
     */
    async validateConfig(credentials, transport): Promise<CpConfigValidation> {
      const check = verifyBot ? await verifyBot(credentials.appId, credentials.appSecret, credentials.region) : null
      if (check?.status === 'invalid') {
        return {
          ok: false,
          status: 400,
          message:
            'Feishu rejected the credentials — check the App ID (cli_…) and App Secret from the Developer Console (Credentials & Basic Info).'
        }
      }
      const tenant = tenantGuard
        ? await tenantGuard.checkApp(credentials.appId, credentials.appSecret, credentials.region)
        : 'not_configured'
      if (tenant === 'not_configured') {
        return {
          ok: false,
          status: 503,
          message: 'This AgentConnect deployment has no Lark/Feishu Login App configured for this region.'
        }
      }
      if (tenant === 'invalid_credentials') {
        return {
          ok: false,
          status: 400,
          message:
            'Feishu rejected the credentials — check the App ID (cli_…) and App Secret from the Developer Console (Credentials & Basic Info).'
        }
      }
      if (tenant === 'unavailable' || tenant === 'unresolved') {
        return {
          ok: false,
          status: 503,
          message:
            'Could not verify this App’s organization. Enable and publish the Obtain tenant information permission, then try again.'
        }
      }
      if (tenant === 'org_mismatch') {
        return {
          ok: false,
          status: 400,
          code: 'FEISHU_ORG_MISMATCH',
          message: 'This Bot App belongs to a different Lark/Feishu organization from this AgentConnect deployment.'
        }
      }
      // HTTP ingress cannot call Feishu with the app secret, so the CP must
      // resolve the bot's own open_id now (route parity: 503, inconclusive).
      if (transport === 'http' && (check?.status !== 'ok' || !check.openId)) {
        return {
          ok: false,
          status: 503,
          message: 'Could not resolve this app’s bot identity. Enable the bot capability in Feishu, then try again.'
        }
      }
      // `name` is the middle rung of the create tail's name ladder;
      // `externalAppId` is the pasted `cli_…` app id echoed back (the D6
      // fence's key — core persists and checks it); `botUserId` is the bot's
      // own open_id where resolved (http demux).
      const name = check?.status === 'ok' ? check.name : null
      const openId = check?.status === 'ok' ? check.openId : null
      return {
        ok: true,
        identity: {
          ...(name ? { name } : {}),
          externalAppId: credentials.appId,
          ...(openId ? { botUserId: openId } : {})
        }
      }
    },

    /**
     * The create tail's platform half (§9) — the same rows `installNewFeishuBot`
     * writes for a manual credential install (the one-click funnel keeps that
     * function for its pre-reserved-id idempotency):
     *
     *  - the app id and the gateway region are durable on BOTH rows, so a freed
     *    bot reinstalls against the region it was registered with;
     *  - `botUserId` is the bot's own open_id where `validateConfig` resolved it
     *    (http ingress demuxes @-mentions with it);
     *  - the D6 fence declares the identity core checks BEFORE the write and the
     *    copy core sends when either half of the fence fires. `'-'` is the
     *    tenantless sentinel `BotRepo.getByExternalIdentity` documents;
     *  - Feishu bots are single-agent — the requested `shareable` is dropped.
     */
    buildNewBotInstall: ({ credentials, identity }) => ({
      bot: {
        feishuAppId: credentials.appId,
        feishuRegion: credentials.region,
        ...(identity.botUserId ? { botUserId: identity.botUserId } : {})
      },
      integration: { feishuRegion: credentials.region },
      secrets: {
        botToken: credentials.appSecret,
        appToken: credentials.appId,
        signingSecret: null,
        verificationToken: credentials.verificationToken ?? null,
        encryptKey: credentials.encryptKey ?? null
      },
      externalIdentity: {
        externalAppId: credentials.appId,
        externalTenantId: TENANTLESS_SENTINEL,
        conflictMessage:
          'This Feishu app is already registered as a bot. Reuse that bot (pick it under "Existing") instead of registering the app again.'
      }
    }),

    /**
     * D6 identity (§11): Feishu is APP-scoped with NO tenant axis, so the pair
     * is the `cli_…` app id plus {@link TENANTLESS_SENTINEL} — a real value, so
     * the composite unique actually fires and becomes a one-bot-per-Feishu-app
     * fence. (Writing NULL there would silently disable it: a NULL never
     * participates in a composite unique.)
     *
     * The gateway region has no generic column, so it rides the generic bag
     * beside the app id — the durable home that lets a freed bot reinstall
     * against the same gateway once the legacy columns are dropped.
     */
    projectBotIdentity: (input) => {
      const bag = {
        ...(input.feishuAppId ? { feishuAppId: input.feishuAppId } : {}),
        ...(input.feishuRegion ? { feishuRegion: input.feishuRegion } : {})
      }
      return {
        ...(input.feishuAppId ? { externalAppId: input.feishuAppId, externalTenantId: TENANTLESS_SENTINEL } : {}),
        ...(Object.keys(bag).length ? { platformConfig: bag } : {})
      }
    },

    threadFallbackRealm: (bot) => {
      const appId = bot.feishuAppId ?? bot.externalAppId
      return appId ? `${bot.feishuRegion ?? 'feishu'}:${appId}` : null
    },

    // Feishu reuses the established two-slot shape (`install-feishu.ts`):
    // botToken = app SECRET (the credential), appToken = app ID (the
    // identifier) — the overloading the audit found spelled only in comments,
    // made data here. An http assign is gated on the verification token AND
    // the app id (`httpBot.ts`: callback ingress needs both to authenticate
    // and demux inbound POSTs).
    secretShape: {
      slots: {
        botToken: 'Feishu app secret (Developer Console → Credentials & Basic Info)',
        appToken: 'Feishu app id (cli_…; identifier, not a secret)',
        verificationToken: 'Feishu event-subscription verification token (http only)',
        encryptKey: 'Feishu event encrypt key (http only, optional)'
      },
      httpAssignRequires: ['verificationToken', 'appToken']
    },

    // The one-click registration funnel's durable state (§9): encrypted device
    // cursor + provisional credentials, swept on a funnel-appropriate constant
    // TTL rather than the Slack env knob — exactly today's third container
    // reaper instance.
    ...(pendingInstalls
      ? {
          pendingInstalls: [
            {
              model: 'FeishuAppRegistration',
              label: 'feishu-registration',
              store: pendingInstalls.registrations,
              ttlMs: FEISHU_REGISTRATION_TTL_MS,
              intervalMs: pendingInstalls.intervalMs
            }
          ] as const
        }
      : {}),

    // Ongoing agent-icon convergence only — the feishu create arm runs no
    // post-create push (the one-click funnel brands the app at registration
    // time instead, via the deeplink's avatarUrl). The app id is resolved from
    // the secret row, falling back to public bot metadata for older rows
    // (`http/agent-bot-icon-sync.ts` feishu arm); a row with neither is
    // skipped — the sync is cosmetic and best-effort by contract.
    ...(syncAppIcon
      ? {
          sideEffects: {
            syncBotProfileIcon: async (bot, secrets, agent) => {
              const appId = secrets.appToken ?? bot.feishuAppId
              if (!appId) return
              await syncAppIcon(appId, secrets.botToken, bot.feishuRegion ?? 'feishu', agent)
            }
          }
        }
      : {}),

    // No per-user provider tooling credentials (Feishu's one-click flow rides
    // the official device authorization, not a caller-stored config token) and
    // no background loops (contract optionality).

    // §6.4 projection: `bot.transport` is the direct-vs-shared fork itself
    // (`integrations.ts`) — the same bodies the live `integrationToSpec` /
    // `httpIntegrationToSpec` feishu arms call. Async by contract; Feishu
    // maintains no additional secret store to load from. Token-bearing — NEVER log.
    async projectIntegrationConfig(integration, bot, _core, secrets) {
      return bot.transport === 'http'
        ? feishuSharedIntegrationConfig(secrets, integration, bot.botUserId ?? undefined)
        : feishuIntegrationConfig(secrets, integration)
    },

    // §6.7 projection: same body as the live `buildAssign` feishu fork (both
    // call {@link feishuBotAssignBags}). Token-bearing — NEVER log.
    async projectBotAssign(bot, secrets) {
      return feishuBotAssignBags(bot, secrets)
    }
  }
}
