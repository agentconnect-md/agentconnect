/**
 * `config.ts` — zod-validated `process.env` → `RelayConfig`, fail-fast on boot
 * (mirrors the CP's `config/env.ts` and the daemon's config discipline).
 *
 * The relay is DB-less deployment infra: its only durable identity is
 * `RELAY_NAME` (the CP upserts the `relay` row by it), and it authenticates to
 * the CP with ONE of the two §8 credentials (a shared `RELAY_TOKEN` or a
 * per-relay `RELAY_API_KEY`). Credentials are secret material — never logged.
 */
import { z } from 'zod'
import { isIPv4 } from 'node:net'
import { COMPUTER_TURN_URLS_MAX, ComputerStunUrl, ComputerTurnUrl } from '@agentconnect.md/protocol/computer-viewer'

export const RelayConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    AHP_MODE: z.enum(['off', 'shadow', 'on']).default('off'),
    // Issuer of the CP's OAuth authorization server, advertised beside the AHP endpoint for client discovery only.
    AHP_AUTHORIZATION_SERVER: z
      .string()
      .url()
      .transform((url) => url.replace(/\/+$/, ''))
      .optional(),
    // Health/readiness HTTP surface (k8s probes; the daemon/browser WS servers land here in PR 2/3).
    PORT: z.coerce.number().int().default(8080),
    HOST: z.string().default('0.0.0.0'),
    // The control-plane origin the relay dials for the rc/* control wire. http(s)
    // is normalized to ws(s); the `/api/v1/relays/ws` path is appended at dial time.
    CP_URL: z.string().url(),
    // Deployment-side identity (pod name etc.) — the CP's upsert key for the
    // `relay` row, stable across restarts (design §6).
    RELAY_NAME: z.string().min(1),
    // The address daemons dial for THIS relay instance (rc/register.daemonUrl).
    // MUST route to this specific instance — per-pod DNS or a relay-id-sticky
    // path, never a pool-level LB (design §5).
    DAEMON_DIAL_URL: z.string().min(1),
    // §8 dual-mode auth — set EXACTLY ONE (refine below):
    //  - RELAY_TOKEN   : deployment-shared secret (self-hosted; ≥32, dot-free recommended)
    //  - RELAY_API_KEY : per-relay ApiKey (managed / multi-relay)
    RELAY_TOKEN: z.string().min(32).optional(),
    RELAY_API_KEY: z.string().min(1).optional(),
    // GitHub App webhook signing secret (webhook-triggers doc, decision 13).
    // Unset ⇒ POST /webhooks/github is never registered (whole endpoint 404);
    // the generic /webhooks/in ingress is unaffected. Secret material — the
    // deploy side must put the SAME secret on every relay replica, or the pool
    // LB turns the missing pods into a partial blackhole GitHub won't retry.
    GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Fallback heartbeat cadence if the CP's rc/auth/ok carries none (it always does).
    HEARTBEAT_DEFAULT_MS: z.coerce.number().int().default(15_000),
    // Seconds between periodic re-checks of each assigned bot's platform credential (jittered ±10%, first run at a random offset).
    RELAY_CREDENTIAL_PROBE_INTERVAL_SEC: z.coerce.number().int().positive().default(3600),
    // Comma-separated hostnames the MCP reverse proxy may resolve to PRIVATE addresses
    // (centralized-tool-management.md §5.3) — the deploy-level opt-in for internal MCP
    // upstreams. Unset ⇒ public-only (private/loopback/metadata rejected). Never a wildcard.
    RELAY_MCP_ALLOWED_UPSTREAMS: z.string().optional(),
    // Purpose-separated opt-in for private external-memory plugin endpoints.
    // Never inherit the model-facing MCP exception: approving an internal MCP
    // provider must not silently widen the memory-plugin egress boundary.
    RELAY_MEMORY_ALLOWED_UPSTREAMS: z.string().optional(),
    // ── open-connector integration (docs: connectors) ──
    // The relay serves open_connector provider bindings as a synthesized MCP server
    // backed by open-connector's runtime REST API. Unset ⇒ the OC origin is derived
    // from each binding's upstreamUrl (`<OC>/mcp`); set to override with a fixed origin.
    OPEN_CONNECTOR_URL: z.string().url().optional(),
    // Optional bearer for open-connector's runtime API (if OC requires a runtime token).
    OPEN_CONNECTOR_RUNTIME_TOKEN: z.string().optional(),
    // STUN for viewer hole punching (computer-use.md §7.2): the UDP port to answer on (unset ⇒ none) and its bind host.
    RELAY_STUN_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    RELAY_STUN_HOST: z.string().min(1).default('0.0.0.0'),
    // The public `stun:<host>:<port>` that reaches this instance's STUN port with the client's source address intact.
    RELAY_STUN_URL: ComputerStunUrl.optional(),
    // TURN for viewer media when punching fails (computer-use.md §7.2): UDP and TCP on this port (unset ⇒ none), IPv4 bind host.
    RELAY_TURN_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    RELAY_TURN_HOST: z.string().refine(isIPv4, 'an IPv4 address').default('0.0.0.0'),
    // The public `turn:` / `turns:` URLs that reach this instance's TURN ports, comma-separated.
    RELAY_TURN_URLS: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? '')
          .split(',')
          .map((url) => url.trim())
          .filter(Boolean)
      )
      .pipe(z.array(ComputerTurnUrl).max(COMPUTER_TURN_URLS_MAX)),
    // TURN over TLS, for networks that only let 443 out; the certificate is re-read hourly so a rotated one is picked up.
    RELAY_TURN_TLS_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    RELAY_TURN_TLS_CERT_FILE: z.string().min(1).optional(),
    RELAY_TURN_TLS_KEY_FILE: z.string().min(1).optional(),
    RELAY_TURN_REALM: z.string().min(1).max(127).default('agentconnect'),
    // The IPv4 address relayed candidates carry; peers are only this instance's allocations, so it is an identifier, not a socket.
    RELAY_TURN_RELAYED_ADDRESS: z.string().refine(isIPv4, 'an IPv4 address').optional(),
    RELAY_TURN_MAX_ALLOCATIONS: z.coerce.number().int().positive().default(400),
    RELAY_TURN_MAX_ALLOCATIONS_PER_USER: z.coerce.number().int().positive().default(16),
    // Per allocation, what its client may send to its peer; the default fits the viewer's 2.5 Mbps stream and its bursts.
    RELAY_TURN_MAX_BPS: z.coerce.number().int().min(64_000).default(10_000_000),
    RELAY_TURN_IDLE_TIMEOUT_SEC: z.coerce.number().int().min(10).max(3600).default(120)
  })
  .refine((c) => c.RELAY_TURN_URLS.length === 0 || c.RELAY_TURN_PORT !== undefined, {
    message: 'RELAY_TURN_URLS advertises a TURN server, so RELAY_TURN_PORT must be set too',
    path: ['RELAY_TURN_URLS']
  })
  .refine((c) => c.RELAY_TURN_PORT === undefined || c.RELAY_TURN_URLS.length > 0, {
    message: 'RELAY_TURN_PORT serves TURN, so RELAY_TURN_URLS must name the public addresses that reach it',
    path: ['RELAY_TURN_URLS']
  })
  .refine(
    (c) =>
      [c.RELAY_TURN_TLS_PORT, c.RELAY_TURN_TLS_CERT_FILE, c.RELAY_TURN_TLS_KEY_FILE].every((v) => v === undefined) ||
      (c.RELAY_TURN_PORT !== undefined &&
        [c.RELAY_TURN_TLS_PORT, c.RELAY_TURN_TLS_CERT_FILE, c.RELAY_TURN_TLS_KEY_FILE].every((v) => v !== undefined)),
    {
      message: 'TURN over TLS needs RELAY_TURN_PORT plus all of RELAY_TURN_TLS_PORT, _CERT_FILE and _KEY_FILE',
      path: ['RELAY_TURN_TLS_PORT']
    }
  )
  .refine((c) => c.RELAY_TURN_PORT === undefined || c.RELAY_TURN_PORT !== c.RELAY_STUN_PORT, {
    message: 'RELAY_TURN_PORT answers STUN Binding requests too, so it cannot share RELAY_STUN_PORT',
    path: ['RELAY_TURN_PORT']
  })
  .refine((c) => !c.RELAY_STUN_URL || c.RELAY_STUN_PORT !== undefined, {
    message: 'RELAY_STUN_URL advertises a STUN server, so RELAY_STUN_PORT must be set too',
    path: ['RELAY_STUN_URL']
  })
  .refine((c) => (c.RELAY_TOKEN ? 1 : 0) + (c.RELAY_API_KEY ? 1 : 0) === 1, {
    message: 'set exactly one of RELAY_TOKEN or RELAY_API_KEY (the relay↔CP credential, §8)'
  })

export type RelayConfig = z.infer<typeof RelayConfigSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return RelayConfigSchema.parse(env)
}

/** The rc/auth credential the relay presents, derived from whichever §8 secret is set. */
export interface RelayAuthCredential {
  method: 'token' | 'apikey'
  credential: string
}

export function resolveAuth(config: RelayConfig): RelayAuthCredential {
  // `.refine` guarantees exactly one is set.
  return config.RELAY_API_KEY
    ? { method: 'apikey', credential: config.RELAY_API_KEY }
    : { method: 'token', credential: config.RELAY_TOKEN! }
}

/** Normalize an http(s)/ws(s) origin to the ws(s) scheme the `ws` client dials. */
export function toWsOrigin(url: string): string {
  if (url.startsWith('ws://') || url.startsWith('wss://')) return url
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`
  return url
}
