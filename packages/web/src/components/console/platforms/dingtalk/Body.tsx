// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlatformMark } from '@/components/marks'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'
import { TokenGuidePane } from '../wizard-chrome'
import { dingTalkWalkthroughSteps } from './steps'

// The Control Plane's own Client ID rule, so a malformed paste is marked before the round trip.
const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** DingTalk's create pane (dingtalk-integration.md §5): the developer-console walkthrough, then the app's two credentials. */
export function DingTalkWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.dingtalk')
  const stepsT = useTranslations('Platforms.dingtalk.steps')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const clientIdTrim = clientId.trim()
  const clientIdOk = CLIENT_ID.test(clientIdTrim)
  const valid = clientIdOk && !!clientSecret.trim()
  async function submit() {
    if (!valid || busy.current) return
    busy.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({
        platform: 'dingtalk',
        agentId: agent.id,
        dingtalk: { clientId: clientIdTrim, clientSecret: clientSecret.trim() }
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
      mark={<PlatformMark platform="dingtalk" />}
      step1={t('step1')}
      linkHref="https://open-dev.dingtalk.com/fe/app"
      linkLabel={t('createApp')}
      steps={dingTalkWalkthroughSteps(stepsT)}
      walkthroughLabel={t('walkthroughLabel')}
      step2={t('step2')}
      fields={[
        {
          label: 'Client ID',
          placeholder: 'dingxxxxxxxxxxxxxxxx',
          value: clientId,
          invalid: clientIdTrim !== '' && !clientIdOk,
          onChange: setClientId
        },
        {
          label: 'Client Secret',
          placeholder: 'Client Secret',
          value: clientSecret,
          invalid: false,
          onChange: setClientSecret,
          secret: true
        }
      ]}
    />
  )
}
