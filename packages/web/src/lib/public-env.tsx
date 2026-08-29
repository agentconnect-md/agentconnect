// Runtime public config injection.
//
// Next inlines `NEXT_PUBLIC_*` at build time, which would pin a prebuilt image to
// one tenant. Instead the server reads plain (non-public) env at request time and
// emits an inline script that sets `window.__AC_ENV` before the app bundle runs;
// the client (lib/auth.ts) reads from there. Same image, configured at deploy
// time. Values here are public (they ship to the browser regardless) — never put
// secrets in __AC_ENV. Falls back to the NEXT_PUBLIC_* build-time vars so local
// dev (.env.local) keeps working unchanged.

// LOGTO_* gate the social-login UI; CP_URL points the console at its Control
// Plane; RELAY_URL points at the public relay ingress. OTEL_WEB_* configures
// browser-side tracing only. All are public (they reach the browser anyway) —
// never add secrets.
const KEYS = [
  'LOGTO_ENDPOINT',
  'LOGTO_APP_ID',
  'LOGTO_API_RESOURCE',
  // Which social sign-in methods this deployment offers (comma-separated Logto
  // connector targets; unset/`*` ⇒ all). The console is the only side that reads
  // it — see lib/social-login-providers.
  'SOCIAL_PROVIDERS',
  'CP_URL',
  'RELAY_URL',
  // The deployment's GitLab instance base URL (workspace tile derivation). Served
  // by the CP's runtime-config below; this env key is the local-dev fallback.
  'GITLAB_URL',
  // Dedicated MCP origin (mirrors the CP's PUBLIC_MCP_URL). Unset ⇒ the console
  // renders the MCP endpoint as CP_URL + /mcp (ConnectAiCard).
  'MCP_URL',
  // Billing service base URL. Only an address: whether the console offers billing
  // is the `billing` feature flag in FEATURE_FLAGS. Both are PRESENTATION only —
  // the billing service authenticates and authorizes every request itself.
  'BILLING_URL',
  // Help-menu link targets — let an OSS fork point the rail-footer help menu at its
  // own docs / connector guide / releases / support channel without rebuilding.
  // Unset ⇒ the agentconnect.md defaults (see Shell.tsx HELP_LINK_DEFAULTS).
  // Sender address the waitlist page tells approved users to expect the activation
  // link from. Must match the admin mailer's verified sender. Unset ⇒ the
  // agentconnect.md default (see Waitlist.tsx FROM_EMAIL_DEFAULT).
  'WAITLIST_FROM_EMAIL',
  'HELP_MCP_URL',
  'HELP_DOCS_URL',
  'HELP_RELEASES_URL',
  'HELP_SUPPORT_URL',
  'OTEL_WEB_ENABLED',
  'OTEL_WEB_TRACES_ENDPOINT',
  'OTEL_WEB_SERVICE_NAME',
  'OTEL_WEB_DEPLOYMENT_ENVIRONMENT',
  'OTEL_WEB_RESOURCE_ATTRIBUTES',
  'OTEL_WEB_PROPAGATE_TRACE_HEADER_URLS',
  // PostHog product analytics (opt-in). POSTHOG_API_KEY is PostHog's PUBLIC
  // project key (phc_…) — safe in the browser. Unset ⇒ analytics is a no-op
  // (lib/analytics never initializes). POSTHOG_HOST defaults to us.i.posthog.com.
  'POSTHOG_API_KEY',
  'POSTHOG_HOST',
  // Console feature flags this deployment turns on — a comma-separated list of ids
  // (lib/feature-flags.ts). Unset ⇒ none: a flagged surface ships in every build and appears
  // only where an environment asks for it, so one prebuilt image serves them all.
  'FEATURE_FLAGS'
] as const

interface RuntimeConfigResponse {
  schemaVersion: '1'
  revision: number | null
  config: null | {
    auth: null | {
      endpoint: string
      issuer: string
      appId: string
      apiResource: string | null
      socialProviders: string[]
    }
    gitlab?: null | { instanceUrl: string }
  }
}

let deploymentEnv: Promise<Record<string, string> | null> | undefined

async function loadDeploymentEnv(): Promise<Record<string, string> | null> {
  const base = process.env.CP_INTERNAL_URL
  if (!base) return null
  const url = new URL('runtime-config', base.endsWith('/') ? base : `${base}/`)
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`runtime config returned HTTP ${response.status}`)
  const body = (await response.json()) as RuntimeConfigResponse
  if (body.schemaVersion !== '1' || body.config === null) return null

  const env: Record<string, string> = {}
  if (body.config.auth) {
    env.LOGTO_ENDPOINT = body.config.auth.endpoint
    env.LOGTO_APP_ID = body.config.auth.appId
    if (body.config.auth.apiResource) env.LOGTO_API_RESOURCE = body.config.auth.apiResource
    env.SOCIAL_PROVIDERS = body.config.auth.socialProviders.join(',')
  }
  if (body.config.gitlab?.instanceUrl) env.GITLAB_URL = body.config.gitlab.instanceUrl
  return env
}

async function resolve(): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const k of KEYS) {
    const v = process.env[k] ?? process.env[`NEXT_PUBLIC_${k}`] ?? ''
    if (v) env[k] = v
  }
  // The Control Plane already calls this value PUBLIC_RELAY_URL. Accept that name
  // for shared local env files while keeping the Web runtime key parallel to CP_URL.
  const relayUrl = process.env.RELAY_URL ?? process.env.PUBLIC_RELAY_URL ?? process.env.NEXT_PUBLIC_RELAY_URL
  if (relayUrl) env.RELAY_URL = relayUrl

  // Cache a successful CP snapshot (including configured absence) but retry transient startup failures.
  if (process.env.CP_INTERNAL_URL) {
    deploymentEnv ??= loadDeploymentEnv()
    const pending = deploymentEnv
    let persisted: Record<string, string> | null = null
    try {
      persisted = await pending
    } catch {
      if (deploymentEnv === pending) deploymentEnv = undefined
    }
    if (persisted) {
      for (const key of ['LOGTO_ENDPOINT', 'LOGTO_APP_ID', 'LOGTO_API_RESOURCE', 'SOCIAL_PROVIDERS']) {
        delete env[key]
      }
      Object.assign(env, persisted)
    }
  }
  return env
}

/** Inline <script> that publishes the runtime public config to the browser. */
export async function PublicEnvScript() {
  // Escape `<` as well as JSON syntax so a deployment-controlled value cannot
  // terminate the inline script with a literal `</script>` sequence.
  const json = JSON.stringify(await resolve()).replaceAll('<', '\\u003c')
  return <script dangerouslySetInnerHTML={{ __html: `window.__AC_ENV=${json}` }} />
}
