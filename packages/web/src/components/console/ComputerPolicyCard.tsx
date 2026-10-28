'use client'

// How agents use a Computer once they have access (computer-use.md §4.1, §4.2, §5.7): view or control, approvals, the command line, limits.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { ComputerAdminPromptMode, ComputerPolicy } from '@agentconnect.md/protocol/computer'
import { viewerPeerToPeerAllowed } from '@agentconnect.md/protocol/computer-viewer'
import {
  COMPUTER_FILE_ROOTS_MAX,
  ComputerFileRoot,
  computerCommandLine,
  type ComputerFilesMode,
  type ComputerShellMode
} from '@agentconnect.md/protocol/computer-command-line'
import { setComputerPolicy, type ComputerDto } from '@/lib/api'
import { FieldSelect } from '@/components/console/FieldSelect'
import { Button, Icon, Toggle } from '@/components/ui'

/** The policy fields the form edits; the rest (app lists, quiet hours) are kept as they are. */
export interface PolicyDraft {
  agentMode: ComputerPolicy['agentMode']
  firstInputPerSession: boolean
  /** Windows only; undefined while the policy names none, so the default applies. */
  adminPrompts?: ComputerAdminPromptMode
  exposeDriverTools: boolean
  /** The effective setting; it is stored only while it differs from the default. */
  viewerPeerToPeer: boolean
  leaseIdleSeconds: string
  leaseMaxSeconds: string
  leaseWaitSeconds: string
  /** Blank keeps the deployment's default. */
  screenshotRetentionDays: string
  /** The effective command-line tier; each is stored only while it differs from the Computer's default. */
  shell: ComputerShellMode
  files: ComputerFilesMode
  /** One path per line; blank means the home directory. */
  fileRoots: string
}

/** Whose Computer the policy is for, which decides the peer-to-peer default. */
export type PolicyOwner = Pick<ComputerDto, 'ownerUserId' | 'kind'>

const NO_OWNER: PolicyOwner = { ownerUserId: '', kind: 'self-hosted' }

export function draftOf(policy: ComputerPolicy, owner: PolicyOwner = NO_OWNER): PolicyDraft {
  return {
    agentMode: policy.agentMode,
    firstInputPerSession: policy.approvals.firstInputPerSession,
    ...(policy.approvals.adminPrompts ? { adminPrompts: policy.approvals.adminPrompts } : {}),
    exposeDriverTools: policy.exposeDriverTools,
    viewerPeerToPeer: viewerPeerToPeerAllowed(policy, owner),
    leaseIdleSeconds: String(policy.leaseIdleSeconds),
    leaseMaxSeconds: String(policy.leaseMaxSeconds),
    leaseWaitSeconds: String(policy.leaseWaitSeconds),
    screenshotRetentionDays: policy.screenshotRetentionDays === undefined ? '' : String(policy.screenshotRetentionDays),
    ...computerCommandLine(policy, owner),
    fileRoots: (policy.fileRoots ?? []).join('\n')
  }
}

export type PolicyProblem = 'idleRange' | 'maxRange' | 'idleAboveMax' | 'waitRange' | 'retentionRange' | 'rootsInvalid'

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
  const roots = draft.fileRoots
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (roots.length > COMPUTER_FILE_ROOTS_MAX || roots.some((root) => !ComputerFileRoot.safeParse(root).success))
    return { problem: 'rootsInvalid' }
  const {
    screenshotRetentionDays: _drop,
    viewerPeerToPeer: _p2p,
    shell: _sh,
    files: _fs,
    fileRoots: _roots,
    ...rest
  } = base
  void _drop
  void _p2p
  void _sh
  void _fs
  void _roots
  // A view Computer offers no shell; a tier matching the default stays unset, so it follows the Computer's kind.
  const tierDefault = computerCommandLine({ agentMode: draft.agentMode }, owner)
  const shell = draft.agentMode === 'view' ? 'off' : draft.shell
  // Left unset while it matches the default, so sharing the Computer later still turns hole punching off.
  const p2pDefault = draft.viewerPeerToPeer === viewerPeerToPeerAllowed({ ...base, viewerPeerToPeer: undefined }, owner)
  return {
    policy: {
      ...rest,
      agentMode: draft.agentMode,
      approvals: {
        firstInputPerSession: draft.firstInputPerSession,
        ...(draft.adminPrompts ? { adminPrompts: draft.adminPrompts } : {})
      },
      exposeDriverTools: draft.exposeDriverTools,
      ...(p2pDefault ? {} : { viewerPeerToPeer: draft.viewerPeerToPeer }),
      leaseIdleSeconds: idle,
      leaseMaxSeconds: max,
      leaseWaitSeconds: wait,
      ...(retention === undefined ? {} : { screenshotRetentionDays: retention }),
      ...(shell === tierDefault.shell ? {} : { shell }),
      ...(draft.files === tierDefault.files ? {} : { files: draft.files }),
      ...(roots.length > 0 ? { fileRoots: roots } : {})
    }
  }
}

const SHELL_OPTIONS: readonly ComputerShellMode[] = ['off', 'ask', 'on']
const FILES_OPTIONS: readonly ComputerFilesMode[] = ['off', 'read', 'read-write']

// What an unset mode means, as protocol's DEFAULT_COMPUTER_ADMIN_PROMPT_MODE says; that module is not bundler-safe here.
export const DEFAULT_ADMIN_PROMPTS: ComputerAdminPromptMode = 'people'

// The order the console and the taskbar menu list them in.
const ADMIN_PROMPT_OPTIONS: readonly ComputerAdminPromptMode[] = ['people', 'agent', 'approve', 'deny']

const sameDraft = (a: PolicyDraft, b: PolicyDraft) => JSON.stringify(a) === JSON.stringify(b)

const changedFields = (a: PolicyDraft, b: PolicyDraft) =>
  (Object.keys(a) as (keyof PolicyDraft)[]).filter((key) => a[key] !== b[key]).length

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
  const changes = changedFields(draft, saved)
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

  const number = (key: NumberField, label: string, hint: string, unit: string, placeholder?: string) => (
    <Row label={label} detail={hint}>
      <span className="inline-flex h-8 items-center overflow-hidden rounded-sm border border-(--border-default) bg-(--surface-card)">
        <input
          className="mono h-full w-[72px] border-0 bg-transparent px-[10px] text-right text-[12.5px] text-(--text-primary) outline-none disabled:opacity-60"
          inputMode="numeric"
          aria-label={label}
          disabled={!editable}
          placeholder={placeholder}
          value={draft[key]}
          onChange={(e) => set(key, e.target.value)}
        />
        <span className="flex h-full items-center border-l border-(--border-subtle) bg-(--surface-sunken) px-[9px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {unit}
        </span>
      </span>
    </Row>
  )

  return (
    <div className="card max-w-[880px] max-desktop:rounded-lg">
      {!editable && (
        <div className="flex items-center gap-2 border-b border-(--border-subtle) bg-(--surface-sunken) px-[18px] py-[10px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="lock" size={13} className="flex-none" />
          {t('readOnly')}
        </div>
      )}

      <Group title={t('accessTitle')} hint={t('accessHint')}>
        <Row label={t('mode')} detail={t('modeHint')}>
          <Segmented
            label={t('mode')}
            value={draft.agentMode}
            disabled={!editable}
            options={[
              { value: 'view', label: t('modeView') },
              { value: 'control', label: t('modeControl') }
            ]}
            onChange={(v) => set('agentMode', v)}
          />
        </Row>
        <Row label={t('firstInput')} detail={t('firstInputHint')}>
          <Toggle
            checked={draft.firstInputPerSession}
            disabled={!editable}
            onChange={(v) => set('firstInputPerSession', v)}
            ariaLabel={t('firstInput')}
          />
        </Row>
        {computer.os === 'windows' && (
          <Row label={t('adminPrompts')} detail={t('adminPromptsHint')}>
            <div className="w-full desktop:w-[220px]">
              <FieldSelect
                ariaLabel={t('adminPrompts')}
                value={draft.adminPrompts ?? DEFAULT_ADMIN_PROMPTS}
                disabled={!editable}
                options={ADMIN_PROMPT_OPTIONS.map((mode) => ({ value: mode, label: t(`adminPrompt.${mode}`) }))}
                onChange={(v) => set('adminPrompts', v)}
              />
            </div>
          </Row>
        )}
      </Group>

      <Group title={t('commandLineTitle')} hint={t('commandLineHint')}>
        <Row label={t('shell')} detail={draft.agentMode === 'view' ? t('shellViewOnly') : t('shellHint')}>
          <Segmented
            label={t('shell')}
            value={draft.agentMode === 'view' ? 'off' : draft.shell}
            disabled={!editable || draft.agentMode === 'view'}
            options={SHELL_OPTIONS.map((mode) => ({ value: mode, label: t(`shellMode.${mode}`) }))}
            onChange={(v) => set('shell', v)}
          />
        </Row>
        <Row label={t('files')} detail={t('filesHint')}>
          <Segmented
            label={t('files')}
            value={draft.files}
            disabled={!editable}
            options={FILES_OPTIONS.map((mode) => ({ value: mode, label: t(`filesMode.${mode}`) }))}
            onChange={(v) => set('files', v)}
          />
        </Row>
        <Row label={t('fileRoots')} detail={t('fileRootsHint')}>
          <textarea
            className="inp mono min-h-[64px] w-full resize-y text-[12.5px] desktop:w-[260px]"
            rows={3}
            spellCheck={false}
            aria-label={t('fileRoots')}
            disabled={!editable || draft.files === 'off'}
            placeholder="~"
            value={draft.fileRoots}
            onChange={(e) => set('fileRoots', e.target.value)}
          />
        </Row>
        {computer.isolation === 'none' && draft.agentMode === 'control' && draft.shell !== 'off' && (
          <p
            role="note"
            className="mx-[18px] my-2 flex items-start gap-2 rounded-md bg-(--status-paused-soft) px-3 py-2 font-sans text-[12px] font-normal leading-[1.5] text-[#9a6500]"
          >
            <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
            <span>{t('shellNoIsolation')}</span>
          </p>
        )}
        {computer.capabilities.exec !== true && (draft.shell !== 'off' || draft.files !== 'off') && (
          <p className="mx-[18px] my-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            {t('commandLineUnsupported')}
          </p>
        )}
      </Group>

      <Group title={t('limitsTitle')}>
        {number('leaseIdleSeconds', t('idle'), t('idleHint'), t('unitSeconds'))}
        {number('leaseMaxSeconds', t('max'), t('maxHint'), t('unitSeconds'))}
        {number('leaseWaitSeconds', t('wait'), t('waitHint'), t('unitSeconds'))}
        {number('screenshotRetentionDays', t('retention'), t('retentionHint'), t('unitDays'), t('retentionDefault'))}
      </Group>

      <Group title={t('advancedTitle')}>
        <Row label={t('driverTools')} detail={t('driverToolsHint')}>
          <Toggle
            checked={draft.exposeDriverTools}
            disabled={!editable}
            onChange={(v) => set('exposeDriverTools', v)}
            ariaLabel={t('driverTools')}
          />
        </Row>
        <Row label={t('peerToPeer')} detail={t('peerToPeerHint')}>
          <Toggle
            checked={draft.viewerPeerToPeer}
            disabled={!editable}
            onChange={(v) => set('viewerPeerToPeer', v)}
            ariaLabel={t('peerToPeer')}
          />
        </Row>
      </Group>

      {editable && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-[10px] rounded-b-[inherit] border-t border-(--border-subtle) bg-(--surface-card) px-[18px] py-3">
          {(problem && dirty) || error ? (
            <span role="alert" className="min-w-0 flex-1 font-sans text-[12.5px] leading-[1.5] text-(--status-error)">
              {problem && dirty ? t(`problem.${problem}`) : error}
            </span>
          ) : (
            <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {dirty ? t('unsaved', { count: changes }) : t('appliesToAll')}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" size="sm" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
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

type NumberField = 'leaseIdleSeconds' | 'leaseMaxSeconds' | 'leaseWaitSeconds' | 'screenshotRetentionDays'

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-(--border-subtle) pb-[6px] first:border-t-0">
      <div className="px-[18px] pt-4 pb-[6px]">
        <h3 className="m-0 font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">{title}</h3>
        {hint && (
          <p className="m-0 mt-[3px] max-w-[620px] font-sans text-[12px] font-normal leading-[1.5] text-pretty text-(--text-tertiary)">
            {hint}
          </p>
        )}
      </div>
      {children}
    </section>
  )
}

function Row({ label, detail, children }: { label: string; detail: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[10px] px-[18px] py-3 desktop:flex-row desktop:items-start desktop:gap-6">
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13px] font-medium leading-normal text-(--text-primary)">{label}</div>
        <div className="mt-[2px] max-w-[480px] font-sans text-[12px] font-normal leading-[1.5] text-pretty text-(--text-tertiary)">
          {detail}
        </div>
      </div>
      <div className="flex flex-none desktop:min-w-[220px] desktop:justify-end">{children}</div>
    </div>
  )
}

function Segmented<V extends string>({
  label,
  value,
  options,
  disabled,
  onChange
}: {
  label: string
  value: V
  options: readonly { value: V; label: string }[]
  disabled: boolean
  onChange: (next: V) => void
}) {
  return (
    <div className="pillbar max-w-full flex-wrap" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          className={
            value === option.value
              ? 'pill on whitespace-nowrap disabled:cursor-default disabled:opacity-60'
              : 'pill whitespace-nowrap disabled:cursor-default disabled:opacity-60'
          }
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
