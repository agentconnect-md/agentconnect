import type { Metadata } from 'next'
import { Suspense } from 'react'
import HomeView from '@/components/console/views/HomeView'
import { LoadingState } from '@/components/marks'

export const metadata: Metadata = { title: 'Home · AgentConnect' }

export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <HomeView />
    </Suspense>
  )
}
