// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlatformMark } from '@/components/marks'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'
import { TokenGuidePane } from '../wizard-chrome'

// The Control Plane's own BotID rule, so a malformed paste is marked before the round trip.
const BOT_ID = /^\S{1,128}$/

// The WeCom admin console, where an organization admin creates the smart bot.
export const WECOM_ADMIN_CONSOLE_URL = 'https://work.weixin.qq.com/wework_admin/frame'

// The create route's own duplicate fence answers a racing install with a 409 that carries only this message.
const ALREADY_INSTALLED_MESSAGE = 'This WeCom bot is already installed. Reuse the existing bot.'

type ErrorKey = 'invalidCredentials' | 'longConnectionDisabled' | 'checkUnavailable' | 'alreadyInstalled'

/** The localized sentence for a refusal the Console can explain better than the Control Plane's English. */
function errorKey(error: unknown): ErrorKey | null {
  if (!(error instanceof ApiError)) return null
  if (error.code === 'WECOM_CREDENTIALS_INVALID') return 'invalidCredentials'
  if (error.code === 'WECOM_LONG_CONNECTION_DISABLED') return 'longConnectionDisabled'
  if (error.code === 'WECOM_CHECK_UNAVAILABLE') return 'checkUnavailable'
  if (error.code === 'WECOM_BOT_ALREADY_INSTALLED') return 'alreadyInstalled'
  if (error.status === 409 && error.message === ALREADY_INSTALLED_MESSAGE) return 'alreadyInstalled'
  return null
}

/** WeCom's create pane: create a smart bot in long-connection mode, then paste its BotID and Secret. */
export function WeComWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.wecom')
  const [botId, setBotId] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const botIdTrim = botId.trim()
  const botIdOk = BOT_ID.test(botIdTrim)
  const valid = botIdOk && !!secret.trim()
  async function submit() {
    if (!valid || busy.current) return
    busy.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({
        platform: 'wecom',
        agentId: agent.id,
        wecom: { botId: botIdTrim, secret: secret.trim() }
      })
      host.close()
    } catch (error) {
      const key = errorKey(error)
      host.setError(key ? t(`errors.${key}`) : error instanceof Error ? error.message : String(error))
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
      mark={<PlatformMark platform="wecom" />}
      step1={t('step1')}
      linkHref={WECOM_ADMIN_CONSOLE_URL}
      linkLabel={t('openConsole')}
      step2={t('step2')}
      fields={[
        {
          label: 'BotID',
          placeholder: 'BotID',
          value: botId,
          invalid: botIdTrim !== '' && !botIdOk,
          onChange: setBotId
        },
        {
          label: 'Secret',
          placeholder: 'Secret',
          value: secret,
          invalid: false,
          onChange: setSecret,
          secret: true
        }
      ]}
    />
  )
}
