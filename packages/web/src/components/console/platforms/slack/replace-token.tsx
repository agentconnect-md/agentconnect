// No 'use client' here: rendered only inside client boundaries (the Integrations view's Slack fragments, the agent page's Slack card).

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import type { BotDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { slackApi } from './api'
import { SlackBotTokenField, slackBotTokenOk } from './bot-token-field'

/** Paste a custom Slack app's new bot token; the bot keeps its id, integrations and conversation settings. */
export function SlackReplaceTokenModal({
  bot,
  onClose,
  onReplaced
}: {
  bot: BotDto
  onClose: () => void
  onReplaced?: (bot: BotDto) => void
}) {
  const t = useTranslations('Platforms.slack.replaceToken')
  const { refresh } = useConsoleData()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inFlight = useRef(false)
  const valid = slackBotTokenOk(token)

  const submit = async () => {
    if (inFlight.current || !valid) return
    inFlight.current = true
    setBusy(true)
    setErr(null)
    try {
      const updated = await slackApi.replaceBotToken(bot.id, token.trim())
      refresh()
      onReplaced?.(updated)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    // `contents` keeps the modal's flex column intact while Enter still submits.
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="key-round" size={15} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('title')}</span>
        <button type="button" className="iconbtn" aria-label={t('cancel')} onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <SlackBotTokenField value={token} onChange={setToken} invalid={token.trim() !== '' && !valid} autoFocus />
        {err && (
          <div role="alert" className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
            {err}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={!valid || busy}>
          {busy ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  )
}

/** The icon control that opens {@link SlackReplaceTokenModal}, highlighted while the bot is revoked (or `attention` says so). */
export function SlackReplaceTokenAction({
  bot,
  attention,
  onReplaced
}: {
  bot: BotDto
  attention?: boolean
  onReplaced?: (bot: BotDto) => void
}) {
  const t = useTranslations('Platforms.slack.replaceToken')
  const [open, setOpen] = useState(false)
  const revoked = attention ?? !!bot.revokedAt

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        className={`iconbtn h-7 w-7 flex-none ${
          revoked ? 'border-(--amber-500) bg-(--status-paused-soft) text-(--amber-500)' : ''
        }`}
        title={revoked ? t('revoked') : t('title')}
        aria-label={t('title')}
        onClick={() => setOpen(true)}
      >
        <Icon name="key-round" size={14} />
      </button>
      {open &&
        createPortal(
          // React events bubble through portals, so the host row must not see clicks made inside the dialog.
          <div className="scrim" onClick={(e) => e.stopPropagation()}>
            <div className="modal" role="dialog" aria-modal="true" aria-label={t('title')}>
              <SlackReplaceTokenModal bot={bot} onClose={() => setOpen(false)} onReplaced={onReplaced} />
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
