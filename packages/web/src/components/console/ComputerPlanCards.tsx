'use client'

// Managed computers' egress (computer-use.md §15.4): read by members, set by admins and owners.
import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { setComputerEgress, type ComputerEgressDto } from '@/lib/api'
import { useComputerEgress } from '@/lib/computers'
import { Button, Icon, Toggle } from '@/components/ui'

export function ComputerEgressCard() {
  const { data, mutate } = useComputerEgress()
  const t = useTranslations('Computers.egress')
  const [editing, setEditing] = useState(false)
  if (!data) return null
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg" data-egress-card>
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        {data.canEdit && data.orgProxyAllowed && !editing && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditing(true)}>
            <Icon name="pencil" size={14} />
            {t('edit')}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2 px-4 py-3 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
        <p className="m-0" data-egress-limitation>
          {t('limitation')}
        </p>
        {data.description && <p className="m-0 text-(--text-tertiary)">{data.description}</p>}
        {!data.orgProxyAllowed && <p className="m-0 text-(--text-tertiary)">{t('noOrgProxy')}</p>}
      </div>
      {editing ? (
        <EgressEditor
          egress={data}
          onDone={(next) => {
            if (next) void mutate(next, { revalidate: false })
            setEditing(false)
          }}
        />
      ) : (
        <div className="border-t border-(--border-subtle) py-[6px]">
          <Line label={t('mode')}>
            <span data-egress-mode={data.mode}>{t(`modes.${data.mode}`)}</span>
          </Line>
          {data.mode === 'proxy' && (
            <>
              <Line label={t('url')}>{data.url}</Line>
              <Line label={t('username')}>{data.username ?? '—'}</Line>
              <Line label={t('password')}>{data.passwordSet ? t('passwordSet') : '—'}</Line>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function EgressEditor({ egress, onDone }: { egress: ComputerEgressDto; onDone: (next?: ComputerEgressDto) => void }) {
  const t = useTranslations('Computers.egress')
  const [proxy, setProxy] = useState(egress.mode === 'proxy')
  const [url, setUrl] = useState(egress.url ?? '')
  const [username, setUsername] = useState(egress.username ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(
        await setComputerEgress(
          proxy
            ? {
                mode: 'proxy',
                url: url.trim(),
                username: username.trim() || null,
                ...(password ? { password } : {})
              }
            : { mode: 'deployment' }
        )
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-(--border-subtle) px-4 py-3">
      <label className="flex items-center gap-2 font-sans text-[13px] leading-normal">
        <Toggle checked={proxy} ariaLabel={t('useProxy')} onChange={setProxy} />
        {t('useProxy')}
      </label>
      {proxy && (
        <div className="grid grid-cols-1 gap-3 desktop:grid-cols-3">
          <input
            className="inp"
            aria-label={t('url')}
            placeholder="http://proxy.example.com:3128"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            className="inp"
            aria-label={t('username')}
            placeholder={t('username')}
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="inp"
            type="password"
            aria-label={t('password')}
            placeholder={egress.passwordSet ? t('passwordKeep') : t('password')}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      )}
      {proxy && <p className="m-0 font-sans text-[12px] leading-[1.5] text-(--text-tertiary)">{t('proxyHint')}</p>}
      {error && (
        <span role="alert" className="font-sans text-[12.5px] leading-[1.5] text-(--status-error)">
          {error}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || (proxy && url.trim() === '')} onClick={() => void save()}>
          {t('save')}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDone()}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row grid-cols-[auto_1fr] gap-3">
      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{label}</span>
      <span className="min-w-0 truncate text-right font-sans text-[12.5px] font-medium leading-normal">{children}</span>
    </div>
  )
}
