import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import AzureDevOpsConnect from './AzureDevOpsConnect'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Auth.metadata')
  return { title: t('azureDevOpsConnect'), referrer: 'no-referrer' }
}

export default function AzureDevOpsConnectPage() {
  return <AzureDevOpsConnect />
}
