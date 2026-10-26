'use client'

// How agents use a Computer once they have access (computer-use.md §4.1, §4.2): view or control, approvals and limits.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { ComputerPolicy } from '@agentconnect.md/protocol/computer'
import { viewerPeerToPeerAllowed } from '@agentconnect.md/protocol/computer-viewer'
import { setComputerPolicy, type ComputerDto } from '@/lib/api'
import { FieldSelect } from '@/components/console/FieldSelect'
import { Button, Toggle } from '@/components/ui'

/** The policy fields the form edits; the rest (app lists, quiet hours) are kept as they are. */
export interface PolicyDraft {
  agentMode: ComputerPolicy['agentMode']
  firstInputPerSession: boolean
  exposeDriverTools: boolean
  /** The effective setting; it is stored only while it differs from the default. */
  viewerPeerToPeer: boolean
  leaseIdleSeconds: string
  leaseMaxSeconds: string
  leaseWaitSeconds: string
  /** Blank keeps the deployment's default. */
  screenshotRetentionDays: string
}

/** Whose Computer the policy is for, which decides the peer-to-peer default. */
export type PolicyOwner = Pick<ComputerDto, 'ownerUserId' | 'kind'>

const NO_OWNER: PolicyOwner = { ownerUserId: '', kind: 'self-hosted' }

export function draftOf(policy: ComputerPolicy, owner: PolicyOwner = NO_OWNER): PolicyDraft {
  return {
    agentMode: policy.agentMode,
    firstInputPerSession: policy.approvals.firstInputPerSession,
    exposeDriverTools: policy.exposeDriverTools,
    viewerPeerToPeer: viewerPeerToPeerAllowed(policy, owner),
    leaseIdleSeconds: String(policy.leaseIdleSeconds),
    leaseMaxSeconds: String(policy.leaseMaxSeconds),
    leaseWaitSeconds: String(policy.leaseWaitSeconds),
    screenshotRetentionDays: policy.screenshotRetentionDays === undefined ? '' : String(policy.screenshotRetentionDays)
  }
}

export type PolicyProblem = 'idleRange' | 'maxRange' | 'idleAboveMax' | 'waitRange' | 'retentionRange'

const wholeIn = (raw: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return n >= min && n <= max ? n : null
}

/** The policy to send, or what is wrong with the draft; mirrors the Control Plane's schema bounds. */
export function policyFromDraft(
  base: ComputerPolicy,
  draft: PolicyDraft,
  owner: PolicyOwner = NO_OWNER
): { policy: ComputerPolicy } | { problem: PolicyProblem } {
  const idle = wholeIn(draft.leaseIdleSeconds, 10, 3600)
  if (idle === null) return { problem: 'idleRange' }
  const max = wholeIn(draft.leaseMaxSeconds, 60, 86_400)
  if (max === null) return { problem: 'maxRange' }
  if (idle > max) return { problem: 'idleAboveMax' }
  const wait = wholeIn(draft.leaseWaitSeconds, 0, 600)
  if (wait === null) return { problem: 'waitRange' }
  const blank = draft.screenshotRetentionDays.trim() === ''
  const retention = blank ? undefined : wholeIn(draft.screenshotRetentionDays, 0, 3650)
  if (retention === null) return { problem: 'retentionRange' }
  const { screenshotRetentionDays: _drop, viewerPeerToPeer: _p2p, ...rest } = base
  void _drop
  void _p2p
  // Left unset while it matches the default, so sharing the Computer later still turns hole punching off.
  const p2pDefault = draft.viewerPeerToPeer === viewerPeerToPeerAllowed({ ...base, viewerPeerToPeer: undefined }, owner)
  return {
    policy: {
      ...rest,
      agentMode: draft.agentMode,
      approvals: { firstInputPerSession: draft.firstInputPerSession },
      exposeDriverTools: draft.exposeDriverTools,
      ...(p2pDefault ? {} : { viewerPeerToPeer: draft.viewerPeerToPeer }),
      leaseIdleSeconds: idle,
      leaseMaxSeconds: max,
      leaseWaitSeconds: wait,
      ...(retention === undefined ? {} : { screenshotRetentionDays: retention })
    }
  }
}

const sameDraft = (a: PolicyDraft, b: PolicyDraft) => JSON.stringify(a) === JSON.stringify(b)

export function ComputerPolicyCard({
  computer,
  onSaved
}: {
  computer: ComputerDto
  onSaved: (next: ComputerDto) => void
}) {
  const t = useTranslations('Computers.policy')
  const saved = useMemo(
    () => draftOf(computer.policy, { ownerUserId: computer.ownerUserId, kind: computer.kind }),
    [computer.policy, computer.ownerUserId, computer.kind]
  )
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A save elsewhere, or the periodic re-read, replaces an untouched form.
  const [base, setBase] = useState(saved)
  useEffect(() => {
    if (sameDraft(saved, base)) return
    setBase(saved)
    setDraft((current) => (sameDraft(current, base) ? saved : current))
  }, [saved, base])
  const editable = computer.canEditPolicy
  const dirty = !sameDraft(draft, saved)
  const result = policyFromDraft(computer.policy, draft, computer)
  const problem = 'problem' in result ? result.problem : null
  const set = <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  const save = async () => {
    if (!('policy' in result) || saving) return
    setSaving(true)
    setError(null)
    try {
      onSaved(await setComputerPolicy(computer.id, result.policy))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('title')}</span>
        {!editable && (
          <span className="ml-auto font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {t('readOnly')}
          </span>
        )}
      </div>

      <Section title={t('accessTitle')}>
        <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
          <Field label={t('mode')} detail={t('modeHint')}>
            <FieldSelect
              ariaLabel={t('mode')}
              value={draft.agentMode}
              disabled={!editable}
              options={[
                { value: 'control', label: t('modeControl') },
                { value: 'view', label: t('modeView') }
              ]}
              onChange={(v) => set('agentMode', v)}
            />
          </Field>
          <ToggleRow
            label={t('firstInput')}
            detail={t('firstInputHint')}
            checked={draft.firstInputPerSession}
            disabled={!editable}
            onChange={(v) => set('firstInputPerSession', v)}
          />
        </div>
      </Section>

      <Section title={t('limitsTitle')}>
        <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
          <Field label={t('idle')} detail={t('idleHint')}>
            <input
              className="inp"
              inputMode="numeric"
              aria-label={t('idle')}
              disabled={!editable}
              value={draft.leaseIdleSeconds}
              onChange={(e) => set('leaseIdleSeconds', e.target.value)}
            />
          </Field>
          <Field label={t('max')} detail={t('maxHint')}>
            <input
              className="inp"
              inputMode="numeric"
              aria-label={t('max')}
              disabled={!editable}
              value={draft.leaseMaxSeconds}
              onChange={(e) => set('leaseMaxSeconds', e.target.value)}
            />
          </Field>
          <Field label={t('wait')} detail={t('waitHint')}>
            <input
              className="inp"
              inputMode="numeric"
              aria-label={t('wait')}
              disabled={!editable}
              value={draft.leaseWaitSeconds}
              onChange={(e) => set('leaseWaitSeconds', e.target.value)}
            />
          </Field>
          <Field label={t('retention')} detail={t('retentionHint')}>
            <input
              className="inp"
              inputMode="numeric"
              aria-label={t('retention')}
              disabled={!editable}
              placeholder={t('retentionDefault')}
              value={draft.screenshotRetentionDays}
              onChange={(e) => set('screenshotRetentionDays', e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 desktop:grid-cols-2">
          <ToggleRow
            label={t('driverTools')}
            detail={t('driverToolsHint')}
            checked={draft.exposeDriverTools}
            disabled={!editable}
            onChange={(v) => set('exposeDriverTools', v)}
          />
          <ToggleRow
            label={t('peerToPeer')}
            detail={t('peerToPeerHint')}
            checked={draft.viewerPeerToPeer}
            disabled={!editable}
            onChange={(v) => set('viewerPeerToPeer', v)}
          />
        </div>
      </Section>

      {editable && (
        <div className="flex flex-wrap items-center gap-2 border-t border-(--border-subtle) px-4 py-3">
          {(problem || error) && (
            <span role="alert" className="min-w-0 flex-1 font-sans text-[12.5px] leading-[1.5] text-(--status-error)">
              {problem && dirty ? t(`problem.${problem}`) : error}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
              {t('reset')}
            </Button>
            <Button size="sm" disabled={!dirty || saving || problem !== null} onClick={() => void save()}>
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  hint,
  action,
  children
}: {
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-b border-(--border-subtle) px-4 py-4 last:border-b-0">
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 font-sans text-[13px] font-semibold leading-normal">{title}</h3>
          {hint && (
            <p className="m-0 mt-[2px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              {hint}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Field({ label, detail, children }: { label: string; detail: string; children: ReactNode }) {
  return (
    <div className="fld m-0 min-w-0">
      <span className="fldlbl">{label}</span>
      {children}
      <span className="mt-1 block font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
        {detail}
      </span>
    </div>
  )
}

function ToggleRow({
  label,
  detail,
  checked,
  disabled,
  onChange
}: {
  label: string
  detail: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-(--border-subtle) px-3 py-[10px]">
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13px] font-medium leading-normal">{label}</div>
        <div className="mt-[2px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
          {detail}
        </div>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} ariaLabel={label} />
    </div>
  )
}
