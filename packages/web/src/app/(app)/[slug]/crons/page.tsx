import type { Metadata } from 'next'
import CronsView from '@/components/console/views/CronsView'

export const metadata: Metadata = { title: 'Schedules · AgentConnect' }

export default function Page() {
  return <CronsView />
}
