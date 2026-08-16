/**
 * The ONE precondition every http-transport install shares: this deployment can
 * terminate public platform callbacks. Core knowledge, not a provider's
 * (integration-plugin-architecture.md §9 — core knows the relay pool), so the
 * Slack funnel, the platform-app install, the generic `POST /integrations` tail
 * and the Feishu registration all answer it the same way.
 *
 * Availability is NOT reachability. A relay can be registered, connected and
 * healthy while sitting on `http://localhost:8090` behind a firewall — the
 * platform's servers still cannot POST to it, and because the transport is
 * immutable the resulting bot is a silent black hole that can only be recovered
 * by deleting the integration and the bot. So the gate also refuses a public
 * origin that could never be dialled from the internet.
 */
import net from 'node:net'
import type { HttpDeps } from './deps.js'
import { privateV4, privateV6 } from '../net/private-address.js'

/** The relay pool's public HTTPS base from PUBLIC_RELAY_URL, normalizing a
 *  `ws(s)://` origin to `http(s)://` (the Events API request_url is HTTP) and
 *  trimming a trailing slash. Null/undefined ⇒ null. */
export function relayHttpBase(publicRelayUrl: string | undefined): string | null {
  if (!publicRelayUrl) return null
  return publicRelayUrl.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/$/, '')
}

/** Special-use names that never resolve to a public address (RFC 6761 `.localhost`,
 *  RFC 6762 `.local`, RFC 8375 `.home.arpa`, and ICANN's private-use `.internal`). */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']

/**
 * Could a platform's servers never deliver an event to this origin? True only for
 * the unmistakable cases — `localhost`, a special-use name, or a literal
 * loopback/private/link-local IP. A name we cannot classify counts as reachable:
 * an operator's split-horizon or tunnelled hostname is theirs to know, and this
 * check exists to close the one-way door, not to police DNS.
 */
export function unreachableIngressOrigin(base: string): boolean {
  let host: string
  try {
    host = new URL(base).hostname.toLowerCase()
  } catch {
    return true // PUBLIC_RELAY_URL is url-validated at boot, so this is not a working origin
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1) // IPv6 literal
  if (host === 'localhost' || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return true
  const fam = net.isIP(host)
  return (fam === 4 && privateV4(host)) || (fam === 6 && privateV6(host))
}

/** The gate's answer: the request_url base to bake into a platform app, or the
 *  refusal to send back as a 409. */
export type RelayIngress = { ok: true; base: string } | { ok: false; message: string }

const UNAVAILABLE = 'HTTP callback delivery is unavailable on this deployment'

/** Pure form of {@link relayIngress}, so the predicate is testable without deps. */
export function publicRelayIngress(publicRelayUrl: string | undefined, relayConnected: boolean): RelayIngress {
  const base = relayHttpBase(publicRelayUrl)
  if (!base)
    return { ok: false, message: `${UNAVAILABLE} — the relay pool has no public origin (set PUBLIC_RELAY_URL).` }
  if (!relayConnected) return { ok: false, message: `${UNAVAILABLE} — no relay is connected.` }
  if (unreachableIngressOrigin(base)) {
    return {
      ok: false,
      message: `HTTP callback delivery cannot work on this deployment: PUBLIC_RELAY_URL (${base}) is a loopback or private address, so a chat platform can never deliver events to it. Use socket delivery, or point PUBLIC_RELAY_URL at a publicly reachable relay origin.`
    }
  }
  return { ok: true, base }
}

/** Can this deployment accept an http-transport install right now? */
export function relayIngress(deps: Pick<HttpDeps, 'config' | 'httpBot'>): RelayIngress {
  return publicRelayIngress(deps.config.PUBLIC_RELAY_URL, deps.httpBot.hasConnectedRelay())
}
