'use client'

// Connectors & MCP servers card (Tools & Skills page) — the org-level MCP-provider
// registry (centralized-tool-management.md §4-§7). Each provider is an upstream
// MCP server the CP proxies to agents through a relay; agents receive a proxy URL
// + a bearer grant key and never see the upstream url/credential. This card shows
// the providers as a 3-up tile grid (mark / name / kind / access / added date) and
// drives create / edit / delete; transport, url, and header names stay in the edit
// dialog. The "Add" button opens a source menu (the open-connector browser first,
// then "Custom MCP provider" by URL).
//
// SECRET DISCIPLINE mirrors the CP: upstream header VALUES are write-only (blank on
// edit = keep the current set) and the bearer grant key is shown EXACTLY ONCE on
// create — never retrievable afterward. Self-contained (own create/edit/delete
// dialogs in a scrim, like the API-keys card).

import { useRef, useState } from 'react'
import useSWR from 'swr'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import {
  fetchConnectorCatalog,
  fmtDate,
  type McpProviderDto,
  type McpProviderCreatedDto,
  type McpHeaderInput,
  type ConnectorAuthDefinition
} from '@/lib/api'
import { credentialFieldsFor, initialAuthType, type CredentialField } from '@/lib/connectors'
import { VisibilityField, VisibilityValue, sameSharing, type SharingValue } from '@/components/console/VisibilityField'
import { ProviderMark, ToolTile, ToolTileGrid, useConnectorIcons } from '@/components/console/ToolTile'
import { ConnectorsModal } from '@/components/console/ConnectorsModal'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

export function McpServersCard({ canWrite }: { canWrite: boolean }) {
  const { mcpProviders, mcpProvidersLoading, connectorsEnabled } = useConsoleData()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<McpProviderDto | null>(null)
  const [deleting, setDeleting] = useState<McpProviderDto | null>(null)
  const [addingConnectors, setAddingConnectors] = useState(false)
  const canAddConnectors = connectorsEnabled

  // Resolve open_connector providers' icons from the connector catalog (same source
  // the Add-connectors browser uses). Fetched once, only when there's a connector row
  // to decorate — custom providers keep the generic plug glyph.
  const hasConnectorRows = mcpProviders.some((p) => p.kind === 'open_connector' && p.service)
  const iconByService = useConnectorIcons(connectorsEnabled && hasConnectorRows)

  const empty = (
    <div className="px-4 py-7 text-center">
      <div className="font-sans text-[13px] font-semibold leading-normal">No connectors or MCPs yet</div>
      <div className="mx-auto mt-1 max-w-[430px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
        Register an upstream MCP server once and any agent in this organization can enable it — the tool calls are
        proxied through a relay with a managed grant key, so the upstream URL and credentials stay here.
      </div>
    </div>
  )

  return (
    <div className="card mb-[18px]">
      <div className="cardhead justify-between">
        <span className="cardtitle">Connectors & MCP servers</span>
        {canWrite && (
          <AnchoredFlyout
            ariaLabel="Add connector or MCP server"
            estimatedHeight={canAddConnectors ? 154 : 78}
            trigger={({ open, menuId, toggle }) => (
              <Button
                variant="secondary"
                size="xs"
                onClick={toggle}
                ariaExpanded={open}
                ariaHasPopup="menu"
                ariaControls={open ? menuId : undefined}
              >
                <Icon name="plus" size={14} />
                Add
                <Icon name="chevron-down" size={13} color="var(--text-tertiary)" />
              </Button>
            )}
          >
            {({ close }) => (
              <>
                {canAddConnectors && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      close()
                      setAddingConnectors(true)
                    }}
                    className="flex w-full cursor-pointer items-start gap-[9px] rounded-[6px] border-0 bg-transparent p-[10px] text-left hover:bg-(--surface-hover)"
                  >
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
                      <Icon name="blocks" size={16} color="var(--brand)" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                        Add connectors
                      </span>
                      <span className="mt-[2px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
                        Browse and connect open-connector providers
                      </span>
                    </span>
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    close()
                    setCreating(true)
                  }}
                  className="flex w-full cursor-pointer items-start gap-[9px] rounded-[6px] border-0 bg-transparent p-[10px] text-left hover:bg-(--surface-hover)"
                >
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
                    <Icon name="plug" size={16} color="var(--brand)" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                      Custom MCP provider
                    </span>
                    <span className="mt-[2px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
                      Connect an upstream MCP server by URL
                    </span>
                  </span>
                </button>
              </>
            )}
          </AnchoredFlyout>
        )}
      </div>

      {mcpProvidersLoading && mcpProviders.length === 0 ? (
        <LoadingState size={22} padding={20} />
      ) : mcpProviders.length === 0 ? (
        empty
      ) : (
        <ToolTileGrid>
          {mcpProviders.map((p) => (
            <ProviderTile
              key={p.id}
              p={p}
              iconUrl={p.service ? iconByService.get(p.service) : undefined}
              canWrite={canWrite}
              onEdit={() => setEditing(p)}
              onDelete={() => setDeleting(p)}
            />
          ))}
        </ToolTileGrid>
      )}

      {creating && (
        <div className="scrim">
          <div className="modal">
            <CreateMcpProviderModal onClose={() => setCreating(false)} />
          </div>
        </div>
      )}
      {editing && (
        <div className="scrim">
          <div className="modal">
            {editing.kind === 'open_connector' ? (
              <EditConnectorModal provider={editing} onClose={() => setEditing(null)} />
            ) : (
              <EditMcpProviderModal provider={editing} onClose={() => setEditing(null)} />
            )}
          </div>
        </div>
      )}
      {deleting && (
        <div className="scrim">
          <div className="modal">
            <DeleteMcpProviderModal provider={deleting} onClose={() => setDeleting(null)} />
          </div>
        </div>
      )}
      {addingConnectors && (
        <div className="scrim">
          <div className="modal max-w-[920px]">
            <ConnectorsModal onClose={() => setAddingConnectors(false)} />
          </div>
        </div>
      )}
    </div>
  )
}

// One provider tile — the shared ToolTile (see ToolTile.tsx), with edit/delete as its
// action. The upstream url, transport, and header names are intentionally not surfaced
// here — they live in the edit dialog. open_connector tiles show the provider's catalog
// icon (falls back to the generic plug glyph).
function ProviderTile({
  p,
  iconUrl,
  canWrite,
  onEdit,
  onDelete
}: {
  p: McpProviderDto
  iconUrl?: string
  canWrite: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <ToolTile
      mark={<ProviderMark iconUrl={iconUrl} />}
      name={p.name}
      subtitle={p.kind === 'open_connector' ? 'Open connector' : 'Custom MCP server'}
      action={
        canWrite ? (
          <>
            <button className="iconbtn h-6 w-6" title="Edit" onClick={onEdit}>
              <Icon name="pencil" size={12} />
            </button>
            <button className="iconbtn h-6 w-6" title="Remove" onClick={onDelete}>
              <Icon name="trash-2" size={12} />
            </button>
          </>
        ) : undefined
      }
      footer={
        <div className="flex min-w-0 items-center gap-2">
          <VisibilityValue visibility={p.visibility} sharedWith={p.sharedWith} />
          <span className="mono ml-auto flex-none text-[10.5px] text-(--text-disabled)">
            added {fmtDate(p.createdAt)}
          </span>
        </div>
      }
    />
  )
}

// ── header rows editor ────────────────────────────────────────────────────────
// The write-only upstream auth headers. Each row is a name + value pair; blank rows
// are dropped on submit. Reused by the create and edit dialogs.
interface HeaderRow {
  name: string
  value: string
}

function HeadersEditor({
  rows,
  onChange,
  valuePlaceholder
}: {
  rows: HeaderRow[]
  onChange: (rows: HeaderRow[]) => void
  valuePlaceholder?: string
}) {
  const set = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const add = () => onChange([...rows, { name: '', value: '' }])
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  return (
    <div className="fld">
      <span className="fldlbl">
        Headers{' '}
        <span className="font-normal tracking-normal normal-case text-(--text-tertiary)">
          — sent to the upstream server; values are write-only
        </span>
      </span>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="dsinput-field mono min-w-0 flex-1"
              placeholder="Authorization"
              value={r.name}
              onChange={(e) => set(i, { name: e.target.value })}
              aria-label="Header name"
            />
            <input
              className="dsinput-field mono min-w-0 flex-1"
              placeholder={valuePlaceholder ?? 'Bearer …'}
              value={r.value}
              onChange={(e) => set(i, { value: e.target.value })}
              aria-label="Header value"
            />
            <button
              type="button"
              className="iconbtn flex-none"
              onClick={() => remove(i)}
              aria-label="Remove header"
              title="Remove header"
            >
              <Icon name="x" size={15} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={add}
          className="inline-flex w-fit cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-medium leading-normal text-(--brand)"
        >
          <Icon name="plus" size={14} />
          Add header
        </button>
      </div>
    </div>
  )
}

// Drop blank rows and shape into the API's header input list.
function cleanHeaders(rows: HeaderRow[]): McpHeaderInput[] {
  return rows.filter((r) => r.name.trim() && r.value.length > 0).map((r) => ({ name: r.name.trim(), value: r.value }))
}

// ── create dialog (form → mint; the grant key is minted server-side and pushed to
// the relay, but never surfaced here — agents enable the provider by name) ────────
/** Register an upstream MCP server. Reused by the agent detail view's Tools card,
 *  which passes `onCreated` to attach the new provider to that agent right away. */
export function CreateMcpProviderModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated?: (created: McpProviderCreatedDto) => void
}) {
  const { createMcpProvider } = useConsoleData()
  const { me } = useProfile()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<HeaderRow[]>([{ name: '', value: '' }])
  const [sharing, setSharing] = useState<SharingValue>({ visibility: 'org', sharedWith: [] })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const valid = !!(name.trim() && url.trim())

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setErr(null)
    try {
      const created = await createMcpProvider({
        name: name.trim(),
        url: url.trim(),
        headers: cleanHeaders(headers),
        // Atomic restricted-create: the CP intersects sharedWith with org members.
        ...(sharing.visibility === 'restricted'
          ? { visibility: 'restricted' as const, sharedWith: sharing.sharedWith }
          : {})
      })
      onCreated?.(created)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="plug" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Add MCP server</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        <div className="flex flex-col gap-[14px]">
          <div className="fld">
            <span className="fldlbl">Name</span>
            <input
              className="inp mn"
              placeholder="linear"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="fld">
            <span className="fldlbl">URL</span>
            <input
              className="inp mn"
              placeholder="https://mcp.example.com/sse"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              The upstream MCP endpoint (http transport). Agents never see this — the relay dials it.
            </span>
          </div>
          <HeadersEditor rows={headers} onChange={setHeaders} />
          <VisibilityField value={sharing} onChange={setSharing} />
        </div>
        {err && <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
      </div>

      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          className={valid && !busy ? undefined : 'pointer-events-none opacity-50'}
        >
          <Icon name="plug" size={14} />
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </>
  )
}

// ── edit dialog (url + headers; headers are write-only — blank keeps them) ─────
function EditMcpProviderModal({ provider, onClose }: { provider: McpProviderDto; onClose: () => void }) {
  const { updateMcpProvider, saveSharing } = useConsoleData()
  const [url, setUrl] = useState(provider.url)
  // Start empty: the stored values are never returned, so a blank editor means
  // "keep the current headers". Adding rows REPLACES the whole set on save.
  const [headers, setHeaders] = useState<HeaderRow[]>([])
  const [replaceHeaders, setReplaceHeaders] = useState(false)
  const [sharing, setSharing] = useState<SharingValue>({
    visibility: provider.visibility,
    sharedWith: provider.sharedWith
  })
  const initialSharing = useRef<SharingValue>({ visibility: provider.visibility, sharedWith: provider.sharedWith })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const valid = !!url.trim()

  const startEditingHeaders = () => {
    setReplaceHeaders(true)
    setHeaders([{ name: '', value: '' }])
  }

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setErr(null)
    try {
      const contentChanged = url.trim() !== provider.url || replaceHeaders
      if (contentChanged) {
        await updateMcpProvider(provider.id, {
          // Name is the agent-binding key and there's no atomic rename yet
          // (renaming would orphan every agent's stored selection), so it's fixed
          // here — recreate under a new name to change it. (centralized-tool-management v1)
          ...(url.trim() !== provider.url ? { url: url.trim() } : {}),
          // Only touch headers when the user opted to replace them.
          ...(replaceHeaders ? { headers: cleanHeaders(headers) } : {})
        })
      }
      // Sharing rides its own gated endpoint (canManageSharing).
      if (provider.canManageSharing && !sameSharing(sharing, initialSharing.current)) {
        await saveSharing('mcp', provider.id, sharing)
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="plug" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Edit MCP server</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        <div className="flex flex-col gap-[14px]">
          <div className="fld">
            <span className="fldlbl">Name</span>
            <input className="inp mn opacity-60" value={provider.name} readOnly disabled />
            <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              The name is fixed once created — agents bind to it. Recreate under a new name to change it.
            </span>
          </div>
          <div className="fld">
            <span className="fldlbl">URL</span>
            <input className="inp mn" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          {replaceHeaders ? (
            <HeadersEditor rows={headers} onChange={setHeaders} valuePlaceholder="new value" />
          ) : (
            <div className="fld">
              <span className="fldlbl">Headers</span>
              <div className="flex items-center justify-between gap-3 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px]">
                <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                  {provider.headerNames.length > 0
                    ? `${provider.headerNames.length} header${provider.headerNames.length === 1 ? '' : 's'} configured (${provider.headerNames.join(', ')}). Values are hidden.`
                    : 'No headers configured.'}
                </span>
                <button
                  type="button"
                  onClick={startEditingHeaders}
                  className="inline-flex w-fit flex-none cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[12.5px] font-medium leading-normal text-(--brand)"
                >
                  <Icon name="pencil" size={14} />
                  Replace
                </button>
              </div>
              <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                Editing headers replaces the whole set — re-enter every header you want to keep.
              </span>
            </div>
          )}
          <VisibilityField value={sharing} onChange={setSharing} disabled={!provider.canManageSharing} />
        </div>
        {err && <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
      </div>

      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          className={valid && !busy ? undefined : 'pointer-events-none opacity-50'}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  )
}

// ── edit connector dialog (open_connector only) ───────────────────────────────
// An open_connector row's url (the shared open-connector /mcp endpoint) and headers
// (the x-oomol-connector-* binding markers) are CP-managed — editing them would sever
// the connection. So instead of the url/headers editor, a connector connection edits
// its AUTH material, and the surface adapts to the connection's auth type:
//   • oauth2 → RECONNECT: re-run the sign-in popup to refresh the token.
//   • api_key / custom_credential → EDIT the stored credential and re-save it.
//   • no_auth → nothing to edit.
// Either way only the upstream auth material changes; the row/grant/binding stay put.
// The auth type comes from the catalog: a single-method service is definitive; a rare
// multi-method one is ambiguous (the row doesn't record which was used), so we let the
// user pick. Visibility stays editable regardless.
function EditConnectorModal({ provider, onClose }: { provider: McpProviderDto; onClose: () => void }) {
  const { reconnectConnectorConnection, saveSharing } = useConsoleData()
  const { data: catalog, error: catalogErr } = useSWR('connector-catalog', () => fetchConnectorCatalog(), {
    revalidateOnFocus: false
  })
  const cp = catalog?.providers.find((p) => p.service === provider.service)

  // Resolve the connection's auth method. One method ⇒ definitive; multiple ⇒ ambiguous,
  // so let the user pick (defaulting to the service's preferred method).
  const ambiguous = !!cp && cp.auth.length > 1
  const [picked, setPicked] = useState<ConnectorAuthDefinition['type'] | undefined>(undefined)
  const effectiveType = picked ?? (cp ? initialAuthType(cp) : undefined)
  const auth = cp?.auth.find((a) => a.type === effectiveType) ?? cp?.auth[0]
  const isOauth = auth?.type === 'oauth2'
  const isCredential = auth?.type === 'api_key' || auth?.type === 'custom_credential'
  const isNoAuth = auth?.type === 'no_auth'
  const fields = auth ? credentialFieldsFor(auth) : []
  const [values, setValues] = useState<Record<string, string>>({})

  const [sharing, setSharing] = useState<SharingValue>({
    visibility: provider.visibility,
    sharedWith: provider.sharedWith
  })
  const initialSharing = useRef<SharingValue>({ visibility: provider.visibility, sharedWith: provider.sharedWith })

  const [reconnecting, setReconnecting] = useState(false) // the oauth popup action
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false) // the footer save (credential + sharing)
  const [err, setErr] = useState<string | null>(null)

  const credsEntered = fields.some((f) => (values[f.key] ?? '').trim().length > 0)
  const requiredFilled = fields.filter((f) => f.required).every((f) => (values[f.key] ?? '').trim().length > 0)
  const sharingChanged = provider.canManageSharing && !sameSharing(sharing, initialSharing.current)

  const title = isOauth ? 'Reconnect connector' : auth?.type === 'api_key' ? 'Edit API key' : 'Edit connector'

  // OAuth: re-run the authorization popup (its own action, independent of the footer).
  const reconnectOauth = async () => {
    if (!auth || reconnecting) return
    setReconnecting(true)
    setStatus('Opening authorization…')
    try {
      const res = await reconnectConnectorConnection(provider.id, { authType: auth.type })
      if (res.authorizationUrl) {
        window.open(res.authorizationUrl, 'connectors_oauth', oauthPopupFeatures())
        setStatus('Complete the sign-in in the popup window…')
      } else {
        setStatus('Reconnect started, but authorization did not begin.')
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Reconnect failed.')
    } finally {
      setReconnecting(false)
    }
  }

  // Footer: re-save the credential (when new values were entered) then persist any
  // visibility change. A blank credential form with only a sharing change is allowed.
  const save = async () => {
    if (saving) return
    if (isCredential && credsEntered && !requiredFilled) {
      setErr('Enter every required field to update the credential.')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      if (auth && isCredential && credsEntered) {
        await reconnectConnectorConnection(provider.id, { authType: auth.type, values })
      }
      if (sharingChanged) await saveSharing('mcp', provider.id, sharing)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  const hint = isOauth
    ? 'the URL and headers are managed for you. Re-run authorization if the connection stopped working.'
    : isCredential
      ? 'the URL and headers are managed for you. Enter a new credential to replace the stored one.'
      : 'the URL and headers are managed for you.'

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="plug" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{title}</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        <div className="flex flex-col gap-[14px]">
          <div className="fld">
            <span className="fldlbl">Connection</span>
            <input className="inp mn opacity-60" value={provider.name} readOnly disabled />
            <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {provider.service ? `Open-connector · ${provider.service}` : 'Open-connector connection'} — {hint}
            </span>
          </div>

          {catalogErr ? (
            <div className="flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px]">
              <Icon name="triangle-alert" size={15} color="var(--status-error)" className="mt-[1px] flex-none" />
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                Couldn’t load the connector catalog — editing the connection is unavailable right now.
              </span>
            </div>
          ) : !catalog ? (
            <LoadingState size={20} padding={16} />
          ) : !cp || !auth ? (
            <div className="flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px]">
              <Icon name="triangle-alert" size={15} color="var(--text-tertiary)" className="mt-[1px] flex-none" />
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                This connector is no longer available in the catalog, so its credential can’t be edited. Delete and
                re-add it if you still need it.
              </span>
            </div>
          ) : (
            <div className="fld">
              <span className="fldlbl">{isOauth ? 'Authorization' : 'Credential'}</span>
              {ambiguous && (
                <div className="mb-1 flex gap-1 rounded-[8px] bg-(--surface-sunken) p-[3px]">
                  {cp.auth.map((a) => (
                    <button
                      key={a.type}
                      type="button"
                      onClick={() => setPicked(a.type)}
                      className={`flex-1 cursor-pointer rounded-[6px] border-0 px-3 py-[6px] font-sans text-[12.5px] font-medium leading-normal ${
                        a.type === auth.type
                          ? 'bg-(--surface-card) text-(--text-primary) shadow-(--shadow-sm)'
                          : 'bg-transparent text-(--text-secondary)'
                      }`}
                    >
                      {authLabel(a.type)}
                    </button>
                  ))}
                </div>
              )}

              {isNoAuth ? (
                <div className="flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px]">
                  <Icon
                    name="check-circle-2"
                    size={15}
                    color="var(--status-online-text)"
                    className="mt-[1px] flex-none"
                  />
                  <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    This connector needs no credentials — there’s nothing to edit.
                  </span>
                </div>
              ) : isOauth ? (
                <div className="flex flex-col gap-[12px]">
                  <div className="flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px]">
                    <Icon name="shield-check" size={15} color="var(--brand)" className="mt-[1px] flex-none" />
                    <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                      Sign in with {cp.displayName} again in a popup to refresh this connection’s authorization.
                    </span>
                  </div>
                  <div>
                    <Button
                      variant="secondary"
                      onClick={() => void reconnectOauth()}
                      className={reconnecting ? 'pointer-events-none opacity-50' : undefined}
                    >
                      <Icon name="external-link" size={14} />
                      {reconnecting ? 'Reconnecting…' : `Reconnect ${cp.displayName}`}
                    </Button>
                  </div>
                  {status && (
                    <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                      {status}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-[12px]">
                  {fields.map((f) => (
                    <ConnectorCredentialInput
                      key={f.key}
                      field={f}
                      value={values[f.key] ?? ''}
                      onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))}
                    />
                  ))}
                  <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    The current value is hidden. Enter a new one to replace it, or leave blank to keep it.
                  </span>
                </div>
              )}
            </div>
          )}

          <VisibilityField value={sharing} onChange={setSharing} disabled={!provider.canManageSharing} />
        </div>
        {err && <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
      </div>

      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          className={saving ? 'pointer-events-none opacity-50' : undefined}
        >
          {saving ? 'Saving…' : isCredential && credsEntered ? 'Save' : 'Done'}
        </Button>
      </div>
    </>
  )
}

// One credential field for the connector credential form (mirrors ConnectorsModal's CredentialInput).
function ConnectorCredentialInput({
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

// The auth-method label for the ambiguous-connector picker (mirrors ConnectorsModal.authLabel).
function authLabel(type: ConnectorAuthDefinition['type']): string {
  if (type === 'api_key') return 'API key'
  if (type === 'oauth2') return 'OAuth'
  if (type === 'custom_credential') return 'Custom'
  return 'No auth'
}

// Centered OAuth popup window features (mirrors ConnectorsModal.oauthPopupFeatures).
function oauthPopupFeatures(): string {
  const width = 520
  const height = 720
  const left = Math.round(window.screenX + (window.outerWidth - width) / 2)
  const top = Math.round(window.screenY + (window.outerHeight - height) / 2)
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
}

// ── delete confirm ─────────────────────────────────────────────────────────────
function DeleteMcpProviderModal({ provider, onClose }: { provider: McpProviderDto; onClose: () => void }) {
  const { deleteMcpProvider } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onDelete = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await deleteMcpProvider(provider.id)
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
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Delete MCP server</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          <span className="mono text-(--text-primary)">{provider.name}</span>&#32;will be removed and its grant key
          revoked — agents that enabled it will stop being able to reach it. This can&apos;t be undone.
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
          onClick={() => void onDelete()}
          className={busy ? 'pointer-events-none opacity-50' : undefined}
        >
          <Icon name="trash-2" size={15} />
          {busy ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </>
  )
}
