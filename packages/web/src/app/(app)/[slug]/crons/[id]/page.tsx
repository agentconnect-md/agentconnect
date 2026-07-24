import type { Metadata } from 'next'
import ScheduleDetailView from '@/components/console/views/ScheduleDetailView'

export const metadata: Metadata = { title: 'Schedule · AgentConnect' }

export default function Page() {
  return <ScheduleDetailView />
}
