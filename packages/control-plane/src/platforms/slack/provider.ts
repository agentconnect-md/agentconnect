/**
 * Slack's control-plane platform provider (integration-plugin-architecture.md
 * §9, stage S3) — built against the merged contract (`../provider.ts`) beside
 * the Telegram/Discord pair (#574), and the first provider with the FULL §9
 * surface: two install funnels (the config-token quick install and the
 * platform-published "Add to Slack" app), two pending-install models with TTL
 * reapers, provider env keys, per-user provider tooling credentials
 * (`SlackUserConfig`), a background convergence loop (the bot-identity
 * reconciler), and an HTTP/relay path (`projectBotAssign`).
 *
 * Every behavioral member delegates to the SAME functions the live paths call
 * today, injected through {@link SlackCpProviderDeps} so tests stay offline:
 *
 *  - `validateConfig` → `deps.verifyBot` / `deps.verifyAppToken` — the exact
 *    checks of the create route's slack arm (`http/routes/integrations.ts`),
 *    statuses and user-facing copy verbatim;
 *  - `installRoutes` → the funnel plugins, injected PRE-BOUND to the route
 *    deps by the composition root. They are deliberately not imported here:
 *    the funnel route modules consume the create-DTO module
 *    (`http/dto/index.ts`), which imports this provider's credential block —
 *    binding the factories here would close a runtime import cycle;
 *  - `providerToolingCredentials` → `resolveUserConfigAccessToken` /
 *    `configUsable` (`http/slack-user-config.ts`), the same resolution the
 *    funnel start and the Settings→Bots refresh flow call;
 *  - the wire projections → {@link slackIntegrationConfig} /
 *    {@link slackSharedIntegrationConfig} / {@link slackBotAssignBags}, called
 *    by BOTH the live paths (`orchestrator/placement.ts`,
 *    `orchestrator/httpBot.ts`) and the provider (one implementation).
 *
 * ADOPTION SEQUENCING: nothing consumes this provider yet beyond registry
 * construction in `container.ts` — the create route, `placement.ts`,
 * `httpBot.ts`, `server.ts` mounting, `loadConfig`'s schema fold, and
 * `startBackground()` remain the live paths, sharing the implementations above.
 */
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { IntegrationCoreEnvelope, IntegrationSlackConfig } from '@agentconnect.md/protocol'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import type { SlackBotVerifier, SlackAppTokenVerifier } from '../../http/slack-identity.js'
import { configUsable, resolveUserConfigAccessToken, type SlackUserConfigDeps } from '../../http/slack-user-config.js'
import type { CpConfigValidation, CpInstallTransport, CpPlatformProvider } from '../provider.js'

/** The `slack` credential block of the `POST /integrations` create body —
 *  relocated from `http/dto/index.ts`, which imports it back (one
 *  implementation for the live route and the provider's
 *  {@link CpPlatformProvider.credentialBodySchema}). The bot token is always
 *  required; the transport-conditional requirements (socket ⇒ `appToken`,
 *  http ⇒ `signingSecret`) live in {@link refineSlackCreateBody}. */
export const SlackCreateCredentials = z.object({
  botToken: z.string().min(1),
  appToken: z.string().min(1).optional(),
  signingSecret: z.string().min(1).optional()
})
export type SlackCreateCredentials = z.infer<typeof SlackCreateCredentials>

/**
 * Transport-conditional credential requirements the flat schema cannot express
 * (§9 `refineCreateBody`) — the slack arm of the create DTO's `superRefine`,
 * extracted so `http/dto/index.ts` and the provider share ONE implementation:
 * Socket Mode needs the app-level xapp token; Events-API http mode needs the
 * signing secret the relay HMAC-verifies inbound POSTs with.
 */
export function refineSlackCreateBody(
  body: { credentials: SlackCreateCredentials; transport: CpInstallTransport },
  addIssue: (message: string) => void
): void {
  if (body.transport === 'http') {
    if (!body.credentials.signingSecret) addIssue('http transport requires slack.signingSecret')
  } else if (!body.credentials.appToken) {
    addIssue('socket transport requires slack.appToken')
  }
}

/** App-level tokens are structured `xapp-1-{APP_ID}-{epoch}-{hex}`. The id segment
 *  (A…) is public metadata (it appears in every app-page URL) — stored on the bot so
 *  the console can deep-link "manage / delete the app on Slack". An unexpected shape
 *  just leaves it null. Relocated from `http/install-slack.ts` (which re-exports it):
 *  the provider's `validateConfig` runs the same cross-app check as the create route,
 *  and importing it FROM the install tail would close a runtime import cycle
 *  (`install-slack.ts` → `placement.ts` → this module). */
export function slackAppIdFromAppToken(appToken: string): string | undefined {
  const seg = appToken.split('-')[2]
  return seg && /^A[A-Z0-9]+$/.test(seg) ? seg : undefined
}

/**
 * Env keys this provider owns (§9 `envSchema`) — spread into `AppConfigSchema`
 * by `config/env.ts` until `loadConfig` folds the registry's schemas (S3
 * adoption), so the live schema and the provider's declaration are ONE object.
 *
 *  - `SLACK_INSTALL_*` — the pending-install reaper knobs
 *    (slack-install-smoothing.md §Tier B): a `slack_install` pending row the
 *    operator never finishes (holding a client secret + bot token) is deleted
 *    once older than `SLACK_INSTALL_TTL_SEC`; the sweep runs every
 *    `SLACK_INSTALL_REAP_INTERVAL_SEC`. The platform-install rows share both.
 *  - `SLACK_PLATFORM_*` — the platform-published (distributed) Slack app
 *    (preset-agents.md §5.3), the deployment-level "Add to Slack" app. ALL
 *    FOUR must be set to enable the feature; any unset ⇒ absent (the
 *    self-hosted default: the console offers only the quick-install funnel).
 *    MUST stay `.optional()` so an image bump never fail-fasts an existing
 *    deploy. The all-or-none partial-set fail-fast lives in
 *    `config/slack-platform.ts` (`resolveSlackPlatformAppConfig`). The install
 *    path additionally hard-depends on core's `PUBLIC_CP_URL` (the OAuth
 *    callback origin) + `PUBLIC_RELAY_URL` + a connected relay
 *    (Events-API-only).
 */
export const SlackCpEnvSchema = {
  SLACK_INSTALL_TTL_SEC: z.coerce.number().int().default(3600),
  SLACK_INSTALL_REAP_INTERVAL_SEC: z.coerce.number().int().default(600),
  SLACK_PLATFORM_APP_ID: z.string().optional(), // A… — the distributed app's id
  SLACK_PLATFORM_CLIENT_ID: z.string().optional(),
  SLACK_PLATFORM_CLIENT_SECRET: z.string().optional(),
  SLACK_PLATFORM_SIGNING_SECRET: z.string().optional()
} satisfies ZodRawShape

/**
 * The §6.4 opaque `IntegrationSpec.config` payload for a DIRECT (socket) Slack
 * integration — the body of `integrationToSpec`'s slack arm
 * (`orchestrator/placement.ts`), extracted so the live placement path and the
 * provider's projector share ONE implementation. This daemon owns the Socket
 * Mode connection, so the app-level token rides along; a socket bot is
 * single-agent, so it is never shareable. The routing knobs are deliberately
 * DUPLICATED from the core envelope (§6.4 tolerant-reader window).
 * Token-bearing — NEVER log the result.
 */
export function slackIntegrationConfig(
  core: IntegrationCoreEnvelope,
  secret: Pick<BotSecretMaterial, 'botToken' | 'appToken'>
): IntegrationSlackConfig {
  return {
    mode: 'direct',
    shareable: false,
    botToken: secret.botToken,
    appToken: secret.appToken ?? '',
    bindRules: core.bindRules,
    mutedChannels: core.mutedChannels,
    gated: core.gated
  }
}

/**
 * The §6.4 payload for a SHARED (http/relay) Slack integration — the slack arm
 * of `httpIntegrationToSpec` (`orchestrator/placement.ts`), extracted for the
 * same one-implementation reason. Send-only: xoxb but NO appToken (credential
 * domaining — the daemon must not be able to subscribe the event stream).
 * `shareable` gates the daemon's in-thread "Switch agent" control;
 * `providerAppId` is the bot row's public Slack app id (the permission-update
 * deep link). Token-bearing — NEVER log.
 */
export function slackSharedIntegrationConfig(
  core: IntegrationCoreEnvelope,
  secret: Pick<BotSecretMaterial, 'botToken'>,
  shareable: boolean,
  providerAppId?: string
): IntegrationSlackConfig {
  return {
    mode: 'shared',
    shareable,
    botToken: secret.botToken,
    ...(providerAppId ? { appId: providerAppId } : {}),
    bindRules: core.bindRules,
    mutedChannels: core.mutedChannels,
    gated: core.gated
  }
}

/**
 * The two opaque `rc/bot-assign` bags for a Slack HTTP bot (§6.7) — the slack
 * fork of `buildAssign` (`orchestrator/httpBot.ts`), extracted so the live
 * frame assembly and the provider's {@link CpPlatformProvider.projectBotAssign}
 * share ONE implementation.
 *
 *  - ingress `apiAppId` — the "A…" app id (== the Events API envelope
 *    `api_app_id`), O(1) inbound demux. Absent on a manual-paste http bot (no
 *    xapp to parse); the relay verify-scans instead.
 *  - ingress `teamId` — workspace "T…", present only for a distributed
 *    (platform) app's install, where the composite (api_app_id, team_id) is
 *    the ONLY safe demux (all sibling installs share the app id AND the
 *    signing secret).
 *  - ingress `botUserId` — persisted at OAuth exchange; spares an auth.test
 *    round-trip.
 *  - secrets — the send token + the signing secret the relay HMAC-verifies
 *    inbound POSTs with (core's completeness gate requires it before an
 *    assign is built — `secretShape.httpAssignRequires`).
 *
 * Token-bearing — NEVER log the result.
 */
export function slackBotAssignBags(
  bot: Pick<BotRecord, 'slackAppId' | 'teamId' | 'botUserId'>,
  secret: Pick<BotSecretMaterial, 'botToken' | 'signingSecret'>
): { secrets: Record<string, unknown>; ingress: Record<string, unknown> } {
  return {
    secrets: { botToken: secret.botToken, signingSecret: secret.signingSecret ?? '' },
    ingress: {
      ...(bot.slackAppId ? { apiAppId: bot.slackAppId } : {}),
      ...(bot.teamId ? { teamId: bot.teamId } : {}),
      ...(bot.botUserId ? { botUserId: bot.botUserId } : {})
    }
  }
}

/** The provider's injected seams — the same functions/objects `container.ts`
 *  wires into the route deps and background lifecycle today, so the live paths
 *  and the provider share one implementation and tests stay offline by faking
 *  exactly these. Every slot is optional: a focused test composes only the
 *  facet it exercises, and member presence follows slot presence. */
export interface SlackCpProviderDeps {
  /** Live `auth.test` check (`http/slack-identity.ts`). Absent ⇒ no bot-token
   *  validation (the route's own fallback: name derivation is skipped and the
   *  create tail falls back to the agent name). */
  verifyBot?: SlackBotVerifier
  /** Live `apps.connections.open` app-level token check. Absent ⇒ no app-token
   *  validation (route parity). */
  verifyAppToken?: SlackAppTokenVerifier
  /**
   * The funnel's Fastify plugins per mount scope, injected PRE-BOUND to the
   * route deps (`slackInstallRoutes` / `slackPlatformInstallRoutes` /
   * `slackConfigRoutes` at `'org'`; `slackOauthCallbackRoutes` /
   * `slackPlatformCallbackRoutes` at `'public-callback'`). Injected rather
   * than imported: the route modules consume the create-DTO module, which
   * imports this provider's credential block — importing the factories here
   * would close a runtime import cycle. Each plugin self-disables when its
   * config is absent (contract §9). Absent ⇒ no funnel routes (focused tests).
   */
  funnelRoutes?: {
    org: FastifyPluginAsync[]
    publicCallback: FastifyPluginAsync[]
  }
  /** The per-user App Configuration token seam (`http/slack-user-config.ts`) —
   *  store + rotation API. `HttpDeps` is structurally assignable, so the
   *  composition root passes the same bundle the routes get. Absent ⇒ the
   *  platform reports no provider tooling credentials. */
  userConfigs?: SlackUserConfigDeps
  /** Pending-install funnel state (§9 `pendingInstalls`): the two stores'
   *  reap slices + the shared TTL/interval from this provider's env keys
   *  (`SLACK_INSTALL_TTL_SEC` / `SLACK_INSTALL_REAP_INTERVAL_SEC`, ms).
   *  Absent ⇒ no funnel state declared (focused tests). */
  pendingInstalls?: {
    installs: { reapExpired(staleBefore: Date): Promise<number> }
    platformInstalls: { reapExpired(staleBefore: Date): Promise<number> }
    ttlMs: number
    intervalMs: number
  }
  /** The bot-identity reconciler's lifecycle
   *  (`orchestrator/slackBotIdentityReconciler.ts`) — the SAME instance
   *  `startBackground()`/`shutdown` drive today. Absent ⇒ no background loop
   *  declared. */
  identityReconciler?: { start(): void; stop(): void }
}

export function createSlackCpProvider(deps: SlackCpProviderDeps): CpPlatformProvider<SlackCreateCredentials> {
  const { verifyBot, verifyAppToken, funnelRoutes, userConfigs, pendingInstalls, identityReconciler } = deps
  return {
    platformId: 'slack',

    // Both install funnels ride here (contract §9): org-scoped wizard + config
    // routes, and the two unauthenticated browser OAuth callbacks core mounts
    // twice (internal `/api/v1` + the public `/v1` alias — the double mount is
    // core's, not the provider's).
    installRoutes: (scope) => (scope === 'org' ? (funnelRoutes?.org ?? []) : (funnelRoutes?.publicCallback ?? [])),

    credentialBodySchema: SlackCreateCredentials,

    refineCreateBody: refineSlackCreateBody,

    /**
     * `auth.test` + (socket) the app-level token check + the same-app
     * cross-check — the live checks the create route runs before anything is
     * stored (`integrations.ts` slack arm), with the route's statuses and
     * user-facing copy verbatim (none carries a machine code today).
     * Reachability is best-effort by contract: an unreachable Slack refuses
     * NOTHING here (the route proceeds with no derived identity) — only a
     * definitive rejection blocks. The http-transport relay-availability check
     * is a 409 and stays core (contract §9: core knows the relay pool).
     */
    async validateConfig(credentials, transport): Promise<CpConfigValidation> {
      const botCheck = verifyBot ? await verifyBot(credentials.botToken) : null
      if (botCheck?.status === 'invalid') {
        return {
          ok: false,
          status: 400,
          message: 'Slack rejected the bot token — check you pasted the Bot User OAuth Token (xoxb-…).'
        }
      }
      if (transport === 'socket') {
        // Socket Mode: the app-level xapp token is required + validated against
        // Slack. `refineCreateBody` guarantees its presence for this transport.
        const appCheck = verifyAppToken ? await verifyAppToken(credentials.appToken!) : null
        if (appCheck === 'invalid') {
          return {
            ok: false,
            status: 400,
            message:
              'Slack rejected the app-level token — check you pasted the App-Level Token (xapp-…) and gave it the connections:write scope.'
          }
        }
        const appTokenAppId = slackAppIdFromAppToken(credentials.appToken!)
        if (botCheck?.status === 'ok' && botCheck.appId && appTokenAppId && botCheck.appId !== appTokenAppId) {
          return {
            ok: false,
            status: 400,
            message: 'The Slack bot token and app-level token belong to different apps.'
          }
        }
      }
      // `name` is the middle rung of the create tail's name ladder (operator →
      // auth.test-derived → owning agent); `externalAppId` is the "A…" app id
      // auth.test resolved; workspaceId/workspaceName are the display-only
      // tenant metadata the create tail persists (distinct from the DEMUX
      // `Bot.teamId`, which only the platform-app OAuth funnel writes).
      const identity =
        botCheck?.status === 'ok'
          ? {
              ...(botCheck.name ? { name: botCheck.name } : {}),
              ...(botCheck.appId ? { externalAppId: botCheck.appId } : {}),
              ...(botCheck.teamId ? { workspaceId: botCheck.teamId } : {}),
              ...(botCheck.teamName ? { workspaceName: botCheck.teamName } : {})
            }
          : {}
      return { ok: true, identity }
    },

    // Slack stores the literal tokens in the shared row (`install-slack.ts`):
    // the xapp (socket) / signing secret (http) stay CP-side for the relay —
    // the daemon never receives them. An http assign is gated on the signing
    // secret (`httpBot.ts`: an unverifiable Events API bot must not be placed).
    secretShape: {
      slots: {
        botToken: 'Slack bot user OAuth token (xoxb-…)',
        appToken: 'Slack app-level token (xapp-…; Socket Mode only)',
        signingSecret: 'Slack signing secret (Events API verification; http only)'
      },
      httpAssignRequires: ['signingSecret']
    },

    // The two pending-install funnels (§9): the config-token quick install
    // (`SlackInstall` — holds a client secret + bot token mid-funnel) and the
    // platform-app install (`SlackPlatformInstall` — OAuth state → tenancy, no
    // secrets). Core instantiates the ONE shared reaper class per declaration
    // (`orchestrator/slackInstallReaper.ts`); both share this provider's env
    // TTL knobs, exactly like today's two container instances.
    ...(pendingInstalls
      ? {
          pendingInstalls: [
            {
              model: 'SlackInstall',
              label: 'slack-install',
              store: pendingInstalls.installs,
              ttlMs: pendingInstalls.ttlMs,
              intervalMs: pendingInstalls.intervalMs
            },
            {
              model: 'SlackPlatformInstall',
              label: 'slack-platform-install',
              store: pendingInstalls.platformInstalls,
              ttlMs: pendingInstalls.ttlMs,
              intervalMs: pendingInstalls.intervalMs
            }
          ] as const
        }
      : {}),

    envSchema: SlackCpEnvSchema,

    // No install-time side effects: Slack renders per-message `icon_url` from
    // the public CP endpoint instead of a pushed bot avatar, so there is no
    // post-create push and no ongoing icon convergence member (contract §9 —
    // member presence is the capability probe in `http/agent-bot-icon-sync.ts`).

    // Per-user provider tooling credentials (§9): the caller's stored Slack
    // App Configuration token, resolved/rotated by the SAME functions the
    // funnel start and the Settings→Bots refresh call
    // (`http/slack-user-config.ts`).
    ...(userConfigs
      ? {
          providerToolingCredentials: {
            model: 'SlackUserConfig',
            resolveAccessToken: (orgId, userId, now) => resolveUserConfigAccessToken(userConfigs, orgId, userId, now),
            usableNow: async (orgId, userId, now) =>
              configUsable(await userConfigs.repos.slackUserConfig.get(orgId, userId), now)
          }
        }
      : {}),

    // The bot-identity reconciler (backfills app/workspace identity onto
    // pre-capture Bot rows from the stored token) — declared so
    // `startBackground()`/shutdown can drive it without naming platforms once
    // the registry is adopted; today's container lifecycle calls remain the
    // live path on the same instance.
    ...(identityReconciler
      ? {
          backgroundLoops: [
            {
              label: 'slack-bot-identity',
              start: () => identityReconciler.start(),
              stop: () => identityReconciler.stop()
            }
          ] as const
        }
      : {}),

    // §6.4 projection: `bot.transport` is the direct-vs-shared fork itself
    // (`integrations.ts`) — the same bodies the live `integrationToSpec` /
    // `httpIntegrationToSpec` slack arms call. Async by contract; Slack
    // maintains no additional secret store to load from. Token-bearing — NEVER log.
    async projectIntegrationConfig(integration, bot, core, secrets) {
      return bot.transport === 'http'
        ? slackSharedIntegrationConfig(core, secrets, bot.shareable, bot.slackAppId ?? undefined)
        : slackIntegrationConfig(core, secrets)
    },

    // §6.7 projection: same body as the live `buildAssign` slack fork (both
    // call {@link slackBotAssignBags}). Token-bearing — NEVER log.
    async projectBotAssign(bot, secrets) {
      return slackBotAssignBags(bot, secrets)
    }
  }
}
