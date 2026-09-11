/**
 * Reading the MCP Apps extension off what an upstream server declares (SEP-1865, Final
 * 2026-01-26) — the pure half of the daemon's Apps host (webchat-mcp-apps.md §3).
 *
 * Everything here takes `unknown` and narrows, because every input is another vendor's `_meta`.
 * A malformed declaration yields `undefined` rather than throwing: a server that describes its
 * interface wrongly should lose the interface, not the tool. The tool still runs and its text
 * result still reaches the model, which is the same closed failure the card's wire skew takes.
 */
import { McpAppCsp, McpAppDimensions } from '@agentconnect.md/protocol'

/** The extension key hosts advertise and servers gate their UI tools on. */
export const MCP_APP_UI_EXTENSION = 'io.modelcontextprotocol/ui'

/** The one mime type this version of the extension defines. A resource that is not this is not
 *  an app template, however `ui://` its uri looks. */
export const MCP_APP_MIME = 'text/html;profile=mcp-app'

/** The scheme reserved for app templates. Checked as well as the mime type: the pair is what the
 *  spec reserves, and half of it is a resource that merely resembles one. */
export const MCP_APP_URI_SCHEME = 'ui://'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The `_meta.ui` block of a tool or resource, if it has one. */
function uiMeta(carrier: unknown): Record<string, unknown> | undefined {
  const meta = record(record(carrier)?._meta)
  return meta ? record(meta.ui) : undefined
}

/**
 * The template a tool declares, or undefined when it declares none — which is the ordinary case
 * and the reason this returns rather than throws: most tools on a UI-capable server have no
 * interface at all, and they must keep working exactly as they do today.
 *
 * Both spellings are read. The nested `_meta.ui.resourceUri` is the current one; the flat
 * `_meta["ui/resourceUri"]` is deprecated and slated for removal before GA, so it is accepted
 * but never preferred — a server mid-migration that sets both is taken at its nested word.
 */
export function appTemplateUri(tool: unknown): string | undefined {
  const nested = uiMeta(tool)?.resourceUri
  const flat = record(record(tool)?._meta)?.['ui/resourceUri']
  const uri = typeof nested === 'string' ? nested : typeof flat === 'string' ? flat : undefined
  return uri && uri.startsWith(MCP_APP_URI_SCHEME) ? uri : undefined
}

/**
 * Whether the tool's RESULT is meant for the model as well as the view. `visibility: ["app"]`
 * alone says the payload is the interface's, not the transcript's — so the model gets the fact
 * that an interface opened and not the body behind it.
 *
 * Absent ⇒ both, which is the spec's default and the conservative one here for a reason worth
 * naming: a result withheld from a model that expected it leaves the agent unable to answer at
 * all, whereas a result shown to a model that did not need it is merely redundant.
 */
export function appResultVisibleToModel(tool: unknown): boolean {
  const visibility = uiMeta(tool)?.visibility
  if (!Array.isArray(visibility)) return true
  return visibility.includes('model')
}

const DOMAIN_KEYS = [
  ['connect', 'connectDomains'],
  ['resource', 'resourceDomains'],
  ['frame', 'frameDomains'],
  ['baseUri', 'baseUriDomains']
] as const

/**
 * The domain allowlists a template declares, as the card carries them. Only `https` origins and
 * bare hostnames are kept: a `http:` entry would downgrade the frame's whole directive, and a
 * wildcard would make the declaration meaningless — the spec's rule is that a host MUST NOT
 * admit an undeclared domain, and `*` declares nothing while admitting everything.
 */
export function appCsp(resource: unknown): McpAppCsp | undefined {
  const csp = record(uiMeta(resource)?.csp)
  if (!csp) return undefined
  const out: Record<string, string[]> = {}
  for (const [field, key] of DOMAIN_KEYS) {
    const raw = csp[key]
    if (!Array.isArray(raw)) continue
    const kept = raw.filter((d): d is string => typeof d === 'string' && isDeclarableDomain(d))
    if (kept.length > 0) out[field] = kept.slice(0, 32)
  }
  const parsed = McpAppCsp.safeParse(out)
  return parsed.success && Object.keys(out).length > 0 ? parsed.data : undefined
}

/** One declarable CSP source: an `https://host` origin or a bare host, with no wildcard, no
 *  path, no credentials and no port trickery. Anything else is dropped rather than repaired. */
export function isDeclarableDomain(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.includes('*')) return false
  const candidate = value.includes('://') ? value : `https://${value}`
  if (!candidate.startsWith('https://')) return false
  try {
    const url = new URL(candidate)
    return url.username === '' && url.password === '' && (url.pathname === '/' || url.pathname === '')
  } catch {
    return false
  }
}

/** The container size a template asks for, read from either the resource's or the result's
 *  `_meta.ui` — the extension puts it on the declaration, but a result that restates it is
 *  taken too, since an app whose size depends on what it just fetched has nowhere else to say so. */
export function appDimensions(...carriers: unknown[]): McpAppDimensions | undefined {
  for (const carrier of carriers) {
    const dims = record(uiMeta(carrier)?.containerDimensions)
    if (!dims) continue
    const parsed = McpAppDimensions.safeParse(dims)
    if (parsed.success && Object.keys(parsed.data).length > 0) return parsed.data
  }
  return undefined
}

/** Whether a listed resource is actually an app template: the reserved scheme AND the one mime
 *  type the extension defines, compared without the spacing a server may or may not emit. */
export function isAppTemplate(resource: unknown): boolean {
  const r = record(resource)
  const uri = r?.uri
  const mime = r?.mimeType
  if (typeof uri !== 'string' || !uri.startsWith(MCP_APP_URI_SCHEME)) return false
  return typeof mime === 'string' && mime.replace(/\s+/g, '').toLowerCase() === MCP_APP_MIME
}

/** The template text out of a `resources/read` result, or undefined when the read returned
 *  something that is not one document of HTML — several contents, a blob, a different mime. */
export function appTemplateText(read: unknown): string | undefined {
  const contents = record(read)?.contents
  if (!Array.isArray(contents) || contents.length !== 1) return undefined
  const only = record(contents[0])
  if (!only || !isAppTemplate(only)) return undefined
  return typeof only.text === 'string' ? only.text : undefined
}
