import type { Metadata } from 'next'
import NotFoundView from '@/components/console/views/NotFoundView'

export const metadata: Metadata = { title: 'Not found · AgentConnect' }

// Any path under a known org slug that doesn't match a real section (agents,
// sessions, …). Static sibling segments take routing priority, so this only
// catches genuine unknowns. Rendered within the (app) shell layout.
export default function Page() {
  return <NotFoundView />
}
