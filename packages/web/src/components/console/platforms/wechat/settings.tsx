// No 'use client' here: rendered only inside the Settings view's client tree.

import { createContext, useContext, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui'
import { creatorLabel, type BotDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import type { WebBotSettingsFragments } from '../contract'
import { useWeChatLogin, WeChatLoginView } from './login'

/** The last characters of a WeChat id's local part, which is all the console shows of it. */
export function weChatIdTail(id: string | null | undefined): string | null {
  const local = id?.split('@')[0]
  return local ? local.slice(-6) : null
}

/** The agent a re-scan installs for: the bot's own, since a WeChat bot serves one agent. */
function boundAgentId(bot: BotDto): string | null {
  return bot.inUseByAgentId ?? bot.agentIds[0] ?? null
}

// Which bot row has its reconnect panel open; one per card.
const SettingsContext = createContext<{ selected: string | null; select(id: string | null): void }>({
  selected: null,
  select: () => {}
})

function CardProvider({ children }: { children: ReactNode }) {
  const [selected, select] = useState<string | null>(null)
  return <SettingsContext.Provider value={{ selected, select }}>{children}</SettingsContext.Provider>
}

function RowActions({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const t = useTranslations('Platforms.wechat.settings')
  const { select } = useContext(SettingsContext)
  return canWrite && boundAgentId(bot) ? (
    <button className="dsbtn sm dsbtn-secondary" onClick={() => select(bot.id)}>
      {t('reconnect')}
    </button>
  ) : null
}

function ReconnectPanel({ bot, agentId }: { bot: BotDto; agentId: string }) {
  const t = useTranslations('Platforms.wechat')
  const { select } = useContext(SettingsContext)
  const { refresh } = useConsoleData()
  const [error, setError] = useState<string | null>(null)
  const state = useWeChatLogin({ agentId, botId: bot.id, onCompleted: () => refresh() })
  async function start() {
    setError(null)
    setError(await state.start())
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="m-0 font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
        {t('settings.reconnectHint')}
      </p>
      {state.phase === 'idle' ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={state.starting} onClick={() => void start()}>
            {state.starting ? t('starting') : t('start')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => select(null)}>
            {t('settings.close')}
          </Button>
        </div>
      ) : (
        <>
          <WeChatLoginView state={state} onRetry={() => void start()} />
          <div>
            <Button size="sm" variant="secondary" onClick={() => select(null)}>
              {t('settings.close')}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="m-0 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
          {error}
        </p>
      )}
    </div>
  )
}

function CardNotice({ bot }: { bot: BotDto }) {
  const { selected } = useContext(SettingsContext)
  const agentId = boundAgentId(bot)
  return selected === bot.id && agentId ? <ReconnectPanel key={bot.id} bot={bot} agentId={agentId} /> : null
}

/** The binding a scan made: which WeChat user is the bot's counterpart, and which member scanned. */
function RowSettings({ bot }: { bot: BotDto; canWrite: boolean }) {
  const t = useTranslations('Platforms.wechat.settings')
  const { me } = useProfile()
  const tail = weChatIdTail(bot.platformConfig?.wechatUserId)
  const member = bot.platformConfig?.boundMemberUserId ?? null
  return (
    <div className="mb-3 grid grid-cols-1 gap-[10px] rounded-lg border border-(--border-subtle) bg-(--surface-card) px-3 py-3 desktop:grid-cols-2">
      <div className="fld min-w-0">
        <span className="fldlbl">{t('wechatUser')}</span>
        <span className="mono truncate text-[12.5px] text-(--text-primary)">{tail ? `…${tail}` : '—'}</span>
      </div>
      <div className="fld min-w-0">
        <span className="fldlbl">{t('scannedBy')}</span>
        <span className="truncate font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-primary)">
          {creatorLabel(member, me)}
        </span>
      </div>
    </div>
  )
}

/** Settings → Bots for WeChat: the binding, and Reconnect (a re-scan that keeps the integration); unbinding is the host's delete. */
export const weChatSettingsFragments: WebBotSettingsFragments = {
  botCard: { RowSettings },
  lifecycleActions: { CardProvider, RowActions, CardNotice },
  // Host-rendered row copy; still English source data, like every module's (docs/i18n.md).
  copy: {
    revokedHint: 'WeChat logged this bot out — reconnect it and scan the code again',
    rejectedHint: 'WeChat rejected this bot’s login — reconnect it and scan the code again'
  }
}
