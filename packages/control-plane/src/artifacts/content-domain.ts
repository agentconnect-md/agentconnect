// The artifact content domain (artifacts.md §5.5): a wildcard DNS name on a site of its own, checked at boot.
import { parse } from 'tldts'

/** The longest revision label, `a<32 hex>r<9 digits>`, so every revision host fits in 253 characters. */
const REVISION_LABEL_MAX = 1 + 32 + 1 + 9
const DOMAIN_MAX = 253 - REVISION_LABEL_MAX - 1
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** Why `domain` cannot be a content domain, or undefined when it is a DNS name the Public Suffix List can classify. */
export function contentDomainProblem(domain: string): string | undefined {
  if (domain.startsWith('*.')) return 'must be the bare domain, without the `*.` wildcard'
  if (/[/:@?#]/.test(domain)) return 'must be a bare domain name, without a scheme, port or path'
  if (domain !== domain.toLowerCase()) return 'must be lower case'
  if (domain.length > DOMAIN_MAX) return `must be at most ${DOMAIN_MAX} characters, so every revision host fits in DNS`
  const labels = domain.split('.')
  if (labels.length < 2) return 'must be a DNS name with at least two labels, not a single-label host'
  if (!labels.every((label) => LABEL_RE.test(label))) return 'must be a DNS name of letters, digits and hyphens'
  const parsed = parse(domain, { allowPrivateDomains: false })
  if (parsed.isIp || /^\d+$/.test(labels.at(-1)!)) return 'must be a DNS name, not an IP address'
  if (labels.at(-1) === 'localhost') return 'must not be localhost, which the Public Suffix List cannot classify'
  if (parsed.domain === null) return 'must not be a public suffix itself'
  return undefined
}

/** The browser's site for a host: its registrable domain under the full Public Suffix List, else the host itself. */
function siteOf(host: string): string {
  return parse(host, { allowPrivateDomains: true }).domain ?? host
}

/** One origin the deployment knows, named by the setting it comes from. */
export interface KnownOrigin {
  name: string
  url: string
}

/** Each known origin that shares a site with a revision host, or sits on the content domain itself. */
export function contentDomainConflicts(domain: string, origins: readonly KnownOrigin[]): string[] {
  const revisionSite = siteOf(`a${'0'.repeat(32)}r1.${domain}`)
  const out: string[] = []
  for (const { name, url } of origins) {
    let host: string
    try {
      host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    } catch {
      continue
    }
    if (host === domain || host.endsWith(`.${domain}`)) out.push(`${name} is on the content domain`)
    else if (siteOf(host) === revisionSite) out.push(`${name} is same-site with it (both under ${revisionSite})`)
  }
  return out
}
