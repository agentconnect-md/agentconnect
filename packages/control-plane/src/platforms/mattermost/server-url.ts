import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { isLinkLocalOrUnspecifiedAddress } from '../../net/guarded-fetch.js'

/** Derive the colon-free D6 `externalAppId` (also used as the Mattermost audience/tenant realmKey) from a normalized Mattermost server URL. */
export function mattermostExternalAppId(normalizedServerUrl: string): string {
  return `mm-${createHash('sha256').update(normalizedServerUrl).digest('hex').slice(0, 16)}`
}

/**
 * Normalize and SSRF-guard a self-hosted Mattermost base URL.
 * Allows http/https, private/loopback/intranet hosts, and subpaths (stripping trailing slashes);
 * rejects non-http(s) schemes, embedded userinfo, query strings, fragments, link-local ranges, and unspecified addresses.
 */
export function normalizeMattermostServerUrl(
  raw: string
): { ok: true; serverUrl: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: 'Enter a valid Mattermost server URL (for example, https://mattermost.example.com).' }
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return { ok: false, reason: 'The Mattermost server URL must not include a query string or fragment.' }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'Enter a valid Mattermost server URL (for example, https://mattermost.example.com).' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Mattermost server URL must use http:// or https://.' }
  }
  const authority = trimmed.slice(url.protocol.length + 2).split('/')[0] ?? ''
  if (url.username || url.password || authority.includes('@')) {
    return { ok: false, reason: 'The Mattermost server URL must not include a username or password.' }
  }
  if (!url.hostname) {
    return { ok: false, reason: 'Enter a valid Mattermost server URL (for example, https://mattermost.example.com).' }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0 && isLinkLocalOrUnspecifiedAddress(host)) {
    return { ok: false, reason: 'This Mattermost server address is not allowed.' }
  }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, serverUrl: `${url.origin}${path}` }
}
