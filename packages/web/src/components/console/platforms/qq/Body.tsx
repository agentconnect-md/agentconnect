import { useRef, useState } from 'react'
import { PlatformMark } from '@/components/marks'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'
import { TokenGuidePane } from '../wizard-chrome'

export function QQWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const appIdTrim = appId.trim()
  const appIdOk = /^\d+$/.test(appIdTrim)
  const valid = appIdOk && !!appSecret.trim()
  async function submit() {
    if (!valid || busy.current) return
    busy.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({
        platform: 'qq',
        agentId: agent.id,
        qq: { appId: appIdTrim, appSecret: appSecret.trim() }
      })
      host.close()
    } catch (error) {
      host.setError(error instanceof Error ? error.message : String(error))
      busy.current = false
      setSaving(false)
    }
  }
  usePublishedFooter(host, {
    label: saving ? 'Checking credentials…' : 'Connect',
    enabled: valid && !saving,
    onSubmit: () => void submit()
  })
  if (host.mode !== 'create') return null
  return (
    <TokenGuidePane
      mark={<PlatformMark platform="qq" />}
      step1="Create a bot in the QQ developer portal, turn on private and group messages, then copy its AppID and AppSecret."
      step1Warning="Before publishing the bot, add your daemon's public IP to its IP allowlist — QQ rejects calls from other addresses."
      linkHref="https://q.qq.com/"
      linkLabel="Create QQ bot"
      step2="Paste the AppID & AppSecret — required to connect"
      fields={[
        {
          label: 'AppID',
          placeholder: '123456789',
          value: appId,
          invalid: appIdTrim !== '' && !appIdOk,
          onChange: setAppId
        },
        {
          label: 'AppSecret',
          placeholder: 'AppSecret',
          value: appSecret,
          invalid: false,
          onChange: setAppSecret,
          secret: true
        }
      ]}
    />
  )
}
