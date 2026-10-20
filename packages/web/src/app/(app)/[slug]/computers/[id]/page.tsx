import type { Metadata } from 'next'
import ComputerDetailView from '@/components/console/views/ComputerDetailView'

export const metadata: Metadata = { title: 'Computer · AgentConnect' }

export default function Page() {
  return <ComputerDetailView />
}
