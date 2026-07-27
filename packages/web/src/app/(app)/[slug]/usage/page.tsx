import type { Metadata } from 'next'
import { Suspense } from 'react'
import UsageView from '@/components/console/views/UsageView'
import { LoadingState } from '@/components/marks'

export const metadata: Metadata = { title: 'Analytics · AgentConnect' }

// UsageView reads ?range via useSearchParams → Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <UsageView />
    </Suspense>
  )
}
