import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import OrgOnboarding from './OrgOnboarding'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Auth.metadata')
  return { title: t('welcome') }
}

export default function WelcomePage() {
  return <OrgOnboarding />
}
