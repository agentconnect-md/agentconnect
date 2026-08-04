/**
 * The control plane's **behavioral platform-provider contract**
 * (integration-plugin-architecture.md §9, stage S3) — published FIRST, with
 * every implementation still in place. Same sequencing as the daemon's Layer-1
 * contract (#525) and the relay's two-sided ingress contract (#560): moving a
 * body while ALSO changing what it can reach is how a file move becomes a
 * silent contract redesign (§16), so the seam lands as types, and the four
 * platforms' funnels / projectors move against it in their own PRs.
 *
 * WHY BEHAVIORAL, NOT DECLARATIVE (§9). A descriptor cannot express what the
 * three existing install funnels contribute: Fastify route plugins at two
 * mount-scope classes (org-scoped and unauthenticated public callbacks — the
 * latter deliberately mounted twice, `http/server.ts:202-204` at the internal
 * `/api/v1` root and `:270-280` again at the public `/v1` alias), dedicated
 * pending-install Prisma models with `SecretCipher` stores and TTL reapers
 * (`container.ts:930-955`), env-config keys (`config/env.ts:32-33,114-124`),
 * live-credential validation against the provider's API, and wire projection
 * of decrypted secret material. Only the §5 manifest values a platform ALSO
 * carries (`multiAgentShareable`, `ingress`, `leaveGranularity`, `regions`,
 * `membershipEnumeration`, …) are declarative — those are manifest fields per
 * D2, NOT members here.
 *
 * THE INSTANCE MODEL. A provider is per-platform and constructed once at
 * `buildContainer` time from its env slice + its own API clients. The audit's
 * biggest CP blind spot (integration-plugin-audit.md Appendix C §5.1) is
 * "optional-dependency presence as the branch": twelve per-platform named dep
 * slots on core deps (`http/deps.ts:301-347` — `verifySlackBot`,
 * `verifyTelegramBot`, `syncDiscordBotProfile`, `configureFeishuHttpApp`, …)
 * wired positionally in `container.ts:844-856`, consumed via `if
 * (deps.syncTelegramBotIcon)`-style probes. Those slots dissolve into the
 * provider instances; core keeps ONE registry of providers and asks the
 * registry, never a named field. Test composition keeps its offline stubs by
 * constructing providers with stub clients — the injectability the named
 * slots existed for.
 *
 * WIRE PROJECTION IS TODAY'S WIRE, not the audit-era one. Since the §6.4
 * emission flip, `IntegrationSpec` is envelope-only — `core` routing knobs +
 * an opaque `config` the CONSUMING platform module validates
 * (`orchestrator/placement.ts:247-252`); since the §6.7 flip (#556), the
 * `rc/bot-assign` demux identity rides ONLY the opaque `ingress` bag
 * (`orchestrator/httpBot.ts:877-927`). The two projectors below are therefore
 * the ONLY code that turns persisted integration/bot rows plus decrypted
 * secrets into those opaque payloads; core still assembles the frames (it
 * holds the rows, the routing compile, and the fencing) and merely awaits.
 * Both projectors are ASYNC by contract: a provider owns loading from any
 * ADDITIONAL secret store it maintains (the Linear design keeps rotating
 * integration-scoped tokens in its own encrypted table), and core must await
 * uniformly rather than grow a per-platform preload branch. Secret material
 * is never persisted inside `platformConfig` JSON.
 *
 * WHAT STAYS CORE (§12 + the §9 consequences):
 *  - the common create skeleton — derived-visibility 404/403, the placement
 *    check, the daemon platform-capability gate, the mutation lease, and the
 *    best-effort `replicateUpsert` push (`http/routes/integrations.ts:197-268,
 *    99-115`; `http/daemon-platform-capability.ts:27`);
 *  - the relay-availability 409s for `transport: 'http'` (core knows the
 *    relay pool, `integrations.ts:552-558,662-668`) and the D6 external-
 *    identity uniqueness fence + tenant sentinel (`integrations.ts:584-592`);
 *  - the shared pending-install reaper CLASS (`orchestrator/
 *    slackInstallReaper.ts` — one clock-driven sweep, instantiated per
 *    declared funnel) and the shared `BotSecretStore` cipher boundary;
 *  - HTTP-bot route compilation, arbitration inputs, thread affinity, and
 *    credential-revision fencing (`orchestrator/httpBot.ts`);
 *  - cron/hook scheduling, the webhook ingress seam, webchat end-to-end, and
 *    the GitHub/GitLab services (Layer 2 per D5).
 *
 * DELIBERATELY ABSENT — adjacent per-platform services the design gives
 * "audit homes, not new slots" (§9, final consequence): the session-audience
 * resolvers (`http/slack-session-access.ts` / `http/feishu-session-access.ts`
 * are platform plugins to the session-VISIBILITY system, not to this slot),
 * viewer-identity composition (`http/viewer-identity.ts:50-57` — per-platform
 * key arity), the external-scope realm key, and preset default-binding (a
 * documented core→plugin reference). Wiring those through this interface
 * would couple two independent seams.
 */
import type { FastifyPluginAsync } from 'fastify'
import type { ZodRawShape, ZodType } from 'zod'
import type { IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import type { BotRecord, BotSecretMaterial, IntegrationRecord } from '../persistence/ports.js'
import type { BotProfileIconAgent } from '../http/bot-profile-icon.js'
import type { OrgId } from '../domain/ids.js'

/** Inbound transport chosen at install time. Same value set as the persisted
 *  `SlackTransport` enum — historically Slack-branded, platform-generic in
 *  practice (Feishu rows use it too; a rename is blocked by a destructive
 *  PostgreSQL enum migration, audit Appendix C §5.7). */
export type CpInstallTransport = 'socket' | 'http'

/** The two route mount scopes `http/server.ts` drives (§9):
 *  - `'org'` — behind humanAuth + the org guard under `/orgs/:orgId`
 *    (`server.ts:232-235`: today's `feishuRegistrationRoutes`,
 *    `slackInstallRoutes`, `slackPlatformInstallRoutes`, `slackConfigRoutes`);
 *  - `'public-callback'` — unauthenticated at the version root, for browser
 *    redirects whose state rides the OAuth exchange (`server.ts:202-204`:
 *    `slackOauthCallbackRoutes`, `slackPlatformCallbackRoutes`). Core mounts
 *    this scope TWICE — internal `/api/v1` and the public `/v1` alias
 *    (`server.ts:270-280`) — because handed-out callback URLs leave the
 *    system in the public form; the double mount is core's, not the
 *    provider's. */
export type CpRouteScope = 'org' | 'public-callback'

/**
 * Product of {@link CpPlatformProvider.validateConfig} — the identity a LIVE
 * credential check derived, in exactly the fields the create tail persists:
 *
 *  - `name` — provider-derived bot name, the middle rung of the name ladder
 *    (operator-typed → derived → owning agent's name; Slack `auth.test`
 *    `integrations.ts:673`, Telegram `getMe` `:434`, Discord `users/@me`
 *    `:503`, Feishu `bot/v3/info` `:594`).
 *  - `externalAppId` — the provider app id (Slack "A…" from `auth.test`
 *    `:680`; Discord's decoded from the token `:505`; Feishu's is the pasted
 *    `cli_…` input echoed back). Core persists it on the Bot row and runs the
 *    D6 uniqueness fence on it (`:584-592`).
 *  - `workspaceId` / `workspaceName` — display-only tenant metadata (Slack
 *    `teamId`/`teamName`, `:681-682`); distinct from the DEMUX `Bot.teamId`,
 *    which only the platform-app OAuth funnel persists.
 *  - `botUserId` — the bot's own platform user id where the check resolves it
 *    (Feishu `openId`, `:605` — HTTP ingress needs it for @-mention demux).
 */
export interface CpValidatedIdentity {
  name?: string
  externalAppId?: string
  workspaceId?: string
  workspaceName?: string
  botUserId?: string
}

/**
 * Refusal from {@link CpPlatformProvider.validateConfig}: the HTTP status +
 * user-facing copy the create route sends verbatim. The audited refusals are
 * 400 (definitive credential rejection, Telegram Privacy Mode still on,
 * Discord intent setup rejected, Slack token pair from different apps —
 * `integrations.ts:408-415,424-432,479-487,652-659`) and 503 (provider
 * unreachable = inconclusive, never proof the token is bad —
 * `:416-423,488-496,573-580`). 409s stay core (relay availability, D6
 * identity taken, bot-reuse conflicts). `code` is the stable machine-readable
 * error the console switches copy on where one exists today
 * (`TELEGRAM_PRIVACY_MODE_ENABLED`,
 * `DISCORD_MESSAGE_CONTENT_INTENT_SETUP_FAILED`, …).
 */
export interface CpConfigRefusal {
  ok: false
  status: 400 | 503
  code?: string
  message: string
}

export type CpConfigValidation = { ok: true; identity: CpValidatedIdentity } | CpConfigRefusal

/**
 * How this platform packs the shared two-slot `bot_secret` row (+ optional
 * callback slots). The audit found the overloading spelled only in comments —
 * Feishu stores `botToken` = app SECRET and `appToken` = app ID
 * (`http/install-feishu.ts:80-88`), Slack stores the literal bot/app tokens +
 * signing secret (`http/install-slack.ts:102-109`), Telegram/Discord use
 * `botToken` alone — so the declaration makes it data.
 */
export interface CpSecretShape {
  /** Slot → what this platform stores there (human-readable; label-grade for
   *  a future generic credentials card). Values are NEVER echoed. */
  slots: Readonly<Partial<Record<keyof BotSecretMaterial, string>>>
  /** Slots that must be non-empty before an `rc/bot-assign` can be built —
   *  core's completeness gate before it calls {@link
   *  CpPlatformProvider.projectBotAssign} (today's per-platform guards at
   *  `orchestrator/httpBot.ts:134-142` and the replay path `:308-309`:
   *  Slack ⇒ `signingSecret`, Feishu ⇒ `verificationToken` + `appToken`). */
  httpAssignRequires: readonly (keyof BotSecretMaterial)[]
}

/**
 * One pending-install funnel's durable state + its sweep parameters.
 * Install-state tables stay PER-PLATFORM (§11 — a generic table is a §15
 * consolidation, not a prerequisite), so the provider declares each model it
 * owns and core instantiates the ONE shared reaper class per declaration —
 * exactly today's three instances with three labels and two TTL sources
 * (`container.ts:930-955`; TTLs from the provider's own env keys,
 * `config/env.ts:32-33`, or a funnel-appropriate constant like the Feishu
 * registration's 10 minutes).
 */
export interface CpPendingInstallDecl {
  /** Prisma model holding the funnel state (`SlackInstall`,
   *  `SlackPlatformInstall`, `FeishuAppRegistration`). Documentation-grade
   *  identity; core never queries by this name. */
  model: string
  /** Reaper diagnostic label (`'slack-install'`, `'slack-platform-install'`,
   *  `'feishu-registration'` — `orchestrator/slackInstallReaper.ts:45`). */
  label: string
  /** The narrow store slice the shared reaper drives
   *  (`slackInstallReaper.ts:19-21`). */
  store: { reapExpired(staleBefore: Date): Promise<number> }
  /** A pending row older than this is deleted (bounds how long funnel-held
   *  secret material can linger). */
  ttlMs: number
  intervalMs: number
}

/** Resolution of a per-user provider tooling credential — mirrors today's
 *  `UserConfigResolution` (`http/slack-user-config.ts:31-34`) exactly. */
export type CpToolingTokenResolution =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'not_configured' | 'expired' | 'rotate_failed' | 'unreachable' }

/**
 * Per-USER provider tooling credentials (§9 `providerToolingCredentials`) —
 * the pattern any platform with programmatic app-minting will reproduce, today
 * realized by Slack's App Configuration token (`SlackUserConfig`). The store,
 * entry/rotation/status routes ride {@link CpPlatformProvider.installRoutes}
 * (`'org'` scope); this facet is the piece OTHER flows call back into: the
 * quick-install funnel start and the Settings→Bots manifest-refresh flow
 * (`http/routes/bots.ts:151-233`, which also carries the provider console
 * deep links — `slackAppLinks`, `bots.ts:69-87` — into the refresh DTO; both
 * migrate into the provider with this facet).
 */
export interface CpProviderToolingCredentials {
  /** Prisma model holding the per-user credential (`SlackUserConfig`). */
  model: string
  /** Resolve a usable ACCESS token for `(orgId, userId)`, rotating a stored
   *  refresh token when the access token is near expiry — today's
   *  `resolveUserConfigAccessToken` (`http/slack-user-config.ts:47-74`),
   *  including its spent-refresh reload retry. */
  resolveAccessToken(orgId: OrgId, userId: string, now: Date): Promise<CpToolingTokenResolution>
  /** Whether the stored credential can start an install RIGHT NOW — the
   *  status signal that switches the web wizard between the automatic funnel
   *  and the manual manifest path (today's `configUsable`,
   *  `http/slack-user-config.ts:43-45`, surfaced by the config status
   *  route). */
  usableNow(orgId: OrgId, userId: string, now: Date): Promise<boolean>
}

/** A provider-owned background convergence loop, armed by the container's
 *  `startBackground()` and stopped on shutdown — never in tests. Today:
 *  Slack's bot-identity reconciler (`orchestrator/
 *  slackBotIdentityReconciler.ts`, wired at `container.ts:995`), which
 *  backfills app/workspace identity onto pre-capture Bot rows from the stored
 *  token; its platform-keyed repo query moves with it. */
export interface CpBackgroundLoop {
  label: string
  start(): void
  stop(): void
}

/**
 * Install-time side effects the create tail runs AFTER the rows exist — all
 * best-effort and cosmetic by contract: a failure is logged and the install
 * survives (`integrations.ts:453-460,526-535`). Pre-store provider calls are
 * NOT here — they belong to {@link CpPlatformProvider.validateConfig}, which
 * owns every provider round-trip that must precede persistence (token
 * verification AND Discord's Message-Content intent enablement,
 * `integrations.ts:478-496` — the intent flip happens before anything is
 * stored, so modeling it post-create would reorder observable behavior).
 */
export interface CpInstallSideEffects {
  /** Post-create push of the owning agent's identity to the provider (the
   *  Telegram avatar push `integrations.ts:453-460`; the Discord
   *  profile/avatar push `:526-535`). */
  postCreate?(input: {
    integration: IntegrationRecord
    bot: BotRecord
    secrets: BotSecretMaterial
    agent: BotProfileIconAgent
  }): Promise<void>
  /** Ongoing agent-icon convergence: push a CHANGED agent icon to this
   *  platform's dedicated bot. Presence of the member is the capability —
   *  today's three-way `supported` test + per-platform dispatch chain in
   *  `http/agent-bot-icon-sync.ts:57-61,99-115` (Slack has no member here:
   *  it renders per-message `icon_url` from the public CP endpoint instead).
   *  Feishu resolves its app id from `secrets.appToken ?? bot.feishuAppId`
   *  inside (`:106`). */
  syncBotProfileIcon?(bot: BotRecord, secrets: BotSecretMaterial, agent: BotProfileIconAgent): Promise<void>
}

/**
 * One platform's control-plane provider. Stateless per-request; constructed
 * once at `buildContainer` time with its env slice and API clients.
 *
 * @typeParam TCredentials The provider's OWN parsed credential-body type —
 *   the output of {@link credentialBodySchema}, flowing into
 *   {@link validateConfig} and the provider's create tail. Opaque to core,
 *   exactly like the relay contract's `TVerified`.
 */
export interface CpPlatformProvider<TCredentials = unknown> {
  /** Platform id (§6.1 vocabulary). Never parsed. The registry keyed on this
   *  becomes the single platform-set authority (S3 exit criterion), replacing
   *  the audit's six hand-copied closed unions (`http/dto/index.ts:713,1809,
   *  2040`, `orchestrator/httpBot.ts:57`,
   *  `http/daemon-platform-capability.ts:13`, `http/mcp/tools.ts:365`). */
  readonly platformId: string

  /**
   * Route plugins for one mount scope; empty array ⇒ nothing at that scope
   * (Telegram and Discord have no funnel routes — their whole install is the
   * create-DTO path). Each plugin closes over the provider's own deps, may
   * self-disable when its config is absent (the platform-app funnel returns
   * early without `SLACK_PLATFORM_*` + `PUBLIC_CP_URL`, so "the routes 404"
   * is the feature flag — audit Appendix C §5.2), and follows the repo
   * OpenAPI conventions (`tags`, `summary`, `description`, unique
   * `operationId`) — `/docs` renders every contributed route.
   */
  installRoutes(scope: CpRouteScope): FastifyPluginAsync[]

  /**
   * This platform's credential block of the `POST /integrations` create body.
   * Core composes the blocks into the route schema at `buildContainer` time —
   * replacing the four hand-written sub-schemas of `http/dto/index.ts:
   * 727-759` — so `/docs` and `openapi.json` stay accurate per registered
   * platform. The generic cross-block rules stay core: exactly-one-of
   * `botId`/credentials, and the mismatched-block guard, which becomes a loop
   * over registry ids (`dto/index.ts:761-786`).
   */
  credentialBodySchema: ZodType<TCredentials>

  /**
   * Transport-conditional credential requirements the flat schema cannot
   * express — today's per-platform `superRefine` arms (`http/dto/index.ts:
   * 788-800`: Slack http ⇒ `signingSecret`, socket ⇒ `appToken`; Feishu http
   * ⇒ `verificationToken`). Runs only when this platform's block is present.
   */
  refineCreateBody?(
    body: { credentials: TCredentials; transport: CpInstallTransport },
    addIssue: (message: string) => void
  ): void

  /**
   * LIVE credential validation — every provider API round-trip that must
   * precede persistence, so a stale/wrong/swapped credential fails the
   * request instead of minting an integration whose transport never opens:
   * Slack `auth.test` + app-token check + same-app cross-check
   * (`integrations.ts:633-659`), Telegram `getMe` + the Privacy-Mode gate
   * (`:407-432`), Discord `users/@me` + Message-Content intent enablement
   * (`:469-496`), Feishu tenant-access-token exchange + the http-transport
   * `openId` resolution (`:559-580`). Reachability stays best-effort by
   * contract: only a DEFINITIVE rejection may refuse with 400; a network blip
   * is 503, never proof the credential is bad.
   */
  validateConfig(credentials: TCredentials, transport: CpInstallTransport): Promise<CpConfigValidation>

  /** How this platform packs the shared secret row + which slots gate an
   *  http assign. See {@link CpSecretShape}. */
  secretShape: CpSecretShape

  /** Pending-install funnel state models + their TTL reapers. Absent ⇒ the
   *  platform has no funnel (Telegram/Discord). */
  pendingInstalls?: readonly CpPendingInstallDecl[]

  /**
   * Env keys this provider owns, folded into `AppConfigSchema` at
   * `loadConfig` time — today's platform-named residents of the core schema
   * (`config/env.ts:114-117` `SLACK_PLATFORM_*`, `:121-124`
   * `FEISHU/LARK_PLATFORM_*`, `:32-33` the install-reaper knobs). Resolution
   * into typed config — including the all-or-none partial-set fail-fast of
   * `config/slack-platform.ts:34-55` / `config/feishu-platform.ts:18-34` —
   * happens inside the provider's factory, not through a core member: core
   * consumes only the schema shape.
   */
  envSchema?: ZodRawShape

  /** Best-effort install-time and ongoing profile side effects. */
  sideEffects?: CpInstallSideEffects

  /** Per-user provider tooling credentials (Slack's App Configuration token
   *  today). Absent ⇒ the platform mints nothing programmatically. */
  providerToolingCredentials?: CpProviderToolingCredentials

  /** Provider-owned background convergence loops (the Slack bot-identity
   *  reconciler today). Registered via the provider so `startBackground()` /
   *  shutdown drive them without naming platforms. */
  backgroundLoops?: readonly CpBackgroundLoop[]

  /**
   * Project one integration into the opaque `IntegrationSpec.config` payload
   * (§6.4) — today's per-platform arms of `integrationToSpec` /
   * `httpIntegrationToSpec` (`orchestrator/placement.ts:253-291,325-350`),
   * relocated behind the provider. Core keeps assembling the envelope
   * (`integrationId`/`agentId`/`platform`/`core`) — it owns the routing
   * compile that produces `core` — and passes that envelope IN so the config
   * can keep carrying the duplicated routing knobs today's daemon readers
   * take from it. The BOT row is a required input even though the direct-mode
   * call sites don't load it yet: the shared-mode fields ride it
   * (`shareable`, the provider app id, `botUserId` —
   * `orchestrator/httpBot.ts:844-873`) and `bot.transport` is the
   * direct-vs-shared fork itself (`integrations.ts:317`). Shape validation of
   * the produced payload lives in the same platform's DAEMON module (§6.4
   * tolerant-reader rule), not here. Token-bearing — NEVER log.
   */
  projectIntegrationConfig(
    integration: IntegrationRecord,
    bot: BotRecord,
    core: IntegrationCoreEnvelope,
    secrets: BotSecretMaterial
  ): Promise<unknown>

  /**
   * Project one HTTP bot's credentials + demux identity into the two opaque
   * bags of `rc/bot-assign` (§6.7) — today's per-platform forks inside
   * `buildAssign` (`orchestrator/httpBot.ts:897-905` the ingress bag:
   * Feishu's app id from `secret.appToken` vs Slack's `bot.slackAppId`, the
   * distributed-install `teamId`, `botUserId`; `:909-915` the secrets bag:
   * Feishu `verificationToken`/`encryptKey` vs Slack
   * `botToken`/`signingSecret`). Everything else on the frame stays core-
   * assembled: the compiled routing table, member directory, gating fences,
   * and `credentialRevision` (`:877-927`) — and the four-way platform ternary
   * at `:820-828` disappears entirely under an open `PlatformId` (audit
   * ambiguous row 6). Returned as `Record<string, unknown>` (not `unknown`)
   * so the product assigns to the frame's open-reader members
   * (`RcBotSecrets`' record arm / `ingress: z.unknown()`) without a cast;
   * the RELAY platform module validates the shapes (§6.7). Token-bearing —
   * NEVER log.
   */
  projectBotAssign(
    bot: BotRecord,
    secrets: BotSecretMaterial
  ): Promise<{ secrets: Record<string, unknown>; ingress: Record<string, unknown> }>
}

/**
 * The registry shape core composes at `buildContainer` time — one instance,
 * threaded to the create route, the spec/assign assembly, `loadConfig`'s
 * schema fold, and `startBackground()`. Adding a platform registers one
 * provider here; no core file grows a platform branch. Deliberately an
 * interface (the S2/S3 seam-first precedent): the concrete registry lands
 * with the first provider move, not with the contract.
 */
export interface CpPlatformRegistry {
  get(platformId: string): CpPlatformProvider | undefined
  all(): readonly CpPlatformProvider[]
  /** The single platform-id authority (S3 exit criterion). */
  ids(): readonly string[]
}
