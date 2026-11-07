// Which provider API key slot a request reaches and which header its key goes back into (github-app-git-credentials.md, Provider keys); the body is never read.
import { stripHostPathPrefix } from '../gitcred/managed-hosts.js'
import { hostKey } from './instance-route.js'
import { looksLikePlaceholder } from './placeholder.js'

/** One provider API key an agent may use, and the origin that key is accepted at. */
export interface ProviderSlot {
  /** A stable source name, such as `org:anthropic`; what a provider placeholder is sealed for. */
  id: string
  /** The provider, such as `anthropic` or `openai`. */
  provider: string
  host: string
  port: number
  /** The path the upstream serves the API under, without surrounding slashes; the root when absent. */
  pathPrefix?: string
  /** The provider's own default origin, which never resolves into private space; an operator-configured endpoint may. */
  saas: boolean
}

/** A slot's real key, and any headers the upstream also needs (an API version, an organization). */
export interface ResolvedProviderKey {
  key: string
  headers?: Record<string, string>
}

/** The headers a provider client may send its key in besides Authorization. */
const KEY_HEADERS = ['x-api-key', 'api-key', 'x-goog-api-key'] as const

/** A placeholder a request carries toward a provider: the header it came in, and Authorization's scheme. */
export interface CarriedKey {
  header: string
  value: string
  scheme?: string
}

/** Every header that carries a placeholder: the key headers, and Authorization in any scheme so a non-Bearer one is refused. */
export function providerKeyPlaceholders(headers: Headers): CarriedKey[] {
  const carried: CarriedKey[] = []
  const authorization = headers
    .get('authorization')
    ?.trim()
    .match(/^(\S+)\s+(\S+)$/)
  if (authorization && looksLikePlaceholder(authorization[2]!))
    carried.push({ header: 'authorization', value: authorization[2]!, scheme: authorization[1]!.toLowerCase() })
  for (const header of KEY_HEADERS) {
    const value = headers.get(header)?.trim()
    if (value && looksLikePlaceholder(value)) carried.push({ header, value })
  }
  return carried
}

/** A slot's host name as the proxy compares it: lower case, an IPv6 address unbracketed. */
export function slotHostname(slot: ProviderSlot): string {
  return slot.host.toLowerCase().replace(/^\[(.*)\]$/, '$1')
}

/** What a provider placeholder is sealed for: the slot's host, with its port unless it is HTTPS's own. */
export function slotHostKey(slot: ProviderSlot): string {
  return hostKey(slotHostname(slot), slot.port)
}

/** Whether a request to this host and port reaches the slot's origin. */
export function slotServes(slot: ProviderSlot, hostname: string, port: number): boolean {
  return slotHostname(slot) === hostname && slot.port === port
}

/** Whether a request target falls under the slot's path prefix; anything beside it is not the provider's API. */
export function underSlotPrefix(slot: ProviderSlot, target: string): boolean {
  const prefix = (slot.pathPrefix ?? '').replace(/^\/+|\/+$/g, '')
  return stripHostPathPrefix(target.split('?')[0] ?? '', prefix) !== undefined
}

/** The slot a key used at this endpoint goes through; undefined for a cleartext endpoint, where the proxy cannot exchange a placeholder. */
export function endpointSlot(
  id: string,
  provider: string,
  endpoint: URL,
  defaultEndpoint: string | null
): ProviderSlot | undefined {
  if (endpoint.protocol !== 'https:') return undefined
  const pathPrefix = endpoint.pathname.replace(/^\/+|\/+$/g, '')
  return {
    id,
    provider,
    host: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : 443,
    ...(pathPrefix ? { pathPrefix } : {}),
    saas: defaultEndpoint !== null && new URL(defaultEndpoint).origin === endpoint.origin
  }
}

/** Whether two slots send their key to the same provider, origin and path prefix. */
export function sameSlotOrigin(a: ProviderSlot, b: ProviderSlot): boolean {
  return a.provider === b.provider && slotHostKey(a) === slotHostKey(b) && (a.pathPrefix ?? '') === (b.pathPrefix ?? '')
}
