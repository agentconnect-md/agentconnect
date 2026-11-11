import type { Metadata } from 'next'
import GoogleChatRecovery from './GoogleChatRecovery'

export const metadata: Metadata = { referrer: 'no-referrer' }

export default function GoogleChatRecoveryPage() {
  return <GoogleChatRecovery />
}
