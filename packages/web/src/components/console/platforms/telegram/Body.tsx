// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { PlatformMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { checkTelegramBot, type TelegramBotCheckDto } from '@/lib/api'
import type { Agent } from '@/lib/data'
import { randomUuid } from '@/lib/random-uuid'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'
import { TokenGuidePane } from '../wizard-chrome'
import { useTelegramPrivacyAutoRefresh } from './privacy-auto-refresh'
import { telegramWalkthroughSteps } from './steps'

type TelegramCheckState = 'idle' | 'checking' | TelegramBotCheckDto['status']
const TELEGRAM_CHECK_DEBOUNCE_MS = 350

type TelegramPrivacyTranslator = ReturnType<typeof useTranslations<'Platforms.telegram.privacy'>>

// The probe's outcome, as the sentence a reader needs. `checking` covers both a token
// too short to probe yet and a probe in flight — the reader's next action is the same.
const PRIVACY_MESSAGE_KEY: Record<TelegramCheckState, Parameters<TelegramPrivacyTranslator>[0]> = {
  idle: 'checking',
  checking: 'checking',
  ready: 'ready',
  privacy_enabled: 'privacyEnabled',
  invalid: 'invalid',
  unreachable: 'unreachable'
}

function TelegramPrivacyStatus({
  status,
  refreshing,
  onRetry
}: {
  status: TelegramCheckState
  refreshing: boolean
  onRetry: () => void
}) {
  const t = useTranslations('Platforms.telegram.privacy')
  if (status === 'idle') return null
  const checking = status === 'checking'
  const ready = status === 'ready'
  const message = t(PRIVACY_MESSAGE_KEY[status])
  const retryable = status === 'privacy_enabled' || status === 'unreachable'

  return (
    <div
      aria-live="polite"
      className={`mt-2 flex items-start gap-2 rounded-md border px-[10px] py-2 font-sans text-[11.5px] font-normal leading-[1.5] ${
        ready
          ? 'border-(--status-online) bg-(--status-online-soft) text-(--text-secondary)'
          : checking
            ? 'border-(--border-default) bg-(--status-info-soft) text-(--text-secondary)'
            : 'border-(--status-error) bg-(--status-error-soft) text-(--status-error)'
      }`}
    >
      <Icon
        name={checking ? 'loader' : ready ? 'circle-check' : 'triangle-alert'}
        size={14}
        color={ready ? 'var(--status-online)' : checking ? 'var(--status-info)' : 'var(--status-error)'}
        className={`mt-[1px] flex-none ${checking ? 'animate-spin' : ''}`}
      />
      <span className="min-w-0 flex-1">{message}</span>
      {retryable && (
        <button
          type="button"
          disabled={refreshing}
          className="inline-flex flex-none cursor-pointer items-center gap-[5px] border-0 bg-transparent p-0 font-sans text-[11.5px] font-semibold leading-[1.5] text-(--text-secondary) hover:text-(--text-primary) disabled:cursor-wait"
          onClick={onRetry}
        >
          <Icon name="refresh-cw" size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? t('checkingNow') : status === 'privacy_enabled' ? t('checkNow') : t('tryAgain')}
        </button>
      )}
    </div>
  )
}

/**
 * Telegram's create-mode pane: the @BotFather walkthrough, one bot token, and
 * the debounced getMe/Privacy-Mode probe that gates the footer — a Telegram bot
 * with Privacy Mode on never sees ordinary group messages, so connecting one is
 * a silent dead end and the primary stays disabled until the probe says ready.
 */
export function TelegramWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.telegram')
  const tokenT = useTranslations('Platforms.chrome.token')
  const [botToken, setBotToken] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  // Synchronous re-entry guard: `saving` commits on the NEXT render, so a fast
  // double-click would fire two creates in the same tick.
  const busyRef = useRef(false)

  const tokenTrim = botToken.trim()
  const telegramOk = /^\d+:[A-Za-z0-9_-]{20,}$/.test(tokenTrim)

  const [checkScope] = useState(randomUuid)
  const checkSequence = useRef(0)
  const [checkRequest, setCheckRequest] = useState<{ token: string; sequence: number } | null>(null)
  const checkEnabled = host.mode === 'create' && telegramOk
  useEffect(() => {
    if (!checkEnabled || host.mockMode) {
      setCheckRequest(null)
      return
    }
    const timer = window.setTimeout(() => {
      checkSequence.current += 1
      setCheckRequest({ token: tokenTrim, sequence: checkSequence.current })
    }, TELEGRAM_CHECK_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [checkEnabled, host.mockMode, tokenTrim])
  const checkKey =
    checkEnabled && !host.mockMode && checkRequest?.token === tokenTrim
      ? ['telegram-bot-check', agent.id, checkScope, checkRequest.sequence]
      : null
  const {
    data: checkData,
    error: checkError,
    isValidating: checkRefreshing,
    mutate: refreshCheck
  } = useSWR<TelegramBotCheckDto>(checkKey, () => checkTelegramBot(checkRequest!.token), {
    revalidateOnFocus: false,
    shouldRetryOnError: false
  })
  const check: TelegramCheckState = !checkEnabled
    ? 'idle'
    : host.mockMode
      ? 'ready'
      : checkRequest?.token !== tokenTrim
        ? 'checking'
        : checkError
          ? 'unreachable'
          : (checkData?.status ?? 'checking')
  useTelegramPrivacyAutoRefresh(check === 'privacy_enabled', refreshCheck)

  const valid = telegramOk && check === 'ready'

  const submit = async () => {
    setShowErrors(true)
    if (busyRef.current || !valid) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({ platform: 'telegram', agentId: agent.id, telegram: { botToken: tokenTrim } })
      host.close()
    } catch (e) {
      host.setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
      busyRef.current = false
    }
  }

  usePublishedFooter(host, {
    label: saving ? t('footer.connecting') : t('footer.connect'),
    enabled: valid && !saving,
    onSubmit: () => void submit()
  })

  if (host.mode !== 'create') return null

  return (
    <TokenGuidePane
      mark={<PlatformMark platform="telegram" />}
      step1={t('guide.step1')}
      step1Warning={check === 'ready' ? undefined : t('guide.step1Warning')}
      linkHref="https://t.me/BotFather"
      linkLabel={t('guide.link')}
      steps={telegramWalkthroughSteps(t)}
      walkthroughLabel={t('guide.walkthroughLabel')}
      step2={tokenT('prompt')}
      fields={[
        {
          label: tokenT('label'),
          placeholder: t('guide.tokenPlaceholder'),
          value: botToken,
          invalid:
            (showErrors && !telegramOk) ||
            check === 'privacy_enabled' ||
            check === 'invalid' ||
            check === 'unreachable',
          onChange: setBotToken
        }
      ]}
    >
      <TelegramPrivacyStatus
        status={check}
        refreshing={check !== 'checking' && checkRefreshing}
        onRetry={() => void refreshCheck().catch(() => undefined)}
      />
    </TokenGuidePane>
  )
}
