'use client'

// The GitHub App an agent works through: the built-in one, a free organization App, or a new one created on GitHub.
// A switch goes through only once the App reaches everything the agent works on; the check runs as soon as an App is picked.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { FieldSelect, type FieldSelectOption } from '@/components/console/FieldSelect'
import { Scrim } from '@/components/console/Scrim'
import {
  ApiError,
  fetchBuiltinGithubAppSlug,
  fetchGithubAppCoverage,
  fetchGithubApps,
  startGithubAppManifest,
  switchAgentGithubApp,
  type GithubAppCoverageItem
} from '@/lib/api'
import type { Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

const BUILT_IN = 'built-in'
const CREATE = 'create'

/** Posts the manifest to GitHub as a top-level form, the only way GitHub accepts one. */
function submitToGithub(action: string, manifest: Record<string, unknown>): void {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = action
  const field = document.createElement('input')
  field.type = 'hidden'
  field.name = 'manifest'
  field.value = JSON.stringify(manifest)
  form.appendChild(field)
  document.body.appendChild(form)
  form.submit()
}

/** The agent's GitHub App slug (null on the built-in App) and the dialog that changes it; `onSwitched` lets an open picker reload. */
export function useAgentGithubAppDialog(
  agent: Pick<Agent, 'id' | 'githubAppId'>,
  initialAppId?: string,
  onSwitched?: (githubAppId: string | null) => void
) {
  const { activeOrg } = useOrgs()
  const { data: apps } = useSWR(agent.githubAppId ? consoleKeys.githubApps(activeOrg?.id) : null, ([, id]) =>
    fetchGithubApps(id ?? undefined)
  )
  const appSlug = agent.githubAppId ? (apps?.find((app) => app.id === agent.githubAppId)?.slug ?? null) : null
  const [open, setOpen] = useState(initialAppId !== undefined)
  const dialog = open ? (
    <GithubAppDialog
      agent={agent}
      initialAppId={initialAppId}
      onClose={() => setOpen(false)}
      {...(onSwitched ? { onSwitched } : {})}
    />
  ) : null
  return { appSlug, openDialog: () => setOpen(true), dialog }
}

export function GithubAppDialog({
  agent,
  initialAppId,
  onClose,
  onSwitched
}: {
  agent: Pick<Agent, 'id' | 'githubAppId'>
  /** The App to open on, such as one just created on GitHub. */
  initialAppId?: string
  onClose: () => void
  onSwitched?: (githubAppId: string | null) => void
}) {
  const t = useTranslations('Common.githubApp')
  const { activeOrg } = useOrgs()
  const { refresh } = useConsoleData()
  const orgId = activeOrg?.id
  const current = agent.githubAppId ?? BUILT_IN
  const [choice, setChoice] = useState(initialAppId ?? current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: builtInSlug } = useSWR(consoleKeys.githubBuiltinApp(orgId), ([, id]) =>
    fetchBuiltinGithubAppSlug(id ?? undefined)
  )
  const { data: apps } = useSWR(consoleKeys.githubApps(orgId), ([, id]) => fetchGithubApps(id ?? undefined))
  const checking = choice !== current && choice !== CREATE
  const coverageKey = checking ? (['github-app-coverage', agent.id, choice] as const) : null
  const {
    data: coverage,
    error: coverageError,
    mutate: recheck
  } = useSWR(coverageKey, () => fetchGithubAppCoverage(agent.id, choice === BUILT_IN ? null : choice))

  const usable = (apps ?? []).filter((app) => app.agentId === null || app.agentId === agent.id)
  const options: FieldSelectOption<string>[] = [
    { value: BUILT_IN, label: builtInSlug ?? t('builtInFallback'), tag: t('builtIn') },
    ...usable.map((app) => ({ value: app.id, label: app.slug, ...(app.agentId === null ? { tag: t('free') } : {}) })),
    { value: CREATE, label: t('create') }
  ]
  const chosenSlug = choice === BUILT_IN ? builtInSlug : usable.find((app) => app.id === choice)?.slug
  const uncovered = coverage?.filter((item) => !item.covered) ?? []

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const proceed = () =>
    run(async () => {
      if (choice === CREATE) {
        const form = await startGithubAppManifest(agent.id)
        submitToGithub(form.action, form.manifest)
        return
      }
      const next = choice === BUILT_IN ? null : choice
      try {
        await switchAgentGithubApp(agent.id, next)
      } catch (e) {
        // A refusal names what is still uncovered; show the fresh list rather than a bare message.
        if (e instanceof ApiError && e.status === 409 && Array.isArray(e.details?.coverage)) {
          await recheck(e.details.coverage as GithubAppCoverageItem[], { revalidate: false })
          throw new Error(t('notCovered', { slug: chosenSlug ?? '' }))
        }
        throw e
      }
      refresh()
      onSwitched?.(next)
      onClose()
    })

  const kindLabel = (item: GithubAppCoverageItem) => t(`kinds.${item.kind}`)
  const installUrl = chosenSlug ? `https://github.com/apps/${encodeURIComponent(chosenSlug)}/installations/new` : null

  return (
    <Scrim onEscape={busy ? undefined : onClose}>
      <div className="modal max-w-[520px]" role="dialog" aria-modal="true" aria-label={t('title')}>
        <div className="modalhead">
          <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('title')}</span>
          <button type="button" className="iconbtn" aria-label={t('close')} disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-3">
          <FieldSelect ariaLabel={t('title')} value={choice} options={options} onChange={setChoice} disabled={busy} />
          {checking && (
            <div className="flex flex-col gap-[6px]">
              {coverage === undefined && !coverageError ? (
                <span className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                  {t('checking')}
                </span>
              ) : coverageError ? (
                <span className="font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
                  {coverageError instanceof Error ? coverageError.message : String(coverageError)}
                </span>
              ) : (
                coverage!.map((item) => (
                  <div key={`${item.kind}:${item.target}`} className="flex min-w-0 items-center gap-2">
                    <Icon
                      name={item.covered ? 'check' : 'x'}
                      size={14}
                      color={item.covered ? 'var(--status-online)' : 'var(--status-error)'}
                    />
                    <span className="mono min-w-0 truncate text-[12.5px] text-(--text-primary)">{item.target}</span>
                    <span className="flex-none font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {kindLabel(item)}
                    </span>
                    <span className="flex-1" />
                    {!item.covered && installUrl && (
                      <a
                        className="flex-none font-sans text-[12px] font-medium leading-normal text-(--text-secondary) hover:text-(--text-primary)"
                        href={installUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('addOnGithub')}
                      </a>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
          {error && (
            <div role="alert" className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
              {error}
            </div>
          )}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          {checking && uncovered.length > 0 && (
            <Button variant="ghost" onClick={() => void recheck()}>
              {t('checkAgain')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          {choice === CREATE ? (
            <Button onClick={() => void proceed()} className={busy ? 'pointer-events-none opacity-50' : undefined}>
              {busy ? t('opening') : t('continueOnGithub')}
            </Button>
          ) : (
            checking && (
              <Button
                onClick={() => void proceed()}
                disabled={coverage === undefined || uncovered.length > 0}
                className={busy ? 'pointer-events-none opacity-50' : undefined}
              >
                {busy ? t('switching') : t('switch')}
              </Button>
            )
          )}
        </div>
      </div>
    </Scrim>
  )
}
