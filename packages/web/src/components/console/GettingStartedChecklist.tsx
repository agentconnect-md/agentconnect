'use client'

// Shared getting-started tutorial pieces for the console pill/drawer (GettingStarted.tsx),
// all reading the SAME derivation (lib/getting-started.ts).
//
//   useGsActions()    — maps a GsAction (pure, from computeGettingStarted) to the real
//                       console surface that completes it (open a modal, route).
//   <SlackSlideBody/> — the one-click "Add to Slack" slide content.

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { useModal } from './ModalProvider'
import type { GsAction } from '@/lib/getting-started'
import { agentIsPlaced } from '@/lib/data'
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
import { FaSlack } from 'react-icons/fa6'
import { Button, Icon } from '@/components/ui'

/** The checklist's action-runner, wired to the live console surfaces. */
export function useGsActions() {
  const { agents } = useConsoleData()
  const { orgPath } = useOrgs()
  const { openModal } = useModal()
  const router = useRouter()
  const firstAgent = agents[0]
  // Every org ships the built-in `agentconnect` preset — the agent-scoped CTAs target it,
  // falling back to the first agent for older backfilled orgs without the preset row.
  const builtinAgent = agents.find((a) => a.builtin) ?? firstAgent

  const runAction = useCallback(
    (action: GsAction) => {
      switch (action.kind) {
        case 'daemon':
          return openModal('daemon')
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
    [openModal, router, orgPath, builtinAgent, agents]
  )

  return { runAction }
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

// "Add to Slack" slide body — the 'slack' step: the one-click built-in Slack Bot for the
// preset (preset-agents.md §5.3), the SAME flow as AddIntegrationModal's "Add to Slack"
// button via the shared hook. Only meaningful once the agent is placed; a failed install
// (e.g. no published platform app on this CP) or the manual link falls back to the full
// integration modal, which handles every path. `onManual` opens that modal.
export function SlackSlideBody({ done, onManual }: { done: boolean; onManual: () => void }) {
  const { agents, refresh } = useConsoleData()
  const builtin = agents.find((a) => a.builtin) ?? agents[0]
  const placed = !!builtin && agentIsPlaced(builtin)
  const slack = useSlackPlatformInstall(builtin?.id ?? '', refresh)
  return (
    <>
      <div className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
        {done
          ? 'Connected — the built-in bot can read and post in your Slack channel.'
          : placed
            ? 'One click installs the built-in AgentConnect bot — no Slack app, token, or scopes to pick.'
            : 'Set up your agent first, then connect it to Slack in one click.'}
      </div>
      {!done && (
        <div className="mt-[14px]">
          {!placed ? (
            <Button size="sm" variant="secondary" disabled>
              <FaSlack size={14} aria-hidden />
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
              <FaSlack size={14} aria-hidden />
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
            onClick={onManual}
            className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[11.5px] font-semibold text-(--brand) underline"
          >
            Set up Slack another way
          </button>
        </div>
      )}
    </>
  )
}
