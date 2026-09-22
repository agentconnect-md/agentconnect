import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import type { BotDto } from '@/lib/api'
import { updateQQBotCredentials } from './api'
import type { WebBotSettingsFragments } from '../contract'

const SettingsContext = createContext<{ selected: string | null; select(id: string | null): void }>({
  selected: null,
  select: () => {}
})

function CardProvider({ children }: { children: ReactNode }) {
  const [selected, select] = useState<string | null>(null)
  return <SettingsContext.Provider value={{ selected, select }}>{children}</SettingsContext.Provider>
}
function RowActions({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const { select } = useContext(SettingsContext)
  return canWrite ? (
    <button className="dsbtn sm dsbtn-secondary" onClick={() => select(bot.id)}>
      Update secret
    </button>
  ) : null
}
function SecretForm({ bot }: { bot: BotDto }) {
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
      await updateQQBotCredentials(bot.id, secret.trim())
      setSecret('')
      setMessage('AppSecret updated — the bot’s conversations are unchanged.')
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
      <div className="fld">
        <span className="fldlbl">New AppSecret</span>
        <input
          className="inp mn"
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className="flex gap-2">
        <button className="dsbtn sm dsbtn-primary" disabled={busy || !secret.trim()} type="submit">
          {busy ? 'Checking…' : 'Save'}
        </button>
        <button className="dsbtn sm dsbtn-secondary" type="button" onClick={() => select(null)} disabled={busy}>
          Close
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
export const QQSettingsFragments: WebBotSettingsFragments = {
  lifecycleActions: { CardProvider, RowActions, CardNotice }
}
