import type { Metadata } from 'next'
import DaemonDetailView from '@/components/console/views/DaemonDetailView'

export const metadata: Metadata = { title: 'Daemon · AgentConnect' }

export default function Page() {
  return <DaemonDetailView />
}
