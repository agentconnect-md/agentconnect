import { NextResponse, type NextRequest } from 'next/server'

// URL shape: the console ALWAYS carries an org segment — `/{slug}/agents`.
// `-` is the seeded LOCAL DEFAULT org's real slug (reserved: the slug regex
// forbids a user org from taking it), so a no-auth install lives at
// `/-/agents`; hosted users live on their own slug.
//
// Entry points (`/` and hand-typed bare page paths) are normalized WITHOUT an
// ugly intermediate hop:
//   - the `ac.org` cookie (written by the org context whenever an org
//     resolves) names the last-used slug → ONE server redirect straight to
//     `/{slug}/…`;
//   - no cookie yet (first visit) → REWRITE to the default org's tree, so the
//     address bar keeps the entered URL until the client resolves the real
//     org and replaces it in one step.
// A stale cookie (renamed/removed org) is fine: the org context's
// reconciliation replaces an unknown slug with the caller's real org.
const CONSOLE_ROOTS = ['agents', 'sessions', 'daemons', 'crons', 'tools', 'usage', 'settings', 'profile']

// A real slug or the reserved `-` — anything else in the cookie is ignored
// (it goes straight into a redirect path, so validate strictly).
const SLUG_RE = /^(?:-|[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/

function lastOrgSlug(req: NextRequest): string | null {
  const raw = req.cookies.get('ac.org')?.value
  return raw && SLUG_RE.test(raw) ? raw : null
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const first = pathname.split('/')[1]!
  const isEntry = pathname === '/' || CONSOLE_ROOTS.includes(first)
  if (!isEntry) return NextResponse.next()

  const consolePath = pathname === '/' ? '/agents' : pathname
  const url = req.nextUrl.clone()
  const slug = lastOrgSlug(req)
  if (slug) {
    url.pathname = `/${slug}${consolePath}`
    return NextResponse.redirect(url)
  }
  url.pathname = `/-${consolePath}`
  return NextResponse.rewrite(url)
}

export const config = {
  // Skip static assets and Next internals; /login and /auth pass through
  // untouched (they're outside the console).
  matcher: ['/((?!_next|favicon\\.ico|icon\\.svg|apple-icon\\.png|login|auth).*)']
}
