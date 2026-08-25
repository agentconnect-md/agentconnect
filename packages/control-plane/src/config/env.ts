/**
 * `config/env.ts` (design §2.4) — zod-validated `process.env` → `AppConfig`.
 *
 * Fail-fast on boot, mirroring the daemon's "validate config or refuse to
 * start" discipline. The auth service (C4) takes the relevant slice
 * (`API_KEY_PEPPER`, `HEARTBEAT_SEC`).
 */
import { z } from 'zod'
import { USAGE_COLLECTOR_SA_NAME } from '@agentconnect.md/protocol'
import { composeCpPlatformEnv } from '../platforms/env.js'
import { effectiveOrgKeyPrefix, orgKeyPrefixConflict } from '../secrets/scope.js'

const HttpOriginSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'must use HTTP or HTTPS' })
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      ctx.addIssue({ code: 'custom', message: 'must be an origin without credentials, path, query, or fragment' })
    }
  })

const SecureOriginSchema = HttpOriginSchema.superRefine((value, ctx) => {
  const url = new URL(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (url.protocol !== 'https:' && !loopback) {
    ctx.addIssue({ code: 'custom', message: 'must use HTTPS unless it is loopback' })
  }
})

/** The env keys CORE owns. Platform keys are folded in below — this object is
 *  never exported: `AppConfigSchema` is the only schema, and it is the two
 *  halves together. */
const CoreConfigShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(), // Postgres (Prisma)
  WS_PATH: z.string().default('/daemon/ws'),
  HEARTBEAT_SEC: z.coerce.number().int().default(15), // → AuthOk.heartbeatSec (protocol §2.2)
  MISSED_BEATS: z.coerce.number().int().default(3), // freeze after 3×heartbeat
  REASSIGN_GRACE_SEC: z.coerce.number().int().default(60),
  ACK_TIMEOUT_MS: z.coerce.number().int().default(5000),
  // Schedule-run reconciliation (§3.14). A `cron_run` row opens `running` on the
  // fire report and closes on the completion report; a lost completion (daemon
  // offline / drained at turn end) would otherwise leave it `running` forever.
  // The CronRunReaper fails any `running` row older than CRON_RUN_TTL_SEC (a late
  // completion still overwrites it — the run-row upsert is last-writer-wins), and
  // sweeps every CRON_RUN_REAP_INTERVAL_SEC.
  CRON_RUN_TTL_SEC: z.coerce.number().int().default(1800),
  CRON_RUN_REAP_INTERVAL_SEC: z.coerce.number().int().default(300),
  // ── Session-access cache policy (session-access-cold-visit.md §2.3) ──
  // Any cached access decision older than this must be re-verified (seconds).
  // Per-user checks (workspace membership, repo permission) block until
  // re-verified; resource facts (channel/repo publicness) re-verify in the
  // background while the cached value serves.
  SESSION_ACCESS_RECHECK_SEC: z.coerce.number().int().min(30).max(600).default(120),
  // How long a channel/repo may still be treated as public after its last
  // confirmation (seconds). Bounds how late a public→private conversion is
  // honored while nobody is looking; any access older than RECHECK re-verifies
  // immediately. Must be ≥ SESSION_ACCESS_RECHECK_SEC (checked below).
  SESSION_ACCESS_PUBLIC_TTL_SEC: z.coerce.number().int().min(300).max(14400).default(3600),
  // Serving lease for a viewer's provider-identity projection (seconds); in-product
  // link/unlink still invalidates immediately — only an out-of-band Logto edit waits this out.
  SESSION_ACCESS_IDENTITY_TTL_SEC: z.coerce.number().int().min(30).max(86400).default(120),
  // HMAC pepper for `api_key.hash` (C4). Required, ≥32 chars. Effectively immutable —
  // rotating it invalidates every stored key hash. See daemon-api-key-auth.md.
  API_KEY_PEPPER: z.string().min(32),
  // ── Relay (shared-bot-relay.md §8) — the unified ingress plane ──
  // Deployment-shared secret for the relay↔CP `rc/auth` token mode. Unset ⇒ token
  // mode is OFF (relays must present a per-relay ApiKey instead). ≥32 chars, and
  // .optional() so it never fail-fast an existing deploy (like OIDC/GitHub above).
  RELAY_TOKEN: z.string().min(32).optional(),
  // The path the relay control socket is mounted at (parallel to WS_PATH).
  RELAY_WS_PATH: z.string().default('/api/v1/relays/ws'),
  // Failover sweeper: a `relay` row whose lastSeenAt predates now−RELAY_STALE_SEC is
  // swept (its roster entry drops), sweeping every RELAY_REAP_INTERVAL_SEC. Default
  // 3×heartbeat / 1×heartbeat, mirroring the daemon watchdog's freeze threshold.
  RELAY_STALE_SEC: z.coerce.number().int().default(45),
  RELAY_REAP_INTERVAL_SEC: z.coerce.number().int().default(15),
  // The relay pool's public ingress origin (browser webchat, webhooks, AND — from
  // slack-http-mode — the stable Slack Events API `request_url` baked once into an
  // http bot's app manifest, never repointed at runtime). Returned by the
  // webchat-token mint and surfaced in the Slack config status so the console can
  // show the request_url to paste. Unset ⇒ the webchat mint 503s and HTTP-mode Slack
  // installs are unavailable.
  PUBLIC_RELAY_URL: z.string().url().optional(),
  // ── Usage report interface — the non-daemon ingress ──
  // Deployment-shared secret authenticating the batch usage endpoint, which records
  // `gateway`-source reports for an upstream that meters sessions outside any daemon.
  // Unset ⇒ that endpoint is NOT MOUNTED at all (the daemon EVT is the only ingress).
  // ≥32 chars, and .optional() so a deployment without one never fail-fasts.
  USAGE_INGEST_TOKEN: z.string().min(32).optional(),
  SECRETS_PROVIDER: z.enum(['memory', 'vault']).default('memory'),
  // ── At-rest secret encryption (docs/designs/secret-store-seams.md) — opt-in ──
  // Selects the SecretCipher every secret store seals/opens through. `none`
  // (default) is the identity cipher — plaintext at rest, the pre-existing
  // behavior, so existing deploys never fail-fast on an image bump.
  // `vault-transit` seals via HashiCorp Vault's Transit engine; the flip is
  // ONLINE: open() passes existing plaintext rows through unchanged and the
  // next write re-seals them (lazy migration, no backfill required).
  SECRET_CIPHER: z.enum(['none', 'vault-transit']).default('none'),
  VAULT_ADDR: HttpOriginSchema.optional(), // Vault origin, e.g. http://vault.vault.svc:8200
  VAULT_TRANSIT_KEY: z.string().default('agentconnect-cp'), // deployment-scope transit key name
  // Org-scope key names are this prefix + the org id (one key per organization,
  // so deleting an org can destroy its key — docs/designs/per-org-secret-encryption.md).
  // Unset ⇒ derived as `<VAULT_TRANSIT_KEY>-org-`, which inherits whatever
  // namespace the deployment key already occupies; deployments sharing one
  // transit mount rely on key naming alone to stay separated, and a fixed
  // prefix would collide their org keys.
  VAULT_TRANSIT_ORG_KEY_PREFIX: z.string().optional(),
  VAULT_TRANSIT_MOUNT: z.string().default('transit'), // transit engine mount path
  VAULT_NAMESPACE: z.string().optional(), // Vault Enterprise namespace (sent as X-Vault-Namespace)
  // Auth — exactly ONE of the two modes when SECRET_CIPHER=vault-transit:
  // a static token, or a workload JWT read from a file and exchanged at a Vault
  // login-style auth method (`auth/<mount>/login` with {role, jwt} — Vault's
  // `kubernetes` and generic `jwt`/OIDC methods share that exact wire shape, so
  // the CP is NOT bound to Kubernetes; the defaults below merely make the common
  // k8s deployment zero-config: point the path/mount anywhere your platform
  // mounts a workload identity JWT).
  VAULT_TOKEN: z.string().optional(),
  VAULT_JWT_ROLE: z.string().optional(),
  VAULT_JWT_PATH: z.string().default('/var/run/secrets/kubernetes.io/serviceaccount/token'),
  VAULT_AUTH_MOUNT: z.string().default('kubernetes'), // login auth method mount (e.g. kubernetes | jwt)
  OIDC_ISSUER: z.string().url().optional(), // human-auth (C2); unset ⇒ devAuth stub
  OIDC_AUDIENCE: z.string().optional(), // required `aud` on the bearer JWT (C2)
  // ── Waitlist / closed-beta admission gate ──
  // When on, a signed-in user must be a formal (activated) user OR an existing org
  // member to enter the app; otherwise they land on /waitlist. Default OFF keeps the
  // OSS self-hosted behavior (login ⇒ org onboarding ⇒ app). Parsed as an
  // EXPLICIT 'true'/'false' enum, NOT z.coerce.boolean() — the latter treats any
  // non-empty string (including "false") as true, which would silently gate everyone
  // out. Approval / join-link minting / admin auth live in a separate external admin
  // app (§7); the CP only needs this switch to decide whether to enforce the gate.
  WAITLIST_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Externally-reachable CP origin used to render the daemon start command on
  // onboarding (C2). Unset ⇒ the command URL falls back to HOST:PORT.
  PUBLIC_CP_URL: z.string().url().optional(),
  // ── Preset agents (docs/designs/preset-agents.md §3) — default ON ──
  // Every org is born with the `agentconnect` general preset (org-creation seam)
  // and existing orgs are backfilled once at boot. 'false' turns BOTH off for
  // self-hosted fleets that don't want provisioned agents (the §9 deploy-time
  // default; a per-org setting may refine this later). Explicit enum, not
  // z.coerce.boolean() — same footgun as WAITLIST_MODE below.
  PRESET_AGENTS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Exec config the preset is BORN with on an install that runs a daemon pool
  // (DAEMON_POOL_ENABLED — an ordinary deployment shape, self-hosted included): a
  // new org's preset is placed on the pool at creation instead of waiting for a
  // machine, so its builtin agent can answer immediately. Deployment policy rather
  // than a product constant — the pool image decides which runtime is installed and
  // signed in for every org, so the deployment names it. Empty runtime ⇒ never
  // place on the pool (born unplaced, as before); an install with no pool member
  // ignores both keys.
  PRESET_AGENT_POOL_RUNTIME: z.string().default('dsh-acp'),
  // Model pinned on that placement; empty ⇒ leave it to the runtime's own default.
  PRESET_AGENT_POOL_MODEL: z.string().default('deepseek-v4-flash'),
  // (SLACK_PLATFORM_* and FEISHU/LARK_PLATFORM_* moved into the provider env
  // shapes spread above.)
  // The MCP endpoint's dedicated public origin (agent-assistant.md §6.1), e.g.
  // https://mcp.example.test. Set ⇒ the canonical MCP resource URL IS this origin (root resource;
  // the URL users paste is just the host) and auth discovery uses the origin-root
  // PRM. Unset ⇒ the resource is <public base>/v1/mcp (MCP_PUBLIC_PATH).
  PUBLIC_MCP_URL: z.string().url().optional(),
  // Externally-reachable Web App console origin, sent to daemons on `auth/ok` so they can
  // build session deep links (`<url>/sessions/<id>`) without local config. Unset ⇒ falls
  // back to a concrete CORS_ORIGIN (a two-origin deploy already lists the console origin
  // there), then to PUBLIC_CP_URL (single-origin deploys); all unset ⇒ no link is sent.
  // See resolveWebAppUrl.
  PUBLIC_WEB_URL: z.string().url().optional(),
  // npm dist-tag (or exact version) the onboarding command pins, so `npx` pulls
  // a specific daemon build — e.g. `rc` on the test CP renders
  // `npx @agentconnect.md/daemon@rc …`. Unset ⇒ npm's default (`@latest`).
  DAEMON_DIST_TAG: z.string().optional(),
  // Browser CORS for the Web UI (C2). Comma-separated allowed origins, or `*`.
  // Unset ⇒ reflect any origin in development, disabled in production.
  CORS_ORIGIN: z.string().optional(),
  // ── GitHub App (github-app workspaces) — opt-in, mirroring OIDC_ISSUER ──
  // All three must be set to enable the feature; any unset ⇒ the github module
  // is not assembled, its routes 404 and the console hides the repo picker.
  // MUST stay .optional(): a required field would fail-fast every existing
  // deployment on the next image bump (credentials roll out independently).
  GITHUB_APP_ID: z.coerce.number().int().optional(),
  // base64 of the App private key PEM — the ONE canonical encoding (raw
  // multiline PEM can't ride dotenv and \n-escapes differ between k8s
  // stringData and `set -a; . ./.env`). Decoded + parsed at boot; invalid ⇒
  // fail-fast with a clear error.
  GITHUB_APP_PRIVATE_KEY_B64: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(), // github.com/apps/<slug> — install deep link
  // Optional; when set the App JWT uses iss=client_id (GitHub's current
  // recommendation). Unset ⇒ iss=GITHUB_APP_ID (still supported).
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  // ── GitLab OAuth application (gitlab-com-integration.md §18.3, §24.1) ──
  // Both must be set to enable the GitLab integration; either unset ⇒ the
  // gitlab module is not assembled and its routes 404. Plain env is the
  // no-document fallback; the typed deployment document overlays these.
  GITLAB_CLIENT_ID: z.string().optional(),
  GITLAB_CLIENT_SECRET: z.string().optional(),
  // The instance the OAuth application above is registered on. One axis, not a
  // mode: absent means https://gitlab.com. Set without the pair ⇒ fail fast.
  GITLAB_BASE_URL: z.string().optional(),
  // ── Logto Management API (identity metadata + Profile social sign-in methods) ──
  // The ONE deliberate Logto coupling: it resolves GitHub identity metadata for
  // repo authorization and manages the signed-in user's own social identities.
  // All three must be set; both uses require OIDC_ISSUER, while repo authorization
  // additionally requires GITHUB_APP_*.
  LOGTO_MGMT_ENDPOINT: z.string().url().optional(), // tenant origin, e.g. https://tenant-id.logto.app
  LOGTO_MGMT_APP_ID: z.string().optional(), // an M2M app with Management API access
  LOGTO_MGMT_APP_SECRET: z.string().optional(),
  // Management API resource indicator; default `${LOGTO_MGMT_ENDPOINT}/api`.
  // Cloud tenants fronted by a custom domain must pin the canonical
  // `https://tenant.example.com/api` here.
  LOGTO_MGMT_RESOURCE: z.string().url().optional(),
  // ── Object store for uploaded icons (docs/designs/icon-uploads.md) — opt-in ──
  // A neutral S3-compatible target. `S3_ENDPOINT` takes the full S3 API origin,
  // so hosted services and local development stores use the same interface.
  // All FIVE required vars must be set to enable icon uploads; any unset ⇒ the
  // store is not assembled, the upload routes are not mounted, and the console
  // hides the Upload button (icons stay glyph-only). Must stay .optional() so an
  // existing deploy never fail-fast on the next image bump.
  S3_ENDPOINT: z.string().url().optional(), // full S3 API origin (NOT an R2 account id)
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  // Public base the uploaded object is served from (R2 custom domain / r2.dev URL,
  // a CDN, or MinIO's public bucket). Rendered into `<img src>` + Slack icon_url.
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  // SigV4 region. R2 ignores it ("auto"); real S3/MinIO may need a concrete one.
  S3_REGION: z.string().default('auto'),
  // ── open-connector integration (docs: connectors) — opt-in ──
  // Base URL of the open-connector admin API the CP brokers connector browsing +
  // connection provisioning through. Unset ⇒ the feature is off: the connectors
  // routes 404 and the console hides the "Add connectors" menu item. .optional()
  // so an existing deploy never fail-fast on the next image bump.
  OPEN_CONNECTOR_URL: z.string().url().optional(),
  // Provider whitelist for the connectors catalog. '*' (or unset) ⇒ every provider;
  // otherwise a comma-separated list of `service` ids.
  OPEN_CONNECTOR_PROVIDER_WHITELIST: z.string().optional(),
  // Provider blocklist applied after the whitelist. Defaults to the exact open-connector
  // service ids that overlap AgentConnect's native integrations.
  OPEN_CONNECTOR_PROVIDER_BLOCKLIST: z
    .string()
    .default('github,slack,telegram,discord,discordbot,feishu,feishu_app_bot,feishu_custom_bot'),
  // ── in-cluster Kubernetes access — opt-in by running a daemon pool ──
  // THE switch for the cluster surface, and the only access knob: turning it on asserts this
  // control plane runs inside the cluster, so the pod's ServiceAccount is the credential and a
  // process outside a pod fails at boot. It also says where the pool lives — the control plane's
  // own namespace, since the install places its pool members beside itself; a member identity from
  // any other namespace is refused, the fence around "may name its own org". 'false' (default) ⇒
  // no cluster module, only API-key daemon auth. Explicit rather than sniffed: a control plane
  // that merely happens to run on Kubernetes must not start claiming cluster access.
  // EXPLICIT enum, not z.coerce.boolean().
  DAEMON_POOL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // ServiceAccount the usage-report collector presents on the batch usage ingress. A knob, not
  // a constant: the collector is not this codebase's pod — the deployment that runs it names
  // it (e.g. after the component it lives in), and this is how that deployment tells the
  // verifying side. The default matches the historical name; the check itself stays
  // load-bearing either way, since collector and pool-member tokens share an audience and the
  // ServiceAccount is what keeps a daemon's token from writing usage. Read only where the
  // cluster surface is on (DAEMON_POOL_ENABLED); the shared-secret ingest path needs no identity.
  USAGE_COLLECTOR_SERVICE_ACCOUNT: z.string().min(1).default(USAGE_COLLECTOR_SA_NAME)
} as const

/**
 * Core keys + every platform provider's own (§9 `envSchema`, folded by
 * `platforms/env.ts`): today the Slack auto-install reaper knobs
 * (`SLACK_INSTALL_*`), the platform-published Slack app (`SLACK_PLATFORM_*`),
 * and the platform-owned Feishu/Lark apps (`FEISHU/LARK_PLATFORM_*`). Each key's
 * documentation lives with its provider's shape, and adding a platform with
 * deployment configuration no longer edits this file. The fold throws on a key
 * that shadows a core one, so the two halves cannot silently overlap.
 */
export const AppConfigSchema = z.object({
  ...CoreConfigShape,
  ...composeCpPlatformEnv(Object.keys(CoreConfigShape))
})

export type AppConfig = z.infer<typeof AppConfigSchema>

interface SecretCipherEnv {
  SECRET_CIPHER: 'none' | 'vault-transit'
  VAULT_ADDR?: string
  VAULT_TOKEN?: string
  VAULT_JWT_ROLE?: string
  VAULT_TRANSIT_KEY: string
  VAULT_TRANSIT_ORG_KEY_PREFIX?: string
}

function validateSecretCipher(config: SecretCipherEnv, ctx: z.RefinementCtx): void {
  // Checked whatever the cipher is: a deployment key sitting inside the org key
  // namespace is a SHREDDABLE name, and destroying it would take the whole
  // deployment's trust root with it. Catch the naming mistake at boot rather
  // than the first time an org is deleted.
  const conflict = orgKeyPrefixConflict(
    config.VAULT_TRANSIT_KEY,
    effectiveOrgKeyPrefix(config.VAULT_TRANSIT_KEY, config.VAULT_TRANSIT_ORG_KEY_PREFIX)
  )
  if (conflict) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['VAULT_TRANSIT_ORG_KEY_PREFIX'],
      message: conflict
    })
  }
  if (config.SECRET_CIPHER !== 'vault-transit') return
  if (!config.VAULT_ADDR) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['VAULT_ADDR'],
      message: 'SECRET_CIPHER=vault-transit requires VAULT_ADDR'
    })
  }
  const auths = [config.VAULT_TOKEN, config.VAULT_JWT_ROLE].filter((v) => v !== undefined).length
  if (auths !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['VAULT_TOKEN'],
      message: 'SECRET_CIPHER=vault-transit requires exactly one of VAULT_TOKEN or VAULT_JWT_ROLE'
    })
  }
}

// A public verdict must outlive its own re-check threshold, or every serve
// would already be past its ceiling (session-access-cold-visit.md §2.3).
function validateSessionAccess(
  config: { SESSION_ACCESS_RECHECK_SEC: number; SESSION_ACCESS_PUBLIC_TTL_SEC: number },
  ctx: z.RefinementCtx
): void {
  if (config.SESSION_ACCESS_PUBLIC_TTL_SEC < config.SESSION_ACCESS_RECHECK_SEC) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_ACCESS_PUBLIC_TTL_SEC'],
      message: 'SESSION_ACCESS_PUBLIC_TTL_SEC must be ≥ SESSION_ACCESS_RECHECK_SEC'
    })
  }
}

/** Cross-field checks the flat schema can't express — fail-fast at boot, before
 *  the first secret write could silently land plaintext next to sealed rows. */
const AppConfigChecked = AppConfigSchema.superRefine(validateSecretCipher).superRefine(validateSessionAccess)

const BootstrapConfigSchema = z
  .object({
    DATABASE_URL: CoreConfigShape.DATABASE_URL,
    SECRET_CIPHER: CoreConfigShape.SECRET_CIPHER,
    VAULT_ADDR: CoreConfigShape.VAULT_ADDR,
    VAULT_TRANSIT_KEY: CoreConfigShape.VAULT_TRANSIT_KEY,
    VAULT_TRANSIT_ORG_KEY_PREFIX: CoreConfigShape.VAULT_TRANSIT_ORG_KEY_PREFIX,
    VAULT_TRANSIT_MOUNT: CoreConfigShape.VAULT_TRANSIT_MOUNT,
    VAULT_NAMESPACE: CoreConfigShape.VAULT_NAMESPACE,
    VAULT_TOKEN: CoreConfigShape.VAULT_TOKEN,
    VAULT_JWT_ROLE: CoreConfigShape.VAULT_JWT_ROLE,
    VAULT_JWT_PATH: CoreConfigShape.VAULT_JWT_PATH,
    VAULT_AUTH_MOUNT: CoreConfigShape.VAULT_AUTH_MOUNT
  })
  .superRefine(validateSecretCipher)

export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>

/** Parse only roots needed before the DB-backed deployment row can be read. */
export function loadBootstrapConfig(env: NodeJS.ProcessEnv = process.env): BootstrapConfig {
  return BootstrapConfigSchema.parse(env)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const logtoEndpoint = env.LOGTO_ENDPOINT?.trim()
  if (!logtoEndpoint) return AppConfigChecked.parse(env)

  const logtoOrigin = new URL(SecureOriginSchema.parse(logtoEndpoint)).origin
  const logtoMgmtEndpoint = env.LOGTO_MGMT_ENDPOINT?.trim()
  const hasLogtoMgmtCredentials = Boolean(env.LOGTO_MGMT_APP_ID?.trim() || env.LOGTO_MGMT_APP_SECRET?.trim())
  return AppConfigChecked.parse({
    ...env,
    OIDC_ISSUER: env.OIDC_ISSUER?.trim() || `${logtoOrigin}/oidc`,
    LOGTO_MGMT_ENDPOINT: logtoMgmtEndpoint || (hasLogtoMgmtCredentials ? logtoOrigin : undefined)
  })
}

/** The first concrete browser origin in a CORS_ORIGIN value, or undefined when it names
 *  none: unset, the `*` wildcard, or entries that aren't valid http(s) origins. A
 *  comma-separated list yields its first usable entry (conventionally the primary origin). */
export function corsWebOrigin(cors?: string): string | undefined {
  if (!cors) return undefined
  for (const raw of cors.split(',')) {
    const only = raw.trim()
    if (!only || only === '*') continue
    try {
      const u = new URL(only)
      if (u.protocol === 'http:' || u.protocol === 'https:') return only
    } catch {
      // not a URL — skip
    }
  }
  return undefined
}

/** The Web App console origin sent to daemons for session deep links (`<url>/sessions/<id>`).
 *  Prefers the explicit PUBLIC_WEB_URL; else a concrete CORS_ORIGIN (a two-origin deploy
 *  already lists the console origin for the browser, and it is by definition an allowed web
 *  origin — reusing it avoids a duplicate env var); else PUBLIC_CP_URL for single-origin
 *  deploys. Undefined means daemons use their own config or local default. */
export function resolveWebAppUrl(
  config: Pick<AppConfig, 'PUBLIC_WEB_URL' | 'CORS_ORIGIN' | 'PUBLIC_CP_URL'>
): string | undefined {
  return config.PUBLIC_WEB_URL ?? corsWebOrigin(config.CORS_ORIGIN) ?? config.PUBLIC_CP_URL
}
