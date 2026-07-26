import type { Metadata } from 'next'
import KnowledgeHubView from '@/components/console/views/KnowledgeHubView'

export const metadata: Metadata = { title: 'Tools & Skills · AgentConnect' }

export default function Page() {
  return <KnowledgeHubView />
}
