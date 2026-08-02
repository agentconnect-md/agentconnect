import type { ReactNode } from 'react'
import { SessionsRouteFrame } from '@/components/console/SessionsRouteFrame'

// Mirror of /sessions/layout: the persistent client frame mounts the merged
// conversation view (merged-conversation-view.md §5.3) and survives key-to-key
// navigation without remounting.
export default function Layout({ children }: { children: ReactNode }) {
  return <SessionsRouteFrame>{children}</SessionsRouteFrame>
}
