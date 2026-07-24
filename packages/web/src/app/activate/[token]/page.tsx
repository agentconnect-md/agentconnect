import type { Metadata } from 'next'
import ActivateAccount from './ActivateAccount'

export const metadata: Metadata = {
  title: 'Activate account · AgentConnect',
  referrer: 'no-referrer'
}

export default async function ActivatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <ActivateAccount token={token} />
}
