'use client'

// The caller's personal API keys, on the Profile page. A key authenticates the
// AgentConnect REST API *as you*, with your role, in the ONE org it is minted for
// (permissions are per-org — daemon-api-key-auth.md §8). So the create dialog always
// picks an org (defaulting to the active one). The plaintext is shown exactly once.
//
// Self-contained: it fetches `/me/keys` and renders its own create/revoke dialogs in
// a scrim (mirrors the Settings→Bots local-modal pattern), so it drops into the
// Profile layouts and the agent API tab.

import { useState } from 'react'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { MOCK_MODE } from '@/lib/data'
import {
  fetchMyApiKeys,
  createMyApiKey,
  revokeMyApiKey,
  fmtDate,
  type UserApiKeyDto,
  type MintedUserKeyDto,
  type OrgDto
} from '@/lib/api'
import { profileKeys } from '@/lib/swr-keys'

// `days: null` mints a non-expiring key (server accepts `expiresInDays: null`).
const EXPIRY_OPTIONS: { days: number | null; label: string }[] = [
  { days: 30, label: '30 days' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: null, label: 'Never' }
]

type KeyState = 'active' | 'expired'

function keyState(k: UserApiKeyDto): KeyState {
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) return 'expired'
  return 'active'
}

const orgLabel = (k: UserApiKeyDto) => k.orgName ?? k.orgSlug

function lastUsedLabel(k: UserApiKeyDto): string {
  if (!k.lastUsedAt) return 'never used'
  return `used ${fmtDate(k.lastUsedAt)}`
}

// ── the card ────────────────────────────────────────────────────────────────
export default function ApiKeysCard({
  orgs,
  defaultOrgId,
  mobile = false,
  scopeOrgId,
  defaultName,
  embedded = false,
  title = 'API keys',
  description
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
}) {
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<UserApiKeyDto | null>(null)
  const {
    data: keysData,
    error: loadError,
    isLoading: loading,
    mutate: mutateKeys
  } = useSWR<UserApiKeyDto[]>(MOCK_MODE ? null : profileKeys.apiKeys, fetchMyApiKeys)
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
      New key
    </Button>
  ) : null

  const rows = visibleKeys.map((k) => {
    const state = keyState(k)
    const stateBadge =
      state === 'expired' ? { text: 'expired', bg: 'var(--surface-active)', fg: 'var(--text-tertiary)' } : null
    return (
      <div
        key={k.id}
        className="row grid-cols-[1fr_auto] items-center gap-[10px] desktop:grid-cols-[1fr_auto_auto] desktop:gap-[14px]"
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
                title="the organization this key acts in"
              >
                {orgLabel(k)}
              </span>
            )}
            {stateBadge && (
              <span className="badge" style={{ background: stateBadge.bg, color: stateBadge.fg }}>
                {stateBadge.text}
              </span>
            )}
          </div>
          <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {lastUsedLabel(k)}
            {state === 'active' && (
              <span className="desktop:hidden">
                {' · '}
                {k.expiresAt ? `expires ${fmtDate(k.expiresAt)}` : 'never expires'}
              </span>
            )}
          </div>
        </div>
        <span className="hidden font-sans text-[12px] font-normal leading-normal whitespace-nowrap text-(--text-tertiary) desktop:block">
          {state === 'active' ? (k.expiresAt ? `expires ${fmtDate(k.expiresAt)}` : 'never expires') : ''}
        </span>
        {state === 'active' ? (
          <button className="lnk text-(--red-600)" onClick={() => setRevoking(k)}>
            Revoke
          </button>
        ) : (
          <span className="w-12" />
        )}
      </div>
    )
  })

  const empty = (
    <div className="px-4 py-[22px] text-center">
      <div className="font-sans text-[13px] font-semibold leading-normal">No API keys yet</div>
      <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
        {MOCK_MODE
          ? 'API key creation is unavailable in mock mode.'
          : 'Create a key to call the AgentConnect API as yourself.'}
      </div>
    </div>
  )

  const loadFailure = (
    <div className="px-4 py-[18px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
      Couldn’t load API keys. Try refreshing the page.
    </div>
  )

  const body =
    loadError && keysData === undefined ? (
      loadFailure
    ) : loading ? (
      <div className="px-4 py-[18px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
        Loading…
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
        <div className="scrim">
          <div className="modal">
            <CreateApiKeyModal
              orgs={orgs}
              defaultOrgId={defaultOrgId}
              defaultName={defaultName}
              onClose={() => setCreating(false)}
              onCreated={reload}
            />
          </div>
        </div>
      )}
      {revoking && (
        <div className="scrim">
          <div className="modal">
            <RevokeApiKeyModal apiKey={revoking} onClose={() => setRevoking(null)} onRevoked={reload} />
          </div>
        </div>
      )}
    </>
  )

  // ── mobile: match the Profile page's inline card styling ──
  if (mobile) {
    return (
      <div className="overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
        <div className="flex items-center justify-between gap-3 border-b border-(--border-subtle) px-4 py-3">
          <span className="font-sans text-[14px] font-semibold leading-normal">{title}</span>
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
        <span className="cardtitle">{title}</span>
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

// ── create dialog (org picker → mint → one-time reveal) ───────────────────────
function CreateApiKeyModal({
  orgs,
  defaultOrgId,
  defaultName,
  onClose,
  onCreated
}: {
  orgs: OrgDto[]
  defaultOrgId?: string
  defaultName?: string
  onClose: () => void
  onCreated: () => void
}) {
  const [orgId, setOrgId] = useState(defaultOrgId ?? orgs[0]?.id ?? '')
  const [name, setName] = useState(defaultName ?? '')
  const [expiresInDays, setExpiresInDays] = useState<number | null>(90)
  const [minted, setMinted] = useState<MintedUserKeyDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const submit = async () => {
    if (busy || !orgId) return
    setBusy(true)
    setErr(null)
    try {
      const m = await createMyApiKey({
        orgId,
        ...(name.trim() ? { name: name.trim() } : {}),
        expiresInDays
      })
      setMinted(m)
      onCreated()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!minted) return
    try {
      await navigator.clipboard.writeText(minted.apiKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (insecure context) — user can still select the text */
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="key" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {minted ? 'API key created' : 'Create API key'}
        </span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        {minted ? (
          <>
            <div className="mb-[14px] flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[11px]">
              <Icon name="alert-triangle" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                Copy this key now — it is shown only once and cannot be retrieved. Store it somewhere safe.
              </span>
            </div>
            <div className="overflow-hidden rounded-[9px] border border-(--gray-800) bg-(--gray-1000)">
              <div className="flex items-center gap-2 border-b border-(--gray-800) px-[13px] py-[9px]">
                <Icon name="key" size={13} color="var(--text-inverse-dim)" />
                <span className="font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)">
                  API key
                </span>
                <button
                  type="button"
                  onClick={copy}
                  className="ml-auto inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)"
                >
                  <Icon name={copied ? 'check' : 'copy'} size={12} />
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
              <div className="break-all px-[14px] py-[13px] font-mono text-[12px] leading-[1.7] text-[#cdd6e0]">
                {minted.apiKey}
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="mb-4 font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
              This key calls the AgentConnect API as you, with your role in the chosen organization. Treat it like a
              password.
            </p>
            <div className="flex flex-col gap-[14px]">
              <div className="flex flex-col gap-[6px]">
                <span className="fldlbl">Organization</span>
                <select className="dsinput-field" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name ?? o.slug}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-[6px]">
                <span className="fldlbl">Name (optional)</span>
                <input
                  className="dsinput-field"
                  placeholder="e.g. ci-runner"
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-[6px]">
                <span className="fldlbl">Expires</span>
                <select
                  className="dsinput-field"
                  value={expiresInDays === null ? 'never' : String(expiresInDays)}
                  onChange={(e) => setExpiresInDays(e.target.value === 'never' ? null : Number(e.target.value))}
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.label} value={o.days === null ? 'never' : String(o.days)}>
                      {o.label}
                    </option>
                  ))}
                </select>
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
          <>
            <span className="mono text-[11px] text-(--text-tertiary)">shown only once</span>
            <div className="flex-1" />
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <div className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              className={busy || !orgId ? 'pointer-events-none opacity-50' : undefined}
            >
              <Icon name="key" size={14} />
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </>
        )}
      </div>
    </>
  )
}

// ── revoke confirm ────────────────────────────────────────────────────────────
function RevokeApiKeyModal({
  apiKey,
  onClose,
  onRevoked
}: {
  apiKey: UserApiKeyDto
  onClose: () => void
  onRevoked: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onConfirm = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await revokeMyApiKey(apiKey.id)
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
          <Icon name="trash-2" size={16} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Revoke API key</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          <span className="mono text-(--text-primary)">{apiKey.displayTail}</span>
          {apiKey.name ? ` (${apiKey.name})` : ''}
          {
            ' will stop working immediately. Any script or integration using it will start getting 401s. This can’t be undone.'
          }
        </p>
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => void onConfirm()}
          className={busy ? 'pointer-events-none opacity-50' : undefined}
        >
          <Icon name="trash-2" size={15} />
          {busy ? 'Revoking…' : 'Revoke'}
        </Button>
      </div>
    </>
  )
}
