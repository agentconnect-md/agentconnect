'use client'

// The assistant mode switch (assistant-mode.md §1.8, §4.1, §5.1): on/off, where undeliverable work goes, and the limits.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { AssistantModeAdmission, AssistantModePolicy, AssistantModeRefusal } from '@agentconnect.md/protocol'
import { fetchAgentAssistantModeAdmission, memberDisplayName } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { Icon, Button } from '@/components/ui'

const LIMIT_KEYS = [
  'maxConcurrentSubsessions',
  'dailyPatrolBudget',
  'dailySubsessionsPerItem',
  'permissionWaitHours'
] as const
type LimitKey = (typeof LIMIT_KEYS)[number]
const LIMIT_MAX: Record<LimitKey, number> = {
  maxConcurrentSubsessions: 50,
  dailyPatrolBudget: 500,
  dailySubsessionsPerItem: 50,
  permissionWaitHours: 72
}
// Joins an integration id and a channel id in one select value; neither can contain it.
const SEP = '\u0000'

export interface AssistantModeDraft {
  enabled: boolean
  responsibleUserId: string
  fallback: string
  limits: Record<LimitKey, string>
}

export function assistantModeDraft(policy: AssistantModePolicy | undefined): AssistantModeDraft {
  const limits = policy?.limits ?? {}
  return {
    enabled: policy?.enabled ?? false,
    responsibleUserId: policy?.responsibleUserId ?? '',
    fallback: policy?.fallbackConversation
      ? `${policy.fallbackConversation.integrationId}${SEP}${policy.fallbackConversation.channelId}`
      : '',
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k] === undefined ? '' : String(limits[k])])) as Record<
      LimitKey,
      string
    >
  }
}

/** The policy a draft saves, keeping the fields this panel does not edit; a string is the reason it cannot be saved. */
export function assistantModePolicyForDraft(
  draft: AssistantModeDraft,
  persisted: AssistantModePolicy | undefined
): AssistantModePolicy | 'needsTarget' | 'invalidLimit' {
  const limits: NonNullable<AssistantModePolicy['limits']> = {}
  for (const key of LIMIT_KEYS) {
    const raw = draft.limits[key].trim()
    if (!raw) continue
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1 || value > LIMIT_MAX[key]) return 'invalidLimit'
    limits[key] = value
  }
  const [integrationId, channelId] = draft.fallback ? draft.fallback.split(SEP) : []
  const { responsibleUserId: _r, fallbackConversation: _f, limits: _l, ...kept } = persisted ?? { enabled: false }
  const policy: AssistantModePolicy = {
    ...kept,
    enabled: draft.enabled,
    ...(draft.responsibleUserId ? { responsibleUserId: draft.responsibleUserId } : {}),
    ...(integrationId && channelId ? { fallbackConversation: { integrationId, channelId } } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {})
  }
  if (policy.enabled && !policy.responsibleUserId && !policy.fallbackConversation) return 'needsTarget'
  return policy
}

export function AssistantModePanel({
  agentId,
  canEdit,
  assistantMode,
  runtime,
  memoryProvider,
  placement,
  askEveryTime
}: {
  agentId: string
  canEdit: boolean
  assistantMode?: AssistantModePolicy
  /** Admission reads these; a change re-asks the Control Plane. */
  runtime: string
  memoryProvider: string
  placement: string
  /** The effective permission mode asks before every action, so background work would wait on approvals. */
  askEveryTime: boolean
}) {
  const t = useTranslations('Agents.detail.assistantMode')
  const { updateAgent, members, integrations } = useConsoleData()
  const [admission, setAdmission] = useState<AssistantModeAdmission | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => assistantModeDraft(assistantMode))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // An unanswered check leaves the switch available; the Control Plane refuses an edit that fails it.
    void fetchAgentAssistantModeAdmission(agentId)
      .then((a) => {
        if (live) setAdmission(a)
      })
      .catch(() => {
        if (live) setAdmission(null)
      })
    return () => {
      live = false
    }
  }, [agentId, runtime, memoryProvider, placement, assistantMode?.enabled])

  const persistedDraft = assistantModeDraft(assistantMode)
  useEffect(() => {
    if (!open) setDraft(assistantModeDraft(assistantMode))
  }, [assistantMode, open])

  const enabled = assistantMode?.enabled === true
  const refusals = admission && !admission.admitted ? admission.refusals : []
  // A locked switch can still be turned off; it only refuses turning on.
  const locked = refusals.length > 0 && !enabled
  const changed = JSON.stringify(draft) !== JSON.stringify(persistedDraft)
  const result = assistantModePolicyForDraft(draft, assistantMode)
  const blocker = typeof result === 'string' ? result : null
  const editable = canEdit && !saving

  const agentConversations = integrations
    .filter((i) => i.agentId === agentId && i.id)
    .flatMap((i) => i.channels.map((c) => ({ value: `${i.id}${SEP}${c.channelId}`, label: `${i.name} · ${c.name}` })))
  const responsibleName = (() => {
    const member = members.find((m) => m.userId === assistantMode?.responsibleUserId)
    return member ? memberDisplayName(member) : null
  })()
  const fallbackName = agentConversations.find((c) => c.value === persistedDraft.fallback)?.label ?? null

  const refusalText = (refusal: AssistantModeRefusal) => t(`refusals.${refusal}`)

  const close = () => {
    if (saving) return
    setDraft(assistantModeDraft(assistantMode))
    setError(null)
    setOpen(false)
  }

  const save = async () => {
    if (typeof result === 'string' || saving) return
    setSaving(true)
    setError(null)
    try {
      await updateAgent(agentId, { assistantMode: result })
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const summary = enabled
    ? [
        t('on'),
        ...(responsibleName ? [t('responsibleNamed', { name: responsibleName })] : []),
        ...(fallbackName ? [t('fallbackNamed', { name: fallbackName })] : [])
      ].join(' · ')
    : t('off')

  return (
    <section className="card mb-4 overflow-hidden max-desktop:rounded-lg" data-assistant-mode>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-sans text-[13px] font-semibold leading-normal">{t('title')}</span>
            <span className="badge bg-(--surface-active) text-(--text-secondary)">{enabled ? t('on') : t('off')}</span>
            {locked ? (
              <span
                className="inline-flex items-center gap-1 font-sans text-[11px] font-semibold leading-normal text-(--text-tertiary)"
                data-assistant-mode-locked
              >
                <Icon name="lock" size={11} />
                {t('locked')}
              </span>
            ) : null}
          </div>
          <span className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {summary}
          </span>
        </div>
        <Button variant="secondary" size="xs" disabled={saving} onClick={() => (open ? close() : setOpen(true))}>
          {open ? (
            changed ? (
              t('cancel')
            ) : (
              t('close')
            )
          ) : canEdit ? (
            <>
              <Icon name="pencil" size={13} />
              {t('edit')}
            </>
          ) : (
            t('details')
          )}
        </Button>
      </div>

      {locked ? (
        <ul className="m-0 flex list-none flex-col gap-1 border-t border-(--border-subtle) px-4 py-3" role="status">
          {refusals.map((refusal) => (
            <li
              key={refusal}
              data-assistant-mode-refusal={refusal}
              className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)"
            >
              {refusalText(refusal)}
            </li>
          ))}
        </ul>
      ) : null}

      {askEveryTime && (enabled || (open && draft.enabled)) ? (
        <div
          className="border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] font-normal leading-[1.5] text-(--amber-500)"
          data-assistant-mode-ask-warning
        >
          {t('askWarning')}
        </div>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-4 border-t border-(--border-subtle) px-4 py-4">
          <label className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={!editable || (locked && !draft.enabled)}
              onChange={() => {
                setDraft((d) => ({ ...d, enabled: !d.enabled }))
                setError(null)
              }}
            />
            {t('enable')}
          </label>

          <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
            <label className="flex flex-col gap-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
              {t('responsibleUser')}
              <select
                value={draft.responsibleUserId}
                disabled={!editable}
                onChange={(e) => {
                  const responsibleUserId = e.target.value
                  setDraft((d) => ({ ...d, responsibleUserId }))
                  setError(null)
                }}
                className="w-full rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-sans text-[12px] text-(--text-primary)"
              >
                <option value="">{t('none')}</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {memberDisplayName(m)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
              {t('fallbackConversation')}
              <select
                value={draft.fallback}
                disabled={!editable}
                onChange={(e) => {
                  const fallback = e.target.value
                  setDraft((d) => ({ ...d, fallback }))
                  setError(null)
                }}
                className="w-full rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-sans text-[12px] text-(--text-primary)"
              >
                <option value="">{t('none')}</option>
                {agentConversations.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="font-sans text-[13px] font-semibold leading-normal">{t('limits')}</span>
            <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
              {LIMIT_KEYS.map((key) => (
                <label
                  key={key}
                  className="flex flex-col gap-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)"
                >
                  {t(`limit.${key}`)}
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={LIMIT_MAX[key]}
                    step={1}
                    value={draft.limits[key]}
                    placeholder={t('defaultLimit')}
                    disabled={!editable}
                    data-assistant-mode-limit={key}
                    onChange={(e) => {
                      const value = e.target.value
                      setDraft((d) => ({ ...d, limits: { ...d.limits, [key]: value } }))
                      setError(null)
                    }}
                    className="w-full rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-sans text-[12px] text-(--text-primary)"
                  />
                </label>
              ))}
            </div>
          </div>

          {blocker && changed ? (
            <div className="font-sans text-[12px] font-normal leading-normal text-(--red-600)" role="alert">
              {t(`blockers.${blocker}`)}
            </div>
          ) : null}
          {error ? (
            <div className="font-sans text-[12px] font-normal leading-normal text-(--red-600)" role="alert">
              {error}
            </div>
          ) : null}

          {canEdit ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-(--border-subtle) pt-3">
              <Button size="sm" disabled={saving || !changed || Boolean(blocker)} onClick={() => void save()}>
                {saving ? t('saving') : t('save')}
              </Button>
              <Button variant="ghost" size="sm" disabled={saving} onClick={close}>
                {t('cancel')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
