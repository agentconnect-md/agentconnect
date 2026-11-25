'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import {
  deleteAgentMcpToolPolicy,
  fetchMcpToolCatalog,
  refreshMcpToolCatalog,
  saveAgentMcpToolPolicy,
  type AgentMcpToolPolicyDto,
  type McpCatalogToolDto,
  type McpToolCatalogDto,
  type McpToolDecision,
  type McpToolGroup,
  type McpToolGroupDecisions
} from '@/lib/api'
import {
  ALL_ALLOWED,
  MCP_TOOL_DECISIONS,
  MCP_TOOL_GROUPS,
  MCP_TOOL_PRESETS,
  PRESET_GROUPS,
  approvalDecisionsInUse,
  hasDrift,
  isCatalogStale,
  isDestructive,
  isKnownCatalogFailure,
  presetOf,
  sameGroups,
  sameOverrides,
  needsResave,
  type ApprovalDecision,
  type ApprovalRefusal,
  type McpToolPreset
} from '@/lib/mcp-tool-permissions'
import { formatRelative } from '@/i18n/format'
import { Button, Icon } from '@/components/ui'
import { FieldSelect, type FieldSelectOption } from '@/components/console/FieldSelect'
import { ConfirmStrip } from '@/components/console/ConfirmStrip'

const EXCERPT_CHARS = 140
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The compatibility warnings of §8, with daemon ids resolved to names by the caller; the approval lists leave out peers the first two already name. */
export interface ToolPolicyCompatibility {
  daemonsWithoutAgentDefinitions: string[]
  relaysWithoutToolPolicies: number
  daemonsWithoutApprovals: string[]
  relaysWithoutApprovals: number
}

/** The agent's runtime and starting mode when its gate refuses an approval decision (§7.3), with display names. */
export interface RuntimeApprovalGate {
  refusal: ApprovalRefusal
  runtime: string
  mode: string
}

/** One agent's tool permissions for one registry MCP provider: presets, groups, per-tool overrides, save or return to Full access. */
export function McpToolPermissionsPanel({
  agentId,
  providerId,
  providerName,
  policy,
  compatibility,
  runtimeGate = null,
  onClose,
  onSaved
}: {
  agentId: string
  providerId: string
  providerName: string
  /** The saved policy; null means Full access. */
  policy: AgentMcpToolPolicyDto | null
  compatibility: ToolPolicyCompatibility | null
  runtimeGate?: RuntimeApprovalGate | null
  onClose: () => void
  /** A save or removal landed; the caller re-reads the policies. */
  onSaved: () => void
}) {
  const t = useTranslations('Agents.detail.toolPermissions')
  const tc = useTranslations('Common.actions')
  const format = useFormatter()

  const [preset, setPreset] = useState<McpToolPreset>(() => presetOf(policy))
  const [groups, setGroups] = useState<McpToolGroupDecisions>(policy?.groups ?? ALL_ALLOWED)
  const [overrides, setOverrides] = useState<Record<string, McpToolDecision>>(policy?.overrides ?? {})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmingFull, setConfirmingFull] = useState(false)

  const [catalog, setCatalog] = useState<McpToolCatalogDto | null>(null)
  const [catalogErr, setCatalogErr] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const autoRefreshed = useRef(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setCatalogErr(null)
    try {
      setCatalog(await refreshMcpToolCatalog(providerId))
    } catch (e) {
      setCatalogErr(errText(e))
    } finally {
      setRefreshing(false)
    }
  }, [providerId])

  // Read the snapshot, then refresh it once when it was never fetched or is over a day old.
  useEffect(() => {
    let live = true
    fetchMcpToolCatalog(providerId).then(
      (snapshot) => {
        if (!live) return
        setCatalog(snapshot)
        if (!autoRefreshed.current && isCatalogStale(snapshot.fetchedAt, Date.now())) {
          autoRefreshed.current = true
          void refresh()
        }
      },
      (e) => live && setCatalogErr(errText(e))
    )
    return () => {
      live = false
    }
  }, [providerId, refresh])

  const restricted = preset !== 'full'
  const tools = catalog?.tools ?? []
  const listed = new Set(tools.map((tool) => tool.name))
  const manualNames = Object.keys(overrides)
    .filter((name) => !listed.has(name))
    .sort()
  const noCatalog = catalog !== null && tools.length === 0

  // A saved policy whose catalog changed is dirty too: the control plane expands the table only on save.
  const dirty =
    preset === 'full'
      ? policy !== null
      : policy === null ||
        !sameGroups(groups, policy.groups) ||
        !sameOverrides(overrides, policy.overrides) ||
        (catalog !== null && needsResave(policy, tools))

  const choosePreset = (next: McpToolPreset) => {
    setPreset(next)
    setConfirmingFull(false)
    if (next === 'full') {
      setGroups(ALL_ALLOWED)
      setOverrides({})
    } else if (next !== 'custom') {
      setGroups(PRESET_GROUPS[next])
      setOverrides({})
    }
  }
  const setGroup = (group: McpToolGroup, decision: McpToolDecision) => {
    setGroups((prev) => ({ ...prev, [group]: decision }))
    setPreset('custom')
  }
  const setOverride = (name: string, decision: McpToolDecision | null) => {
    setOverrides((prev) => {
      const next = { ...prev }
      if (decision === null) delete next[name]
      else next[name] = decision
      return next
    })
    setPreset('custom')
  }

  const save = async () => {
    if (!dirty || busy) return
    if (preset === 'full') {
      setConfirmingFull(true)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await saveAgentMcpToolPolicy(agentId, providerId, { groups, overrides })
      onSaved()
      onClose()
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  const returnToFull = async () => {
    setBusy(true)
    setErr(null)
    try {
      await deleteAgentMcpToolPolicy(agentId, providerId)
      onSaved()
      onClose()
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
      setConfirmingFull(false)
    }
  }

  const decisionOptions = MCP_TOOL_DECISIONS.map((decision): FieldSelectOption<McpToolDecision> => ({
    value: decision,
    label: t(`decisions.${decision}.label`),
    description: t(`decisions.${decision}.description`)
  }))

  const failure = catalog?.failure
  const failureText = failure
    ? isKnownCatalogFailure(failure)
      ? t(`failures.${failure}`)
      : t('failures.other', { code: failure })
    : null
  const daemons = compatibility?.daemonsWithoutAgentDefinitions ?? []
  const relays = compatibility?.relaysWithoutToolPolicies ?? 0
  // Approval warnings matter only while the table would gate some tool on an approval.
  const gated = restricted ? approvalDecisionsInUse(groups, overrides, tools) : new Set<ApprovalDecision>()
  const approvalDaemons = gated.size > 0 ? (compatibility?.daemonsWithoutApprovals ?? []) : []
  const approvalRelays = gated.size > 0 ? (compatibility?.relaysWithoutApprovals ?? 0) : 0
  const runtimeRefuses = runtimeGate?.refusal.refused.some((d) => gated.has(d)) === true

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="shield-check" size={16} color="var(--brand)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[16px] font-semibold leading-normal">{t('title')}</div>
          <div className="mono truncate text-[11.5px] text-(--text-tertiary)">{providerName}</div>
        </div>
        <button type="button" className="iconbtn" aria-label={tc('close')} onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        <div className="flex flex-col gap-[14px]">
          {restricted && daemons.length > 0 && (
            <Warning>{t('compat.daemons', { count: daemons.length, names: daemons.join(', ') })}</Warning>
          )}
          {restricted && relays > 0 && <Warning>{t('compat.relays', { count: relays })}</Warning>}
          {approvalDaemons.length > 0 && (
            <Warning testId="tool-policy-approval-daemons">
              {t('compat.daemonsApprovals', { count: approvalDaemons.length, names: approvalDaemons.join(', ') })}
            </Warning>
          )}
          {approvalRelays > 0 && (
            <Warning testId="tool-policy-approval-relays">
              {t('compat.relaysApprovals', { count: approvalRelays })}
            </Warning>
          )}
          {runtimeGate && runtimeRefuses && (
            <Warning testId="tool-policy-runtime">
              {t(`runtimeWarnings.${runtimeGate.refusal.reason}`, {
                runtime: runtimeGate.runtime,
                mode: runtimeGate.mode
              })}
            </Warning>
          )}
          {policy && hasDrift(policy.drift) && (
            <Warning testId="tool-policy-drift">
              {policy.drift.newTools.length > 0 && (
                <span className="block">{t('drift.newTools', { count: policy.drift.newTools.length })}</span>
              )}
              {policy.drift.changedTools.length > 0 && (
                <span className="block">{t('drift.changedTools', { count: policy.drift.changedTools.length })}</span>
              )}
              {policy.drift.missingTools.length > 0 && (
                <span className="block">{t('drift.missingTools', { count: policy.drift.missingTools.length })}</span>
              )}
              <span className="block">{t('drift.resave')}</span>
            </Warning>
          )}

          <div className="fld">
            <span className="fldlbl">{t('presetLabel')}</span>
            <div className="pillbar max-w-full flex-wrap self-start" role="radiogroup" aria-label={t('presetLabel')}>
              {MCP_TOOL_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={preset === p}
                  disabled={busy}
                  className={preset === p ? 'pill on whitespace-nowrap' : 'pill whitespace-nowrap'}
                  onClick={() => choosePreset(p)}
                >
                  {t(`presets.${p}`)}
                </button>
              ))}
            </div>
            <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              {t(`presetHints.${preset}`)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            <span className="min-w-0 flex-1" data-testid="tool-catalog-status">
              {catalog === null && !catalogErr
                ? t('catalog.loading')
                : refreshing
                  ? t('catalog.refreshing')
                  : catalog?.fetchedAt
                    ? t('catalog.listed', { when: formatRelative(format, new Date(catalog.fetchedAt), Date.now()) })
                    : t('catalog.neverListed')}
            </span>
            <Button variant="ghost" size="xs" disabled={refreshing || busy} onClick={() => void refresh()}>
              <Icon name="refresh-cw" size={13} />
              {t('catalog.refresh')}
            </Button>
          </div>
          {failureText && !refreshing && (
            <div
              data-testid="tool-catalog-failure"
              className="-mt-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
            >
              {t('catalog.failed', { reason: failureText })}
            </div>
          )}
          {catalogErr && (
            <div className="-mt-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
              {catalogErr}
            </div>
          )}
          {noCatalog && (
            <div className="rounded-md bg-(--surface-sunken) px-3 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
              {t('noCatalog')}
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-(--border-subtle)">
            {MCP_TOOL_GROUPS.map((group) => (
              <ToolGroup
                key={group}
                group={group}
                tools={tools.filter((tool) => tool.group === group)}
                decision={groups[group]}
                overrides={overrides}
                options={decisionOptions}
                disabled={busy}
                onGroup={(decision) => setGroup(group, decision)}
                onOverride={setOverride}
              />
            ))}
          </div>

          {(noCatalog || manualNames.length > 0) && (
            <ManualTools
              names={manualNames}
              overrides={overrides}
              canAdd={noCatalog}
              taken={listed}
              disabled={busy}
              options={decisionOptions}
              onOverride={setOverride}
            />
          )}
        </div>

        {confirmingFull && (
          <ConfirmStrip
            prompt={t('confirmFull', { provider: providerName })}
            confirm={t('returnToFull')}
            keep={t('keepRestrictions')}
            busy={busy}
            tone="primary"
            onConfirm={() => void returnToFull()}
            onKeep={() => setConfirmingFull(false)}
          />
        )}
        {err && <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
      </div>

      <div className="modalfoot flex-wrap">
        {policy && (
          <Button variant="ghost" disabled={busy || confirmingFull} onClick={() => setConfirmingFull(true)}>
            {t('returnToFull')}
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {tc('cancel')}
        </Button>
        <Button variant="primary" disabled={!dirty || busy || confirmingFull} onClick={() => void save()}>
          {busy ? t('saving') : tc('save')}
        </Button>
      </div>
    </>
  )
}

function Warning({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-primary)"
    >
      <Icon name="triangle-exclamation-point" size={14} color="var(--amber-500)" className="mt-[2px] flex-none" />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/** One collapsible group: its decision, then each tool following it or overriding it. */
function ToolGroup({
  group,
  tools,
  decision,
  overrides,
  options,
  disabled,
  onGroup,
  onOverride
}: {
  group: McpToolGroup
  tools: McpCatalogToolDto[]
  decision: McpToolDecision
  overrides: Record<string, McpToolDecision>
  options: FieldSelectOption<McpToolDecision>[]
  disabled: boolean
  onGroup: (decision: McpToolDecision) => void
  onOverride: (name: string, decision: McpToolDecision | null) => void
}) {
  const t = useTranslations('Agents.detail.toolPermissions')
  const [open, setOpen] = useState(false)
  const overridden = tools.filter((tool) => overrides[tool.name] !== undefined).length
  const label = t(`groups.${group}`)
  const toolOptions: FieldSelectOption<McpToolDecision | 'group'>[] = [
    { value: 'group', label: t('followsGroup'), tag: t(`decisions.${decision}.label`) },
    ...options
  ]
  return (
    <div className="border-b border-(--border-subtle) last:border-b-0" data-testid={`tool-group-${group}`}>
      <div className="flex flex-col gap-2 px-3 py-[10px] desktop:flex-row desktop:items-center desktop:gap-3">
        <button
          type="button"
          aria-expanded={open}
          disabled={tools.length === 0}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left disabled:cursor-default"
        >
          <Icon
            name="chevron-right"
            size={14}
            color="var(--text-tertiary)"
            className={`flex-none transition-transform ${open ? 'rotate-90' : ''} ${tools.length === 0 ? 'opacity-0' : ''}`}
          />
          <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">{label}</span>
          <span className="mono text-[11px] text-(--text-tertiary)">{tools.length}</span>
          {overridden > 0 && (
            <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('overridden', { count: overridden })}
            </span>
          )}
        </button>
        <div className="w-full flex-none desktop:w-[210px]">
          <FieldSelect
            ariaLabel={t('groupDecision', { group: label })}
            value={decision}
            options={options}
            onChange={onGroup}
            disabled={disabled}
            menuWidth={320}
          />
        </div>
      </div>
      {open &&
        tools.map((tool) => (
          <ToolRow
            key={tool.name}
            tool={tool}
            value={overrides[tool.name] ?? 'group'}
            options={toolOptions}
            disabled={disabled}
            onChange={(next) => onOverride(tool.name, next === 'group' ? null : next)}
          />
        ))}
    </div>
  )
}

function ToolRow({
  tool,
  value,
  options,
  disabled,
  onChange
}: {
  tool: McpCatalogToolDto
  value: McpToolDecision | 'group'
  options: FieldSelectOption<McpToolDecision | 'group'>[]
  disabled: boolean
  onChange: (next: McpToolDecision | 'group') => void
}) {
  const t = useTranslations('Agents.detail.toolPermissions')
  const [expanded, setExpanded] = useState(false)
  const description = tool.description?.trim() ?? ''
  const long = description.length > EXCERPT_CHARS
  const shown = long && !expanded ? `${description.slice(0, EXCERPT_CHARS).trimEnd()}…` : description
  return (
    <div
      data-testid={`tool-row-${tool.name}`}
      className="flex flex-col gap-2 border-t border-(--border-subtle) bg-(--surface-app) py-[10px] pr-3 pl-[34px] desktop:flex-row desktop:items-start desktop:gap-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-[6px]">
          <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)">
            {tool.title ?? tool.name}
          </span>
          {tool.title && <span className="mono text-[11px] text-(--text-tertiary)">{tool.name}</span>}
          {tool.interactive && (
            <span className="badge bg-(--status-info-soft) text-(--status-info)">{t('interactive')}</span>
          )}
          {isDestructive(tool) && (
            <span className="badge bg-(--status-error-soft) text-(--status-error)">{t('destructive')}</span>
          )}
        </div>
        {shown && (
          <p className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            {shown}
            {long && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[12px] font-medium leading-normal text-(--text-link)"
                >
                  {expanded ? t('showLess') : t('showMore')}
                </button>
              </>
            )}
          </p>
        )}
      </div>
      <div className="w-full flex-none desktop:w-[210px]">
        <FieldSelect
          ariaLabel={t('toolDecision', { tool: tool.name })}
          value={value}
          options={options}
          onChange={onChange}
          disabled={disabled}
          menuWidth={320}
        />
      </div>
    </div>
  )
}

/** Overrides naming tools the catalog does not list; without a catalog, the only way to decide a tool. */
function ManualTools({
  names,
  overrides,
  canAdd,
  taken,
  disabled,
  options,
  onOverride
}: {
  names: string[]
  overrides: Record<string, McpToolDecision>
  canAdd: boolean
  taken: ReadonlySet<string>
  disabled: boolean
  options: FieldSelectOption<McpToolDecision>[]
  onOverride: (name: string, decision: McpToolDecision | null) => void
}) {
  const t = useTranslations('Agents.detail.toolPermissions')
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const add = () => {
    const name = draft.trim()
    if (!name) return
    if (name.length > 256) return setErr(t('manualTooLong'))
    if (overrides[name] !== undefined || taken.has(name)) return setErr(t('manualDuplicate', { tool: name }))
    onOverride(name, 'allow')
    setDraft('')
    setErr(null)
  }
  return (
    <div className="fld" data-testid="manual-tools">
      <span className="fldlbl">{t('manualTitle')}</span>
      {names.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-(--border-subtle)">
          {names.map((name) => {
            const current = overrides[name] ?? 'allow'
            return (
              <div
                key={name}
                className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) px-3 py-2 last:border-b-0"
              >
                <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">{name}</span>
                <div className="w-[170px] flex-none">
                  <FieldSelect
                    ariaLabel={t('toolDecision', { tool: name })}
                    value={current}
                    options={options}
                    onChange={(next) => onOverride(name, next)}
                    disabled={disabled}
                    menuWidth={320}
                  />
                </div>
                <button
                  type="button"
                  className="iconbtn flex-none"
                  title={t('manualRemove', { tool: name })}
                  aria-label={t('manualRemove', { tool: name })}
                  disabled={disabled}
                  onClick={() => onOverride(name, null)}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {canAdd && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <input
            className="inp mn min-w-0 flex-1"
            value={draft}
            placeholder={t('manualPlaceholder')}
            aria-label={t('manualTitle')}
            disabled={disabled}
            onChange={(event) => {
              setDraft(event.target.value)
              setErr(null)
            }}
          />
          <Button variant="secondary" type="submit" disabled={disabled || !draft.trim()}>
            {t('manualAdd')}
          </Button>
        </form>
      )}
      {err && <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</span>}
    </div>
  )
}
