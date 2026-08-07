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
 *    provider construction stays one-directional (a provider never reaches back
 *    for a route factory), which is what keeps the create route free to fold
 *    this provider's credential block into its body schema;
 *  - `providerToolingCredentials` → {@link createSlackToolingCredentials}, over
 *    `resolveUserConfigAccessToken` / `configUsable`
 *    (`http/slack-user-config.ts`). The composition root builds ONE facet and
 *    injects the same instance here AND into the routes that call back into it
 *    (the funnel start, the config status projection, the Settings→Bots
 *    refresh), so none of them can drift on which store answers;
 *  - the wire projections → {@link slackIntegrationConfig} /
 *    {@link slackSharedIntegrationConfig} / {@link slackBotAssignBags}, called
 *    by BOTH the live paths (`orchestrator/placement.ts`,
 *    `orchestrator/httpBot.ts`) and the provider (one implementation).
 *
 * ADOPTION SEQUENCING: core now reads this provider through the registry end to
 * end — `server.ts` mounts {@link CpPlatformProvider.installRoutes} at both
 * scopes, `POST /integrations` folds {@link SlackCreateCredentials} +
 * {@link refineSlackCreateBody} into its body and runs
 * {@link CpPlatformProvider.validateConfig} +
 * {@link CpPlatformProvider.buildNewBotInstall} as its tail, `config/env.ts`
 * folds {@link SlackCpEnvSchema}, the container's background lifecycle drives
 * the declared reapers and loops, and spec assembly (`placement.ts`) /
 * `rc/bot-assign` (`httpBot.ts`) await
 * {@link CpPlatformProvider.projectIntegrationConfig} /
 * {@link CpPlatformProvider.projectBotAssign}. The helpers below stay exported
 * as the ONE implementation both the projectors and the equivalence tests call.
 */
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { IntegrationSlackConfig } from '@agentconnect.md/protocol'
import type { BotRecord, BotSecretMaterial, SlackUserConfigStore } from '../../persistence/ports.js'
import type { SlackBotVerifier, SlackAppTokenVerifier } from '../../http/slack-identity.js'
import type { SlackConfigApi } from '../../http/slack-config-api.js'
import { checkSlackBotScopes } from '../../http/slack-manifest.js'
import { configUsable, resolveUserConfigAccessToken, type SlackUserConfigDeps } from '../../http/slack-user-config.js'
import type {
  CpConfigValidation,
  CpInstallTransport,
  CpPlatformProvider,
  CpProviderToolingCredentials
} from '../provider.js'

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
 * Env keys this provider owns (§9 `envSchema`) — folded into `AppConfigSchema`
 * through `platforms/env.ts`, so the live schema and the provider's declaration
 * are ONE object. (The fold reads the static declaration rather than the
 * registry: `loadConfig` necessarily runs before a provider, which is
 * constructed FROM the parsed config, can exist.)
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
 * single-agent, so it is never shareable. Platform-private material ONLY: the
 * routing knobs (and the ingress mode) ride the core ENVELOPE, never this
 * payload (§6.4 final shape). Token-bearing — NEVER log the result.
 */
export function slackIntegrationConfig(
  secret: Pick<BotSecretMaterial, 'botToken' | 'appToken'>
): IntegrationSlackConfig {
  return {
    shareable: false,
    botToken: secret.botToken,
    appToken: secret.appToken ?? ''
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
  secret: Pick<BotSecretMaterial, 'botToken'>,
  shareable: boolean,
  providerAppId?: string
): IntegrationSlackConfig {
  return {
    shareable,
    botToken: secret.botToken,
    ...(providerAppId ? { appId: providerAppId } : {})
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
 *  - ingress `workspaceId` — the workspace this bot belongs to, captured for
 *    EVERY bot kind (auth.test / OAuth). Not a demux index key: it is the
 *    relay's tenant FENCE (ingress-tenant-fence.md §3), which is why a
 *    quick-install bot — whose `teamId` is deliberately null — still needs it
 *    on the wire. Without it, a second organization holding the same app's
 *    signing secret verifies this bot's deliveries too.
 *  - ingress `botUserId` — persisted at OAuth exchange; spares an auth.test
 *    round-trip.
 *  - secrets — the send token + the signing secret the relay HMAC-verifies
 *    inbound POSTs with (core's completeness gate requires it before an
 *    assign is built — `secretShape.httpAssignRequires`).
 *
 * Token-bearing — NEVER log the result.
 */
/** The 409 copy when another organization already holds this app+workspace
 *  (ingress-tenant-fence.md §5). Deliberately never names the holder. Shared by
 *  the provider's create path and the two Slack funnels' tail. */
export const SLACK_WORKSPACE_CLAIMED_MESSAGE =
  'this Slack workspace is already connected to another organization with this app'

export function slackBotAssignBags(
  bot: Pick<BotRecord, 'slackAppId' | 'teamId' | 'workspaceId' | 'botUserId'>,
  secret: Pick<BotSecretMaterial, 'botToken' | 'signingSecret'>
): { secrets: Record<string, unknown>; ingress: Record<string, unknown> } {
  return {
    secrets: { botToken: secret.botToken, signingSecret: secret.signingSecret ?? '' },
    ingress: {
      ...(bot.slackAppId ? { apiAppId: bot.slackAppId } : {}),
      ...(bot.teamId ? { teamId: bot.teamId } : {}),
      ...(bot.workspaceId ? { workspaceId: bot.workspaceId } : {}),
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
  /** The §9 per-user provider tooling-credential facet, built once by the
   *  composition root with {@link createSlackToolingCredentials} and handed to
   *  BOTH this provider and the Slack routes that call back into it (the
   *  quick-install funnel start, the config status route, and the
   *  Settings→Bots manifest refresh). One instance, so "which store answers"
   *  cannot drift between the provider and its callers. Absent ⇒ the platform
   *  reports no provider tooling credentials. */
  toolingCredentials?: CpProviderToolingCredentials
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

/**
 * The §9 `providerToolingCredentials` facet over one `SlackUserConfig` store —
 * the SINGLE authority for "the caller's Slack App Configuration token" that
 * every flow now reads through: the provider itself, the quick-install funnel
 * start, the `GET|PUT /slack/config` status projection, and the Settings→Bots
 * manifest refresh. Both members delegate to the same
 * `http/slack-user-config.ts` bodies those flows used to call directly, so this
 * is a call-site swap, not a rewrite:
 *
 *  - `resolveAccessToken` → `resolveUserConfigAccessToken` (rotate-near-expiry
 *    + the spent-refresh reload retry);
 *  - `usableNow` → `configUsable` over a FRESH read of the same row. It answers
 *    only the credential question; deployment-level terms (the funnel's public
 *    callback origin, the relay pool) stay with the status route, which is what
 *    knows them.
 *
 * THE ARGUMENT IS EXPLICIT, NOT A BUNDLE, on purpose. `SlackUserConfigDeps` —
 * what `resolveUserConfigAccessToken` takes — declares `slackConfigApi` OPTIONAL,
 * so the route dep bundle satisfied it structurally, and kept satisfying it after
 * the §9 DI collapse deleted that member: the compiler stayed silent while every
 * production resolution silently became `unreachable`. Requiring a NAMED store
 * here makes that mistake unrepresentable — no bundle in this codebase has a
 * `store` member to donate — and forces the API client to be passed by name.
 */
export function createSlackToolingCredentials(seams: {
  /** Slack App-management + OAuth calls (the rotate). Absent ⇒ the funnel is off
   *  and every resolution is `unreachable`, which is the pre-existing meaning —
   *  but it must now be an explicit choice, not an omission. Read per call so a
   *  late-bound composition (the test harness) can swap it. */
  readonly configApi?: SlackConfigApi
  /** The `SlackUserConfig` store this facet is the sole authority over. */
  readonly store: SlackUserConfigStore
}): CpProviderToolingCredentials {
  const userConfigs: SlackUserConfigDeps = {
    get slackConfigApi() {
      return seams.configApi
    },
    repos: { slackUserConfig: seams.store }
  }
  return {
    model: 'SlackUserConfig',
    resolveAccessToken: (orgId, userId, now) => resolveUserConfigAccessToken(userConfigs, orgId, userId, now),
    usableNow: async (orgId, userId, now) => configUsable(await seams.store.get(orgId, userId), now)
  }
}

export function createSlackCpProvider(deps: SlackCpProviderDeps): CpPlatformProvider<SlackCreateCredentials> {
  const { verifyBot, verifyAppToken, funnelRoutes, toolingCredentials, pendingInstalls, identityReconciler } = deps
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
     * user-facing copy verbatim — plus, LAST, the same bot-scope fence the two
     * install funnels apply (#768): a workspace authorization that positively
     * granted fewer scopes than the manifest declares is refused on BOTH
     * transports, carrying `code: 'SLACK_MISSING_SCOPES'` (the one refusal
     * here with a machine code). Reachability is best-effort by contract: an
     * unreachable Slack refuses NOTHING here (the route proceeds with no
     * derived identity) — only a definitive rejection blocks, and an
     * unreported grant (`scopes: null`) is inconclusive, never short (see
     * `checkSlackBotScopes`). The http-transport relay-availability check is a
     * 409 and stays core (contract §9: core knows the relay pool).
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
      // The manual Bot-token wizard is the third install path the #768 scope
      // fences cover: Slack's authorization does not reliably apply every bot
      // permission the manifest declares, and a short grant installs SILENTLY —
      // the shortfall surfaces much later, as scoped calls answering
      // `missing_scope` and the session-access check failing closed. Refuse it
      // here — while the operator is one Reinstall away — naming the scopes,
      // for both transports. LAST of the checks, so a more specific credential
      // refusal (bad token, mismatched apps) still wins; an inconclusive check
      // never blocks (`checkSlackBotScopes`: an unreported grant is unknown,
      // not short). The reused-bot arm (`botId`) mints no new grant and stays
      // the Settings refresh's job.
      if (botCheck?.status === 'ok') {
        const grant = checkSlackBotScopes(botCheck.scopes)
        if (grant.status === 'short') {
          return {
            ok: false,
            status: 400,
            code: 'SLACK_MISSING_SCOPES',
            message: `Slack didn’t grant every permission this app needs. Reinstall it in your Slack workspace, then connect again. Missing: ${grant.missing.join(', ')}`
          }
        }
      }
      // `name` is the middle rung of the create tail's name ladder (operator →
      // auth.test-derived → owning agent); `externalAppId` is the "A…" app id
      // auth.test resolved; workspaceId/workspaceName are the display-only
      // tenant metadata the create tail persists (distinct from the DEMUX
      // `Bot.teamId`, which only the platform-app OAuth funnel writes). `botUserId`
      // is the public Slack member id used to render exact channel mentions.
      const identity =
        botCheck?.status === 'ok'
          ? {
              ...(botCheck.name ? { name: botCheck.name } : {}),
              ...(botCheck.appId ? { externalAppId: botCheck.appId } : {}),
              ...(botCheck.teamId ? { workspaceId: botCheck.teamId } : {}),
              ...(botCheck.teamName ? { workspaceName: botCheck.teamName } : {}),
              ...(botCheck.botUserId ? { botUserId: botCheck.botUserId } : {}),
              // The granted set `auth.test` reported for the pasted token, kept
              // on the bot row so capability reads (the session-access workspace
              // checker) don't have to re-probe Slack. Absent header ⇒ omitted.
              ...(botCheck.scopes && botCheck.scopes.length > 0 ? { grantedScopes: botCheck.scopes } : {})
            }
          : {}
      return { ok: true, identity }
    },

    /**
     * The create tail's platform half (§9) — the same bot columns + secret row
     * `installNewSlackBot` writes, which now shares core's one skeleton:
     *
     *  - `slackAppId` keeps the xapp DERIVATION as the authority when both are
     *    present (`validateConfig` has already refused a mismatched pair), and
     *    falls back to the "A…" id `auth.test` resolved;
     *  - `workspaceId` / `workspaceName` are the display-only tenant metadata
     *    (never `Bot.teamId`, which only the platform-app OAuth funnel writes);
     *  - `botUserId` is the public Slack member id that renders exact channel
     *    mentions (#601);
     *  - `shareable` is echoed back — Slack is the one platform with multi-agent
     *    bots — and core still coerces it off for a socket install.
     */
    buildNewBotInstall: ({ credentials, identity, shareable }) => {
      const slackAppId =
        (credentials.appToken ? slackAppIdFromAppToken(credentials.appToken) : undefined) ?? identity.externalAppId
      return {
        bot: {
          ...(slackAppId ? { slackAppId } : {}),
          ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
          ...(identity.workspaceName ? { workspaceName: identity.workspaceName } : {}),
          ...(identity.botUserId ? { botUserId: identity.botUserId } : {}),
          ...(identity.grantedScopes ? { grantedScopes: identity.grantedScopes } : {}),
          ...(shareable ? { shareable: true } : {})
        },
        // Workspace-claim admission fence (ingress-tenant-fence.md §5). This is
        // the arm the D6 `externalIdentity` pre-check deliberately leaves open:
        // a manual paste captures no `teamId`, so it declares no D6 identity —
        // but `auth.test` DOES resolve the workspace, and a second org pasting
        // the same app's credentials for it would produce two rows sharing one
        // signing secret AND one tenant, which the relay cannot disambiguate.
        ...(slackAppId && identity.workspaceId
          ? {
              workspaceClaim: {
                appId: slackAppId,
                tenantId: identity.workspaceId,
                conflictMessage: SLACK_WORKSPACE_CLAIMED_MESSAGE
              }
            }
          : {}),
        secrets: {
          botToken: credentials.botToken,
          appToken: credentials.appToken ?? null,
          signingSecret: credentials.signingSecret ?? null
        }
      }
    },

    /**
     * D6 identity (§11): Slack is TENANT-SCOPED, so the pair is
     * `(slackAppId, teamId)` — an install of a distributed app is identified by
     * the app AND the workspace, never the app alone.
     *
     * Each half is conditional and neither implies the other: a manual
     * single-workspace install pastes tokens without an OAuth exchange, so it
     * captures no `teamId` (and sometimes no app id either) and keeps NULLs.
     * Postgres holds those rows distinct, which is why Slack declares no
     * `externalIdentity` 409 pre-check — there is nothing to pre-check.
     */
    projectBotIdentity: (input) => ({
      ...(input.slackAppId ? { externalAppId: input.slackAppId } : {}),
      ...(input.teamId ? { externalTenantId: input.teamId } : {})
    }),

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
    // App Configuration token. The composition root builds ONE facet
    // ({@link createSlackToolingCredentials}) and injects the same instance
    // into the Slack routes that call back into it, so the funnel start, the
    // config status route and the Settings→Bots refresh cannot drift from what
    // the registry advertises.
    ...(toolingCredentials ? { providerToolingCredentials: toolingCredentials } : {}),

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
    async projectIntegrationConfig(integration, bot, _core, secrets) {
      return bot.transport === 'http'
        ? slackSharedIntegrationConfig(secrets, bot.shareable, bot.slackAppId ?? undefined)
        : slackIntegrationConfig(secrets)
    },

    // §6.7 projection: same body as the live `buildAssign` slack fork (both
    // call {@link slackBotAssignBags}). Token-bearing — NEVER log.
    async projectBotAssign(bot, secrets) {
      return slackBotAssignBags(bot, secrets)
    }
  }
}
