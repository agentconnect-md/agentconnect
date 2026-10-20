import type { Metadata } from 'next'
import ComputersView from '@/components/console/views/ComputersView'

export const metadata: Metadata = { title: 'Computers · AgentConnect' }

export default function Page() {
  return <ComputersView />
}
