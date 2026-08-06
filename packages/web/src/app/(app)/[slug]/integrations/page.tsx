import type { Metadata } from 'next'
import IntegrationsView from '@/components/console/views/IntegrationsView'

export const metadata: Metadata = { title: 'Integrations · AgentConnect' }

export default function Page() {
  return <IntegrationsView />
}
