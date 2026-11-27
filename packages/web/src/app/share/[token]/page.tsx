import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { SharedArtifactPage } from '@/components/console/artifact/SharedArtifactPage'

// A share link (artifacts.md §8.3): never indexed, and its token never leaves in a Referer.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Artifacts.sharePage')
  return { title: t('metadataTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' }
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <SharedArtifactPage token={token} />
}
