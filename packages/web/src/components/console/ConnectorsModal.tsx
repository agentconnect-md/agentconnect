'use client'

// "Add connectors" surface for the open-connector integration. Opened from the MCP
// tools card's Add menu when the CP reports the integration is configured. Two views
// inside one modal — a provider browser (search + category filter) and a per-provider
// NEW-connection form. Every call goes through the Control Plane (lib/api
// fetchConnectorCatalog / useConsoleData().createConnectorConnection); creating a
// connection records it as an open_connector MCP provider. This surface only ADDS
// connections — it never shows or manages existing ones.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchConnectorCatalog,
  type ConnectorAuthDefinition,
  type ConnectorConnectionCreatedDto,
  type ConnectorProviderDto
} from '@/lib/api'
import {
  credentialFieldsFor,
  filterByCategory,
  filterProviders,
  initialAuthType,
  providerCategories,
  providerIconUrl,
  providerInitials,
  type CredentialField
} from '@/lib/connectors'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { VisibilityField, type SharingValue } from '@/components/console/VisibilityField'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

// Must match the CP's CreateConnectorConnectionBody rule (≤32, alphanumeric-led).
const CONNECTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

export function ConnectorsModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  /** Fired with the connection's provider row, so a caller can attach it to an agent. */
  onCreated?: (created: ConnectorConnectionCreatedDto) => void
}) {
  const [providers, setProviders] = useState<ConnectorProviderDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { providers } = await fetchConnectorCatalog()
      setProviders(providers)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const provider = selected ? providers?.find((p) => p.service === selected) : undefined

  return (
    <>
      <div className="modalhead">
        {provider ? (
          <button className="iconbtn" onClick={() => setSelected(null)} aria-label="Back to connectors">
            <Icon name="arrow-left" size={16} />
          </button>
        ) : (
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name="blocks" size={16} color="var(--brand)" />
          </span>
        )}
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {provider ? provider.displayName : 'Add connectors'}
        </span>
        <button className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Icon name="triangle-alert" size={22} color="var(--status-error)" />
            <div className="font-sans text-[13px] font-normal leading-[1.5] text-(--text-secondary)">{error}</div>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <Icon name="refresh-cw" size={14} />
              Retry
            </Button>
          </div>
        ) : !providers ? (
          <LoadingState size={22} padding={24} />
        ) : provider ? (
          <ProviderDetail provider={provider} onDone={onClose} onCreated={onCreated} />
        ) : (
          <ProviderBrowser providers={providers} onSelect={setSelected} />
        )}
      </div>
    </>
  )
}

// ── browse ────────────────────────────────────────────────────────────────────
function ProviderBrowser({
  providers,
  onSelect
}: {
  providers: ConnectorProviderDto[]
  onSelect: (service: string) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('')
  const categories = useMemo(() => providerCategories(providers), [providers])
  const shown = useMemo(
    () => filterByCategory(filterProviders(providers, query), category || null),
    [providers, query, category]
  )

  return (
    <div className="flex flex-col gap-[14px] desktop:flex-row desktop:items-stretch desktop:gap-5">
      {categories.length > 0 && (
        <aside className="hidden w-[176px] flex-none border-r border-(--border-subtle) pr-4 desktop:block">
          <nav
            className="sticky top-0 flex max-h-[calc(88vh-105px)] flex-col gap-1 overflow-y-auto"
            aria-label="Connector categories"
          >
            <span className="mb-1 px-[10px] font-sans text-[11px] font-semibold leading-normal text-(--text-tertiary)">
              Categories
            </span>
            <button
              type="button"
              className={categoryButtonClass(category === '')}
              onClick={() => setCategory('')}
              aria-pressed={category === ''}
            >
              All categories
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className={categoryButtonClass(category === c)}
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
              >
                {c}
              </button>
            ))}
          </nav>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-[14px]">
        <div className="flex items-center gap-2">
          <label className="relative flex flex-1 items-center">
            <Icon
              name="search"
              size={15}
              color="var(--text-tertiary)"
              className="pointer-events-none absolute left-[11px]"
            />
            <input
              className="inp mn pl-[34px]"
              placeholder="Search connectors…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search connectors"
            />
          </label>
          {categories.length > 0 && (
            <select
              className="inp mn w-[40%] max-w-[190px] desktop:hidden"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>

        {providers.length === 0 ? (
          <div className="px-4 py-9 text-center">
            <div className="font-sans text-[13px] font-semibold leading-normal">No connectors available</div>
            <div className="mx-auto mt-1 max-w-[430px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
              Non-OAuth connectors and OAuth providers with a configured client secret appear here, subject to the
              configured catalog filters. Configure one upstream or adjust those filters to make it available.
            </div>
          </div>
        ) : shown.length === 0 ? (
          <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            No connectors match your filters.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 desktop:grid-cols-2">
            {shown.map((p) => (
              <ProviderCard key={p.service} provider={p} onSelect={() => onSelect(p.service)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function categoryButtonClass(active: boolean): string {
  return active
    ? 'w-full cursor-pointer rounded-[7px] border-0 bg-(--brand-soft) px-[10px] py-2 text-left font-sans text-[12.5px] font-semibold leading-normal text-(--brand)'
    : 'w-full cursor-pointer rounded-[7px] border-0 bg-transparent px-[10px] py-2 text-left font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'
}

function ProviderCard({ provider, onSelect }: { provider: ConnectorProviderDto; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="flex w-full cursor-pointer items-center gap-[11px] rounded-[9px] border border-(--border-default) bg-(--surface-card) px-[13px] py-[11px] text-left transition-[background-color,border-color] hover:border-(--border-strong) hover:bg-(--surface-hover)"
    >
      <ProviderIcon provider={provider} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
          {provider.displayName}
        </span>
        <span className="truncate font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {provider.service}
        </span>
      </span>
      <span className="badge bg-(--surface-active) text-(--text-secondary)">Add</span>
      <Icon name="chevron-right" size={15} color="var(--text-tertiary)" className="flex-none" />
    </button>
  )
}

function ProviderIcon({ provider, large }: { provider: ConnectorProviderDto; large?: boolean }) {
  const url = providerIconUrl(provider)
  const [broken, setBroken] = useState(false)
  const size = large ? 40 : 30
  const cls = 'flex flex-none items-center justify-center overflow-hidden rounded-[8px] bg-(--surface-sunken)'
  const style = { width: size, height: size }
  if (!url || broken) {
    return (
      <span className={cls} style={style}>
        <span className="font-sans text-[12px] font-semibold text-(--text-secondary)">
          {providerInitials(provider.displayName)}
        </span>
      </span>
    )
  }
  return (
    <span className={cls} style={style}>
      <img
        alt=""
        src={url}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="h-[62%] w-[62%] object-contain"
        onError={() => setBroken(true)}
      />
    </span>
  )
}

// ── detail / new connection ───────────────────────────────────────────────────
function ProviderDetail({
  provider,
  onDone,
  onCreated
}: {
  provider: ConnectorProviderDto
  onDone: () => void
  onCreated?: (created: ConnectorConnectionCreatedDto) => void
}) {
  const [authType, setAuthType] = useState<ConnectorAuthDefinition['type'] | undefined>(() => initialAuthType(provider))
  const auth = provider.auth.find((a) => a.type === authType) ?? provider.auth[0]
  const hasMultiple = provider.auth.length > 1

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="flex items-start gap-[12px]">
        <ProviderIcon provider={provider} large />
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {provider.service}
          </span>
          {provider.description && (
            <p className="mt-[5px] font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
              {provider.description}
            </p>
          )}
        </div>
        {provider.homepageUrl && (
          <a
            href={provider.homepageUrl}
            target="_blank"
            rel="noreferrer"
            className="lnk flex flex-none items-center gap-[5px] text-[12px]"
          >
            Homepage
            <Icon name="arrow-up-right" size={13} />
          </a>
        )}
      </div>

      {hasMultiple && (
        <div className="flex gap-1 rounded-[8px] bg-(--surface-sunken) p-[3px]">
          {provider.auth.map((a) => (
            <button
              key={a.type}
              onClick={() => setAuthType(a.type)}
              className={`flex-1 cursor-pointer rounded-[6px] border-0 px-3 py-[6px] font-sans text-[12.5px] font-medium leading-normal ${
                a.type === auth?.type
                  ? 'bg-(--surface-card) text-(--text-primary) shadow-(--shadow-sm)'
                  : 'bg-transparent text-(--text-secondary)'
              }`}
            >
              {authLabel(a.type)}
            </button>
          ))}
        </div>
      )}

      {auth ? (
        <ConnectionForm
          key={`${provider.service}:${auth.type}`}
          provider={provider}
          auth={auth}
          onDone={onDone}
          onCreated={onCreated}
        />
      ) : (
        <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          This connector has no supported connection method.
        </div>
      )}
    </div>
  )
}

function ConnectionForm({
  provider,
  auth,
  onDone,
  onCreated
}: {
  provider: ConnectorProviderDto
  auth: ConnectorAuthDefinition
  onDone: () => void
  onCreated?: (created: ConnectorConnectionCreatedDto) => void
}) {
  const { createConnectorConnection } = useConsoleData()
  const { me } = useProfile()
  const fields = credentialFieldsFor(auth)
  const [connectionName, setConnectionName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [sharing, setSharing] = useState<SharingValue>({ visibility: 'org', sharedWith: [] })
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameValid = CONNECTION_NAME_RE.test(connectionName)

  const submit = async () => {
    if (busy || !nameValid) return
    setBusy(true)
    setStatus(auth.type === 'oauth2' ? 'Opening authorization…' : 'Saving…')
    try {
      const created = await createConnectorConnection({
        service: provider.service,
        connectionName,
        authType: auth.type,
        ...(auth.type === 'oauth2' || auth.type === 'no_auth' ? {} : { values }),
        // Atomic restricted-create: the CP intersects sharedWith with org members.
        ...(sharing.visibility === 'restricted'
          ? { visibility: 'restricted' as const, sharedWith: sharing.sharedWith }
          : {})
      })
      // The provider row exists the moment the CP accepts the connection — including
      // on the oauth2 path, where the popup finishes independently — so a caller
      // attaching it to an agent hears about it here, not after the sign-in lands.
      onCreated?.(created)
      if (auth.type === 'oauth2') {
        if (created.authorizationUrl) {
          window.open(created.authorizationUrl, 'connectors_oauth', oauthPopupFeatures())
          setStatus('Complete the sign-in in the popup window…')
        } else {
          setStatus('Connection created, but authorization did not start.')
        }
        // The connection (and its MCP tool) is already recorded; close and let the
        // popup finish independently.
        onDone()
        return
      }
      onDone()
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Failed to create connection.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-[14px]">
      <label className="fld">
        <span className="fldlbl">Connection name</span>
        <input
          className="inp"
          value={connectionName}
          placeholder="e.g. prod-gmail"
          maxLength={32}
          onChange={(e) => setConnectionName(e.target.value)}
        />
        <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          Unique within your organization · letters, digits, <code>_</code> or <code>-</code> (max 32).
        </span>
      </label>

      {auth.type === 'oauth2' ? (
        <div className="flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px]">
          <Icon name="shield-check" size={15} color="var(--brand)" className="mt-[1px] flex-none" />
          <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
            Sign in with {provider.displayName} in a popup to authorize this connection.
          </span>
        </div>
      ) : auth.type === 'no_auth' ? (
        <div className="flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px]">
          <Icon name="check-circle-2" size={15} color="var(--status-online-text)" className="mt-[1px] flex-none" />
          <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
            This connector needs no credentials — just name it and add.
          </span>
        </div>
      ) : null}

      {fields.map((f) => (
        <CredentialInput
          key={f.key}
          field={f}
          value={values[f.key] ?? ''}
          onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))}
        />
      ))}

      <VisibilityField value={sharing} onChange={setSharing} />

      <div>
        <Button
          variant="primary"
          onClick={() => void submit()}
          className={busy || !nameValid ? 'pointer-events-none opacity-50' : undefined}
        >
          <Icon name={auth.type === 'oauth2' ? 'external-link' : 'plus'} size={14} />
          {auth.type === 'oauth2' ? `Connect ${provider.displayName}` : 'Add connection'}
        </Button>
      </div>
      {status && <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">{status}</div>}
    </div>
  )
}

function CredentialInput({
  field,
  value,
  onChange
}: {
  field: CredentialField
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="fld">
      <span className="fldlbl">{field.label}</span>
      {field.inputType === 'textarea' || field.inputType === 'json' ? (
        <textarea
          className="dsinput-field mono min-h-24 resize-y text-xs leading-relaxed"
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <input
          className="inp"
          type={field.secret ? 'password' : 'text'}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.description && (
        <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {field.description}
        </span>
      )}
    </label>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────────
function authLabel(type: ConnectorAuthDefinition['type']): string {
  if (type === 'api_key') return 'API key'
  if (type === 'oauth2') return 'OAuth'
  if (type === 'custom_credential') return 'Custom'
  return 'No auth'
}

function oauthPopupFeatures(): string {
  const width = 520
  const height = 720
  const left = Math.round(window.screenX + (window.outerWidth - width) / 2)
  const top = Math.round(window.screenY + (window.outerHeight - height) / 2)
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
}
