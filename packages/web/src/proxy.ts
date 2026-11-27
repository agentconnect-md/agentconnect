import { NextResponse, type NextRequest } from 'next/server'
import {
  contentHostConfig,
  contentHostResponse,
  contentHostRevision,
  type ContentHostConfig
} from './lib/artifact-content/content-host'

// Console URLs carry an org segment (`-` is the local default org); bare entries rewrite to `/-/…`, then OrgProvider moves to the user's server-stored org, never a cookie's.
const CONSOLE_ROOTS = [
  'home',
  'agents',
  'sessions',
  'daemons',
  'crons',
  'tools',
  'usage',
  'billing',
  'settings',
  'profile'
]

// The console refuses foreign framing, since a content-domain page may frame it under a console tab (artifacts.md §5.5).
const FRAME_HEADERS = { 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' }

function sameOriginFramesOnly(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(FRAME_HEADERS)) response.headers.set(name, value)
  return response
}

let contentConfig: { key: string; config: ContentHostConfig | undefined } | undefined

// Read from web's own environment, never from the request: the content domain and the console origin that may frame it.
function contentDomain(): ContentHostConfig | undefined {
  const key = `${process.env.ARTIFACTS_CONTENT_DOMAIN ?? ''} ${process.env.PUBLIC_WEB_URL ?? ''}`
  if (contentConfig?.key !== key) contentConfig = { key, config: contentHostConfig(process.env) }
  return contentConfig.config
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  // A content-domain host gets only the shim and the worker script (artifacts.md §5.5); nothing of the app is reachable there.
  const content = contentDomain()
  const host = req.headers.get('host') ?? ''
  if (content && contentHostRevision(host, content.domain) !== undefined) {
    const answer = contentHostResponse(content, { method: req.method, host, pathname })
    return new NextResponse(answer.body, { status: answer.status, headers: answer.headers })
  }
  const first = pathname.split('/')[1]!
  const isEntry = pathname === '/' || CONSOLE_ROOTS.includes(first)
  if (!isEntry) {
    const response = sameOriginFramesOnly(NextResponse.next())
    // A share page's address carries its token: leak it to nothing it loads, and keep it out of search (artifacts.md §8.3).
    if (first === 'share') {
      response.headers.set('Referrer-Policy', 'no-referrer')
      response.headers.set('X-Robots-Tag', 'noindex')
    }
    return response
  }

  const consolePath = pathname === '/' ? '/home' : pathname
  const url = req.nextUrl.clone()
  url.pathname = `/-${consolePath}`
  return sameOriginFramesOnly(NextResponse.rewrite(url))
}

export const config = {
  // Every path, `_next` and public files included: the content-domain branch must see them all, and the rewrite skips non-entries.
  matcher: ['/:path*']
}
