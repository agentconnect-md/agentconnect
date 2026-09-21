import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import ActivateAccount from './ActivateAccount'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Auth.metadata')
  return { title: t('activate'), referrer: 'no-referrer' }
}

export default async function ActivatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <ActivateAccount token={token} />
}
