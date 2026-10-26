import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import CapabilityRequestView from '@/components/console/views/CapabilityRequestView'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('CapabilityRequests.metadata')
  return { title: t('title') }
}

export default function Page() {
  return <CapabilityRequestView />
}
