// No 'use client' here: rendered only inside the Settings view's client tree.

import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { BotDto } from '@/lib/api'
import { replaceDingTalkBotSecret } from './api'
import type { WebBotSettingsFragments } from '../contract'

// Which bot row has its secret form open; one per card.
const SettingsContext = createContext<{ selected: string | null; select(id: string | null): void }>({
  selected: null,
  select: () => {}
})

function CardProvider({ children }: { children: ReactNode }) {
  const [selected, select] = useState<string | null>(null)
  return <SettingsContext.Provider value={{ selected, select }}>{children}</SettingsContext.Provider>
}

function RowActions({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const t = useTranslations('Platforms.dingtalk.settings')
  const { select } = useContext(SettingsContext)
  return canWrite ? (
    <button className="dsbtn sm dsbtn-secondary" onClick={() => select(bot.id)}>
      {t('replace')}
    </button>
  ) : null
}

function SecretForm({ bot }: { bot: BotDto }) {
  const t = useTranslations('Platforms.dingtalk.settings')
  const { select } = useContext(SettingsContext)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const lock = useRef(false)
  async function submit() {
    if (lock.current || !secret.trim()) return
    lock.current = true
    setBusy(true)
    setMessage('')
    try {
      await replaceDingTalkBotSecret(bot.id, secret.trim())
      setSecret('')
      setMessage(t('updated'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
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
      <label className="fld">
        <span className="fldlbl">{t('newSecret')}</span>
        <input
          className="inp mn"
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          disabled={busy}
        />
      </label>
      <div className="flex gap-2">
        <button className="dsbtn sm dsbtn-primary" disabled={busy || !secret.trim()} type="submit">
          {busy ? t('checking') : t('save')}
        </button>
        <button className="dsbtn sm dsbtn-secondary" type="button" onClick={() => select(null)} disabled={busy}>
          {t('close')}
        </button>
      </div>
      {message && (
        <p role="status" className="psub">
          {message}
        </p>
      )}
    </form>
  )
}

function CardNotice({ bot }: { bot: BotDto }) {
  const { selected } = useContext(SettingsContext)
  return selected === bot.id ? <SecretForm key={bot.id} bot={bot} /> : null
}

/** Settings → Bots for DingTalk: replace an app's Client Secret; the Client ID is the bot's identity and stays. */
export const dingTalkSettingsFragments: WebBotSettingsFragments = {
  lifecycleActions: { CardProvider, RowActions, CardNotice }
}
