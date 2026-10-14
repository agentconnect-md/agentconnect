/** The host a stored skill source names; GitHub's `owner/repo` shorthand has none and means github.com. */
function skillSourceHost(source: string): string {
  const value = source.trim()
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(value)
  if (scp) return scp[1]!.toLowerCase()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return new URL(value).hostname.toLowerCase().replace(/\.+$/, '')
    } catch {
      return ''
    }
  }
  const first = value.split('/')[0] ?? ''
  return first.includes('.') ? first.toLowerCase() : 'github.com'
}

/** An anonymous source off GitHub installs from its URL alone, with no identity check (source-cache.md §5); unknown on older CPs. */
export function isTrustedByUrl(s: { source: string; credential?: { provider: string } | null }): boolean {
  return s.credential === null && skillSourceHost(s.source) !== 'github.com'
}

/** A source typed into the Git URL import form must be a plain HTTPS address. */
export function isHttpsGitAddress(raw: string): boolean {
  const value = raw.trim()
  if (!/^https:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return !!url.hostname && !url.username && !url.password && url.pathname.replace(/\/+$/, '').length > 1
  } catch {
    return false
  }
}
