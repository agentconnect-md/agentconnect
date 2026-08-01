import type { Metadata } from 'next'
import KnowledgeView from '@/components/console/views/KnowledgeView'

export const metadata: Metadata = { title: 'Knowledge · AgentConnect' }

export default function Page() {
  return <KnowledgeView />
}
