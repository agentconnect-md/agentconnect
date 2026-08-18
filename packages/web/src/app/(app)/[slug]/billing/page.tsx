import type { Metadata } from 'next'
import BillingView from '@/components/console/views/BillingView'

export const metadata: Metadata = { title: 'Billing · AgentConnect' }

export default function Page() {
  return <BillingView />
}
