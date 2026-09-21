import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import BillingView from '@/components/console/views/BillingView'
import { LoadingState } from '@/components/marks'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Billing.metadata')
  return { title: t('title') }
}

// BillingView reads ?checkout/purchase (the Stripe return) via useSearchParams → Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <BillingView />
    </Suspense>
  )
}
