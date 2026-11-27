import type { Metadata } from 'next'
import { Suspense } from 'react'
import ArtifactsView from '@/components/console/views/ArtifactsView'
import { LoadingState } from '@/components/marks'

export const metadata: Metadata = { title: 'Artifacts · AgentConnect' }

// ArtifactsView reads its filters via useSearchParams, so it sits under Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <ArtifactsView />
    </Suspense>
  )
}
