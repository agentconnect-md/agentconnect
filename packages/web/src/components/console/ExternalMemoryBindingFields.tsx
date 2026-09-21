'use client'

import useSWR from 'swr'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
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
 * reference — so labelling it "Plugin endpoint: unavailable" is misleading.
 * Returns message keys under `Agents.dialog.memory.external`, not display text —
 * the caller resolves them through `t` so the logic stays testable without one. */
export function connectionEndpointDisplay(
  installation: Pick<MemoryPluginInstallationDto, 'transport' | 'endpoint' | 'commandRef'> | undefined
): { labelKey: 'operatorCommand' | 'pluginEndpoint'; value: string | null } {
  if (installation?.transport === 'stdio') {
    return { labelKey: 'operatorCommand', value: installation.commandRef ?? null }
  }
  return { labelKey: 'pluginEndpoint', value: installation?.endpoint ?? null }
}

export interface ConnectionStatusNotice {
  tone: 'progress' | 'warn' | 'error'
  textKey: 'probing' | 'degraded' | 'invalid'
}

/** State-specific console copy for a connection revision. `ready` needs no
 * banner (the status badge already says so). `probing` is the initial
 * compatibility check. `degraded` is an already-admitted revision that is only
 * temporarily unavailable — it must NOT claim it still needs a first
 * compatibility check. `invalid` is a proven static failure. Returns a message
 * key under `Agents.dialog.memory.external.notice`, resolved by the caller. */
export function connectionStatusNotice(status: MemoryConnectionStatus): ConnectionStatusNotice | null {
  switch (status) {
    case 'ready':
      return null
    case 'probing':
      return { tone: 'progress', textKey: 'probing' }
    case 'degraded':
      return { tone: 'warn', textKey: 'degraded' }
    case 'invalid':
      return { tone: 'error', textKey: 'invalid' }
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
  const t = useTranslations('Agents.dialog.memory.external')
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
        <span className="fldlbl">{t('connectionLabel')}</span>
        <select
          className="dsinput-field"
          disabled={disabled || isLoading}
          value={value.connectionId}
          onChange={(event) => onChange({ ...value, connectionId: event.target.value, captureMode: 'manual' })}
          required
          aria-invalid={!value.connectionId}
        >
          <option value="" disabled={emptySelectionDisabled}>
            {t('selectConnection')}
          </option>
          {selectable.map((connection) => {
            const installation = installationById.get(connection.installationId)
            return (
              <option key={connection.id} value={connection.id}>
                {installation?.pluginId ?? t('unknownPlugin')} · {connection.status} · {connection.id.slice(0, 8)}
              </option>
            )
          })}
        </select>
      </label>
      {connectionError && <div className="text-[12px] text-(--red-600)">{String(connectionError)}</div>}
      {isLoading && <div className="text-[12px] text-(--text-tertiary)">{t('loading')}</div>}
      {!isLoading && connections.length === 0 && (
        <div className="text-[12px] leading-[1.5] text-(--text-secondary)">
          {t.rich('emptyState', {
            link: (chunks) => (
              <a className="lnk" href={orgPath('/knowledge#external-memory')}>
                {chunks}
              </a>
            )
          })}
        </div>
      )}
      {selected && (
        <div className="rounded-md border border-(--border-subtle) bg-(--surface-card) p-3 text-[11.5px] leading-[1.5] text-(--text-secondary)">
          <div>
            <span className="font-semibold">{t('pluginLabel')}</span>{' '}
            <span className="mono">{selectedInstallation?.pluginId ?? t('unknownValue')}</span>{' '}
            <span className="badge ml-1 bg-(--surface-active) text-(--text-secondary)">{selected.status}</span>
          </div>
          {statusNotice && (
            <div className={`mt-1 ${STATUS_NOTICE_CLASS[statusNotice.tone]}`}>
              {t(`notice.${statusNotice.textKey}`)}
            </div>
          )}
          <details className="mt-1">
            <summary className="cursor-pointer font-semibold text-(--text-tertiary)">{t('endpointAndEgress')}</summary>
            <div className="mt-1 break-all">
              <span className="font-semibold">{t(endpointDisplay.labelKey)}:</span>{' '}
              <span className="mono">{endpointDisplay.value ?? t('unavailable')}</span>
            </div>
            <div className="mt-1">
              <span className="font-semibold">{t('declaredEgress')}</span>{' '}
              {selected.declaredEgressHosts.length
                ? selected.declaredEgressHosts.join(', ')
                : selected.status === 'ready'
                  ? t('noneDeclared')
                  : t('notReportedYet')}
            </div>
          </details>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
        <div className="fld">
          <span className="fldlbl">{t('recall.label')}</span>
          <div className="pillbar self-start">
            <button
              type="button"
              disabled={disabled}
              className={
                value.recall.mode === 'auto' ? 'pill on px-[10px] py-1 text-[12px]' : 'pill px-[10px] py-1 text-[12px]'
              }
              onClick={() => onChange({ ...value, recall: { ...value.recall, mode: 'auto' } })}
            >
              {t('recall.auto')}
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
              {t('recall.toolOnly')}
            </button>
          </div>
          <span className="mt-1 text-[11px] text-(--text-tertiary)">
            {value.recall.mode === 'auto' ? t('recall.autoHint') : t('recall.toolOnlyHint')}
          </span>
        </div>
        <div className="fld">
          <span className="fldlbl">{t('capture.label')}</span>
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
              {t('capture.manual')}
            </button>
            <button
              type="button"
              disabled={disabled || !value.connectionId}
              className={
                value.captureMode === 'turn' ? 'pill on px-[10px] py-1 text-[12px]' : 'pill px-[10px] py-1 text-[12px]'
              }
              onClick={() => setCapture('turn')}
            >
              {t('capture.turn')}
            </button>
          </div>
          <span className="mt-1 text-[11px] text-(--text-tertiary)">
            {value.captureMode === 'turn' ? t('capture.turnHint') : t('capture.manualHint')}
          </span>
        </div>
      </div>

      <details>
        <summary className="cursor-pointer text-[11.5px] font-semibold text-(--text-secondary)">
          {t('recall.limits')}
        </summary>
        <div className="mt-2 grid grid-cols-1 gap-2 desktop:grid-cols-3">
          <label className="fld">
            <span className="fldlbl">{t('recall.topResults')}</span>
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
            <span className="fldlbl">{t('recall.maxBytes')}</span>
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
            <span className="fldlbl">{t('recall.timeoutMs')}</span>
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
          title={t('confirmCapture.title')}
          confirmLabel={t('confirmCapture.confirm')}
          onClose={() => setConfirmingCapture(false)}
          onConfirm={() => {
            onChange({ ...value, captureMode: 'turn' })
            setConfirmingCapture(false)
          }}
        >
          <p className="m-0">
            {t.rich('confirmCapture.body', {
              endpoint: () => <span className="mono break-all text-(--text-primary)">{endpointDisplay.value}</span>
            })}
          </p>
          <p className="mb-0 mt-3">
            {t.rich('confirmCapture.egress', {
              hosts: () => (
                <span className="text-(--text-primary)">
                  {selected?.declaredEgressHosts.length ? selected.declaredEgressHosts.join(', ') : t('noneDeclared')}
                </span>
              )
            })}
          </p>
        </ConfirmationDialog>
      ) : null}
    </div>
  )
}
