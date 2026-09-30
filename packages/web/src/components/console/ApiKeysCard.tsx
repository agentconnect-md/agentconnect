'use client'

// The caller's personal API keys: each acts as you, with your role, in the one org it is minted for (daemon-api-key-auth.md §8).
// Name, expiry, permission and agents are edited in place with the same secret; Regenerate alone reveals a new plaintext once (§6).
// Self-contained: fetches `/me/keys` and renders its own scrim dialogs, so it drops into the Profile layouts and a service account's keys.

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { MOCK_MODE, agentLabel, type Agent } from '@/lib/data'
import { AgentIconView } from '@/components/marks'
import { FieldSelect } from '@/components/console/FieldSelect'
import {
  fetchMyApiKeys,
  createMyApiKey,
  updateMyApiKey,
  regenerateMyApiKey,
  revokeMyApiKey,
  fetchAgents,
  fmtDate,
  type ApiKeyPermission,
  type UserApiKeyDto,
  type MintedUserKeyDto,
  type OrgDto
} from '@/lib/api'
import { consoleKeys, profileKeys } from '@/lib/swr-keys'
import { Scrim } from '@/components/console/Scrim'

/** Where the card reads and writes keys; the default is the caller's own `/me/keys`. */
export interface ApiKeySource {
  swrKey: readonly unknown[] | null
  list: () => Promise<UserApiKeyDto[]>
  create: typeof createMyApiKey
  update: typeof updateMyApiKey
  regenerate: typeof regenerateMyApiKey
  revoke: typeof revokeMyApiKey
  /** A service account's keys: the org is fixed and the keys do not act as the caller. */
  serviceAccount?: boolean
}

export const MY_KEYS: ApiKeySource = {
  swrKey: profileKeys.apiKeys,
  list: fetchMyApiKeys,
  create: createMyApiKey,
  update: updateMyApiKey,
  regenerate: regenerateMyApiKey,
  revoke: revokeMyApiKey
}

// The dialog's permission choices, in the order offered (daemon-api-key-auth.md §6).
const PERMISSIONS: ApiKeyPermission[] = ['full', 'read', 'agent:chat']

// `days: null` mints a non-expiring key (server accepts `expiresInDays: null`).
const EXPIRY_OPTIONS: { days: number | null }[] = [
  { days: 30 },
  { days: 60 },
  { days: 90 },
  { days: 365 },
  { days: null }
]

type KeyState = 'active' | 'expired'

function keyState(k: UserApiKeyDto): KeyState {
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) return 'expired'
  return 'active'
}

const orgLabel = (k: UserApiKeyDto) => k.orgName ?? k.orgSlug

type T = ReturnType<typeof useTranslations<'Profile'>>

const expiryText = (expiresAt: string | null, t: T) =>
  expiresAt ? t('apiKeys.expires', { date: fmtDate(expiresAt) }) : t('apiKeys.neverExpires')

/** The list's permission label; `full` is the default and shows nothing, like an unexpired key. */
function permissionLabel(k: UserApiKeyDto, t: T): string | null {
  if (k.permission === 'full') return null
  if (k.permission === 'read') return t('apiKeys.permissionRead')
  // Named agents, so the list says which ones; an emptied selection reaches no agent and says so.
  const agents = k.allAgents
    ? t('apiKeys.allAgents')
    : k.agents.length === 0
      ? t('apiKeys.agentCount', { count: 0 })
      : k.agents.map((a) => agentLabel({ name: a.name, displayName: a.displayName ?? undefined })).join(', ')
  return `${t('apiKeys.permissionAgentChat')} · ${agents}`
}

// ── the card ────────────────────────────────────────────────────────────────
export default function ApiKeysCard({
  orgs,
  defaultOrgId,
  mobile = false,
  scopeOrgId,
  defaultName,
  embedded = false,
  title,
  description,
  source = MY_KEYS
}: {
  orgs: OrgDto[]
  defaultOrgId?: string
  mobile?: boolean
  /** Limit the list to one org. Creation is still constrained by `orgs`. */
  scopeOrgId?: string
  /** Suggested name in the create dialog (the user can still edit it). */
  defaultName?: string
  /** Drop the Profile page's standalone top margin when composed inside another view. */
  embedded?: boolean
  title?: string
  description?: string
  /** A service account's keys instead of the caller's own. */
  source?: ApiKeySource
}) {
  const t = useTranslations('Profile')
  const resolvedTitle = title ?? t('apiKeys.title')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<UserApiKeyDto | null>(null)
  const [regenerating, setRegenerating] = useState<UserApiKeyDto | null>(null)
  const [revoking, setRevoking] = useState<UserApiKeyDto | null>(null)
  const {
    data: keysData,
    error: loadError,
    isLoading: loading,
    mutate: mutateKeys
  } = useSWR<UserApiKeyDto[]>(MOCK_MODE ? null : source.swrKey, source.list)
  const keys = keysData ?? []
  const reload = () => {
    void mutateKeys().catch(() => undefined)
  }

  // Mock mode must never send a key mutation carrying its synthetic org id to a
  // configured CP. Keep the documentation visible, but remove the write action.
  const canCreate = orgs.length > 0 && !MOCK_MODE
  const visibleKeys = keys.filter((k) => !k.revokedAt && (!scopeOrgId || k.orgId === scopeOrgId))
  const newBtn = canCreate ? (
    <Button variant="secondary" size="xs" onClick={() => setCreating(true)}>
      <Icon name="key" size={14} />
      {t('apiKeys.newKey')}
    </Button>
  ) : null

  const rows = visibleKeys.map((k) => {
    const state = keyState(k)
    const stateBadge =
      state === 'expired'
        ? { text: t('apiKeys.expired'), bg: 'var(--surface-active)', fg: 'var(--text-tertiary)' }
        : null
    const permission = permissionLabel(k, t)
    return (
      <div
        key={k.id}
        className="row grid-cols-1 gap-[6px] desktop:grid-cols-[1fr_auto_auto] desktop:items-center desktop:gap-[14px]"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`mono text-[12.5px] ${state === 'active' ? '' : 'opacity-60'}`}>{k.displayTail}</span>
            {k.name && (
              <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                · {k.name}
              </span>
            )}
            {!scopeOrgId && (
              <span
                className="badge bg-(--surface-active) text-(--text-secondary)"
                title={t('apiKeys.organizationHint')}
              >
                {orgLabel(k)}
              </span>
            )}
            {permission && <span className="badge bg-(--surface-active) text-(--text-secondary)">{permission}</span>}
            {stateBadge && (
              <span className="badge" style={{ background: stateBadge.bg, color: stateBadge.fg }}>
                {stateBadge.text}
              </span>
            )}
          </div>
          <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {k.lastUsedAt ? t('apiKeys.used', { date: fmtDate(k.lastUsedAt) }) : t('apiKeys.neverUsed')}
            {state === 'active' && (
              <span className="desktop:hidden">
                {' · '}
                {expiryText(k.expiresAt, t)}
              </span>
            )}
          </div>
        </div>
        <span className="hidden font-sans text-[12px] font-normal leading-normal whitespace-nowrap text-(--text-tertiary) desktop:block">
          {state === 'active' ? expiryText(k.expiresAt, t) : ''}
        </span>
        {state === 'active' ? (
          <div className="flex items-center gap-3">
            <button className="lnk" onClick={() => setEditing(k)}>
              {t('apiKeys.edit')}
            </button>
            <button className="lnk" onClick={() => setRegenerating(k)}>
              {t('apiKeys.regenerate')}
            </button>
            <button className="lnk text-(--red-600)" onClick={() => setRevoking(k)}>
              {t('apiKeys.revoke')}
            </button>
          </div>
        ) : (
          <span className="hidden w-12 desktop:block" />
        )}
      </div>
    )
  })

  const empty = (
    <div className="px-4 py-[22px] text-center">
      <div className="font-sans text-[13px] font-semibold leading-normal">{t('apiKeys.emptyTitle')}</div>
      <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
        {MOCK_MODE ? t('apiKeys.mockUnavailable') : t('apiKeys.emptyBody')}
      </div>
    </div>
  )

  const loadFailure = (
    <div className="px-4 py-[18px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
      {t('apiKeys.loadError')}
    </div>
  )

  const body =
    loadError && keysData === undefined ? (
      loadFailure
    ) : loading ? (
      <div className="px-4 py-[18px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
        {t('apiKeys.loading')}
      </div>
    ) : visibleKeys.length === 0 ? (
      empty
    ) : mobile ? (
      <div className="py-1">{rows}</div>
    ) : (
      rows
    )

  const dialogs = (
    <>
      {creating && (
        <Scrim onEscape={() => setCreating(false)}>
          <div className="modal">
            <ApiKeyFormModal
              source={source}
              orgs={orgs}
              defaultOrgId={defaultOrgId}
              defaultName={defaultName}
              onClose={() => setCreating(false)}
              onSaved={reload}
            />
          </div>
        </Scrim>
      )}
      {editing && (
        <Scrim onEscape={() => setEditing(null)}>
          <div className="modal">
            <ApiKeyFormModal
              source={source}
              orgs={orgs}
              editing={editing}
              onClose={() => setEditing(null)}
              onSaved={reload}
            />
          </div>
        </Scrim>
      )}
      {regenerating && (
        <Scrim onEscape={() => setRegenerating(null)}>
          <div className="modal">
            <RegenerateApiKeyModal
              source={source}
              apiKey={regenerating}
              onClose={() => setRegenerating(null)}
              onRegenerated={reload}
            />
          </div>
        </Scrim>
      )}
      {revoking && (
        <Scrim onEscape={() => setRevoking(null)}>
          <div className="modal">
            <RevokeApiKeyModal source={source} apiKey={revoking} onClose={() => setRevoking(null)} onRevoked={reload} />
          </div>
        </Scrim>
      )}
    </>
  )

  // ── mobile: match the Profile page's inline card styling ──
  if (mobile) {
    return (
      <div className="overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
        <div className="flex items-center justify-between gap-3 border-b border-(--border-subtle) px-4 py-3">
          <span className="font-sans text-[14px] font-semibold leading-normal">{resolvedTitle}</span>
          {newBtn}
        </div>
        {description && (
          <p className="m-0 border-b border-(--border-subtle) px-4 py-3 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
            {description}
          </p>
        )}
        {body}
        {dialogs}
      </div>
    )
  }

  // ── desktop ──
  return (
    <div className={embedded ? 'card overflow-hidden' : 'card mt-[18px]'}>
      <div className="cardhead justify-between">
        <span className="cardtitle">{resolvedTitle}</span>
        {newBtn}
      </div>
      {description && (
        <p className="m-0 border-b border-(--border-subtle) px-4 py-3 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          {description}
        </p>
      )}
      {body}
      {dialogs}
    </div>
  )
}

// ── the one-time plaintext reveal, shared by create and regenerate ──────────
function KeyReveal({ apiKey }: { apiKey: string }) {
  const t = useTranslations('Profile')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (insecure context) — user can still select the text */
    }
  }
  return (
    <>
      <div className="mb-[14px] flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[11px]">
        <Icon name="triangle-alert" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
        <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
          {t('apiKeys.copyWarning')}
        </span>
      </div>
      <div className="overflow-hidden rounded-[9px] border border-(--gray-800) bg-(--gray-1000)">
        <div className="flex items-center gap-2 border-b border-(--gray-800) px-[13px] py-[9px]">
          <Icon name="key" size={13} color="var(--text-inverse-dim)" />
          <span className="font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)">
            {t('apiKeys.apiKey')}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            className="ml-auto inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)"
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
          </button>
        </div>
        <div className="break-all px-[14px] py-[13px] font-mono text-[12px] leading-[1.7] text-[#cdd6e0]">{apiKey}</div>
      </div>
    </>
  )
}

function RevealFooter({ onClose }: { onClose: () => void }) {
  const t = useTranslations('Profile')
  return (
    <>
      <span className="mono text-[11px] text-(--text-tertiary)">{t('apiKeys.shownOnce')}</span>
      <div className="flex-1" />
      <Button variant="primary" onClick={onClose}>
        {t('apiKeys.done')}
      </Button>
    </>
  )
}

/** Who a new key is minted for, when the dialog offers the choice: the caller, or one of the org's service accounts. */
export interface ApiKeyOwner {
  id: string
  label: string
  serviceAccount: boolean
  source: ApiKeySource
}

// ── create / edit dialog (org picker → mint → one-time reveal; or edit in place) ──
export function ApiKeyFormModal({
  source,
  orgs,
  defaultOrgId,
  defaultName,
  editing,
  owners,
  defaultPermission,
  defaultAgentIds,
  onClose,
  onSaved
}: {
  source: ApiKeySource
  orgs: OrgDto[]
  defaultOrgId?: string
  defaultName?: string
  /** The key being edited; the org is fixed and the same secret stays in force. */
  editing?: UserApiKeyDto
  /** Offer an Owner choice, first entry preselected; the org is then fixed to `defaultOrgId`. */
  owners?: ApiKeyOwner[]
  defaultPermission?: ApiKeyPermission
  /** Preselected agents for an agent-level permission. */
  defaultAgentIds?: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('Profile')
  const [orgId, setOrgId] = useState(editing?.orgId ?? defaultOrgId ?? orgs[0]?.id ?? '')
  const [name, setName] = useState(editing?.name ?? defaultName ?? '')
  const [ownerId, setOwnerId] = useState(owners?.[0]?.id ?? '')
  const owner = owners?.find((o) => o.id === ownerId)
  const target = owner?.source ?? source
  // `'keep'` (edit only) leaves the stored expiry alone; a number or null is a new lifetime from now.
  const [expiresInDays, setExpiresInDays] = useState<number | null | 'keep'>(editing ? 'keep' : 90)
  const [permission, setPermission] = useState<ApiKeyPermission>(editing?.permission ?? defaultPermission ?? 'full')
  const [agentScope, setAgentScope] = useState<'all' | 'selected'>(
    (editing && !editing.allAgents) || (!editing && defaultAgentIds?.length) ? 'selected' : 'all'
  )
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>(editing?.agentIds ?? defaultAgentIds ?? [])
  const [minted, setMinted] = useState<MintedUserKeyDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // The chosen org's agents, fetched only once a selection is being made and gated on the org (the key is null without one).
  const agentLevel = permission === 'agent:chat'
  const selecting = agentLevel && agentScope === 'selected'
  const { data: agents } = useSWR<Agent[]>(selecting ? consoleKeys.agents(orgId) : null, ([, id]) =>
    fetchAgents(id as string)
  )
  const pickOrg = (next: string) => {
    setOrgId(next)
    setSelectedAgentIds([]) // agents belong to one org
  }
  const toggleAgent = (id: string) =>
    setSelectedAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  const canSubmit = !busy && !!orgId && (!selecting || selectedAgentIds.length > 0)

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setErr(null)
    try {
      if (editing) {
        // Send only what changed; the server refuses an empty patch, so nothing changed just closes.
        const trimmed = name.trim()
        const sameSelection =
          agentScope === 'all'
            ? editing.allAgents
            : !editing.allAgents &&
              selectedAgentIds.length === editing.agentIds.length &&
              selectedAgentIds.every((id) => editing.agentIds.includes(id))
        const patch = {
          ...(trimmed !== (editing.name ?? '') ? { name: trimmed || null } : {}),
          ...(expiresInDays !== 'keep' ? { expiresInDays } : {}),
          ...(permission !== editing.permission ? { permission } : {}),
          ...(agentLevel && (permission !== editing.permission || !sameSelection)
            ? { agents: agentScope === 'all' ? ('all' as const) : selectedAgentIds }
            : {})
        }
        if (Object.keys(patch).length > 0) {
          await source.update(editing.id, patch)
          onSaved()
        }
        onClose()
        return
      }
      const m = await target.create({
        orgId,
        ...(name.trim() ? { name: name.trim() } : {}),
        expiresInDays: expiresInDays === 'keep' ? 90 : expiresInDays,
        permission,
        ...(agentLevel ? { agents: agentScope === 'all' ? 'all' : selectedAgentIds } : {})
      })
      setMinted(m)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="key" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {minted ? t('apiKeys.createdTitle') : editing ? t('apiKeys.editTitle') : t('apiKeys.createTitle')}
        </span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        {minted ? (
          <KeyReveal apiKey={minted.apiKey} />
        ) : (
          <>
            {!source.serviceAccount && !owners && (
              <p className="mb-4 font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
                {t('apiKeys.description')}
              </p>
            )}
            <div className="flex flex-col gap-[14px]">
              <div className={source.serviceAccount || owners ? 'hidden' : 'flex flex-col gap-[6px]'}>
                <span className="fldlbl">{t('apiKeys.organization')}</span>
                <FieldSelect
                  ariaLabel={t('apiKeys.organization')}
                  value={orgId}
                  disabled={!!editing}
                  onChange={pickOrg}
                  options={(editing ? [{ id: editing.orgId, slug: editing.orgSlug, name: editing.orgName }] : orgs).map(
                    (o) => ({ value: o.id, label: o.name ?? o.slug })
                  )}
                />
              </div>
              <div className="flex flex-col gap-[6px]">
                <span className="fldlbl">{t('apiKeys.nameOptional')}</span>
                <input
                  className="inp placeholder:text-(--text-tertiary)"
                  placeholder={t('apiKeys.namePlaceholder')}
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              {owners && (
                <div className="flex flex-col gap-[6px]">
                  <span className="fldlbl">{t('apiKeys.owner')}</span>
                  <FieldSelect
                    ariaLabel={t('apiKeys.owner')}
                    value={ownerId}
                    onChange={setOwnerId}
                    options={owners.map((o) => ({
                      value: o.id,
                      label: o.label,
                      ...(o.serviceAccount ? { tag: t('apiKeys.serviceAccount') } : {})
                    }))}
                  />
                </div>
              )}
              <div className="flex flex-col gap-[6px]">
                <span className="fldlbl">{t('apiKeys.permissionLabel')}</span>
                <FieldSelect
                  ariaLabel={t('apiKeys.permissionLabel')}
                  value={permission}
                  onChange={setPermission}
                  options={PERMISSIONS.map((p) => ({
                    value: p,
                    label:
                      p === 'full'
                        ? t('apiKeys.permissionFull')
                        : p === 'read'
                          ? t('apiKeys.permissionRead')
                          : t('apiKeys.permissionAgentChat')
                  }))}
                />
              </div>
              {agentLevel && (
                <div className="flex flex-col gap-[6px]">
                  <span className="fldlbl">{t('apiKeys.agentsLabel')}</span>
                  <FieldSelect
                    ariaLabel={t('apiKeys.agentsLabel')}
                    value={agentScope}
                    onChange={setAgentScope}
                    options={[
                      { value: 'all', label: t('apiKeys.allAgents') },
                      { value: 'selected', label: t('apiKeys.selectedAgents') }
                    ]}
                  />
                  {selecting && (
                    <div className="max-h-[200px] overflow-y-auto rounded-md border border-(--border-subtle)">
                      {agents === undefined ? (
                        <div className="px-3 py-[9px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                          {t('apiKeys.agentsLoading')}
                        </div>
                      ) : agents.length === 0 ? (
                        <div className="px-3 py-[9px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                          {t('apiKeys.noAgents')}
                        </div>
                      ) : (
                        agents.map((a) => (
                          <label
                            key={a.id}
                            className="flex cursor-pointer items-center gap-[9px] border-b border-(--border-subtle) px-3 py-[7px] last:border-b-0 hover:bg-(--surface-hover)"
                          >
                            <input
                              type="checkbox"
                              className="flex-none accent-(--brand)"
                              checked={selectedAgentIds.includes(a.id)}
                              onChange={() => toggleAgent(a.id)}
                            />
                            <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
                              <AgentIconView icon={a.icon} runtime={a.runtime} size={22} />
                            </span>
                            <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)">
                              {agentLabel(a)}
                            </span>
                          </label>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-[6px]">
                <span className="fldlbl">{t('apiKeys.expiresLabel')}</span>
                <FieldSelect
                  ariaLabel={t('apiKeys.expiresLabel')}
                  value={expiresInDays === 'keep' ? 'keep' : expiresInDays === null ? 'never' : String(expiresInDays)}
                  onChange={(v) => setExpiresInDays(v === 'keep' ? 'keep' : v === 'never' ? null : Number(v))}
                  options={[
                    ...(editing ? [{ value: 'keep', label: expiryText(editing.expiresAt, t) }] : []),
                    ...EXPIRY_OPTIONS.map((o) => ({
                      value: o.days === null ? 'never' : String(o.days),
                      label:
                        o.days === null
                          ? t('apiKeys.never')
                          : o.days === 365
                            ? t('apiKeys.oneYear')
                            : t('apiKeys.days', { count: o.days })
                    }))
                  ]}
                />
              </div>
            </div>
            {err && (
              <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
            )}
          </>
        )}
      </div>

      <div className="modalfoot">
        {minted ? (
          <RevealFooter onClose={onClose} />
        ) : (
          <>
            <div className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              {t('apiKeys.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              className={canSubmit ? undefined : 'pointer-events-none opacity-50'}
            >
              <Icon name="key" size={14} />
              {editing
                ? busy
                  ? t('apiKeys.saving')
                  : t('apiKeys.save')
                : busy
                  ? t('apiKeys.creating')
                  : t('apiKeys.create')}
            </Button>
          </>
        )}
      </div>
    </>
  )
}

// ── regenerate: confirm, then the new plaintext once ─────────────────────────
function RegenerateApiKeyModal({
  source,
  apiKey,
  onClose,
  onRegenerated
}: {
  source: ApiKeySource
  apiKey: UserApiKeyDto
  onClose: () => void
  onRegenerated: () => void
}) {
  const t = useTranslations('Profile')
  const [minted, setMinted] = useState<MintedUserKeyDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onConfirm = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      setMinted(await source.regenerate(apiKey.id))
      onRegenerated()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="refresh-cw" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {minted ? t('apiKeys.regeneratedTitle') : t('apiKeys.regenerateTitle')}
        </span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        {minted ? (
          <KeyReveal apiKey={minted.apiKey} />
        ) : (
          <>
            <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
              <span className="mono text-(--text-primary)">{apiKey.displayTail}</span>
              {apiKey.name ? ` (${apiKey.name})` : ''} {t('apiKeys.regenerateBody')}
            </p>
            {err && (
              <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                {err}
              </div>
            )}
          </>
        )}
      </div>
      <div className="modalfoot">
        {minted ? (
          <RevealFooter onClose={onClose} />
        ) : (
          <>
            <div className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              {t('apiKeys.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void onConfirm()}
              className={busy ? 'pointer-events-none opacity-50' : undefined}
            >
              <Icon name="refresh-cw" size={14} />
              {busy ? t('apiKeys.regenerating') : t('apiKeys.regenerate')}
            </Button>
          </>
        )}
      </div>
    </>
  )
}

// ── revoke confirm ────────────────────────────────────────────────────────────
function RevokeApiKeyModal({
  source,
  apiKey,
  onClose,
  onRevoked
}: {
  source: ApiKeySource
  apiKey: UserApiKeyDto
  onClose: () => void
  onRevoked: () => void
}) {
  const t = useTranslations('Profile')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onConfirm = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await source.revoke(apiKey.id)
      onRevoked()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft)">
          <Icon name="trash" size={16} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('apiKeys.revokeTitle')}</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          <span className="mono text-(--text-primary)">{apiKey.displayTail}</span>
          {apiKey.name ? ` (${apiKey.name})` : ''} {t('apiKeys.revokeBody')}
        </p>
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('apiKeys.cancel')}
        </Button>
        <Button
          variant="danger"
          onClick={() => void onConfirm()}
          className={busy ? 'pointer-events-none opacity-50' : undefined}
        >
          <Icon name="trash" size={15} />
          {busy ? t('apiKeys.revoking') : t('apiKeys.revoke')}
        </Button>
      </div>
    </>
  )
}
