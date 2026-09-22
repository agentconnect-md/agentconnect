'use client'

// The built-in Slack app's reinstall — one round trip per surface — and the icon control that starts it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { ApiError, type SlackPlatformInstallStatusDto } from '@/lib/api'
import { slackApi } from './api'
import { SLACK_MISSING_SCOPES_REASON, slackMissingScopesMessage } from './install-failure'

/** How one reinstall ends, reported to the surface that started it. */
export interface SlackReinstallCallbacks {
  /** Before the authorize link is minted — the surface clears its last failure. */
  onStart?(botId: string): void
  /** The reinstall could not start, or Slack settled it unsuccessfully, as a sentence. */
  onFailed(botId: string, message: string): void
  /** Slack reauthorized this bot. */
  onInstalled(botId: string): void
}

export interface SlackReinstall {
  /** The bot whose reinstall is in flight, or null. */
  botId: string | null
  /** Starting again while one is pending replaces it with a fresh link; the abandoned row just expires. */
  start(botId: string): void
}

/** A settled-unsuccessful reinstall row, as a sentence; a short grant names what is still absent. */
export function slackReinstallFailure(
  status: Pick<SlackPlatformInstallStatusDto, 'failureReason' | 'missingScopes'>
): string {
  if (status.failureReason === 'denied') return 'The reinstall was cancelled in Slack.'
  if (status.failureReason === 'workspace_mismatch')
    return 'Slack authorized a different workspace. Try again and choose this bot’s workspace.'
  if (status.failureReason === SLACK_MISSING_SCOPES_REASON) return slackMissingScopesMessage(status.missingScopes)
  return 'Slack could not complete the reinstall. Please try again.'
}

/** Reinstall a built-in bot: mint the authorize link, open it, poll the install row to a terminal state. */
export function useSlackBuiltinReinstall(callbacks: SlackReinstallCallbacks): SlackReinstall {
  const [pending, setPending] = useState<{ botId: string; installId: string } | null>(null)
  // Callers pass fresh closures each render; a ref keeps the poll from restarting under a live reinstall.
  const latest = useRef(callbacks)
  latest.current = callbacks
  // The popup cannot report being closed (`noopener`), so a pending reinstall stays restartable; only a mint in flight is not.
  const minting = useRef(false)

  const start = useCallback(async (botId: string) => {
    if (minting.current) return
    minting.current = true
    latest.current.onStart?.(botId)
    try {
      const started = await slackApi.startPlatformInstall({ botId })
      // A new pending object restarts the poll effect, whose cleanup silences the replaced one.
      setPending({ botId, installId: started.id })
      window.open(started.installUrl, '_blank', 'noopener,width=680,height=760')
    } catch (e) {
      setPending(null)
      latest.current.onFailed(botId, e instanceof Error ? e.message : String(e))
    } finally {
      minting.current = false
    }
  }, [])

  // The ROW is the signal, not "did an integration appear": a reauthorization only rotates the token.
  useEffect(() => {
    if (!pending) return
    const { botId, installId } = pending
    let stopped = false

    const stop = () => {
      stopped = true
      clearInterval(timer)
    }
    const fail = (message: string) => {
      stop()
      setPending(null)
      latest.current.onFailed(botId, message)
    }
    const tick = async () => {
      try {
        const status = await slackApi.getPlatformInstall(installId)
        if (stopped || status.status === 'pending') return
        if (status.status === 'failed') {
          fail(slackReinstallFailure(status))
          return
        }
        if (status.botId !== botId) {
          fail('Slack reauthorized a different bot. Please try again.')
          return
        }
        stop()
        setPending(null)
        latest.current.onInstalled(botId)
      } catch (e) {
        if (!stopped && e instanceof ApiError && e.status === 404) {
          fail('This reinstall link expired. Please try again.')
        }
      }
    }

    const timer = setInterval(() => void tick(), 2500)
    void tick()
    return stop
  }, [pending])

  return useMemo<SlackReinstall>(
    () => ({ botId: pending?.botId ?? null, start: (botId) => void start(botId) }),
    [pending, start]
  )
}

/** The reinstall icon control, haloed because it only shows while the app is revoked; it spins but stays clickable while pending. */
export function SlackReinstallButton({
  busy,
  disabled = false,
  onClick
}: {
  busy: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const t = useTranslations('Platforms.slack.settings')
  return (
    <button
      type="button"
      disabled={disabled}
      title={busy ? t('reinstalling') : t('reinstall')}
      aria-label={t('reinstall')}
      onClick={onClick}
      className={`iconbtn h-7 w-7 flex-none border-(--status-error) text-(--status-error) ${
        disabled ? 'cursor-default opacity-55' : 'cursor-pointer'
      }`}
    >
      <Icon name={busy ? 'loader' : 'plug-zap'} size={14} className={busy ? 'animate-spin' : undefined} />
    </button>
  )
}
