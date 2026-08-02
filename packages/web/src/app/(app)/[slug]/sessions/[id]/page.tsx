import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Session · AgentConnect' }

export default function Page() {
  // /sessions/layout owns the persistent client view. The leaf still exists so
  // this dynamic URL remains routable and can keep its own metadata.
  return null
}
