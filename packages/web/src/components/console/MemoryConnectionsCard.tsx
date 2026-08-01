'use client'

// Org external-memory administration (memory-evolution M-5A). Installation is
// the owner-reviewed remote endpoint or local operator-reference trust decision;
// connection is one account/config. Secret values remain write-only.

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import {
  createExternalMemoryConnection,
  createMemoryPluginInstallation,
  deleteExternalMemoryConnection,
  deleteMemoryPluginInstallation,
  fetchExternalMemoryConnections,
  fetchMemoryPluginInstallations,
  rotateExternalMemoryConnectionGrant,
  updateExternalMemoryConnection,
  type ExternalMemoryConnectionDto,
  type MemoryPluginInstallationDto,
  type MemoryPluginSecretHeaderDto
} from '@/lib/api'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

type SecretRow = MemoryPluginSecretHeaderDto & { value: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseObjectJson(text: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${label} must be valid JSON.`)
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

function statusClasses(status: ExternalMemoryConnectionDto['status']): string {
  if (status === 'ready') return 'bg-(--status-online-soft) text-(--status-online)'
  if (status === 'invalid') return 'bg-(--status-error-soft) text-(--status-error)'
  if (status === 'degraded') return 'bg-(--status-paused-soft) text-(--status-paused)'
  return 'bg-(--status-info-soft) text-(--status-info)'
}

function statusLabel(status: ExternalMemoryConnectionDto['status']): string {
  if (status === 'ready') return 'Ready'
  if (status === 'probing') return 'Connecting'
  if (status === 'degraded') return 'Degraded'
  return 'Invalid'
}

export function MemoryConnectionsCard({ canManage }: { canManage: boolean }) {
  const { activeOrg } = useOrgs()
  const installationKey = consoleKeys.memoryPluginInstallations(activeOrg?.id)
  const connectionKey = consoleKeys.externalMemoryConnections(activeOrg?.id)
  const {
    data: installations = [],
    isLoading: installationsLoading,
    mutate: mutateInstallations
  } = useSWR(installationKey, ([, orgId]) => fetchMemoryPluginInstallations(orgId))
  const {
    data: connections = [],
    isLoading: connectionsLoading,
    mutate: mutateConnections
  } = useSWR(connectionKey, ([, orgId]) => fetchExternalMemoryConnections(orgId))
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ExternalMemoryConnectionDto | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const installationById = useMemo(
    () => new Map(installations.map((installation) => [installation.id, installation])),
    [installations]
  )
  const refresh = async () => {
    await Promise.all([mutateInstallations(), mutateConnections()])
  }

  const rotate = async (connection: ExternalMemoryConnectionDto) => {
    if (
      !window.confirm(
        "Rotate this connection's access key? Active agents will receive the replacement before the old key is retired."
      )
    )
      return
    setActionId(connection.id)
    setError(null)
    try {
      await rotateExternalMemoryConnectionGrant(connection.id)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setActionId(null)
    }
  }

  const removeConnection = async (connection: ExternalMemoryConnectionDto) => {
    if (
      !window.confirm('Delete this external-memory connection? Unbind every agent first. Backend data is not deleted.')
    )
      return
    setActionId(connection.id)
    setError(null)
    try {
      await deleteExternalMemoryConnection(connection.id)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setActionId(null)
    }
  }

  const removeInstallation = async (installation: MemoryPluginInstallationDto) => {
    if (!window.confirm(`Remove the reviewed installation “${installation.pluginId}”?`)) return
    setActionId(installation.id)
    setError(null)
    try {
      await deleteMemoryPluginInstallation(installation.id)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setActionId(null)
    }
  }

  const loading = installationsLoading || connectionsLoading
  return (
    <div className="card">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-(--border-subtle) px-4 py-[14px] desktop:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="cardtitle">External memory</span>
          {!loading && connections.length > 0 && (
            <span className="rounded-full bg-(--surface-active) px-2 py-[2px] font-sans text-[10.5px] font-semibold leading-normal text-(--text-secondary)">
              {connections.length} {connections.length === 1 ? 'connection' : 'connections'}
            </span>
          )}
        </div>
        {canManage && (
          <Button variant="secondary" size="xs" className="flex-none" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            Add connection
          </Button>
        )}
        <p className="col-span-2 mt-0 max-w-[560px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-1 desktop:col-start-1">
          Connect approved memory services that agents can use for recall and capture.
        </p>
      </div>

      {loading && connections.length === 0 && installations.length === 0 ? (
        <LoadingState size={22} padding={20} />
      ) : connections.length === 0 ? (
        <div className="flex flex-col items-center gap-[6px] px-4 py-9">
          <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] bg-(--surface-sunken)">
            <Icon name="database" size={18} color="var(--text-tertiary)" />
          </span>
          <div className="mt-1 font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
            No external-memory connections yet
          </div>
          <div className="max-w-[420px] text-center font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            Register a plugin and create an account connection. Secret values are never shown again.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          {connections.map((connection) => {
            const installation = installationById.get(connection.installationId)
            return (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                installation={installation}
                canManage={canManage}
                busy={actionId === connection.id}
                onEdit={() => setEditing(connection)}
                onRotate={() => void rotate(connection)}
                onDelete={() => void removeConnection(connection)}
              />
            )
          })}
        </div>
      )}

      {canManage &&
        installations.some((installation) => !connections.some((c) => c.installationId === installation.id)) && (
          <div className="border-t border-(--border-subtle) bg-(--surface-sunken) px-4 py-[14px]">
            <div className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">
              Ready to connect
            </div>
            <div className="mt-1 font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
              These approved plugins do not have an account connection yet.
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {installations
                .filter((installation) => !connections.some((c) => c.installationId === installation.id))
                .map((installation) => (
                  <div
                    key={installation.id}
                    className="flex min-w-0 items-center gap-3 rounded-md border border-(--border-subtle) bg-(--surface-card) px-3 py-[10px]"
                  >
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--surface-sunken) text-(--text-tertiary)">
                      <Icon name="database" size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11.5px] font-semibold leading-normal text-(--text-primary)">
                        {installation.pluginId}
                      </span>
                      <span className="mt-[3px] block truncate font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
                        {installation.transport === 'stdio'
                          ? `Local · ${installation.commandRef ?? 'Command unavailable'}`
                          : `Remote · ${installation.endpoint ?? 'Endpoint unavailable'}`}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="lnk flex-none text-[11px] text-(--red-600)"
                      disabled={actionId === installation.id}
                      onClick={() => void removeInstallation(installation)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}
      {error && <div className="border-t border-(--border-subtle) px-4 py-3 text-[12px] text-(--red-600)">{error}</div>}

      {creating && (
        <div className="scrim">
          <div className="modal max-w-[640px]">
            <CreateMemoryConnectionModal
              installations={installations}
              onClose={() => setCreating(false)}
              onSaved={async () => {
                await refresh()
                setCreating(false)
              }}
            />
          </div>
        </div>
      )}
      {editing && (
        <div className="scrim">
          <div className="modal max-w-[600px]">
            <EditMemoryConnectionModal
              connection={editing}
              installation={installationById.get(editing.installationId)}
              onClose={() => setEditing(null)}
              onSaved={async () => {
                await refresh()
                setEditing(null)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function ConnectionCard({
  connection,
  installation,
  canManage,
  busy,
  onEdit,
  onRotate,
  onDelete
}: {
  connection: ExternalMemoryConnectionDto
  installation?: MemoryPluginInstallationDto
  canManage: boolean
  busy: boolean
  onEdit: () => void
  onRotate: () => void
  onDelete: () => void
}) {
  const [actionsOpen, setActionsOpen] = useState(false)
  const downstream = connection.declaredEgressHosts
  const operations = Array.isArray(connection.capabilities?.operations)
    ? connection.capabilities.operations.filter((value): value is string => typeof value === 'string')
    : []
  const isRemote = installation?.transport === 'streamable-http'
  const connectionLocation = isRemote
    ? (installation?.endpoint ?? 'Endpoint unavailable')
    : (installation?.commandRef ?? 'Command unavailable')
  const credentialsLabel = connection.secretKeys.length
    ? `${connection.secretKeys.length} ${connection.secretKeys.length === 1 ? 'credential' : 'credentials'} configured`
    : 'No credentials required'
  const egressLabel = downstream.length
    ? downstream.join(', ')
    : connection.status === 'ready'
      ? 'No downstream hosts declared'
      : 'Waiting for plugin report'

  return (
    <div className="overflow-hidden rounded-lg border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xs)">
      <div className="flex items-start gap-3 px-[14px] py-[13px] desktop:items-center">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-(--brand-soft) text-(--brand)">
          <Icon name="database" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)">
              {installation?.pluginId ?? 'Unknown plugin'}
            </span>
            {connection.pluginVersion && (
              <span className="font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
                v{connection.pluginVersion}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className={`badge ${statusClasses(connection.status)}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {statusLabel(connection.status)}
            </span>
            <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
              {isRemote ? 'Remote plugin' : 'Local plugin'}
            </span>
          </div>
        </div>
        {canManage && (
          <div className="flex flex-none items-center gap-[6px]">
            <button className="iconbtn" disabled={busy} onClick={onEdit} title="Edit connection">
              <Icon name="pencil" size={15} />
            </button>
            <div className="relative">
              <button
                className="iconbtn"
                disabled={busy}
                onClick={() => setActionsOpen((open) => !open)}
                title="Connection actions"
              >
                <Icon name="ellipsis" size={16} />
              </button>
              {actionsOpen && (
                <>
                  <div onClick={() => setActionsOpen(false)} className="fixed inset-0 z-[45]" />
                  <div className="dmenu" onClick={(event) => event.stopPropagation()}>
                    {isRemote && (
                      <button
                        className="dmi"
                        onClick={() => {
                          setActionsOpen(false)
                          onRotate()
                        }}
                      >
                        <Icon name="key-round" size={15} />
                        Rotate access key
                      </button>
                    )}
                    {isRemote && <div className="dmsep" />}
                    <button
                      className="dmi danger"
                      onClick={() => {
                        setActionsOpen(false)
                        onDelete()
                      }}
                    >
                      <Icon name="trash-2" size={15} />
                      Delete connection
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {connection.reasonCode && (
        <div className="mx-[14px] mb-3 flex items-start gap-2 rounded-md bg-(--status-error-soft) px-3 py-[9px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--status-error)">
          <Icon name="triangle-alert" size={15} className="mt-[1px] flex-none" />
          <span>
            This connection needs attention. <span className="font-mono">{connection.reasonCode}</span>
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 border-t border-(--border-subtle) bg-(--surface-sunken) p-[14px] desktop:grid-cols-[minmax(0,1.2fr)_minmax(210px,.8fr)]">
        <div className="min-w-0 rounded-md border border-(--border-subtle) bg-(--surface-card) p-3">
          <div className="flex items-center gap-[6px] font-sans text-[10.5px] font-semibold leading-normal tracking-[.04em] text-(--text-tertiary) uppercase">
            <Icon name={isRemote ? 'globe-2' : 'terminal-square'} size={13} />
            Connection
          </div>
          <div className="mt-2 font-sans text-[12px] font-medium leading-normal text-(--text-primary)">
            {isRemote ? 'Reviewed remote endpoint' : 'Operator-installed command'}
          </div>
          <div
            className="mt-1 break-all font-mono text-[10.5px] font-normal leading-[1.5] text-(--text-tertiary) desktop:truncate"
            title={connectionLocation}
          >
            {connectionLocation}
          </div>
        </div>

        <div className="rounded-md border border-(--border-subtle) bg-(--surface-card) p-3">
          <div className="flex items-center gap-[6px] font-sans text-[10.5px] font-semibold leading-normal tracking-[.04em] text-(--text-tertiary) uppercase">
            <Icon name="shield-check" size={13} />
            Access
          </div>
          <div className="mt-2 flex items-start gap-2">
            <Icon name="key-round" size={13} color="var(--text-tertiary)" className="mt-[1px] flex-none" />
            <div className="min-w-0">
              <div className="font-sans text-[11.5px] font-medium leading-normal text-(--text-primary)">
                {credentialsLabel}
              </div>
              {connection.secretKeys.length > 0 && (
                <div className="mt-1 break-all font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
                  {connection.secretKeys.join(', ')}
                </div>
              )}
            </div>
          </div>
          <div className="mt-[10px] flex items-start gap-2">
            <Icon name="network" size={13} color="var(--text-tertiary)" className="mt-[1px] flex-none" />
            <div className="min-w-0">
              <div className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                Network access
              </div>
              <div className="mt-[2px] break-words font-sans text-[11.5px] font-medium leading-[1.4] text-(--text-primary)">
                {egressLabel}
              </div>
            </div>
          </div>
        </div>

        {operations.length > 0 && (
          <div className="desktop:col-span-2">
            <div className="font-sans text-[10.5px] font-semibold leading-normal tracking-[.04em] text-(--text-tertiary) uppercase">
              Capabilities
            </div>
            <div className="mt-2 flex flex-wrap gap-[6px]">
              {operations.map((operation) => (
                <span
                  key={operation}
                  className="rounded-full border border-(--border-default) bg-(--surface-card) px-[9px] py-1 font-sans text-[10.5px] font-medium leading-normal text-(--text-secondary)"
                >
                  {operation}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-(--border-subtle) px-[14px] py-[9px] font-mono text-[10px] font-normal leading-normal text-(--text-disabled)">
        <span className="min-w-0 truncate" title={connection.id}>
          Connection {connection.id}
        </span>
        <span className="flex-none">Revision {connection.revision}</span>
        {connection.probedRevision !== null && (
          <span className="flex-none">Checked revision {connection.probedRevision}</span>
        )}
      </div>
    </div>
  )
}

function SecretRowsEditor({
  rows,
  onChange,
  collectValues,
  transport
}: {
  rows: SecretRow[]
  onChange: (rows: SecretRow[]) => void
  collectValues: boolean
  transport: MemoryPluginInstallationDto['transport']
}) {
  const set = (index: number, patch: Partial<SecretRow>) =>
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
  return (
    <div className="fld desktop:col-span-2">
      <span className="fldlbl">Credential fields</span>
      <span className="mb-2 text-[11px] text-(--text-tertiary)">
        Logical names and transport headers are matched against the plugin profile. Values are write-only.
        {transport === 'stdio'
          ? ' For local plugins, the daemon injects each value only through the operator allowlist mapping.'
          : ' For remote plugins, the relay injects each value into its reviewed header.'}
      </span>
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-1 gap-2 desktop:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              className="dsinput-field mono"
              placeholder="apiKey"
              value={row.name}
              onChange={(event) => set(index, { name: event.target.value })}
            />
            <input
              className="dsinput-field mono"
              placeholder="Authorization"
              value={row.header}
              onChange={(event) => set(index, { header: event.target.value })}
            />
            {collectValues ? (
              <input
                className="dsinput-field mono"
                type="password"
                autoComplete="new-password"
                placeholder="secret value"
                value={row.value}
                onChange={(event) => set(index, { value: event.target.value })}
              />
            ) : (
              <span />
            )}
            <span className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] text-(--text-secondary)">
                <input
                  type="checkbox"
                  checked={row.required}
                  onChange={(event) => set(index, { required: event.target.checked })}
                />
                required
              </label>
              <button
                type="button"
                className="iconbtn"
                aria-label="Remove credential field"
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                <Icon name="x" size={14} />
              </button>
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="lnk mt-2 text-[12px]"
        onClick={() => onChange([...rows, { name: '', header: '', required: true, value: '' }])}
      >
        + Add credential field
      </button>
    </div>
  )
}

function CreateMemoryConnectionModal({
  installations,
  onClose,
  onSaved
}: {
  installations: MemoryPluginInstallationDto[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? 'new')
  const [pluginId, setPluginId] = useState('')
  const [transport, setTransport] = useState<MemoryPluginInstallationDto['transport']>('streamable-http')
  const [endpoint, setEndpoint] = useState('')
  const [commandRef, setCommandRef] = useState('')
  const [manifestDigest, setManifestDigest] = useState('')
  const [newSecretRows, setNewSecretRows] = useState<SecretRow[]>([])
  const [existingSecretValues, setExistingSecretValues] = useState<Record<string, string>>({})
  const [configText, setConfigText] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = installations.find((installation) => installation.id === installationId)

  const submit = async () => {
    setBusy(true)
    setError(null)
    let createdInstallation: MemoryPluginInstallationDto | undefined
    try {
      const config = parseObjectJson(configText, 'Configuration')
      let target = selected
      let secrets: Record<string, string>
      if (!target) {
        const rows = newSecretRows.filter((row) => row.name.trim() || row.header.trim() || row.value)
        if (!pluginId.trim()) throw new Error('Plugin id is required.')
        if (transport === 'streamable-http' && !endpoint.trim()) throw new Error('Plugin endpoint is required.')
        if (transport === 'stdio' && !commandRef.trim()) throw new Error('Operator command reference is required.')
        if (rows.some((row) => !row.name.trim() || !row.header.trim() || (row.required && !row.value))) {
          throw new Error('Every credential field needs a logical name and header; required fields also need a value.')
        }
        const common = {
          pluginId: pluginId.trim(),
          ...(manifestDigest.trim() ? { expectedManifestDigest: manifestDigest.trim() } : {}),
          secretHeaders: rows.map(({ name, header, required }) => ({
            name: name.trim(),
            header: header.trim(),
            required
          }))
        }
        createdInstallation = await createMemoryPluginInstallation(
          transport === 'stdio'
            ? { ...common, transport: 'stdio', commandRef: commandRef.trim() }
            : { ...common, transport: 'streamable-http', endpoint: endpoint.trim() }
        )
        target = createdInstallation
        secrets = Object.fromEntries(rows.filter((row) => row.value).map((row) => [row.name.trim(), row.value]))
      } else {
        const missing = target.secretHeaders.filter((field) => field.required && !existingSecretValues[field.name])
        if (missing.length)
          throw new Error(`Enter required secret value(s): ${missing.map((field) => field.name).join(', ')}.`)
        secrets = Object.fromEntries(Object.entries(existingSecretValues).filter(([, value]) => value))
      }
      await createExternalMemoryConnection({ installationId: target.id, config, secrets })
      await onSaved()
    } catch (cause) {
      if (createdInstallation) await deleteMemoryPluginInstallation(createdInstallation.id).catch(() => undefined)
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="database" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Add memory connection</span>
        <button className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody grid grid-cols-1 gap-4 desktop:grid-cols-2">
        <div className="fld desktop:col-span-2">
          <span className="fldlbl">Reviewed plugin installation</span>
          <select
            className="dsinput-field"
            value={installationId}
            onChange={(event) => {
              setInstallationId(event.target.value)
              setExistingSecretValues({})
            }}
          >
            {installations.map((installation) => (
              <option key={installation.id} value={installation.id}>
                {installation.pluginId} —{' '}
                {installation.transport === 'stdio'
                  ? `local:${installation.commandRef ?? 'unavailable'}`
                  : installation.endpoint}
              </option>
            ))}
            <option value="new">Register a new plugin…</option>
          </select>
        </div>
        {selected ? (
          <>
            <div className="desktop:col-span-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) p-3 text-[12px] text-(--text-secondary)">
              {selected.transport === 'stdio' ? (
                <>
                  The daemon will resolve <span className="mono">{selected.commandRef}</span> only from its local
                  operator allowlist. No command, path, or arguments are stored in this installation. Downstream network
                  access is controlled by that operator deployment, not AgentConnect.
                </>
              ) : (
                <>
                  Recall and capture traffic will be sent to <span className="mono">{selected.endpoint}</span>. The
                  plugin may make further requests that AgentConnect cannot enforce.
                </>
              )}
            </div>
            {selected.secretHeaders.map((field) => (
              <label key={field.name} className="fld">
                <span className="fldlbl">
                  {field.name}
                  {field.required ? ' *' : ''}
                </span>
                <input
                  className="dsinput-field mono"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    selected.transport === 'stdio' ? 'injected by operator mapping' : `sent as ${field.header}`
                  }
                  value={existingSecretValues[field.name] ?? ''}
                  onChange={(event) =>
                    setExistingSecretValues((values) => ({ ...values, [field.name]: event.target.value }))
                  }
                />
              </label>
            ))}
          </>
        ) : (
          <>
            <label className="fld desktop:col-span-2">
              <span className="fldlbl">Plugin transport</span>
              <select
                className="dsinput-field"
                value={transport}
                onChange={(event) => setTransport(event.target.value as MemoryPluginInstallationDto['transport'])}
              >
                <option value="streamable-http">Remote · Streamable HTTP</option>
                <option value="stdio">Local · operator-installed stdio</option>
              </select>
            </label>
            <label className="fld">
              <span className="fldlbl">Plugin id</span>
              <input
                className="dsinput-field mono"
                placeholder="ai.mem0.memory"
                value={pluginId}
                onChange={(event) => setPluginId(event.target.value)}
              />
            </label>
            {transport === 'stdio' ? (
              <label className="fld">
                <span className="fldlbl">Operator command reference</span>
                <input
                  className="dsinput-field mono"
                  placeholder="mem0-oss"
                  value={commandRef}
                  onChange={(event) => setCommandRef(event.target.value)}
                />
                <span className="mt-1 text-[11px] text-(--text-tertiary)">
                  Allowlist key only — never enter a path, executable, or arguments. The operator-installed child may
                  make deployment-configured network requests.
                </span>
              </label>
            ) : (
              <label className="fld">
                <span className="fldlbl">Streamable HTTP endpoint</span>
                <input
                  className="dsinput-field mono"
                  type="url"
                  placeholder="https://memory-plugin.example/mcp"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                />
              </label>
            )}
            <label className="fld desktop:col-span-2">
              <span className="fldlbl">
                Expected manifest digest <span className="font-normal text-(--text-tertiary)">(optional pin)</span>
              </span>
              <input
                className="dsinput-field mono"
                placeholder="sha256:…"
                value={manifestDigest}
                onChange={(event) => setManifestDigest(event.target.value)}
              />
            </label>
            <SecretRowsEditor rows={newSecretRows} onChange={setNewSecretRows} collectValues transport={transport} />
          </>
        )}
        <label className="fld desktop:col-span-2">
          <span className="fldlbl">Non-secret connection config (JSON)</span>
          <textarea
            className="dsinput-field mono min-h-[120px] resize-y"
            spellCheck={false}
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
          />
        </label>
        <div className="desktop:col-span-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) p-3 text-[11.5px] leading-[1.5] text-(--text-secondary)">
          A compatibility check starts after an agent selects this connection. The agent will not start with external
          memory until this exact revision verifies successfully.
        </div>
        {error && <div className="desktop:col-span-2 text-[12px] text-(--red-600)">{error}</div>}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => void submit()}>
          <Icon name="database" size={14} />
          {busy ? 'Creating…' : 'Create connection'}
        </Button>
      </div>
    </>
  )
}

function EditMemoryConnectionModal({
  connection,
  installation,
  onClose,
  onSaved
}: {
  connection: ExternalMemoryConnectionDto
  installation?: MemoryPluginInstallationDto
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [configText, setConfigText] = useState(JSON.stringify(connection.config, null, 2))
  const [replaceSecrets, setReplaceSecrets] = useState(false)
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const config = parseObjectJson(configText, 'Configuration')
      let secrets: Record<string, string> | undefined
      if (replaceSecrets) {
        const fields = installation?.secretHeaders ?? []
        const missing = fields.filter((field) => field.required && !secretValues[field.name])
        if (missing.length)
          throw new Error(`Enter required secret value(s): ${missing.map((field) => field.name).join(', ')}.`)
        secrets = Object.fromEntries(Object.entries(secretValues).filter(([, value]) => value))
      }
      await updateExternalMemoryConnection(connection.id, { config, ...(secrets ? { secrets } : {}) })
      await onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }
  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="database" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Edit memory connection</span>
        <button className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody flex flex-col gap-4">
        <div className="rounded-md border border-(--border-subtle) bg-(--surface-sunken) p-3 text-[12px] text-(--text-secondary)">
          {installation?.transport === 'stdio' ? 'Operator command ref' : 'Plugin endpoint'}:{' '}
          <span className="mono">
            {installation?.transport === 'stdio'
              ? (installation.commandRef ?? 'unavailable')
              : (installation?.endpoint ?? 'unavailable')}
          </span>
          . Saving increments the definition revision and requires a fresh compatibility check.
        </div>
        <label className="fld">
          <span className="fldlbl">Non-secret connection config (JSON)</span>
          <textarea
            className="dsinput-field mono min-h-[140px] resize-y"
            spellCheck={false}
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-(--text-secondary)">
          <input
            type="checkbox"
            checked={replaceSecrets}
            onChange={(event) => setReplaceSecrets(event.target.checked)}
          />
          Replace the complete write-only secret set
        </label>
        {replaceSecrets &&
          (installation?.secretHeaders ?? []).map((field) => (
            <label key={field.name} className="fld">
              <span className="fldlbl">
                {field.name}
                {field.required ? ' *' : ''}
              </span>
              <input
                className="dsinput-field mono"
                type="password"
                autoComplete="new-password"
                placeholder={
                  installation?.transport === 'stdio' ? 'injected by operator mapping' : `sent as ${field.header}`
                }
                value={secretValues[field.name] ?? ''}
                onChange={(event) => setSecretValues((values) => ({ ...values, [field.name]: event.target.value }))}
              />
            </label>
          ))}
        {error && <div className="text-[12px] text-(--red-600)">{error}</div>}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Save and check compatibility'}
        </Button>
      </div>
    </>
  )
}
