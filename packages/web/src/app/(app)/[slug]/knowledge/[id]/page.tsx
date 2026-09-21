import type { Metadata } from 'next'
import KnowledgeDetailView from '@/components/console/views/KnowledgeDetailView'

export const metadata: Metadata = { title: 'Knowledge · AgentConnect' }

export default function Page() {
  return <KnowledgeDetailView />
}
