'use client'

// External-memory administration on Knowledge (memory-evolution.md §3.3.1, §6): one row per connection, details on demand.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel, type Agent } from '@/lib/data'
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
import { AgentIconView, LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

type CardTranslator = ReturnType<typeof useTranslations<'Knowledge.memoryConnections'>>
type DialogTranslator = ReturnType<typeof useTranslations<'Knowledge.memoryConnections.dialog'>>
type Transport = MemoryPluginInstallationDto['transport']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseObjectJson(text: string, t: DialogTranslator): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(t('errors.mustBeValidJson'))
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(t('errors.mustBeObject'))
  return value as Record<string, unknown>
}

/** Values for the fields that exist now: a field renamed or removed after Back keeps no hidden key. */
function secretsFor(fields: MemoryPluginSecretHeaderDto[], values: Record<string, string>): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const field of fields) {
    const value = values[field.name]
    if (value) secrets[field.name] = value
  }
  return secrets
}

function statusClasses(status: ExternalMemoryConnectionDto['status']): string {
  if (status === 'ready') return 'bg-(--status-online-soft) text-(--status-online)'
  if (status === 'invalid') return 'bg-(--status-error-soft) text-(--status-error)'
  if (status === 'degraded') return 'bg-(--status-paused-soft) text-(--status-paused)'
  return 'bg-(--status-info-soft) text-(--status-info)'
}

/** The endpoint's host, or the raw value when it is not a URL. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint
  } catch {
    return endpoint
  }
}

/** "Remote · host" or "Local · command": where the plugin runs, in one short line. */
function whereLabel(installation: MemoryPluginInstallationDto | undefined, t: CardTranslator): string {
  if (!installation) return t('unknownPlugin')
  if (installation.transport === 'stdio')
    return t('localTransport', { ref: installation.commandRef ?? t('commandUnavailable') })
  return t('remoteTransport', {
    endpoint: installation.endpoint ? hostOf(installation.endpoint) : t('endpointUnavailable')
  })
}

export function MemoryConnectionsCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('Knowledge.memoryConnections')
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
  const { agents } = useConsoleData()
  const [creating, setCreating] = useState<{ installationId: string | null } | null>(null)
  const [editing, setEditing] = useState<ExternalMemoryConnectionDto | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const installationById = useMemo(
    () => new Map(installations.map((installation) => [installation.id, installation])),
    [installations]
  )
  // Reverse index of the bindings the console already holds (memory-evolution.md §6): no connection-scoped endpoint.
  const agentsByConnection = useMemo(() => {
    const index = new Map<string, Agent[]>()
    for (const agent of agents) {
      if (agent.memoryProvider !== 'external' || !agent.memoryConnectionId) continue
      const bound = index.get(agent.memoryConnectionId) ?? []
      bound.push(agent)
      index.set(agent.memoryConnectionId, bound)
    }
    for (const bound of index.values()) bound.sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)))
    return index
  }, [agents])
  const unconnected = installations.filter(
    (installation) => !connections.some((connection) => connection.installationId === installation.id)
  )
  const refresh = async () => {
    await Promise.all([mutateInstallations(), mutateConnections()])
  }

  const run = async (id: string, confirmText: string, action: () => Promise<unknown>) => {
    if (!window.confirm(confirmText)) return
    setActionId(id)
    setError(null)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setActionId(null)
    }
  }

  const loading = installationsLoading || connectionsLoading
  return (
    <div id="external-memory" className="card mt-[18px]">
      <div className="cardhead justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="cardtitle">{t('title')}</span>
          {!loading && connections.length > 0 && (
            <span className="badge hidden bg-(--surface-active) text-[10.5px] text-(--text-secondary) desktop:inline-flex">
              {t('connectionsCount', { count: connections.length })}
            </span>
          )}
        </span>
        {canManage && (
          <Button
            variant="secondary"
            size="xs"
            className="flex-none"
            onClick={() => setCreating({ installationId: null })}
          >
            <Icon name="plus" size={14} />
            {t('addConnection')}
          </Button>
        )}
      </div>

      {loading && connections.length === 0 && installations.length === 0 ? (
        <LoadingState size={22} padding={20} />
      ) : connections.length === 0 ? (
        <div className="flex flex-col items-center gap-[6px] px-4 py-9">
          <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] bg-(--surface-sunken)">
            <Icon name="database" size={18} color="var(--text-tertiary)" />
          </span>
          <div className="mt-1 font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
            {t('emptyTitle')}
          </div>
          <div className="max-w-[420px] text-center font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            {t('emptyDescription')}
          </div>
        </div>
      ) : (
        connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            installation={installationById.get(connection.installationId)}
            agents={agentsByConnection.get(connection.id) ?? []}
            canManage={canManage}
            busy={actionId === connection.id}
            open={openId === connection.id}
            onToggle={() => setOpenId((current) => (current === connection.id ? null : connection.id))}
            onEdit={() => setEditing(connection)}
            onRotate={() =>
              void run(connection.id, t('rotateConfirm'), () => rotateExternalMemoryConnectionGrant(connection.id))
            }
            onDelete={() =>
              void run(connection.id, t('deleteConnectionConfirm'), () => deleteExternalMemoryConnection(connection.id))
            }
          />
        ))
      )}

      {canManage && unconnected.length > 0 && (
        <div className="border-t border-(--border-subtle) bg-(--surface-sunken) last:rounded-b-[10px]">
          {unconnected.map((installation) => (
            <div
              key={installation.id}
              className="flex items-center gap-3 border-b border-(--border-subtle) px-4 py-[10px] last:border-b-0"
            >
              <Icon name="database" size={15} color="var(--text-tertiary)" className="flex-none" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-normal leading-normal text-(--text-secondary)">
                {installation.pluginId}
                <span className="text-(--text-tertiary)"> · {whereLabel(installation, t)}</span>
              </span>
              <span className="hidden font-sans text-[11px] font-normal leading-normal text-(--text-tertiary) desktop:inline">
                {t('readyToConnect')}
              </span>
              <button
                type="button"
                className="lnk flex-none text-[11.5px]"
                disabled={actionId === installation.id}
                onClick={() => setCreating({ installationId: installation.id })}
              >
                {t('connect')}
              </button>
              <button
                type="button"
                className="lnk flex-none text-[11.5px] text-(--red-600)"
                disabled={actionId === installation.id}
                onClick={() =>
                  void run(installation.id, t('deleteInstallationConfirm', { pluginId: installation.pluginId }), () =>
                    deleteMemoryPluginInstallation(installation.id)
                  )
                }
              >
                {t('remove')}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] text-(--status-error)">
          {error}
        </div>
      )}

      {creating && (
        <div className="scrim">
          <div className="modal max-w-[640px]">
            <CreateMemoryConnectionModal
              installations={installations}
              preselectedId={creating.installationId}
              onClose={() => setCreating(null)}
              onSaved={async () => {
                await refresh()
                setCreating(null)
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

function ConnectionRow({
  connection,
  installation,
  agents,
  canManage,
  busy,
  open,
  onToggle,
  onEdit,
  onRotate,
  onDelete
}: {
  connection: ExternalMemoryConnectionDto
  installation?: MemoryPluginInstallationDto
  /** Agents bound to this connection, in label order; each links to its Memory tab. */
  agents: Agent[]
  canManage: boolean
  busy: boolean
  open: boolean
  onToggle: () => void
  onEdit: () => void
  onRotate: () => void
  onDelete: () => void
}) {
  const t = useTranslations('Knowledge.memoryConnections')
  const { orgPath } = useOrgs()
  const [actionsOpen, setActionsOpen] = useState(false)
  const detailId = `memory-connection-${connection.id}`
  const isRemote = installation?.transport === 'streamable-http'
  const location = isRemote
    ? (installation?.endpoint ?? t('endpointUnavailable'))
    : (installation?.commandRef ?? t('commandUnavailable'))
  const operations = Array.isArray(connection.capabilities?.operations)
    ? connection.capabilities.operations.filter((value): value is string => typeof value === 'string')
    : []
  const egress = connection.declaredEgressHosts.length
    ? connection.declaredEgressHosts.join(', ')
    : connection.status === 'ready'
      ? t('noDownstreamHosts')
      : t('waitingForPluginReport')
  const usage = agents.length ? t('usedByCount', { count: agents.length }) : t('usedByNone')

  return (
    <div data-connection={connection.id} className="group border-b border-(--border-subtle) last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          className="iconbtn h-6 w-6 flex-none"
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={open ? t('hideDetails') : t('showDetails')}
          onClick={onToggle}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        </button>
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--brand-soft) text-(--brand)">
          <Icon name="database" size={15} />
        </span>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onToggle}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)">
              {installation?.pluginId ?? t('unknownPlugin')}
            </span>
            {connection.pluginVersion && (
              <span className="font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
                v{connection.pluginVersion}
              </span>
            )}
            <span className={`badge ${statusClasses(connection.status)}`} title={connection.reasonCode ?? undefined}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {t(`status.${connection.status}`)}
            </span>
          </div>
          <div className="mt-[3px] truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {whereLabel(installation, t)} · {usage}
          </div>
        </div>
        {canManage && (
          <div className="flex flex-none items-center gap-[6px]">
            <button className="iconbtn" disabled={busy} onClick={onEdit} title={t('editConnection')}>
              <Icon name="pencil" size={15} />
            </button>
            <div className="relative">
              <button
                className="iconbtn"
                disabled={busy}
                onClick={() => setActionsOpen((value) => !value)}
                title={t('connectionActions')}
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
                        {t('rotateAccessKey')}
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
                      <Icon name="trash" size={15} />
                      {t('deleteConnection')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {open && (
        <div
          id={detailId}
          className="border-t border-(--border-subtle) bg-(--surface-sunken) px-4 py-3 group-last:rounded-b-[10px]"
        >
          {connection.reasonCode && (
            <div className="mb-3 flex items-center gap-2 rounded-md bg-(--status-error-soft) px-3 py-2 font-sans text-[11.5px] font-normal leading-normal text-(--status-error)">
              <Icon name="triangle-alert" size={14} className="flex-none" />
              <span>
                {t.rich('attentionNeeded', { code: () => <span className="font-mono">{connection.reasonCode}</span> })}
              </span>
            </div>
          )}
          <dl className="grid grid-cols-[minmax(96px,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 font-sans text-[12px] font-normal leading-normal">
            <dt className="text-(--text-tertiary)">{isRemote ? t('endpoint') : t('command')}</dt>
            <dd className="min-w-0 break-all font-mono text-[11.5px] text-(--text-primary)">{location}</dd>
            <dt className="text-(--text-tertiary)">{t('credentials')}</dt>
            <dd className="min-w-0 text-(--text-primary)">
              {connection.secretKeys.length
                ? t('credentialsConfigured', { count: connection.secretKeys.length })
                : t('noCredentialsRequired')}
              {connection.secretKeys.length > 0 && (
                <span className="font-mono text-[11px] text-(--text-tertiary)">
                  {' '}
                  · {connection.secretKeys.join(', ')}
                </span>
              )}
            </dd>
            <dt className="text-(--text-tertiary)">{t('networkAccess')}</dt>
            <dd className="min-w-0 break-words text-(--text-primary)">{egress}</dd>
            {operations.length > 0 && (
              <>
                <dt className="text-(--text-tertiary)">{t('capabilities')}</dt>
                <dd className="flex min-w-0 flex-wrap gap-1">
                  {operations.map((operation) => (
                    <span
                      key={operation}
                      className="badge border border-(--border-subtle) bg-(--surface-card) text-[10px] font-medium text-(--text-secondary)"
                    >
                      {operation}
                    </span>
                  ))}
                </dd>
              </>
            )}
            <dt className="text-(--text-tertiary)">{t('usedBy')}</dt>
            <dd className="min-w-0">
              {agents.length === 0 ? (
                <span className="text-(--text-tertiary)">{t('usedByNone')}</span>
              ) : (
                <ul className="flex flex-wrap gap-x-4 gap-y-1">
                  {agents.map((agent) => {
                    const label = agentLabel(agent)
                    return (
                      <li key={agent.id}>
                        <Link
                          href={orgPath(`/agents/${encodeURIComponent(agent.id)}?tab=memory`)}
                          aria-label={t('openAgentMemory', { name: label })}
                          className="lnk inline-flex items-center gap-[6px] text-[12px] font-medium"
                        >
                          <span className="av h-[18px] w-[18px] rounded-[5px]">
                            <AgentIconView icon={agent.icon} runtime={agent.runtime || agent.model || ''} size={18} />
                          </span>
                          {label}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </dd>
          </dl>
        </div>
      )}
    </div>
  )
}

/** Step one's credential definitions: what the plugin expects, without values. */
function FieldRowsEditor({
  rows,
  onChange
}: {
  rows: MemoryPluginSecretHeaderDto[]
  onChange: (rows: MemoryPluginSecretHeaderDto[]) => void
}) {
  const t = useTranslations('Knowledge.memoryConnections.dialog')
  const set = (index: number, patch: Partial<MemoryPluginSecretHeaderDto>) =>
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
  return (
    <div className="fld">
      <span className="fldlbl">{t('credentialFields')}</span>
      <span className="text-[11px] text-(--text-tertiary)">{t('credentialFieldsHint')}</span>
      {rows.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          {rows.map((row, index) => (
            <div key={index} className="grid grid-cols-1 gap-2 desktop:grid-cols-[1fr_1fr_auto]">
              <input
                className="dsinput-field mono"
                placeholder="apiKey"
                aria-label={t('fieldName')}
                value={row.name}
                onChange={(event) => set(index, { name: event.target.value })}
              />
              <input
                className="dsinput-field mono"
                placeholder="Authorization"
                aria-label={t('fieldHeader')}
                value={row.header}
                onChange={(event) => set(index, { header: event.target.value })}
              />
              <span className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-[11px] text-(--text-secondary)">
                  <input
                    type="checkbox"
                    checked={row.required}
                    onChange={(event) => set(index, { required: event.target.checked })}
                  />
                  {t('required')}
                </label>
                <button
                  type="button"
                  className="iconbtn"
                  aria-label={t('removeCredentialField')}
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                >
                  <Icon name="x" size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="lnk mt-1 self-start text-[12px]"
        onClick={() => onChange([...rows, { name: '', header: '', required: true }])}
      >
        {t('addCredentialField')}
      </button>
    </div>
  )
}

function SecretValueFields({
  fields,
  transport,
  values,
  onChange
}: {
  fields: MemoryPluginSecretHeaderDto[]
  transport: Transport
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void
}) {
  const t = useTranslations('Knowledge.memoryConnections.dialog')
  if (fields.length === 0) return <div className="text-[12px] text-(--text-tertiary)">{t('noCredentials')}</div>
  return (
    <>
      {fields.map((field) => (
        <label key={field.name} className="fld">
          <span className="fldlbl">
            {field.name}
            {field.required ? ' *' : ''}
          </span>
          <input
            className="dsinput-field mono"
            type="password"
            autoComplete="new-password"
            placeholder={transport === 'stdio' ? t('passedToCommand') : t('sentAsHeader', { header: field.header })}
            value={values[field.name] ?? ''}
            onChange={(event) => onChange({ ...values, [field.name]: event.target.value })}
          />
        </label>
      ))}
    </>
  )
}

function DialogHead({ title, onClose }: { title: string; onClose: () => void }) {
  const t = useTranslations('Knowledge.memoryConnections.dialog')
  return (
    <div className="modalhead">
      <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
        <Icon name="database" size={16} color="var(--brand)" />
      </span>
      <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{title}</span>
      <button className="iconbtn" onClick={onClose} aria-label={t('close')}>
        <Icon name="x" size={16} />
      </button>
    </div>
  )
}

// Two steps, as memory-evolution.md §3.3.1 allows: the plugin first, then the account on it.
function CreateMemoryConnectionModal({
  installations,
  preselectedId,
  onClose,
  onSaved
}: {
  installations: MemoryPluginInstallationDto[]
  preselectedId: string | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const t = useTranslations('Knowledge.memoryConnections.dialog')
  const tc = useTranslations('Knowledge.memoryConnections')
  const [step, setStep] = useState<'plugin' | 'account'>('plugin')
  const [installationId, setInstallationId] = useState(preselectedId ?? installations[0]?.id ?? 'new')
  const [pluginId, setPluginId] = useState('')
  const [transport, setTransport] = useState<Transport>('streamable-http')
  const [endpoint, setEndpoint] = useState('')
  const [commandRef, setCommandRef] = useState('')
  const [manifestDigest, setManifestDigest] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [newFields, setNewFields] = useState<MemoryPluginSecretHeaderDto[]>([])
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const [configText, setConfigText] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = installations.find((installation) => installation.id === installationId)
  const definedFields = newFields.filter((row) => row.name.trim() || row.header.trim())
  const fields = selected ? selected.secretHeaders : definedFields.map((row) => ({ ...row, name: row.name.trim() }))
  const accountTransport = selected ? selected.transport : transport
  const summary = selected
    ? `${selected.pluginId} · ${whereLabel(selected, tc)}`
    : `${pluginId.trim()} · ${
        transport === 'stdio'
          ? tc('localTransport', { ref: commandRef.trim() })
          : tc('remoteTransport', { endpoint: hostOf(endpoint.trim()) })
      }`

  const next = () => {
    setError(null)
    if (!selected) {
      if (!pluginId.trim()) return setError(t('errors.pluginIdRequired'))
      if (transport === 'streamable-http' && !endpoint.trim()) return setError(t('errors.endpointRequired'))
      if (transport === 'stdio' && !commandRef.trim()) return setError(t('errors.commandRefRequired'))
      if (definedFields.some((row) => !row.name.trim() || !row.header.trim()))
        return setError(t('errors.credentialFieldsInvalid'))
    }
    setStep('account')
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    let createdInstallation: MemoryPluginInstallationDto | undefined
    try {
      const config = parseObjectJson(configText, t)
      const missing = fields.filter((field) => field.required && !secretValues[field.name])
      if (missing.length)
        throw new Error(t('errors.missingSecretValues', { names: missing.map((field) => field.name).join(', ') }))
      let target = selected
      if (!target) {
        const common = {
          pluginId: pluginId.trim(),
          ...(manifestDigest.trim() ? { expectedManifestDigest: manifestDigest.trim() } : {}),
          secretHeaders: definedFields.map(({ name, header, required }) => ({
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
      }
      await createExternalMemoryConnection({
        installationId: target.id,
        config,
        secrets: secretsFor(fields, secretValues)
      })
      await onSaved()
    } catch (cause) {
      if (createdInstallation) await deleteMemoryPluginInstallation(createdInstallation.id).catch(() => undefined)
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  const stepLabel = (
    <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
      {step === 'plugin'
        ? t('stepOf', { step: 1, title: t('steps.plugin') })
        : t('stepOf', { step: 2, title: t('steps.account') })}
    </span>
  )

  return (
    <>
      <DialogHead title={t('addTitle')} onClose={onClose} />
      {step === 'plugin' ? (
        <div className="modalbody flex flex-col gap-4">
          {stepLabel}
          <label className="fld">
            <span className="fldlbl">{t('plugin')}</span>
            <select
              className="dsinput-field"
              value={installationId}
              onChange={(event) => {
                setInstallationId(event.target.value)
                setSecretValues({})
              }}
            >
              {installations.map((installation) => (
                <option key={installation.id} value={installation.id}>
                  {installation.pluginId} · {whereLabel(installation, tc)}
                </option>
              ))}
              <option value="new">{t('registerNewPlugin')}</option>
            </select>
          </label>
          {!selected && (
            <>
              <div className="grid grid-cols-1 gap-4 desktop:grid-cols-2">
                <label className="fld">
                  <span className="fldlbl">{t('pluginId')}</span>
                  <input
                    className="dsinput-field mono"
                    placeholder="ai.mem0.memory"
                    value={pluginId}
                    onChange={(event) => setPluginId(event.target.value)}
                  />
                </label>
                <div className="fld">
                  <span className="fldlbl">{t('runs')}</span>
                  <div className="pillbar self-start">
                    <button
                      type="button"
                      className={transport === 'streamable-http' ? 'pill on' : 'pill'}
                      onClick={() => setTransport('streamable-http')}
                    >
                      {t('remote')}
                    </button>
                    <button
                      type="button"
                      className={transport === 'stdio' ? 'pill on' : 'pill'}
                      onClick={() => setTransport('stdio')}
                    >
                      {t('local')}
                    </button>
                  </div>
                </div>
              </div>
              {transport === 'stdio' ? (
                <label className="fld">
                  <span className="fldlbl">{t('commandName')}</span>
                  <input
                    className="dsinput-field mono"
                    placeholder="mem0-oss"
                    value={commandRef}
                    onChange={(event) => setCommandRef(event.target.value)}
                  />
                  <span className="text-[11px] text-(--text-tertiary)">{t('commandHint')}</span>
                </label>
              ) : (
                <label className="fld">
                  <span className="fldlbl">{t('pluginUrl')}</span>
                  <input
                    className="dsinput-field mono"
                    type="url"
                    placeholder="https://memory-plugin.example/mcp"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                  />
                </label>
              )}
              <FieldRowsEditor rows={newFields} onChange={setNewFields} />
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  className="lnk inline-flex items-center gap-1 self-start text-[12px]"
                  aria-expanded={advanced}
                  onClick={() => setAdvanced((value) => !value)}
                >
                  <Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={13} />
                  {t('advanced')}
                </button>
                {advanced && (
                  <label className="fld">
                    <span className="fldlbl">{t('manifestDigest')}</span>
                    <input
                      className="dsinput-field mono"
                      placeholder="sha256:…"
                      value={manifestDigest}
                      onChange={(event) => setManifestDigest(event.target.value)}
                    />
                    <span className="text-[11px] text-(--text-tertiary)">{t('manifestDigestHint')}</span>
                  </label>
                )}
              </div>
            </>
          )}
          {error && <div className="text-[12px] text-(--status-error)">{error}</div>}
        </div>
      ) : (
        <div className="modalbody flex flex-col gap-4">
          {stepLabel}
          <div className="flex items-center gap-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-(--text-secondary)">{summary}</span>
            <button type="button" className="lnk flex-none text-[12px]" onClick={() => setStep('plugin')}>
              {t('change')}
            </button>
          </div>
          <SecretValueFields
            fields={fields}
            transport={accountTransport}
            values={secretValues}
            onChange={setSecretValues}
          />
          <label className="fld">
            <span className="fldlbl">{t('settings')}</span>
            <textarea
              className="dsinput-field mono min-h-[120px] resize-y"
              spellCheck={false}
              value={configText}
              onChange={(event) => setConfigText(event.target.value)}
            />
            <span className="text-[11px] text-(--text-tertiary)">{t('settingsHint')}</span>
          </label>
          {error && <div className="text-[12px] text-(--status-error)">{error}</div>}
        </div>
      )}
      <div className="modalfoot">
        <div className="flex-1" />
        {step === 'plugin' ? (
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button onClick={next}>
              {t('next')}
              <Icon name="chevron-right" size={14} />
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setStep('plugin')}>
              {t('back')}
            </Button>
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? t('creating') : t('createConnection')}
            </Button>
          </>
        )}
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
  const t = useTranslations('Knowledge.memoryConnections.dialog')
  const tc = useTranslations('Knowledge.memoryConnections')
  const [configText, setConfigText] = useState(JSON.stringify(connection.config, null, 2))
  const [replaceSecrets, setReplaceSecrets] = useState(false)
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fields = installation?.secretHeaders ?? []
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const config = parseObjectJson(configText, t)
      let secrets: Record<string, string> | undefined
      if (replaceSecrets) {
        const missing = fields.filter((field) => field.required && !secretValues[field.name])
        if (missing.length)
          throw new Error(t('errors.missingSecretValues', { names: missing.map((field) => field.name).join(', ') }))
        secrets = secretsFor(fields, secretValues)
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
      <DialogHead title={t('editTitle')} onClose={onClose} />
      <div className="modalbody flex flex-col gap-4">
        <div className="truncate rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-mono text-[12px] text-(--text-secondary)">
          {installation?.pluginId ?? tc('unknownPlugin')} · {whereLabel(installation, tc)}
        </div>
        <label className="fld">
          <span className="fldlbl">{t('settings')}</span>
          <textarea
            className="dsinput-field mono min-h-[140px] resize-y"
            spellCheck={false}
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
          />
          <span className="text-[11px] text-(--text-tertiary)">{t('settingsHint')}</span>
        </label>
        {fields.length > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-(--text-secondary)">
            <input
              type="checkbox"
              checked={replaceSecrets}
              onChange={(event) => setReplaceSecrets(event.target.checked)}
            />
            {t('replaceSecrets')}
          </label>
        )}
        {replaceSecrets && (
          <SecretValueFields
            fields={fields}
            transport={installation?.transport ?? 'streamable-http'}
            values={secretValues}
            onChange={setSecretValues}
          />
        )}
        {error && <div className="text-[12px] text-(--status-error)">{error}</div>}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button disabled={busy} onClick={() => void submit()}>
          {busy ? t('saving') : t('save')}
        </Button>
      </div>
    </>
  )
}
