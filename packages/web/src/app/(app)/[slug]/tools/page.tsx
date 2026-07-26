import type { Metadata } from 'next'
import ToolsHubView from '@/components/console/views/ToolsHubView'

export const metadata: Metadata = { title: 'Tools & Skills · AgentConnect' }

export default function Page() {
  return <ToolsHubView />
}
