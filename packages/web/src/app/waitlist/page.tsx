import type { Metadata } from 'next'
import Waitlist from './Waitlist'

export const metadata: Metadata = {
  title: 'Waitlist · AgentConnect',
  referrer: 'no-referrer'
}

export default function WaitlistPage() {
  return <Waitlist />
}
