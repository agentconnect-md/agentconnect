import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import DecisionEditorView from '@/components/console/views/DecisionEditorView'
import { LoadingState } from '@/components/marks'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Decisions.metadata')
  return { title: t('create') }
}

// DecisionEditorView reads ?returnTo and the [id] segment, so it sits under Suspense.
export default function Page() {
  return (
    <Suspense fallback={<LoadingState fill />}>
      <DecisionEditorView />
    </Suspense>
  )
}
