/**
 * The rules an MCP App frame is built under (webchat-mcp-apps.md §7) — pure, so the security
 * decisions are readable and testable on their own rather than buried in a component.
 *
 * Two of them are the whole point:
 *
 * 1. The frame runs on an OPAQUE ORIGIN. SEP-1865 says `allow-scripts allow-same-origin`, which
 *    assumes the host serves app HTML from an origin that is not its own. The console's is: with
 *    `allow-same-origin`, a `srcdoc` frame shares the console's origin and can read the
 *    `localStorage` the browser auth session lives in and call the CP as the signed-in user. So
 *    `allow-same-origin` is withheld, and an app gets no storage. `postMessage` — the only thing
 *    the bridge needs — works regardless.
 * 2. The CSP is built from what the RESOURCE declared and nothing else. A host may restrict
 *    further and must not admit an undeclared domain, so an absent list is the restrictive
 *    default rather than a wildcard, and nothing in the page can widen its own policy.
 */
import type { McpAppCsp } from '@agentconnect.md/protocol'

/**
 * The sandbox tokens the frame gets. Deliberately short, and deliberately without
 * `allow-same-origin` (see above) or `allow-popups` — a page that wants to send the reader
 * somewhere asks with `ui/open-link`, which the host opens on the reader's behalf after checking
 * the scheme, rather than navigating a window itself.
 */
export const MCP_APP_SANDBOX = 'allow-scripts allow-forms'

/**
 * One directive's source list: the keywords this host always allows, plus the domains the
 * resource declared, normalized to `https` so a bare hostname can never mean plain http.
 *
 * `'none'` appears ONLY when the whole list is empty, and that is not cosmetic: `'none'` beside
 * a real source is a contradiction CSP resolves by ignoring it, so emitting both would make a
 * directive read as restrictive while admitting everything it lists.
 */
function sources(declared: readonly string[] | undefined, base: readonly string[]): string {
  const extra = (declared ?? []).map((d) => (d.includes('://') ? d : `https://${d}`))
  const all = [...base, ...extra]
  return all.length > 0 ? all.join(' ') : "'none'"
}

/**
 * The policy the frame carries as a `<meta http-equiv>`, since a `srcdoc` document has no
 * response headers of its own to put one on.
 *
 * `'unsafe-inline'` for scripts and styles is not a lapse: an app template IS one inline
 * document, which is exactly what the extension specifies, and the isolation that matters here
 * is the opaque origin, not the ability to run the page's own code. `default-src 'none'` is what
 * makes every directive below an explicit grant.
 */
export function buildMcpAppCsp(csp?: McpAppCsp): string {
  const resource = csp?.resource
  return [
    "default-src 'none'",
    `script-src ${sources(resource, ["'unsafe-inline'"])}`,
    `style-src ${sources(resource, ["'unsafe-inline'"])}`,
    `img-src ${sources(resource, ['data:', 'blob:'])}`,
    `font-src ${sources(resource, ['data:'])}`,
    `connect-src ${sources(csp?.connect, [])}`,
    `frame-src ${sources(csp?.frame, [])}`,
    `base-uri ${sources(csp?.baseUri, [])}`,
    "form-action 'none'"
  ].join('; ')
}

/**
 * The document actually loaded into the frame: the policy first, then the template verbatim.
 *
 * Prepended rather than injected into the template's own `<head>`, and that is load-bearing — a
 * parser-driven insertion would have to understand a document the host did not write, while a
 * meta element before anything else is applied to everything after it. The template's own markup
 * is never rewritten: a host that edits an app's HTML is a host that can break it invisibly.
 */
export function buildMcpAppDocument(html: string, csp?: McpAppCsp): string {
  return `<meta http-equiv="Content-Security-Policy" content="${buildMcpAppCsp(csp).replace(/"/g, '&quot;')}">\n${html}`
}

/** Whether a `ui/open-link` destination may be opened for the reader. Only `http`/`https`, which
 *  is the same rule the URL-mode consent card applies — a frame must not hand the browser a
 *  `javascript:` or `data:` href, and a scheme we cannot vouch for is refused rather than tried. */
export function isOpenableAppLink(url: string): boolean {
  try {
    const scheme = new URL(url).protocol
    return scheme === 'https:' || scheme === 'http:'
  } catch {
    return false
  }
}

/** The frame's rendered height: the template's declared height, what the view reported when its
 *  height is flexible, and a floor and ceiling so neither a zero-height page nor a runaway one
 *  takes over the transcript. */
export const MCP_APP_MIN_HEIGHT = 120
export const MCP_APP_MAX_HEIGHT = 720
export const MCP_APP_DEFAULT_HEIGHT = 320

export function clampAppHeight(height: number | undefined): number {
  if (height === undefined || !Number.isFinite(height)) return MCP_APP_DEFAULT_HEIGHT
  return Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, Math.round(height)))
}
