/**
 * The per-platform seams the PROVIDER-CONTRIBUTED route plugins are constructed
 * with (integration-plugin-architecture.md §9) — what used to be twelve
 * platform-named fields on the core dep bundle (`http/deps.ts`:
 * `verifySlackBot`, `slackConfigApi`, `verifyTelegramBot`,
 * `syncTelegramBotIcon`, `verifyDiscordBot`,
 * `ensureDiscordMessageContentIntent`, `syncDiscordBotProfile`,
 * `verifyFeishuBot`, `configureFeishuHttpApp`, `syncFeishuAppIcon`,
 * `feishuAppRegistration`, `verifySlackAppToken`, plus `slackPlatformApp`).
 *
 * WHY THEY MOVED. The CP's worst platform-branch shape was
 * "optional-dependency presence as the branch": core code
 * probing `if (deps.syncTelegramBotIcon)` to decide what a platform can do. Those
 * probes are gone — the registry answers now (`provider.sideEffects
 * ?.syncBotProfileIcon`, `provider.providerToolingCredentials`,
 * `provider.secretShape`). What remains is pure INJECTION: a Slack route needs a
 * Slack API client, and it must be swappable so suites stay offline. That is not
 * a core concern, so it is not on core deps; each funnel-route factory takes its
 * platform's seams as a second argument, and the composition root builds the
 * seams, the routes and the provider from the SAME values.
 *
 * Every member stays optional exactly where the old dep slot was optional, and
 * absence keeps meaning what it meant then (no verifier ⇒ inconclusive, never a
 * refusal; no config API ⇒ the funnel routes never register and the console
 * falls back to the manual manifest flow).
 */
import type { SlackConfigApi } from './slack-config-api.js'
import type { SlackBotVerifier, SlackAppTokenVerifier } from './slack-identity.js'
import type { SlackPlatformAppConfig } from '../config/slack-platform.js'
import type { TelegramBotVerifier } from './telegram-identity.js'
import type { FeishuAppTenantGuard, FeishuBotVerifier } from './feishu-identity.js'
import type { FeishuHttpAppConfigurator } from './feishu-app-config.js'
import type { FeishuAppRegistrationService } from './feishu-registration.js'
import type { LinearPlatformAppConfig } from '../config/linear-platform.js'
import type { LinearApiClient } from '../platforms/linear/api.js'
import type { LinearTokenService } from '../platforms/linear/token-service.js'
import type { CpProviderToolingCredentials } from '../platforms/provider.js'

/** Seams for the Slack route plugins: the two install funnels, the config-token
 *  routes, and the Settings→Bots manifest refresh. */
export interface SlackRouteSeams {
  /** Slack App-management + OAuth calls for the config-token auto-install funnel
   *  and the manifest refresh (§Tier B). Absent (with `PUBLIC_CP_URL`) ⇒ the
   *  funnel routes 404 and the console falls back to the manual manifest flow. */
  configApi?: SlackConfigApi
  /** Validates a bot token against `auth.test` (and derives name / app id /
   *  workspace from it). Absent ⇒ no validation. */
  verifyBot?: SlackBotVerifier
  /** Validates an app-level token against `apps.connections.open`. Absent ⇒ no
   *  app-token validation. */
  verifyAppToken?: SlackAppTokenVerifier
  /** Platform-published (distributed) Slack app credentials (preset-agents.md
   *  §5.3); absent ⇒ `SLACK_PLATFORM_*` unset, the platform-install routes 404
   *  and the console hides "Add to Slack". Secret material — NEVER log or DTO. */
  platformApp?: SlackPlatformAppConfig
  /** The §9 per-user tooling-credential facet — the SAME instance the provider
   *  advertises as `providerToolingCredentials`, so the funnel start, the config
   *  status route and the manifest refresh all read the one store the registry
   *  vouches for. Absent ⇒ no stored-credential path (focused tests). */
  toolingCredentials?: CpProviderToolingCredentials
}

/** Seams for the Linear connect funnel and its unauthenticated OAuth callback
 *  (linear-integration.md §7.1). */
export interface LinearRouteSeams {
  /** The deployment's one Linear OAuth app; absent ⇒ `LINEAR_PLATFORM_*` unset, the funnel routes
   *  404 and the console hides "Connect Linear". Secret material — NEVER log or DTO. */
  app?: LinearPlatformAppConfig
  /** Linear's OAuth/GraphQL surface over injectable endpoints, so a suite runs the whole install
   *  against a stubbed Linear. Only the authorize-URL builder is used from a route. */
  api: LinearApiClient
  /** The SAME token-custody instance the provider advertises, so the callback's step-1 write and
   *  the disconnect edge's revoke cannot drift on which store answers. */
  tokens: LinearTokenService
}

/** Seams for the Telegram route plugin (the credential-probe route). */
export interface TelegramRouteSeams {
  /** Validates a pasted token, derives its bot name, and reports whether Group
   *  Privacy Mode is disabled. */
  verifyBot: TelegramBotVerifier
}

/** Seams for the Feishu/Lark one-click registration route plugin. */
export interface FeishuRouteSeams {
  /** Validates an appId + appSecret pair via the tenant-access-token exchange.
   *  Absent ⇒ no validation. */
  verifyBot?: FeishuBotVerifier
  /** Enforces that newly-created Apps share the configured Login App's tenant. */
  tenantGuard: FeishuAppTenantGuard
  /** Applies the sensitive delivery URL and verification keys the official
   *  one-click deeplink intentionally cannot carry. */
  configureHttpApp: FeishuHttpAppConfigurator
  /** Owns the short-lived official device-registration poll. */
  registrations: FeishuAppRegistrationService
}
