'use client'

import { useId, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import useSWR from 'swr'
import type { ProviderKeyStatus, SetProviderKeyInput } from '@agentconnect.md/protocol'
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

type HeaderDraft = { name: string; value: string; saved: boolean; removed: boolean }

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
  const [endpoint, setEndpoint] = useState('')
  const [headers, setHeaders] = useState<HeaderDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeHeaderNames = headers
    .filter((header) => !header.removed)
    .map((header) => header.name.trim().toLowerCase())
  const duplicateHeaders = new Set(activeHeaderNames).size !== activeHeaderNames.length

  const save = async () => {
    if (!editing || busy || duplicateHeaders || (!editing.configured && !apiKey.trim())) return
    setBusy(true)
    setError(null)
    try {
      const input: SetProviderKeyInput = {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        endpoint: endpoint.trim() || null,
        headers: Object.fromEntries(
          headers
            .filter((header) => header.removed || header.value)
            .map((header) => [header.name.trim().toLowerCase(), header.removed ? null : header.value])
        )
      }
      const saved = await setProviderKey(orgId, editing.provider, input)
      setApiKey('')
      setHeaders([])
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
            row.provider === deleting.provider
              ? { ...row, configured: false, updatedAt: null, endpoint: null, headerNames: [] }
              : row
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
                        setEndpoint(entry.endpoint ?? '')
                        setHeaders(entry.headerNames.map((name) => ({ name, value: '', saved: true, removed: false })))
                        setApiKey('')
                        setError(null)
                      }}
                    >
                      {entry.configured ? t('edit') : t('add')}
                    </Button>
                    {entry.configured && (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() => {
                          setDeleting(entry)
                          setEditing(null)
                          setHeaders([])
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
                    required={!entry.configured}
                    disabled={busy}
                    value={apiKey}
                    placeholder={entry.configured ? t('keepValue') : undefined}
                    onChange={(event) => setApiKey(event.target.value)}
                    aria-describedby={`${inputId}-help`}
                  />
                  <p id={`${inputId}-help`} className="text-[12px] text-(--text-secondary)">
                    {t('writeOnly')}
                  </p>
                  <details
                    open={entry.endpointRequired || !!entry.endpoint || headers.some((header) => !header.removed)}
                  >
                    <summary className="cursor-pointer text-[12px] text-(--text-secondary)">
                      {t('connectionSettings')}
                    </summary>
                    <div className="mt-3 flex flex-col gap-3">
                      <label className="fldlbl" htmlFor={`${inputId}-endpoint`}>
                        {t('endpoint')}
                        {entry.endpointRequired ? ' *' : ''}
                      </label>
                      <input
                        id={`${inputId}-endpoint`}
                        className="inp w-full"
                        type="url"
                        value={endpoint}
                        disabled={busy}
                        required={entry.endpointRequired}
                        placeholder={entry.defaultEndpoint ?? 'https://gateway.example.test/v1'}
                        onChange={(event) => setEndpoint(event.target.value)}
                      />
                      <p className="text-[12px] text-(--text-secondary)">
                        {entry.endpointRequired ? t('gatewayHelp') : t('endpointHelp')}
                      </p>
                      <span className="fldlbl">{t('headers')}</span>
                      {headers.map((header, index) =>
                        header.removed ? null : (
                          <div key={index} className="flex flex-wrap gap-2">
                            <input
                              className="inp min-w-0 flex-1"
                              aria-label={t('headerName')}
                              placeholder={t('headerName')}
                              value={header.name}
                              readOnly={header.saved}
                              disabled={busy}
                              required
                              onChange={(event) =>
                                setHeaders((rows) =>
                                  rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row))
                                )
                              }
                            />
                            <input
                              className="inp min-w-0 flex-1"
                              type="password"
                              autoComplete="new-password"
                              aria-label={t('headerValue')}
                              placeholder={header.saved ? t('keepValue') : t('headerValue')}
                              value={header.value}
                              disabled={busy}
                              required={!header.saved}
                              maxLength={8192}
                              onChange={(event) =>
                                setHeaders((rows) =>
                                  rows.map((row, i) => (i === index ? { ...row, value: event.target.value } : row))
                                )
                              }
                            />
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={busy}
                              ariaLabel={t('removeHeader')}
                              onClick={() =>
                                setHeaders((rows) =>
                                  rows.flatMap((row, i) =>
                                    i !== index ? [row] : row.saved ? [{ ...row, value: '', removed: true }] : []
                                  )
                                )
                              }
                            >
                              <Icon name="x" size={14} />
                            </Button>
                          </div>
                        )
                      )}
                      <Button
                        variant="secondary"
                        size="xs"
                        disabled={busy || headers.length >= 32}
                        onClick={() =>
                          setHeaders((rows) => [...rows, { name: '', value: '', saved: false, removed: false }])
                        }
                      >
                        {t('addHeader')}
                      </Button>
                      <p className="text-[12px] text-(--text-secondary)">{t('headersHelp')}</p>
                      {duplicateHeaders && (
                        <p role="alert" className="text-[12px] text-(--status-error)">
                          {t('duplicateHeaders')}
                        </p>
                      )}
                    </div>
                  </details>
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
                        setHeaders([])
                        setApiKey('')
                        setError(null)
                      }}
                    >
                      {t('cancel')}
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        busy ||
                        duplicateHeaders ||
                        (!entry.configured && !apiKey.trim()) ||
                        /\s/.test(apiKey.trim()) ||
                        (entry.endpointRequired && !endpoint.trim())
                      }
                    >
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
