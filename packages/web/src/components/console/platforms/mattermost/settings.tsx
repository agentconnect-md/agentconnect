// No 'use client' here: rendered only inside the Settings view's client tree.

import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ApiError, type BotDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import type { WebBotSettingsFragments } from '../contract'
import { replaceMattermostBotToken } from './api'

// Which bot row has its token form open; one per card.
const SettingsContext = createContext<{ selected: string | null; select(id: string | null): void }>({
  selected: null,
  select: () => {}
})

function CardProvider({ children }: { children: ReactNode }) {
  const [selected, select] = useState<string | null>(null)
  return <SettingsContext.Provider value={{ selected, select }}>{children}</SettingsContext.Provider>
}

function RowActions({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const t = useTranslations('Platforms.mattermost.settings')
  const { select } = useContext(SettingsContext)
  const attention = !!(bot.revokedAt || bot.credentialRejectedAt)
  return canWrite ? (
    <button
      className={`dsbtn sm ${attention ? 'border-(--amber-500) bg-(--status-paused-soft) text-(--amber-500)' : 'dsbtn-secondary'}`}
      onClick={() => select(bot.id)}
    >
      {t('replace')}
    </button>
  ) : null
}

function TokenForm({ bot }: { bot: BotDto }) {
  const t = useTranslations('Platforms.mattermost.settings')
  const errT = useTranslations('Platforms.mattermost.errors')
  const { refresh } = useConsoleData()
  const { select } = useContext(SettingsContext)
  const [botToken, setBotToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'status' | 'error'; text: string } | null>(null)
  const lock = useRef(false)

  async function submit() {
    if (lock.current || !botToken.trim()) return
    lock.current = true
    setBusy(true)
    setFeedback(null)
    try {
      await replaceMattermostBotToken(bot.id, botToken.trim())
      setBotToken('')
      setFeedback({ kind: 'status', text: t('updated') })
      await refresh()
    } catch (error) {
      let text: string
      if (error instanceof ApiError && error.code === 'MATTERMOST_SERVER_URL_INVALID') {
        text = errT('invalidServerUrl')
      } else if (error instanceof ApiError && error.code === 'MATTERMOST_CREDENTIALS_INVALID') {
        text = errT('invalidCredentials')
      } else if (error instanceof ApiError && error.code === 'MATTERMOST_BOT_MISMATCH') {
        text = errT('botMismatch')
      } else if (error instanceof ApiError && error.code === 'MATTERMOST_CHECK_UNAVAILABLE') {
        text = errT('checkUnavailable')
      } else {
        text = error instanceof Error ? error.message : String(error)
      }
      setFeedback({ kind: 'error', text })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-2 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="psub">{t('hint')}</p>
      <label className="fld">
        <span className="fldlbl">{t('newToken')}</span>
        <input
          className="inp mn"
          type="password"
          autoComplete="new-password"
          value={botToken}
          onChange={(event) => setBotToken(event.target.value)}
          disabled={busy}
        />
      </label>
      <div className="flex gap-2">
        <button className="dsbtn sm dsbtn-primary" disabled={busy || !botToken.trim()} type="submit">
          {busy ? t('checking') : t('save')}
        </button>
        <button className="dsbtn sm dsbtn-secondary" type="button" onClick={() => select(null)} disabled={busy}>
          {t('close')}
        </button>
      </div>
      {feedback && (
        <p
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          className={feedback.kind === 'error' ? 'psub text-(--status-error)' : 'psub'}
        >
          {feedback.text}
        </p>
      )}
    </form>
  )
}

function CardNotice({ bot }: { bot: BotDto }) {
  const t = useTranslations('Platforms.mattermost.settings')
  const { selected } = useContext(SettingsContext)
  const alertText = bot.revokedAt
    ? t('revoked')
    : bot.credentialRejectedAt
      ? bot.credentialRejectedCode
        ? t('rejected', { code: bot.credentialRejectedCode })
        : t('revoked')
      : null
  return (
    <>
      {alertText && (
        <p role="alert" className="psub px-4 pt-3 text-(--status-error)">
          {alertText}
        </p>
      )}
      {selected === bot.id ? <TokenForm key={bot.id} bot={bot} /> : null}
    </>
  )
}

/** Settings → Bots for Mattermost: replace a bot's token (Bot Account Token or PAT); serverUrl + botUserId stay. */
export const mattermostSettingsFragments: WebBotSettingsFragments = {
  lifecycleActions: { CardProvider, RowActions, CardNotice }
}
