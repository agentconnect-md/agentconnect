import type { Metadata } from 'next'
import { Suspense } from 'react'
import OutOfCreditsView from '@/components/console/views/OutOfCreditsView'
import { LoadingState } from '@/components/marks'

export const metadata: Metadata = { title: 'Credits · AgentConnect' }

// OutOfCreditsView reads ?code via useSearchParams, so it must sit under Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <OutOfCreditsView />
    </Suspense>
  )
}
