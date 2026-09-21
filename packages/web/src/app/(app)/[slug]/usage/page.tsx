import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import UsageView from '@/components/console/views/UsageView'
import { LoadingState } from '@/components/marks'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Usage.metadata')
  return { title: t('title') }
}

// UsageView reads ?range via useSearchParams → Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <UsageView />
    </Suspense>
  )
}
