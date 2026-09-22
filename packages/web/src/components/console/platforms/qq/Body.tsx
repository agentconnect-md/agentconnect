import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlatformMark } from '@/components/marks'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'
import { TokenGuidePane } from '../wizard-chrome'

export function QQWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.qq')
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
    label: saving ? t('checking') : t('connect'),
    enabled: valid && !saving,
    onSubmit: () => void submit()
  })
  if (host.mode !== 'create') return null
  return (
    <TokenGuidePane
      mark={<PlatformMark platform="qq" />}
      step1={t('step1')}
      step1Warning={t('step1Warning')}
      linkHref="https://q.qq.com/"
      linkLabel={t('createBot')}
      step2={t('step2')}
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
