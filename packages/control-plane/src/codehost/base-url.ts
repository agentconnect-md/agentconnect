/**
 * The one normalization of a code host's instance base URL
 * (gitlab-com-integration.md §24.1, gitea-integration.md §3).
 *
 * One helper rather than a copy per host: the rules are the instance axis itself, not any
 * host's opinion — HTTPS, no userinfo/query/fragment, lower-cased host, explicit non-default
 * port kept, no trailing slash, and a path prefix preserved, because a relative URL root is a
 * first-class install shape on every self-hosted code host. `subject` only names the host in
 * the refusal, so an operator reads which field they typed wrongly.
 */
export function normalizeCodeHostBaseUrl(raw: string, subject: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${subject} base url must be an absolute URL`)
  }
  if (url.protocol !== 'https:') throw new Error(`${subject} base url must use https`)
  if (url.username !== '' || url.password !== '') throw new Error(`${subject} base url must not carry userinfo`)
  if (url.search !== '') throw new Error(`${subject} base url must not carry a query`)
  if (url.hash !== '') throw new Error(`${subject} base url must not carry a fragment`)
  // `url.host` already lower-cases the host and drops the default 443 port.
  return `https://${url.host}${url.pathname.replace(/\/+$/, '')}`
}
