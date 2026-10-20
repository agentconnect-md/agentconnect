'use client'

// Who may use a Computer and how (computer-use.md §4.1, §4.2): granted agents, view or control, approvals and limits.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { ComputerPolicy } from '@agentconnect.md/protocol/computer'
import { setComputerPolicy, type ComputerDto } from '@/lib/api'
import { agentLabel, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { AttachedEmpty, AttachedRow, AttachMenu } from '@/components/console/AttachedList'
import { FieldSelect } from '@/components/console/FieldSelect'
import { AgentIconView } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'

/** The policy fields the form edits; the rest (app lists, quiet hours) are kept as they are. */
export interface PolicyDraft {
  allowedAgents: string[]
  agentMode: ComputerPolicy['agentMode']
  firstInputPerSession: boolean
  launchApp: ComputerPolicy['approvals']['launchApp']
  submitLikeKeys: boolean
  exposeDriverTools: boolean
  leaseIdleSeconds: string
  leaseMaxSeconds: string
  /** Blank keeps the deployment's default. */
  screenshotRetentionDays: string
}

export function draftOf(policy: ComputerPolicy): PolicyDraft {
  return {
    allowedAgents: policy.allowedAgents,
    agentMode: policy.agentMode,
    firstInputPerSession: policy.approvals.firstInputPerSession,
    launchApp: policy.approvals.launchApp,
    submitLikeKeys: policy.approvals.submitLikeKeys,
    exposeDriverTools: policy.exposeDriverTools,
    leaseIdleSeconds: String(policy.leaseIdleSeconds),
    leaseMaxSeconds: String(policy.leaseMaxSeconds),
    screenshotRetentionDays: policy.screenshotRetentionDays === undefined ? '' : String(policy.screenshotRetentionDays)
  }
}

export type PolicyProblem = 'idleRange' | 'maxRange' | 'idleAboveMax' | 'retentionRange'

const wholeIn = (raw: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return n >= min && n <= max ? n : null
}

/** The policy to send, or what is wrong with the draft; mirrors the Control Plane's schema bounds. */
export function policyFromDraft(
  base: ComputerPolicy,
  draft: PolicyDraft
): { policy: ComputerPolicy } | { problem: PolicyProblem } {
  const idle = wholeIn(draft.leaseIdleSeconds, 10, 3600)
  if (idle === null) return { problem: 'idleRange' }
  const max = wholeIn(draft.leaseMaxSeconds, 60, 86_400)
  if (max === null) return { problem: 'maxRange' }
  if (idle > max) return { problem: 'idleAboveMax' }
  const blank = draft.screenshotRetentionDays.trim() === ''
  const retention = blank ? undefined : wholeIn(draft.screenshotRetentionDays, 0, 3650)
  if (retention === null) return { problem: 'retentionRange' }
  const { screenshotRetentionDays: _drop, ...rest } = base
  void _drop
  return {
    policy: {
      ...rest,
      allowedAgents: draft.allowedAgents,
      agentMode: draft.agentMode,
      approvals: {
        firstInputPerSession: draft.firstInputPerSession,
        launchApp: draft.launchApp,
        submitLikeKeys: draft.submitLikeKeys
      },
      exposeDriverTools: draft.exposeDriverTools,
      leaseIdleSeconds: idle,
      leaseMaxSeconds: max,
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
  const { agents } = useConsoleData()
  const saved = useMemo(() => draftOf(computer.policy), [computer.policy])
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
  const result = policyFromDraft(computer.policy, draft)
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

  const byId = new Map(agents.map((a) => [a.id, a]))
  const available = agents.filter((a) => !draft.allowedAgents.includes(a.id))
  const menu = editable ? (
    <AttachMenu
      ariaLabel={t('addAgent')}
      disabled={saving}
      actions={[]}
      groups={[
        {
          heading: t('agents'),
          icon: 'bot',
          emptyLabel: t('noMoreAgents'),
          options: available.map((a) => ({
            key: a.id,
            name: agentLabel(a),
            onPick: () => set('allowedAgents', [...draft.allowedAgents, a.id])
          }))
        }
      ]}
    />
  ) : undefined

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

      <Section title={t('agentsTitle')} hint={t('agentsHint')} action={menu}>
        {draft.allowedAgents.length === 0 ? (
          <AttachedEmpty title={t('noAgents')} hint={t('noAgentsHint')} />
        ) : (
          <div className="overflow-hidden rounded-md border border-(--border-subtle)">
            {draft.allowedAgents.map((id) => (
              <GrantedAgent
                key={id}
                agent={byId.get(id)}
                id={id}
                computer={computer}
                onRemove={
                  editable && !saving
                    ? () =>
                        set(
                          'allowedAgents',
                          draft.allowedAgents.filter((v) => v !== id)
                        )
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </Section>

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
          <Field label={t('launchApp')} detail={t('launchAppHint')}>
            <FieldSelect
              ariaLabel={t('launchApp')}
              value={draft.launchApp}
              disabled={!editable}
              options={[
                { value: 'always', label: t('launchAlways') },
                { value: 'session', label: t('launchSession') },
                { value: 'never-ask', label: t('launchNever') }
              ]}
              onChange={(v) => set('launchApp', v)}
            />
          </Field>
          <ToggleRow
            label={t('firstInput')}
            detail={t('firstInputHint')}
            checked={draft.firstInputPerSession}
            disabled={!editable}
            onChange={(v) => set('firstInputPerSession', v)}
          />
          <ToggleRow
            label={t('submitKeys')}
            detail={t('submitKeysHint')}
            checked={draft.submitLikeKeys}
            disabled={!editable}
            onChange={(v) => set('submitLikeKeys', v)}
          />
        </div>
      </Section>

      <Section title={t('limitsTitle')}>
        <div className="grid grid-cols-1 gap-3 desktop:grid-cols-3">
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
        <div className="mt-3 desktop:max-w-[50%]">
          <ToggleRow
            label={t('driverTools')}
            detail={t('driverToolsHint')}
            checked={draft.exposeDriverTools}
            disabled={!editable}
            onChange={(v) => set('exposeDriverTools', v)}
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

function GrantedAgent({
  agent,
  id,
  computer,
  onRemove
}: {
  agent: Agent | undefined
  id: string
  computer: ComputerDto
  onRemove?: () => void
}) {
  const t = useTranslations('Computers.policy')
  const picked = agent?.computerUse?.enabled === true && agent.computerUse.computers.includes(computer.id)
  // A self-hosted desktop has no isolation from the agents of another member (§4.1).
  const shared = agent !== undefined && agent.createdBy !== '' && agent.createdBy !== computer.ownerUserId
  return (
    <AttachedRow
      mark={
        <span className="flex h-7 w-7 flex-none overflow-hidden rounded-md">
          {agent ? (
            <AgentIconView icon={agent.icon} runtime={agent.runtime} size={28} />
          ) : (
            <Icon name="bot" size={18} />
          )}
        </span>
      }
      name={agent ? agentLabel(agent) : t('unknownAgent')}
      meta={agent ? (picked ? t('agentPicked') : t('agentNotPicked')) : id}
      dimmed={!agent}
      badge={
        shared ? (
          <span
            className="inline-flex flex-none items-center gap-1 rounded-full bg-(--status-paused-soft) px-2 py-[1px] font-sans text-[11px] font-semibold leading-normal text-[#9a6500]"
            title={t('noIsolationHint')}
          >
            <Icon name="triangle-alert" size={12} />
            {t('noIsolation')}
          </span>
        ) : undefined
      }
      onRemove={onRemove}
      removeTitle={t('removeAgent')}
    />
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
