import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import Waitlist from './Waitlist'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Auth.metadata')
  return { title: t('waitlist'), referrer: 'no-referrer' }
}

export default function WaitlistPage() {
  return <Waitlist />
}
