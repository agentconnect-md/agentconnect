// Web's answer on the artifact content domain (artifacts.md §5.5): the shim and the worker script, 404 for everything else.
import { SHIM_PATH, WORKER_PATH } from './protocol'
import { shimDocument } from './shim'
import { workerScript } from './worker'

export interface ContentHostConfig {
  /** The bare content domain, lower-case. */
  domain: string
  /** The console's origin, the only one allowed to frame the shim; undefined leaves the content domain answering 404 only. */
  consoleOrigin: string | undefined
}

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const LABEL_RE = /^a([0-9a-f]{32})r([1-9][0-9]{0,8})$/

/** The content domain and console origin from web's own environment; undefined without a well-formed content domain. */
export function contentHostConfig(env: Record<string, string | undefined>): ContentHostConfig | undefined {
  const domain = env.ARTIFACTS_CONTENT_DOMAIN?.trim().toLowerCase().replace(/\.$/, '')
  if (!domain || !DOMAIN_RE.test(domain)) return undefined
  let consoleOrigin: string | undefined
  try {
    const url = new URL(env.PUBLIC_WEB_URL ?? '')
    if (url.protocol === 'https:' || url.protocol === 'http:') consoleOrigin = url.origin
  } catch {}
  return { domain, consoleOrigin }
}

/** The revision a content host names, `null` for a malformed label, or undefined when the host is not on the content domain. */
export function contentHostRevision(
  host: string,
  domain: string
): { artifactId: string; revision: number } | null | undefined {
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  if (name === domain) return null
  if (!name.endsWith(`.${domain}`)) return undefined
  const match = LABEL_RE.exec(name.slice(0, -domain.length - 1))
  if (!match) return null
  const hex = match[1]!
  const artifactId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return { artifactId, revision: Number(match[2]) }
}

/** The origin revision `revision` of artifact `artifactId` renders at. */
export function artifactContentOrigin(artifactId: string, revision: number, domain: string): string {
  return `https://a${artifactId.replaceAll('-', '').toLowerCase()}r${revision}.${domain}`
}

export interface ContentResponse {
  status: number
  headers: Record<string, string>
  body: string | null
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
}

const NOT_FOUND: ContentResponse = {
  status: 404,
  headers: {
    ...BASE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
  },
  body: 'Not found'
}

const rendered = new Map<string, { shim: ContentResponse; worker: ContentResponse }>()

function renderFor(consoleOrigin: string) {
  let hit = rendered.get(consoleOrigin)
  if (!hit) {
    const { html, csp } = shimDocument(consoleOrigin)
    hit = {
      shim: {
        status: 200,
        headers: { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp },
        body: html
      },
      // The script lives under /__ac/, so scope `/` needs Service-Worker-Allowed; the worker itself fetches nothing.
      worker: {
        status: 200,
        headers: {
          ...BASE_HEADERS,
          'Content-Type': 'text/javascript; charset=utf-8',
          'Service-Worker-Allowed': '/',
          'Content-Security-Policy': "default-src 'none'"
        },
        body: workerScript(consoleOrigin)
      }
    }
    rendered.set(consoleOrigin, hit)
  }
  return hit
}

/** The answer for a request to a content host: the shim and worker on a well-formed revision host, 404 otherwise. */
export function contentHostResponse(
  config: ContentHostConfig,
  request: { method: string; host: string; pathname: string }
): ContentResponse {
  const read = request.method === 'GET' || request.method === 'HEAD'
  const revision = contentHostRevision(request.host, config.domain)
  if (!read || !revision || !config.consoleOrigin) return NOT_FOUND
  const files = renderFor(config.consoleOrigin)
  const hit = request.pathname === SHIM_PATH ? files.shim : request.pathname === WORKER_PATH ? files.worker : NOT_FOUND
  return request.method === 'HEAD' ? { ...hit, body: null } : hit
}
