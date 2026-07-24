import type { Metadata } from 'next'
import SessionDetailView from '@/components/console/views/SessionDetailView'

export const metadata: Metadata = { title: 'Session · AgentConnect' }

export default function Page() {
  return <SessionDetailView />
}
