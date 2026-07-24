/**
 * `http/onboarding.ts` — daemon onboarding helpers (copy-paste setup flow).
 *
 * Provisions a fresh daemon identity + its first long-lived API key and renders the
 * copy-paste command that starts a daemon pointed at this CP. The provisioning WRITES
 * rows (a `provisioned` Daemon + an `ApiKey`, see `ApiKeyService.provisionDaemon`) so the
 * key is revocable; the daemon row flips `provisioned → ready` on the first `auth`
 * handshake. The full key plaintext is returned here exactly once.
 */
import type { ApiKeyAdmin } from '../ports.js'
import type { HttpServerConfig } from './deps.js'

/** The npm package whose `bin` (`agentconnect`) runs the daemon. */
const DAEMON_PKG = '@agentconnect.md/daemon'

/**
 * Render the npm package spec `npx` should install, honouring an optional
 * dist-tag (or exact version). The operator sets `DAEMON_DIST_TAG` per
 * environment — e.g. `rc` on the test CP so onboarding pulls
 * `@agentconnect.md/daemon@rc`, while prod leaves it unset and pulls the npm
 * default (`@latest`). A leading `@` and surrounding whitespace are tolerated,
 * so both `rc` and `@rc` work.
 */
export function daemonPkgSpec(distTag?: string): string {
  const tag = distTag?.trim().replace(/^@+/, '')
  return tag ? `${DAEMON_PKG}@${tag}` : DAEMON_PKG
}

export interface DaemonConnect {
  daemonId: string
  /** Full opaque API-key plaintext — shown exactly once; not retrievable afterward. */
  apiKey: string
  /** Non-secret console label, e.g. `…a2b1`. */
  displayTail: string
  command: string
}

/**
 * Derive the daemon WebSocket base URL the start command should dial. Prefers an
 * explicit `PUBLIC_CP_URL` (the externally-reachable origin); otherwise falls
 * back to `HOST:PORT`. `http(s)` is normalised to `ws(s)`; `0.0.0.0` is rendered
 * as `127.0.0.1` so a copy-pasted local command actually connects.
 *
 * Any path on `PUBLIC_CP_URL` is treated as an ingress mount prefix and preserved:
 * `WS_PATH` is appended *under* it. So `https://cp.example.com/cp` ⇒
 * `wss://cp.example.com/cp/daemon/ws`
 * (the prefix the edge strips before the CP sees `/daemon/ws`), while a bare
 * `https://cp.example.com` ⇒ `wss://cp.example.com/daemon/ws`. Overwriting the path instead would drop
 * the prefix and the handshake would 404 at the gateway.
 */
export function daemonWsUrl(config: HttpServerConfig): string {
  const wsPath = config.WS_PATH ?? '/daemon/ws'
  if (config.PUBLIC_CP_URL) {
    const u = new URL(config.PUBLIC_CP_URL)
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol
    const prefix = u.pathname.replace(/\/+$/, '') // strip trailing slash(es) on the mount prefix
    u.pathname = `${prefix}${wsPath.startsWith('/') ? '' : '/'}${wsPath}`
    u.search = ''
    return u.toString().replace(/\/$/, '')
  }
  const host = !config.HOST || config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST
  const port = config.PORT ?? 8080
  return `ws://${host}:${port}${wsPath}`
}

/** Render the copy-paste daemon start command for a freshly-minted API key.
 *  The key's row carries the daemonId, so no `--daemon-id` is needed — the daemon
 *  adopts its identity from `auth/ok` (a minimal `--server-url --api-key` shape).
 *  `distTag` pins the npm dist-tag/version `npx` installs (see `daemonPkgSpec`). */
export function daemonStartCommand(wsUrl: string, apiKey: string, distTag?: string): string {
  // `-y` so npx installs the package non-interactively (a copy-pasted command
  // shouldn't stall on the "Ok to proceed?" prompt on a fresh host).
  return `npx -y ${daemonPkgSpec(distTag)} run --cp-url ${wsUrl} --cp-key ${apiKey}`
}

/**
 * Provision a new daemon (provisioned row + first API key) and render its start
 * command. The key plaintext is returned exactly once. `createdByUserId` stamps
 * the WebUI principal on the daemon row (console "Created" row).
 */
export async function provisionDaemonConnect(
  apiKeys: ApiKeyAdmin,
  config: HttpServerConfig,
  orgId: string,
  createdByUserId?: string
): Promise<DaemonConnect> {
  const { daemonId, token, displayTail } = await apiKeys.provisionDaemon({
    orgId,
    ...(createdByUserId ? { createdByUserId } : {})
  })
  const command = daemonStartCommand(daemonWsUrl(config), token, config.DAEMON_DIST_TAG)
  return { daemonId, apiKey: token, displayTail, command }
}
