import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import SlackConnect from './SlackConnect'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Auth.metadata')
  return { title: t('slackConnect'), referrer: 'no-referrer' }
}

export default function SlackConnectPage() {
  return <SlackConnect />
}
