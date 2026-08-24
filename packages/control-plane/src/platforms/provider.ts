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
 * `buildContainer` time from its env slice + its own API clients. The CP's
 * worst platform-branch shape was
 * "optional-dependency presence as the branch": twelve per-platform named dep
 * slots on core deps (`verifySlackBot`, `verifyTelegramBot`,
 * `syncDiscordBotProfile`, `configureFeishuHttpApp`, …) wired positionally in
 * `container.ts`, consumed via `if (deps.syncTelegramBotIcon)`-style probes.
 * Those slots are GONE. They conflated two things: the CAPABILITY question,
 * which core now asks this registry (`sideEffects.syncBotProfileIcon`,
 * `providerToolingCredentials`, `secretShape`, `projectBotAssign`) and never a
 * named field; and INJECTION, which is not a core concern at all — each
 * platform's route factories take their own seams as a second argument
 * (`http/platform-route-seams.ts`), and the composition root builds the seams,
 * the routes and the provider from the SAME values. Test composition keeps its
 * offline stubs by constructing providers and seams with stub clients — the
 * injectability the named slots existed for — read THROUGH a mutable bag so a
 * stub swapped after the app is built is still observed.
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
 * viewer-identity composition (owned by each Session-access plugin), the
 * external-scope realm key, and preset default-binding (a
 * documented core→plugin reference). Wiring those through this interface
 * would couple two independent seams.
 */
import type { FastifyPluginAsync } from 'fastify'
import type { ZodRawShape, ZodType } from 'zod'
import type { IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import type {
  BotIdentityColumns,
  BotRecord,
  BotSecretMaterial,
  CreateBotInput,
  CreateIntegrationInput,
  IntegrationRecord
} from '../persistence/ports.js'
import type { BotProfileIconAgent } from '../http/bot-profile-icon.js'
import type { OrgId } from '../domain/ids.js'

/** Inbound transport chosen at install time. Same value set as the persisted
 *  `SlackTransport` enum — historically Slack-branded, platform-generic in
 *  practice (Feishu rows use it too; a rename is blocked by a destructive
 *  PostgreSQL enum migration, audit Appendix C §5.7). */
export type CpInstallTransport = 'socket' | 'http'

/** The two route mount scopes `http/server.ts` drives (§9):
 *  - `'org'` — behind humanAuth + the org guard under `/api/v1/orgs/:orgId`
 *    (today's `slackInstallRoutes`, `slackPlatformInstallRoutes`,
 *    `slackConfigRoutes`, `feishuRegistrationRoutes`);
 *  - `'public-callback'` — unauthenticated at the version root, for browser
 *    redirects whose state rides the OAuth exchange (today's
 *    `slackOauthCallbackRoutes`, `slackPlatformCallbackRoutes`). Core mounts
 *    this scope TWICE — internal `/api/v1` and the public `/v1` alias —
 *    because handed-out callback URLs leave the system in the public form; the
 *    double mount is core's, not the provider's.
 *
 *  The resulting table is pinned path-by-path in
 *  `http/platform-route-mounts.test.ts`: these URLs are external contracts. */
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
  /** Bot scopes the platform REPORTED as granted for the validated credential
   *  (Slack: `auth.test`'s `x-oauth-scopes`). Omitted when the platform did not
   *  report one — absence is "unknown", never a short grant. */
  grantedScopes?: string[]
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
 * The PLATFORM-SPECIFIC half of "register a new bot from pasted credentials" —
 * everything core's one shared create tail (`http/install-bot.ts`) cannot know:
 * which `bot` / `integration` columns this platform fills, how it packs the
 * shared secret row, and whether it has a D6 external-identity to fence.
 *
 * The SKELETON around it stays core (§9): the id mint, the row writes in order,
 * the socket `integration/upsert` vs http `syncBot` fork, and the shareable
 * coercion. Before this existed, `http/routes/integrations.ts` carried four
 * `req.body.platform === …` tails that each cast the opaque credential block
 * back to a per-platform type — the last create-path platform branch in core.
 */
export interface CpNewBotInstall {
  /** Platform-specific columns of the new `bot` row. Core owns `id`, `orgId`,
   *  `platform`, `name`, `transport`, `prebuilt` and `createdByUserId`;
   *  `shareable` is honored only by a platform that declares it here AND only
   *  on the http transport (core coerces it off for socket at the single
   *  bot-create seam). */
  bot?: Readonly<
    Partial<
      Pick<
        CreateBotInput,
        | 'slackAppId'
        | 'teamId'
        | 'workspaceId'
        | 'workspaceName'
        | 'botUserId'
        | 'discordAppId'
        | 'feishuAppId'
        | 'feishuRegion'
        | 'shareable'
        | 'grantedScopes'
      >
    >
  >
  /** Platform-specific columns of the `integration` row (today: the Feishu
   *  gateway region, carried so a freed bot reinstalls against it). */
  integration?: Readonly<Partial<Pick<CreateIntegrationInput, 'feishuRegion'>>>
  /** The shared two-slot `bot_secret` row as this platform packs it — see
   *  {@link CpSecretShape}. Token-bearing; NEVER log. */
  secrets: BotSecretMaterial
  /**
   * The D6 external-identity this install claims, when the platform has one.
   * Core runs BOTH halves of the fence with it — the pre-check that turns the
   * common case into a clean 409, and the `BotExternalIdentityTaken` race
   * backstop from the composite unique — so the query and the copy stay one
   * declaration (`integrations.ts`' feishu arm before adoption). Pass the `'-'`
   * sentinel as `externalTenantId` on a tenantless platform, exactly as
   * `BotRepo.getByExternalIdentity` documents.
   */
  externalIdentity?: {
    externalAppId: string
    externalTenantId: string
    /** The 409 body's user-facing copy — platform-named reuse guidance. */
    conflictMessage: string
  }
  /**
   * The WORKSPACE this install claims, when the platform captured one
   * (ingress-tenant-fence.md §5). Core refuses the create when a DIFFERENT
   * organization already holds a bot for the same `(appId, tenantId)`: those
   * two rows would share one inbound-verification secret AND one tenant, which
   * the relay's delivery-time fence cannot tell apart, so pool order would
   * decide attribution.
   *
   * DISTINCT from {@link CpNewBotInstall.externalIdentity}: that one fences the
   * D6 composite unique and stays NULL wherever a platform preserves
   * pre-capture semantics (Slack's manual paste captures no `teamId`). This one
   * asks a narrower question — "is this workspace already spoken for?" — off
   * the identity the platform *did* capture, which is exactly the case the
   * D6 fence leaves open. Absent ⇒ no claim to check (identity unknown, e.g.
   * `auth.test` was unavailable), which is the §3.3 fail-open arm.
   */
  workspaceClaim?: {
    appId: string
    tenantId: string
    /** The 409 body's copy. MUST NOT name the holding organization. */
    conflictMessage: string
  }
}

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
   *  CpPlatformProvider.projectBotAssign}. `orchestrator/httpBot.ts` reads this
   *  declaration in `syncBot` and on the register-replay path, replacing the two
   *  hand-written arms it used to hold (Slack ⇒ `signingSecret`, Feishu ⇒
   *  `verificationToken` + `appToken`): same slots, now owned by the platform,
   *  and the operator-facing refusal names the missing ones. A platform
   *  declaring none is never gated here. */
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
 * (`'org'` scope); this facet is the piece the platform's OTHER flows call back
 * into — the quick-install funnel start, the config status projection, and the
 * Settings→Bots manifest refresh, which moved into the provider WITH this facet
 * (`http/routes/slack-bot-refresh.ts`, carrying the `slackAppLinks` console
 * deep links into the refresh DTO).
 *
 * ONE INSTANCE, by construction: the composition root builds the facet and hands
 * the same object to the provider and to those routes' seams, so "which store
 * answers" and "when is a token stale" cannot drift between them. The facet
 * answers only the CREDENTIAL question — deployment-level terms (the funnel's
 * public callback origin, the relay pool) stay with the routes that know them.
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
   *  platform's dedicated bot. Presence of the member IS the capability —
   *  `http/agent-bot-icon-sync.ts` probes for it and skips the bot when it is
   *  absent, which replaced that file's three-way `bot.platform === … &&
   *  deps.syncX` conjunction (Slack has no member here: it renders per-message
   *  `icon_url` from the public CP endpoint instead). Which credential the push
   *  needs is the provider's business — Feishu resolves its app id from
   *  `secrets.appToken ?? bot.feishuAppId` inside and no-ops without one. */
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

  /**
   * Map a validated credential block onto the rows a NEW bot install writes —
   * the platform-specific half of the create tail (see {@link CpNewBotInstall}).
   * Pure: no I/O, no provider round-trip (those all belong to
   * {@link validateConfig}, which runs first and hands its
   * {@link CpValidatedIdentity} in here).
   *
   * `shareable` is the caller's REQUEST, not a decision: a platform that does
   * not support multi-agent bots simply drops it (the §5 manifest is the
   * eventual declarative home for that axis — until it carries the field, the
   * platform that supports sharing is the one that echoes the flag back).
   */
  buildNewBotInstall(input: {
    credentials: TCredentials
    identity: CpValidatedIdentity
    transport: CpInstallTransport
    shareable: boolean
  }): CpNewBotInstall

  /** How this platform packs the shared secret row + which slots gate an
   *  http assign. See {@link CpSecretShape}. */
  secretShape: CpSecretShape

  /**
   * Project a NEW bot row's generic D6 identity columns from the platform
   * columns of the same write (§11; audit F13) — which value is this platform's
   * external APP id, whether it has a TENANT axis or writes the tenantless
   * sentinel, and what public metadata rides the generic `platformConfig` bag.
   *
   * An AT-WRITE read, and the reason it is a member rather than a repository
   * `switch`: `PgBotRepo.create` writes the D6 identity for EVERY caller —
   * the shared create tail, the Feishu one-click funnel, and anything added
   * later — so the decision has to be reachable from persistence, but it is not
   * persistence's to make. Core keeps the write (and so keeps §11's guarantee
   * that a new row never leaves the pair NULL unless the platform genuinely
   * captured no app identity); the platform keeps the mapping.
   *
   * DISTINCT from {@link CpNewBotInstall.externalIdentity}, which is the create
   * ROUTE's 409 pre-check and applies only to a platform that wants a clean
   * conflict message on the credential-paste path. This member describes what is
   * PERSISTED, on every path, and a platform may project an identity here
   * without claiming a route-level fence (Slack does exactly that: its rows
   * carry the pair whenever an app id and workspace were captured, and the
   * composite unique fences them, but a pasted-token install with neither is
   * admitted unfenced because there is nothing to fence on).
   *
   * Pure: no I/O. Absent ⇒ this platform persists no external identity
   * (Telegram — a bot token and nothing else). PUBLIC metadata only.
   */
  projectBotIdentity?(input: CreateBotInput): BotIdentityColumns

  /** Normalize the provider realm used to fence bot-agnostic SessionMeta thread fallback. */
  threadFallbackRealm?(bot: BotRecord): string | null

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
   * (§6.4) — the per-platform arms of `integrationToSpec` /
   * `httpIntegrationToSpec` (`orchestrator/placement.ts`), relocated behind
   * the provider. Core keeps assembling the envelope
   * (`integrationId`/`agentId`/`platform`/`core`) — it owns the routing
   * compile that produces `core` — and passes the envelope IN by contract (a
   * platform whose payload legitimately depends on the ingress mode may read
   * it), but the payload must NEVER duplicate the envelope's routing knobs:
   * since the S3 flatten the daemon reads `bindRules`/`mutedChannels`/`gated`/
   * `mode` exclusively from `core`, so a copy inside `config` would be a
   * second representation free to disagree. The BOT row is a required input:
   * the shared-mode fields ride it (`shareable`, the provider app id,
   * `botUserId`) and `bot.transport` is the direct-vs-shared fork itself.
   * Shape validation of the produced payload lives in the same platform's
   * DAEMON module (§6.4), not here. Token-bearing — NEVER log.
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
   * `buildAssign` (`orchestrator/httpBot.ts` the ingress bag:
   * Feishu's app id from `secret.appToken` vs Slack's `bot.slackAppId`, the
   * distributed-install `teamId`, `botUserId`; and the secrets bag:
   * Feishu `verificationToken`/`encryptKey` vs Slack
   * `botToken`/`signingSecret`). Everything else on the frame stays core-
   * assembled: the compiled routing table, member directory, gating fences,
   * and `credentialRevision` — and the four-way platform ternary
   * disappears entirely under an open `PlatformId` (audit
   * ambiguous row 6). Returned as `Record<string, unknown>` (not `unknown`)
   * so the product assigns to the frame's open-reader members
   * (`RcBotSecrets`' record arm / `ingress: z.unknown()`) without a cast;
   * the RELAY platform module validates the shapes (§6.7). Token-bearing —
   * NEVER log.
   *
   * OPTIONAL (S3 erratum): a platform without an HTTP/relay transport simply
   * does not declare the member. Telegram and Discord keep their daemon-owned
   * long-lived connections — the create route refuses `transport: 'http'` for
   * them (`integrations.ts:392-400`), so no such bot row can carry the http
   * transport and core's assign builder never sees one. Modeling that as a
   * required member forced the first two providers into throwing refusal
   * stubs; absence is the honest signal, and core's adoption code treats a
   * missing member as "this platform has no relay path" (the completeness gate
   * above never even fires — there is nothing to assign).
   */
  projectBotAssign?(
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
