import type { ReactNode } from 'react'
import ConsoleShell from '@/components/console/Shell'
import { THEME_KEY } from '@/lib/theme'

// Shared shell for every console route (sidebar, top bar, providers, auth gate).
// /login and /auth/callback live outside this route group, so they render bare.
//
// This layout deliberately sits ABOVE the `[slug]` segment (as `(app)/layout`,
// not `(app)/[slug]/layout`). A layout only persists across navigations that
// leave its own segment untouched — switching org changes `[slug]`, so a shell
// hosted at `[slug]/layout` would REMOUNT on every org switch, tearing down the
// providers and re-running the auth gate (a full-page spinner flash). Hosted one
// level up, the shell — auth gate, org list, data provider — persists across the
// slug change; only the page subtree below re-renders with the new org's data.

// Set the persisted dark theme on <html> before first paint so a hard reload of a
// dark-mode console doesn't flash light. Scoped to this group (login stays bare);
// the shell keeps it in sync at runtime and clears it on unmount (lib/theme).
const THEME_INIT = `try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}`

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      <ConsoleShell>{children}</ConsoleShell>
    </>
  )
}
