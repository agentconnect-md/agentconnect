import type { Metadata } from 'next'
import GroupDetailView from '@/components/console/views/GroupDetailView'

export const metadata: Metadata = { title: 'Daemon group · AgentConnect' }

export default function Page() {
  return <GroupDetailView />
}
