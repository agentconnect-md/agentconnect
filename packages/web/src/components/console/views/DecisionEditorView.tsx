'use client'

// The reusable question and standalone preview; consumers own their conditions.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { LoadingState } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { groupPlacementValue, poolLabel, POOL_PLACEMENT } from '@/lib/data'
import { useDecisionProviders, useDecisionsPrototype } from '@/lib/decisions/provider'
import { DaemonSelect, type DaemonSelectOption } from '@/components/console/DaemonSelect'
import { VisibilityField, sameSharing, type SharingValue } from '@/components/console/VisibilityField'
import { DecisionsNotOffered } from '@/components/console/decisions/DecisionsNotOffered'
import { featureFlagEnabled } from '@/lib/feature-flags'
import {
  DecisionDraft,
  DECISION_PROVIDER_PROFILES,
  decisionConditionNeedsReview,
  type DecisionQuestion,
  type DecisionValidationIssue
} from '@agentconnect.md/protocol/decision'
import type {
  DecisionPreviewTarget,
  DecisionProviderOption,
  DecisionUsage
} from '@agentconnect.md/protocol/decision-api'

type QuestionType = DecisionQuestion['type']
/** One editable criterion. Choice keys are free text; boolean keys and score levels are positional. */
interface DraftCriterion {
  key: string
  description: string
}
interface Draft {
  name: string
  providerId: string
  model: string
  type: QuestionType
  instructions: string
  criteria: DraftCriterion[]
  visibility: 'org' | 'restricted'
  sharedWith: string[]
}

const CHOICE_GRID =
  'grid grid-cols-[150px_minmax(0,1fr)_28px] items-start gap-2 max-desktop:grid-cols-[minmax(0,1fr)_28px]'
const SCORE_GRID = 'grid grid-cols-[34px_minmax(0,1fr)_28px_28px_28px] items-center gap-2'

function criteriaForType(type: QuestionType): DraftCriterion[] {
  if (type === 'boolean')
    return [
      { key: 'true', description: '' },
      { key: 'false', description: '' }
    ]
  if (type === 'score') return [0, 1, 2, 3].map((level) => ({ key: String(level), description: '' }))
  return [
    { key: '', description: '' },
    { key: '', description: '' }
  ]
}

/** Re-key score levels from their position, so a move or removal cannot leave a gap. */
function reindex(criteria: DraftCriterion[], type: QuestionType): DraftCriterion[] {
  if (type !== 'score') return criteria
  return criteria.map((criterion, index) => ({ key: String(index), description: criterion.description }))
}

function draftFrom(definition: {
  name: string
  providerId: string
  model: string
  question: DecisionQuestion
  visibility: 'org' | 'restricted'
  sharedWith: string[]
}): Draft {
  const question = definition.question
  const criteria =
    question.type === 'choice'
      ? Object.entries(question.criteria).map(([key, description]) => ({ key, description }))
      : question.type === 'boolean'
        ? [
            { key: 'true', description: question.criteria.true },
            { key: 'false', description: question.criteria.false }
          ]
        : question.criteria.map((description, index) => ({ key: String(index), description }))
  return {
    name: definition.name,
    providerId: definition.providerId,
    model: definition.model,
    type: question.type,
    instructions: question.instructions,
    criteria,
    visibility: definition.visibility,
    sharedWith: definition.sharedWith
  }
}

function questionFrom(draft: Draft): DecisionQuestion {
  if (draft.type === 'choice') {
    return {
      type: 'choice',
      instructions: draft.instructions.trim(),
      criteria: Object.fromEntries(
        draft.criteria.map((criterion) => [criterion.key.trim(), criterion.description.trim()])
      )
    }
  }
  if (draft.type === 'boolean') {
    return {
      type: 'boolean',
      instructions: draft.instructions.trim(),
      criteria: {
        true: draft.criteria[0]?.description.trim() ?? '',
        false: draft.criteria[1]?.description.trim() ?? ''
      }
    }
  }
  return {
    type: 'score',
    instructions: draft.instructions.trim(),
    criteria: draft.criteria.map((criterion) => criterion.description.trim())
  }
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="fld">
      <span className="fldlbl">{label}</span>
      {children}
      {hint && <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">{hint}</span>}
    </label>
  )
}

export default function DecisionEditorView() {
  const { activeOrg } = useOrgs()
  const { id } = useParams<{ id?: string }>()
  return <DecisionEditor key={`${activeOrg?.id ?? ''}:${id ?? 'new'}`} />
}

function DecisionEditor() {
  const t = useTranslations('Decisions')
  const placementT = useTranslations('Agents.dialog.daemonSelect')
  const { orgPath, myRole } = useOrgs()
  const { memberSets } = useConsoleData()
  const router = useRouter()
  const search = useSearchParams()
  const { id } = useParams<{ id?: string }>()
  // `returnTo` is attacker-controllable: only a console-relative target may be followed.
  const requested = search.get('returnTo')
  const returnTo = requested?.startsWith('/') && !requested.startsWith('//') ? requested : null
  const { decisions, loading, error, api, reload, gateUsages, markGatesForReview } = useDecisionsPrototype()
  const { providers, error: providerError } = useDecisionProviders()
  const definition = id ? decisions.find((entry) => entry.id === id) : undefined

  const [selectedTargetValue, setSelectedTargetValue] = useState<string | null>(null)
  const editable = myRole !== 'viewer' && (!id || (!!definition && definition.canEdit !== false))
  const [draft, setDraft] = useState<Draft | null>(null)
  const initialSharing = useRef<SharingValue | null>(null)
  const [usages, setUsages] = useState<DecisionUsage[]>([])
  const [issues, setIssues] = useState<DecisionValidationIssue[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState<Array<{ sender: string; text: string }>>([])
  const [current, setCurrent] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{
    signature: string
    badge: string
    rows: Array<{ label: string; value: string }>
    model: string
    context: number
    unavailable: boolean
    error?: string
    sample?: string
  } | null>(null)

  const firstProvider = providers[0] ?? DECISION_PROVIDER_PROFILES[0]
  // Shipped models let users save a definition even when no daemon is available.
  useEffect(() => {
    if (draft) return
    if (id) {
      if (definition) {
        initialSharing.current = { visibility: definition.visibility, sharedWith: [...definition.sharedWith] }
        setDraft(draftFrom(definition))
      }
      return
    }
    if (!firstProvider) return
    setDraft({
      name: '',
      providerId: firstProvider.id,
      model: firstProvider.models[0]?.id ?? '',
      type: 'choice',
      instructions: '',
      criteria: criteriaForType('choice'),
      visibility: 'org',
      sharedWith: []
    })
  }, [draft, id, definition, firstProvider])

  useEffect(() => {
    if (!id) return
    let live = true
    void api.getDecision(id).then(
      (detail) => live && setUsages(detail.usages),
      () => live && setUsages([])
    )
    return () => {
      live = false
    }
  }, [api, id])

  // The decision keeps its provider, so the model list comes from the provider that owns it.
  const candidates = providers.filter((entry) => entry.id === draft?.providerId)
  const supportsDraft = (entry: DecisionProviderOption) =>
    !!draft && entry.models.some((model) => model.id === draft.model && model.questionTypes.includes(draft.type))
  const ready = (entry: DecisionProviderOption) => entry.readiness.status === 'ready' && supportsDraft(entry)
  const providerFor = (members: DecisionProviderOption[]) => members.find(ready) ?? members[0]
  const pool = candidates.filter((entry) => entry.pool)
  const targets: Array<DaemonSelectOption & { target: DecisionPreviewTarget; provider?: DecisionProviderOption }> = [
    ...(featureFlagEnabled('daemon-pool') && pool.length
      ? [
          {
            value: POOL_PLACEMENT,
            label: poolLabel(),
            kind: 'pool' as const,
            target: { kind: 'pool' as const },
            provider: providerFor(pool)
          }
        ]
      : []),
    ...(featureFlagEnabled('daemon-groups') ? memberSets : []).map((group) => ({
      value: groupPlacementValue(group.setId),
      label: group.name,
      kind: 'group' as const,
      target: { kind: 'set' as const, setId: group.setId },
      meta: placementT('groupMeta', { count: group.memberDaemonIds.length }),
      provider: providerFor(candidates.filter((entry) => !entry.pool && entry.memberSetId === group.setId))
    })),
    ...candidates
      .filter((entry) => !entry.pool)
      .map((entry) => ({
        value: entry.daemonId,
        label: entry.daemonName ?? entry.daemonId,
        kind: 'daemon' as const,
        target: { kind: 'daemon' as const, daemonId: entry.daemonId },
        provider: entry
      }))
  ]
  const selectedTarget =
    selectedTargetValue === null
      ? (targets.find((entry) => entry.provider && ready(entry.provider)) ?? targets[0])
      : targets.find((entry) => entry.value === selectedTargetValue)
  const provider = selectedTarget?.provider
  const targetOptions = targets.map((entry) => ({
    ...entry,
    disabled: !entry.provider || !ready(entry.provider),
    title: !entry.provider
      ? t('try.noDaemon')
      : !ready(entry.provider)
        ? t(`try.states.${supportsDraft(entry.provider) ? entry.provider.readiness.status : 'unsupported'}`)
        : undefined
  }))
  const profile = provider ?? DECISION_PROVIDER_PROFILES.find((entry) => entry.id === draft?.providerId)
  const previewReady = editable && !providerError && !!provider && ready(provider)
  const models = useMemo(
    () => (profile?.models ?? []).filter((model) => model.questionTypes.includes(draft?.type ?? 'choice')),
    [profile, draft?.type]
  )
  const signature = JSON.stringify({ draft, history, current, target: selectedTarget?.target ?? selectedTargetValue })
  const stale = !!result && result.signature !== signature
  // Conversations gated on this decision: an edit can strand their saved conditions.
  const gated = id && definition ? gateUsages(id) : []
  const brokenGates =
    draft && definition
      ? gated.filter((usage) => decisionConditionNeedsReview(definition.question, questionFrom(draft), usage.when))
      : []

  if (!featureFlagEnabled('decisions')) return <DecisionsNotOffered />

  if (!draft) {
    return (
      <div className="wrap max-desktop:p-4">
        {loading ? (
          <LoadingState size={22} padding={30} />
        ) : (
          <div className="card px-5 py-10 text-center font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
            {error ?? t('notFound')}
          </div>
        )}
      </div>
    )
  }

  const patch = (values: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...values } : current))
  const setType = (type: QuestionType) => {
    if (type === draft.type) return
    const eligible = (profile?.models ?? []).find((model) => model.questionTypes.includes(type))
    patch({ type, criteria: criteriaForType(type), ...(eligible ? { model: eligible.id } : {}) })
    setIssues([])
  }
  const setCriterion = (index: number, values: Partial<DraftCriterion>) =>
    patch({ criteria: draft.criteria.map((criterion, at) => (at === index ? { ...criterion, ...values } : criterion)) })
  const removeCriterion = (index: number) =>
    patch({
      criteria: reindex(
        draft.criteria.filter((_, at) => at !== index),
        draft.type
      )
    })
  const moveCriterion = (index: number, delta: number) => {
    const next = [...draft.criteria]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const held = next[target]!
    next[target] = next[index]!
    next[index] = held
    patch({ criteria: reindex(next, draft.type) })
  }

  const validate = (): DecisionValidationIssue[] => {
    const found: DecisionValidationIssue[] = []
    if (!draft.name.trim()) found.push({ path: ['name'], message: t('errors.name') })
    if (!draft.instructions.trim())
      found.push({ path: ['question', 'instructions'], message: t('errors.instructions') })
    if (draft.type === 'choice') {
      const keys = draft.criteria.map((criterion) => criterion.key.trim()).filter(Boolean)
      if (keys.length < 2) found.push({ path: ['question', 'criteria'], message: t('errors.choiceCriteria') })
      else if (new Set(keys).size !== keys.length)
        found.push({ path: ['question', 'criteria'], message: t('errors.duplicateKeys') })
      else if (draft.criteria.some((criterion) => !criterion.description.trim()))
        found.push({ path: ['question', 'criteria'], message: t('errors.emptyCriterion') })
    } else if (draft.type === 'boolean') {
      if (draft.criteria.some((criterion) => !criterion.description.trim()))
        found.push({ path: ['question', 'criteria'], message: t('errors.emptyCriterion') })
    } else {
      if (draft.criteria.length < 2 || draft.criteria.length > 10)
        found.push({ path: ['question', 'criteria'], message: t('errors.scoreLevels') })
      else if (draft.criteria.some((criterion) => !criterion.description.trim()))
        found.push({ path: ['question', 'criteria'], message: t('errors.emptyCriterion') })
    }
    return found
  }

  // The name is only needed to save: a preview must run on the question alone.
  const previewIssues = validate().filter((issue) => issue.path[0] === 'question')

  const run = async () => {
    if (!selectedTarget || !previewReady || running || previewIssues.length) return
    setRunning(true)
    setResult(null)
    try {
      const preview = await api.preview({
        decision: {
          name: draft.name.trim() || t('untitled'),
          providerId: draft.providerId,
          model: draft.model,
          question: questionFrom(draft),
          visibility: draft.visibility,
          sharedWith: draft.sharedWith
        },
        target: selectedTarget.target,
        state: {
          history: history.map((message) => ({ sender: message.sender, text: message.text })),
          currentMessage: { text: current }
        },
        consumer: { type: 'none' }
      })
      const evaluation = preview.evaluation
      if (!evaluation || evaluation.status !== 'answered') {
        setResult({
          signature,
          badge: t('try.unavailableBadge'),
          rows: [],
          model: draft.model,
          context: history.length,
          unavailable: true,
          sample: current,
          error: evaluation?.status === 'unavailable' ? t(`try.failures.${evaluation.reason}`) : undefined
        })
        return
      }
      const answer = evaluation.answer
      const rows =
        answer.type === 'score'
          ? [{ label: 'score', value: String(answer.value) }]
          : answer.type === 'choice'
            ? Object.entries(answer.probabilities).map(([key, value]) => ({
                label: key,
                value: `${Math.round(value * 100)}%`
              }))
            : [
                { label: t('condition.yes'), value: `${Math.round(answer.probability * 100)}%` },
                { label: t('condition.no'), value: `${Math.round((1 - answer.probability) * 100)}%` }
              ]
      const badge =
        answer.type === 'boolean' ? (answer.value ? t('condition.yes') : t('condition.no')) : String(answer.value)
      setResult({
        signature,
        badge,
        rows,
        model: evaluation.model,
        context: history.length,
        unavailable: false,
        sample: current
      })
    } catch (cause) {
      setResult({
        signature,
        badge: t('try.unavailableBadge'),
        rows: [],
        model: draft.model,
        context: history.length,
        unavailable: true,
        sample: current,
        error: cause instanceof Error ? cause.message : undefined
      })
    } finally {
      setRunning(false)
    }
  }

  const save = async () => {
    if (!editable) return
    const found = validate()
    setIssues(found)
    setSaveError(null)
    if (found.length) return
    const input = {
      name: draft.name.trim(),
      providerId: draft.providerId,
      model: draft.model,
      question: questionFrom(draft),
      visibility: draft.visibility,
      sharedWith: draft.sharedWith
    }
    const parsed = DecisionDraft.safeParse(input)
    if (!parsed.success) {
      setSaveError(parsed.error.issues[0]?.message ?? t('errors.unknown'))
      return
    }
    setSaving(true)
    try {
      if (id) {
        const { visibility, sharedWith, ...question } = parsed.data
        await api.updateDecision(
          id,
          initialSharing.current && sameSharing(draft, initialSharing.current)
            ? question
            : { ...question, visibility, sharedWith }
        )
        // The mock service has no bindings, so the invalidation is recorded here (§6.1).
        if (definition) markGatesForReview(id, definition.question, parsed.data.question)
      } else await api.createDecision(parsed.data)
      await reload()
      router.push(returnTo ?? orgPath('/decisions'))
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const issueFor = (path: string) => issues.find((issue) => issue.path.join('.') === path)?.message
  const criteriaIssue = issueFor('question.criteria')

  return (
    <div className="wrap max-desktop:p-4">
      <div className="mb-4 flex min-h-[34px] flex-wrap items-center gap-3">
        <p className="psub mt-0 min-w-0 flex-1">
          {id ? t('editing', { name: draft.name || t('untitled') }) : t('newDecision')}
        </p>
        <Button variant="secondary" size="sm" onClick={() => router.push(returnTo ?? orgPath('/decisions'))}>
          {t('cancel')}
        </Button>
        <Button variant="primary" size="sm" disabled={saving || !editable} onClick={() => void save()}>
          {id ? t('save') : t('create')}
        </Button>
      </div>

      <div className="grid grid-cols-1 items-start gap-[18px] desktop:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-4">
          {saveError && (
            <div className="flex items-start gap-[9px] rounded-md border border-(--red-500) bg-(--status-error-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]">
              <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
              <span>{saveError}</span>
            </div>
          )}

          {brokenGates.length > 0 && (
            <div className="flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]">
              <Icon name="triangle-alert" size={14} className="mt-[2px] flex-none" />
              <span>{t('breaksChannels', { names: brokenGates.map((usage) => usage.channelName).join(', ') })}</span>
            </div>
          )}

          <fieldset disabled={!editable || saving} className="card min-w-0 flex flex-col gap-[15px] p-4">
            <div className="grid grid-cols-1 gap-3 desktop:grid-cols-3">
              <Field label={t('name')}>
                <input
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder={t('namePlaceholder')}
                  className="inp min-h-9"
                />
                {issueFor('name') && <IssueLine>{issueFor('name')}</IssueLine>}
              </Field>
              <Field label={t('provider')}>
                <span className="inp min-h-9 items-center">
                  <span className="truncate font-sans text-[13px] font-normal leading-normal">
                    {profile?.name ?? draft.providerId}
                  </span>
                </span>
              </Field>
              <Field label={t('model')}>
                <AnchoredFlyout
                  ariaLabel={t('model')}
                  align="start"
                  width={280}
                  estimatedHeight={10 + models.length * 34}
                  triggerClassName="inline-flex w-full"
                  trigger={({ open, menuId, toggle }) => (
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={open}
                      aria-controls={open ? menuId : undefined}
                      onClick={toggle}
                      className="inp min-h-9 w-full cursor-pointer justify-between gap-2"
                    >
                      <span className="mono truncate text-[12.5px]">
                        {models.find((model) => model.id === draft.model)?.label ?? draft.model}
                      </span>
                      <Icon name="chevron-down" size={15} color="var(--text-tertiary)" className="flex-none" />
                    </button>
                  )}
                >
                  {({ close }) => (
                    <>
                      {models.map((model) => (
                        <button
                          key={model.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={model.id === draft.model}
                          className={model.id === draft.model ? 'fopt on' : 'fopt'}
                          onClick={() => {
                            close(true)
                            patch({ model: model.id })
                          }}
                        >
                          <span className="mono text-[12.5px]">{model.label}</span>
                        </button>
                      ))}
                    </>
                  )}
                </AnchoredFlyout>
              </Field>
            </div>

            <Field
              label={t('questionType')}
              hint={
                draft.type === 'choice'
                  ? t('typeHint.choice')
                  : draft.type === 'boolean'
                    ? t('typeHint.boolean')
                    : t('typeHint.score')
              }
            >
              <span className="pillbar self-start">
                {(['choice', 'boolean', 'score'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={type === draft.type ? 'pill on' : 'pill'}
                    aria-pressed={type === draft.type}
                    onClick={() => setType(type)}
                  >
                    {t(`types.${type}`)}
                  </button>
                ))}
              </span>
            </Field>

            <Field
              label={t('instructions')}
              hint={t.rich('instructionsHelp', { code: (chunks) => <span className="mono">{chunks}</span> })}
            >
              <textarea
                value={draft.instructions}
                rows={3}
                onChange={(event) => patch({ instructions: event.target.value })}
                placeholder={t('instructionsPlaceholder')}
                className="inp block w-full resize-y leading-[1.55]"
              />
              {issueFor('question.instructions') && <IssueLine>{issueFor('question.instructions')}</IssueLine>}
            </Field>
            <VisibilityField value={draft} onChange={(sharing) => patch(sharing)} disabled={!editable || saving} />
          </fieldset>

          <fieldset disabled={!editable || saving} className="card min-w-0">
            <div className="cardhead justify-between">
              <span className="cardtitle">{t('criteria')}</span>
              <span className="font-mono text-[11px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                {t(`criteriaHint.${draft.type}`)}
              </span>
            </div>
            <div className="flex flex-col gap-[9px] px-4 py-[14px]">
              {draft.type === 'choice' &&
                draft.criteria.map((criterion, index) => (
                  <div key={index} className={CHOICE_GRID}>
                    <input
                      value={criterion.key}
                      onChange={(event) => setCriterion(index, { key: event.target.value })}
                      placeholder={t('keyPlaceholder')}
                      aria-label={t('keyPlaceholder')}
                      className="inp mn min-h-9"
                    />
                    <input
                      value={criterion.description}
                      onChange={(event) => setCriterion(index, { description: event.target.value })}
                      placeholder={t('answerDescriptionPlaceholder')}
                      aria-label={t('answerDescriptionPlaceholder')}
                      className="inp min-h-9 max-desktop:col-start-1 max-desktop:row-start-2"
                    />
                    <button
                      type="button"
                      title={t('removeAnswer')}
                      aria-label={t('removeAnswer')}
                      onClick={() => removeCriterion(index)}
                      className="flex h-7 w-7 items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}

              {draft.type === 'boolean' &&
                draft.criteria.map((criterion, index) => (
                  <div key={criterion.key} className={CHOICE_GRID}>
                    <span className="inp mn min-h-9 items-center bg-(--surface-sunken)">
                      {index === 0 ? t('condition.yes') : t('condition.no')}
                    </span>
                    <input
                      value={criterion.description}
                      onChange={(event) => setCriterion(index, { description: event.target.value })}
                      placeholder={t('booleanDescriptionPlaceholder')}
                      aria-label={t('booleanDescriptionPlaceholder')}
                      className="inp min-h-9 max-desktop:col-start-1 max-desktop:row-start-2"
                    />
                    <span />
                  </div>
                ))}

              {draft.type === 'score' &&
                draft.criteria.map((criterion, index) => (
                  <div key={criterion.key} className={SCORE_GRID}>
                    <span className="mono text-center text-[13px] font-semibold text-(--brand)">{index}</span>
                    <input
                      value={criterion.description}
                      onChange={(event) => setCriterion(index, { description: event.target.value })}
                      placeholder={t('levelDescriptionPlaceholder')}
                      aria-label={t('levelDescriptionPlaceholder')}
                      className="inp min-h-9"
                    />
                    <button
                      type="button"
                      title={t('moveUp')}
                      aria-label={t('moveUp')}
                      disabled={index === 0}
                      onClick={() => moveCriterion(index, -1)}
                      className="flex h-7 w-7 items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:opacity-35"
                    >
                      <Icon name="chevron-up" size={15} />
                    </button>
                    <button
                      type="button"
                      title={t('moveDown')}
                      aria-label={t('moveDown')}
                      disabled={index === draft.criteria.length - 1}
                      onClick={() => moveCriterion(index, 1)}
                      className="flex h-7 w-7 items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:opacity-35"
                    >
                      <Icon name="chevron-down" size={15} />
                    </button>
                    <button
                      type="button"
                      title={t('removeLevel')}
                      aria-label={t('removeLevel')}
                      onClick={() => removeCriterion(index)}
                      className="flex h-7 w-7 items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}

              {draft.type !== 'boolean' && (
                <button
                  type="button"
                  className="lnk self-start gap-[6px] text-[12.5px] font-medium"
                  onClick={() =>
                    patch({
                      criteria: reindex(
                        [
                          ...draft.criteria,
                          { key: draft.type === 'score' ? String(draft.criteria.length) : '', description: '' }
                        ],
                        draft.type
                      )
                    })
                  }
                >
                  <Icon name="plus" size={14} />
                  {draft.type === 'score' ? t('addLevel') : t('addAnswer')}
                </button>
              )}

              {draft.type === 'choice' && (
                <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                  {t('criteriaHelp')}
                </span>
              )}
              {criteriaIssue && <IssueLine>{criteriaIssue}</IssueLine>}
            </div>
          </fieldset>

          <div className="card">
            <div className="cardhead justify-between">
              <span className="cardtitle">{t('usedBy.title')}</span>
              <span className="font-mono text-[11px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                {t('places', { count: usages.length + gated.length })}
              </span>
            </div>
            <div className="py-[6px]">
              {gated.map((usage) => {
                const review = usage.needsReview
                return (
                  <div key={`gate:${usage.channelId}`} className="flex flex-wrap items-center gap-[10px] px-4 py-[9px]">
                    <Icon name="hash" size={13} color="var(--text-tertiary)" />
                    <span className="mono min-w-[120px] flex-1 text-[12.5px]">{usage.channelName}</span>
                    <span className="badge bg-(--surface-active) text-(--text-secondary)">{t('usedBy.kind.gate')}</span>
                    <span
                      className={`badge ${
                        review
                          ? 'bg-(--status-paused-soft) text-(--amber-500)'
                          : 'bg-(--status-online-soft) text-(--status-online)'
                      }`}
                    >
                      {review ? t('usedBy.needsReview') : t('usedBy.ok')}
                    </span>
                  </div>
                )
              })}
              {usages.length + gated.length === 0 ? (
                <div className="px-4 py-[10px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                  {t('notUsed')}
                </div>
              ) : (
                usages.map((usage) => (
                  <div
                    key={`${usage.kind}:${usage.id}`}
                    className="flex flex-wrap items-center gap-[10px] px-4 py-[9px]"
                  >
                    <Icon name={usage.kind === 'gate' ? 'hash' : 'git-branch'} size={13} color="var(--text-tertiary)" />
                    <span className="mono min-w-[120px] flex-1 text-[12.5px]">{usage.label}</span>
                    <span className="badge bg-(--surface-active) text-(--text-secondary)">
                      {t(`usedBy.kind.${usage.kind}`)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4 desktop:sticky desktop:top-4">
          <div className="card">
            <div className="cardhead justify-between">
              <span className="cardtitle">{t('try.title')}</span>
              <button
                type="button"
                className="lnk gap-[6px] text-[12px] font-medium"
                onClick={() => {
                  const demo = EXAMPLES[draft.type]
                  setHistory(demo.history.map((message) => ({ ...message })))
                  setCurrent(demo.current)
                  setResult(null)
                }}
              >
                {t('try.loadExample')}
              </button>
            </div>
            <div className="flex flex-col gap-[11px] px-[15px] py-[13px]">
              <div className="fld">
                <span className="fldlbl">{placementT('runsOn')}</span>
                {providerError && <IssueLine>{providerError}</IssueLine>}
                <DaemonSelect
                  ariaLabel={placementT('runsOn')}
                  placeholder={t('try.noDaemon')}
                  value={selectedTargetValue ?? selectedTarget?.value ?? ''}
                  options={targetOptions}
                  onChange={setSelectedTargetValue}
                />
                {provider && (
                  <span className="text-[12px] text-(--text-secondary)">
                    {t(`try.states.${supportsDraft(provider) ? provider.readiness.status : 'unsupported'}`)}
                    {provider.source && ` · ${t(`try.sources.${provider.source}`)}`}
                  </span>
                )}
              </div>
              <div className="fld">
                <span className="fldlbl">{t('try.history')}</span>
                {history.map((message, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[104px_minmax(0,1fr)_26px] items-start gap-[7px] max-desktop:grid-cols-[minmax(0,1fr)_26px]"
                  >
                    <input
                      value={message.sender}
                      onChange={(event) =>
                        setHistory((rows) =>
                          rows.map((row, at) => (at === index ? { ...row, sender: event.target.value } : row))
                        )
                      }
                      placeholder={t('try.senderPlaceholder')}
                      aria-label={t('try.senderPlaceholder')}
                      className="inp mn h-8 min-h-0"
                    />
                    <input
                      value={message.text}
                      onChange={(event) =>
                        setHistory((rows) =>
                          rows.map((row, at) => (at === index ? { ...row, text: event.target.value } : row))
                        )
                      }
                      placeholder={t('try.messagePlaceholder')}
                      aria-label={t('try.messagePlaceholder')}
                      className="inp h-8 min-h-0 max-desktop:col-start-1 max-desktop:row-start-2"
                    />
                    <button
                      type="button"
                      title={t('try.removeMessage')}
                      aria-label={t('try.removeMessage')}
                      onClick={() => setHistory((rows) => rows.filter((_, at) => at !== index))}
                      className="flex h-8 w-[26px] items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="lnk self-start gap-[6px] text-[12.5px] font-medium"
                  onClick={() => setHistory((rows) => [...rows, { sender: '@user', text: '' }])}
                >
                  <Icon name="plus" size={14} />
                  {t('try.addMessage')}
                </button>
              </div>
              <div className="fld">
                <span className="fldlbl">{t('try.current')}</span>
                <textarea
                  value={current}
                  rows={2}
                  onChange={(event) => setCurrent(event.target.value)}
                  placeholder={t('try.currentPlaceholder')}
                  className="inp block w-full resize-y"
                />
              </div>
              <div className="flex flex-wrap items-center gap-[9px]">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={running || !previewReady || previewIssues.length > 0}
                  onClick={() => void run()}
                >
                  <Icon name="play" size={14} />
                  {running ? t('try.running') : t('try.run')}
                </Button>
              </div>
              {previewIssues[0] && <IssueLine>{previewIssues[0].message}</IssueLine>}
              <div className="flex gap-2 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
                <Icon name="shield" size={13} className="mt-[2px] flex-none" />
                <span>{t('try.note')}</span>
              </div>
            </div>

            {result && (
              <div className="flex flex-col gap-[9px] rounded-b-[10px] border-t border-(--border-subtle) bg-(--surface-app) px-[15px] py-[13px]">
                {stale && (
                  <div className="flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]">
                    <Icon name="refresh-cw" size={14} className="mt-[2px] flex-none" />
                    <span>{t('try.stale')}</span>
                  </div>
                )}
                <div className="overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card)">
                  <div className="flex items-center gap-[9px] px-[12px] py-[10px]">
                    <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-[1.45]">
                      {result.sample || t('try.currentPlaceholder')}
                    </span>
                    <span
                      className={`badge flex-none ${
                        result.unavailable
                          ? 'bg-(--status-error-soft) text-(--red-600)'
                          : 'bg-(--surface-active) text-(--text-primary)'
                      }`}
                    >
                      {result.badge}
                    </span>
                  </div>
                  <div className="flex flex-col gap-[7px] border-t border-(--border-subtle) bg-(--surface-app) px-[12px] py-[11px]">
                    {result.unavailable ? (
                      <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                        {result.error ?? t('try.unavailableBody')}
                      </span>
                    ) : (
                      result.rows.map((row) => (
                        <div
                          key={row.label}
                          className="flex items-baseline justify-between gap-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
                        >
                          <span className="mono">{row.label}</span>
                          <b className="mono font-medium text-(--text-secondary)">{row.value}</b>
                        </div>
                      ))
                    )}
                    <div className="flex items-baseline justify-between gap-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      <span>{t('model')}</span>
                      <b className="mono font-medium text-(--text-secondary)">{result.model}</b>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      <span>{t('try.context')}</span>
                      <b className="mono font-medium text-(--text-secondary)">
                        {t('try.messages', { count: result.context })}
                      </b>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function IssueLine({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-start gap-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--red-600)">
      <Icon name="triangle-alert" size={12} className="mt-[2px] flex-none" />
      <span>{children}</span>
    </span>
  )
}

const EXAMPLES: Record<QuestionType, { history: Array<{ sender: string; text: string }>; current: string }> = {
  choice: { history: [{ sender: '@sam', text: 'morning all' }], current: 'Can someone ship the hotfix to prod?' },
  boolean: {
    history: [
      { sender: '@mira', text: 'this build is broken and the rollout is stalled' },
      { sender: '@tal', text: "let's keep it civil" }
    ],
    current: 'still broken, and nobody has answered my last three messages'
  },
  score: {
    history: [{ sender: '@ren', text: 'seeing 500s on /v1/runs' }],
    current: 'checkout is fully down for every customer'
  }
}
