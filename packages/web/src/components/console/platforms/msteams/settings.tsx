// No 'use client' here: rendered only inside the Settings view's client tree.

import { useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { BotDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import type { WebBotSettingsFragments } from '../contract'
import { useDeploymentConfig } from '../deployment-config'
import { msTeamsApi } from './api'
import { AppPackageButton } from './app-package'
import { CopyField } from './fields'
import { msTeamsErrorMessage, msTeamsMessagesUrl } from './setup'

/** A Teams bot's expanded row: its two IDs, the endpoint its registration must name, secret rotation, and the app package of its integration. */
export function MsTeamsBotSettings({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const t = useTranslations('Platforms.msteams')
  const translate = (key: Parameters<typeof t>[0]) => t(key)
  const probe = useDeploymentConfig(true)
  const { integrations, refresh } = useConsoleData()
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const lock = useRef(false)

  const endpoint = msTeamsMessagesUrl(probe.config?.relayPublicUrl ?? null)
  // The package is built per integration; a freed bot has none to build it from.
  const integrationId = integrations.find((row) => row.botId === bot.id)?.id
  const secretTrim = secret.trim()

  const replace = async () => {
    if (lock.current || !secretTrim) return
    lock.current = true
    setBusy(true)
    setResult(null)
    try {
      await msTeamsApi.replaceSecret(bot.id, secretTrim)
      setResult({ ok: true, text: t('settings.updated') })
      refresh()
    } catch (e) {
      setResult({ ok: false, text: msTeamsErrorMessage(e, translate) })
    } finally {
      // Write-only: the pasted secret never outlives its request.
      setSecret('')
      setBusy(false)
      lock.current = false
    }
  }

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-(--border-subtle) bg-(--surface-card) px-3 py-3">
      <div className="grid grid-cols-1 gap-[10px] desktop:grid-cols-2">
        <Value label={t('credentials.appId')}>{bot.externalAppId ?? '—'}</Value>
        <Value label={t('credentials.tenantId')}>{bot.platformConfig?.tenantId ?? '—'}</Value>
        {endpoint && (
          <div className="desktop:col-span-2">
            <CopyField label={t('register.endpoint')} value={endpoint} />
          </div>
        )}
      </div>
      {canWrite && (
        <form
          className="flex flex-col gap-2 desktop:flex-row desktop:items-end"
          onSubmit={(event) => {
            event.preventDefault()
            void replace()
          }}
        >
          <label className="fld min-w-0 flex-1">
            <span className="fldlbl">{t('settings.newSecret')}</span>
            <input
              className="inp mn"
              type="password"
              autoComplete="new-password"
              placeholder={t('credentials.clientSecretPlaceholder')}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              disabled={busy}
            />
          </label>
          <button className="dsbtn sm dsbtn-primary flex-none" disabled={busy || !secretTrim} type="submit">
            {busy ? t('settings.checking') : t('settings.save')}
          </button>
        </form>
      )}
      {result && (
        <p
          role="status"
          className={`m-0 font-sans text-[12px] font-normal leading-[1.5] ${result.ok ? 'text-(--text-secondary)' : 'text-(--status-error)'}`}
        >
          {result.text}
        </p>
      )}
      {integrationId && (
        <div className="flex">
          <AppPackageButton integrationId={integrationId} className="dsbtn sm dsbtn-secondary" />
        </div>
      )}
    </div>
  )
}

function Value({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fld min-w-0">
      <span className="fldlbl">{label}</span>
      <span className="mono truncate text-[12.5px] text-(--text-primary)">{children}</span>
    </div>
  )
}

export const msTeamsSettingsFragments: WebBotSettingsFragments = {
  botCard: { RowSettings: MsTeamsBotSettings }
}
