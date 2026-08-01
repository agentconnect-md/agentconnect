'use client'

// Settings page (design: `isSettings`). Everything here is REAL and scoped to
// the active org: the Organization card (rename via PATCH /orgs/:id, owners
// only), self-service organization leave, Members & roles (GET /members;
// owners can invite-by-email, re-role and remove members — the CP enforces the
// last-owner guard), the Bots card (the org's durable bot identities; free ones
// can be deleted here — the Add-integration picker only offers them for reuse),
// and the Roles explainer.

import { Fragment, useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { Avatar, Button, Icon, Toggle } from '@/components/ui'
import { AgentIconView, GithubMark, LoadingState, PlatformMark } from '@/components/marks'
import type { AgentIcon } from '@/lib/agent-icon'
import { withIconUrl } from '@/lib/agent-icon'
import { AgentIconPicker } from '@/components/console/AgentIconPicker'
import { useModal } from '@/components/console/ModalProvider'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { useOrgs } from '@/lib/org-context'
import { initialsFrom } from '@/lib/auth'
import {
  ApiError,
  createOrgInviteLink,
  creatorLabel,
  fetchGithubInstallUrl,
  fetchGithubInstallations,
  fetchMembers,
  fetchOrgInviteLink,
  fetchSessionExternalAccess,
  memberDisplayName,
  refreshSlackBot,
  getSlackPlatformInstall,
  revokeOrgInviteLink,
  ROLE_LABELS,
  syncGithubInstallations,
  startSlackPlatformInstall,
  putSessionExternalAccess,
  updateOrg,
  uploadOrgIcon,
  type BotDto,
  type GithubInstallationDto,
  type MeDto,
  type MemberDto,
  type MemberRole,
  type OrgInviteLinkDto,
  type SessionAccessProvider,
  type SlackBotRefreshDto
} from '@/lib/api'
import { agentLabel, isDirectConversation, type IntegrationRow } from '@/lib/data'
import { slackAppSettingsUrl } from '@/lib/slack-manifest'
import { slackRefreshNoticeState } from '@/lib/slack-refresh-notice'
import { discordBotInviteUrl } from '@/lib/discord-invite'
import { consoleKeys } from '@/lib/swr-keys'
import { inviteLinkStatus, inviteLinkUrl } from '@/lib/org-invite-link'
import EditMemberModal, { type MemberTarget } from '@/components/console/modals/EditMemberModal'
import InviteMembersModal from '@/components/console/modals/InviteMembersModal'
import DeleteBotModal from '@/components/console/modals/DeleteBotModal'
import UninstallGithubInstallationModal from '@/components/console/modals/UninstallGithubInstallationModal'

// The free-bot sub-line shows where the bot came from without repeating
// historical usage metadata in the list row.
function botSubline(b: BotDto): string {
  return b.freedFromAgent ? `freed from ${b.freedFromAgent}` : b.prebuilt ? 'builtin' : ''
}

function feishuAppSettingsUrl(appId: string | null | undefined, region: 'feishu' | 'lark'): string {
  const host = region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  return appId ? `${host}/app/${encodeURIComponent(appId)}/baseinfo` : `${host}/app`
}

const SESSION_ACCESS_COPY: Record<
  SessionAccessProvider,
  {
    title: string
    unavailable: string
    enabled: string
    disabled: string
    unresolved: (count: number) => string
    degraded: string
  }
> = {
  slack: {
    title: 'Follow Slack conversation access',
    unavailable:
      'Requires OIDC and linked Slack identities. Until then, shared sessions remain visible to Everyone who can view the agent.',
    enabled:
      'Public-channel sessions follow Slack workspace access. Private channels, group DMs, guests, and Slack Connect users require current conversation membership. DMs remain private. Agent memory learned earlier is not erased.',
    disabled:
      'New shared sessions are visible to Everyone who can view the agent. Previously synced sessions keep following Slack. DMs remain private.',
    unresolved: (count) =>
      `${count} historical session${count === 1 ? '' : 's'} lack a trusted Slack scope and remain hidden.`,
    degraded: 'Slack access is degraded; unresolved sessions remain hidden.'
  },
  github: {
    title: 'Follow GitHub repository access',
    unavailable:
      'Requires OIDC and GitHub access checks. Until then, GitHub sessions remain visible to Everyone who can view the agent.',
    enabled:
      'Public repository sessions remain visible to members who can view the agent. Private repository sessions require a linked GitHub profile with current access. Agent memory learned earlier is not erased.',
    disabled:
      'New GitHub sessions are visible to Everyone who can view the agent. Previously synced sessions keep following GitHub.',
    unresolved: (count) =>
      `${count} historical session${count === 1 ? '' : 's'} lack a trusted GitHub repository scope and remain hidden.`,
    degraded: 'GitHub access is degraded; unresolved sessions remain hidden.'
  }
}

function SessionAccessRow({
  provider,
  orgId,
  isOwner,
  bordered = false
}: {
  provider: SessionAccessProvider
  orgId?: string
  isOwner: boolean
  bordered?: boolean
}) {
  const copy = SESSION_ACCESS_COPY[provider]
  const key = consoleKeys.sessionAccess(orgId, provider)
  const {
    data: access,
    error: loadError,
    mutate
  } = useSWR(key, ([, scopedOrgId, , scopedProvider]) => fetchSessionExternalAccess(scopedProvider, scopedOrgId))
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<{ scope: string; message: string } | null>(null)
  const hiddenSessions = access?.hiddenSessions ?? 0
  const scope = `${orgId ?? ''}:${provider}`
  const currentActionError = actionError?.scope === scope ? actionError.message : null

  const setEnabled = async (enabled: boolean) => {
    if (!orgId || !isOwner || busy) return
    setBusy(true)
    setActionError(null)
    try {
      const next = await putSessionExternalAccess(provider, enabled, orgId)
      await mutate(next, { revalidate: false })
    } catch (error) {
      setActionError({ scope, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`flex items-center gap-3 px-4 py-[15px] ${bordered ? 'border-t border-(--border-subtle)' : ''}`}>
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-(--surface-active)">
        {provider === 'slack' ? (
          <PlatformMark platform="slack" fillPct={100} />
        ) : (
          <GithubMark color="var(--text-primary)" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13px] font-semibold leading-normal">{copy.title}</div>
        <div className="mt-[2px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {access?.available === false && !access.enabled
            ? copy.unavailable
            : access?.enabled
              ? copy.enabled
              : copy.disabled}
        </div>
        {(access?.state === 'degraded' || hiddenSessions > 0) && (
          <div className="mt-1 font-sans text-[11.5px] font-medium leading-normal text-(--status-paused)">
            {hiddenSessions > 0 ? copy.unresolved(hiddenSessions) : copy.degraded}
          </div>
        )}
        {(currentActionError || loadError) && (
          <div role="alert" className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--status-error)">
            {currentActionError ?? `Could not load ${provider === 'slack' ? 'Slack' : 'GitHub'} session access.`}
          </div>
        )}
      </div>
      <span title={isOwner ? undefined : 'Only organization owners can change this setting'}>
        <Toggle
          checked={access?.enabled === true}
          disabled={!isOwner || !access || busy || (access.available === false && access.enabled === false)}
          ariaLabel={copy.title}
          onChange={(next) => void setEnabled(next)}
        />
      </span>
    </div>
  )
}

// One rendered member row, precomputed from the wire DTO.
interface MemberRowView {
  userId: string
  name: string
  email: string | null
  picture: string | null
  initials: string
  avBg: string
  avText: string
  roleLabel: string
  roleBg: string
  roleText: string
  role: MemberRole
  isCurrentUser: boolean
}

function rowFromDto(m: MemberDto): MemberRowView {
  const name = memberDisplayName(m)
  const owner = m.role === 'owner'
  return {
    userId: m.userId,
    name,
    email: m.email,
    picture: m.picture,
    initials: initialsFrom(m.name ?? '', m.email ?? undefined),
    avBg: owner ? 'var(--magenta-100)' : 'var(--gray-100)',
    avText: owner ? 'var(--magenta-700)' : 'var(--text-secondary)',
    roleLabel: ROLE_LABELS[m.role],
    roleBg: owner ? 'var(--brand-soft)' : 'var(--surface-active)',
    roleText: owner ? 'var(--brand-soft-text)' : 'var(--text-secondary)',
    role: m.role,
    isCurrentUser: m.isCurrentUser
  }
}

const MEMBER_GRID = 'grid-cols-[2fr_1.4fr_auto]'
// Design grid (`isSettings` Bots card): Bot | Sharable | Agents | Created by |
// actions. The 100px action track fits refresh + platform link + delete and stays
// identical across rows; below 480px "Created by" is dropped to preserve space.
const BOT_GRID = 'grid-cols-[3fr_1.1fr_1fr_100px] min-[480px]:grid-cols-[2fr_0.9fr_1.5fr_1fr_100px]'
const BOT_PLATFORMS = [
  { platform: 'slack', label: 'Slack', noun: 'app' },
  { platform: 'discord', label: 'Discord', noun: 'bot' },
  { platform: 'telegram', label: 'Telegram', noun: 'bot' },
  { platform: 'feishu', label: 'Lark', noun: 'bot' }
] as const
type BotPlatform = (typeof BOT_PLATFORMS)[number]['platform']

type BotRosterRow = { kind: 'workspace'; key: string; label: string } | { kind: 'bot'; key: string; bot: BotDto }

// Preserve the server's bot order within each workspace. The heading is rendered
// only when this produces several groups, so single-workspace organizations keep
// the compact flat list.
function botRosterRows(bots: BotDto[]): BotRosterRow[] {
  const groups = new Map<string, { label: string; bots: BotDto[] }>()
  for (const bot of bots) {
    const workspaceId = bot.workspaceId?.trim() || null
    const workspaceName = bot.workspaceName?.trim() || null
    const key = workspaceId ? `id:${workspaceId}` : workspaceName ? `name:${workspaceName.toLowerCase()}` : 'unknown'
    const current = groups.get(key)
    if (current) {
      if (workspaceName && current.label === workspaceId) current.label = workspaceName
      current.bots.push(bot)
      continue
    }
    groups.set(key, {
      label: workspaceName ?? workspaceId ?? 'Workspace unavailable',
      bots: [bot]
    })
  }
  if (groups.size <= 1) return bots.map((bot) => ({ kind: 'bot', key: bot.id, bot }))
  return [...groups].flatMap(([workspaceKey, group]) => [
    { kind: 'workspace', key: `workspace:${workspaceKey}`, label: group.label },
    ...group.bots.map((bot) => ({ kind: 'bot' as const, key: bot.id, bot }))
  ])
}

// One merged channel row for a bot's expandable roster.
interface BotChannelView {
  channelId: string
  name: string
  kind: 'channel' | 'im' | 'mpim'
  /** Effective per-channel owner; null only before legacy state converges. */
  agentId: string | null
  /** Any integration whose snapshot row backs this channel; ownership PATCHes
   *  are bot-scoped. */
  integrationId: string | null
}

// The bot's channel roster, merged across its installs (a shared bot fans out to
// one integration per agent, each reporting its own membership snapshot).
function botChannels(bot: BotDto, integrations: IntegrationRow[]): BotChannelView[] {
  const merged = new Map<string, BotChannelView>()
  for (const i of integrations) {
    if (i.botId !== bot.id) continue
    for (const c of i.channels) {
      const explicit = c.agentId ?? null
      const prev = merged.get(c.channelId)
      if (!prev) {
        merged.set(c.channelId, {
          channelId: c.channelId,
          name: c.name,
          kind: c.kind ?? 'channel',
          agentId: explicit,
          integrationId: i.id ?? null
        })
      } else if (!prev.agentId && explicit) {
        prev.agentId = explicit
        prev.integrationId = i.id ?? null
      }
    }
  }
  // Channels first, then the direct conversations (DMs and group DMs) under one
  // heading — the roster's second half is "places the bot was not invited to".
  return [...merged.values()].sort((a, b) => {
    const rank = (k: BotChannelView['kind']) => (isDirectConversation(k) ? 1 : 0)
    if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) - rank(b.kind)
    return a.name.localeCompare(b.name)
  })
}

/** Per-channel default dispatch for a SHARED bot (design: the Bots card's
 *  expanded channel rows) — the agent a channel's unmatched messages go to.
 *  Shows the current one and opens a menu of every agent installed on the bot;
 *  picking one PATCHes the channel's explicit owner. This is the full-roster
 *  picker: the agent page's own popover (IntegrationChannelList) only claims the
 *  channel for the agent being viewed. */
function DefaultDispatchPicker({
  options,
  activeId,
  disabled,
  onPick
}: {
  options: { id: string; name: string; model: string; runtime: string; icon?: AgentIcon | null }[]
  activeId: string | null
  disabled: boolean
  onPick: (agentId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const active = options.find((o) => o.id === activeId) ?? options[0]
  const pick = (id: string) => {
    setOpen(false)
    if (disabled || saving || id === active?.id) return
    setSaving(true)
    onPick(id).finally(() => setSaving(false))
  }
  return (
    <span className="relative justify-self-end" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        title="Default dispatch — the agent this channel's unmatched messages go to"
        className={`flex items-center gap-2 rounded-[7px] border-0 bg-transparent px-[5px] py-1 hover:bg-(--surface-hover) ${
          disabled ? 'cursor-default' : 'cursor-pointer'
        } ${saving ? 'opacity-60' : ''}`}
      >
        <span className="av h-5 w-5 rounded-[5px]">
          <AgentIconView icon={active?.icon} runtime={active?.runtime ?? active?.model ?? ''} size={20} />
        </span>
        <span className="mono text-[12.5px] text-(--text-primary)">{active?.name ?? '—'}</span>
        <Icon name="chevron-down" size={13} color="var(--text-tertiary)" />
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          {/* right-anchored: the picker sits in the roster's right-most column, so a
              left-anchored menu (wider than its button) would clip past the card edge */}
          <div className="absolute right-0 top-[calc(100%+5px)] z-40 min-w-[230px] rounded-[10px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg)">
            <div className="px-[9px] pb-[5px] pt-[6px] font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
              Default dispatch
            </div>
            {options.map((o) => (
              <button
                key={o.id}
                onClick={() => pick(o.id)}
                className="flex w-full cursor-pointer items-center gap-[9px] rounded-[6px] border-0 bg-transparent px-[9px] py-[6px] text-left hover:bg-(--surface-hover)"
              >
                <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
                  <AgentIconView icon={o.icon} runtime={o.runtime} size={22} />
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">{o.name}</span>
                <Icon
                  name="check"
                  size={13}
                  color={o.id === active?.id ? 'var(--brand)' : 'transparent'}
                  className="flex-none"
                />
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  )
}

function SlackRefreshNotice({
  result,
  builtin,
  reinstalling,
  onReinstall
}: {
  result: SlackBotRefreshDto
  builtin?: boolean
  reinstalling?: boolean
  onReinstall?: () => void
}) {
  const { needsAttention, message: defaultMessage, action } = slackRefreshNoticeState(result)
  const message =
    builtin && result.authorization === 'invalid'
      ? 'Slack rejected this workspace authorization. Reinstall the app to reconnect it.'
      : defaultMessage

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-start gap-2 border-b border-(--border-subtle) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] desktop:flex-row desktop:justify-between desktop:gap-3 ${
        needsAttention ? 'bg-(--status-paused-soft) text-(--amber-500)' : 'text-(--green-500)'
      }`}
    >
      <span className="min-w-0">
        <span>{message}</span>
        {result.missingScopes.length > 0 && (
          <span className="mono ml-1 text-[11px]">Missing: {result.missingScopes.join(', ')}</span>
        )}
      </span>
      {action?.label === 'Reinstall workspace' && onReinstall ? (
        <button
          type="button"
          className="lnk flex-none border-0 bg-transparent p-0"
          disabled={reinstalling}
          onClick={onReinstall}
        >
          {reinstalling ? 'Reinstalling…' : action.label}
        </button>
      ) : action ? (
        <a href={action.href} target="_blank" rel="noopener noreferrer" className="lnk flex-none">
          {action.label}
        </a>
      ) : null}
    </div>
  )
}

function InviteLinksCard({ orgId }: { orgId: string }) {
  const key = consoleKeys.inviteLink(orgId)
  const {
    data: link,
    error: loadError,
    mutate
  } = useSWR<OrgInviteLinkDto | null>(key, ([, id]) => fetchOrgInviteLink(id as string))
  const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null)
  const [busy, setBusy] = useState<'generate' | 'revoke' | null>(null)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    setRevealed(null)
    setCopied(false)
    setActionError(null)
  }, [orgId])

  const status = link ? inviteLinkStatus(link) : null
  const canGenerate = link !== undefined && (!link || status !== 'active')

  const generate = async () => {
    if (busy || !canGenerate) return
    setBusy('generate')
    setActionError(null)
    setCopied(false)
    try {
      const created = await createOrgInviteLink(orgId)
      setRevealed({ id: created.id, url: inviteLinkUrl(created.token, window.location.origin) })
      await mutate(created, { revalidate: false })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const revoke = async () => {
    if (!link || busy) return
    setBusy('revoke')
    setActionError(null)
    try {
      await revokeOrgInviteLink(link.id, orgId)
      setRevealed(null)
      await mutate()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const copy = async () => {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — the URL stays visible for manual selection */
    }
  }

  return (
    <div className="card mt-[18px]">
      <div className="cardhead justify-between">
        <span className="cardtitle">Invite links</span>
        {canGenerate && (
          <Button variant="secondary" size="xs" onClick={() => void generate()}>
            <Icon name="link" size={14} />
            {busy === 'generate' ? 'Generating…' : link ? 'Generate new' : 'Generate link'}
          </Button>
        )}
      </div>

      {link === undefined && !loadError ? (
        <LoadingState size={22} padding={20} />
      ) : loadError ? (
        <div className="px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
          Couldn&apos;t load the invite link.
        </div>
      ) : !link ? (
        <div className="flex items-center gap-3 px-4 py-[15px]">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-(--surface-sunken)">
            <Icon name="link" size={17} color="var(--text-tertiary)" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[13px] font-semibold leading-normal">No invite link</div>
            <div className="mt-[2px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              Generate the organization&apos;s single collaborator link.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 px-4 py-[15px] desktop:flex-row desktop:items-center">
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-(--brand-soft)">
              <Icon name="link" size={17} color="var(--brand)" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-sans text-[13px] font-semibold leading-normal">Organization invite link</span>
                <span
                  className={`badge ${
                    status === 'active'
                      ? 'bg-(--status-online-soft) text-(--status-online)'
                      : status === 'expired'
                        ? 'bg-(--status-paused-soft) text-(--status-paused)'
                        : 'bg-(--status-error-soft) text-(--status-error)'
                  }`}
                >
                  {status === 'active' ? 'Active' : status === 'expired' ? 'Expired' : 'Revoked'}
                </span>
              </div>
            </div>
            {status === 'active' && (
              <Button variant="secondary" size="xs" onClick={() => void revoke()}>
                <Icon name="ban" size={13} />
                {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
              </Button>
            )}
          </div>

          {revealed?.id === link.id && (
            <div className="mx-4 mb-4 overflow-hidden rounded-[9px] border border-(--gray-800) bg-(--gray-1000)">
              <div className="flex items-center gap-2 border-b border-(--gray-800) px-[13px] py-[9px]">
                <Icon name="link" size={13} color="var(--text-inverse-dim)" />
                <span className="font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)">
                  Copy this link now — it is shown only once
                </span>
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="ml-auto inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)"
                >
                  <Icon name={copied ? 'check' : 'copy'} size={12} />
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
              <div className="break-all px-[14px] py-[13px] font-mono text-[12px] leading-[1.7] text-[#cdd6e0]">
                {revealed.url}
              </div>
            </div>
          )}
        </>
      )}

      {actionError && (
        <div className="border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
          {actionError}
        </div>
      )}
    </div>
  )
}

export default function SettingsView() {
  const targetBotId = useSearchParams().get('bot')
  const { me } = useProfile()
  const { activeOrg, myRole, refreshOrgs, leaveOrg, error: orgError } = useOrgs()
  const { openModal } = useModal()
  const isOwner = myRole === 'owner'
  const canWrite = myRole !== 'viewer' // the CP denies viewer writes; hide the controls too

  const membersKey = consoleKeys.members(activeOrg?.id)
  const {
    data: membersData,
    error: membersError,
    mutate: mutateMembers
  } = useSWR(membersKey, ([, orgId]) => fetchMembers(orgId))
  const loadFailed = membersData === undefined && Boolean(membersError ?? orgError)
  const members = loadFailed ? [] : (membersData ?? null)
  const [editing, setEditing] = useState<MemberTarget | null>(null)
  const [inviting, setInviting] = useState(false)
  const [deletingBot, setDeletingBot] = useState<BotDto | null>(null)

  // `?invite=1` auto-opens the invite-members dialog (the getting-started "Invite
  // teammates" CTA lands here with it). One-shot: the param is stripped immediately
  // so back/refresh doesn't reopen the modal.
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  useEffect(() => {
    if (!searchParams.get('invite')) return
    setInviting(true)
    const sp = new URLSearchParams(searchParams)
    sp.delete('invite')
    router.replace(`${pathname}${sp.size ? `?${sp}` : ''}`, { scroll: false })
  }, [searchParams, pathname, router])

  // A member change can affect ME (self-demote/-remove) — re-pull the org list
  // too so myRole / the active org stay honest instead of 403-ing controls.
  const onMembersChanged = useCallback(() => {
    void Promise.allSettled([mutateMembers(), refreshOrgs()])
  }, [mutateMembers, refreshOrgs])

  const rows = (members ?? []).map(rowFromDto)
  const ownerCount = rows.filter((r) => r.role === 'owner').length

  const edit = (r: MemberRowView) => {
    setEditing({
      userId: r.userId,
      name: r.name,
      email: r.email,
      picture: r.picture,
      initials: r.initials,
      avBg: r.avBg,
      avText: r.avText,
      role: r.role,
      isCurrentUser: r.isCurrentUser,
      lastOwner: r.role === 'owner' && ownerCount <= 1
    })
  }

  return (
    <div className="wrap max-w-[900px] max-desktop:p-4">
      <p className="psub mt-0">Organization, members and access tokens.</p>

      <div className="card mt-5">
        <div className="cardhead justify-between">
          <span className="cardtitle">Organization</span>
          {isOwner && (
            <Button variant="secondary" size="xs" onClick={() => openModal('editOrg')}>
              <Icon name="pencil" size={14} />
              Edit
            </Button>
          )}
        </div>
        <div className="flex items-center gap-[14px] px-4 py-[15px]">
          {isOwner ? (
            // Owners edit the org avatar in place: glyph/color via onCommit, an uploaded
            // image via onUploadImage (shown only when the object store is configured).
            <AgentIconPicker
              value={withIconUrl(activeOrg?.icon, activeOrg?.iconUrl)}
              runtime=""
              size={44}
              radiusClass="rounded-[10px]"
              onCommit={(icon) =>
                activeOrg &&
                void updateOrg(activeOrg.id, { icon })
                  .then(() => refreshOrgs())
                  .catch(() => {})
              }
              onUploadImage={
                activeOrg?.iconUploadEnabled
                  ? async (blob) => {
                      await uploadOrgIcon(blob, activeOrg.id)
                      refreshOrgs()
                    }
                  : undefined
              }
            />
          ) : (
            <span className="av h-11 w-11 flex-none rounded-[10px]">
              <AgentIconView icon={withIconUrl(activeOrg?.icon, activeOrg?.iconUrl)} runtime="" size={44} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[15px] font-semibold leading-normal">
              {activeOrg?.name ?? activeOrg?.slug ?? '—'}
            </div>
            <div className="mono mt-[2px] text-[11.5px] text-(--text-tertiary)">{activeOrg?.slug ?? ''}</div>
          </div>
        </div>
      </div>

      <div className="card mt-[18px]">
        <div className="cardhead">
          <span className="cardtitle">Session access</span>
        </div>
        <SessionAccessRow provider="slack" orgId={activeOrg?.id} isOwner={isOwner} />
        <SessionAccessRow provider="github" orgId={activeOrg?.id} isOwner={isOwner} bordered />
      </div>

      <div className="card mt-[18px]">
        <div className="cardhead justify-between">
          <span className="cardtitle">Members &amp; roles</span>
          {isOwner && (
            <Button variant="secondary" size="xs" onClick={() => setInviting(true)}>
              <Icon name="user-plus" size={14} />
              Invite
            </Button>
          )}
        </div>
        <div className={`row h ${MEMBER_GRID}`}>
          <span>Member</span>
          <span>Role</span>
          <span />
        </div>
        {rows.map((p) => (
          <div key={p.userId} className={`row ${MEMBER_GRID} gap-[11px]`}>
            <div className="flex min-w-0 items-center gap-[11px]">
              <Avatar src={p.picture} initials={p.initials} size={32} fontSize={12} bg={p.avBg} fg={p.avText} />
              <div className="min-w-0">
                <div className="truncate font-sans text-[13px] font-semibold leading-normal">{p.name}</div>
                <div className="mono truncate text-[11px] text-(--text-tertiary)">{p.email ?? '—'}</div>
              </div>
            </div>
            <span className="badge self-center justify-self-start" style={{ background: p.roleBg, color: p.roleText }}>
              {p.roleLabel}
            </span>
            {isOwner || p.isCurrentUser ? (
              <button
                className="iconbtn h-7 w-7 self-center"
                title={isOwner ? 'Edit member' : 'Manage membership'}
                onClick={() => edit(p)}
              >
                <Icon name="pencil" size={14} />
              </button>
            ) : (
              <span className="w-7" />
            )}
          </div>
        ))}
        {members === null && (
          <div className="row grid-cols-[1fr]">
            <LoadingState size={22} padding={20} />
          </div>
        )}
        {loadFailed && (
          <div className="row grid-cols-[1fr] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
            Couldn&apos;t load members — is the control plane reachable?
          </div>
        )}
      </div>

      {isOwner && activeOrg && <InviteLinksCard orgId={activeOrg.id} />}

      {/* One tabbed card for every IM platform's durable bot identities. Rows carry
          the Sharable toggle + installed-agent stack and expand to the bot's
          channel roster (a SHARED bot's channels each get an active-agent picker).
          Slack rows deep-link to the app's settings; Discord rows offer a ready-made
          "Add to Discord" invite built from the persisted application id. */}
      <BotsCard canWrite={canWrite} me={me} targetBotId={targetBotId} onDelete={setDeletingBot} />

      <GithubCard canWrite={canWrite} isOwner={isOwner} />

      {inviting && (
        <div className="scrim" onClick={() => setInviting(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <InviteMembersModal onClose={() => setInviting(false)} onAdded={onMembersChanged} />
          </div>
        </div>
      )}
      {editing && (
        <div className="scrim" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <EditMemberModal
              member={editing}
              canEditRole={isOwner}
              onLeave={editing.isCurrentUser ? () => leaveOrg(editing.userId) : undefined}
              onClose={() => setEditing(null)}
              onChanged={onMembersChanged}
            />
          </div>
        </div>
      )}
      {deletingBot && (
        <div className="scrim" onClick={() => setDeletingBot(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <DeleteBotModal bot={deletingBot} onClose={() => setDeletingBot(null)} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tabbed IM bots card ───────────────────────────────────────────────────────
// The platform tabs select one complete roster at a time — in-use and free bots
// are always shown together. Each row carries the Sharable toggle (PATCH
// /bots/:id; the CP's 409 reason renders inline) + installed-agent stack and
// expands to the bot's channel roster.
function BotsCard({
  canWrite,
  me,
  targetBotId,
  onDelete
}: {
  canWrite: boolean
  me: MeDto | null
  targetBotId: string | null
  onDelete: (b: BotDto) => void
}) {
  const {
    bots,
    integrations,
    getAgent,
    setBotShareable,
    setChannelAgent,
    refresh,
    loading: dataLoading
  } = useConsoleData()
  const [platform, setPlatform] = useState<BotPlatform>('slack')
  // Bot row expanded to its channel roster (one at a time), the bot whose
  // shareable PATCH is in flight, and the last toggle denial to surface (the CP
  // 409s with a reason: no relay connected / still shared by several agents).
  const [openBotId, setOpenBotId] = useState<string | null>(null)
  const [botBusyId, setBotBusyId] = useState<string | null>(null)
  const [botErr, setBotErr] = useState<{ id: string; msg: string } | null>(null)
  const [slackRefreshBusyId, setSlackRefreshBusyId] = useState<string | null>(null)
  const [slackRefresh, setSlackRefresh] = useState<Record<string, { result?: SlackBotRefreshDto; error?: string }>>({})
  const [slackReinstall, setSlackReinstall] = useState<{ botId: string; installId: string } | null>(null)

  const targetBotPlatform = BOT_PLATFORMS.find(
    (item) => item.platform === bots.find((bot) => bot.id === targetBotId)?.platform
  )?.platform
  const { label, noun } = BOT_PLATFORMS.find((item) => item.platform === platform)!
  const platformBots = bots.filter((b) => b.platform === platform)
  const rosterRows = botRosterRows(platformBots)

  useEffect(() => {
    if (!targetBotId || !targetBotPlatform) return
    setPlatform(targetBotPlatform)
    setOpenBotId(targetBotId)
  }, [targetBotId, targetBotPlatform])

  useEffect(() => {
    if (!targetBotId || openBotId !== targetBotId) return
    document.getElementById(`settings-bot-${targetBotId}`)?.scrollIntoView({ block: 'start' })
  }, [openBotId, targetBotId])

  const flipShareable = async (b: BotDto, next: boolean) => {
    if (botBusyId) return
    setBotBusyId(b.id)
    setBotErr(null)
    try {
      await setBotShareable(b.id, next)
    } catch (e) {
      setBotErr({ id: b.id, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBotBusyId(null)
    }
  }

  const refreshSlackApp = async (b: BotDto) => {
    if (slackRefreshBusyId) return
    setSlackRefreshBusyId(b.id)
    setSlackRefresh((current) => ({ ...current, [b.id]: {} }))
    try {
      const result = await refreshSlackBot(b.id)
      setSlackRefresh((current) => ({ ...current, [b.id]: { result } }))
      refresh()
    } catch (e) {
      setSlackRefresh((current) => ({
        ...current,
        [b.id]: { error: e instanceof Error ? e.message : String(e) }
      }))
    } finally {
      setSlackRefreshBusyId(null)
    }
  }

  const reinstallBuiltinSlackApp = async (b: BotDto) => {
    if (slackReinstall || slackRefreshBusyId) return
    setSlackRefresh((current) => {
      const result = current[b.id]?.result
      return { ...current, [b.id]: result ? { result } : {} }
    })
    try {
      const started = await startSlackPlatformInstall({ botId: b.id })
      setSlackReinstall({ botId: b.id, installId: started.id })
      window.open(started.installUrl, '_blank', 'noopener,width=680,height=760')
    } catch (e) {
      setSlackRefresh((current) => {
        const result = current[b.id]?.result
        const error = e instanceof Error ? e.message : String(e)
        return { ...current, [b.id]: result ? { result, error } : { error } }
      })
    }
  }

  useEffect(() => {
    if (!slackReinstall) return
    const { botId, installId } = slackReinstall
    let stopped = false

    const stop = () => {
      stopped = true
      clearInterval(timer)
    }
    const fail = (message: string) => {
      stop()
      setSlackReinstall(null)
      setSlackRefresh((current) => {
        const result = current[botId]?.result
        return { ...current, [botId]: result ? { result, error: message } : { error: message } }
      })
    }
    const tick = async () => {
      try {
        const status = await getSlackPlatformInstall(installId)
        if (stopped || status.status === 'pending') return
        if (status.status === 'failed') {
          fail(
            status.failureReason === 'denied'
              ? 'The reinstall was cancelled in Slack.'
              : status.failureReason === 'workspace_mismatch'
                ? 'Slack authorized a different workspace. Try again and choose this bot’s workspace.'
                : 'Slack could not complete the reinstall. Please try again.'
          )
          return
        }
        if (status.botId !== botId) {
          fail('Slack reauthorized a different bot. Please try again.')
          return
        }

        stop()
        setSlackReinstall(null)
        setSlackRefreshBusyId(botId)
        try {
          const result = await refreshSlackBot(botId)
          setSlackRefresh((current) => ({ ...current, [botId]: { result } }))
          refresh()
        } catch (e) {
          setSlackRefresh((current) => ({
            ...current,
            [botId]: { error: e instanceof Error ? e.message : String(e) }
          }))
        } finally {
          setSlackRefreshBusyId(null)
        }
      } catch (e) {
        if (!stopped && e instanceof ApiError && e.status === 404) {
          fail('This reinstall link expired. Please try again.')
        }
      }
    }

    const timer = setInterval(() => void tick(), 2500)
    void tick()
    return stop
  }, [refresh, slackReinstall])

  return (
    <div className="card mt-[18px]">
      <div
        className="cardhead gap-0 overflow-x-auto py-0 [scrollbar-width:none] desktop:overflow-x-visible [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Bot platform"
      >
        {BOT_PLATFORMS.map((item) => {
          const selected = item.platform === platform
          return (
            <button
              key={item.platform}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`${selected ? 'tab on' : 'tab'} mr-[5px] flex items-center gap-[5px] whitespace-nowrap last:mr-0 desktop:mr-[22px] desktop:gap-[6px]`}
              onClick={() => {
                setPlatform(item.platform)
                setOpenBotId(null)
              }}
            >
              <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
                <PlatformMark platform={item.platform} fillPct={100} />
              </span>
              {item.label}
            </button>
          )
        })}
      </div>
      {/* gap must match the data rows' or the narrow tracks drift out of line. */}
      <div className={`row h ${BOT_GRID} gap-[11px]`}>
        <span>{noun === 'app' ? 'App' : 'Bot'}</span>
        <span>Sharable</span>
        <span>Agents</span>
        <span className="whitespace-nowrap max-[479px]:hidden">Created by</span>
        <span />
      </div>
      {rosterRows.map((row) => {
        if (row.kind === 'workspace') {
          return (
            <div
              key={row.key}
              className="flex items-center gap-2 border-b border-(--border-subtle) bg-(--surface-sunken) px-4 py-2"
            >
              <span className="font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                Workspace
              </span>
              <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">{row.label}</span>
            </div>
          )
        }
        const b = row.bot
        const free = b.agentIds.length === 0
        const open = openBotId === b.id
        const channels = open ? botChannels(b, integrations) : []
        const hasChannelRows = channels.some((c) => c.kind === 'channel')
        const slackState = slackRefresh[b.id]
        const reinstallingSlack = slackReinstall?.botId === b.id
        const refreshingSlack = slackRefreshBusyId === b.id || reinstallingSlack
        const slackNeedsAttention = slackState?.result
          ? slackRefreshNoticeState(slackState.result).needsAttention
          : false
        const showDefaultDispatch = b.shareable && hasChannelRows
        const chanGrid = showDefaultDispatch ? 'grid-cols-[1fr_auto]' : 'grid-cols-[1fr]'
        const feishuRegion = b.feishuRegion ?? 'feishu'
        const feishuBrand = feishuRegion === 'lark' ? 'Lark' : 'Feishu'
        // The picker's choices: every agent installed on the bot.
        const agentOptions = b.agentIds.map((id) => {
          const ag = getAgent(id)
          return {
            id,
            name: ag ? agentLabel(ag) : id,
            model: ag?.model || ag?.runtime || '',
            runtime: ag?.runtime || ag?.model || '',
            icon: ag?.icon
          }
        })
        return (
          <Fragment key={b.id}>
            <div
              id={`settings-bot-${b.id}`}
              className={`row click ${BOT_GRID} items-center gap-[11px]`}
              onClick={() => setOpenBotId(open ? null : b.id)}
            >
              <div className="flex min-w-0 items-center gap-[10px]">
                <Icon
                  name="chevron-right"
                  size={14}
                  className={`flex-none text-(--text-tertiary) transition-transform ${open ? 'rotate-90' : ''}`}
                />
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                  <span className="flex h-[14px] w-[14px] items-center justify-center">
                    <PlatformMark platform={b.platform} fillPct={100} />
                  </span>
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[12.5px]">{b.name}</span>
                {b.prebuilt && <span className="badge bg-(--surface-active) text-(--text-tertiary)">builtin</span>}
                {/* Workspace uninstalled the app / revoked its tokens (rc/bot-revoked):
                    the credential is dead until a re-install refreshes it. */}
                {b.revokedAt && (
                  <span
                    className="badge bg-(--status-error-soft) text-(--danger)"
                    title="The Slack workspace uninstalled this app or revoked its tokens — re-install to reconnect"
                  >
                    revoked
                  </span>
                )}
                {/* Transport tag (Slack) — makes the Sharable column's disabled state
                    self-explanatory: only an http bot may be shared. */}
                {platform === 'slack' && (
                  <span className="badge bg-(--surface-active) text-(--text-tertiary) max-[479px]:hidden">
                    {b.transport ?? 'socket'}
                  </span>
                )}
              </div>
              <span
                className="flex items-center justify-self-start"
                title={
                  (b.transport ?? 'socket') === 'socket'
                    ? 'HTTP transport required to share'
                    : 'Allow several agents to share this bot across channels'
                }
                onClick={(e) => e.stopPropagation()}
              >
                <Toggle
                  checked={b.shareable}
                  disabled={!canWrite || botBusyId === b.id || (b.transport ?? 'socket') === 'socket'}
                  onChange={(next) => void flipShareable(b, next)}
                />
              </span>
              <div className="flex min-w-0 items-center">
                {b.agentIds.length > 0 ? (
                  b.agentIds.map((id, idx) => {
                    const ag = getAgent(id)
                    return (
                      <span
                        key={id}
                        title={ag ? agentLabel(ag) : id}
                        className={`av h-[22px] w-[22px] rounded-[6px] ${
                          idx > 0 ? '-ml-[6px] shadow-[-1px_0_0_0_var(--surface-card)]' : ''
                        }`}
                      >
                        <AgentIconView icon={ag?.icon} runtime={ag?.runtime || ag?.model || ''} size={22} />
                      </span>
                    )
                  })
                ) : (
                  <span className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    {botSubline(b)}
                  </span>
                )}
              </div>
              <span className="min-w-0 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) max-[479px]:hidden">
                {b.createdBy ? creatorLabel(b.createdBy, me) : b.prebuilt ? 'AgentConnect' : '—'}
              </span>
              <span className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                {platform === 'slack' && b.slackAppId && canWrite && (
                  <button
                    className={`iconbtn h-7 w-7 flex-none ${
                      slackNeedsAttention ? 'border-(--amber-500) bg-(--status-paused-soft) text-(--amber-500)' : ''
                    } ${refreshingSlack ? 'cursor-default opacity-60' : ''}`}
                    title={slackNeedsAttention ? 'Slack app needs attention' : 'Refresh Slack app'}
                    aria-label="Refresh Slack app"
                    disabled={refreshingSlack}
                    onClick={() => void refreshSlackApp(b)}
                  >
                    <Icon
                      name={refreshingSlack ? 'loader' : 'refresh-cw'}
                      size={14}
                      className={refreshingSlack ? 'animate-spin' : undefined}
                    />
                  </button>
                )}
                {platform === 'slack' && b.slackAppId && (
                  <a
                    href={slackAppSettingsUrl(b.slackAppId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Configure on Slack"
                    aria-label="Configure on Slack"
                    className="iconbtn h-7 w-7 flex-none"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Icon name="external-link" size={12} />
                  </a>
                )}
                {platform === 'discord' && b.discordAppId && (
                  <a
                    href={discordBotInviteUrl(b.discordAppId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Invite this bot to a Discord server — preset scopes &amp; permissions"
                    aria-label="Add this bot to a Discord server"
                    className="iconbtn h-7 w-7 flex-none"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Icon name="external-link" size={12} />
                  </a>
                )}
                {platform === 'feishu' && (
                  <a
                    href={feishuAppSettingsUrl(b.feishuAppId, feishuRegion)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Configure on ${feishuBrand}`}
                    aria-label={`Configure on ${feishuBrand}`}
                    className="iconbtn h-7 w-7 flex-none"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Icon name="external-link" size={12} />
                  </a>
                )}
                {free && canWrite ? (
                  <button className="iconbtn h-7 w-7 flex-none" title={`Delete ${noun}`} onClick={() => onDelete(b)}>
                    <Icon name="trash-2" size={14} />
                  </button>
                ) : !free ? (
                  <span
                    title="Uninstall its integration first"
                    className="flex h-7 w-7 flex-none cursor-not-allowed items-center justify-center opacity-45"
                  >
                    <Icon name="trash-2" size={14} />
                  </span>
                ) : (
                  <span className="h-7 w-7 flex-none" />
                )}
              </span>
            </div>
            {botErr?.id === b.id && (
              <div className="border-b border-(--border-subtle) px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
                {botErr.msg}
              </div>
            )}
            {slackState?.error && (
              <div
                role="alert"
                className="border-b border-(--border-subtle) bg-(--status-error-soft) px-4 py-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
              >
                Couldn&apos;t refresh this Slack app — {slackState.error}
              </div>
            )}
            {slackState?.result && (
              <SlackRefreshNotice
                result={slackState.result}
                builtin={b.prebuilt}
                reinstalling={reinstallingSlack}
                onReinstall={b.prebuilt ? () => void reinstallBuiltinSlackApp(b) : undefined}
              />
            )}
            {open && (
              <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-4 pb-[14px] pl-10 pt-3">
                {channels.length > 0 ? (
                  <>
                    <div
                      className={`grid ${chanGrid} gap-[11px] px-3 pb-[7px] font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)`}
                    >
                      <span>Conversation</span>
                      {showDefaultDispatch && <span className="justify-self-end">Default dispatch</span>}
                    </div>
                    <div className="overflow-visible rounded-lg border border-(--border-subtle) bg-(--surface-card)">
                      {channels.map((c, index) => (
                        <Fragment key={c.channelId}>
                          {isDirectConversation(c.kind) && !isDirectConversation(channels[index - 1]?.kind) && (
                            <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-[6px] font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                              Direct messages
                            </div>
                          )}
                          <div
                            className={`grid ${chanGrid} items-center gap-[11px] border-b border-(--border-subtle) px-3 py-2 last:border-b-0`}
                          >
                            <span className="mono flex min-w-0 items-center gap-[7px] text-[12px]">
                              <Icon
                                name={c.kind === 'mpim' ? 'users' : c.kind === 'im' ? 'at-sign' : 'hash'}
                                size={12}
                                color="var(--text-tertiary)"
                                className="flex-none"
                              />
                              <span className="sr-only">
                                {c.kind === 'mpim' ? 'Group DM' : c.kind === 'im' ? 'Direct message' : 'Channel'}:{' '}
                              </span>
                              <span className="truncate">
                                {isDirectConversation(c.kind) ? c.name.replace(/^@+/, '') : c.name}
                              </span>
                            </span>
                            {showDefaultDispatch && c.kind === 'channel' && (
                              <DefaultDispatchPicker
                                options={agentOptions}
                                activeId={c.agentId ?? b.agentIds[0] ?? null}
                                disabled={!canWrite || !c.integrationId}
                                onPick={(agentId) => setChannelAgent(c.integrationId!, c.channelId, agentId)}
                              />
                            )}
                          </div>
                        </Fragment>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                    Not in any channel yet — invite the bot to a channel and it shows up here.
                  </div>
                )}
              </div>
            )}
          </Fragment>
        )
      })}
      {platformBots.length === 0 &&
        (dataLoading ? (
          <LoadingState size={22} padding={20} />
        ) : (
          <div className="px-4 py-7 text-center">
            <div className="font-sans text-[13px] font-semibold leading-normal">No {noun}s yet</div>
            <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              A {label} {noun} is registered when you add a {label} integration to an agent.
            </div>
          </div>
        ))}
    </div>
  )
}

// ── GitHub App card ─────────────────────────────────────────────────────────
// The deployment GitHub App powering github-app workspaces (repo picker +
// credential-free daemon git). Deployment-config opt-in: when the CP has no
// GITHUB_APP_* env the routes 404 and this card shows the disabled note.
// Installations are org-level infrastructure (like bots) — every member can
// see them; installing and syncing are writes (viewers don't get those buttons),
// while uninstalling the App from an account is owner-only.
function GithubCard({ canWrite, isOwner }: { canWrite: boolean; isOwner: boolean }) {
  // Gate the org-scoped fetch on the active org (same hard-refresh race as SlackCard):
  // before OrgProvider resolves, `orgBase()` throws → the catch would show "not enabled"
  // even when it IS. Re-fetch once the org resolves / on switch.
  const { activeOrg } = useOrgs()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [installs, setInstalls] = useState<GithubInstallationDto[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState<GithubInstallationDto | null>(null)

  useEffect(() => {
    if (!activeOrg) return
    let alive = true
    setEnabled(null)
    fetchGithubInstallations()
      .then(({ enabled, installations }) => {
        if (!alive) return
        setEnabled(enabled)
        setInstalls(installations)
      })
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [activeOrg])

  // The install link mints a ONE-SHOT signed state — fetch fresh per click.
  const install = async () => {
    setErr(null)
    try {
      const url = await fetchGithubInstallUrl()
      if (url) window.open(url, '_blank', 'noopener')
      else setErr('Could not mint an install link.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  // Reconcile with GitHub — the fallback for a lost setup callback, a pending
  // admin approval, or an install finished in the other tab just now.
  const sync = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      setInstalls(await syncGithubInstallations())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card mt-[18px]">
      <div className="cardhead justify-between">
        <span className="cardtitle flex items-center gap-2">
          <span className="flex h-[15px] w-[15px] items-center justify-center">
            <GithubMark color="var(--text-primary)" />
          </span>
          GitHub
        </span>
        {enabled === true && canWrite && (
          <span className="flex items-center gap-2">
            <Button variant="ghost" onClick={sync}>
              <Icon name="refresh-cw" size={13} />
              {busy ? 'Syncing…' : 'Sync'}
            </Button>
            <Button onClick={install}>
              <Icon name="external-link" size={13} />
              Install on GitHub
            </Button>
          </span>
        )}
      </div>
      {enabled === null && <LoadingState size={22} padding={20} />}
      {enabled === false && (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          Not enabled on this deployment — the control plane has no GitHub App configured.
        </div>
      )}
      {enabled === true && installs.length === 0 && (
        <div className="px-4 py-7 text-center">
          <div className="font-sans text-[13px] font-semibold leading-normal">No installations yet</div>
          <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            Install the GitHub App on your org to pick private repositories when creating agents — the daemon then
            clones and pushes with short-lived tokens, no git credentials on the machine.
          </div>
        </div>
      )}
      {enabled === true &&
        installs.map((i) => (
          <Fragment key={i.id}>
            <div className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]">
              <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                  <span className="flex h-[14px] w-[14px] items-center justify-center">
                    <GithubMark color="var(--text-primary)" />
                  </span>
                </span>
                <span className="mono min-w-0 truncate text-[12.5px]">{i.accountLogin}</span>
                <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                  {i.accountType === 'Organization' ? 'org' : 'user'}
                </span>
                {i.suspended && <span className="badge bg-(--status-error-soft) text-(--status-error)">suspended</span>}
                {i.permissionsStatus === 'outdated' && (
                  <span className="badge bg-(--status-paused-soft) text-(--amber-500)">needs update</span>
                )}
              </div>
              <span className="flex items-center justify-between gap-3 desktop:justify-end">
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {i.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}
                </span>
                {isOwner && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-(--status-error) hover:text-(--status-error)"
                    onClick={() => setUninstalling(i)}
                  >
                    <Icon name="unplug" size={13} />
                    Uninstall
                  </Button>
                )}
              </span>
            </div>
            {i.permissionsStatus === 'outdated' && (
              <div
                role="status"
                className="flex flex-col items-start gap-2 border-b border-(--border-subtle) bg-(--status-paused-soft) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--amber-500) desktop:flex-row desktop:items-center desktop:justify-between desktop:gap-3"
              >
                <span className="flex min-w-0 items-start gap-2">
                  <Icon name="triangle-alert" size={14} color="var(--amber-500)" className="mt-[2px] flex-none" />
                  <span>This installation&rsquo;s GitHub permissions need updating before all features will work.</span>
                </span>
                <a href={i.settingsUrl} target="_blank" rel="noopener noreferrer" className="lnk flex-none text-[12px]">
                  Update permissions
                  <Icon name="external-link" size={12} />
                </a>
              </div>
            )}
          </Fragment>
        ))}
      {err && (
        <div className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
      )}
      {uninstalling && (
        <div className="scrim" onClick={() => setUninstalling(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <UninstallGithubInstallationModal
              installation={uninstalling}
              onClose={() => setUninstalling(null)}
              onUninstalled={(id) => {
                setInstalls((current) => current.filter((installation) => installation.id !== id))
                setUninstalling(null)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
