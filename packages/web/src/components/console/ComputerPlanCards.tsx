'use client'

// The organization's Computer quotas and managed egress (computer-use.md §15.4, §15.5): read by members, set by admins and owners.
import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  setComputerEgress,
  setComputerQuotas,
  type ComputerEgressDto,
  type ComputerQuotaOverride,
  type ComputerQuotaStatusDto,
  type ComputerQuotas
} from '@/lib/api'
import { useComputerEgress, useComputerQuotas } from '@/lib/computers'
import { Button, Icon, Toggle } from '@/components/ui'

/** The quotas the console lists and edits, in display order; per-mode limits stay API-only. */
const QUOTA_ROWS = [
  'runningDesktops',
  'desktops',
  'storageGib',
  'monthlyDesktopHours',
  'viewers',
  'viewersPerComputer',
  'monthlyViewerGib',
  'screenshotStorageGib',
  'screenshotRetentionDays'
] as const satisfies ReadonlyArray<Exclude<keyof ComputerQuotas, 'modes'>>
type QuotaKey = (typeof QUOTA_ROWS)[number]

/** What the organization uses against each quota; a per-Computer or retention limit has no single figure. */
function usedOf(status: ComputerQuotaStatusDto, key: QuotaKey): number | null {
  switch (key) {
    case 'viewersPerComputer':
    case 'screenshotRetentionDays':
      return null
    default:
      return status.used[key]
  }
}

export function ComputerQuotasCard() {
  const { data, mutate } = useComputerQuotas()
  const t = useTranslations('Computers.quotas')
  const [editing, setEditing] = useState(false)
  if (!data) return null
  return (
    <div className="card overflow-hidden max-desktop:rounded-lg" data-quotas-card>
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        {data.canEdit && !editing && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditing(true)}>
            <Icon name="pencil" size={14} />
            {t('edit')}
          </Button>
        )}
      </div>
      <p className="m-0 px-4 pt-3 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
        {t('hint')}
      </p>
      {editing ? (
        <QuotaEditor
          status={data}
          onDone={(next) => {
            if (next) void mutate(next, { revalidate: false })
            setEditing(false)
          }}
        />
      ) : (
        <div className="py-[6px]">
          {QUOTA_ROWS.map((key) => (
            <QuotaLine key={key} label={t(`rows.${key}`)} used={usedOf(data, key)} limit={data.limits[key]} />
          ))}
        </div>
      )}
    </div>
  )
}

function QuotaLine({ label, used, limit }: { label: string; used: number | null; limit: number | null }) {
  const t = useTranslations('Computers.quotas')
  const full = limit !== null && used !== null && used >= limit
  const pct = limit && used !== null ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="row grid-cols-[1fr_auto] gap-3" data-quota-line={label}>
      <span className="min-w-0 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{label}</span>
      <span
        className={`text-right font-mono text-[12px] font-medium leading-normal tabular-nums ${full ? 'text-(--status-error)' : ''}`}
      >
        {limit === null
          ? used === null
            ? t('unlimited')
            : t('usedUnlimited', { used })
          : used === null
            ? t('limitOnly', { limit })
            : t('usedOf', { used, limit })}
      </span>
      {limit !== null && used !== null && (
        <span className="col-span-2 h-1 overflow-hidden rounded-full bg-(--surface-sunken)">
          <span
            className={`block h-full rounded-full ${full ? 'bg-(--status-error)' : 'bg-(--brand)'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
      )}
    </div>
  )
}

type Draft = Record<QuotaKey, { value: string; unlimited: boolean; custom: boolean }>

function draftOf(status: ComputerQuotaStatusDto): Draft {
  const override = status.override ?? {}
  return Object.fromEntries(
    QUOTA_ROWS.map((key) => {
      const own = override[key]
      return [key, { value: own == null ? '' : String(own), unlimited: own === null, custom: key in override }]
    })
  ) as Draft
}

function QuotaEditor({
  status,
  onDone
}: {
  status: ComputerQuotaStatusDto
  onDone: (next?: ComputerQuotaStatusDto) => void
}) {
  const t = useTranslations('Computers.quotas')
  const [draft, setDraft] = useState<Draft>(() => draftOf(status))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (key: QuotaKey, patch: Partial<Draft[QuotaKey]>) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }))

  const save = async (override: ComputerQuotaOverride | null) => {
    setBusy(true)
    setError(null)
    try {
      onDone(await setComputerQuotas(override))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    const override: ComputerQuotaOverride = { ...(status.override?.modes ? { modes: status.override.modes } : {}) }
    for (const key of QUOTA_ROWS) {
      const row = draft[key]
      if (row.unlimited) override[key] = null
      else if (row.value.trim() !== '') {
        const n = Number(row.value)
        if (!Number.isInteger(n) || n < 0) return setError(t('invalid', { label: t(`rows.${key}`) }))
        override[key] = n
      }
    }
    void save(Object.keys(override).length > 0 ? override : null)
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
        {QUOTA_ROWS.map((key) => {
          const fallback = status.defaults[key]
          return (
            <label key={key} className="flex flex-col gap-1">
              <span className="font-sans text-[12.5px] font-medium leading-normal">{t(`rows.${key}`)}</span>
              <span className="flex items-center gap-2">
                <input
                  className="inp min-w-0 flex-1"
                  inputMode="numeric"
                  aria-label={t(`rows.${key}`)}
                  disabled={draft[key].unlimited}
                  placeholder={
                    fallback === null ? t('defaultUnlimited') : t('defaultValue', { value: String(fallback) })
                  }
                  value={draft[key].value}
                  onChange={(e) => set(key, { value: e.target.value })}
                />
                <Toggle
                  size="sm"
                  checked={draft[key].unlimited}
                  ariaLabel={t('noLimitFor', { label: t(`rows.${key}`) })}
                  onChange={(on) => set(key, { unlimited: on })}
                />
                <span className="font-sans text-[12px] text-(--text-tertiary)">{t('noLimit')}</span>
              </span>
            </label>
          )
        })}
      </div>
      <p className="m-0 font-sans text-[12px] leading-[1.5] text-(--text-tertiary)">{t('editHint')}</p>
      {error && (
        <span role="alert" className="font-sans text-[12.5px] leading-[1.5] text-(--status-error)">
          {error}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={submit}>
          {t('save')}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDone()}>
          {t('cancel')}
        </Button>
        {status.override && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)}>
            {t('useDefaults')}
          </Button>
        )}
      </div>
    </div>
  )
}

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
