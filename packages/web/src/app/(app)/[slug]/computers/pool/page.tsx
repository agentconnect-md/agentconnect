import type { Metadata } from 'next'
import ComputerPoolView from '@/components/console/views/ComputerPoolView'

export const metadata: Metadata = { title: 'Computer pool · AgentConnect' }

export default function Page() {
  return <ComputerPoolView />
}
