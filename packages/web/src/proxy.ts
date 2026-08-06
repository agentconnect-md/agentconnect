import { NextResponse, type NextRequest } from 'next/server'

// URL shape: the console ALWAYS carries an org segment — `/{slug}/agents`.
// `-` is the seeded LOCAL DEFAULT org's real slug (reserved: the slug regex
// forbids a user org from taking it), so a no-auth install lives at
// `/-/agents`; hosted users live on their own slug.
//
// Entry points (`/` and hand-typed bare page paths) are rewritten to the
// default org's tree while the address bar keeps the entered URL. OrgProvider
// then resolves the signed-in user's server-stored preference and replaces the
// URL in one step. A browser-wide cookie cannot drive this choice: it would
// leak one account's last org into another account and drift across devices.
const CONSOLE_ROOTS = ['home', 'agents', 'sessions', 'daemons', 'crons', 'tools', 'usage', 'settings', 'profile']

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const first = pathname.split('/')[1]!
  const isEntry = pathname === '/' || CONSOLE_ROOTS.includes(first)
  if (!isEntry) return NextResponse.next()

  const consolePath = pathname === '/' ? '/home' : pathname
  const url = req.nextUrl.clone()
  url.pathname = `/-${consolePath}`
  return NextResponse.rewrite(url)
}

export const config = {
  // Skip static assets and Next internals. /login and /auth bypass the console rewrite above.
  matcher: ['/((?!_next|favicon\\.ico|icon\\.svg|apple-icon\\.png).*)']
}
