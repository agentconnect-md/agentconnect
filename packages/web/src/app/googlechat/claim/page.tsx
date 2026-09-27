import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import GoogleChatClaim from './GoogleChatClaim'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Auth.metadata')
  return { title: t('googleChatClaim'), referrer: 'no-referrer' }
}

export default function GoogleChatClaimPage() {
  return <GoogleChatClaim />
}
