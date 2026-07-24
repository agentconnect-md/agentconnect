import type { Metadata } from 'next'
import AgentsView from '@/components/console/views/AgentsView'

export const metadata: Metadata = { title: 'Agents · AgentConnect' }

export default function Page() {
  return <AgentsView />
}
