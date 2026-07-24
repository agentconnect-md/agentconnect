import type { Metadata } from 'next'
import { Suspense } from 'react'
import AgentDetailView from '@/components/console/views/AgentDetailView'
import { LoadingState } from '@/components/marks'

export const metadata: Metadata = { title: 'Agent · AgentConnect' }

// AgentDetailView reads ?tab via useSearchParams, so it must sit under Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <AgentDetailView />
    </Suspense>
  )
}
