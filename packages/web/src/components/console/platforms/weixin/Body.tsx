import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlatformMark } from '@/components/marks'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'
import { TokenGuidePane } from '../wizard-chrome'

export function WeixinWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.weixin')
  const [accountId, setAccountId] = useState('')
  const [botToken, setBotToken] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const valid = !!accountId.trim() && !!botToken.trim()
  async function submit() {
    if (!valid || busy.current) return
    busy.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({
        platform: 'weixin',
        agentId: agent.id,
        weixin: { accountId: accountId.trim(), botToken: botToken.trim() }
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
      mark={<PlatformMark platform="weixin" />}
      step1={t('step1')}
      step1Warning={t('step1Warning')}
      linkHref="https://github.com/wong2/weixin-agent-sdk"
      linkLabel={t('loginCli')}
      step2={t('step2')}
      fields={[
        {
          label: 'Account ID',
          placeholder: 'xxxxxxxx-im-bot',
          value: accountId,
          invalid: false,
          onChange: setAccountId
        },
        {
          label: 'Bot Token',
          placeholder: 'Bot Token',
          value: botToken,
          invalid: false,
          onChange: setBotToken,
          secret: true
        }
      ]}
    />
  )
}
