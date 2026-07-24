import type { Metadata } from 'next'
import JoinOrganization from './JoinOrganization'

export const metadata: Metadata = {
  title: 'Join organization · AgentConnect',
  referrer: 'no-referrer'
}

export default async function JoinOrganizationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <JoinOrganization token={token} />
}
