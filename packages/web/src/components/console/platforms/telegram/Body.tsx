// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { PlatformMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { checkTelegramBot, type TelegramBotCheckDto } from '@/lib/api'
import { randomUUID } from '@/lib/random-id'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'
import { TokenGuidePane } from '../wizard-chrome'
import { useTelegramPrivacyAutoRefresh } from './privacy-auto-refresh'
import { TG_STEPS } from './steps'

type TelegramCheckState = 'idle' | 'checking' | TelegramBotCheckDto['status']
const TELEGRAM_CHECK_DEBOUNCE_MS = 350

function TelegramPrivacyStatus({
  status,
  refreshing,
  onRetry
}: {
  status: TelegramCheckState
  refreshing: boolean
  onRetry: () => void
}) {
  if (status === 'idle') return null
  const checking = status === 'checking'
  const ready = status === 'ready'
  const message =
    status === 'checking'
      ? 'Checking the token and Privacy Mode…'
      : status === 'ready'
        ? 'Privacy Mode is off. This bot can receive ordinary group messages.'
        : status === 'privacy_enabled'
          ? 'Privacy Mode is still on. Disable it in @BotFather. Checking automatically.'
          : status === 'invalid'
            ? 'Telegram rejected this token. Copy it again from @BotFather.'
            : 'AgentConnect could not reach Telegram. Try the check again.'
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
          {refreshing ? 'Checking…' : status === 'privacy_enabled' ? 'Check now' : 'Try again'}
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
  const [botToken, setBotToken] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  // Synchronous re-entry guard: `saving` commits on the NEXT render, so a fast
  // double-click would fire two creates in the same tick.
  const busyRef = useRef(false)

  const tokenTrim = botToken.trim()
  const telegramOk = /^\d+:[A-Za-z0-9_-]{20,}$/.test(tokenTrim)

  const [checkScope] = useState(() => randomUUID())
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
    label: saving ? 'Connecting…' : 'Connect & authorize',
    enabled: valid && !saving,
    onSubmit: () => void submit()
  })

  if (host.mode !== 'create') return null

  return (
    <TokenGuidePane
      mark={<PlatformMark platform="telegram" />}
      step1="Open @BotFather → New bot (or send /newbot), give it a display name and a username ending in “bot” — it hands back the token."
      step1Warning={
        check === 'ready'
          ? undefined
          : 'In @BotFather, send /setprivacy, select this bot and choose Disable. AgentConnect checks it after you paste the token.'
      }
      linkHref="https://t.me/BotFather"
      linkLabel="Open @BotFather"
      steps={TG_STEPS}
      walkthroughLabel="Telegram bot setup steps"
      tokenPlaceholder="123456789:AAE…"
      tokenValue={botToken}
      tokenInvalid={
        (showErrors && !telegramOk) || check === 'privacy_enabled' || check === 'invalid' || check === 'unreachable'
      }
      onTokenChange={setBotToken}
    >
      <TelegramPrivacyStatus
        status={check}
        refreshing={check !== 'checking' && checkRefreshing}
        onRetry={() => void refreshCheck().catch(() => undefined)}
      />
    </TokenGuidePane>
  )
}
