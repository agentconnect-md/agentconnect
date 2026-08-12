'use client'

// Settings → "Cluster execution": the organization's managed-execution envelope
// (docs/designs/agentconnect-org-operator.md). The control plane owns the spec
// and the operator owns everything after it, so this card WRITES settings and
// READS status live from the AgentConnectOrg resource — a stored field is never
// presented as cluster truth.
//
// Three things it deliberately does not do:
//
//  1. It never shows the daemon key. Issuing publishes the key into a cluster
//     Secret and answers with a revision handle only, so there is nothing to
//     reveal and no copy button to offer.
//  2. It renders nothing where the deployment has no cluster configured. The
//     whole surface 404s there, which is an absent feature, not an error.
//  3. It is owner-only, like every other write on this page.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import {
  ApiError,
  fetchClusterExecution,
  fetchClusterExecutionStatus,
  issueClusterExecutionCredential,
  updateClusterExecution,
  type ClusterConditionDto,
  type ClusterEgressPolicy,
  type ClusterEnvelopeStatusDto,
  type ClusterExecutionSettingsDto,
  type ClusterRuntimeTierDto,
  type UpdateClusterExecutionBody
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { Button, Icon, Toggle } from '@/components/ui'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { LoadingState } from '@/components/marks'

/** The envelope moves on the operator's clock, not on a request's. */
const STATUS_REFRESH_MS = 10_000

/** The CRD's own bound on `runtime.tiers[]`. */
const MAX_TIERS = 16

const FIELD =
  'w-full min-w-0 rounded-md border border-(--border-default) bg-(--surface-card) px-[9px] font-mono text-[12px] font-medium text-(--text-primary) outline-none focus:border-(--border-focus) focus:ring-[3px] focus:ring-(--brand-ring)'
const INPUT = `h-8 ${FIELD}`
const LABEL = 'font-sans text-[12px] font-semibold leading-normal text-(--text-primary)'
const HELP = 'font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)'
const ROW = 'flex flex-col gap-3 px-4 py-[15px] desktop:flex-row desktop:items-center desktop:gap-4'

/** Operator-owned condition types, named the way this page reads them. */
const CONDITION_LABELS: Record<string, string> = {
  Ready: 'Ready',
  NamespaceReady: 'Namespace',
  CredentialReady: 'Credential',
  LimitsApplied: 'Limits',
  Progressing: 'Progressing',
  Degraded: 'Degraded'
}

/** Conditions that are news only while TRUE — a steady envelope is neither. */
const TRANSIENT = new Set(['Progressing', 'Degraded'])

const EGRESS_POLICIES: { value: ClusterEgressPolicy; label: string; detail: string }[] = [
  { value: 'locked', label: 'Locked', detail: 'Sandboxes reach nothing outside the cluster.' },
  { value: 'curated', label: 'Curated', detail: 'Sandboxes reach the destinations this deployment allows.' },
  { value: 'open', label: 'Open', detail: 'Sandboxes reach the internet.' }
]

/** The refusals this surface answers with, in the console's own words. */
const REFUSALS: Record<string, string> = {
  CLUSTER_NOT_ENABLED: 'Cluster execution is switched off for this organization.',
  CLUSTER_NAMESPACE_NOT_READY: 'The envelope namespace does not exist yet. Try again once Namespace reads ready.',
  CLUSTER_ROTATION_IN_PROGRESS: 'Another credential rotation is already running for this organization.'
}

function errorMessage(err: unknown): string {
  const refusal = err instanceof ApiError && err.code ? REFUSALS[err.code] : undefined
  if (refusal) return refusal
  return err instanceof Error ? err.message : String(err)
}

/** 404 ⇒ this deployment mounts no cluster routes at all. */
function isAbsentFeature(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404
}

export function ClusterExecutionCard({ orgId, isOwner }: { orgId: string | undefined; isOwner: boolean }) {
  const key = isOwner ? consoleKeys.clusterExecution(orgId) : null
  const {
    data: settings,
    error: loadError,
    mutate
  } = useSWR<ClusterExecutionSettingsDto>(key, ([, id]) => fetchClusterExecution(id as string))
  // Status exists only once a resource does, and it is the operator's to answer.
  const statusKey = settings?.enabled ? consoleKeys.clusterExecutionStatus(orgId) : null
  const { data: status, error: statusError } = useSWR<ClusterEnvelopeStatusDto>(
    statusKey,
    ([, id]) => fetchClusterExecutionStatus(id as string),
    { refreshInterval: STATUS_REFRESH_MS }
  )

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [disabling, setDisabling] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [configuring, setConfiguring] = useState(false)

  useEffect(() => {
    setError(null)
    setDisabling(false)
    setRotating(false)
    setConfiguring(false)
  }, [orgId])

  if (!isOwner) return null
  if (loadError && isAbsentFeature(loadError)) return null

  const save = async (patch: UpdateClusterExecutionBody) => {
    if (!orgId || busy) return
    setBusy(true)
    setError(null)
    try {
      await mutate(await updateClusterExecution(patch, orgId), { revalidate: false })
      setDisabling(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const issue = async () => {
    if (!orgId || busy) return
    setBusy(true)
    setError(null)
    try {
      await issueClusterExecutionCredential(orgId)
      setRotating(false)
      await mutate()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card mt-[18px]" id="cluster-execution">
      <div className="cardhead justify-between">
        <span className="inline-flex min-w-0 items-baseline gap-[7px]">
          <span className="cardtitle">Cluster execution</span>
          {settings?.enabled && status?.namespace && (
            <span className="mono truncate text-[11px] text-(--text-tertiary)">{status.namespace}</span>
          )}
        </span>
        {settings?.enabled && (
          <Button variant="secondary" size="xs" onClick={() => setConfiguring(true)}>
            <Icon name="sliders-horizontal" size={14} />
            Configure
          </Button>
        )}
      </div>

      {settings === undefined && !loadError ? (
        <LoadingState size={22} padding={20} />
      ) : !settings ? (
        <div className="px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
          Couldn&apos;t load the cluster execution settings.
        </div>
      ) : (
        <>
          <div className={ROW}>
            <div className="min-w-0 flex-1">
              <div className="font-sans text-[13px] font-medium leading-normal">
                Run this organization in the cluster
              </div>
              <div className={`${HELP} mt-[3px]`}>
                The operator provisions a namespace, a daemon, and the sandbox pools this organization&apos;s agents run
                in. Switching it off deletes the envelope.
              </div>
            </div>
            <Toggle
              checked={settings.enabled}
              disabled={busy}
              ariaLabel="Run this organization in the cluster"
              onChange={(next) => (next ? void save({ enabled: true }) : setDisabling(true))}
            />
          </div>

          {settings.enabled && (
            <>
              <div className={`${ROW} border-t border-(--border-subtle)`}>
                <div className="min-w-0 flex-1">
                  <div className="font-sans text-[13px] font-medium leading-normal">Suspend</div>
                  <div className={`${HELP} mt-[3px]`}>
                    Quiesce without tearing down — the daemon goes to zero and the sandboxes drain. The envelope stays.
                  </div>
                </div>
                <Toggle
                  checked={settings.suspend}
                  disabled={busy}
                  ariaLabel="Suspend"
                  onChange={(next) => void save({ suspend: next })}
                />
              </div>

              <EnvelopeStatus status={status} error={statusError} />

              <div className={`${ROW} border-t border-(--border-subtle)`}>
                <div className="min-w-0 flex-1">
                  <div className="font-sans text-[13px] font-medium leading-normal">Daemon credential</div>
                  <div className={`${HELP} mt-[3px]`}>
                    Published into the <span className="mono">{settings.credentialSecretName}</span>&#32;Secret in the
                    envelope namespace. The key is never shown here; rotating recreates the daemon pod on the new one.
                  </div>
                </div>
                <span className="mono truncate text-[11px] text-(--text-tertiary)">
                  {settings.credentialRevision ?? 'Not issued'}
                </span>
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={busy}
                  onClick={() => (settings.credentialRevision ? setRotating(true) : void issue())}
                >
                  {settings.credentialRevision ? 'Rotate' : 'Issue'}
                </Button>
              </div>
            </>
          )}

          {error && !disabling && !rotating && (
            <div
              role="alert"
              className="border-t border-(--border-subtle) px-4 py-[13px] font-sans text-[12px] font-normal leading-normal text-(--status-error)"
            >
              {error}
            </div>
          )}
        </>
      )}

      {disabling && (
        <ConfirmationDialog
          title="Switch off cluster execution?"
          confirmLabel="Switch off"
          busy={busy}
          busyLabel="Switching off…"
          error={error}
          onConfirm={() => void save({ enabled: false })}
          onClose={() => (busy ? undefined : setDisabling(false))}
        >
          The operator removes this organization&apos;s envelope — its namespace, its daemon, and every sandbox in it —
          and the daemon credential is revoked. Agents placed there stop running until it is switched back on.
        </ConfirmationDialog>
      )}

      {rotating && (
        <ConfirmationDialog
          title="Rotate the daemon credential?"
          confirmLabel="Rotate"
          busy={busy}
          busyLabel="Rotating…"
          error={error}
          onConfirm={() => void issue()}
          onClose={() => (busy ? undefined : setRotating(false))}
        >
          The new key is published before the old one is revoked, and the daemon pod is recreated on it. Turns running
          at that moment are interrupted; the organization&apos;s agents, sessions, and history are kept.
        </ConfirmationDialog>
      )}

      {configuring && settings && (
        <ConfigureSheet
          settings={settings}
          orgId={orgId}
          onClose={() => setConfiguring(false)}
          onSaved={async (next) => {
            setConfiguring(false)
            await mutate(next, { revalidate: false })
          }}
        />
      )}
    </div>
  )
}

/**
 * What the operator says about the envelope — never what the settings row says.
 * Because this panel IS the live read, a failed one is never rendered as
 * loading, and a snapshot SWR retained across a failure is never rendered as
 * current: a stale `Ready` with nothing marking it is the one wrong answer here.
 */
function EnvelopeStatus({ status, error }: { status: ClusterEnvelopeStatusDto | undefined; error: unknown }) {
  if (error && !status) {
    return (
      <div className="border-t border-(--border-subtle) px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
        Couldn&apos;t read the envelope status from the cluster.
      </div>
    )
  }
  if (!status) return <LoadingState size={20} padding={16} />
  const shown = status.conditions.filter((condition) => !TRANSIENT.has(condition.type) || condition.status === 'True')
  const warm = status.pools?.reduce((sum, pool) => sum + pool.warmAvailable, 0)
  return (
    <div className="border-t border-(--border-subtle) px-4 py-[15px]">
      {Boolean(error) && (
        <div
          role="status"
          className="mb-[10px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--status-paused)"
        >
          The cluster read is failing — this is the last status it answered, not the current one.
        </div>
      )}
      {!status.present ? (
        <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No envelope in the cluster yet — the operator creates one from the resource that was just applied.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-[6px]">
            {shown.length === 0 ? (
              <span className="badge bg-(--surface-sunken) text-(--text-tertiary)">No conditions reported</span>
            ) : (
              shown.map((condition) => <ConditionBadge key={condition.type} condition={condition} />)
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 desktop:grid-cols-4">
            <Stat label="Daemon" value={status.daemon ? (status.daemon.ready ? 'Ready' : 'Not ready') : '—'} />
            <Stat label="Sandboxes" value={status.sandboxes ? String(status.sandboxes.total) : '—'} />
            <Stat label="Running" value={status.sandboxes ? String(status.sandboxes.running) : '—'} />
            <Stat label="Warm" value={warm === undefined ? '—' : String(warm)} />
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="mt-[2px] font-sans text-[13px] font-medium leading-normal">{value}</div>
    </div>
  )
}

/** True is good for a readiness condition and bad for a fault one. */
function ConditionBadge({ condition }: { condition: ClusterConditionDto }) {
  const label = CONDITION_LABELS[condition.type] ?? condition.type
  const fault = condition.type === 'Degraded'
  const neutral = 'bg-(--surface-sunken) text-(--text-tertiary)'
  const tone =
    condition.status === 'Unknown'
      ? neutral
      : condition.status === 'True'
        ? fault
          ? 'bg-(--status-error-soft) text-(--status-error)'
          : 'bg-(--status-online-soft) text-(--status-online)'
        : fault
          ? neutral
          : 'bg-(--status-paused-soft) text-(--status-paused)'
  const detail = [condition.reason, condition.message].filter(Boolean).join(' — ')
  return (
    <span className={`badge ${tone}`} title={detail || undefined}>
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">
        {label}: {condition.status}
        {detail ? `. ${detail}` : ''}
      </span>
    </span>
  )
}

/** The spec fields the control plane owns. The resource name and the Secret name
 *  are fixed at first enable, and the namespace is the operator's, so none is here. */
function ConfigureSheet({
  settings,
  orgId,
  onClose,
  onSaved
}: {
  settings: ClusterExecutionSettingsDto
  orgId: string | undefined
  onClose: () => void
  onSaved: (next: ClusterExecutionSettingsDto) => Promise<void>
}) {
  const [daemonImage, setDaemonImage] = useState(settings.daemonImage)
  const [daemonTier, setDaemonTier] = useState(settings.daemonTier)
  const [runtimeImage, setRuntimeImage] = useState(settings.runtimeImage)
  const [tiers, setTiers] = useState<ClusterRuntimeTierDto[]>(settings.runtimeTiers)
  const [maxAgents, setMaxAgents] = useState(String(settings.quota.maxAgents))
  const [cpu, setCpu] = useState(settings.quota.cpu)
  const [memory, setMemory] = useState(settings.quota.memory)
  const [storage, setStorage] = useState(settings.quota.storage)
  const [egressPolicy, setEgressPolicy] = useState<ClusterEgressPolicy>(settings.egressPolicy)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The same bounds the CP enforces, so a bad value fails inline, not as a 400.
  const validation = useMemo(() => {
    if (!daemonImage.trim() || !runtimeImage.trim()) return 'Both images are required.'
    if (!daemonTier.trim()) return 'The daemon tier is required.'
    if (tiers.length < 1) return 'At least one runtime tier is required.'
    if (tiers.some((tier) => !tier.name.trim())) return 'Every runtime tier needs a name.'
    if (!/^\d+$/.test(maxAgents.trim())) return 'Max agents must be a whole number — 0 means unlimited.'
    return null
  }, [daemonImage, daemonTier, runtimeImage, tiers, maxAgents])

  const submit = async () => {
    if (busy || validation) return
    setBusy(true)
    setError(null)
    try {
      const next = await updateClusterExecution(
        {
          daemonImage: daemonImage.trim(),
          daemonTier: daemonTier.trim(),
          runtimeImage: runtimeImage.trim(),
          runtimeTiers: tiers.map((tier) => ({ name: tier.name.trim(), warmReplicas: tier.warmReplicas })),
          quota: {
            maxAgents: Number(maxAgents.trim()),
            cpu: cpu.trim(),
            memory: memory.trim(),
            storage: storage.trim()
          },
          egressPolicy
        },
        orgId
      )
      await onSaved(next)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrim" onClick={() => (busy ? undefined : onClose())}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modalhead">
          <span className="cardtitle">Configure cluster execution</span>
        </div>
        <div className="modalbody flex flex-col gap-[18px]">
          <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
            <Field label="Daemon image">
              <input className={INPUT} value={daemonImage} onChange={(event) => setDaemonImage(event.target.value)} />
            </Field>
            <Field label="Daemon tier">
              <input className={INPUT} value={daemonTier} onChange={(event) => setDaemonTier(event.target.value)} />
            </Field>
            <Field label="Runtime image" wide>
              <input className={INPUT} value={runtimeImage} onChange={(event) => setRuntimeImage(event.target.value)} />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <span className={LABEL}>Runtime tiers</span>
            <span className={HELP}>A tier is a sandbox size and how many of it the operator keeps warm.</span>
            {tiers.map((tier, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  className={INPUT}
                  value={tier.name}
                  aria-label={`Runtime tier ${index + 1} name`}
                  onChange={(event) =>
                    setTiers(tiers.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))
                  }
                />
                <input
                  className={`${INPUT} w-[92px] flex-none`}
                  type="number"
                  min={0}
                  value={String(tier.warmReplicas)}
                  aria-label={`Runtime tier ${index + 1} warm replicas`}
                  onChange={(event) =>
                    setTiers(
                      tiers.map((row, i) =>
                        i === index ? { ...row, warmReplicas: Math.max(0, Number(event.target.value)) } : row
                      )
                    )
                  }
                />
                <button
                  type="button"
                  className="iconbtn flex-none"
                  aria-label={`Remove runtime tier ${index + 1}`}
                  title="Remove tier"
                  disabled={tiers.length <= 1}
                  onClick={() => setTiers(tiers.filter((_, i) => i !== index))}
                >
                  <Icon name="trash-2" size={14} />
                </button>
              </div>
            ))}
            {tiers.length < MAX_TIERS && (
              <div>
                <Button variant="ghost" size="xs" onClick={() => setTiers([...tiers, { name: '', warmReplicas: 0 }])}>
                  <Icon name="plus" size={14} />
                  Add tier
                </Button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
              <Field label="Max agents">
                <input className={INPUT} value={maxAgents} onChange={(event) => setMaxAgents(event.target.value)} />
              </Field>
              <Field label="CPU">
                <input className={INPUT} value={cpu} onChange={(event) => setCpu(event.target.value)} />
              </Field>
              <Field label="Memory">
                <input className={INPUT} value={memory} onChange={(event) => setMemory(event.target.value)} />
              </Field>
              <Field label="Storage">
                <input className={INPUT} value={storage} onChange={(event) => setStorage(event.target.value)} />
              </Field>
            </div>
            <span className={HELP}>Quotas are Kubernetes quantities, and zero means unlimited.</span>
          </div>

          <div className="flex flex-col gap-2">
            <span className={LABEL}>Sandbox egress</span>
            <div className="pillbar" role="radiogroup" aria-label="Sandbox egress">
              {EGRESS_POLICIES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={egressPolicy === option.value}
                  className={egressPolicy === option.value ? 'pill on' : 'pill'}
                  title={option.detail}
                  onClick={() => setEgressPolicy(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {(error ?? validation) && (
            <div role="alert" className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">
              {error ?? validation}
            </div>
          )}
        </div>
        <div className="modalfoot">
          <Button variant="ghost" onClick={() => (busy ? undefined : onClose())}>
            Cancel
          </Button>
          <Button disabled={busy || Boolean(validation)} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={wide ? 'flex flex-col gap-[6px] desktop:col-span-2' : 'flex flex-col gap-[6px]'}>
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  )
}
