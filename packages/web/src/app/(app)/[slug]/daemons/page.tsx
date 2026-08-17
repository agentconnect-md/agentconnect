import type { Metadata } from 'next'
import DaemonsView from '@/components/console/views/DaemonsView'

export const metadata: Metadata = { title: 'Infra · AgentConnect' }

export default function Page() {
  return <DaemonsView />
}
