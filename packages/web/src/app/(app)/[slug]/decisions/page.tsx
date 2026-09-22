import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import DecisionsView from '@/components/console/views/DecisionsView'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Decisions.metadata')
  return { title: t('title') }
}

export default function Page() {
  return <DecisionsView />
}
