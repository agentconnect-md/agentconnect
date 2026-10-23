import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import MsTeamsConnect from './MsTeamsConnect'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Auth.metadata')
  return { title: t('msTeamsConnect'), referrer: 'no-referrer' }
}

export default function MsTeamsConnectPage() {
  return <MsTeamsConnect />
}
