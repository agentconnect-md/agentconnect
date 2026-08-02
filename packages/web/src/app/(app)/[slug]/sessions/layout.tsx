import type { ReactNode } from 'react'
import { SessionsRouteFrame } from '@/components/console/SessionsRouteFrame'

// Keep the detail client mounted while only the dynamic session id changes.
// App Router preserves layouts across sibling-page navigation, so the session
// rail and the already-loaded detail shell no longer disappear and remount for
// every click in the rail.
export default function Layout({ children }: { children: ReactNode }) {
  return <SessionsRouteFrame>{children}</SessionsRouteFrame>
}
