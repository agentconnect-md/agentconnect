import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import MsTeamsConnectEntry from './MsTeamsConnectEntry'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Auth.metadata')
  return { title: t('msTeamsConnect'), referrer: 'no-referrer' }
}

export default function MsTeamsConnectPage() {
  return <MsTeamsConnectEntry />
}
