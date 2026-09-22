'use client'

import { useId, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import useSWR from 'swr'
import type { ProviderKeyStatus } from '@agentconnect.md/protocol'
import { deleteProviderKey, fetchProviderKeys, setProviderKey } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { ConfirmationDialog } from './ConfirmationDialog'

export default function ProviderKeysSection() {
  const { activeOrg, myRole } = useOrgs()
  // Remount on organization or permission changes so an unsaved key cannot cross those boundaries.
  return activeOrg ? (
    <ProviderKeysForOrg key={`${activeOrg.id}:${myRole}`} orgId={activeOrg.id} isOwner={myRole === 'owner'} />
  ) : null
}

function ProviderKeysForOrg({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const t = useTranslations('ProviderKeys')
  const format = useFormatter()
  const inputId = useId()
  const {
    data: entries,
    error: loadError,
    mutate
  } = useSWR(consoleKeys.providerKeys(orgId), ([, id]) => fetchProviderKeys(id))
  const [editing, setEditing] = useState<ProviderKeyStatus | null>(null)
  const [deleting, setDeleting] = useState<ProviderKeyStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!editing || busy || !apiKey.trim()) return
    setBusy(true)
    setError(null)
    try {
      const saved = await setProviderKey(orgId, editing.provider, apiKey.trim())
      setApiKey('')
      setEditing(null)
      await mutate((rows) => rows?.map((row) => (row.provider === saved.provider ? saved : row)), { revalidate: false })
    } catch {
      setError(t('saveError'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!deleting || busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteProviderKey(orgId, deleting.provider)
      await mutate(
        (rows) =>
          rows?.map((row) =>
            row.provider === deleting.provider ? { ...row, configured: false, updatedAt: null } : row
          ),
        { revalidate: false }
      )
      setDeleting(null)
    } catch {
      setError(t('deleteError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card mt-6" aria-labelledby={`${inputId}-title`}>
      <div className="cardhead">
        <Icon name="key-round" size={16} />
        <h2 id={`${inputId}-title`} className="cardtitle">
          {t('title')}
        </h2>
      </div>
      <p className="px-4 pt-3 text-[12.5px] text-(--text-secondary)">{t('description')}</p>
      {!isOwner && <p className="px-4 pt-2 text-[12px] text-(--text-tertiary)">{t('ownerOnly')}</p>}
      {loadError ? (
        <div className="flex items-center gap-3 p-4">
          <span role="alert" className="text-[12px] text-(--status-error)">
            {t('loadError')}
          </span>
          <Button variant="secondary" size="xs" onClick={() => void mutate()}>
            {t('retry')}
          </Button>
        </div>
      ) : !entries ? (
        <LoadingState size={22} padding={20} />
      ) : (
        <div className="divide-y divide-(--border-subtle)">
          {entries.map((entry) => (
            <div key={entry.provider} className="px-4 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 font-sans text-[13px] font-semibold leading-normal">{entry.name}</span>
                <span
                  className={`badge ${entry.configured ? 'bg-(--status-online-soft) text-(--status-online)' : 'bg-(--surface-sunken) text-(--text-tertiary)'}`}
                >
                  {entry.configured ? t('configured') : t('notConfigured')}
                </span>
                {entry.updatedAt && (
                  <time dateTime={entry.updatedAt} className="text-[12px] text-(--text-tertiary)">
                    {t('updated', {
                      date: format.dateTime(new Date(entry.updatedAt), { dateStyle: 'medium', timeStyle: 'short' })
                    })}
                  </time>
                )}
                {isOwner && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={busy}
                      onClick={() => {
                        setEditing(entry)
                        setApiKey('')
                        setError(null)
                      }}
                    >
                      {entry.configured ? t('replace') : t('add')}
                    </Button>
                    {entry.configured && (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() => {
                          setDeleting(entry)
                          setEditing(null)
                          setApiKey('')
                          setError(null)
                        }}
                      >
                        {t('remove')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {editing?.provider === entry.provider && (
                <form
                  className="mt-4 flex flex-col gap-3 rounded-md border border-(--border-subtle) bg-(--surface-sunken) p-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void save()
                  }}
                >
                  <label className="fldlbl" htmlFor={inputId}>
                    {entry.configured ? t('replacementKey') : t('apiKey')}
                  </label>
                  <input
                    id={inputId}
                    className="inp w-full"
                    type="password"
                    autoComplete="new-password"
                    autoFocus
                    spellCheck={false}
                    maxLength={8192}
                    required
                    disabled={busy}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    aria-describedby={`${inputId}-help`}
                  />
                  <p id={`${inputId}-help`} className="text-[12px] text-(--text-secondary)">
                    {t('writeOnly')}
                  </p>
                  {error && (
                    <p role="alert" className="text-[12px] text-(--status-error)">
                      {error}
                    </p>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setEditing(null)
                        setApiKey('')
                        setError(null)
                      }}
                    >
                      {t('cancel')}
                    </Button>
                    <Button type="submit" size="sm" disabled={busy || !apiKey.trim() || /\s/.test(apiKey.trim())}>
                      {busy ? t('saving') : t('save')}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="border-t border-(--border-subtle) px-4 py-3 text-[12px] text-(--text-tertiary)">
        {t('statusNote')}
      </p>
      {deleting && (
        <ConfirmationDialog
          title={t('deleteTitle', { provider: deleting.name })}
          confirmLabel={t('remove')}
          busyLabel={t('removing')}
          busy={busy}
          error={error}
          destructive
          onConfirm={() => void remove()}
          onClose={() => {
            if (!busy) {
              setDeleting(null)
              setError(null)
            }
          }}
        >
          {t('deleteBody')}
        </ConfirmationDialog>
      )}
    </section>
  )
}
