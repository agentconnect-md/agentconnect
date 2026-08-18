import type { Metadata } from 'next'
import { Suspense } from 'react'
import BillingView from '@/components/console/views/BillingView'
import { LoadingState } from '@/components/marks'

export const metadata: Metadata = { title: 'Billing · AgentConnect' }

// BillingView reads ?checkout/purchase (the Stripe return) via useSearchParams → Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <BillingView />
    </Suspense>
  )
}
