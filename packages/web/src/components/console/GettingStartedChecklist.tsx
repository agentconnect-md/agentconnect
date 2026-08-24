'use client'

// Shared getting-started checklist pieces, so the console pill/drawer (GettingStarted.tsx)
// and the onboarding reveal (OnboardingView.tsx) render the SAME checklist from the SAME
// derivation (lib/getting-started.ts) — the design's explicit goal: onboarding "hands over
// the same getting-started checklist as the console".
//
//   useGsActions() — maps a GsAction (pure, from computeGettingStarted) to the real console
//                    surface that completes it (open a modal, route, open the Playground).
//   <GsRows/>      — the expandable item rows (mark · label · chevron → explanation + CTA).

import { Fragment, type ReactNode } from 'react'
import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { useModal } from './ModalProvider'
import type { GsAction, GsItem } from '@/lib/getting-started'
import { agentIsPlaced, agentLabel, modelLabel, runtimeLabel } from '@/lib/data'
import { isAuthConfigured } from '@/lib/auth'
import {
  fetchGithubInstallations,
  fetchMySocialAccount,
  fetchSessionExternalAccess,
  type SessionAccessProvider
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { socialLoginProviders } from '@/lib/social-login-providers'
import { useSlackPlatformInstall } from '@/components/console/platforms/slack/use-platform-install'
import { useDeploymentConfig } from '@/components/console/platforms/deployment-config'
import { Button, Icon } from '@/components/ui'
import { PlatformMark } from '@/components/marks'

/** The action-runner + the agent the agent-scoped steps act on, wired to the live console. */
export function useGsActions() {
  const { agents } = useConsoleData()
  const { orgPath } = useOrgs()
  const { openModal } = useModal()
  const router = useRouter()
  const firstAgent = agents[0]
  // Every org ships the built-in `agentconnect` preset, so "set up your agent" edits it
  // (placement + runtime/model) rather than creating a new one — only a truly empty org
  // (no preset row) falls back to the create modal.
  const builtinAgent = agents.find((a) => a.builtin) ?? firstAgent

  const runAction = useCallback(
    (action: GsAction) => {
      switch (action.kind) {
        case 'agent':
          return builtinAgent ? openModal('editAgent', builtinAgent, { focusSection: 'basics' }) : openModal('agent')
        case 'slack': {
          // The action targets the built-in preset; honor it — agents[0] is commonly an
          // older custom agent in backfilled orgs, and the manual fallback must not
          // configure Slack on the wrong agent.
          const target = agents.find((a) => a.id === action.agentId) ?? builtinAgent
          return target ? openModal('integration', target, { platform: 'slack' }) : openModal('agent')
        }
        case 'github':
          // Land on the Workspace tab with the workspace editor auto-opened on the
          // GitHub mode (`editws` is consumed one-shot by WorkspaceCard).
          return action.agentId
            ? router.push(orgPath(`/agents/${action.agentId}?tab=workspace&editws=github`))
            : openModal('agent')
        case 'github-profile':
          // Land on Profile with the GitHub link flow auto-started (`link=github` is
          // consumed one-shot by ProfileView → SocialSignInCard's autoAuthorize).
          return router.push(orgPath('/profile?link=github'))
        case 'chat':
          // The chat-first Home landing is where conversations start.
          return router.push(orgPath('/home'))
        case 'members':
          // Land on Settings with the invite-members dialog auto-opened (`invite` is
          // consumed one-shot by SettingsView).
          return router.push(orgPath('/settings?invite=1'))
        case 'session-access':
          // The Session access card owns id="session-access" — the hash lands and
          // scrolls there natively (same href the console nav / GlobalSearch use).
          return router.push(orgPath('/settings#session-access'))
      }
    },
    [openModal, router, orgPath, firstAgent, builtinAgent, agents]
  )

  return { runAction, firstAgent }
}

// Backs the "Link your GitHub profile" step. The SWR key is shared with
// SocialSignInCard, so this is deduped with the profile page. Undefined while
// unknowable — auth off, no GitHub connector on this deployment, or the account
// still loading — and computeGettingStarted omits the step for that value.
export function useGithubProfileLinked(): boolean | undefined {
  const offersGithub = isAuthConfigured() && socialLoginProviders().some((p) => p.target === 'github')
  const { data } = useSWR(offersGithub ? 'logto-account-sign-in-methods' : null, fetchMySocialAccount, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false
  })
  if (!data) return undefined
  return data.identities.some((i) => i.target === 'github')
}

// Backs hiding the "Connect GitHub" step: whether this deployment's GitHub App
// provider is configured at all (the installations list doubles as the enabled
// probe — 404 ⇒ off). Undefined while loading or on error, and
// computeGettingStarted keeps the step for that value.
export function useGithubAppEnabled(): boolean | undefined {
  const { activeOrg } = useOrgs()
  const { data } = useSWR(
    consoleKeys.githubApp(activeOrg?.id),
    () => fetchGithubInstallations().then((r) => r.enabled),
    { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }
  )
  return data
}

// Backs hiding the "Review session access policy" step: mirrors GlobalSearch's
// `sessionAccessRenders` guard (GlobalSearch.tsx) so the checklist's CTA never
// points at a card that renders null — SessionAccessCard hides itself once every
// provider is BOTH unavailable and disabled (`hasNothingToOffer`, SettingsView.tsx).
// Undefined while any read is still pending/unanswered — keep the step rather than
// guess; only a definitive "nothing to offer" from all three hides it.
export function useSessionAccessCardAvailable(): boolean | undefined {
  const { activeOrg } = useOrgs()
  const key = (provider: SessionAccessProvider) => consoleKeys.sessionAccess(activeOrg?.id, provider)
  const fetcher = ([, orgId, , provider]: NonNullable<ReturnType<typeof key>>) =>
    fetchSessionExternalAccess(provider, orgId)
  const opts = { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }
  const slack = useSWR(key('slack'), fetcher, opts)
  const github = useSWR(key('github'), fetcher, opts)
  const feishu = useSWR(key('feishu'), fetcher, opts)
  const results = [slack, github, feishu]
  if (results.some(({ data, error }) => data === undefined && !error)) return undefined
  return results.some(({ data }) => data === undefined || data.available || data.enabled)
}

// Whether the platform-published one-click "Add to Slack" app is installable on
// this deployment. Local/self-hosted mode has no published app — the checklist
// then renders the plain "Connect Slack" row, whose CTA opens the Slack
// integration wizard instead. An unanswered probe keeps the one-click UI (the
// hosted default); only a definitive false / failed probe switches to manual.
export function useSlackPlatformAppAvailable(): boolean {
  const probe = useDeploymentConfig(true)
  return probe.config ? probe.config.platformInstallAvailable === true : !probe.failed
}

// The checklist item rows. `runAction` is supplied by the caller so each surface can
// wrap it (the drawer closes itself first); the wrapper stops the CTA click from
// bubbling to the row's expand/collapse toggle.
export function GsRows({
  items,
  expanded,
  onToggle,
  runAction,
  renderItem
}: {
  items: GsItem[]
  expanded: string | null
  onToggle: (key: string) => void
  runAction: (action: GsAction) => void
  /** Per-item override: return a full custom row for `item` (e.g. onboarding's rich
   *  "Meet your agents" row), or null/undefined to use the default row. */
  renderItem?: (item: GsItem, ctx: { open: boolean; toggle: () => void }) => ReactNode | null
}): ReactNode {
  return items.map((it) => {
    const open = expanded === it.key
    const custom = renderItem?.(it, { open, toggle: () => onToggle(it.key) })
    if (custom != null) return <Fragment key={it.key}>{custom}</Fragment>
    return (
      <div
        key={it.key}
        onClick={() => onToggle(it.key)}
        className="flex cursor-pointer gap-3 border-b border-(--border-subtle) py-3 pr-[14px] pl-4 last:border-b-0 hover:bg-(--surface-hover)"
      >
        <span
          className={`mt-[1px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full ${
            it.done ? 'bg-(--brand) text-white' : 'border-[1.5px] border-(--border-strong)'
          }`}
        >
          {it.done && <Icon name="check" size={12} />}
        </span>
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center gap-2">
            <span
              className={`font-sans text-[13.5px] leading-normal ${
                it.done && !it.optional
                  ? 'font-normal text-(--text-tertiary) line-through'
                  : 'font-medium text-(--text-primary)'
              }`}
            >
              {it.label}
            </span>
            {it.tag && <span className="font-mono text-[11.5px] leading-none text-(--text-disabled)">{it.tag}</span>}
          </span>
          {open && (
            <>
              <div className="mt-[5px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {it.expl}
              </div>
              {(!it.done || it.optional) && (
                <div className="mt-[11px]" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" onClick={() => runAction(it.action)}>
                    {it.ctaLabel}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        <span
          className="mt-[2px] flex flex-none self-start text-(--text-tertiary) transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'none' }}
        >
          <Icon name="chevron-down" size={15} />
        </span>
      </div>
    )
  })
}

// Shared row chrome (mark · label · chevron + expandable body) for the two custom
// getting-started rows below, so they line up pixel-for-pixel with the default GsRows.
function CustomRow({
  done,
  open,
  toggle,
  title,
  tag,
  children
}: {
  done: boolean
  open: boolean
  toggle: () => void
  title: string
  tag?: string
  children: ReactNode
}) {
  return (
    <div
      onClick={toggle}
      className="flex cursor-pointer gap-3 border-b border-(--border-subtle) py-3 pr-[14px] pl-4 last:border-b-0 hover:bg-(--surface-hover)"
    >
      <span
        className={`mt-[1px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full ${
          done ? 'bg-(--brand) text-white' : 'border-[1.5px] border-(--border-strong)'
        }`}
      >
        {done && <Icon name="check" size={12} />}
      </span>
      <div className="min-w-0 flex-1">
        <span className="inline-flex items-center gap-2">
          <span
            className={`font-sans text-[13.5px] leading-normal ${
              done ? 'font-normal text-(--text-tertiary) line-through' : 'font-medium text-(--text-primary)'
            }`}
          >
            {title}
          </span>
          {tag && <span className="font-mono text-[11.5px] leading-none text-(--text-disabled)">{tag}</span>}
        </span>
        {open && <div className="mt-[9px] flex flex-col gap-2">{children}</div>}
      </div>
      <span
        className="mt-[2px] flex flex-none self-start text-(--text-tertiary) transition-transform"
        style={{ transform: open ? 'rotate(180deg)' : 'none' }}
      >
        <Icon name="chevron-down" size={15} />
      </span>
    </div>
  )
}

// "Meet your agent" — the FIRST half of the split (the 'agent' step): configure the org's
// built-in `agentconnect` preset (preset-agents.md §3), no `agentconnect-admin` (cancelled;
// its capabilities fold into this one agent). Placed (daemon + runtime) ⇒ show runtime ·
// model; unplaced ⇒ the set-up CTA (`onConnect` → the 'agent' GsAction). Slack now lives in
// its own step (AddToSlackRow). Falls back to the first agent if no preset row exists.
export function MeetYourAgents({
  done,
  open,
  toggle,
  onConnect
}: {
  done: boolean
  open: boolean
  toggle: () => void
  onConnect: () => void
}) {
  const { agents } = useConsoleData()
  const builtin = agents.find((a) => a.builtin) ?? agents[0]
  const placed = !!builtin && agentIsPlaced(builtin)
  return (
    <CustomRow done={done} open={open} toggle={toggle} title="Meet your agent" tag="built-in">
      <div className="rounded-[9px] border border-(--border-subtle) bg-(--surface-app) px-3 py-[11px]">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] bg-(--surface-inverse) text-white">
            <Icon name="bot" size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                {builtin ? agentLabel(builtin) : 'agentconnect'}
              </span>
              <span className="flex-none whitespace-nowrap rounded-[5px] bg-(--surface-active) px-[6px] py-[1px] font-sans text-[10px] font-medium leading-normal text-(--text-secondary)">
                Built-in
              </span>
            </div>
            <div className="mt-[2px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-secondary)">
              A general agent for coding, code review, and everyday tasks
            </div>
          </div>
        </div>
        <div className="mt-[10px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          {placed ? (
            <span className="inline-flex h-[30px] items-center gap-[6px] whitespace-nowrap rounded-(--radius-sm) border border-(--border-subtle) bg-(--surface-card) px-3 font-sans text-[12.5px] leading-none text-(--text-tertiary)">
              <Icon name="check" size={14} />
              {runtimeLabel(builtin.runtime)}
              {builtin.model ? ` · ${modelLabel(builtin.model)}` : ''}
            </span>
          ) : (
            <Button size="sm" onClick={onConnect}>
              <Icon name="sliders-horizontal" size={14} />
              Set up
            </Button>
          )}
        </div>
      </div>
      <div className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
        Place it on a daemon and pick a runtime and model — then talk to it from the Playground or a channel.
      </div>
    </CustomRow>
  )
}

// "Add to Slack" — the SECOND half of the split (the 'slack' step): the one-click built-in
// Slack Bot for the preset (preset-agents.md §5.3), the SAME flow as AddIntegrationModal's
// "Add to Slack" button via the shared hook. Only meaningful once the agent is placed; a
// failed install (e.g. no published platform app on this CP) or the manual link falls back
// to the full integration modal, which handles every path. `onManual` opens that modal.
export function AddToSlackRow({
  done,
  open,
  toggle,
  onManual
}: {
  done: boolean
  open: boolean
  toggle: () => void
  onManual: () => void
}) {
  const { agents, refresh } = useConsoleData()
  const builtin = agents.find((a) => a.builtin) ?? agents[0]
  const placed = !!builtin && agentIsPlaced(builtin)
  const slack = useSlackPlatformInstall(builtin?.id ?? '', refresh)
  return (
    <CustomRow done={done} open={open} toggle={toggle} title="Add to Slack" tag="built-in bot">
      <div className="rounded-[9px] border border-(--border-subtle) bg-(--surface-app) px-3 py-[11px]">
        <div className="flex items-start gap-3">
          <span className="imark h-8 w-8 flex-none border-0 bg-transparent">
            <PlatformMark platform="slack" />
          </span>
          <div className="min-w-0 flex-1 font-sans text-[12px] font-normal leading-[1.45] text-(--text-secondary)">
            {done
              ? 'Connected — the built-in bot can read and post in your Slack channel.'
              : placed
                ? 'One click installs the built-in AgentConnect bot — no Slack app, token, or scopes to pick.'
                : 'Set up your agent first, then connect it to Slack in one click.'}
          </div>
        </div>
        {!done && (
          <div className="mt-[10px] flex justify-end" onClick={(e) => e.stopPropagation()}>
            {!placed ? (
              <Button size="sm" variant="secondary" disabled>
                <span className="imark h-[14px] w-[14px] border-0 bg-transparent">
                  <PlatformMark platform="slack" />
                </span>
                Add to Slack
              </Button>
            ) : slack.phase === 'authorizing' ? (
              <button
                type="button"
                onClick={() => slack.cancel()}
                title="Cancel — closed the Slack tab? Click to try again"
                className="group inline-flex h-[30px] cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-(--radius-sm) border-0 bg-(--surface-inverse) px-3 font-sans text-[12.5px] font-medium leading-none text-white"
              >
                <Icon name="loader" size={14} className="animate-spin group-hover:hidden" />
                <Icon name="x" size={14} className="hidden group-hover:inline" />
                <span className="group-hover:hidden">Waiting for Slack…</span>
                <span className="hidden group-hover:inline">Cancel</span>
              </button>
            ) : (
              <Button size="sm" onClick={() => void slack.start()}>
                <span className="imark h-[14px] w-[14px] border-0 bg-transparent">
                  <PlatformMark platform="slack" />
                </span>
                Add to Slack
              </Button>
            )}
          </div>
        )}
        {slack.err && (
          <div className="mt-2 font-sans text-[11.5px] font-normal leading-[1.4] text-(--status-error)">
            {slack.err}{' '}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onManual()
              }}
              className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[11.5px] font-semibold text-(--brand) underline"
            >
              Set up Slack another way
            </button>
          </div>
        )}
      </div>
    </CustomRow>
  )
}
