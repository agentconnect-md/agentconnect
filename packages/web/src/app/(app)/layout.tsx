import type { ReactNode } from 'react'
import ConsoleShell from '@/components/console/Shell'
import { DOCK_WIDTH_INIT } from '@/components/console/dock/dock-width'
import { THEME_INIT } from '@/lib/theme'

// Shared shell for every console route (sidebar, top bar, providers, auth gate) — /login and /auth/callback live outside this group, so they render bare — mounted deliberately ABOVE the `[slug]` segment, since a shell at `[slug]/layout` would REMOUNT on every org switch, tearing down the providers and re-running the auth gate, while one level up only the page subtree re-renders.

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Set the stored or system dark theme before first paint so a dark console does not flash light; the shell keeps it in sync (lib/theme). */}
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      {/* Same no-FOUC trick for the session dock's reserved track: the width lives in localStorage, which SSR cannot read, and a mismatched inline style is one React 19 will not patch. */}
      <script dangerouslySetInnerHTML={{ __html: DOCK_WIDTH_INIT }} />
      <ConsoleShell>{children}</ConsoleShell>
    </>
  )
}
