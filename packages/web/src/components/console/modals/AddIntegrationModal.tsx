// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { GithubMark, PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { GithubReviewSettings } from '@/components/console/GithubReviewSettings'
import { agentLabel, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { useProfile } from '@/lib/profile'
import { consoleKeys } from '@/lib/swr-keys'
import {
  ApiError,
  creatorLabel,
  startSlackInstall,
  getSlackInstall,
  fetchSlackConfig,
  saveSlackConfig,
  fetchAgentHooks,
  fetchAgentRepos,
  fetchAllGithubRepos,
  fetchGithubInstallationRepo,
  fetchGithubInstallations,
  fetchGithubInstallUrl,
  syncGithubInstallations,
  updateAgentRepo,
  type CreateIntegrationInput,
  type CreatedHookDto,
  type GithubInstallationDto,
  type GithubRepoDto,
  type RepoAccess
} from '@/lib/api'
import { REPO_ACCESS_BADGE } from '@/components/console/WorkspaceCard'
import AddAgentRepoModal from './AddAgentRepoModal'
import {
  GH_DEFAULT_FAMILIES,
  GH_DEFAULT_TRIGGER_MODE,
  GH_FAMILIES,
  GH_TRIGGER_LABEL,
  commentFamiliesForFamilies,
  eventsForFamilies,
  githubMentionUsage,
  type GhFamily,
  type GhTriggerMode
} from '@/lib/github-events'
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
import {
  slackAppIdFromAppToken,
  slackAppOAuthUrl,
  slackAppSettingsUrl,
  slackCreateAppUrl,
  slackManifestJson
} from '@/lib/slack-manifest'
import { agentIconBackgroundColor } from '@/lib/agent-icon'
import { discordApplicationIdFromToken, discordBotInviteUrl } from '@/lib/discord-invite'

// `webhook` and `github` are not bot platforms: picking them mints an inbound
// trigger (a hook) instead of installing a bot identity — webhook is
// agent-fired-by-URL, github subscribes a repo's issue/PR/commit events. Both
// live on the relay pool, so neither is gated by the daemon's adapter
// capabilities.
type BotPlatform = 'slack' | 'telegram' | 'discord' | 'feishu'
export type Platform = BotPlatform | 'webhook' | 'github'

type GithubRepoChoice = GithubRepoDto & { installationId: string }

const BOT_PLATFORMS: { key: BotPlatform; label: string }[] = [
  { key: 'slack', label: 'Slack' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'discord', label: 'Discord' },
  { key: 'feishu', label: 'Feishu' }
]

const PLATFORMS: { key: Platform; label: string }[] = [
  ...BOT_PLATFORMS,
  { key: 'webhook', label: 'Webhook' },
  { key: 'github', label: 'GitHub' }
]

/** The trigger cadences (design vocabulary: "when created / updated / mention only"
 *  — the stored event patterns + the mentionOnly flag encode the choice).
 *  `desc` stays a one-liner so the design's 3-up tiles keep equal height. */
const GH_TRIGGER_TILES: { mode: GhTriggerMode; label: string; desc: string }[] = [
  { mode: 'first', label: GH_TRIGGER_LABEL.first, desc: 'When opened, plus later @mentions.' },
  {
    mode: 'every',
    label: GH_TRIGGER_LABEL.every,
    desc: 'Updates, plus replies for selected issues and PRs.'
  },
  {
    mode: 'mention',
    label: GH_TRIGGER_LABEL.mention,
    desc: 'Only when @-mentioned.'
  }
]

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

function inviteBotHint(
  target: 'channel' | 'group',
  platform: 'Slack' | 'Telegram' | 'Discord' | 'Feishu',
  nextStep = 'it starts listening there'
): string {
  return `invite the bot to any ${target} in ${platform} and ${nextStep}.`
}

const IM_INVITE_HINT = {
  slack: inviteBotHint('channel', 'Slack'),
  telegram: inviteBotHint('group', 'Telegram'),
  discord: inviteBotHint('channel', 'Discord'),
  feishu: inviteBotHint('group', 'Feishu', '@-mention it to start')
} as const

// Per-platform "create a new bot" walkthrough for the non-Slack platforms (Slack
// keeps its richer manifest flow inline below). Each is: an external portal link,
// a one-line setup instruction, a single bot-token field, and optional setup hints.
const GUIDE: Record<
  'telegram' | 'discord',
  {
    linkHref: string
    linkLabel: string
    step1: string
    step1Warning?: string
    tokenPlaceholder: string
  }
> = {
  telegram: {
    linkHref: 'https://t.me/BotFather',
    linkLabel: 'Open @BotFather',
    step1: 'Message @BotFather, send /newbot, and follow the prompts to name your bot — it replies with a token.',
    step1Warning:
      'disable privacy mode in @BotFather (/setprivacy → Disable) after creation, so it reads every message.',
    tokenPlaceholder: '123456789:AAE…'
  },
  discord: {
    linkHref: 'https://discord.com/developers/applications',
    linkLabel: 'Open Developer Portal',
    step1:
      'Create an application, add a Bot, and enable the Message Content intent (Bot → Privileged Gateway Intents), then copy its token.',
    tokenPlaceholder: 'Bot token from the Developer Portal'
  }
}

// Discord needs a few app/invite-level settings beyond the token that aren't obvious
// and each fails silently if missed — surfaced as a checklist on the Discord path.
const DISCORD_REQS: { icon: string; title: string; desc: string }[] = [
  {
    icon: 'message-square',
    title: 'Message Content intent',
    desc: 'Bot → Privileged Gateway Intents. Without it every message arrives with empty text and the bot never replies.'
  },
  {
    icon: 'terminal',
    title: 'Invite with the applications.commands scope',
    desc: 'Use the “Add to Discord” button below the token — it requests the bot and applications.commands scopes so /status, /models … appear in Discord’s slash menu. A bot-only invite must be re-authorized.'
  },
  {
    icon: 'git-branch',
    title: 'Create Public Threads permission',
    desc: 'Grant it in the invite (or on the channel) so a reply opens a thread instead of flooding the channel.'
  }
]

// Feishu needs a few app-level settings beyond the credentials that aren't obvious
// and each fails silently if missed — surfaced as a checklist on the Feishu path.
const FEISHU_REQS: { icon: string; title: string; desc: string }[] = [
  {
    icon: 'bot',
    title: 'Enable the bot capability',
    desc: 'In the app’s “Add features”, turn on Bot — otherwise it can’t send or receive messages.'
  },
  {
    icon: 'radio',
    title: 'Event subscription via Long Connection',
    desc: 'Set event delivery to Long Connection (not Webhook) and subscribe im.message.receive_v1 — the daemon dials out, so no public URL is needed.'
  },
  {
    icon: 'shield-check',
    title: 'Grant the message scopes',
    desc: 'Request im:message, im:message:send_as_bot and im:resource (add im:chat as needed), then create a version and publish.'
  },
  {
    icon: 'users',
    title: 'Add the bot to your group',
    desc: 'Invite the bot into the target chat — it replies wherever it’s a member and @-mentioned.'
  }
]

const CREATE_DESC: Record<BotPlatform, string> = {
  slack: 'Create a Slack app from our manifest and paste its tokens.',
  telegram: 'Create a bot with @BotFather and paste its token.',
  discord: 'Create an app in the Developer Portal and paste its bot token.',
  feishu: 'Create a self-built app in the Feishu console and paste its App ID & Secret.'
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

const TRANSPORT_LABEL: Record<'socket' | 'http', string> = {
  socket: 'Socket Mode',
  http: 'HTTP (Events API)'
}

// The one-line delivery-mode note under the Slack manifest button (design's
// `slackTransport`): it names the current inbound transport and, when possible,
// offers a subtle underlined switch. Socket is kept as minimal as possible — when
// there's no relay (http unavailable) or the install is locked, it collapses to
// just "Delivery: Socket Mode." with no switch. `http` (Events API via the relay)
// is only offerable with a relay connected; `locked` pins it once an auto-install
// app has been created for that transport.
function SlackDeliveryLine({
  transport,
  relayAvailable,
  locked,
  onSwitch
}: {
  transport: 'socket' | 'http'
  relayAvailable: boolean
  locked: boolean
  onSwitch: (next: 'socket' | 'http') => void
}) {
  const next = transport === 'http' ? 'socket' : 'http'
  // Switching TO http needs a connected relay; switching back to socket is always fine.
  const canSwitch = !locked && (next === 'socket' || relayAvailable)
  return (
    <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
      Delivery: <span className="text-(--text-secondary)">{TRANSPORT_LABEL[transport]}</span>.
      {canSwitch && (
        <>
          {' '}
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[11.5px] leading-normal text-(--text-tertiary) underline underline-offset-2 hover:text-(--text-secondary)"
            onClick={() => onSwitch(next)}
          >
            Switch to {TRANSPORT_LABEL[next]}
          </button>
        </>
      )}
    </div>
  )
}

// Hover preview for the "Copy manifest & open Slack" button — a miniature of Slack's
// "Create new app" dialog cropped to the two "Or start your own way" tiles, with the
// "From a manifest" tile blinking so the user knows exactly which option to click once the
// manifest is on their clipboard. Styled like Slack's own (light) dialog; pointer-events-none
// so it never intercepts the button's click.
function SlackManifestPreview() {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-[320px] -translate-x-1/2 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      <div className="rounded-xl border border-[#e0e0e2] bg-white p-3 shadow-(--shadow-xl)">
        <div className="mb-2 flex items-center gap-1.5 font-sans text-[11px] font-semibold leading-normal text-[#616061]">
          <Icon name="mouse-pointer-click" size={12} />
          In Slack, pick &ldquo;From a manifest&rdquo;
        </div>
        <div className="mb-1.5 font-sans text-[9.5px] font-semibold uppercase leading-normal tracking-wide text-[#8d8d8d]">
          Or start your own way
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="relative rounded-lg border-2 border-[#1264a3] bg-white p-2.5">
            <span className="pointer-events-none absolute -inset-0.5 slack-hint-blink rounded-[10px] ring-2 ring-[#1264a3]" />
            <span className="mb-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-[#f4f4f4] text-[#454545]">
              <Icon name="scroll-text" size={14} />
            </span>
            <div className="font-sans text-[11.5px] font-bold leading-tight text-[#1d1c1d]">From a manifest</div>
            <div className="mt-0.5 font-sans text-[10px] leading-tight text-[#616061]">Upload JSON or YAML config.</div>
          </div>
          <div className="rounded-lg border border-[#e0e0e2] bg-white p-2.5">
            <span className="mb-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-[#f4f4f4] text-[#454545]">
              <Icon name="clapperboard" size={14} />
            </span>
            <div className="font-sans text-[11.5px] font-bold leading-tight text-[#1d1c1d]">Blank app</div>
            <div className="mt-0.5 font-sans text-[10px] leading-tight text-[#616061]">
              Empty app with minimal setup.
            </div>
          </div>
        </div>
        <div className="mt-2 font-sans text-[10px] leading-snug text-[#616061]">
          Then paste the copied manifest, choose a workspace, and create the app.
        </div>
      </div>
      <div className="absolute -bottom-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-r border-b border-[#e0e0e2] bg-white" />
    </div>
  )
}

// Hover preview for "Open Slack app config tokens" — an animated mock of Slack's apps page
// scrolling down to the "Your App Configuration Tokens" section and pulsing the access
// token's Copy button (then the refresh token's), so the user sees exactly where the pair
// lives. Uses the design's .cfgtok-pop container (above the button, surface-card, downward
// caret). pointer-events-none.
function SlackConfigTokenPreview() {
  return (
    <div className="cfgtok-pop rounded-xl border border-(--border-default) bg-(--surface-card) p-2 shadow-(--shadow-xl)">
      <div className="overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-app)">
        <div className="flex items-center gap-1.5 border-b border-(--border-subtle) px-2.5 py-1.5">
          <span className="h-2 w-2 flex-none rounded-full bg-[#e0605a]" />
          <span className="h-2 w-2 flex-none rounded-full bg-[#e8b13a]" />
          <span className="h-2 w-2 flex-none rounded-full bg-[#4aa564]" />
          <span className="ml-1 min-w-0 truncate font-mono text-[9px] leading-normal text-(--text-tertiary)">
            api.slack.com/apps
          </span>
        </div>
        <div className="h-[140px] overflow-hidden bg-(--surface-card)">
          <div className="cfg-scroll px-2.5 py-2">
            <div className="mb-1.5 font-sans text-[10px] font-bold leading-tight text-(--text-primary)">Your apps</div>
            {[0, 1].map((i) => (
              <div
                key={i}
                className="mb-1.5 flex items-center gap-2 rounded-md border border-(--border-subtle) px-2 py-1.5"
              >
                <span className="h-4 w-4 flex-none rounded bg-(--surface-active)" />
                <span className="h-1.5 w-24 rounded-full bg-(--surface-active)" />
              </div>
            ))}
            <div className="mt-2 rounded-md border border-(--border-subtle) bg-(--surface-app) p-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-sans text-[10px] font-bold leading-tight text-(--text-primary)">
                  Your App Configuration Tokens
                </span>
                <span className="flex-none rounded bg-(--surface-active) px-1.5 py-[3px] font-sans text-[8px] font-semibold leading-normal text-(--text-secondary)">
                  Generate Token
                </span>
              </div>
              <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1">
                <span className="font-sans text-[8px] font-semibold uppercase leading-normal text-(--text-tertiary)">
                  Workspace
                </span>
                <span className="font-sans text-[8px] font-semibold uppercase leading-normal text-(--text-tertiary)">
                  Access
                </span>
                <span className="font-sans text-[8px] font-semibold uppercase leading-normal text-(--text-tertiary)">
                  Refresh
                </span>
                <span className="font-mono text-[9px] leading-normal text-(--text-secondary)">your-workspace</span>
                <span className="relative rounded border border-(--border-default) bg-(--surface-card) px-1.5 py-[3px] font-sans text-[8.5px] font-semibold leading-normal text-(--text-secondary)">
                  Copy
                  <span className="pointer-events-none absolute -inset-[3px] cfg-click-a rounded ring-2 ring-(--brand)" />
                </span>
                <span className="relative rounded border border-(--border-default) bg-(--surface-card) px-1.5 py-[3px] font-sans text-[8.5px] font-semibold leading-normal text-(--text-secondary)">
                  Copy
                  <span className="pointer-events-none absolute -inset-[3px] cfg-click-b rounded ring-2 ring-(--brand)" />
                </span>
              </div>
              <div className="mt-1 font-sans text-[8px] leading-normal text-(--text-tertiary)">Expires in 5 hours</div>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-1.5 px-1 font-sans text-[10.5px] font-normal leading-[1.45] text-(--text-secondary)">
        Scroll to the bottom of <span className="mono">Your apps</span> — the token pair lives under &ldquo;App
        configuration tokens&rdquo;.
      </div>
    </div>
  )
}

// The integration is owned by one agent; that agent's daemon opens the connection.
// The dialog is only reachable from a specific agent (its row / detail page), so the
// agent is fixed — no picker. `initialPlatform` lets a caller land on a specific
// pane (the GitHub group card's "Add repository" — adding a repo, not a bot).
export default function AddIntegrationModal({
  agent,
  initialPlatform,
  onClose
}: {
  agent: Agent
  initialPlatform?: Platform
  onClose: () => void
}) {
  const {
    createIntegration,
    finalizeSlackInstall,
    bots,
    createHook,
    createGithubHook,
    daemons,
    daemonsLoading,
    updateAgent
  } = useConsoleData()
  const { me } = useProfile()
  const [platform, setPlatform] = useState<Platform>(initialPlatform ?? 'slack')
  // Prefilled from the agent's name so the manifest carries a real app name out of
  // the box; still editable, and empty falls back to `agent.name` for the manifest.
  const [appName, setAppName] = useState(agent.name)
  const [botToken, setBotToken] = useState('')
  const [appToken, setAppToken] = useState('')
  // Feishu/Lark gateway: 'feishu' (open.feishu.cn, China) vs 'lark' (open.larksuite.com, intl).
  const [feishuRegion, setFeishuRegion] = useState<'feishu' | 'lark'>('feishu')
  const [saving, setSaving] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Synchronous re-entry guard for the async actions. `saving` state can't do this —
  // it commits on the NEXT render, so a fast double-click fires two calls in the same
  // tick (both see saving=false). A ref flips immediately, so the second click bails —
  // otherwise a double "Create app & install" spawns two Slack apps / two OAuth tabs
  // and the modal ends up polling an install the user never approved.
  const busyRef = useRef(false)

  // Tier B config-token auto-install (docs/designs/slack-install-smoothing.md §Tier B).
  // PER-USER: the app is created with the CALLER's own config token, so it belongs to
  // them and only they can mint its app-level token. `slackFunnel`: null = still
  // checking, true = this deployment supports auto-install (public callback), false =
  // manual (create the app yourself). Fetched on open; `autoUsable` (below) tracks whether
  // the caller's stored config token can one-click right now.
  const [slackFunnel, setSlackFunnel] = useState<boolean | null>(null)
  // The caller's stored config token is USABLE for a one-click install right now: it
  // auto-rotates (durable) or its access token is still fresh. False when they've stored
  // nothing OR their access-only token expired — either way the config method shows the
  // inline token entry instead.
  const [autoUsable, setAutoUsable] = useState(false)
  // "Create a new bot" method (Slack): 'config' = recommended config-token quick install
  // (works for socket AND http), 'bot' = manual bot-token flow. Null ⇒ derive the default.
  const [createMethod, setCreateMethod] = useState<'config' | 'bot' | null>(null)
  // Inline config-token entry, shown under the config method — saved to the same per-user
  // store as the Profile card (so it appears there too).
  const [cfgAccess, setCfgAccess] = useState('')
  const [cfgRefresh, setCfgRefresh] = useState('')
  // Slack inbound transport (locked rule): `http` (Events API via relay) is the
  // default when a relay is available; `socket` (Socket Mode) is the only choice
  // when none. `transport` null = not yet chosen ⇒ derive the default from
  // `relayAvailable`. `relayAvailable` / `relayPublicUrl` come off the same
  // fetchSlackConfig() call as the funnel flags below.
  const [transport, setTransport] = useState<'socket' | 'http' | null>(null)
  const [signingSecret, setSigningSecret] = useState('') // http manual credential
  const [relayAvailable, setRelayAvailable] = useState(false)
  const [relayPublicUrl, setRelayPublicUrl] = useState<string | null>(null)
  // config → authorizing (OAuth in the other tab) → appToken (bot ready, paste xapp).
  const [autoPhase, setAutoPhase] = useState<'config' | 'authorizing' | 'appToken'>('config')
  const [install, setInstall] = useState<{
    installId: string
    appId: string
    installUrl: string
    transport: 'socket' | 'http'
  } | null>(null)

  // Webhook path: the form (just a name), then the created row — which carries
  // the ONE-TIME signing-secret echo, so once it exists the platform is locked
  // (switching away would discard a secret the user can never see again).
  const [hookName, setHookName] = useState('')
  const [createdHook, setCreatedHook] = useState<CreatedHookDto | null>(null)
  const [copiedHook, setCopiedHook] = useState<'url' | 'secret' | 'curl' | null>(null)
  const [hookTestMessage, setHookTestMessage] = useState(DEFAULT_HOOK_TEST_MESSAGE)
  const hookMessageRef = useRef<HTMLTextAreaElement | null>(null)
  // The real signature for the test-delivery snippet, computed client-side from
  // the one-time secret (WebCrypto is async — null until it lands / unavailable).
  const [testSig, setTestSig] = useState<{ body: string; hex: string } | null>(null)

  // GitHub path (design: repo selector + "Listen for" event rows). The
  // installations probe doubles as the enabled-probe; repos load page 1 per
  // installation and filter client-side (same contract as the Add-agent picker).
  const [gh, setGh] = useState<{ enabled: boolean; installations: GithubInstallationDto[] } | null>(null)
  const [ghRepos, setGhRepos] = useState<GithubRepoChoice[] | null>(null)
  // At least one installation's roster failed to load — the list may be
  // incomplete, which must not read as "no repositories". `denied` = the
  // per-user identity gate refused the caller (actionable: sign in with
  // GitHub); `failed` = upstream trouble (actionable: retry).
  const [ghReposError, setGhReposError] = useState<'failed' | 'denied' | null>(null)
  const [ghRepoPick, setGhRepoPick] = useState<string | null>(
    agent.workspace.mode === 'github' ? agent.workspace.repo : null
  )
  const [ghRepoOpen, setGhRepoOpen] = useState(false)
  const [ghQ, setGhQ] = useState('')
  const [ghExactRepoLoading, setGhExactRepoLoading] = useState(false)
  const [ghFams, setGhFams] = useState<Set<GhFamily>>(new Set(GH_DEFAULT_FAMILIES))
  const [ghMode, setGhMode] = useState<GhTriggerMode>(GH_DEFAULT_TRIGGER_MODE)
  const [ghReviewPolicy, setGhReviewPolicy] = useState<HookReviewPolicy>('full')
  const [ghReportingMode, setGhReportingMode] = useState<HookReportingMode>('check')
  const [ghSyncing, setGhSyncing] = useState(false)
  const [ghAccessSaving, setGhAccessSaving] = useState(false)
  const [ghWorkspaceAccessOverride, setGhWorkspaceAccessOverride] = useState<'write' | null>(null)
  // Repos this agent ALREADY watches — offered rows are disabled, free-typed
  // duplicates rejected inline (the CP 409s them as the backstop).
  const { activeOrg } = useOrgs()
  const agentHooksKey = consoleKeys.agentHooks(activeOrg?.id, agent.id)
  const { data: agentHooksData } = useSWR(agentHooksKey, ([, orgId, , agentId]) => fetchAgentHooks(agentId, orgId))
  const watchedRepos = useMemo(
    () =>
      new Set(
        (agentHooksData ?? [])
          .filter((h) => h.kind === 'github' && h.repoFullName)
          .map((h) => h.repoFullName!.toLowerCase())
      ),
    [agentHooksData]
  )
  const ghRepoAlreadyWatched = !!ghRepoPick && watchedRepos.has(ghRepoPick.toLowerCase())
  // Multi-repo design decision 6 + issue #457 UX layer: a github hook may only
  // watch the agent's workspace repo or an explicitly authorized one (the CP
  // 409s anything else). The picker lists ALL App-visible repos and guides the
  // user to authorize an unpicked one inline. Scratch workspaces have no
  // implicit repo and use this explicit allowlist for every GitHub repo. A
  // manual GitHub workspace remains limited to its own repo.
  const wsRepo = agent.workspace.mode === 'github' ? agent.workspace.repo : null
  const isGithubAppWs = agent.workspace.mode === 'github' && !!agent.workspace.installationId
  const canAuthorizeAdditionalRepos = isGithubAppWs || agent.workspace.mode === 'scratch'
  const agentReposKey = consoleKeys.agentRepos(activeOrg?.id, agent.id)
  const { data: agentReposData, mutate: mutateAgentRepos } = useSWR(agentReposKey, ([, orgId, , agentId]) =>
    fetchAgentRepos(agentId, orgId)
  )
  const authorizedRepos = useMemo(() => agentReposData ?? [], [agentReposData])
  const canEditAgent = agent.canManageSharing
  // Non-null ⇒ the nested authorize-repo dialog is open, prefilled with this
  // owner/repo + the minimum review/reporting tier ('' = no repo prefill).
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
  const ghNeededAccess = requiredRepoAccess({ reviewPolicy: ghReviewPolicy, reportingMode: ghReportingMode })
  const ghSelectedInstallation =
    gh?.installations.find((installation) => installation.id === ghSelectedRepo?.installationId) ??
    installationForRepo(ghRepoPick, gh?.installations ?? [])
  const ghReviewSettingsBlocked =
    !!ghRepoPick &&
    (!repoAccessSatisfies(ghRepoAccess, ghNeededAccess) ||
      (ghReviewPolicy !== 'off' && !hasPullRequestsWritePermission(ghSelectedInstallation)) ||
      (ghReportingMode === 'check' &&
        (!hasChecksWritePermission(ghSelectedInstallation) || !hasPullRequestsReadPermission(ghSelectedInstallation))))

  // 'existing' | 'create'; until the user picks, default to reuse when there is
  // anything to reuse (bots load async, so this is derived, not initial state).
  const [modePick, setModePick] = useState<'existing' | 'create' | null>(null)
  const [botPick, setBotPick] = useState<string | null>(null)
  // Shared-bot opt-in (shared-bot-relay.md §4.1): one bot, many agents, inbound via a
  // relay. Slack-only for now; the CP rejects a shared Telegram/Discord install.
  const [shared, setShared] = useState(false)

  // A bot integration is runnable only when the owning daemon has reported its
  // adapter on register. Do not substitute `maxAgents`: it is a concurrency
  // ceiling, while `caps.platforms` is the adapter-capability declaration.
  const daemon = daemons.find((d) => d.daemonId === agent.daemon)
  const supportedBotPlatforms = daemonsLoading
    ? BOT_PLATFORMS
    : BOT_PLATFORMS.filter((p) => daemon?.caps.platforms.includes(p.key))
  const firstSupportedBotPlatform = supportedBotPlatforms[0]?.key
  // webhook + github are relay/CP-backed triggers — always available, never
  // gated by the daemon's adapter capabilities.
  const isPlatformAvailable = (candidate: Platform) =>
    candidate === 'webhook' ||
    candidate === 'github' ||
    supportedBotPlatforms.some((supported) => supported.key === candidate)
  const selectedBotPlatformSupported = isPlatformAvailable(platform)

  // Switching platform resets the whole bot-identity sub-form: a different platform
  // has different free bots, a different token shape, and its own default mode.
  const pickPlatform = (candidate: Platform) => {
    if (createdHook || !isPlatformAvailable(candidate)) return
    setPlatform(candidate)
    setModePick(null)
    setBotPick(null)
    setShared(false)
    setTransport(null)
    setSigningSecret('')
    setAppName(agent.name)
    setBotToken('')
    setAppToken('')
    setCreateMethod(null)
    setCfgAccess('')
    setCfgRefresh('')
    setShowErrors(false)
    setErr(null)
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
    setTransport(null)
    setSigningSecret('')
    setAppName(agent.name)
    setBotToken('')
    setAppToken('')
    setShowErrors(false)
    setErr(null)
  }, [agent.name, createdHook, daemonsLoading, firstSupportedBotPlatform, selectedBotPlatformSupported])

  // A bot serves one agent at a time; freed (or prebuilt, never-installed) bots of
  // THIS platform are offered for reuse instead of forcing a re-create.
  const freeBots = bots.filter((b) => b.platform === platform && !b.inUseByAgentId)
  const mode = modePick ?? (freeBots.length > 0 ? 'existing' : 'create')
  const selectedBotId = freeBots.some((b) => b.id === botPick) ? botPick : (freeBots[0]?.id ?? null)
  const selectedBot = freeBots.find((b) => b.id === selectedBotId) ?? null
  // The effective Slack transport for the CREATE path: an explicit pick, else the
  // locked default (http when a relay is available, socket when none).
  // Once an auto-install is pending, PIN the transport to what the app was actually
  // created as (the server row) — not the still-editable selector — so a post-start
  // switch can't drive the wrong finalize path. Before that, it's the user's choice.
  const effTransport: 'socket' | 'http' = install
    ? install.transport
    : (transport ?? (relayAvailable ? 'http' : 'socket'))
  // The inline delivery toggle's switch action: pick the transport, and drop the
  // shared opt-in when moving to socket (shared bots are http-only).
  const switchTransport = (next: 'socket' | 'http') => {
    setTransport(next)
    if (next === 'socket') setShared(false)
  }
  // Shared mode is Slack-only AND http-only — a socket bot can never be shared.
  // Create: gate on the chosen transport. Existing: gate on the reused bot's own
  // transport (the selector isn't shown for reuse), so a socket bot never offers it.
  const shareToggleAvailable =
    platform === 'slack' &&
    (mode === 'existing' ? (selectedBot?.transport ?? 'socket') === 'http' : effTransport === 'http')
  // Reusing an already-shared bot is implicitly a shared install.
  const wantShared = shareToggleAvailable && (shared || (mode === 'existing' && !!selectedBot?.shareable))

  // Slack: bot token (xoxb-) + either an app-level Socket Mode token (xapp-, socket)
  // or a signing secret (http). Telegram: one BotFather token (`<id>:<secret>`).
  // Discord: one bot token (no fixed prefix).
  const tokenTrim = botToken.trim()
  const slackBotOk = tokenTrim.startsWith('xoxb-')
  const slackAppOk = appToken.trim().startsWith('xapp-')
  // Slack signing secrets are 32 hex chars; keep the guard lenient.
  const slackSigningOk = signingSecret.trim().length >= 16
  // Aliases used by the Slack funnel UI (auto-install + manual-manifest branches).
  const botOk = slackBotOk
  const appOk = slackAppOk
  const telegramOk = /^\d+:[A-Za-z0-9_-]{20,}$/.test(tokenTrim)
  const discordOk = tokenTrim.length >= 24
  // The application (client) id is base64-encoded in the bot token's first segment, so
  // once a token is pasted we can offer a ready-made "Add to Discord" invite link with
  // the right scopes + permissions (mirrors slackAppIdFromAppToken). Null until decodable.
  const discordAppId = platform === 'discord' ? discordApplicationIdFromToken(tokenTrim) : null
  const singleTokenOk = platform === 'telegram' ? telegramOk : discordOk
  // Feishu: App ID (cli_…) in the botToken slot, App Secret in the appToken slot.
  const feishuAppIdOk = tokenTrim.startsWith('cli_') && tokenTrim.length >= 8
  const feishuSecretOk = appToken.trim().length >= 8
  const feishuOk = feishuAppIdOk && feishuSecretOk
  // Slack: http needs bot + signing secret; socket needs bot + app-level token.
  const slackCreateOk = effTransport === 'http' ? slackBotOk && slackSigningOk : slackBotOk && slackAppOk
  const createValid = platform === 'slack' ? slackCreateOk : platform === 'feishu' ? feishuOk : singleTokenOk
  const valid = mode === 'existing' ? selectedBotId !== null : createValid
  // The app-level token embeds the app id (xapp-1-{APP_ID}-…); once it's pasted we can
  // deep-link straight to THIS app's Slack pages (Slack funnel only) — chiefly the OAuth
  // & Permissions page where the bot token lives — instead of hunting through menus.
  const appId = slackAppIdFromAppToken(appToken)

  // Manifest names mirror the agent's naming model (Slack only): the app name is
  // what the user typed, else the agent's `name` (slug); the channel display name
  // is the agent's `displayName`, falling back to the app name when unset.
  const manifestNames = {
    name: appName.trim() || agent.name,
    ...(agent.displayName ? { displayName: agent.displayName } : {})
  }
  // Manifest transport mirrors the create-path choice; the http request_urls point
  // at the relay's public base (omitted ⇒ buildSlackManifest falls back to socket).
  const manifestOpts = {
    mode: effTransport,
    // Brand the created app with the agent's icon color (matches the CP auto-install
    // funnel) — Slack has no API to set the app image itself.
    backgroundColor: agentIconBackgroundColor(agent.icon),
    ...(relayPublicUrl ? { relayUrl: relayPublicUrl } : {})
  }
  const manifestJson = slackManifestJson(manifestNames, manifestOpts)
  const createUrl = slackCreateAppUrl(manifestNames, manifestOpts)

  // Webhook path: create the hook (secret always minted), then flip to the reveal
  // step — the response is the ONLY time the signing secret is ever shown. Nothing
  // to validate: the name defaults to the agent's; there is no fixed prompt — the
  // agent's description is its standing context and the caller speaks through
  // the delivery payload.
  const submitHook = async () => {
    if (busyRef.current || createdHook) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      const created = await createHook({
        agentId: agent.id,
        name: hookName.trim() || `${agent.name}-webhook`
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

  // Repo pick list: every page from every installation, merged. GitHub offers
  // no server-side search for App installations, so the dropdown filters this
  // complete App-visible roster client-side.
  useEffect(() => {
    if (platform !== 'github' || !gh?.enabled || gh.installations.length === 0 || ghRepos !== null) return
    let alive = true
    const ctrl = new AbortController()
    void Promise.all(
      gh.installations.map(async (installation) => {
        try {
          const repos = await fetchAllGithubRepos(installation.id, ctrl.signal)
          return { page: repos.map((repo) => ({ ...repo, installationId: installation.id })) }
        } catch (e) {
          const denied = e instanceof ApiError && e.code === 'GITHUB_IDENTITY_REQUIRED'
          return { error: denied ? ('denied' as const) : ('failed' as const) }
        }
      })
    ).then((batches) => {
      if (!alive) return
      // A failed roster read (GitHub outage) must not render as an empty
      // list — keep the pages that loaded and surface the gap with a retry.
      // An identity denial outranks a generic failure for messaging.
      setGhReposError(batches.find((b) => b.error === 'denied')?.error ?? batches.find((b) => b.error)?.error ?? null)
      setGhRepos(batches.flatMap((b) => b.page ?? []))
    })
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [platform, gh, ghRepos])

  // Resolve a complete owner/repo input directly as a fallback if a paged
  // roster request failed or the repository appeared after the roster loaded.
  const ghTypedRepo = /^[^/\s]+\/[^/\s]+$/.test(ghQ.trim()) ? ghQ.trim() : null
  useEffect(() => {
    const exactAlreadyLoaded =
      !!ghTypedRepo && ghRepos?.some((repo) => repo.fullName.toLowerCase() === ghTypedRepo.toLowerCase())
    if (
      platform !== 'github' ||
      !ghRepoOpen ||
      !gh?.enabled ||
      gh.installations.length === 0 ||
      ghRepos === null ||
      !ghTypedRepo ||
      exactAlreadyLoaded
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
      void Promise.all(
        gh.installations.map(async (installation) => {
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
  }, [platform, ghRepoOpen, gh, ghRepos, ghTypedRepo])

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

  // One subscription = one hook row on this agent, named after the repo. The CP
  // resolves owner/repo to the numeric id, 400s anything outside the grant, and
  // 409s a repo this agent already watches.
  const submitGithub = async () => {
    if (busyRef.current || !ghRepoPick || ghFams.size === 0) return
    if (watchedRepos.has(ghRepoPick.toLowerCase())) {
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
    if (ghReviewPolicy !== 'off' && !hasPullRequestsWritePermission(ghSelectedInstallation)) {
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
      ghReportingMode === 'check' &&
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
      await createGithubHook({
        agentId: agent.id,
        name: ghRepoPick,
        repoFullName: ghRepoPick,
        events: eventsForFamilies(ghFams, ghMode),
        commentFamilies: commentFamiliesForFamilies(ghFams),
        mentionOnly: ghMode === 'mention',
        reviewPolicy: ghReviewPolicy,
        reportingMode: ghReportingMode,
        gateMode: 'informational'
      })
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
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

  const submit = async () => {
    if (platform === 'webhook' || platform === 'github') return // those commit via submitHook/submitGithub (narrows for TS too)
    setShowErrors(true)
    if (busyRef.current || !valid) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      let input: CreateIntegrationInput
      if (mode === 'existing') {
        // Slack carries the reused bot's own transport so the CP validates
        // shareable⇒http consistently; telegram/discord have no transport field.
        input =
          platform === 'slack'
            ? {
                platform: 'slack',
                agentId: agent.id,
                botId: selectedBotId!,
                transport: selectedBot?.transport ?? 'socket',
                ...(wantShared ? { shareable: true } : {})
              }
            : { platform, agentId: agent.id, botId: selectedBotId!, ...(wantShared ? { shareable: true } : {}) }
      } else if (platform === 'slack') {
        // shareable is attached ONLY under http (a socket bot can never be shared).
        input =
          effTransport === 'http'
            ? {
                platform: 'slack',
                agentId: agent.id,
                transport: 'http',
                ...(appName.trim() ? { name: appName.trim() } : {}),
                ...(wantShared ? { shareable: true } : {}),
                slack: { botToken: tokenTrim, signingSecret: signingSecret.trim() }
              }
            : {
                platform: 'slack',
                agentId: agent.id,
                transport: 'socket',
                ...(appName.trim() ? { name: appName.trim() } : {}),
                slack: { botToken: tokenTrim, appToken: appToken.trim() }
              }
      } else if (platform === 'telegram') {
        input = { platform: 'telegram', agentId: agent.id, telegram: { botToken: tokenTrim } }
      } else if (platform === 'feishu') {
        input = {
          platform: 'feishu',
          agentId: agent.id,
          feishu: { appId: tokenTrim, appSecret: appToken.trim(), region: feishuRegion }
        }
      } else {
        input = { platform: 'discord', agentId: agent.id, discord: { botToken: tokenTrim } }
      }
      await createIntegration(input)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
      busyRef.current = false
    }
  }

  // Config-token method commit: store the pasted configuration token (same per-user store
  // as the Profile card), then immediately create the Slack app + open OAuth — the CP uses
  // the stored config token to mint the app. Refresh token optional (access-only lasts ~12h;
  // a refresh token keeps it from expiring).
  const saveConfigAndStart = async () => {
    setShowErrors(true)
    if (busyRef.current || !cfgAccess.trim() || install) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      const refreshTrim = cfgRefresh.trim()
      const s = await saveSlackConfig({
        accessToken: cfgAccess.trim(),
        ...(refreshTrim ? { refreshToken: refreshTrim } : {})
      })
      setAutoUsable(s.autoAvailable)
      setRelayAvailable(s.relayAvailable)
      setRelayPublicUrl(s.relayPublicUrl)
      setCfgAccess('')
      setCfgRefresh('')
      // Create the app with the just-stored config token and open the Slack OAuth tab.
      const nextTransport = transport ?? (s.relayAvailable ? 'http' : 'socket')
      const started = await startSlackInstall({
        agentId: agent.id,
        transport: nextTransport,
        ...(appName.trim() ? { name: appName.trim() } : {})
      })
      setInstall(started)
      setAutoPhase('authorizing')
      window.open(started.installUrl, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
      busyRef.current = false
    }
  }

  // Auto flow — step 1: create the app (with the caller's stored config token) + open
  // the Slack OAuth install in a new tab.
  const startAuto = async () => {
    // `install` guard: once a start has succeeded, never create a second app.
    if (busyRef.current || install) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      const started = await startSlackInstall({
        agentId: agent.id,
        transport: effTransport,
        ...(appName.trim() ? { name: appName.trim() } : {})
      })
      setInstall(started)
      setAutoPhase('authorizing')
      window.open(started.installUrl, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
      busyRef.current = false
    }
  }

  // Abandon the current pending install and return to the config step — the escape
  // hatch when the Slack approval was denied / never finished (otherwise the poll sits
  // on "Waiting for Slack…" forever). The orphaned pending row is reaped by TTL.
  const restartAuto = () => {
    if (busyRef.current) return
    setInstall(null)
    setAutoPhase('config')
    setErr(null)
  }

  // Auto flow — final step. Socket: hand the CP the pasted app-level token; it
  // combines it with the OAuth-obtained bot token to create the bot + integration.
  // Http: no token — the CP reads the signing secret via the caller's config token,
  // so finalize is fully automatic.
  const finalizeAuto = async () => {
    setShowErrors(true)
    if (busyRef.current || !install) return
    if (effTransport === 'socket' && !appOk) return
    busyRef.current = true
    setSaving(true)
    setErr(null)
    try {
      await finalizeSlackInstall(install.installId, {
        // socket: the pasted app-level token; http: none. The shared choice rides here too.
        ...(effTransport === 'socket' ? { appToken: appToken.trim() } : {}),
        ...(wantShared ? { shareable: true } : {})
      })
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
      busyRef.current = false
    }
  }

  // On open (create mode), ask the CP whether auto-install is possible here (the funnel
  // callback is configured) and whether the CALLER has stored their own config token.
  // Funnel on + own token ⇒ straight to auto; otherwise ⇒ manual app-token + bot-token
  // entry. Slack-only: the config-token funnel is a Slack concept, so never probe it
  // for Telegram / Discord (and never let its result gate their footer — see `isAuto`).
  useEffect(() => {
    if (mode !== 'create' || platform !== 'slack' || slackFunnel !== null) return
    let alive = true
    fetchSlackConfig()
      .then((c) => {
        if (!alive) return
        setSlackFunnel(c.funnelEnabled)
        setAutoUsable(c.autoAvailable)
        setRelayAvailable(c.relayAvailable)
        setRelayPublicUrl(c.relayPublicUrl)
      })
      .catch(() => alive && setSlackFunnel(false)) // any error ⇒ fall back to manual
    return () => {
      alive = false
    }
  }, [mode, platform, slackFunnel])

  // While the user approves the install in the other tab, poll until the CP has the
  // bot token, then reveal the app-level-token step. Cleared on close / phase change.
  useEffect(() => {
    if (mode !== 'create' || slackFunnel !== true || autoPhase !== 'authorizing' || !install) return
    let alive = true
    const tick = async () => {
      try {
        const s = await getSlackInstall(install.installId)
        if (alive && s.status === 'bot_ready') setAutoPhase('appToken')
      } catch {
        /* transient — keep polling */
      }
    }
    const h = setInterval(() => void tick(), 2500)
    void tick()
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [mode, slackFunnel, autoPhase, install])

  // The footer primary adapts to the flow. In the auto flow each STEP owns its own
  // action inline (step ① "Create & install" next to the name; step ② the token field),
  // so the footer is the final commit — "Connect" (finalize), live only once the app is
  // installed and a valid app-level token is pasted. The webhook path is two-step:
  // create (mints URL + secret) → reveal → Done.
  // Auto-install (config-token funnel) works for BOTH transports: socket ends with the
  // operator pasting the app-level (xapp) token; http is fully automatic — the CP builds
  // an Events-API manifest and captures the signing secret from apps.manifest.create, so
  // there's no paste step. `shareable` is threaded through `startAuto`.
  // Config token is the recommended method for both transports; `bot` is the manual
  // fallback the user can switch to. Default to config when the funnel is enabled.
  const slackMethod: 'config' | 'bot' = createMethod ?? (slackFunnel === true ? 'config' : 'bot')
  const selectMethod = (m: 'config' | 'bot') => {
    setCreateMethod(m)
    setShowErrors(false)
    setErr(null)
  }
  const isAuto =
    mode === 'create' && platform === 'slack' && slackFunnel === true && slackMethod === 'config' && autoUsable
  // Config method chosen but nothing usable stored yet ⇒ the inline config-token entry
  // is shown and the footer commits it (save + create the app).
  const isConfigSetup =
    mode === 'create' && platform === 'slack' && slackFunnel === true && slackMethod === 'config' && !autoUsable
  const footer =
    platform === 'webhook'
      ? createdHook
        ? { label: 'Done', act: onClose, enabled: true }
        : { label: 'Connect & authorize', act: () => void submitHook(), enabled: true }
      : platform === 'github'
        ? {
            label: 'Connect',
            act: () => void submitGithub(),
            enabled: !!ghRepoPick && !ghRepoAlreadyWatched && ghFams.size > 0 && !ghReviewSettingsBlocked
          }
        : isAuto
          ? {
              label: 'Connect',
              act: () => void finalizeAuto(),
              // Enabled once the install reaches bot-ready. Socket also needs the pasted
              // app-level token; http finalizes with none (signing secret already captured).
              enabled: autoPhase === 'appToken' && (effTransport === 'http' || appOk)
            }
          : isConfigSetup
            ? { label: 'Connect & authorize', act: () => void saveConfigAndStart(), enabled: !!cfgAccess.trim() }
            : { label: 'Connect & authorize', act: () => void submit(), enabled: valid }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="plug" size={17} color="var(--brand)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[16px] font-semibold leading-normal">Add integration</div>
          <div className="mt-[1px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            for <span className="mono">{agentLabel(agent)}</span> — this agent answers on the workspace
          </div>
        </div>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="fldlbl mb-2">Platform</div>
        <div className="mb-[18px] grid grid-cols-2 gap-[10px] desktop:grid-cols-6">
          {PLATFORMS.map((candidate) => {
            const available = isPlatformAvailable(candidate.key)
            const on = available && platform === candidate.key
            return (
              <div
                key={candidate.key}
                className={`${on ? 'ptile on' : 'ptile'} desktop:flex-col desktop:justify-center desktop:gap-[6px] desktop:px-2 desktop:text-center ${
                  available ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                }`}
                aria-disabled={!available}
                title={available ? undefined : 'Not supported by this daemon'}
                onClick={available ? () => pickPlatform(candidate.key) : undefined}
              >
                {candidate.key === 'github' ? (
                  <span className="flex h-[26px] w-[26px] flex-none items-center justify-center [&>svg]:h-full [&>svg]:w-full">
                    <GithubMark />
                  </span>
                ) : (
                  <span className="imark h-[26px] w-[26px] border-0 bg-transparent">
                    <PlatformMark platform={candidate.key} fillPct={100} />
                  </span>
                )}
                <span className="font-sans text-[13px] font-semibold leading-normal">{candidate.label}</span>
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
            <div className="mt-3 flex items-start gap-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
              <Icon name="info" size={13} className="mt-[1px] flex-none" />
              <span>
                The payload is the message — the <span className="mono">message</span> field in your JSON tells the
                agent what to do (its description already sets the standing context). Connecting mints the URL and
                signing secret next.
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
              <span className="mono">message</span> field speaks for the caller). The endpoint lives on the relay pool —
              payloads never touch the control plane.
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
                  body. The relay verifies it before dispatching to the agent.{' '}
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
                            className="mx-[2px] min-h-[20px] min-w-[18ch] flex-1 resize-none overflow-hidden rounded-xs border border-(--border-subtle) bg-(--surface-active) px-[3px] py-0 font-mono text-[12px] leading-[1.65] text-[#cdd6e0] outline-none focus:border-(--brand)"
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
                        watched: watchedRepos.has(lc),
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
                  const typedWatched = !!typedLc && watchedRepos.has(typedLc)
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
                                {ghReposError && (
                                  <div className="flex items-center gap-2 px-2 py-[7px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                                    <span className="min-w-0 flex-1">
                                      {ghReposError === 'denied'
                                        ? 'Your GitHub identity could not be verified — sign in with GitHub, then retry.'
                                        : 'Couldn’t load repositories from GitHub — the list may be incomplete.'}
                                    </span>
                                    <button
                                      type="button"
                                      className="lnk flex-none text-[12px]"
                                      onClick={() => {
                                        setGhReposError(null)
                                        setGhRepos(null) // re-arms the roster effect
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
                                            <span className={REPO_ACCESS_BADGE[authTier]}>{authTier}</span>
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
                {/* Design: compact 3-up tile grids — 16px lead glyph, 12.5px title,
                    11.5px fragment subtitle; checkbox / radio per tile. */}
                <div className="fldlbl mb-2">Listen for</div>
                <div className="mb-4 grid grid-cols-1 gap-[9px] min-[440px]:grid-cols-2">
                  {GH_FAMILIES.map((r) => {
                    const on = ghFams.has(r.fam)
                    return (
                      <div
                        key={r.fam}
                        className={`flex min-w-0 cursor-pointer items-start gap-[9px] rounded-[9px] border px-3 py-[10px] ${
                          on ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-default) bg-(--surface-card)'
                        }`}
                        onClick={() => toggleGhFam(r.fam)}
                      >
                        <Icon
                          name={r.icon}
                          size={16}
                          color={on ? 'var(--brand)' : 'var(--text-tertiary)'}
                          className="mt-[1px] flex-none"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block font-sans text-[12.5px] font-semibold leading-normal">{r.label}</span>
                          <span className="mt-[2px] block font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                            {r.desc}
                          </span>
                        </span>
                        <span
                          className={`mt-[1px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border-[1.5px] ${
                            on ? 'border-(--brand) bg-(--brand)' : 'border-(--border-default) bg-(--surface-card)'
                          }`}
                        >
                          {on && <Icon name="check" size={12} color="#fff" />}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="fldlbl mb-2">Trigger when</div>
                <div className="mb-4 grid grid-cols-1 gap-[9px] min-[440px]:grid-cols-3">
                  {GH_TRIGGER_TILES.map((m) => {
                    const on = ghMode === m.mode
                    return (
                      <div
                        key={m.mode}
                        title={m.mode === 'mention' ? githubMentionUsage(agent.name) : undefined}
                        className={`flex min-w-0 cursor-pointer items-start gap-[9px] rounded-[9px] border px-3 py-[10px] ${
                          on ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-default) bg-(--surface-card)'
                        }`}
                        onClick={() => setGhMode(m.mode)}
                      >
                        <span
                          className={`mt-[1px] flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] bg-(--surface-card) ${
                            on ? 'border-(--brand)' : 'border-(--border-default)'
                          }`}
                        >
                          {on && <span className="h-2 w-2 rounded-full bg-(--brand)" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-sans text-[12.5px] font-semibold leading-normal">{m.label}</span>
                          <span className="mt-[2px] block font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                            {m.desc}
                          </span>
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="mb-4">
                  <GithubReviewSettings
                    value={{ reviewPolicy: ghReviewPolicy, reportingMode: ghReportingMode }}
                    onReviewPolicyChange={(policy) => {
                      setGhReviewPolicy(policy)
                      setErr(null)
                    }}
                    onReportingModeChange={(mode) => {
                      setGhReportingMode(mode)
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
                </div>
              </>
            )}
          </>
        )}
        {platform !== 'webhook' && platform !== 'github' && <div className="fldlbl mb-2">Bot identity</div>}
        {/* A bot is installed on one agent at a time and OUTLIVES its integration:
            reuse a freed / prebuilt one, or create a new bot for this platform.
            (Webhook and GitHub are bot-less — their bodies render above instead.) */}
        {platform !== 'webhook' && platform !== 'github' && (
          <div className="mb-3 grid grid-cols-1 gap-[10px] min-[440px]:grid-cols-2">
            {(
              [
                {
                  key: 'existing' as const,
                  icon: 'bot',
                  title: 'Use an existing bot',
                  desc: "A bot you've created that no agent is using."
                },
                {
                  key: 'create' as const,
                  icon: 'key-round',
                  title: 'Create a new bot',
                  desc: CREATE_DESC[platform]
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
                    <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
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
        {platform !== 'webhook' && platform !== 'github' && mode === 'existing' && (
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
                        <span className="badge bg-(--surface-active) text-(--text-tertiary)">prebuilt</span>
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
        {mode === 'create' && platform === 'slack' && (
          <>
            {slackFunnel === null ? (
              <div className="mb-4 flex items-center gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                <Icon name="loader" size={15} className="flex-none animate-spin" />
                Checking your Slack setup…
              </div>
            ) : (
              <>
                {slackFunnel === true && (
                  <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-[6px]">
                    <div className="inline-flex flex-none rounded-lg border border-(--border-default) bg-(--surface-card) p-[3px]">
                      {(['config', 'bot'] as const).map((m) => {
                        const on = slackMethod === m
                        return (
                          <button
                            key={m}
                            type="button"
                            onClick={() => selectMethod(m)}
                            className={`rounded-[6px] px-[11px] py-[5px] font-sans text-[12px] font-semibold leading-normal ${
                              on ? 'bg-(--brand-soft) text-(--brand)' : 'bg-transparent text-(--text-tertiary)'
                            }`}
                          >
                            {m === 'config' ? 'Config token' : 'Bot token'}
                          </button>
                        )
                      })}
                    </div>
                    <span className="min-w-0 flex-1 font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                      {slackMethod === 'config'
                        ? 'Recommended — one-click install, no manifest to copy or tokens to paste.'
                        : 'Manual — copy our manifest into Slack, install, and paste the tokens back.'}
                    </span>
                  </div>
                )}
                {slackMethod === 'config' && autoUsable ? (
                  <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
                    <div className="mb-[14px]">
                      <SlackDeliveryLine
                        transport={effTransport}
                        relayAvailable={relayAvailable}
                        locked={!!install}
                        onSwitch={switchTransport}
                      />
                    </div>

                    {/* Step 1 — create & install (content changes by phase). */}
                    <div className="flex gap-[10px]">
                      {autoPhase === 'appToken' ? (
                        <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--brand-soft)">
                          <Icon name="check" size={12} color="var(--brand)" />
                        </span>
                      ) : (
                        <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                          1
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        {autoPhase === 'config' && (
                          <>
                            <div className="mb-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                              Name &amp; create the app (name optional)
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="fld flex-1">
                                <input
                                  className="inp mn"
                                  placeholder={
                                    manifestNames.name
                                      ? `${manifestNames.name} — from the agent's name`
                                      : 'Bot name (optional) — e.g. acme-agent'
                                  }
                                  value={appName}
                                  onChange={(e) => setAppName(e.target.value)}
                                />
                              </div>
                              <Button
                                onClick={() => void startAuto()}
                                className={saving ? 'flex-none cursor-default opacity-50' : 'flex-none'}
                              >
                                <Icon name="plus" size={14} />
                                {saving ? 'Creating…' : 'Create & install'}
                              </Button>
                            </div>
                          </>
                        )}
                        {autoPhase === 'authorizing' && (
                          <>
                            <div className="flex items-center gap-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                              <Icon name="loader" size={14} className="flex-none animate-spin" />
                              Approve the install in Slack
                            </div>
                            <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                              We opened Slack in a new tab — click &ldquo;Allow&rdquo;, then come back. This updates
                              automatically.
                            </div>
                            {install && (
                              <div className="mt-2 flex items-center gap-[14px]">
                                <a
                                  href={install.installUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="lnk inline-flex items-center gap-[5px]"
                                >
                                  Reopen the Slack install
                                  <Icon name="external-link" size={12} />
                                </a>
                                <button type="button" className="lnk" onClick={restartAuto}>
                                  Start over
                                </button>
                              </div>
                            )}
                          </>
                        )}
                        {autoPhase === 'appToken' && (
                          <div className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                            {effTransport === 'http'
                              ? 'App created & installed — click Connect to finish'
                              : 'App created & installed — bot token secured'}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Step 2 — app-level token. Socket only: http needs no xapp paste
                    (the CP reads the signing secret itself), so the footer Connect
                    finalizes directly once the install is approved. */}
                    {effTransport === 'socket' && (
                      <div
                        className={`mt-[14px] border-t border-dashed border-(--border-default) pt-[13px] ${
                          autoPhase === 'appToken' ? '' : 'opacity-55'
                        }`}
                      >
                        <div className="flex gap-[10px]">
                          <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                            2
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="mb-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                              Generate the App-Level token &amp; paste it{' '}
                              <span className="font-normal text-(--text-tertiary)">
                                (Slack has no API for this one)
                              </span>
                            </div>
                            <div className="fld">
                              <input
                                className={`inp mn ${showErrors && !appOk ? 'border-(--status-error)' : ''}`}
                                placeholder="xapp-…"
                                value={appToken}
                                onChange={(e) => setAppToken(e.target.value)}
                                disabled={autoPhase !== 'appToken'}
                              />
                            </div>
                            {autoPhase === 'appToken' && install ? (
                              <a
                                href={slackAppSettingsUrl(install.appId)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="lnk mt-[10px] inline-flex items-center gap-[5px]"
                              >
                                Generate the App-Level token
                                <Icon name="external-link" size={12} />
                              </a>
                            ) : (
                              <div className="mt-[8px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                                Unlocks once you approve the install in Slack.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : slackMethod === 'config' ? (
                  <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
                    {/* Step 1 — open Slack's App Configuration Tokens page (hover previews
                    where it lives: scroll to the bottom of Your apps, then Copy). */}
                    <div className="flex gap-[10px]">
                      <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                        1
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="cfgtok relative">
                          <SlackConfigTokenPreview />
                          <a
                            href="https://api.slack.com/apps"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
                          >
                            <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                              <PlatformMark platform="slack" />
                            </span>
                            Open Slack app config tokens
                            <Icon name="external-link" size={14} />
                          </a>
                        </div>
                        <div className="mt-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                          Under <span className="mono">Your apps</span> →{' '}
                          <span className="mono">configuration tokens</span>, pick the workspace and generate a token
                          pair. The app is created in that workspace.
                        </div>
                      </div>
                    </div>
                    {/* Step 2 — paste the configuration token pair (one row; hints inline). */}
                    <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
                      <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                        2
                      </span>
                      <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                        Paste your configuration token
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-[10px] pl-[30px] min-[440px]:grid-cols-2">
                      <div className="fld">
                        <span className="fldlbl">
                          Access Token <span className="font-normal text-(--text-tertiary)">· required</span>
                        </span>
                        <input
                          className={`inp mn ${showErrors && !cfgAccess.trim() ? 'border-(--status-error)' : ''}`}
                          placeholder="xoxe.xoxp-1-…"
                          value={cfgAccess}
                          onChange={(e) => setCfgAccess(e.target.value)}
                        />
                      </div>
                      <div className="fld">
                        <span className="fldlbl">
                          Refresh Token{' '}
                          <span className="font-normal text-(--text-tertiary)">· optional, saved for reuse</span>
                        </span>
                        <input
                          className="inp mn"
                          placeholder="xoxe-1-…"
                          value={cfgRefresh}
                          onChange={(e) => setCfgRefresh(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
                    {/* Step 1 — create & install from our manifest. The agent name is
                    built into the manifest, so no separate name field here. */}
                    <div className="mb-3 flex gap-[10px]">
                      <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                        1
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="mb-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                          Create &amp; install the Slack app from our manifest
                        </div>
                        <div className="group relative">
                          <a
                            href={createUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => void navigator.clipboard?.writeText?.(manifestJson)?.catch?.(() => {})}
                            className="flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
                          >
                            <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                              <PlatformMark platform="slack" />
                            </span>
                            Copy manifest &amp; open Slack
                            <Icon name="external-link" size={14} />
                          </a>
                          <SlackManifestPreview />
                        </div>
                        <div className="mt-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                          In Slack, choose <span className="font-medium text-(--text-secondary)">From a manifest</span>,
                          paste, select a workspace, then create and install the app.
                        </div>
                        <SlackDeliveryLine
                          transport={effTransport}
                          relayAvailable={relayAvailable}
                          locked={false}
                          onSwitch={switchTransport}
                        />
                      </div>
                    </div>
                    {/* Step 2 — paste the tokens the install gives back. */}
                    <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
                      <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                        2
                      </span>
                      <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                        Paste the tokens it gives you — required to connect
                      </span>
                    </div>
                    <div className="pl-[30px]">
                      <div className="grid grid-cols-1 gap-[10px] min-[440px]:grid-cols-2">
                        <div className="fld">
                          <span className="fldlbl">Bot token</span>
                          <input
                            className={`inp mn ${showErrors && !botOk ? 'border-(--status-error)' : ''}`}
                            placeholder="xoxb-…"
                            value={botToken}
                            onChange={(e) => setBotToken(e.target.value)}
                          />
                        </div>
                        {effTransport === 'http' ? (
                          <div className="fld">
                            <span className="fldlbl">Signing secret</span>
                            <input
                              className={`inp mn ${showErrors && !slackSigningOk ? 'border-(--status-error)' : ''}`}
                              placeholder="Signing secret (Basic Information → App Credentials)"
                              value={signingSecret}
                              onChange={(e) => setSigningSecret(e.target.value)}
                            />
                          </div>
                        ) : (
                          <div className="fld">
                            <span className="fldlbl">App-level token</span>
                            <input
                              className={`inp mn ${showErrors && !appOk ? 'border-(--status-error)' : ''}`}
                              placeholder="xapp-…"
                              value={appToken}
                              onChange={(e) => setAppToken(e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                      {/* Socket: once the app-level token decodes, deep-link to the app's
                      Bot-token + settings pages (progressive — hidden until pasted). */}
                      {effTransport === 'socket' && appId && (
                        <div className="mt-[10px] flex flex-wrap items-center gap-x-[14px] gap-y-1 font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                          <span className="flex items-center gap-[5px]">
                            <Icon name="corner-down-right" size={12} className="flex-none" />
                            App&nbsp;<span className="mono">{appId}</span>
                          </span>
                          <a
                            href={slackAppOAuthUrl(appId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="lnk inline-flex items-center gap-[5px]"
                          >
                            Copy the Bot token
                            <Icon name="external-link" size={12} />
                          </a>
                          <a
                            href={slackAppSettingsUrl(appId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="lnk inline-flex items-center gap-[5px]"
                          >
                            Open app settings
                            <Icon name="external-link" size={12} />
                          </a>
                        </div>
                      )}
                      {/* Bot-token path only: getting the Bot User OAuth token means installing
                      the app, and if Slack flags changed scopes it shows a "reinstall your
                      app" banner — reinstalling once is what activates the token pasted above. */}
                      <div className="mt-[11px] flex items-start gap-2 rounded-lg bg-(--status-paused-soft) px-[11px] py-[9px]">
                        <Icon
                          name="triangle-alert"
                          size={14}
                          color="var(--status-paused)"
                          className="mt-[1px] flex-none"
                        />
                        <span className="min-w-0 flex-1 font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-secondary)">
                          If Slack shows{' '}
                          <span className="font-medium">
                            “You’ve changed the permission scopes… reinstall your app”
                          </span>
                          , click <span className="font-medium">Reinstall</span> once — that’s what activates the Bot
                          User OAuth token you paste above.
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
        {mode === 'create' &&
          platform !== 'slack' &&
          platform !== 'feishu' &&
          platform !== 'webhook' &&
          platform !== 'github' && (
            <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
              <div className="mb-3 flex gap-[10px]">
                <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                  1
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-2 font-sans text-[12.5px] font-medium leading-[1.45] text-(--text-secondary)">
                    {GUIDE[platform].step1}
                  </div>
                  <a
                    href={GUIDE[platform].linkHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
                  >
                    <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                      <PlatformMark platform={platform} />
                    </span>
                    {GUIDE[platform].linkLabel}
                    <Icon name="external-link" size={14} />
                  </a>
                  {GUIDE[platform].step1Warning && (
                    <div className="mt-2 font-sans text-[12px] font-medium leading-[1.5] text-(--status-error)">
                      {GUIDE[platform].step1Warning}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
                <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                  2
                </span>
                <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                  Paste the bot token — required to connect
                </span>
              </div>
              <div className="pl-[30px]">
                <div className="fld">
                  <span className="fldlbl">Bot token</span>
                  <input
                    className={`inp mn ${showErrors && !singleTokenOk ? 'border-(--status-error)' : ''}`}
                    placeholder={GUIDE[platform].tokenPlaceholder}
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                  />
                </div>
                {/* Discord: the invite is the fiddly part (right scopes + permissions), so once
                  the token decodes to an app id we hand the user a ready-made invite link. */}
                {platform === 'discord' &&
                  (discordAppId ? (
                    <>
                      <a
                        href={discordBotInviteUrl(discordAppId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-[12px] flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
                      >
                        <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                          <PlatformMark platform="discord" />
                        </span>
                        Add to Discord
                        <Icon name="external-link" size={14} />
                      </a>
                      <div className="mt-[8px] flex flex-wrap items-center gap-x-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                        <Icon name="corner-down-right" size={12} className="flex-none" />
                        App&nbsp;<span className="mono">{discordAppId}</span>
                        <span>
                          — invites with the bot &amp; applications.commands scopes and the right permissions.
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="mt-[8px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                      Paste the bot token and an “Add to Discord” button appears — no need to build the invite URL by
                      hand.
                    </div>
                  ))}
              </div>
            </div>
          )}
        {/* Feishu needs TWO credentials (App ID + App Secret), so it gets its own create
            block instead of the single-token generic one above — mirroring Slack. */}
        {mode === 'create' && platform === 'feishu' && (
          <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
            {/* Region picks the open-platform gateway: Feishu (China, open.feishu.cn) vs
                Lark (international, open.larksuite.com). Same app model, different console
                + host — an app is registered in one region, so the operator chooses first. */}
            <div className="mb-3">
              <span className="fldlbl mb-[6px] block">Region</span>
              <div className="grid grid-cols-2 gap-[6px]" role="radiogroup" aria-label="Feishu region">
                {(
                  [
                    { key: 'feishu', label: 'Feishu', sub: '飞书 · China' },
                    { key: 'lark', label: 'Lark', sub: 'International' }
                  ] as const
                ).map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    role="radio"
                    aria-checked={feishuRegion === r.key}
                    onClick={() => setFeishuRegion(r.key)}
                    className={`flex flex-col items-start gap-[1px] rounded-md border px-[11px] py-[7px] text-left ${
                      feishuRegion === r.key
                        ? 'border-(--brand) bg-(--surface-active)'
                        : 'border-(--border-default) bg-(--surface-app)'
                    }`}
                  >
                    <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                      {r.label}
                    </span>
                    <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {r.sub}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-3 flex gap-[10px]">
              <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                1
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-2 font-sans text-[12.5px] font-medium leading-[1.45] text-(--text-secondary)">
                  Create a self-built app in the {feishuRegion === 'lark' ? 'Lark' : 'Feishu'} console, enable the bot,
                  then copy its App ID and App Secret from Credentials &amp; Basic Info.
                </div>
                <a
                  href={feishuRegion === 'lark' ? 'https://open.larksuite.com/' : 'https://open.feishu.cn/'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
                >
                  <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                    <PlatformMark platform="feishu" />
                  </span>
                  Open the {feishuRegion === 'lark' ? 'Lark' : 'Feishu'} console
                  <Icon name="external-link" size={14} />
                </a>
              </div>
            </div>
            <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
              <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                2
              </span>
              <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                Paste the App ID &amp; App Secret — both required to connect
              </span>
            </div>
            <div className="grid grid-cols-1 gap-[10px] pl-[30px] min-[440px]:grid-cols-2">
              <div className="fld">
                <span className="fldlbl">App ID</span>
                <input
                  className={`inp mn ${showErrors && !feishuAppIdOk ? 'border-(--status-error)' : ''}`}
                  placeholder="cli_…"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                />
              </div>
              <div className="fld">
                <span className="fldlbl">App Secret</span>
                <input
                  className={`inp mn ${showErrors && !feishuSecretOk ? 'border-(--status-error)' : ''}`}
                  placeholder="App Secret"
                  value={appToken}
                  onChange={(e) => setAppToken(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
        {platform === 'feishu' && (
          <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
            <div className="mb-[11px] flex items-center gap-2 font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)">
              <Icon name="shield-check" size={14} color="var(--brand)" className="flex-none" />
              Feishu setup checklist
            </div>
            <ul className="flex flex-col gap-[10px]">
              {FEISHU_REQS.map((r) => (
                <li key={r.title} className="flex items-start gap-2">
                  <Icon name={r.icon} size={14} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
                  <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                    <span className="font-medium text-(--text-secondary)">{r.title}</span> — {r.desc}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {platform === 'discord' && (
          <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
            <div className="mb-[11px] flex items-center gap-2 font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)">
              <Icon name="shield-check" size={14} color="var(--brand)" className="flex-none" />
              Discord setup checklist
            </div>
            <ul className="flex flex-col gap-[10px]">
              {DISCORD_REQS.map((r) => (
                <li key={r.title} className="flex items-start gap-2">
                  <Icon name={r.icon} size={14} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
                  <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                    <span className="font-medium text-(--text-secondary)">{r.title}</span> — {r.desc}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex items-start gap-2 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="hash" size={14} className="mt-[1px] flex-none" />
          <span>
            {platform === 'webhook'
              ? 'Each POST becomes a session, routed to this agent by the endpoint path. Retries are de-duplicated by the X-AC-Delivery-Key header (auto-assigned when absent).'
              : platform === 'github'
                ? 'Matching events run the agent in a session and reply on the same PR, issue or commit thread.'
                : platform === 'slack'
                  ? IM_INVITE_HINT.slack
                  : platform === 'feishu'
                    ? IM_INVITE_HINT.feishu
                    : IM_INVITE_HINT[platform]}
          </span>
        </div>
        {shareToggleAvailable && (
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
        <Button onClick={footer.act} className={footer.enabled && !saving ? undefined : 'cursor-default opacity-50'}>
          <Icon name={platform === 'webhook' && createdHook ? 'check' : 'plug'} size={15} />
          {saving ? (isAuto && autoPhase === 'config' ? 'Creating…' : 'Connecting…') : footer.label}
        </Button>
      </div>
      {/* Nested authorize-repo dialog (its own fixed overlay): grant the typed
          repo, then continue creating the hook with it pre-picked. */}
      {authRepoFor !== null && (
        <AddAgentRepoModal
          agent={agent}
          workspaceRepo={isGithubAppWs ? wsRepo : null}
          authorized={authorizedRepos}
          initialAccess={authRepoFor.access}
          {...(!isGithubAppWs && wsRepo ? { fixedRepo: wsRepo } : {})}
          {...(authRepoFor.repo ? { initialRepo: authRepoFor.repo } : {})}
          onClose={() => setAuthRepoFor(null)}
          onCreated={(row) => {
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
