import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Conversation · AgentConnect' }

export default function Page() {
  // /conversations/layout owns the persistent client view; the leaf keeps the
  // dynamic URL routable with its own metadata.
  return null
}
