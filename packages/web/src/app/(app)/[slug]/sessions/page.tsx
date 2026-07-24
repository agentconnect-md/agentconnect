import type { Metadata } from 'next'
import { Suspense } from 'react'
import SessionsView from '@/components/console/views/SessionsView'
import { LoadingState } from '@/components/marks'

export const metadata: Metadata = { title: 'Sessions · AgentConnect' }

// SessionsView reads ?agent/integration/channel via useSearchParams → Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <SessionsView />
    </Suspense>
  )
}
