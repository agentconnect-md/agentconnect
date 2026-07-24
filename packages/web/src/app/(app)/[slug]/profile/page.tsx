import type { Metadata } from 'next'
import ProfileView from '@/components/console/views/ProfileView'

export const metadata: Metadata = { title: 'Profile · AgentConnect' }

export default function Page() {
  return <ProfileView />
}
