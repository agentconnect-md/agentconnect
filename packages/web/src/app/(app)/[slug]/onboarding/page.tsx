import type { Metadata } from 'next'
import OnboardingView from '@/components/console/views/OnboardingView'

export const metadata: Metadata = { title: 'Get started · AgentConnect' }

export default function Page() {
  return <OnboardingView />
}
