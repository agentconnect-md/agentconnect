'use client'

// Edit workspace's subview that authorizes every repository one installation covers (agent-multi-repo-authorization.md decision 10).

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { AgentRepositorySelector } from '@agentconnect.md/protocol/decision'
import { GithubMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { agentLabel, type Agent } from '@/lib/data'
import {
  createAgentInstallation,
  type AgentInstallationAuthDto,
  type GithubInstallationDto,
  type InstallationMaterialize,
  type RepoAccess
} from '@/lib/api'
import { useRepositoryDecision } from '@/lib/repository-selector'
import { INSTALLATION_MATERIALIZE_OPTIONS, RepositoryMaterializeField } from '@/components/console/WorkspaceFormFields'

/** Installations an owner may still grant: live, unsuspended, and not already held by the agent. */
export function grantableInstallations(
  installations: readonly GithubInstallationDto[],
  granted: readonly AgentInstallationAuthDto[]
): GithubInstallationDto[] {
  const held = new Set(granted.map((grant) => grant.installationId))
  return installations.filter((installation) => !installation.suspended && !held.has(installation.installationId))
}

export default function AuthorizeInstallationModal({
  agent,
  installations,
  granted,
  repositorySelector,
  onClose,
  onExit,
  onCreated
}: {
  agent: Agent
  /** The organization's claimed installations, as the workspace editor probed them. */
  installations: readonly GithubInstallationDto[]
  granted: readonly AgentInstallationAuthDto[]
  /** The selector as Edit workspace holds it, which may be newer than `agent`'s. */
  repositorySelector?: AgentRepositorySelector | null
  /** Back to the workspace form. */
  onClose: () => void
  /** Close the whole workspace editor. */
  onExit: () => void
  onCreated: (row: AgentInstallationAuthDto) => void
}) {
  const t = useTranslations('Agents.installationModal')
  const candidates = grantableInstallations(installations, granted)
  const [pick, setPick] = useState<number | null>(() =>
    candidates.length === 1 ? candidates[0]!.installationId : null
  )
  const [access, setAccess] = useState<RepoAccess>('read')
  const [materialize, setMaterialize] = useState<InstallationMaterialize>('on-demand')
  const { block: decisionBlock } = useRepositoryDecision(
    agent,
    repositorySelector !== undefined ? repositorySelector : agent.repositorySelector
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const busyRef = useRef(false)

  // Capture phase + stopPropagation beats the parent editor's own Escape listener.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const canSubmit = pick !== null && candidates.some((installation) => installation.installationId === pick)

  const submit = async () => {
    if (busyRef.current || !canSubmit || pick === null) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      onCreated(await createAgentInstallation(agent.id, { installationId: pick, access, materialize }))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
      setSaving(false)
      busyRef.current = false
    }
  }

  const tiers: { v: RepoAccess; icon: string; label: string; desc: string }[] = [
    { v: 'read', icon: 'eye', label: t('readOnly'), desc: t('readOnlyDescription') },
    { v: 'write', icon: 'git-branch', label: t('readWrite'), desc: t('writeDescription') }
  ]

  return (
    <div className="scrim">
      <div className="modal">
        <div className="modalhead">
          <button className="iconbtn" title={t('backToWorkspace')} onClick={onClose}>
            <Icon name="arrow-left" size={16} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[16px] font-semibold leading-normal">{t('title')}</div>
            <div className="mt-[1px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {t('subtitle')} <span className="mono">{agentLabel(agent)}</span>
            </div>
          </div>
          <button className="iconbtn" onClick={onExit}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <div className="fldlbl mb-2">{t('installation')}</div>
          <div className="mb-4 flex flex-col gap-[9px]">
            {candidates.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[10px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                <Icon name="info" size={14} className="flex-none" />
                {t('noInstallations')}
              </div>
            ) : (
              candidates.map((installation) => {
                const on = pick === installation.installationId
                return (
                  <button
                    key={installation.id}
                    type="button"
                    data-installation={installation.installationId}
                    className={
                      on
                        ? 'flex cursor-pointer items-center gap-[11px] rounded-[9px] border border-(--brand) bg-(--brand-soft) px-[13px] py-[11px] text-left'
                        : 'flex cursor-pointer items-center gap-[11px] rounded-[9px] border border-(--border-subtle) bg-(--surface-card) px-[13px] py-[11px] text-left'
                    }
                    onClick={() => {
                      setPick(installation.installationId)
                      setErr(null)
                    }}
                  >
                    <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                      <span className="flex h-4 w-4 items-center justify-center">
                        <GithubMark color="var(--text-primary)" />
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="mono block truncate text-[13px] font-semibold text-(--text-primary)">
                        {installation.accountLogin}
                      </span>
                      <span className="mt-[2px] block truncate font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                        {installation.repositorySelection === 'all' ? t('allRepositories') : t('selectedRepositories')}
                      </span>
                    </span>
                    <span
                      className={
                        on
                          ? 'flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] border-(--brand)'
                          : 'flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] border-(--border-strong)'
                      }
                    >
                      {on && <span className="h-2 w-2 rounded-full bg-(--brand)" />}
                    </span>
                  </button>
                )
              })
            )}
          </div>

          <div className="fldlbl mb-2">{t('access')}</div>
          <div className="mb-4 flex flex-col gap-[9px]">
            {tiers.map((tier) => {
              const on = access === tier.v
              return (
                <button
                  key={tier.v}
                  type="button"
                  data-access={tier.v}
                  className={
                    on
                      ? 'flex cursor-pointer items-center gap-[11px] rounded-[9px] border border-(--brand) bg-(--brand-soft) px-[13px] py-[11px] text-left'
                      : 'flex cursor-pointer items-center gap-[11px] rounded-[9px] border border-(--border-subtle) bg-(--surface-card) px-[13px] py-[11px] text-left'
                  }
                  onClick={() => setAccess(tier.v)}
                >
                  <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                    <Icon name={tier.icon} size={16} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-sans text-[13px] font-semibold leading-normal">{tier.label}</span>
                    <span className="mt-[2px] block font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                      {tier.desc}
                    </span>
                  </span>
                  <span
                    className={
                      on
                        ? 'flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] border-(--brand)'
                        : 'flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] border-(--border-strong)'
                    }
                  >
                    {on && <span className="h-2 w-2 rounded-full bg-(--brand)" />}
                  </span>
                </button>
              )
            })}
          </div>
          <RepositoryMaterializeField
            value={materialize}
            options={INSTALLATION_MATERIALIZE_OPTIONS}
            decisionBlock={decisionBlock}
            onChange={(value) => setMaterialize(value as InstallationMaterialize)}
          />
          {err && <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
        </div>
        <div className="modalfoot">
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit || saving}
            className={!canSubmit || saving ? 'pointer-events-none opacity-50' : undefined}
          >
            {saving ? t('authorizing') : t('authorize')}
          </Button>
        </div>
      </div>
    </div>
  )
}
