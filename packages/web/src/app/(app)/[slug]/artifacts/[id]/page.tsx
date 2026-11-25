import type { Metadata } from 'next'
import { Suspense } from 'react'
import ArtifactView from '@/components/console/views/ArtifactView'
import { LoadingState } from '@/components/marks'

export const metadata: Metadata = { title: 'Artifact · AgentConnect' }

// ArtifactView reads ?revision via useSearchParams, so it sits under Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <ArtifactView />
    </Suspense>
  )
}
