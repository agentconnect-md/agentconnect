import type { Metadata } from 'next'
import DaemonsView from '@/components/console/views/DaemonsView'

export const metadata: Metadata = { title: 'Daemons · AgentConnect' }

export default function Page() {
  return <DaemonsView />
}
