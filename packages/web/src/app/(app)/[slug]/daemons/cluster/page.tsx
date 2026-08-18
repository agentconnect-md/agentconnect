import type { Metadata } from 'next'
import ClusterDetailView from '@/components/console/views/ClusterDetailView'

export const metadata: Metadata = { title: 'Cluster · AgentConnect' }

export default function Page() {
  return <ClusterDetailView />
}
