// No 'use client' here: rendered only by ModalProvider (the client boundary).

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import useSWR from 'swr'
import LarkFeishuSwitcher, { type LarkFeishuTarget } from '@/components/LarkFeishuSwitcher'
import { AgentIconView, GithubMark, LoadingState, PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { GithubReviewSettings } from '@/components/console/GithubReviewSettings'
import { GitlabReviewSettings } from '@/components/console/GitlabReviewSettings'
import {
  GithubPrivateReposNotice,
  GitlabNoProjectsNotice,
  GitlabProjectField,
  GitlabProjectOption,
  REPOSITORY_ACCESS_BADGE
} from '@/components/console/WorkspaceFormFields'
import type {
  WebWizardTransport,
  WizardFooterState,
  WizardHost,
  WizardIdentityChromeState,
  WizardReuseContext
} from '@/components/console/platforms/contract'
import { useDeploymentConfig } from '@/components/console/platforms/deployment-config'
import {
  footerView as toFooterView,
  identityChromeView as toIdentityChromeView,
  sameFooterView,
  sameIdentityChromeView,
  type FooterView,
  type IdentityChromeView
} from '@/components/console/platforms/publish'
import {
  platformRegistry,
  platformSharingFixed,
  platformSupportsSharing
} from '@/components/console/platforms/registry'
import { BOT_PLATFORMS, PLATFORMS, isCoreTriggerKind } from '@/components/console/platforms/host-projections'
import { agentCapabilitySource, agentLabel, MOCK_MODE, workspaceSourceOf, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { useProfile } from '@/lib/profile'
import { consoleKeys } from '@/lib/swr-keys'
import {
  creatorLabel,
  fetchAgentHooks,
  fetchAgentRepos,
  repoAuthProvider,
  fetchGithubInstallationRepo,
  fetchGithubInstallations,
  fetchGithubInstallUrl,
  fetchGithubRepoRoster,
  invalidateGithubRepoRosterCache,
  syncGithubInstallations,
  updateAgentRepo,
  type CreatedHookDto,
  type GithubInstallationDto,
  type GithubRepoDto,
  type RepoAccess
} from '@/lib/api'
import EditWorkspaceModal from './EditWorkspaceModal'
import {
  GH_DEFAULT_FAMILIES,
  GH_FAMILIES,
  GH_TRIGGER_LABEL,
  famCovered,
  githubDefaultTriggerMode,
  githubFamilyCarriesReviews,
  githubFamilySubscription,
  githubMentionUsage,
  githubTriggerTooltip,
  type GhFamily,
  type GhTriggerMode
} from '@/lib/github-events'
import {
  GL_DEFAULT_FAMILIES,
  GL_FAMILIES,
  GL_TRIGGER_LABEL,
  gitlabDefaultTriggerMode,
  gitlabFamCovered,
  gitlabFamilyCarriesReviews,
  gitlabFamilySubscription,
  gitlabMentionUsage,
  gitlabTriggerTooltip,
  type GlFamily,
  type GlTriggerMode
} from '@/lib/gitlab-events'
import { matchGitlabProjects, type GitlabProjectChoice } from '@/lib/gitlab-projects'
import { useGitlabProjects } from '@/lib/use-gitlab-projects'
import {
  effectiveRepoAccess,
  hasChecksWritePermission,
  hasPullRequestsReadPermission,
  hasPullRequestsWritePermission,
  installationForRepo,
  isWorkspaceRepo,
  repoAccessSatisfies,
  requiredRepoAccess,
  type HookReportingMode,
  type HookReviewPolicy
} from '@/lib/github-review-settings'

// THE HOST CHASSIS (integration-plugin-architecture.md §10). What lives here is
// everything a platform CANNOT own: the picker tiles and their daemon-capability
// gate, the existing/create mode cards, the generic free-bot reuse list, the
// share toggle, the error banner, the footer, and the two CORE trigger
// sections — webhook and github, which mint an inbound hook rather than a bot
// identity and are therefore fragments of the chassis, not platform modules.
//
// Each chat platform's create pane is a fragment behind `WizardHost`
// (`components/console/platforms/<id>/`). The chassis knows no platform name
// except where §5 manifest data has nowhere else to live yet (the picker labels
// and the Lark/Feishu region switcher — see D2 in the contract); the tile lists
// themselves are registry projections in `platforms/host-projections.ts`.

/**
 * One picker choice: a chat-platform id the registry knows, or one of the two
 * CORE trigger kinds. `webhook` and `github` are not bot platforms — picking
 * either mints an inbound trigger (a hook) instead of installing a bot
 * identity: webhook is agent-fired-by-URL, github subscribes a repo's
 * issue/PR/commit events. Both live on the relay pool, so neither is gated by
 * the daemon's adapter capabilities.
 *
 * OPEN by design (audit §10.6 F15). This was a closed union of the four chat
 * ids plus the two trigger kinds, and the registry-derived tile list was CAST
 * into it — a type asserting a platform set the runtime no longer has, which is
 * the one thing the registry was made the single authority for. It is widened
 * rather than GENERATED from the registry because generating it would mean
 * re-closing an axis the contract deliberately keeps open: `platformId` is a
 * `string` that is "never parsed", `WebPlatformRegistry.ids()` answers
 * `readonly string[]`, and every host lookup over it is total by construction.
 * A literal union would additionally have to survive the registry's erasure of
 * its modules to one homogeneous array — the same erasure that already defeated
 * the `TCardState` parameter (see `WebBotSettingsFragments` in the contract).
 * Nothing reads this type to DECIDE anything; every consumer compares to a
 * literal or asks the registry, and both still work on a string.
 */
export type Platform = string
export type FeishuRegion = LarkFeishuTarget

type GithubRepoChoice = GithubRepoDto & { installationId: string }

/** One cadence choice offered inside a family card. */
interface TriggerTile<M extends string> {
  mode: M
  label: string
  desc: string
}

/** The cadences each GitHub subject offers, worded for that subject. Issues trade
 *  "any update" for "labeled" here: a label is the signal a triaging agent waits
 *  on, and the agent page still offers the full four. */
const GH_TRIGGER_TILES: Partial<Record<GhFamily, TriggerTile<GhTriggerMode>[]>> = {
  pull_request: [
    // Subtitles promise only what the ingress admits: ready-for-review and
    // submitted formal reviews are deliberately silent there.
    { mode: 'first', label: GH_TRIGGER_LABEL.first, desc: 'A new PR is opened' },
    { mode: 'every', label: GH_TRIGGER_LABEL.every, desc: 'Every new commit or reply' },
    { mode: 'mention', label: GH_TRIGGER_LABEL.mention, desc: 'Only when the agent is @-mentioned' }
  ],
  issues: [
    { mode: 'first', label: GH_TRIGGER_LABEL.first, desc: 'A new issue is filed' },
    { mode: 'labeled', label: GH_TRIGGER_LABEL.labeled, desc: 'A label is applied' },
    { mode: 'mention', label: GH_TRIGGER_LABEL.mention, desc: 'Only when the agent is @-mentioned' }
  ]
}

/** The GitLab cadences — the same shape, minus the label mode: GitLab label
 *  events are not a verified subscription here, so its issues keep the three
 *  modes the wire already carries. */
const GL_TRIGGER_TILES: Partial<Record<GlFamily, TriggerTile<GlTriggerMode>[]>> = {
  merge_request: [
    // Same honesty rule: draft/ready flips are dropped by ingress normalization.
    { mode: 'first', label: GL_TRIGGER_LABEL.first, desc: 'A new MR is opened' },
    { mode: 'every', label: GL_TRIGGER_LABEL.every, desc: 'Every new commit or reply' },
    { mode: 'mention', label: GL_TRIGGER_LABEL.mention, desc: 'Only when the agent is @-mentioned' }
  ],
  issues: [
    { mode: 'first', label: GL_TRIGGER_LABEL.first, desc: 'A new issue is filed' },
    { mode: 'every', label: GL_TRIGGER_LABEL.every, desc: 'Every update or comment' },
    { mode: 'mention', label: GL_TRIGGER_LABEL.mention, desc: 'Only when the agent is @-mentioned' }
  ]
}

/**
 * "Listen for": one full-width card per subject family. Unchecked it is a slim
 * row — glyph, name, checkbox. Checked, that row becomes the card's tinted
 * header band and the body opens beneath it with the subject's own "Trigger
 * when" tiles, plus whatever else rides that subject (the review format, on the
 * change-proposal family). A code-host hook row is (agent, repo, family) and
 * carries its own cadence, so one wizard pass can watch PRs on every update and
 * issues on a label. A family the picked repository already watches is not on
 * offer — its row is inert and says so.
 */
function FamilyCards<F extends string, M extends string>({
  families,
  tilesOf,
  takenOf,
  onOf,
  onToggle,
  modeOf,
  onPick,
  familyAttr,
  triggerAttr,
  titleOf,
  bodyExtra
}: {
  families: readonly { fam: F; pill: string; icon: string; label: string }[]
  tilesOf: (fam: F) => readonly TriggerTile<M>[]
  takenOf: (fam: F) => boolean
  onOf: (fam: F) => boolean
  onToggle: (fam: F) => void
  modeOf: (fam: F) => M
  onPick: (fam: F, mode: M) => void
  familyAttr: 'data-github-family' | 'data-gitlab-family'
  triggerAttr: 'data-github-trigger' | 'data-gitlab-trigger'
  /** Hover copy that goes BEYOND the tile's own subtitle, which the user can already read. */
  titleOf: (mode: M) => string
  bodyExtra?: (fam: F) => ReactNode
}) {
  return (
    <>
      <div className="fldlbl mb-2">Listen for</div>
      <div className="mb-4 flex flex-col gap-[9px]">
        {families.map((row) => {
          const taken = takenOf(row.fam)
          const on = !taken && onOf(row.fam)
          const active = modeOf(row.fam)
          const extra = on ? bodyExtra?.(row.fam) : null
          return (
            <div
              key={row.fam}
              className={`overflow-hidden rounded-[9px] border ${
                on ? 'border-(--brand)' : 'border-(--border-default)'
              }`}
            >
              <div
                {...{ [familyAttr]: row.fam }}
                aria-disabled={taken}
                title={taken ? 'Already watched — change its trigger on the agent page' : undefined}
                className={`flex min-w-0 items-center gap-[9px] px-3 py-[10px] ${
                  taken ? 'cursor-default opacity-55' : 'cursor-pointer'
                } ${on ? 'bg-(--brand-soft)' : 'bg-(--surface-card)'}`}
                onClick={() => {
                  if (!taken) onToggle(row.fam)
                }}
              >
                <Icon
                  name={row.icon}
                  size={16}
                  color={on ? 'var(--brand)' : 'var(--text-tertiary)'}
                  className="flex-none"
                />
                <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-semibold leading-normal">
                  {row.label}
                </span>
                {taken && (
                  <span className="flex-none font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    already watched
                  </span>
                )}
                <span
                  className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border-[1.5px] ${
                    on ? 'border-(--brand) bg-(--brand)' : 'border-(--border-default) bg-(--surface-card)'
                  }`}
                >
                  {on && <Icon name="check" size={12} color="#fff" />}
                </span>
              </div>
              {on && (
                <div className="flex flex-col gap-3 border-t border-(--brand) bg-(--surface-card) px-3 py-3">
                  <div>
                    <div className="fldlbl mb-2">Trigger when</div>
                    <div
                      className="grid grid-cols-1 gap-2 desktop:grid-cols-3"
                      role="group"
                      aria-label={`Trigger for ${row.pill}`}
                    >
                      {tilesOf(row.fam).map((tile) => {
                        const picked = tile.mode === active
                        return (
                          <button
                            key={tile.mode}
                            type="button"
                            {...{ [triggerAttr]: `${row.fam}:${tile.mode}` }}
                            aria-pressed={picked}
                            title={titleOf(tile.mode)}
                            className={`flex min-w-0 cursor-pointer items-start gap-[9px] rounded-[9px] border px-3 py-[10px] text-left ${
                              picked
                                ? 'border-(--brand) bg-(--brand-soft)'
                                : 'border-(--border-default) bg-(--surface-card)'
                            }`}
                            onClick={() => onPick(row.fam, tile.mode)}
                          >
                            <span
                              className={`mt-[1px] flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] bg-(--surface-card) ${
                                picked ? 'border-(--brand)' : 'border-(--border-default)'
                              }`}
                            >
                              {picked && <span className="h-2 w-2 rounded-full bg-(--brand)" />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block font-sans text-[12.5px] font-semibold leading-normal">
                                {tile.label}
                              </span>
                              <span className="mt-[2px] block font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                                {tile.desc}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  {extra && <div className="border-t border-(--border-subtle) pt-3">{extra}</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

// "12d ago" for the freed-bot sub-line; null ⇒ the bot was never installed.
function fmtAgo(iso: string | null): string {
  if (!iso) return 'never used'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `last used ${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `last used ${h}h ago`
  return `last used ${Math.round(h / 24)}d ago`
}

// The copy-paste test delivery shown once a webhook is created. The body follows
// the payload-is-the-message convention (a `message` field speaks for the caller);
// the X-AC-Signature is the REAL HMAC of exactly this body, so the command runs
// as-is.
const DEFAULT_HOOK_TEST_MESSAGE = 'Reply with a one-line hello. This is a test delivery.'

function hookTestBody(message: string): string {
  return JSON.stringify({ message })
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** HMAC-SHA256 hex via WebCrypto (available on https + localhost, where the console runs). */
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

function hookTestCurl(url: string, sig: string | null, body: string, requiresSignature: boolean): string {
  return [
    `curl -X POST ${url} \\`,
    `  -H 'Content-Type: application/json' \\`,
    ...(requiresSignature ? [`  -H 'X-AC-Signature: sha256=${sig ?? '<calculating>'}' \\`] : []),
    `  -d ${shellSingleQuote(body)}`
  ].join('\n')
}

// The integration is owned by one agent; that agent's daemon opens the connection.
// Reached from an agent (its row / detail page) the agent is FIXED and no picker
// renders — `agentChoices` is undefined there, and that arm must stay that way.
// Reached from the Integrations page there is no implied agent, so the caller
// (`AddIntegrationForOrgModal`) passes the roster and owns the selection.
// `initialPlatform` lets a caller land on a specific pane (the GitHub group
// card's "Add repository" — adding a repo, not a bot).
export default function AddIntegrationModal({
  agent,
  agentChoices,
  onPickAgent,
  initialPlatform,
  initialFeishuRegion,
  onClose
}: {
  agent: Agent
  /** Present ONLY when the dialog was opened without an agent in hand. */
  agentChoices?: Agent[]
  onPickAgent?: (agentId: string) => void
  initialPlatform?: Platform
  initialFeishuRegion?: FeishuRegion
  onClose: () => void
}) {
  const {
    createIntegration,
    bots,
    createHook,
    createGithubHook,
    createGitlabHook,
    daemons,
    daemonsLoading,
    memberSets,
    refresh,
    updateAgent
  } = useConsoleData()
  const { me } = useProfile()
  const [platform, setPlatform] = useState<Platform>(initialPlatform ?? 'slack')
  // Lark/Feishu gateway: new installs default to international Lark. Host state
  // because the PICKER TILE hosts the switcher and callers preselect it.
  const [feishuRegion, setFeishuRegion] = useState<FeishuRegion>(initialFeishuRegion ?? 'lark')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Synchronous re-entry guard for the chassis's own async actions (webhook,
  // github, reuse). `saving` state can't do this — it commits on the NEXT
  // render, so a fast double-click fires two calls in the same tick. Each
  // platform fragment keeps its own guard for its own flows.
  const busyRef = useRef(false)

  // Webhook path: the form, then the created row. HMAC is an optional second
  // factor; when selected, the row carries the ONE-TIME signing-secret echo.
  // Once created the platform is locked so the completed hook is not orphaned.
  const [hookName, setHookName] = useState('')
  const [hookSessionMode, setHookSessionMode] = useState<'perDelivery' | 'perSubject' | 'shared'>('perDelivery')
  const [hookHmac, setHookHmac] = useState(false)
  const [createdHook, setCreatedHook] = useState<CreatedHookDto | null>(null)
  const [copiedHook, setCopiedHook] = useState<'url' | 'secret' | 'curl' | null>(null)
  const [hookTestMessage, setHookTestMessage] = useState(DEFAULT_HOOK_TEST_MESSAGE)
  const hookMessageRef = useRef<HTMLTextAreaElement | null>(null)
  // The real signature for the test-delivery snippet, computed client-side from
  // the one-time secret (WebCrypto is async — null until it lands / unavailable).
  const [testSig, setTestSig] = useState<{ body: string; hex: string } | null>(null)

  // GitHub path (design: repo selector + "Listen for" event rows). The
  // installations probe doubles as the enabled-probe; repository pages render
  // progressively and filter client-side (same contract as Add-agent).
  const [gh, setGh] = useState<{ enabled: boolean; installations: GithubInstallationDto[] } | null>(null)
  const [ghRepos, setGhRepos] = useState<GithubRepoChoice[] | null>(null)
  const [ghReposNonce, setGhReposNonce] = useState(0)
  // At least one installation's roster failed to load — the list may be
  // incomplete, which must not read as "no repositories".
  const [ghReposError, setGhReposError] = useState<'failed' | null>(null)
  const [ghPrivateReposHidden, setGhPrivateReposHidden] = useState(false)
  const [ghRepoPick, setGhRepoPick] = useState<string | null>(
    agent.workspace.mode === 'git' && workspaceSourceOf(agent.workspace) === 'github' ? agent.workspace.repo : null
  )
  const [ghRepoOpen, setGhRepoOpen] = useState(false)
  const [ghQ, setGhQ] = useState('')
  const [ghExactRepoLoading, setGhExactRepoLoading] = useState(false)
  const [ghFams, setGhFams] = useState<Set<GhFamily>>(new Set(GH_DEFAULT_FAMILIES))
  // Cadence is per SUBJECT — one hook row per family, each with its own trigger.
  // Unset ⇒ that family's default, so a newly ticked family needs no seeding here.
  const [ghModes, setGhModes] = useState<Partial<Record<GhFamily, GhTriggerMode>>>({})
  const ghModeOf = (fam: GhFamily): GhTriggerMode => ghModes[fam] ?? githubDefaultTriggerMode(fam)
  const [ghReviewPolicy, setGhReviewPolicy] = useState<HookReviewPolicy>('full')
  const [ghReportingMode, setGhReportingMode] = useState<HookReportingMode>('check')
  const [ghSyncing, setGhSyncing] = useState(false)
  const [ghAccessSaving, setGhAccessSaving] = useState(false)
  const [ghWorkspaceAccessOverride, setGhWorkspaceAccessOverride] = useState<'write' | null>(null)
  // What this agent ALREADY watches is per (repo, FAMILY) now — one row covers
  // one subject, so a repo may be watched for PRs and still free for issues.
  // Offered rows are disabled only once every offered family is taken (the CP
  // 409s a duplicate family as the backstop).
  const { activeOrg, orgPath } = useOrgs()
  const agentHooksKey = consoleKeys.agentHooks(activeOrg?.id, agent.id)
  const { data: agentHooksData, mutate: mutateAgentHooks } = useSWR(agentHooksKey, ([, orgId, , agentId]) =>
    fetchAgentHooks(agentId, orgId)
  )
  const watchedGhFamilies = useMemo(() => {
    const byRepo = new Map<string, Set<GhFamily>>()
    for (const h of agentHooksData ?? []) {
      if (h.kind !== 'github' || !h.repoFullName) continue
      const key = h.repoFullName.toLowerCase()
      const taken = byRepo.get(key) ?? new Set<GhFamily>()
      // A null-family legacy row still blocks every family its events cover.
      for (const { fam } of GH_FAMILIES) {
        if (h.family ? h.family === fam : famCovered(h.events, fam)) taken.add(fam)
      }
      byRepo.set(key, taken)
    }
    return byRepo
  }, [agentHooksData])
  const repoFullyWatched = (repo: string) => {
    const taken = watchedGhFamilies.get(repo.toLowerCase())
    return !!taken && GH_FAMILIES.every(({ fam }) => taken.has(fam))
  }
  const ghPickedWatched = (ghRepoPick && watchedGhFamilies.get(ghRepoPick.toLowerCase())) || new Set<GhFamily>()
  const ghRepoAlreadyWatched = !!ghRepoPick && repoFullyWatched(ghRepoPick)
  // A family already watched on the picked repo is not selectable, so the
  // enablement, the review gating and the create loop all read this set.
  const ghSelectedFams = GH_FAMILIES.map(({ fam }) => fam).filter((fam) => ghFams.has(fam) && !ghPickedWatched.has(fam))
  // Reviews and Checks ride the pull-request row only; an issues-only pick drops them.
  const ghPrSelected = ghSelectedFams.includes('pull_request')
  const ghEffectiveReviewPolicy: HookReviewPolicy = ghPrSelected ? ghReviewPolicy : 'off'
  const ghEffectiveReportingMode: HookReportingMode = ghPrSelected ? ghReportingMode : 'off'
  // Multi-repo design decision 6 + issue #457 UX layer: a github hook may only
  // watch the agent's workspace repo or an explicitly authorized one (the CP
  // 409s anything else). The picker lists ALL App-visible repos and guides the
  // user to authorize an unpicked one inline. Scratch workspaces have no
  // implicit repo and use this explicit allowlist for every GitHub repo. A
  // manual GitHub workspace remains limited to its own repo.
  const wsRepo =
    agent.workspace.mode === 'git' && workspaceSourceOf(agent.workspace) === 'github' ? agent.workspace.repo : null
  const isGithubAppWs = agent.workspace.mode === 'git' && agent.workspace.provider === 'github'
  const canAuthorizeAdditionalRepos = isGithubAppWs || agent.workspace.mode === 'scratch'
  const agentReposKey = consoleKeys.agentRepos(activeOrg?.id, agent.id)
  const { data: agentReposData, mutate: mutateAgentRepos } = useSWR(agentReposKey, ([, orgId, , agentId]) =>
    fetchAgentRepos(agentId, orgId)
  )
  const authorizedRepos = useMemo(() => agentReposData ?? [], [agentReposData])
  const canEditAgent = agent.canEdit
  // Non-null ⇒ the unified workspace dialog is open at repository
  // authorization, prefilled with this owner/repo + minimum required tier.
  const [authRepoFor, setAuthRepoFor] = useState<{ repo: string; access: RepoAccess } | null>(null)
  const ghSelectedRepo = ghRepos?.find((repo) => repo.fullName.toLowerCase() === ghRepoPick?.toLowerCase())
  const ghSelectedAuthorization = authorizedRepos.find(
    (authorization) => authorization.repoFullName.toLowerCase() === ghRepoPick?.toLowerCase()
  )
  const ghSelectedIsWorkspace = isWorkspaceRepo({
    repoId: ghSelectedRepo?.repoId,
    repoFullName: ghRepoPick,
    workspace: agent.workspace
  })
  const resolvedGhRepoAccess = effectiveRepoAccess({
    repoId: ghSelectedRepo?.repoId,
    repoFullName: ghRepoPick,
    workspace: agent.workspace,
    authorizations: authorizedRepos
  })
  const ghRepoAccess =
    ghSelectedIsWorkspace && ghWorkspaceAccessOverride ? ghWorkspaceAccessOverride : resolvedGhRepoAccess
  const ghNeededAccess = requiredRepoAccess({
    reviewPolicy: ghEffectiveReviewPolicy,
    reportingMode: ghEffectiveReportingMode
  })
  const ghSelectedInstallation =
    gh?.installations.find((installation) => installation.id === ghSelectedRepo?.installationId) ??
    installationForRepo(ghRepoPick, gh?.installations ?? [])
  // Teams exist only under an organization, so a personal installation gets no team form.
  const ghTeamOwner =
    ghSelectedInstallation?.accountType === 'Organization' ? ghSelectedInstallation.accountLogin : null
  const ghReviewSettingsBlocked =
    !!ghRepoPick &&
    (!repoAccessSatisfies(ghRepoAccess, ghNeededAccess) ||
      (ghEffectiveReviewPolicy !== 'off' && !hasPullRequestsWritePermission(ghSelectedInstallation)) ||
      (ghEffectiveReportingMode === 'check' &&
        (!hasChecksWritePermission(ghSelectedInstallation) || !hasPullRequestsReadPermission(ghSelectedInstallation))))

  // GitLab path: one hook per project, picked here. A project the organization
  // has not added yet is set up as part of picking it (§18.1).
  const [glProject, setGlProject] = useState<string | null>(null)
  const [glOpen, setGlOpen] = useState(false)
  const [glQ, setGlQ] = useState('')
  const gl = useGitlabProjects(platform === 'gitlab', glQ)
  const [glFams, setGlFams] = useState<Set<GlFamily>>(new Set(GL_DEFAULT_FAMILIES))
  const [glModes, setGlModes] = useState<Partial<Record<GlFamily, GlTriggerMode>>>({})
  const glModeOf = (fam: GlFamily): GlTriggerMode => glModes[fam] ?? gitlabDefaultTriggerMode(fam)
  const [glReviewPolicy, setGlReviewPolicy] = useState<HookReviewPolicy>('full')
  const [glReportingMode, setGlReportingMode] = useState<HookReportingMode>('check')

  // Reusing a bot is an advanced path; every platform opens on the create flow
  // until the user explicitly chooses an existing identity.
  const [modePick, setModePick] = useState<'existing' | 'create' | null>(null)
  const [botPick, setBotPick] = useState<string | null>(null)
  // Shared-bot opt-in (shared-bot-relay.md §4.1): one bot, many agents, inbound via a
  // relay. Only platforms declaring the `share` affordance offer it; the CP rejects
  // a shared install anywhere else.
  const [shared, setShared] = useState(false)
  // Explicit transport pick; null ⇒ derive the active module's default rule.
  const [transportPick, setTransportPick] = useState<WebWizardTransport | null>(null)

  // ── The two publication channels a fragment drives (§10) ────────────────────
  // Both keep the CALLBACKS in a ref and only the RENDERED fields in state, so a
  // Body may republish on every commit (see `platforms/publish.ts`) without ever
  // looping the host: an unchanged publication returns the previous state and
  // React bails out of the re-render.
  const footerRef = useRef<WizardFooterState | null>(null)
  const [footerView, setFooterView] = useState<FooterView | null>(null)
  const setFooter = useCallback((state: WizardFooterState | null) => {
    footerRef.current = state
    const next = toFooterView(state)
    setFooterView((prev) => (sameFooterView(prev, next) ? prev : next))
  }, [])
  const identityRef = useRef<WizardIdentityChromeState | null>(null)
  const [identityView, setIdentityView] = useState<IdentityChromeView | null>(null)
  const setIdentityChrome = useCallback((state: WizardIdentityChromeState | null) => {
    identityRef.current = state
    const next = toIdentityChromeView(state)
    setIdentityView((prev) => (sameIdentityChromeView(prev, next) ? prev : next))
  }, [])
  // The third publication channel: a fragment with a started, region-bound flow
  // freezes the region switcher on the picker tile (Feishu's pending device
  // registration — see `WizardHost.setRegionLocked`).
  const [regionLocked, setRegionLocked] = useState(false)
  const setError = useCallback((message: string | null) => setErr(message), [])

  // A bot integration is runnable only where the PLACEMENT reported that adapter on register — resolved as a
  // placement, since a set names no member and an id lookup found none, offering a pool agent every platform.
  // Not `maxAgents`: that is a concurrency ceiling, while `caps.platforms` is the adapter-capability declaration.
  // No caps source at all keeps the bot platforms selectable — the platform "Add to Slack" card and the funnel
  // mint CP-side rows whose delivery converges at placement, and the server backstops what needs a daemon.
  const daemon = agentCapabilitySource(agent, daemons, memberSets)
  const capsUnknown = !daemon
  const supportedBotPlatforms =
    daemonsLoading || capsUnknown ? BOT_PLATFORMS : BOT_PLATFORMS.filter((p) => daemon.caps.platforms.includes(p.key))
  const firstSupportedBotPlatform = supportedBotPlatforms[0]?.key
  // webhook + github are relay/CP-backed triggers — always available, never
  // gated by the daemon's adapter capabilities.
  const isPlatformAvailable = (candidate: Platform) =>
    isCoreTriggerKind(candidate) || supportedBotPlatforms.some((supported) => supported.key === candidate)
  const selectedBotPlatformSupported = isPlatformAvailable(platform)

  const platformTiles = PLATFORMS

  // The active platform module — undefined for the core trigger sections.
  const activeModule = platformRegistry.get(platform)
  const wizard = activeModule?.wizard
  // §5 `regions` is manifest data the web module deliberately does not carry
  // (contract D2), so the chassis keeps the one platform with regional clouds.
  const region = platform === 'feishu' ? feishuRegion : undefined

  // Switching platform resets the shared bot-identity axes. The platform's OWN
  // sub-form needs no reset list any more: a different platform is a different
  // Body component, so React unmounts the old fragment and its state goes with
  // it (§10's reset seam).
  const pickPlatform = (candidate: Platform) => {
    if (createdHook || !isPlatformAvailable(candidate)) return
    setPlatform(candidate)
    setModePick(null)
    setBotPick(null)
    setShared(false)
    setTransportPick(null)
    setErr(null)
    setFooter(null)
    setIdentityChrome(null)
    setRegionLocked(false)
  }

  // Daemon data arrives asynchronously and can change after the modal opens. If
  // the current bot platform disappears, reset its form and choose the first
  // reported adapter; fall back to the separate relay-backed webhook trigger.
  useEffect(() => {
    if (daemonsLoading || createdHook || selectedBotPlatformSupported) return
    setPlatform(firstSupportedBotPlatform ?? 'webhook')
    setModePick(null)
    setBotPick(null)
    setShared(false)
    setTransportPick(null)
    setErr(null)
    setFooter(null)
    setIdentityChrome(null)
    setRegionLocked(false)
  }, [
    createdHook,
    daemonsLoading,
    firstSupportedBotPlatform,
    selectedBotPlatformSupported,
    setFooter,
    setIdentityChrome
  ])

  // Deployment-level public-callback capability, probed for every platform module.
  // It used to be gated on a transport CHOICE, which left `relayCapability` reading
  // false for a platform whose single fixed transport is the relay-backed one — the
  // opposite of the answer that platform needs most.
  const probe = useDeploymentConfig(wizard !== undefined)
  const relayCapability = useMemo(
    () => ({ available: probe.config?.relayAvailable ?? false, publicUrl: probe.config?.relayPublicUrl ?? null }),
    [probe.config]
  )

  const mode: 'create' | 'existing' = modePick ?? 'create'
  // A bot serves one agent at a time; freed (or prebuilt, never-installed) bots of
  // THIS platform are offered for reuse instead of forcing a re-create. Two kinds
  // look "free" (`inUseByAgentId` clears with the last install) but are not, and the
  // server rejects both — don't offer what cannot be picked:
  //   • revoked — the workspace uninstalled the app, so its token is dead;
  //   • whatever the platform itself disqualifies (`freeBotFilter`) — Slack's
  //     not-yet-shared workspace install, Feishu's other-region bot.
  // The predicate is evaluated before the EFFECTIVE shared opt-in is known (that
  // needs the selection this list produces), so it sees the raw toggle; no
  // platform's eligibility rule reads it.
  const reuseContext = (sharedOptIn: boolean): WizardReuseContext => ({
    agentId: agent.id,
    ...(region !== undefined ? { region } : {}),
    shared: sharedOptIn
  })
  const freeBots = bots.filter(
    (b) =>
      b.platform === platform &&
      !b.inUseByAgentId &&
      !b.revokedAt &&
      (wizard?.freeBotFilter(b, reuseContext(shared)) ?? false)
  )
  const selectedBotId = freeBots.some((b) => b.id === botPick) ? botPick : (freeBots[0]?.id ?? null)
  const selectedBot = freeBots.find((b) => b.id === selectedBotId) ?? null

  // The effective callback-capable transport for the CREATE path: an explicit pick,
  // else the module's default rule (Slack prefers HTTP when relay delivery is
  // available; Feishu starts on Long Connection and offers HTTP as an explicit choice).
  const transport: WebWizardTransport =
    transportPick ??
    (wizard?.affordances.transport?.httpByDefaultWhenRelayAvailable && relayCapability.available ? 'http' : 'socket')
  // Picking the transport drops the shared opt-in when moving to socket: shared
  // bots are relay-backed and therefore http-only.
  const setTransport = useCallback((next: WebWizardTransport) => {
    setTransportPick(next)
    if (next === 'socket') setShared(false)
  }, [])
  // Shared mode needs a platform with multi-agent bots at all, and is http-only
  // on top of that — a socket bot can never be shared. Create: gate on the chosen
  // transport. Existing: gate on the reused bot's own transport (the selector
  // isn't shown for reuse), so a socket bot never offers it. The platform half
  // goes through `platformSupportsSharing` (registry.ts), the same lookup the
  // Settings → Bots cell makes, so the two surfaces cannot disagree — including
  // on a `share: 'fixed'` platform, where the provider stamps the flag and there
  // is no opt-in to offer on either surface.
  const shareToggleAvailable =
    platformSupportsSharing(platform) &&
    !platformSharingFixed(platform) &&
    (mode === 'existing' ? (selectedBot?.transport ?? 'socket') === 'http' : transport === 'http')
  // Reusing an already-shared bot is implicitly a shared install.
  const wantShared = shareToggleAvailable && (shared || (mode === 'existing' && !!selectedBot?.shareable))

  const host: WizardHost = {
    createIntegration,
    relayCapability,
    mode,
    selectedBot,
    ...(region !== undefined ? { region } : {}),
    transport,
    setTransport,
    shared: wantShared,
    mockMode: MOCK_MODE,
    setFooter,
    setIdentityChrome,
    setRegionLocked,
    setError,
    close: onClose,
    invalidate: refresh
  }

  // Reuse needs no fragment participation: the host builds the input from the
  // module's pure `buildReuseInput` and commits it.
  const submitReuse = async () => {
    if (busyRef.current || !wizard || !selectedBot) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      await createIntegration(wizard.buildReuseInput(selectedBot, reuseContext(wantShared)))
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
      busyRef.current = false
    }
  }

  // Webhook path: create the capability URL, optionally minting an HMAC secret,
  // then flip to the endpoint/reveal step. There is no fixed prompt — the
  // agent's description is standing context and the delivery payload speaks.
  const submitHook = async () => {
    if (busyRef.current || createdHook) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      const created = await createHook({
        agentId: agent.id,
        name: hookName.trim() || `${agent.name}-webhook`,
        sessionMode: hookSessionMode,
        hmac: hookHmac
      })
      setCreatedHook(created)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
      busyRef.current = false
    }
  }

  // Keep the inline message editor fitted to its wrapped content inside the curl block.
  useEffect(() => {
    const el = hookMessageRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [hookTestMessage, createdHook])

  // Sign the test body with the just-minted secret so the snippet is
  // runnable verbatim. Failure (no WebCrypto) degrades to a placeholder header.
  useEffect(() => {
    const secret = createdHook?.hmacSecret
    if (!secret) return
    let alive = true
    const body = hookTestBody(hookTestMessage)
    setTestSig(null)
    hmacSha256Hex(secret, body).then(
      (hex) => alive && setTestSig({ body, hex }),
      () => alive && setTestSig(null)
    )
    return () => {
      alive = false
    }
  }, [createdHook, hookTestMessage])

  // GitHub: probe installations on first pick (doubles as the enabled-probe).
  useEffect(() => {
    if (platform !== 'github' || gh !== null) return
    let alive = true
    fetchGithubInstallations().then(
      (r) => alive && setGh(r),
      () => alive && setGh({ enabled: false, installations: [] })
    )
    return () => {
      alive = false
    }
  }, [platform, gh])

  // Repo pick list: merge pages from every installation as soon as they arrive.
  // GitHub offers no server-side search for App installations, so the dropdown
  // filters the progressively loaded App-visible roster client-side.
  useEffect(() => {
    if (platform !== 'github' || !gh?.enabled || gh.installations.length === 0) return
    let alive = true
    const ctrl = new AbortController()
    setGhPrivateReposHidden(false)
    const applyRoster = (incoming: GithubRepoChoice[]) => {
      if (!alive) return
      setGhRepos((current) => {
        const merged = new Map(incoming.map((repo) => [repo.fullName.toLowerCase(), repo]))
        for (const repo of current ?? []) {
          const key = repo.fullName.toLowerCase()
          if (!merged.has(key)) merged.set(key, repo)
        }
        return [...merged.values()]
      })
    }
    void fetchGithubRepoRoster(gh.installations, ctrl.signal, applyRoster).then(
      ({ repos, privateReposHidden, failed }) => {
        if (!alive) return
        // A failed roster read (GitHub outage) must not render as an empty
        // list — keep the pages that loaded and surface the gap with a retry.
        setGhReposError(failed ? 'failed' : null)
        setGhPrivateReposHidden(privateReposHidden)
        applyRoster(repos)
      }
    )
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [platform, gh, ghReposNonce])

  // Resolve a complete owner/repo input directly as a fallback if a paged
  // roster request failed or the repository appeared after the roster loaded.
  const ghTypedRepo = /^[^/\s]+\/[^/\s]+$/.test(ghQ.trim()) ? ghQ.trim() : null
  const ghExactAlreadyLoaded =
    !!ghTypedRepo && ghRepos?.some((repo) => repo.fullName.toLowerCase() === ghTypedRepo.toLowerCase())
  useEffect(() => {
    if (
      platform !== 'github' ||
      !ghRepoOpen ||
      !gh?.enabled ||
      gh.installations.length === 0 ||
      !ghTypedRepo ||
      ghExactAlreadyLoaded
    ) {
      setGhExactRepoLoading(false)
      return
    }

    const [owner, repo] = ghTypedRepo.split('/')
    if (!owner || !repo) {
      setGhExactRepoLoading(false)
      return
    }

    let alive = true
    const ctrl = new AbortController()
    setGhExactRepoLoading(true)
    const timer = window.setTimeout(() => {
      const matchingInstallations = gh.installations.filter(
        (installation) => installation.accountLogin.toLowerCase() === owner.toLowerCase()
      )
      const candidates = matchingInstallations.length > 0 ? matchingInstallations : gh.installations
      void Promise.all(
        candidates.map(async (installation) => {
          const found = await fetchGithubInstallationRepo(installation.id, owner, repo, ctrl.signal).catch(() => null)
          return found ? { ...found, installationId: installation.id } : null
        })
      )
        .then((matches) => {
          if (!alive || ctrl.signal.aborted) return
          const found = matches.find((match): match is GithubRepoChoice => match !== null)
          if (!found) return
          setGhRepos((current) => {
            const repos = current ?? []
            return repos.some(
              (candidate) =>
                candidate.installationId === found.installationId &&
                candidate.fullName.toLowerCase() === found.fullName.toLowerCase()
            )
              ? repos
              : [...repos, found]
          })
        })
        .finally(() => {
          if (alive && !ctrl.signal.aborted) setGhExactRepoLoading(false)
        })
    }, 250)

    return () => {
      alive = false
      ctrl.abort()
      window.clearTimeout(timer)
    }
  }, [platform, ghRepoOpen, gh, ghTypedRepo, ghExactAlreadyLoaded])

  // Install deep link is minted fresh per click (one-shot signed state).
  const openGhInstall = async () => {
    const url = await fetchGithubInstallUrl().catch(() => null)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  const syncGh = async () => {
    if (ghSyncing) return
    setGhSyncing(true)
    setErr(null)
    try {
      const installations = await syncGithubInstallations()
      setGh({ enabled: true, installations })
      setGhReposError(null)
      setGhPrivateReposHidden(false)
      setGhRepos(null) // fresh install set ⇒ re-pull the repo list
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGhSyncing(false)
    }
  }

  const toggleGhFam = (fam: GhFamily) => {
    setGhFams((prev) => {
      const next = new Set(prev)
      if (next.has(fam)) next.delete(fam)
      else next.add(fam)
      return next
    })
  }

  const toggleGlFam = (fam: GlFamily) => {
    setGlFams((prev) => {
      const next = new Set(prev)
      if (next.has(fam)) next.delete(fam)
      else next.add(fam)
      return next
    })
  }

  const authorizeSelectedRepo = async () => {
    if (!ghRepoPick || ghAccessSaving) return
    if (ghSelectedIsWorkspace) {
      if (ghNeededAccess === 'none' || repoAccessSatisfies(ghRepoAccess, ghNeededAccess)) return
      setGhAccessSaving(true)
      setErr(null)
      try {
        await updateAgent(agent.id, { gitAccess: 'write' })
        setGhWorkspaceAccessOverride('write')
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setGhAccessSaving(false)
      }
      return
    }
    if (!ghSelectedAuthorization) {
      setAuthRepoFor({ repo: ghRepoPick, access: ghNeededAccess === 'none' ? 'read' : ghNeededAccess })
      return
    }
    if (ghNeededAccess === 'none' || repoAccessSatisfies(ghSelectedAuthorization.access, ghNeededAccess)) return
    setGhAccessSaving(true)
    setErr(null)
    try {
      const updated = await updateAgentRepo(agent.id, ghSelectedAuthorization.id, { access: ghNeededAccess })
      void mutateAgentRepos((rows) => rows?.map((row) => (row.id === updated.id ? updated : row)), {
        revalidate: false
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGhAccessSaving(false)
    }
  }

  const glPicked = gl.choices.find((choice) => choice.projectId === glProject)
  const glMatches = matchGitlabProjects(gl.choices, glQ)

  // Picking an unadded project provisions it first; the pick lands on the
  // binding the saga produced, so a failed setup selects nothing.
  const pickGlProject = async (choice: GitlabProjectChoice) => {
    if (!choice.binding && !(await gl.provision(choice.projectId))) return
    setGlProject(choice.projectId)
    setGlOpen(false)
    setErr(null)
  }
  // One hook per (agent, project, FAMILY) — the CP 409s a duplicate family, so
  // the picker takes the taken families out of the offer first.
  const glWatchedFamilies = useMemo(() => {
    const byProject = new Map<string, Set<GlFamily>>()
    for (const h of agentHooksData ?? []) {
      if (h.kind !== 'gitlab' || !h.repoId) continue
      const key = h.repoId.toString()
      const taken = byProject.get(key) ?? new Set<GlFamily>()
      // A null-family legacy row still blocks every family its events cover.
      for (const { fam } of GL_FAMILIES) {
        if (h.family ? h.family === fam : gitlabFamCovered(h.events, fam)) taken.add(fam)
      }
      byProject.set(key, taken)
    }
    return byProject
  }, [agentHooksData])
  const glPickedWatched = (glProject && glWatchedFamilies.get(glProject)) || new Set<GlFamily>()
  const glAlreadyWatched = !!glProject && GL_FAMILIES.every(({ fam }) => glPickedWatched.has(fam))
  const glSelectedFams = GL_FAMILIES.map(({ fam }) => fam).filter((fam) => glFams.has(fam) && !glPickedWatched.has(fam))
  // Reviews and the run note ride the merge-request row only.
  const glMrSelected = glSelectedFams.includes('merge_request')
  const glEffectiveReviewPolicy: HookReviewPolicy = glMrSelected ? glReviewPolicy : 'off'
  const glEffectiveReportingMode: HookReportingMode = glMrSelected ? glReportingMode : 'off'
  // §8.3: a trigger never creates a grant, so the watched project must already be the
  // agent's workspace project or an authorized additional one — the CP 409s anything
  // else, and saying so here beats letting the user reach a refusal at the last click.
  const glProjectAuthorized =
    !glProject ||
    (agent.workspace.mode === 'git' && agent.workspace.provider === 'gitlab' && agent.workspace.repoId === glProject) ||
    authorizedRepos.some((r) => repoAuthProvider(r) === 'gitlab' && r.repoId === glProject)

  // One subscription = one hook row PER SELECTED FAMILY on this agent, each with
  // its OWN cadence, all named after the project. The creates run in order; a
  // failure part-way leaves the earlier families created, which the refreshed
  // picker then shows as watched.
  const submitGitlab = async () => {
    if (busyRef.current || !glProject || glSelectedFams.length === 0) return
    if (glAlreadyWatched) {
      setErr(
        `This agent already watches ${glPicked?.projectPath ?? 'this project'} — edit its events on the agent page instead.`
      )
      return
    }
    // §8.3, the same refusal the CP would return — said here instead of after a round trip.
    if (!glProjectAuthorized) {
      setErr(
        `This agent isn’t authorized for ${glPicked?.projectPath ?? 'this project'} — authorize the project on the agent’s Workspace tab, or make it the agent’s workspace project, then create the trigger.`
      )
      return
    }
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      for (const fam of glSelectedFams) {
        const reviews = gitlabFamilyCarriesReviews(fam)
        await createGitlabHook({
          agentId: agent.id,
          name: glPicked?.projectPath ?? glProject,
          projectId: glProject,
          family: fam,
          ...gitlabFamilySubscription(fam, glModeOf(fam)),
          reviewPolicy: reviews ? glEffectiveReviewPolicy : 'off',
          reportingMode: reviews ? glEffectiveReportingMode : 'off'
        })
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void mutateAgentHooks()
      setSaving(false)
      busyRef.current = false
    }
  }

  // One subscription = one hook row PER SELECTED FAMILY on this agent, each with
  // its OWN cadence, all named after the repo. The CP resolves owner/repo to the
  // numeric id, 400s anything outside the grant, and 409s a (repo, family) this
  // agent already watches.
  const submitGithub = async () => {
    if (busyRef.current || !ghRepoPick || ghSelectedFams.length === 0) return
    if (repoFullyWatched(ghRepoPick)) {
      setErr(`This agent already watches ${ghRepoPick} — edit its events on the agent page instead.`)
      return
    }
    const needsAdditionalGrant = ghRepoAccess === 'none'
    if (needsAdditionalGrant) {
      if (!canEditAgent) {
        setErr(`Ask an editor to authorize ${ghRepoPick} for this agent first.`)
        return
      }
      setAuthRepoFor({ repo: ghRepoPick, access: ghNeededAccess === 'none' ? 'read' : ghNeededAccess })
      return
    }
    if (!repoAccessSatisfies(ghRepoAccess, ghNeededAccess)) {
      setErr(`This review/check configuration needs write access to ${ghRepoPick}. Use Upgrade access above first.`)
      return
    }
    if (ghEffectiveReviewPolicy !== 'off' && !hasPullRequestsWritePermission(ghSelectedInstallation)) {
      setErr(
        ghSelectedInstallation?.pullRequestsPermission === 'missing'
          ? 'The repository’s GitHub App installation must grant Pull requests write permission first.'
          : ghSelectedInstallation?.pullRequestsPermission === 'read'
            ? 'The repository’s GitHub App installation must upgrade Pull requests permission from read to write first.'
            : 'The repository’s Pull requests write permission could not be confirmed. Sync the installation first.'
      )
      return
    }
    if (
      ghEffectiveReportingMode === 'check' &&
      (!hasChecksWritePermission(ghSelectedInstallation) || !hasPullRequestsReadPermission(ghSelectedInstallation))
    ) {
      setErr(
        !hasChecksWritePermission(ghSelectedInstallation)
          ? ghSelectedInstallation?.checksPermission === 'missing'
            ? 'The repository’s GitHub App installation must accept the updated Checks permission first.'
            : 'The repository’s Checks write permission could not be confirmed. Sync or update the installation first.'
          : ghSelectedInstallation?.pullRequestsPermission === 'missing'
            ? 'The repository’s GitHub App installation must grant Pull requests read permission first.'
            : 'The repository’s Pull requests read permission could not be confirmed. Sync the installation first.'
      )
      return
    }
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      for (const fam of ghSelectedFams) {
        const reviews = githubFamilyCarriesReviews(fam)
        await createGithubHook({
          agentId: agent.id,
          name: ghRepoPick,
          repoFullName: ghRepoPick,
          family: fam,
          ...githubFamilySubscription(fam, ghModeOf(fam)),
          reviewPolicy: reviews ? ghEffectiveReviewPolicy : 'off',
          reportingMode: reviews ? ghEffectiveReportingMode : 'off',
          gateMode: 'informational'
        })
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void mutateAgentHooks()
      setSaving(false)
      busyRef.current = false
    }
  }

  const copyHookField = async (which: 'url' | 'secret' | 'curl', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedHook(which)
      setTimeout(() => setCopiedHook(null), 1600)
    } catch {
      /* clipboard unavailable — the value is visible to select manually */
    }
  }

  // The footer primary. The webhook path is two-step: create (mints a URL and
  // optional secret) → reveal → Done. Reuse is platform-free — the label and the
  // "a bot is selected" enablement are the same everywhere. Everything else is
  // whatever the active fragment published (`WizardHost.setFooter`), and the
  // fragment bakes its own busy label / disabled state into that publication.
  const identityHidden = identityView?.hidden === true
  const footer =
    platform === 'webhook'
      ? createdHook
        ? { label: 'Done', act: onClose, enabled: true, hidden: false }
        : { label: 'Create webhook', act: () => void submitHook(), enabled: true, hidden: false }
      : platform === 'github'
        ? {
            label: 'Connect',
            act: () => void submitGithub(),
            enabled: !!ghRepoPick && !ghRepoAlreadyWatched && ghSelectedFams.length > 0 && !ghReviewSettingsBlocked,
            hidden: false
          }
        : platform === 'gitlab'
          ? {
              label: 'Connect',
              act: () => void submitGitlab(),
              enabled: !!glProject && !glAlreadyWatched && glProjectAuthorized && glSelectedFams.length > 0,
              hidden: false
            }
          : mode === 'existing'
            ? {
                label: 'Connect & authorize',
                act: () => void submitReuse(),
                enabled: selectedBotId !== null,
                hidden: false
              }
            : {
                label: footerView?.label ?? 'Connect & authorize',
                act: () => footerRef.current?.onSubmit(),
                enabled: footerView?.enabled === true,
                hidden: footerView?.hidden === true
              }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="plug" size={17} color="var(--brand)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[16px] font-semibold leading-normal">Add integration</div>
          <div className="mt-[1px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {agentChoices ? (
              // The Agent field below names the target — repeating it here would
              // read as fixed, which is the one thing this arm is not.
              'Connect a chat platform, webhook or repository to one of your agents'
            ) : (
              <>
                for <span className="mono">{agentLabel(agent)}</span> — this agent answers on the workspace
              </>
            )}
          </div>
        </div>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        {agentChoices && onPickAgent && (
          <div className="mb-[18px]">
            <div className="fldlbl mb-2">Agent</div>
            <AgentPicker agents={agentChoices} value={agent.id} onPick={onPickAgent} />
            <div className="mt-[7px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              <span className="mono">{agentLabel(agent)}</span> handles messages from this integration.
            </div>
          </div>
        )}
        <div className="fldlbl mb-2">Platform</div>
        {/* One column per offered tile — complete literal strings, so every tile shares
            the one row (the flagged GitLab tile widens it rather than wrapping below). */}
        <div
          className={`mb-[18px] grid grid-cols-2 gap-2 ${
            platformTiles.length > 7
              ? 'desktop:grid-cols-8'
              : platformTiles.length > 6
                ? 'desktop:grid-cols-7'
                : 'desktop:grid-cols-6'
          }`}
        >
          {platformTiles.map((candidate) => {
            const available = isPlatformAvailable(candidate.key)
            const on = available && platform === candidate.key
            return (
              <div
                key={candidate.key}
                className={`${on ? 'ptile on' : 'ptile'} desktop:flex-col desktop:justify-center desktop:gap-[5px] desktop:px-1.5 desktop:py-[9px] desktop:text-center ${
                  available ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                }`}
                aria-disabled={!available}
                title={available ? undefined : 'Not supported by this daemon'}
                onClick={available ? () => pickPlatform(candidate.key) : undefined}
              >
                {candidate.key === 'github' ? (
                  <span className="flex h-[22px] w-[22px] flex-none items-center justify-center [&>svg]:h-full [&>svg]:w-full">
                    <GithubMark />
                  </span>
                ) : (
                  <span className="flex h-[22px] w-[22px] flex-none items-center justify-center">
                    <PlatformMark platform={candidate.key} fillPct={100} />
                  </span>
                )}
                {candidate.key === 'feishu' ? (
                  <LarkFeishuSwitcher
                    value={feishuRegion}
                    // `regionLocked`: the active fragment has a started,
                    // region-bound flow (a pending Feishu registration), which
                    // a switch here would silently relabel as the other cloud.
                    disabled={!available || !!createdHook || regionLocked}
                    onSwitch={(next) => {
                      if (platform !== 'feishu') pickPlatform('feishu')
                      setFeishuRegion(next)
                    }}
                  />
                ) : (
                  <span className="font-sans text-[12px] font-semibold leading-normal">{candidate.label}</span>
                )}
              </div>
            )
          })}
        </div>
        {platform === 'webhook' && !createdHook && (
          <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
            <div className="fld">
              <span className="fldlbl">Name</span>
              <input
                className="inp mn"
                placeholder={`${agent.name}-webhook`}
                value={hookName}
                onChange={(e) => setHookName(e.target.value)}
              />
            </div>
            <div className="fld mt-3">
              <span className="fldlbl">Session continuity</span>
              <select
                className="inp mn"
                value={hookSessionMode}
                onChange={(e) => setHookSessionMode(e.target.value as 'perDelivery' | 'perSubject' | 'shared')}
              >
                <option value="perDelivery">New session per delivery</option>
                <option value="perSubject">One session per subject (X-AC-Session-Key header)</option>
                <option value="shared">One shared session for the whole hook</option>
              </select>
              {hookSessionMode === 'perSubject' && (
                <div className="mt-1.5 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  Deliveries carrying the same <span className="mono">X-AC-Session-Key</span> header continue one
                  session — one ticket, one conversation. A delivery without the header starts its own session.
                </div>
              )}
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-md border border-(--border-default) bg-(--surface-card) px-3 py-[10px]">
              <input
                type="checkbox"
                className="mt-[2px] flex-none accent-(--brand)"
                checked={hookHmac}
                onChange={(e) => setHookHmac(e.target.checked)}
              />
              <span className="font-sans text-[12px] font-medium leading-[1.5] text-(--text-secondary)">
                Require HMAC signature
              </span>
            </label>
            <div className="mt-3 flex items-start gap-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              <Icon name="info" size={13} className="mt-[1px] flex-none" />
              <span>
                The payload is the message — the <span className="mono">message</span> field in your JSON tells the
                agent what to do. The generated URL contains a random token and works like an API key; keep it private.
              </span>
            </div>
          </div>
        )}
        {platform === 'webhook' && createdHook && (
          <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
            <div className="fldlbl mb-2">Inbound endpoint</div>
            <div className="flex items-center gap-2 rounded-[9px] border border-(--border-default) bg-(--surface-card) py-[6px] pr-[6px] pl-3">
              <span className="mono flex-none rounded bg-(--surface-active) px-[7px] py-[2px] text-[11px] font-semibold text-(--text-secondary)">
                POST
              </span>
              <span className="mono min-w-0 flex-1 truncate text-[12.5px]">{createdHook.url ?? '—'}</span>
              <button
                className="iconbtn flex-none"
                title="Copy URL"
                onClick={() => createdHook.url && void copyHookField('url', createdHook.url)}
              >
                <Icon name={copiedHook === 'url' ? 'check' : 'copy'} size={14} />
              </button>
            </div>
            <div className="mt-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              Send a JSON POST here and each request runs this agent — the payload is the message (the{' '}
              <span className="mono">message</span> field speaks for the caller). Keep the full URL private: its random
              token authenticates each request.
            </div>
            {createdHook.hmacSecret && (
              <div className="mt-[14px] border-t border-dashed border-(--border-default) pt-[13px]">
                <div className="mb-2 flex items-center gap-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                  <Icon name="shield-check" size={14} color="var(--brand)" className="flex-none" />
                  Signing secret — sign every request
                </div>
                <div className="flex items-center gap-2 rounded-[9px] border border-(--border-default) bg-(--surface-card) py-[6px] pr-[6px] pl-3">
                  <span className="mono min-w-0 flex-1 truncate text-[12.5px]">{createdHook.hmacSecret}</span>
                  <button
                    className="iconbtn flex-none"
                    title="Copy secret"
                    onClick={() => void copyHookField('secret', createdHook.hmacSecret!)}
                  >
                    <Icon name={copiedHook === 'secret' ? 'check' : 'copy'} size={14} />
                  </button>
                </div>
                <div className="mt-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  Send <span className="mono">X-AC-Signature: sha256=&lt;hmac&gt;</span> computed over the raw request
                  body. The signature is verified before the request reaches the agent.{' '}
                  <span className="font-medium text-(--text-secondary)">Shown only once — copy it now.</span>
                </div>
              </div>
            )}
            {createdHook.url && (
              <div className="mt-[14px] border-t border-dashed border-(--border-default) pt-[13px]">
                <div className="mb-2 flex items-center gap-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                  <Icon name="terminal" size={14} className="flex-none" />
                  Send a test delivery
                </div>
                {(() => {
                  const body = hookTestBody(hookTestMessage)
                  const requiresSignature = !!createdHook.hmacSecret
                  const currentSig = testSig?.body === body ? testSig.hex : null
                  const curl = hookTestCurl(
                    createdHook.url,
                    createdHook.hmacSecret ? currentSig : null,
                    body,
                    requiresSignature
                  )
                  const canCopyCurl = !requiresSignature || !!currentSig
                  return (
                    <div className="relative">
                      <div className="codedark pr-11">
                        <div>{`curl -X POST ${createdHook.url} \\`}</div>
                        <div>{"  -H 'Content-Type: application/json' \\"}</div>
                        {requiresSignature && (
                          <div>{`  -H 'X-AC-Signature: sha256=${currentSig ?? '<calculating>'}' \\`}</div>
                        )}
                        <div className="flex flex-wrap items-start">
                          <span>{'  -d \'{"message":"'}</span>
                          <textarea
                            ref={hookMessageRef}
                            className="mx-[2px] min-h-[20px] min-w-[18ch] flex-1 resize-none overflow-hidden rounded-xs border border-(--gray-800) bg-(--gray-900) px-[3px] py-0 font-mono text-[12px] leading-[1.65] text-[#cdd6e0] outline-none focus:border-(--brand)"
                            rows={1}
                            spellCheck={false}
                            aria-label="Webhook test message"
                            value={hookTestMessage}
                            onChange={(e) => setHookTestMessage(e.target.value)}
                          />
                          <span>{'"}\''}</span>
                        </div>
                      </div>
                      <button
                        className={`absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-md border border-white/15 bg-white/5 ${
                          canCopyCurl ? 'cursor-pointer' : 'cursor-default opacity-50'
                        }`}
                        title="Copy command"
                        disabled={!canCopyCurl}
                        onClick={() => canCopyCurl && void copyHookField('curl', curl)}
                      >
                        <Icon name={copiedHook === 'curl' ? 'check' : 'copy'} size={13} color="#cdd6e0" />
                      </button>
                    </div>
                  )
                })()}
                <div className="mt-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  Fire this from your terminal to confirm the agent is receiving — it opens a session just like a real
                  delivery.
                </div>
              </div>
            )}
          </div>
        )}
        {platform === 'github' && (
          <>
            {gh === null ? (
              <div className="mb-4 flex items-center gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                <Icon name="loader" size={15} className="flex-none animate-spin" />
                Checking your GitHub setup…
              </div>
            ) : !gh.enabled ? (
              <div className="mb-4 flex items-start gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                <Icon name="info" size={15} className="mt-[1px] flex-none" />
                <span>
                  The GitHub App isn&rsquo;t configured on this deployment — set the{' '}
                  <span className="mono">GITHUB_APP_*</span> control-plane env to enable repository subscriptions.
                </span>
              </div>
            ) : gh.installations.length === 0 ? (
              <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
                <div className="font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
                  Connect GitHub to watch repos
                </div>
                <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  Install the AgentConnect GitHub app to subscribe this agent to issue and pull-request events. You
                  choose which repos it can read.
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button size="sm" onClick={() => void openGhInstall()}>
                    <span className="flex h-4 w-4 items-center justify-center">
                      <GithubMark color="#fff" />
                    </span>
                    Install GitHub app
                  </Button>
                  <button
                    type="button"
                    className="lnk inline-flex items-center gap-[6px]"
                    onClick={() => void syncGh()}
                  >
                    <Icon
                      name={ghSyncing ? 'loader' : 'refresh-cw'}
                      size={13}
                      className={ghSyncing ? 'animate-spin' : undefined}
                    />
                    I&rsquo;ve installed it — sync
                  </button>
                  <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                    Opens github.com in a new tab
                  </span>
                </div>
              </div>
            ) : (
              <>
                {(() => {
                  // The picker lists EVERY repo the GitHub App can see (ghRepos).
                  // Workspace + already-authorized repos are directly watchable.
                  // An unauthorized row may be selected so the user can finish
                  // review/check settings first; the review panel then opens the
                  // grant dialog at the minimum required tier. The CP still 409s an
                  // unauthorized watch as the backstop.
                  const pickedRepo = ghRepos?.find((r) => r.fullName === ghRepoPick)
                  const q = ghQ.trim().toLowerCase()
                  const wsLc = wsRepo?.toLowerCase() ?? null
                  const authByName = new Map(authorizedRepos.map((r) => [r.repoFullName.toLowerCase(), r.access]))
                  const reposLoading = ghRepos === null
                  const grantsLoading = agentReposData === undefined
                  // Both must be in before rows render — otherwise grants-still-
                  // loading would paint every row as unauthorized.
                  const loading = reposLoading || grantsLoading
                  // Row source. GitHub-App and scratch workspaces list every
                  // App-visible repo; scratch simply has no implicit workspace
                  // row. A manual GitHub workspace remains fixed to its repo.
                  const wsMeta = wsLc ? ghRepos?.find((r) => r.fullName.toLowerCase() === wsLc) : undefined
                  const listSource: { fullName: string; private: boolean; description: string | null }[] =
                    canAuthorizeAdditionalRepos
                      ? (ghRepos ?? [])
                      : wsRepo
                        ? [
                            {
                              fullName: wsRepo,
                              private: wsMeta ? wsMeta.private : true,
                              description: wsMeta?.description ?? null
                            }
                          ]
                        : []
                  // Filtered by the query; workspace + authorized ones surface
                  // first (stable sort keeps GitHub's order within each rank).
                  const repoRows = listSource
                    .filter((r) => !q || r.fullName.toLowerCase().includes(q))
                    .map((r) => {
                      const lc = r.fullName.toLowerCase()
                      return {
                        repo: r,
                        watched: repoFullyWatched(lc),
                        isWorkspace: wsLc === lc,
                        authTier: authByName.get(lc)
                      }
                    })
                    .sort((a, b) => {
                      const ra = a.isWorkspace ? 0 : a.authTier ? 1 : 2
                      const rb = b.isWorkspace ? 0 : b.authTier ? 1 : 2
                      return ra - rb
                    })
                  // A typed owner/repo the current metadata roster doesn't
                  // cover — offer to authorize / pick it anyway; the CP
                  // re-validates against the installations either way.
                  const typedRepo = ghTypedRepo
                  const typedLc = typedRepo?.toLowerCase() ?? null
                  const typedInList = !!typedLc && listSource.some((r) => r.fullName.toLowerCase() === typedLc)
                  const typedWatched = !!typedLc && repoFullyWatched(typedLc)
                  const typedWorkspace = !!typedLc && wsLc === typedLc
                  const typedAuthorized = !!typedLc && authByName.has(typedLc)
                  return (
                    <div className="fld relative mb-[18px] min-w-0">
                      <span className="fldlbl">Repository</span>
                      <div
                        className="inp min-w-0 cursor-pointer gap-2"
                        onClick={() => {
                          setGhQ('')
                          setGhRepoOpen((v) => !v)
                        }}
                      >
                        <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
                          {ghRepoPick ? (
                            <>
                              <Icon
                                name={pickedRepo && !pickedRepo.private ? 'book-marked' : 'lock'}
                                size={16}
                                color="var(--text-tertiary)"
                                className="flex-none"
                              />
                              <span
                                className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium leading-normal"
                                title={ghRepoPick}
                              >
                                {ghRepoPick}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="imark h-4 w-4 flex-none border-0 bg-transparent">
                                <GithubMark color="var(--text-secondary)" />
                              </span>
                              <span className="truncate text-(--text-tertiary)">
                                {loading ? 'Loading repositories…' : 'Pick a repository'}
                              </span>
                            </>
                          )}
                        </span>
                        <Icon name="chevron-down" size={15} color="var(--text-tertiary)" />
                      </div>
                      {ghPrivateReposHidden ? (
                        <GithubPrivateReposNotice profileHref={orgPath('/profile#sign-in-methods')} />
                      ) : null}
                      {ghRepoOpen && (
                        <>
                          <div className="fscrim" onClick={() => setGhRepoOpen(false)} />
                          <div className="fmenu left-0 right-0 z-40 min-w-0 rounded-lg p-2 shadow-(--shadow-xl)">
                            <input
                              className="fsearch h-10 rounded-md px-3 font-sans text-[13px] font-medium leading-normal"
                              value={ghQ}
                              onChange={(e) => setGhQ(e.target.value)}
                              placeholder="Search or type owner/repo…"
                              autoFocus
                            />
                            {loading ? (
                              <div className="px-2 py-[7px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                                Loading repositories…
                              </div>
                            ) : (
                              <>
                                {ghReposError === 'failed' && (
                                  <div className="flex items-center gap-2 px-2 py-[7px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                                    <span className="min-w-0 flex-1">
                                      Couldn’t load repositories from GitHub — the list may be incomplete.
                                    </span>
                                    <button
                                      type="button"
                                      className="lnk flex-none text-[12px]"
                                      onClick={() => {
                                        invalidateGithubRepoRosterCache()
                                        setGhReposError(null)
                                        setGhPrivateReposHidden(false)
                                        setGhRepos(null) // re-arms the roster effect
                                        setGhReposNonce((value) => value + 1)
                                      }}
                                    >
                                      Retry
                                    </button>
                                  </div>
                                )}
                                {repoRows.map(({ repo, watched, isWorkspace, authTier }) => {
                                  const unauthorized = !isWorkspace && !authTier
                                  const editable = canEditAgent && canAuthorizeAdditionalRepos
                                  // Unauthorized + no edit rights ⇒ dead row (an
                                  // editor must authorize it first).
                                  const blockedNoEdit = unauthorized && !editable
                                  const disabled = watched || blockedNoEdit
                                  return (
                                    <button
                                      key={repo.fullName}
                                      className={`fopt min-h-[46px] items-center gap-3 px-2 py-2 ${disabled ? 'cursor-default opacity-55' : ''}`}
                                      disabled={disabled}
                                      onClick={() => {
                                        if (disabled) return
                                        setGhRepoPick(repo.fullName)
                                        setGhRepoOpen(false)
                                      }}
                                    >
                                      <Icon
                                        name={repo.private ? 'lock' : 'book-marked'}
                                        size={16}
                                        color="var(--text-tertiary)"
                                        className="flex-none"
                                      />
                                      <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
                                        <span
                                          className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)"
                                          title={repo.fullName}
                                        >
                                          {repo.fullName}
                                        </span>
                                        <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                                          {watched
                                            ? 'Already watched by this agent'
                                            : isWorkspace
                                              ? 'The agent’s workspace repository'
                                              : authTier
                                                ? (repo.description ?? 'Authorized for this agent')
                                                : blockedNoEdit
                                                  ? 'Ask an editor to authorize this repository'
                                                  : (repo.description ??
                                                    'Not yet authorized — review settings will request access')}
                                        </span>
                                      </span>
                                      {watched ? (
                                        <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">
                                          added
                                        </span>
                                      ) : (
                                        <>
                                          {isWorkspace ? (
                                            <span className="badge flex-none bg-(--surface-app) text-(--text-tertiary)">
                                              workspace
                                            </span>
                                          ) : authTier ? (
                                            <span className={REPOSITORY_ACCESS_BADGE[authTier]}>{authTier}</span>
                                          ) : blockedNoEdit ? null : (
                                            <span className="badge flex-none bg-(--surface-app) text-(--brand-soft-text)">
                                              authorize
                                            </span>
                                          )}
                                          {ghRepoPick === repo.fullName && (
                                            <Icon name="check" size={17} color="var(--brand)" />
                                          )}
                                        </>
                                      )}
                                    </button>
                                  )
                                })}
                                {typedRepo && !typedInList && typedWatched && (
                                  <div className="fnohit">This agent already watches {typedRepo}</div>
                                )}
                                {typedRepo && !typedInList && !typedWatched && (typedWorkspace || typedAuthorized) && (
                                  <button
                                    key={`typed:${typedRepo}`}
                                    className="fopt min-h-[46px] items-center gap-3 px-2 py-2"
                                    onClick={() => {
                                      setGhRepoPick(typedRepo)
                                      setGhRepoOpen(false)
                                    }}
                                  >
                                    <Icon
                                      name="book-marked"
                                      size={16}
                                      color="var(--text-tertiary)"
                                      className="flex-none"
                                    />
                                    <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
                                      <span className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                                        {typedRepo}
                                      </span>
                                      <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                                        {typedWorkspace
                                          ? 'The agent’s workspace repository'
                                          : 'Authorized for this agent'}
                                      </span>
                                    </span>
                                  </button>
                                )}
                                {typedRepo &&
                                  !typedInList &&
                                  !typedWatched &&
                                  !typedWorkspace &&
                                  !typedAuthorized &&
                                  ghExactRepoLoading && (
                                    <div className="px-2 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                                      Checking GitHub repository…
                                    </div>
                                  )}
                                {typedRepo &&
                                  !typedInList &&
                                  !typedWatched &&
                                  !typedWorkspace &&
                                  !typedAuthorized &&
                                  !ghExactRepoLoading && (
                                    <div className="flex min-h-[46px] items-center gap-3 px-2 py-2">
                                      <Icon name="lock" size={16} color="var(--text-tertiary)" className="flex-none" />
                                      <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
                                        <span className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                                          {typedRepo}
                                        </span>
                                        <span className="block w-full min-w-0 font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
                                          Not in the list — authorize it for this agent to watch it.
                                        </span>
                                      </span>
                                      {canEditAgent && canAuthorizeAdditionalRepos && (
                                        <button
                                          type="button"
                                          className="lnk flex-none text-[12px]"
                                          onClick={() => {
                                            setAuthRepoFor({
                                              repo: typedRepo,
                                              access: ghNeededAccess === 'none' ? 'read' : ghNeededAccess
                                            })
                                            setGhRepoOpen(false)
                                          }}
                                        >
                                          Authorize…
                                        </button>
                                      )}
                                    </div>
                                  )}
                                {repoRows.length === 0 && !typedRepo && !ghReposError && (
                                  <div className="px-2 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                                    {!canAuthorizeAdditionalRepos
                                      ? `No watchable repositories match “${ghQ}”`
                                      : (ghRepos ?? []).length === 0
                                        ? 'No repositories are visible to the GitHub App — install it on the accounts you want to watch.'
                                        : `No repositories match “${ghQ}”`}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </>
                      )}
                      <div className="font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                        {isGithubAppWs
                          ? 'Lists every repository the GitHub App can see.'
                          : agent.workspace.mode === 'scratch'
                            ? 'This scratch workspace can access explicitly authorized GitHub repositories.'
                            : 'This manual workspace can authorize its repository for review and Check effects.'}{' '}
                        Review settings request write access to post formal reviews and Checks.
                      </div>
                    </div>
                  )
                })()}
                <FamilyCards
                  families={GH_FAMILIES}
                  tilesOf={(fam) => GH_TRIGGER_TILES[fam] ?? []}
                  // A family the picked repo is already watched for is not a
                  // second trigger — it is edited on the agent page.
                  takenOf={(fam) => ghPickedWatched.has(fam)}
                  onOf={(fam) => ghFams.has(fam)}
                  onToggle={toggleGhFam}
                  modeOf={ghModeOf}
                  onPick={(fam, mode) => setGhModes((prev) => ({ ...prev, [fam]: mode }))}
                  familyAttr="data-github-family"
                  triggerAttr="data-github-trigger"
                  titleOf={(mode) =>
                    mode === 'mention'
                      ? githubMentionUsage(agent.name, ghTeamOwner)
                      : githubTriggerTooltip(mode, agent.name)
                  }
                  // Reviews and Checks ride the change-proposal subject, so the
                  // format section lives in that card's body and nowhere else.
                  bodyExtra={(fam) =>
                    githubFamilyCarriesReviews(fam) ? (
                      <GithubReviewSettings
                        layout="format"
                        value={{ reviewPolicy: ghReviewPolicy, reportingMode: ghReportingMode }}
                        onReviewPolicyChange={(policy) => {
                          setGhReviewPolicy(policy)
                          setErr(null)
                        }}
                        onReportingModeChange={(m) => {
                          setGhReportingMode(m)
                          setErr(null)
                        }}
                        repoAccess={ghRepoAccess}
                        installation={ghSelectedInstallation}
                        publicRepo={ghSelectedRepo ? !ghSelectedRepo.private : false}
                        repoSelected={Boolean(ghRepoPick)}
                        canAuthorizeRepo={
                          canEditAgent &&
                          (ghRepoAccess === 'none' || ghSelectedIsWorkspace || ghSelectedAuthorization !== undefined)
                        }
                        authorizingRepo={ghAccessSaving}
                        onAuthorizeRepo={() => void authorizeSelectedRepo()}
                      />
                    ) : null
                  }
                />
              </>
            )}
          </>
        )}
        {platform === 'gitlab' && (
          <>
            {gl.error ? (
              <div className="mb-4 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                Couldn&rsquo;t load your GitLab projects — {gl.error}
              </div>
            ) : gl.loading ? (
              <LoadingState size={20} padding={16} />
            ) : gl.empty ? (
              <div className="mb-4">
                <GitlabNoProjectsNotice
                  connected={gl.connected}
                  enabled={gl.enabled}
                  onConnect={() => void gl.connect()}
                  onSync={gl.reload}
                  syncing={gl.reloading}
                />
              </div>
            ) : (
              <>
                <div className="mb-4">
                  <GitlabProjectField
                    value={glPicked?.projectPath ?? ''}
                    icon="book-marked"
                    loading={false}
                    open={glOpen}
                    query={glQ}
                    onToggle={() => {
                      setGlQ('')
                      setGlOpen((value) => !value)
                    }}
                    onClose={() => setGlOpen(false)}
                    onQueryChange={setGlQ}
                    error={
                      gl.provisionError
                        ? `Couldn’t set up that project — ${gl.provisionError}`
                        : glAlreadyWatched
                          ? `This agent already watches ${glPicked?.projectPath ?? 'this project'}.`
                          : undefined
                    }
                  >
                    {glMatches.map((choice) => (
                      <GitlabProjectOption
                        key={choice.projectId}
                        choice={choice}
                        selected={glProject === choice.projectId}
                        busy={gl.provisioning === choice.projectId}
                        onSelect={() => void pickGlProject(choice)}
                      />
                    ))}
                    {glMatches.length === 0 && <div className="fnohit">No projects match &ldquo;{glQ}&rdquo;</div>}
                  </GitlabProjectField>
                </div>
                {/* §8.3 — stated where the pick is, not only inside the closed dropdown. */}
                {!glProjectAuthorized && (
                  <div className="mb-4 flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                    <Icon name="shield-alert" size={14} className="mt-[1px] flex-none" />
                    <span>
                      This agent isn&rsquo;t authorized for{' '}
                      <span className="mono">{glPicked?.projectPath ?? 'this project'}</span>. Authorize the project on
                      the agent&rsquo;s Workspace tab, or make it the agent&rsquo;s workspace project, then create the
                      trigger.
                    </span>
                  </div>
                )}
                <FamilyCards
                  families={GL_FAMILIES}
                  tilesOf={(fam) => GL_TRIGGER_TILES[fam] ?? []}
                  // A family the picked project is already watched for is not a
                  // second trigger — it is edited on the agent page.
                  takenOf={(fam) => glPickedWatched.has(fam)}
                  onOf={(fam) => glFams.has(fam)}
                  onToggle={toggleGlFam}
                  modeOf={glModeOf}
                  onPick={(fam, mode) => setGlModes((prev) => ({ ...prev, [fam]: mode }))}
                  familyAttr="data-gitlab-family"
                  triggerAttr="data-gitlab-trigger"
                  titleOf={(mode) =>
                    mode === 'mention' ? gitlabMentionUsage(agent.name) : gitlabTriggerTooltip(mode, agent.name)
                  }
                  // Reviews and the run note ride the merge-request subject only.
                  bodyExtra={(fam) =>
                    gitlabFamilyCarriesReviews(fam) ? (
                      <GitlabReviewSettings
                        layout="format"
                        value={{ reviewPolicy: glReviewPolicy, reportingMode: glReportingMode }}
                        onReviewPolicyChange={(policy) => {
                          setGlReviewPolicy(policy)
                          setErr(null)
                        }}
                        onReportingModeChange={(mode) => {
                          setGlReportingMode(mode)
                          setErr(null)
                        }}
                        projectBotReady={!glPicked?.binding || glPicked.binding.state !== 'provisioning'}
                      />
                    ) : null
                  }
                />
              </>
            )}
          </>
        )}
        {wizard && !identityHidden && (
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="fldlbl">Bot identity</div>
            {/* The fragment's way back to its own simpler pane (Slack's built-in
                app). Presentation is the chassis's; the action is the module's. */}
            {identityView?.actionLabel && (
              <button
                type="button"
                onClick={() => identityRef.current?.headerAction?.onSelect()}
                className="flex cursor-pointer items-center gap-[5px] border-0 bg-transparent p-0 font-sans text-[12px] font-semibold leading-normal text-(--brand)"
              >
                <Icon name="undo-2" size={13} />
                {identityView.actionLabel}
              </button>
            )}
          </div>
        )}
        {/* A bot is installed on one agent at a time and OUTLIVES its integration:
            reuse a freed / builtin one, or create a new bot for this platform.
            (Webhook and GitHub are bot-less — their bodies render above instead.) */}
        {wizard && !identityHidden && (
          <div className="mb-3 grid grid-cols-1 gap-[10px] desktop:grid-cols-2">
            {(
              [
                {
                  key: 'create' as const,
                  icon: 'key-round',
                  title: 'Create a new bot',
                  desc: wizard.identityCards(region).create
                },
                {
                  key: 'existing' as const,
                  icon: 'bot',
                  title: 'Use an existing bot',
                  desc: wizard.identityCards(region).existing
                }
              ] as const
            ).map((t) => {
              const on = mode === t.key
              return (
                <div
                  key={t.key}
                  className={`${on ? 'ptile on' : 'ptile'} cursor-pointer items-start`}
                  onClick={() => setModePick(t.key)}
                >
                  <span
                    className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border bg-(--surface-card) ${
                      on ? 'border-(--brand)' : 'border-(--border-default)'
                    }`}
                  >
                    <Icon name={t.icon} size={16} color={on ? 'var(--brand)' : 'var(--text-tertiary)'} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-sans text-[13px] font-semibold leading-normal">{t.title}</div>
                    <div className="mt-[3px] whitespace-nowrap font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
                      {t.desc}
                    </div>
                  </div>
                  <span
                    className={`mt-[3px] h-[14px] w-[14px] flex-none rounded-full bg-(--surface-card) ${
                      on ? 'border-4 border-(--brand)' : 'border-[1.5px] border-(--border-strong)'
                    }`}
                  />
                </div>
              )
            })}
          </div>
        )}
        {wizard && mode === 'existing' && !identityHidden && (
          <div className="mb-4 overflow-hidden rounded-[9px] border border-(--border-subtle)">
            {freeBots.length === 0 && (
              <div className="px-[14px] py-[18px] text-center font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                No free bots yet — bots freed by uninstalling an integration will show up here. Create a new one
                instead.
              </div>
            )}
            {freeBots.map((b) => {
              const on = b.id === selectedBotId
              return (
                <div
                  key={b.id}
                  onClick={() => setBotPick(b.id)}
                  className={`flex cursor-pointer items-center gap-[10px] border-b border-(--border-subtle) px-[13px] py-[11px] ${
                    on ? 'bg-(--brand-soft)' : 'bg-(--surface-card)'
                  }`}
                >
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                    <span className="imark h-4 w-4 border-0 bg-transparent">
                      <PlatformMark platform={platform} />
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-[7px]">
                      <span className="mono text-[13px] font-semibold">{b.name}</span>
                      {b.freedFromAgent && (
                        <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                          freed from {b.freedFromAgent}
                        </span>
                      )}
                      {b.prebuilt && (
                        <span className="badge bg-(--surface-active) text-(--text-tertiary)">builtin</span>
                      )}
                    </div>
                    <div className="mt-[2px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
                      created by {b.createdBy ? creatorLabel(b.createdBy, me) : b.prebuilt ? 'AgentConnect' : '—'} ·{' '}
                      {fmtAgo(b.lastUsedAt)}
                    </div>
                  </div>
                  <span
                    className={`h-[14px] w-[14px] flex-none rounded-full bg-(--surface-card) ${
                      on ? 'border-4 border-(--brand)' : 'border-[1.5px] border-(--border-strong)'
                    }`}
                  />
                </div>
              )
            })}
            <div className="flex items-center gap-2 bg-(--surface-app) px-[13px] py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              <Icon name="info" size={13} className="flex-none" />A bot can be installed on one agent at a time. Freed
              bots show up here.
            </div>
          </div>
        )}
        {/* The active platform's fragment. Keyed by platform so its whole
            sub-form resets by construction on a platform switch. */}
        {wizard && <wizard.Body key={platform} agent={agent} host={host} />}
        <div className="flex items-start gap-2 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="hash" size={14} className="mt-[1px] flex-none" />
          <span>
            {platform === 'webhook'
              ? 'Each POST becomes a session, routed to this agent by the endpoint path. Retries are de-duplicated by the X-AC-Delivery-Key header (auto-assigned when absent).'
              : platform === 'github'
                ? 'Matching events run the agent in a session and reply on the same PR, issue or commit thread.'
                : platform === 'gitlab'
                  ? 'Matching events run the agent in a session and reply on the same issue, merge request or push thread.'
                  : wizard?.inviteHint(region)}
          </span>
        </div>
        {shareToggleAvailable && !identityHidden && (
          <label className="mt-[14px] flex cursor-pointer items-start gap-2.5 rounded-md border border-(--border) px-3 py-[11px]">
            <input
              type="checkbox"
              className="mt-[2px] flex-none"
              checked={wantShared}
              disabled={mode === 'existing' && !!selectedBot?.shareable}
              onChange={(e) => setShared(e.target.checked)}
            />
            <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-2)">
              <span className="font-medium text-(--text-1)">Shared bot</span> — let multiple agents use this one bot.
              {mode === 'existing' && selectedBot?.shareable ? ' This bot is already shared.' : ''}
            </span>
          </label>
        )}
        {err && (
          <div className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
            <Icon name="triangle-alert" size={15} className="mt-[1px] flex-none" />
            {err}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {/* A fragment whose commit is an inline button of its own (Slack's
            built-in pane, the Feishu deeplink) publishes the primary away. */}
        {!identityHidden && !footer.hidden && (
          <Button onClick={footer.act} className={footer.enabled && !saving ? undefined : 'cursor-default opacity-50'}>
            <Icon name={platform === 'webhook' && createdHook ? 'check' : 'plug'} size={15} />
            {saving ? 'Connecting…' : footer.label}
          </Button>
        )}
      </div>
      {/* Repository shortcuts share the Workspace card's editor, then return to
          hook creation with the new grant pre-picked. */}
      {authRepoFor !== null && (
        <EditWorkspaceModal
          agent={agent}
          authorized={authorizedRepos}
          initialRepositoryAuthorization={{
            access: authRepoFor.access,
            ...(authRepoFor.repo ? { repo: authRepoFor.repo } : {})
          }}
          onClose={() => setAuthRepoFor(null)}
          onChanged={() => {
            void refresh()
            setAuthRepoFor(null)
          }}
          onRepositoryCreated={(row) => {
            void mutateAgentRepos((rows) => (rows ? [...rows, row] : [row]), { revalidate: false })
            setGhRepoPick(row.repoFullName)
            setGhQ('')
            setErr(null)
            setAuthRepoFor(null)
          }}
        />
      )}
    </>
  )
}

/** The Agent field of the org-scoped arm. Same anatomy as `RuntimeSelect`: an
 *  `.inp` trigger showing the current choice, an `.fmenu` listbox of the roster.
 *  Only rendered when the dialog was opened without an agent. */
function AgentPicker({ agents, value, onPick }: { agents: Agent[]; value: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const selectedIndex = Math.max(
    0,
    agents.findIndex((a) => a.id === value)
  )
  const selected = agents[selectedIndex]

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => listRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const closeAndFocus = () => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const pick = (id: string) => {
    if (id !== value) onPick(id)
    closeAndFocus()
  }
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + agents.length) % agents.length)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const active = agents[activeIndex]
      if (active) pick(active.id)
      return
    }
    if (event.key === 'Escape') {
      // The dialog closes on Escape too — this one belongs to the open menu.
      event.preventDefault()
      event.stopPropagation()
      closeAndFocus()
      return
    }
    if (event.key === 'Tab') setOpen(false)
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`inp relative w-full cursor-pointer text-left outline-none transition-[background-color,border-color,box-shadow] ${
          open
            ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)'
            : 'hover:border-(--border-strong) hover:bg-(--surface-hover) focus-visible:border-(--border-focus) focus-visible:ring-[3px] focus-visible:ring-(--brand-ring)'
        }`}
        aria-label="Agent"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          setActiveIndex(selectedIndex)
          setOpen((v) => !v)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setActiveIndex(selectedIndex)
          setOpen(true)
        }}
      >
        <span className="inline-flex min-w-0 items-center gap-[9px]">
          <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
            <AgentIconView icon={selected?.icon} runtime={selected?.runtime ?? ''} size={22} />
          </span>
          <span className="mono truncate text-[12.5px]">{selected ? agentLabel(selected) : '—'}</span>
        </span>
        <Icon
          name="chevron-down"
          size={15}
          color="var(--text-tertiary)"
          className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <>
          <div className="fscrim" onClick={() => setOpen(false)} />
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            aria-label="Agent"
            aria-activedescendant={`${listboxId}-option-${activeIndex}`}
            className="fmenu left-0 z-40 max-h-[260px] w-full overflow-y-auto rounded-lg p-2 shadow-(--shadow-xl) outline-none"
            onKeyDown={onListKeyDown}
          >
            {agents.map((a, index) => {
              const isSelected = a.id === value
              return (
                <button
                  key={a.id}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  className={`fopt min-h-10 gap-[9px] rounded-md px-2 py-[6px] ${
                    isSelected
                      ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)'
                      : index === activeIndex
                        ? 'bg-(--surface-hover)'
                        : ''
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(a.id)}
                >
                  <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
                    <AgentIconView icon={a.icon} runtime={a.runtime} size={22} />
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-left text-[12.5px]">{agentLabel(a)}</span>
                  {isSelected && <Icon name="check" size={16} color="var(--brand)" className="flex-none" />}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** Add-integration opened from the Integrations page, where no agent is implied.
 *  The dialog itself is unchanged — it just gains the Agent field — and it is
 *  REMOUNTED per agent (`key`) so nothing agent-scoped (watched repos, authorized
 *  repos, the picked bot, a half-finished platform flow) survives a switch. */
export function AddIntegrationForOrgModal({
  initialPlatform,
  initialFeishuRegion,
  onClose
}: {
  initialPlatform?: Platform
  initialFeishuRegion?: FeishuRegion
  onClose: () => void
}) {
  const { agents } = useConsoleData()
  // Creating an integration writes the agent's spec, so only offer the ones this
  // viewer may edit — the CP would 403 the rest.
  const choices = useMemo(() => agents.filter((a) => a.canEdit), [agents])
  const [agentId, setAgentId] = useState<string | null>(null)
  const agent = choices.find((a) => a.id === agentId) ?? choices[0]

  if (!agent) {
    return (
      <>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
            <Icon name="plug" size={17} color="var(--brand)" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[16px] font-semibold leading-normal">Add integration</div>
          </div>
          <button className="iconbtn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <div className="rounded-[9px] border border-(--border-subtle) bg-(--surface-app) px-4 py-5 text-center font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-tertiary)">
            An integration is answered by an agent, and there is no agent you can edit yet. Create one first — the
            Add-integration step is offered again from the agent&rsquo;s own page.
          </div>
        </div>
        <div className="modalfoot">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </>
    )
  }

  return (
    <AddIntegrationModal
      key={agent.id}
      agent={agent}
      agentChoices={choices}
      onPickAgent={setAgentId}
      initialPlatform={initialPlatform}
      initialFeishuRegion={initialFeishuRegion}
      onClose={onClose}
    />
  )
}
