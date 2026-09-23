import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import BotRoutingView from '@/components/console/views/BotRoutingView'
import { LoadingState } from '@/components/marks'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Decisions.routing.metadata')
  return { title: t('title') }
}

// BotRoutingView reads the [botId] segment and search params (inline create returns here), so it sits under Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <BotRoutingView />
    </Suspense>
  )
}
