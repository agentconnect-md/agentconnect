import type { Metadata } from 'next'
import OrgOnboarding from './OrgOnboarding'

export const metadata: Metadata = { title: 'Get started · AgentConnect' }

export default function WelcomePage() {
  return <OrgOnboarding />
}
