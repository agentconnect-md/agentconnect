import type { Metadata } from 'next'
import SettingsView from '@/components/console/views/SettingsView'

export const metadata: Metadata = { title: 'Settings · AgentConnect' }

export default function Page() {
  return <SettingsView />
}
