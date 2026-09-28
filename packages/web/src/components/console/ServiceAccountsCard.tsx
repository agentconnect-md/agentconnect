'use client'

// Owner-only Settings card for service accounts: org members that never sign in and act through keys an owner mints (daemon-api-key-auth.md §6).

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { LoadingState } from '@/components/marks'
import { FieldSelect } from '@/components/console/FieldSelect'
import ApiKeysCard from '@/components/console/ApiKeysCard'
import { MOCK_MODE } from '@/lib/data'
import { useIsMobile } from '@/lib/use-is-mobile'
import {
  createServiceAccount,
  deleteServiceAccount,
  fetchServiceAccounts,
  serviceAccountKeysApi,
  updateServiceAccount,
  type OrgDto,
  type ServiceAccountDto,
  type ServiceAccountRole
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'

const ROLES: ServiceAccountRole[] = ['collaborator', 'viewer']
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const GRID = 'grid-cols-[2fr_1fr_auto]'

export function ServiceAccountsCard({ org }: { org: OrgDto }) {
  const t = useTranslations('Settings.serviceAccounts')
  const tRole = useTranslations('Settings.members.roles')
  const key = MOCK_MODE ? null : consoleKeys.serviceAccounts(org.id)
  const { data, error, mutate } = useSWR<ServiceAccountDto[]>(key, () => fetchServiceAccounts(org.id))
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ServiceAccountDto | null>(null)
  const [keysFor, setKeysFor] = useState<ServiceAccountDto | null>(null)
  const reload = () => void mutate().catch(() => undefined)

  return (
    <div className="card mt-[18px]" id="service-accounts">
      <div className="cardhead justify-between">
        <span className="cardtitle">{t('title')}</span>
        {!MOCK_MODE && (
          <Button variant="secondary" size="xs" onClick={() => setCreating(true)}>
            <Icon name="bot" size={14} />
            {t('new')}
          </Button>
        )}
      </div>

      {data === undefined && !error && !MOCK_MODE ? (
        <LoadingState size={22} padding={20} />
      ) : error ? (
        <div className="px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
          {t('loadError')}
        </div>
      ) : !data?.length ? (
        <div className="px-4 py-[15px] font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
          {t('empty')}
        </div>
      ) : (
        data.map((a) => (
          <div key={a.userId} className={`row ${GRID} gap-[11px]`}>
            <div className="flex min-w-0 items-center gap-[11px]">
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-(--surface-active)">
                <Icon name="bot" size={16} color="var(--text-secondary)" />
              </span>
              <div className="min-w-0">
                <div className="truncate font-sans text-[13px] font-semibold leading-normal">{a.displayName}</div>
                <div className="mono truncate text-[11px] text-(--text-tertiary)">{a.email}</div>
              </div>
            </div>
            <span className="badge self-center justify-self-start bg-(--surface-active) text-(--text-secondary)">
              {tRole(a.role)}
            </span>
            <div className="flex items-center gap-3 self-center">
              <button className="lnk" onClick={() => setKeysFor(a)}>
                {t('keys')}
              </button>
              <button className="iconbtn h-7 w-7" title={t('editTitle')} onClick={() => setEditing(a)}>
                <Icon name="pencil" size={14} />
              </button>
            </div>
          </div>
        ))
      )}

      {creating && (
        <div className="scrim">
          <div className="modal">
            <ServiceAccountFormModal orgId={org.id} onClose={() => setCreating(false)} onSaved={reload} />
          </div>
        </div>
      )}
      {editing && (
        <div className="scrim">
          <div className="modal">
            <ServiceAccountFormModal
              orgId={org.id}
              editing={editing}
              onClose={() => setEditing(null)}
              onSaved={reload}
            />
          </div>
        </div>
      )}
      {keysFor && <ServiceAccountKeysModal org={org} account={keysFor} onClose={() => setKeysFor(null)} />}
    </div>
  )
}

function ServiceAccountFormModal({
  orgId,
  editing,
  onClose,
  onSaved
}: {
  orgId: string
  editing?: ServiceAccountDto
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('Settings.serviceAccounts')
  const tRole = useTranslations('Settings.members.roles')
  const [name, setName] = useState(editing?.displayName ?? '')
  const [role, setRole] = useState<ServiceAccountRole>(editing?.role ?? 'collaborator')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const trimmed = name.trim()
  // A new account's name becomes part of its address; an existing one only renames its display name.
  const invalidName = !editing && trimmed !== '' && !NAME_RE.test(trimmed)
  const canSubmit = !busy && trimmed !== '' && !invalidName

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await action()
      onSaved()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const submit = () => {
    if (!canSubmit) return
    if (!editing) return void run(() => createServiceAccount(orgId, { name: trimmed, role }))
    const patch = {
      ...(trimmed !== editing.displayName ? { displayName: trimmed } : {}),
      ...(role !== editing.role ? { role } : {})
    }
    if (Object.keys(patch).length === 0) return onClose()
    void run(() => updateServiceAccount(orgId, editing.userId, patch))
  }

  const title = confirmingDelete ? t('deleteTitle') : editing ? t('editTitle') : t('createTitle')

  return (
    <>
      <div className="modalhead">
        <span
          className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] ${
            confirmingDelete ? 'bg-(--status-error-soft)' : 'bg-(--brand-soft)'
          }`}
        >
          <Icon
            name={confirmingDelete ? 'trash' : 'bot'}
            size={16}
            color={confirmingDelete ? 'var(--status-error)' : 'var(--brand)'}
          />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{title}</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        {confirmingDelete && editing ? (
          <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
            {t('deleteBody', { name: editing.displayName })}
          </p>
        ) : (
          <div className="flex flex-col gap-[14px]">
            <div className="flex flex-col gap-[6px]">
              <span className="fldlbl">{editing ? t('displayName') : t('name')}</span>
              <input
                className="inp placeholder:text-(--text-tertiary)"
                placeholder={editing ? undefined : t('namePlaceholder')}
                value={name}
                maxLength={editing ? 120 : 23}
                onChange={(e) => setName(e.target.value)}
              />
              {editing && <span className="mono text-[11px] text-(--text-tertiary)">{editing.email}</span>}
              {invalidName && (
                <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                  {t('invalidName')}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-[6px]">
              <span className="fldlbl">{t('role')}</span>
              <FieldSelect
                ariaLabel={t('role')}
                value={role}
                onChange={setRole}
                options={ROLES.map((r) => ({ value: r, label: tRole(r) }))}
              />
            </div>
          </div>
        )}
        {err && <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
      </div>

      <div className="modalfoot">
        {confirmingDelete && editing ? (
          <>
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => void run(() => deleteServiceAccount(orgId, editing.userId))}
              className={busy ? 'pointer-events-none opacity-50' : undefined}
            >
              <Icon name="trash" size={15} />
              {busy ? t('deleting') : t('delete')}
            </Button>
          </>
        ) : (
          <>
            {editing && (
              <Button variant="ghost" className="text-(--status-error)" onClick={() => setConfirmingDelete(true)}>
                {t('delete')}
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              className={canSubmit ? undefined : 'pointer-events-none opacity-50'}
            >
              {editing ? (busy ? t('saving') : t('save')) : busy ? t('creating') : t('create')}
            </Button>
          </>
        )}
      </div>
    </>
  )
}

function ServiceAccountKeysModal({
  org,
  account,
  onClose
}: {
  org: OrgDto
  account: ServiceAccountDto
  onClose: () => void
}) {
  const t = useTranslations('Settings.serviceAccounts')
  const mobile = useIsMobile()
  const api = serviceAccountKeysApi(org.id, account.userId)
  const source = { swrKey: consoleKeys.serviceAccountKeys(org.id, account.userId), ...api, serviceAccount: true }
  return (
    <div className="scrim">
      <div className="modal">
        <div className="modalhead">
          <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {t('keysTitle', { name: account.displayName })}
          </span>
          <button className="iconbtn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <ApiKeysCard
            orgs={[org]}
            defaultOrgId={org.id}
            scopeOrgId={org.id}
            defaultName={account.name}
            mobile={mobile}
            embedded
            title={t('keys')}
            source={source}
          />
        </div>
      </div>
    </div>
  )
}
