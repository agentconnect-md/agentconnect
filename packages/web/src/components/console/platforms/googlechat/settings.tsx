// No 'use client' here: rendered only inside the Settings view's client tree.

import { useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { BotDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import type { WebBotSettingsFragments } from '../contract'
import { useDeploymentConfig } from '../deployment-config'
import { googleChatApi } from './api'
import { CopyField } from './fields'
import { GOOGLE_CHAT_AUDIENCE, googleChatCallbackUrl, googleChatErrorMessage, parseServiceAccountKey } from './setup'

/** A Google Chat app's expanded row: its identity, the endpoint Google must call, its key's state and rotation, and its scope. */
export function GoogleChatBotSettings({ bot, canWrite }: { bot: BotDto; canWrite: boolean }) {
  const t = useTranslations('Platforms.googlechat')
  const translate = (key: Parameters<typeof t>[0]) => t(key)
  const probe = useDeploymentConfig(true)
  const { refresh } = useConsoleData()
  const [serviceAccountKey, setServiceAccountKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const lock = useRef(false)

  const callbackUrl = googleChatCallbackUrl(probe.config?.relayPublicUrl ?? null)
  const keyTrim = serviceAccountKey.trim()
  const keyOk = !!parseServiceAccountKey(keyTrim)
  const keyState = bot.revokedAt
    ? t('settings.keyRevoked')
    : bot.credentialRejectedAt
      ? `${t('settings.keyRejected')}${bot.credentialRejectedCode ? ` (${bot.credentialRejectedCode})` : ''}`
      : t('settings.keyActive')

  const replace = async () => {
    if (lock.current || !keyOk) return
    lock.current = true
    setBusy(true)
    setResult(null)
    try {
      await googleChatApi.replaceKey(bot.id, keyTrim)
      setResult({ ok: true, text: t('settings.updated') })
      refresh()
    } catch (e) {
      setResult({ ok: false, text: googleChatErrorMessage(e, translate) })
    } finally {
      // Write-only: the pasted key never outlives its request.
      setServiceAccountKey('')
      setBusy(false)
      lock.current = false
    }
  }

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-(--border-subtle) bg-(--surface-card) px-3 py-3">
      <div className="grid grid-cols-1 gap-[10px] desktop:grid-cols-2">
        <Value label={t('credentials.projectId')} mono>
          {bot.platformConfig?.projectId ?? '—'}
        </Value>
        <Value label={t('credentials.projectNumber')} mono>
          {bot.externalAppId ?? '—'}
        </Value>
        {callbackUrl && <CopyField label={t('configure.endpoint')} value={callbackUrl} />}
        <CopyField label={t('configure.audience')} value={GOOGLE_CHAT_AUDIENCE} />
        <Value label={t('settings.key')}>
          {bot.prebuilt ? `${keyState} · ${t('settings.deploymentKey')}` : keyState}
        </Value>
      </div>
      {canWrite && !bot.prebuilt && (
        <form
          className="flex flex-col gap-2 desktop:flex-row desktop:items-end"
          onSubmit={(event) => {
            event.preventDefault()
            void replace()
          }}
        >
          <label className="fld min-w-0 flex-1">
            <span className="fldlbl">{t('settings.newKey')}</span>
            <input
              className={`inp mn ${keyTrim && !keyOk ? 'border-(--status-error)' : ''}`}
              type="password"
              autoComplete="new-password"
              placeholder={t('credentials.keyPlaceholder')}
              value={serviceAccountKey}
              onChange={(event) => setServiceAccountKey(event.target.value)}
              disabled={busy}
            />
          </label>
          <button className="dsbtn sm dsbtn-primary flex-none" disabled={busy || !keyOk} type="submit">
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
      <ul className="m-0 flex list-none flex-col gap-[4px] p-0">
        <Scope icon="message-circle">{t('settings.scope.dms')}</Scope>
        <Scope icon="at-sign">{t('settings.scope.spaces')}</Scope>
        <Scope icon="circle-slash">{t('settings.scope.unsupported')}</Scope>
      </ul>
    </div>
  )
}

function Value({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="fld min-w-0">
      <span className="fldlbl">{label}</span>
      <span
        className={
          mono
            ? 'mono truncate text-[12.5px] text-(--text-primary)'
            : 'truncate font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-primary)'
        }
      >
        {children}
      </span>
    </div>
  )
}

/** One scope fact, stated where the app is configured rather than as a caveat. */
function Scope({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
      <Icon name={icon} size={13} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
      <span>{children}</span>
    </li>
  )
}

export const googleChatSettingsFragments: WebBotSettingsFragments = {
  botCard: { RowSettings: GoogleChatBotSettings },
  // Host-rendered row copy; still English source data, like every module's (docs/i18n.md).
  copy: {
    rejectedHint: 'Google rejected this Chat app’s service-account key — replace the key in its settings',
    identityNoun: 'app'
  }
}
