'use client'

import useSWR from 'swr'
import { useState } from 'react'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import {
  fetchExternalMemoryConnections,
  fetchMemoryPluginInstallations,
  type ExternalMemoryConnectionDto,
  type ExternalMemoryRecallPolicy,
  type MemoryPluginInstallationDto
} from '@/lib/api'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'

export interface ExternalMemoryBindingDraft {
  connectionId: string
  recall: ExternalMemoryRecallPolicy
  captureMode: 'turn' | 'manual'
}

export const DEFAULT_EXTERNAL_MEMORY_BINDING: ExternalMemoryBindingDraft = {
  connectionId: '',
  // This is an end-to-end daemon -> relay -> plugin -> backend budget. Keep
  // enough headroom around a healthy ~1s remote search to avoid deadline races.
  recall: { mode: 'auto', topK: 5, maxBytes: 8192, timeoutMs: 3000 },
  captureMode: 'manual'
}

type MemoryConnectionStatus = ExternalMemoryConnectionDto['status']

/** How to present a connection installation's trusted transport target. A local
 * stdio plugin has no network endpoint — it runs an operator-allowlisted command
 * reference — so labelling it "Plugin endpoint: unavailable" is misleading. */
export function connectionEndpointDisplay(
  installation: Pick<MemoryPluginInstallationDto, 'transport' | 'endpoint' | 'commandRef'> | undefined
): { label: string; value: string } {
  if (installation?.transport === 'stdio') {
    return { label: 'Operator command', value: installation.commandRef ?? 'unavailable' }
  }
  return { label: 'Plugin endpoint', value: installation?.endpoint ?? 'unavailable' }
}

export interface ConnectionStatusNotice {
  tone: 'progress' | 'warn' | 'error'
  text: string
}

/** State-specific console copy for a connection revision. `ready` needs no
 * banner (the status badge already says so). `probing` is the initial
 * compatibility check. `degraded` is an already-admitted revision that is only
 * temporarily unavailable — it must NOT claim it still needs a first
 * compatibility check. `invalid` is a proven static failure. */
export function connectionStatusNotice(status: MemoryConnectionStatus): ConnectionStatusNotice | null {
  switch (status) {
    case 'ready':
      return null
    case 'probing':
      return {
        tone: 'progress',
        text: 'Verifying compatibility — the agent can start with external memory once this revision passes its first check.'
      }
    case 'degraded':
      return {
        tone: 'warn',
        text: 'This revision was admitted but the plugin is temporarily unavailable. The agent keeps running and recall fails open; AgentConnect keeps retrying.'
      }
    case 'invalid':
      return {
        tone: 'error',
        text: 'This revision failed conformance validation. Update the connection to return it to verification before an agent can use it.'
      }
  }
}

const STATUS_NOTICE_CLASS: Record<ConnectionStatusNotice['tone'], string> = {
  progress: 'text-(--text-tertiary)',
  warn: 'text-(--amber-500)',
  error: 'text-(--red-600)'
}

export function ExternalMemoryBindingFields({
  value,
  onChange,
  disabled = false,
  emptySelectionDisabled = false
}: {
  value: ExternalMemoryBindingDraft
  onChange: (value: ExternalMemoryBindingDraft) => void
  disabled?: boolean
  /** Keep an already-bound agent from looking unbound while its persisted
   * connection remains active. Switching connections stays available. */
  emptySelectionDisabled?: boolean
}) {
  const [confirmingCapture, setConfirmingCapture] = useState(false)
  const { activeOrg, orgPath } = useOrgs()
  const connectionKey = consoleKeys.externalMemoryConnections(activeOrg?.id)
  const installationKey = consoleKeys.memoryPluginInstallations(activeOrg?.id)
  const {
    data: connections = [],
    error: connectionError,
    isLoading
  } = useSWR(connectionKey, ([, orgId]) => fetchExternalMemoryConnections(orgId))
  const { data: installations = [] } = useSWR(installationKey, ([, orgId]) => fetchMemoryPluginInstallations(orgId))
  const installationById = new Map(installations.map((installation) => [installation.id, installation]))
  const selected = connections.find((connection) => connection.id === value.connectionId)
  const selectedInstallation = selected ? installationById.get(selected.installationId) : undefined
  const selectable = connections.filter((connection) => connection.status !== 'invalid')
  const endpointDisplay = connectionEndpointDisplay(selectedInstallation)
  const statusNotice = selected ? connectionStatusNotice(selected.status) : null

  const setCapture = (mode: 'turn' | 'manual') => {
    if (mode === value.captureMode) return
    if (mode === 'turn') {
      setConfirmingCapture(true)
      return
    }
    onChange({ ...value, captureMode: mode })
  }

  return (
    <div className="desktop:col-span-2 flex flex-col gap-3 rounded-md border border-(--border-subtle) bg-(--surface-sunken) p-3">
      <label className="fld">
        <span className="fldlbl">External-memory connection</span>
        <select
          className="dsinput-field"
          disabled={disabled || isLoading}
          value={value.connectionId}
          onChange={(event) => onChange({ ...value, connectionId: event.target.value, captureMode: 'manual' })}
          required
          aria-invalid={!value.connectionId}
        >
          <option value="" disabled={emptySelectionDisabled}>
            Select a connection…
          </option>
          {selectable.map((connection) => {
            const installation = installationById.get(connection.installationId)
            return (
              <option key={connection.id} value={connection.id}>
                {installation?.pluginId ?? 'Unknown plugin'} · {connection.status} · {connection.id.slice(0, 8)}
              </option>
            )
          })}
        </select>
      </label>
      {connectionError && <div className="text-[12px] text-(--red-600)">{String(connectionError)}</div>}
      {isLoading && <div className="text-[12px] text-(--text-tertiary)">Loading external-memory connections…</div>}
      {!isLoading && connections.length === 0 && (
        <div className="text-[12px] leading-[1.5] text-(--text-secondary)">
          No external-memory connection is configured. An organization owner can add one in{' '}
          <a className="lnk" href={orgPath('/knowledge#external-memory')}>
            Knowledge → External memory
          </a>
          .
        </div>
      )}
      {selected && (
        <div className="rounded-md border border-(--border-subtle) bg-(--surface-card) p-3 text-[11.5px] leading-[1.5] text-(--text-secondary)">
          <div>
            <span className="font-semibold">Plugin:</span>{' '}
            <span className="mono">{selectedInstallation?.pluginId ?? 'unknown'}</span>{' '}
            <span className="badge ml-1 bg-(--surface-active) text-(--text-secondary)">{selected.status}</span>
          </div>
          {statusNotice && <div className={`mt-1 ${STATUS_NOTICE_CLASS[statusNotice.tone]}`}>{statusNotice.text}</div>}
          <details className="mt-1">
            <summary className="cursor-pointer font-semibold text-(--text-tertiary)">Endpoint &amp; egress</summary>
            <div className="mt-1 break-all">
              <span className="font-semibold">{endpointDisplay.label}:</span>{' '}
              <span className="mono">{endpointDisplay.value}</span>
            </div>
            <div className="mt-1">
              <span className="font-semibold">Declared downstream egress:</span>{' '}
              {selected.declaredEgressHosts.length
                ? selected.declaredEgressHosts.join(', ')
                : selected.status === 'ready'
                  ? 'none declared'
                  : 'not reported yet'}
            </div>
            <div className="mt-1 text-(--text-tertiary)">
              AgentConnect enforces the plugin endpoint. Downstream hosts are declarations made by the plugin.
            </div>
          </details>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
        <div className="fld">
          <span className="fldlbl">Recall</span>
          <div className="pillbar self-start">
            <button
              type="button"
              disabled={disabled}
              className={
                value.recall.mode === 'auto' ? 'pill on px-[10px] py-1 text-[12px]' : 'pill px-[10px] py-1 text-[12px]'
              }
              onClick={() => onChange({ ...value, recall: { ...value.recall, mode: 'auto' } })}
            >
              Every turn
            </button>
            <button
              type="button"
              disabled={disabled}
              className={
                value.recall.mode === 'tool-only'
                  ? 'pill on px-[10px] py-1 text-[12px]'
                  : 'pill px-[10px] py-1 text-[12px]'
              }
              onClick={() => onChange({ ...value, recall: { ...value.recall, mode: 'tool-only' } })}
            >
              Tool only
            </button>
          </div>
          <span className="mt-1 text-[11px] text-(--text-tertiary)">
            {value.recall.mode === 'auto'
              ? 'A bounded query derived from each delivered turn is sent to the plugin.'
              : 'No automatic query; the agent searches only through the stable memory tool.'}
          </span>
        </div>
        <div className="fld">
          <span className="fldlbl">Capture</span>
          <div className="pillbar self-start">
            <button
              type="button"
              disabled={disabled}
              className={
                value.captureMode === 'manual'
                  ? 'pill on px-[10px] py-1 text-[12px]'
                  : 'pill px-[10px] py-1 text-[12px]'
              }
              onClick={() => setCapture('manual')}
            >
              Manual only
            </button>
            <button
              type="button"
              disabled={disabled || !value.connectionId}
              className={
                value.captureMode === 'turn' ? 'pill on px-[10px] py-1 text-[12px]' : 'pill px-[10px] py-1 text-[12px]'
              }
              onClick={() => setCapture('turn')}
            >
              Every turn
            </button>
          </div>
          <span className="mt-1 text-[11px] text-(--text-tertiary)">
            {value.captureMode === 'turn'
              ? 'The user input and final reply are sent to the plugin after every completed turn.'
              : 'Turn content is sent to the plugin only when explicitly saved.'}
          </span>
        </div>
      </div>

      <details>
        <summary className="cursor-pointer text-[11.5px] font-semibold text-(--text-secondary)">Recall limits</summary>
        <div className="mt-2 grid grid-cols-1 gap-2 desktop:grid-cols-3">
          <label className="fld">
            <span className="fldlbl">Top results</span>
            <input
              className="dsinput-field mono"
              type="number"
              min={1}
              max={20}
              disabled={disabled}
              value={value.recall.topK}
              onChange={(event) =>
                onChange({ ...value, recall: { ...value.recall, topK: Number(event.target.value) } })
              }
            />
          </label>
          <label className="fld">
            <span className="fldlbl">Max bytes</span>
            <input
              className="dsinput-field mono"
              type="number"
              min={1}
              max={32768}
              disabled={disabled}
              value={value.recall.maxBytes}
              onChange={(event) =>
                onChange({ ...value, recall: { ...value.recall, maxBytes: Number(event.target.value) } })
              }
            />
          </label>
          <label className="fld">
            <span className="fldlbl">Timeout (ms)</span>
            {/* Ceiling mirrors the protocol MEMORY_RECALL_HARD_LIMITS.timeoutMs
                (10s). Local/self-hosted providers can need several seconds on a
                cold first search; recall fails open, so a generous budget only
                delays a warm turn when the provider is genuinely slow. */}
            <input
              className="dsinput-field mono"
              type="number"
              min={1}
              max={10000}
              disabled={disabled}
              value={value.recall.timeoutMs}
              onChange={(event) =>
                onChange({ ...value, recall: { ...value.recall, timeoutMs: Number(event.target.value) } })
              }
            />
          </label>
        </div>
      </details>
      {confirmingCapture ? (
        <ConfirmationDialog
          title="Enable automatic capture?"
          confirmLabel="Enable capture"
          onClose={() => setConfirmingCapture(false)}
          onConfirm={() => {
            onChange({ ...value, captureMode: 'turn' })
            setConfirmingCapture(false)
          }}
        >
          <p className="m-0">
            After each completed turn, the user input and final agent reply will be sent to{' '}
            <span className="mono break-all text-(--text-primary)">{endpointDisplay.value}</span>.
          </p>
          <p className="mb-0 mt-3">
            Declared downstream egress:{' '}
            <span className="text-(--text-primary)">
              {selected?.declaredEgressHosts.length ? selected.declaredEgressHosts.join(', ') : 'none declared'}
            </span>
            . Existing memory is not migrated if you later switch backends.
          </p>
        </ConfirmationDialog>
      ) : null}
    </div>
  )
}
