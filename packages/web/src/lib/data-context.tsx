'use client'

// Console data layer. Fetches the live read models from the Control Plane. By
// default the console shows ONLY that live data. In mock mode (`NEXT_PUBLIC_MOCK`,
// see `MOCK_MODE`) it also merges in static demo content from `./data` (real rows
// first, mock rows appended) so those views are populated with no CP running.
// Daemons are LIVE-ONLY — they are the physical fleet, so a fabricated "mocked-edge"
// would be indistinguishable from a real daemon that has gone offline.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { useSessionList } from '@/lib/use-session-list'
import { randomUuid } from '@/lib/random-uuid'
import { accessNotificationSnapshot, type AccessNotificationSnapshot } from '@/lib/access-notification-snapshot'
import {
  AGENTS,
  INTEGRATIONS,
  MOCK_MODE,
  enrichSessionWithAgent,
  getAgent as mockGetAgent,
  getSessions as mockGetSessions,
  type Agent,
  type DaemonRow,
  type MemberSetRow,
  type IntegrationRow,
  type Session
} from '@/lib/data'
import {
  createAgent as apiCreateAgent,
  deleteAgent as apiDeleteAgent,
  updateAgent as apiUpdateAgent,
  moveAgent as apiMoveAgent,
  type AgentPlacementTarget,
  createIntegration as apiCreateIntegration,
  finalizeSlackInstall as apiFinalizeSlackInstall,
  deleteIntegration as apiDeleteIntegration,
  updateIntegrationChannel as apiUpdateIntegrationChannel,
  forgetIntegrationChannel as apiForgetIntegrationChannel,
  leaveIntegrationConversation as apiLeaveIntegrationConversation,
  updateBot as apiUpdateBot,
  fetchIntegrations,
  createHook as apiCreateHook,
  createGithubHook as apiCreateGithubHook,
  createGitlabHook as apiCreateGitlabHook,
  deleteHook as apiDeleteHook,
  fetchBots,
  deleteBot as apiDeleteBot,
  fetchMcpProviders,
  createMcpProvider as apiCreateMcpProvider,
  updateMcpProvider as apiUpdateMcpProvider,
  deleteMcpProvider as apiDeleteMcpProvider,
  updateMcpProviderSharing as apiUpdateMcpProviderSharing,
  type McpProviderDto,
  type McpProviderCreatedDto,
  type CreateMcpProviderInput,
  type UpdateMcpProviderInput,
  fetchSkillSources,
  fetchMemberSets,
  createMemberSet,
  renameMemberSet,
  deleteMemberSet,
  enrollDaemonInMemberSet,
  withdrawDaemonFromMemberSet,
  type MemberSetDto,
  createSkillSource as apiCreateSkillSource,
  updateSkillSource as apiUpdateSkillSource,
  deleteSkillSource as apiDeleteSkillSource,
  updateSkillSourceSharing as apiUpdateSkillSourceSharing,
  type SkillSourceDto,
  type CreateSkillSourceInput,
  type UpdateSkillSourceInput,
  fetchConnectorsConfig,
  createConnectorConnection as apiCreateConnectorConnection,
  reconnectConnectorConnection as apiReconnectConnectorConnection,
  type CreateConnectorConnectionInput,
  type ConnectorConnectionCreatedDto,
  type ReconnectConnectorConnectionInput,
  type ReconnectConnectorConnectionResult,
  provisionDaemon as apiProvisionDaemon,
  renameDaemon as apiRenameDaemon,
  updateDaemonSessionRetention as apiUpdateDaemonSessionRetention,
  type DaemonSessionRetention,
  deleteDaemon as apiDeleteDaemon,
  restartDaemon as apiRestartDaemon,
  upgradeDaemon as apiUpgradeDaemon,
  mintDaemonKey as apiMintDaemonKey,
  upsertCron as apiUpsertCron,
  deleteCron as apiDeleteCron,
  updateAgentSharing as apiUpdateAgentSharing,
  updateAgentCallPolicy as apiUpdateAgentCallPolicy,
  updateDaemonSharing as apiUpdateDaemonSharing,
  updateCronSharing as apiUpdateCronSharing,
  type SharingInput,
  type AgentCallPolicyInput,
  fetchAgents,
  fetchDaemons,
  fetchDaemonCapabilities,
  withDaemonCapability,
  type DaemonCapabilityDto,
  fetchSessionFacets,
  subscribeSessionEvents,
  fetchCrons,
  fetchUsage,
  fetchMembers,
  setMemberDirectory,
  type MemberDto,
  type UsageDto,
  type UsageRange,
  type CreateAgentInput,
  type UpdateAgentInput,
  type CreateIntegrationInput,
  type ChannelTrigger,
  type IntegrationDto,
  type CreatedHookDto,
  type CreateHookInput,
  type CreateGithubHookInput,
  type CreateGitlabHookInput,
  type BotDto,
  type UpsertCronInput,
  type CronDto,
  type DaemonConnectDto,
  type DaemonLifecycleOpDto,
  type MintedKeyDto,
  type SessionFacets
} from '@/lib/api'

interface ConsoleData {
  agents: Agent[]
  daemons: DaemonRow[]
  allSessions: Session[]
  /** Org-level "any session exists" (bare boolean from GET /sessions page 1) — the
   *  getting-started conversation step derives from it so restricted/private-only
   *  orgs don't under-report. Undefined until loaded / on older CPs. */
  orgHasSessions?: boolean
  sessionFacets: SessionFacets
  sessionsNextCursor: string | null
  /** Per-session body-free SSE invalidation counter for open transcript views. */
  sessionActivityVersionById: Record<string, number>
  /** Advances on every SSE (re)connect so views close any disconnect gap. */
  sessionStreamGeneration: number
  /** Re-fetch cached Session reads — used after a mutation that can change
   *  which sessions a caller may see (e.g. a visibility change). */
  revalidateSessionLists: () => Promise<unknown>
  crons: CronDto[]
  integrations: IntegrationRow[]
  /** Durable bot identities (freed + in-use) — Add-integration picker + Settings Bots card. */
  bots: BotDto[]
  /** Org MCP-provider registry (metadata + header names) — the MCP Servers admin view
   *  and the per-agent enable-list candidate set both read this. */
  mcpProviders: McpProviderDto[]
  mcpProvidersLoading: boolean
  /** Register an upstream MCP server, then re-pull; resolves with the created row
   *  INCLUDING the one-time grant key (the caller reveals it exactly once). */
  createMcpProvider: (input: CreateMcpProviderInput) => Promise<McpProviderCreatedDto>
  /** Edit an MCP provider (url / headers / name), then re-pull. */
  updateMcpProvider: (id: string, patch: UpdateMcpProviderInput) => Promise<void>
  /** Delete an MCP provider (cascade-drops its secret + grants), then re-pull. */
  deleteMcpProvider: (id: string) => Promise<void>
  /** Org shared-skills sources registry — the Skills admin view and the per-agent
   *  enable-list candidate set both read this. */
  skillSources: SkillSourceDto[]
  skillSourcesLoading: boolean
  /** Register a skills source, then re-pull. */
  createSkillSource: (input: CreateSkillSourceInput) => Promise<SkillSourceDto>
  /** Edit a skills source (source / ref / subDir / skill filter), then re-pull. */
  updateSkillSource: (id: string, patch: UpdateSkillSourceInput) => Promise<void>
  /** Delete a skills source (409 while any agent enables it), then re-pull. */
  deleteSkillSource: (id: string) => Promise<void>
  /** The org's own member sets — the groups an agent can be placed on (daemon-groups.md §2).
   *  The install-wide pool is org-less and is never one of these. */
  memberSets: MemberSetRow[]
  memberSetsLoading: boolean
  /** Set ids the org owns — what tells one of these groups from the pool on a `set` placement. */
  orgSetIds: ReadonlySet<string>
  createGroup: (name: string) => Promise<MemberSetRow>
  renameGroup: (setId: string, name: string) => Promise<void>
  /** Delete an EMPTY group (409 while it has members or placed agents), then re-pull. */
  deleteGroup: (setId: string) => Promise<void>
  /** Enroll a daemon — agents pinned to it move onto the group with it. 409 when the machine
   *  cannot confirm it stopped them; `force` commits on the operator's assertion that it is. */
  enrollInGroup: (setId: string, daemonId: string) => Promise<void>
  /** Withdraw a daemon (409 while it holds a live duty lease — drain it first). */
  withdrawFromGroup: (setId: string, daemonId: string) => Promise<void>
  /** Whether the open-connector integration is configured on the CP (gates the
   *  "Add connectors" menu item). */
  connectorsEnabled: boolean
  /** Create an open-connector connection (recorded as an open_connector MCP
   *  provider), then re-pull the providers list. Resolves with the created row
   *  (grant key once) + an OAuth popup URL when authType is oauth2. */
  createConnectorConnection: (input: CreateConnectorConnectionInput) => Promise<ConnectorConnectionCreatedDto>
  /** Reconnect an existing open_connector connection (re-run OAuth / re-save credentials).
   *  The provider row is unchanged, so no re-pull; resolves with an OAuth popup URL for oauth2. */
  reconnectConnectorConnection: (
    id: string,
    input: ReconnectConnectorConnectionInput
  ) => Promise<ReconnectConnectorConnectionResult>
  /** Org members; also feeds creatorLabel's userId→name directory for "Created by" rows. Empty until loaded. */
  members: MemberDto[]
  /** Whether the member directory has returned successfully at least once. */
  membersLoaded: boolean
  /** Forget a free bot (record + stored tokens; the CP 409s while installed), then re-pull. */
  deleteBot: (id: string) => Promise<void>
  /** Last-24h usage rollup (GET /usage?range=d1); null until loaded / on failure. */
  usage24h: UsageDto | null
  /** Trustworthy unfiltered access snapshots; null while loading, validating, failed, or absent on an older server. */
  sessionAccessSnapshot: AccessNotificationSnapshot | null
  usageAccessSnapshot: AccessNotificationSnapshot | null
  /** Resolve an agent by id; undefined for an unknown id (live console, no demo fallback). */
  getAgent: (id: string) => Agent | undefined
  getSessions: (id: string) => Session[]
  /** Create an agent, then re-pull; resolves to the new agent's id (for a follow-up
   *  /sharing write when created restricted). */
  createAgent: (input: CreateAgentInput) => Promise<string>
  /** Set a resource's visibility + share set (PUT .../:id/sharing), then re-pull. */
  saveSharing: (kind: 'agents' | 'daemons' | 'crons' | 'mcp' | 'skill', id: string, body: SharingInput) => Promise<void>
  /** Set which peer agents may call this agent as a sub-agent, then re-pull. */
  saveAgentCallPolicy: (agentId: string, body: AgentCallPolicyInput) => Promise<void>
  /** Delete an agent (CP spec + daemon teardown), then re-pull. */
  deleteAgent: (agentId: string) => Promise<void>
  /** Edit an agent's spec (PATCH), then re-pull. */
  updateAgent: (agentId: string, patch: UpdateAgentInput) => Promise<void>
  /** Hard-cut over or explicitly recover an agent, then refresh placement-derived views. */
  moveAgent: (agentId: string, target: AgentPlacementTarget, options?: { force?: boolean }) => Promise<void>
  /** Install a Slack integration (POST /integrations), then re-pull. */
  createIntegration: (input: CreateIntegrationInput) => Promise<void>
  /** Finalize the config-token auto-install (§Tier B), then re-pull. Socket passes the
   *  pasted app-level token; http omits it (the CP reads the signing secret itself). */
  finalizeSlackInstall: (installId: string, opts?: { appToken?: string; shareable?: boolean }) => Promise<void>
  /** Delete an integration (DELETE /integrations/:id), then re-pull. */
  deleteIntegration: (id: string) => Promise<void>
  /** Create a webhook hook; resolves with the created row INCLUDING the one-time
   *  signing-secret echo (the caller reveals it exactly once). */
  createHook: (input: CreateHookInput) => Promise<CreatedHookDto>
  /** Create a GitHub subscription hook (no URL/secret — events ride the relay),
   *  then invalidate its agent's hook cache. */
  createGithubHook: (input: CreateGithubHookInput) => Promise<CreatedHookDto>
  /** Create a GitLab subscription hook against a managed project binding, then
   *  invalidate its agent's hook cache. */
  createGitlabHook: (input: CreateGitlabHookInput) => Promise<CreatedHookDto>
  /** Delete a hook (its ingress URL dies with it), then invalidate its agent's hook cache. */
  deleteHook: (id: string, agentId?: string | null) => Promise<void>
  /** Per-conversation trigger choice (PATCH), applied to the local row on success. */
  setChannelTrigger: (integrationId: string, channelId: string, trigger: ChannelTrigger) => Promise<void>
  /** Per-conversation default agent for a shared bot (PATCH), applied locally. */
  setChannelAgent: (integrationId: string, channelId: string, agentId: string) => Promise<void>
  /** Forget a conversation row without touching the platform. */
  forgetChannel: (integrationId: string, channelId: string) => Promise<void>
  /** Withdraw the bot at the platform; rejects with the platform's own refusal. */
  leaveConversation: (
    integrationId: string,
    target: { kind: 'conversation'; channel: string } | { kind: 'space'; spaceId: string }
  ) => Promise<void>
  /** Flip a bot's shared-bot opt-in (PATCH /bots/:id), then re-pull. */
  setBotShareable: (botId: string, shareable: boolean) => Promise<void>
  /** Create-or-update a cron (PUT upsert; null id ⇒ mint a fresh UUID), then re-pull. */
  saveCron: (id: string | null, body: UpsertCronInput) => Promise<void>
  /** Delete a cron, then re-pull. */
  deleteCron: (id: string) => Promise<void>
  provisionDaemon: () => Promise<DaemonConnectDto>
  renameDaemon: (daemonId: string, name: string) => Promise<void>
  /** Set the daemon's finished-session retention window ("Expire sessions"), then re-pull. */
  setDaemonSessionRetention: (daemonId: string, retention: DaemonSessionRetention) => Promise<void>
  /** Mint a fresh key for an existing (offline) daemon — the reconnect command. */
  reconnectDaemon: (daemonId: string) => Promise<MintedKeyDto>
  /** Remove an offline daemon from the fleet, then re-pull. */
  deleteDaemon: (daemonId: string) => Promise<void>
  /** Command a daemon to drain + relaunch (same version); returns the opened op (track by id). */
  restartDaemon: (daemonId: string) => Promise<DaemonLifecycleOpDto>
  /** Command a daemon to install `version` + relaunch onto it; returns the opened op. */
  upgradeDaemon: (daemonId: string, version: string) => Promise<DaemonLifecycleOpDto>
  refresh: () => void
  /** Revalidate only Session-derived reads — for after an action known to mint
   *  a session, without re-pulling every console read model. */
  refreshSessions: () => void
  /** Revalidate ONLY the daemon fleet and resolve once the fresh list is committed —
   *  for flows that must observe the post-refresh fleet before acting (e.g. the
   *  onboarding mint retry, which reconnects an ambiguously-provisioned row). */
  refreshDaemons: () => Promise<void>
  /** True until the very first pull of ALL read models has settled (any org switch re-arms it). */
  loading: boolean
  /** Per-model first-load flags — each clears when ITS pull settles, so a slow
   *  `/sessions` fan-out never keeps the Daemons/Agents/Schedules spinners up. */
  agentsLoading: boolean
  sessionsLoading: boolean
  sessionsLoadingMore: boolean
  daemonsLoading: boolean
  cronsLoading: boolean
  loadMoreSessions: () => Promise<void>
  error: string | null
}

const Ctx = createContext<ConsoleData | null>(null)
const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 500
const DAEMON_REFRESH_MS = 15_000
/** Capability changes on connect/upgrade/re-probe, all of which already revalidate the
 *  fleet, so this is a backstop rather than the way a change is noticed. */
const DAEMON_CAPABILITY_REFRESH_MS = 300_000
const RESOURCE_REFRESH_MS = 30_000
const EMPTY_SESSION_FACETS: SessionFacets = {
  agentIds: [],
  agentNames: {},
  integrations: [],
  channels: [],
  triggers: []
}
function settleInBackground(...tasks: Promise<unknown>[]): void {
  void Promise.allSettled(tasks)
}

// Map a live integration DTO to the richer UI row, resolving the holding daemon
// via the owning agent. `channels` is the daemon-reported membership snapshot with
// each channel's trigger choice (@-mention vs any message), set per channel.
function integrationRowFromDto(
  d: IntegrationDto,
  agentsById: Map<string, Agent>,
  botsById: Map<string, BotDto>
): IntegrationRow {
  const agent = agentsById.get(d.agentId)
  const bot = botsById.get(d.botId)
  return {
    id: d.id,
    agentId: d.agentId,
    botId: d.botId,
    shareable: bot?.shareable ?? false,
    discordAppId: bot?.discordAppId ?? null,
    ...(d.platform === 'feishu' ? { region: d.region ?? bot?.feishuRegion ?? 'feishu' } : {}),
    name: d.name,
    platform: d.platform,
    kind: 'Custom app',
    workspace: '—',
    daemon: agent?.daemon ?? '—',
    status: d.status === 'active' ? 'online' : 'offline',
    // A shared bot may serve several agents; show the count so the UI reads right.
    agentCount: bot?.shareable ? String(Math.max(bot.agentIds.length, 1)) : '1',
    channels: d.channels.map((c) => ({
      channelId: c.channelId,
      name: c.name || c.channelId,
      ...(c.spaceId ? { spaceId: c.spaceId } : {}),
      ...(c.space ? { space: c.space } : {}),
      kind: c.kind,
      trigger: c.trigger,
      agentId: c.agentId
    }))
  }
}

// Mock sessions flattened across all demo agents (with agent metadata attached),
// computed once — these never change.
const MOCK_SESSIONS: Session[] = AGENTS.flatMap((a) =>
  mockGetSessions(a.id).map((s) => ({
    ...s,
    agentId: a.id,
    agentName: a.name,
    model: a.model,
    runtime: a.runtime,
    daemon: a.daemon
  }))
)

// Demo roster (MOCK_MODE only) — resolves the mock agents' `sharedWith` ids to real
// names so the visibility avatar stacks + the sharing picker render populated.
const MOCK_MEMBERS: MemberDto[] = [
  {
    userId: 'u_dana',
    name: 'Dana Reyes',
    email: 'dana@acme.dev',
    picture: null,
    role: 'owner',
    isCurrentUser: true,
    joinedAt: '2026-01-01T00:00:00Z'
  },
  {
    userId: 'u_sam',
    name: 'Sam Lin',
    email: 'sam@acme.dev',
    picture: null,
    role: 'collaborator',
    isCurrentUser: false,
    joinedAt: '2026-01-02T00:00:00Z'
  },
  {
    userId: 'u_ana',
    name: 'Ana Kim',
    email: 'ana@acme.dev',
    picture: null,
    role: 'viewer',
    isCurrentUser: false,
    joinedAt: '2026-01-03T00:00:00Z'
  },
  {
    userId: 'u_noah',
    name: 'Noah Patel',
    email: 'noah@acme.dev',
    picture: null,
    role: 'collaborator',
    isCurrentUser: false,
    joinedAt: '2026-01-04T00:00:00Z'
  },
  {
    userId: 'u_priya',
    name: 'Priya Shah',
    email: 'priya@acme.dev',
    picture: null,
    role: 'viewer',
    isCurrentUser: false,
    joinedAt: '2026-01-05T00:00:00Z'
  },
  {
    userId: 'u_leo',
    name: 'Leo Martins',
    email: 'leo@acme.dev',
    picture: null,
    role: 'collaborator',
    isCurrentUser: false,
    joinedAt: '2026-01-06T00:00:00Z'
  }
]

// Demo bot roster (MOCK_MODE only) — one per platform so the Settings platform
// cards + the Add-integration reuse picker render populated with no CP running.
// The two Slack rows sit in distinct workspaces so the conditional grouping is
// visible in design/dev mode.
// Discord rows carry a real-shaped application id so the "Add to Discord" invite
// link is exercised. `createdBy` ids resolve to MOCK_MEMBERS names via creatorLabel.
const MOCK_BOTS: BotDto[] = [
  {
    id: 'bot_slack_deploy',
    name: 'deploy-bot',
    platform: 'slack',
    prebuilt: false,
    slackAppId: 'A0DEPLOYBOT',
    workspaceId: 'T0ENGINEERING',
    workspaceName: 'Engineering',
    discordAppId: null,
    createdBy: 'u_dana',
    transport: 'socket',
    shareable: false,
    inUseByAgentId: 'deploy',
    agentIds: ['deploy'],
    lastUsedAt: null,
    freedFromAgent: null,
    createdAt: '2026-02-01T00:00:00Z'
  },
  {
    id: 'bot_slack_free',
    name: 'AgentConnect',
    platform: 'slack',
    prebuilt: true,
    slackAppId: 'A0SUPPORTBT',
    workspaceId: 'T0SUPPORT',
    workspaceName: 'Support',
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: false,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: '2026-06-28T00:00:00Z',
    freedFromAgent: null,
    createdAt: '2026-01-20T00:00:00Z'
  },
  {
    id: 'bot_discord_ops',
    name: 'acme-ops',
    platform: 'discord',
    prebuilt: false,
    slackAppId: null,
    discordAppId: '123456789012345678',
    createdBy: 'u_noah',
    transport: 'socket',
    shareable: false,
    inUseByAgentId: 'oncall',
    agentIds: ['oncall'],
    lastUsedAt: null,
    freedFromAgent: null,
    createdAt: '2026-03-05T00:00:00Z'
  },
  {
    id: 'bot_discord_free',
    name: 'acme-helper',
    platform: 'discord',
    prebuilt: false,
    slackAppId: null,
    discordAppId: '234567890123456789',
    createdBy: 'u_dana',
    transport: 'socket',
    shareable: false,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: '2026-07-02T00:00:00Z',
    freedFromAgent: 'docs',
    createdAt: '2026-03-05T00:00:00Z'
  },
  {
    id: 'bot_feishu_ops',
    name: 'acme-feishu-ops',
    platform: 'feishu',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    feishuAppId: 'cli_mocklarkops',
    feishuRegion: 'lark',
    createdBy: 'u_noah',
    transport: 'socket',
    shareable: false,
    inUseByAgentId: 'oncall',
    agentIds: ['oncall'],
    lastUsedAt: null,
    freedFromAgent: null,
    createdAt: '2026-05-01T00:00:00Z'
  },
  {
    id: 'bot_feishu_free',
    name: 'acme-feishu-bot',
    platform: 'feishu',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    feishuAppId: 'cli_mockfeishufree',
    feishuRegion: 'feishu',
    createdBy: 'u_leo',
    transport: 'socket',
    shareable: false,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: '2026-07-05T00:00:00Z',
    freedFromAgent: 'docs',
    createdAt: '2026-05-01T00:00:00Z'
  },
  {
    id: 'bot_telegram_docs',
    name: 'acme-docs-bot',
    platform: 'telegram',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: 'u_sam',
    transport: 'socket',
    shareable: false,
    inUseByAgentId: 'docs',
    agentIds: ['docs'],
    lastUsedAt: null,
    freedFromAgent: null,
    createdAt: '2026-04-10T00:00:00Z'
  }
]

// Demo schedule roster (MOCK_MODE only) — enough rows that Home's "Scheduled runs"
// card and the Schedules view render populated with no CP running. Mixed enabled /
// paused and a never-run row so both the next-run and the "ran …" labels are exercised.
const MOCK_CRONS: CronDto[] = [
  {
    id: 'cron_deps',
    orgId: 'mock',
    agentId: 'review',
    name: 'daily-deps-check',
    schedule: '0 9 * * *',
    timezone: 'UTC',
    targetPlatform: 'slack',
    targetChannel: '#pull-requests',
    targetIntegrationId: null,
    trigger: 'check the dependency report and flag anything new',
    enabled: true,
    lastRunAt: '2026-04-11T09:00:00Z',
    createdBy: 'u_dana',
    createdAt: '2026-03-01T00:00:00Z',
    lastModifiedBy: 'u_dana',
    lastModifiedAt: '2026-03-01T00:00:00Z',
    visibility: 'org',
    sharedWith: [],
    canEdit: true,
    canManageSharing: true
  },
  {
    id: 'cron_bugsweep',
    orgId: 'mock',
    agentId: 'deploy',
    name: 'nightly bug sweep',
    schedule: '30 2 * * *',
    timezone: 'UTC',
    targetPlatform: 'slack',
    targetChannel: '#deploys',
    targetIntegrationId: null,
    trigger: 'sweep yesterday’s error budget and summarize',
    enabled: true,
    lastRunAt: '2026-04-11T02:30:00Z',
    createdBy: 'u_sam',
    createdAt: '2026-03-04T00:00:00Z',
    lastModifiedBy: 'u_sam',
    lastModifiedAt: '2026-03-04T00:00:00Z',
    visibility: 'org',
    sharedWith: [],
    canEdit: true,
    canManageSharing: true
  },
  {
    id: 'cron_wakeup',
    orgId: 'mock',
    agentId: 'docs',
    name: 'daily wake up dm',
    schedule: '0 8 * * 1-5',
    timezone: 'UTC',
    targetPlatform: 'telegram',
    targetChannel: '@acme_docs',
    targetIntegrationId: null,
    trigger: 'post the docs backlog for the day',
    enabled: true,
    lastRunAt: null,
    createdBy: 'u_lee',
    createdAt: '2026-04-02T00:00:00Z',
    lastModifiedBy: 'u_lee',
    lastModifiedAt: '2026-04-02T00:00:00Z',
    visibility: 'org',
    sharedWith: [],
    canEdit: true,
    canManageSharing: true
  },
  {
    id: 'cron_weekly_digest',
    orgId: 'mock',
    agentId: 'review',
    name: 'weekly digest',
    schedule: '0 16 * * 5',
    timezone: 'UTC',
    targetPlatform: 'slack',
    targetChannel: '#pull-requests',
    targetIntegrationId: null,
    trigger: 'summarize the week’s merged pull requests',
    enabled: false,
    lastRunAt: '2026-04-04T16:00:00Z',
    createdBy: 'u_dana',
    createdAt: '2026-02-14T00:00:00Z',
    lastModifiedBy: 'u_dana',
    lastModifiedAt: '2026-02-14T00:00:00Z',
    visibility: 'org',
    sharedWith: [],
    canEdit: true,
    canManageSharing: true
  }
]

// Demo MCP-provider registry (MOCK_MODE only) — covers both kinds so the Tools &
// Skills tiles show the connector icon path and the plain plug, and both access
// scopes (org-wide vs restricted, which renders the avatar stack). `service` slugs
// are real catalog names so the icons resolve when the CP serves a catalog; with no
// CP they fall back to the plug glyph. No urls/secrets here — headerNames only.
const MOCK_MCP_PROVIDERS: McpProviderDto[] = [
  {
    id: 'mcp_grafana',
    name: 'grafana',
    kind: 'custom',
    transport: 'http',
    visibility: 'org',
    sharedWith: [],
    createdBy: 'u_dana',
    canEdit: true,
    canManageSharing: true,
    url: 'https://mcp.example.test/grafana/sse',
    headerNames: ['Authorization'],
    createdAt: '2026-07-14T00:00:00Z'
  },
  {
    id: 'mcp_linear',
    name: 'linear',
    kind: 'open_connector',
    transport: 'http',
    service: 'linear',
    visibility: 'org',
    sharedWith: [],
    createdBy: 'u_sam',
    canEdit: true,
    canManageSharing: true,
    url: 'https://connectors.example.test/mcp',
    headerNames: ['x-oomol-connector-id'],
    createdAt: '2026-07-16T00:00:00Z'
  },
  {
    id: 'mcp_notion',
    name: 'team-notion',
    kind: 'open_connector',
    transport: 'http',
    service: 'notion',
    visibility: 'restricted',
    sharedWith: ['u_sam', 'u_ana'],
    createdBy: 'u_dana',
    canEdit: true,
    canManageSharing: true,
    url: 'https://connectors.example.test/mcp',
    headerNames: ['x-oomol-connector-id'],
    createdAt: '2026-07-18T00:00:00Z'
  },
  {
    id: 'mcp_deepseek',
    name: 'my-deepseek',
    kind: 'custom',
    transport: 'http',
    visibility: 'restricted',
    sharedWith: ['u_noah'],
    createdBy: 'u_leo',
    canEdit: true,
    canManageSharing: true,
    url: 'https://mcp.example.test/deepseek',
    headerNames: [],
    createdAt: '2026-07-16T00:00:00Z'
  }
]

// Demo skill-source registry (MOCK_MODE only) — one plain GitHub repo, one pinned
// to a ref with a subdir, one non-GitHub git URL (exercises the branch glyph and the
// unlinked source line), one restricted. Names double as the agent enable-list keys.
const MOCK_SKILL_SOURCES: SkillSourceDto[] = [
  {
    id: 'skill_ai_kit',
    name: 'example-ai-kit',
    source: 'example-org/example-ai-kit',
    githubRepoId: null,
    ref: null,
    subDir: null,
    skills: [],
    visibility: 'org',
    sharedWith: [],
    createdBy: 'u_dana',
    canEdit: true,
    canManageSharing: true,
    createdAt: '2026-07-24T00:00:00Z'
  },
  {
    id: 'skill_platform',
    name: 'platform-skills',
    source: 'https://github.com/example-org/example-platform',
    githubRepoId: null,
    ref: 'v1.2.0',
    subDir: 'skills',
    skills: [],
    visibility: 'org',
    sharedWith: [],
    createdBy: 'u_sam',
    canEdit: true,
    canManageSharing: true,
    createdAt: '2026-06-30T00:00:00Z'
  },
  {
    id: 'skill_internal',
    name: 'internal-runbooks',
    source: 'git@git.example.test:ops/runbooks.git',
    githubRepoId: null,
    ref: 'main',
    subDir: null,
    skills: ['safe-deploy', 'rollback'],
    visibility: 'restricted',
    sharedWith: ['u_noah', 'u_priya'],
    createdBy: 'u_leo',
    canEdit: true,
    canManageSharing: true,
    createdAt: '2026-05-11T00:00:00Z'
  }
]

export function ConsoleDataProvider({ children }: { children: ReactNode }) {
  const { activeOrg, orgs, loading: orgLoading, error: orgError } = useOrgs()
  const { mutate: mutateCache } = useSWRConfig()
  const [mockCallPolicy, setMockCallPolicy] = useState<Record<string, AgentCallPolicyInput>>({})
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionRefreshGenerationRef = useRef(0)
  const sessionRefreshInFlightRef = useRef(false)
  const sessionRefreshDirtyRef = useRef(false)
  const [sessionActivityVersionById, setSessionActivityVersionById] = useState<Record<string, number>>({})
  const [sessionStreamGeneration, setSessionStreamGeneration] = useState(0)

  // Every cache key carries the org id. Unlike `keepPreviousData`, separate keys
  // never paint one org's stale rows under another org while the new pull starts.
  // Org-list failures are surfaced directly by OrgProvider; never turn a pseudo
  // org id into a cache tenant or an HTTP path.
  const waitingForOrg = orgLoading || (!activeOrg && orgs.length > 0)
  const orgKey = waitingForOrg ? null : (activeOrg?.id ?? null)

  const {
    data: realAgents = [],
    error: agentsError,
    isLoading: agentsIsLoading,
    mutate: mutateAgents
  } = useSWR<Agent[]>(consoleKeys.agents(orgKey), ([, orgId]) => fetchAgents(orgId as string), {
    refreshInterval: RESOURCE_REFRESH_MS
  })
  const {
    data: realDaemons = [],
    error: daemonsError,
    isLoading: daemonsIsLoading,
    mutate: mutateDaemonLiveness
  } = useSWR<DaemonRow[]>(consoleKeys.daemons(orgKey), ([, orgId]) => fetchDaemons(orgId as string), {
    refreshInterval: DAEMON_REFRESH_MS
  })
  // Capability moves only when a daemon connects, upgrades, or re-probes, so it is read
  // apart from the liveness poll and stitched back on below. Its own revalidation is slow;
  // the events that actually change it already refresh the fleet through `mutateDaemons`.
  const {
    data: daemonCapabilities,
    isLoading: capabilitiesIsLoading,
    mutate: mutateDaemonCapabilities
  } = useSWR<Map<string, DaemonCapabilityDto>>(
    consoleKeys.daemonCapabilities(orgKey),
    ([, orgId]) => fetchDaemonCapabilities(orgId as string),
    { refreshInterval: DAEMON_CAPABILITY_REFRESH_MS }
  )
  // The two halves are one row to every caller, and the events that refresh daemons —
  // connect, upgrade, re-probe, onboarding polling — change BOTH. Revalidating only the
  // liveness key would show a freshly connected daemon as running nothing until the slow
  // capability backstop, so every existing `mutateDaemons()` refreshes the pair.
  const mutateDaemons = useCallback(
    () => Promise.all([mutateDaemonLiveness(), mutateDaemonCapabilities()]).then(() => undefined),
    [mutateDaemonLiveness, mutateDaemonCapabilities]
  )
  const {
    data: realCrons = [],
    error: cronsError,
    isLoading: cronsIsLoading,
    mutate: mutateCrons
  } = useSWR<CronDto[]>(consoleKeys.crons(orgKey), ([, orgId]) => fetchCrons(orgId as string), {
    refreshInterval: RESOURCE_REFRESH_MS
  })
  const {
    data: realIntegrations = [],
    error: integrationsError,
    isLoading: integrationsIsLoading,
    mutate: mutateIntegrations
  } = useSWR<IntegrationDto[]>(consoleKeys.integrations(orgKey), ([, orgId]) => fetchIntegrations(orgId as string), {
    refreshInterval: RESOURCE_REFRESH_MS
  })
  const {
    data: realBots = [],
    isLoading: botsIsLoading,
    mutate: mutateBots
  } = useSWR<BotDto[]>(consoleKeys.bots(orgKey), ([, orgId]) => fetchBots(orgId as string))
  const {
    data: realMcpProviders = [],
    isLoading: mcpProvidersIsLoading,
    mutate: mutateMcpProviders
  } = useSWR<McpProviderDto[]>(consoleKeys.mcpProviders(orgKey), ([, orgId]) => fetchMcpProviders(orgId as string))
  const {
    data: realSkillSources = [],
    isLoading: skillSourcesIsLoading,
    mutate: mutateSkillSources
  } = useSWR<SkillSourceDto[]>(consoleKeys.skillSources(orgKey), ([, orgId]) => fetchSkillSources(orgId as string))
  // The org's member sets (daemon-groups.md §2) — the groups an agent can be placed on. The
  // install-wide pool is org-less and never appears here; the console renders it from the fleet.
  const {
    data: memberSets = [],
    isLoading: memberSetsIsLoading,
    mutate: mutateMemberSets
  } = useSWR<MemberSetDto[]>(consoleKeys.memberSets(orgKey), ([, orgId]) => fetchMemberSets(orgId as string))
  // Cheap feature gate for the connectors integration; mock mode reports it on so
  // the demo console shows the "Add connectors" flow.
  const { data: connectorsConfig } = useSWR<{ enabled: boolean }>(
    consoleKeys.connectorsConfig(orgKey),
    MOCK_MODE ? () => Promise.resolve({ enabled: true }) : ([, orgId]) => fetchConnectorsConfig(orgId as string)
  )
  const {
    data: fetchedMembers,
    isLoading: membersIsLoading,
    mutate: mutateMembers
  } = useSWR<MemberDto[]>(MOCK_MODE ? null : consoleKeys.members(orgKey), ([, orgId]) => fetchMembers(orgId as string))
  const {
    data: usage24hData,
    error: usage24hError,
    isLoading: usage24hIsLoading,
    isValidating: usage24hIsValidating,
    mutate: mutateUsage24h
  } = useSWR<UsageDto>(consoleKeys.usage(orgKey, 'd1'), ([, orgId, , range]) =>
    fetchUsage(range as UsageRange, orgId as string)
  )

  const {
    sessions: realSessions,
    orgHasSessions,
    nextCursor: sessionsNextCursor,
    loadingMore: sessionsLoadingMore,
    loadMore: loadMoreSessions,
    error: sessionsError,
    isLoading: sessionsIsLoading,
    accessSnapshot: sessionAccessSnapshot
  } = useSessionList(orgKey)
  const {
    data: sessionFacets = EMPTY_SESSION_FACETS,
    error: sessionFacetsError,
    isLoading: sessionFacetsIsLoading
  } = useSWR<SessionFacets>(consoleKeys.sessionFacets(orgKey, '', '', '', '', '', ''), ([, orgId]) =>
    fetchSessionFacets(orgId as string)
  )

  const revalidateSessionLists = useCallback(() => {
    if (!orgKey) return Promise.resolve([])
    return mutateCache(
      (key) =>
        Array.isArray(key) &&
        ((key[0] === 'console' &&
          key[1] === orgKey &&
          (key[2] === 'sessions' || key[2] === 'session-facets' || key[2] === 'session-detail')) ||
          (key[0] === 'conversation-by-key' && key[1] === orgKey))
    )
  }, [mutateCache, orgKey])

  const revalidateConsole = useCallback(
    () =>
      Promise.allSettled([
        mutateAgents(),
        mutateDaemons(),
        revalidateSessionLists(),
        mutateCrons(),
        mutateIntegrations(),
        mutateBots(),
        mutateMcpProviders(),
        mutateMembers(),
        mutateUsage24h()
      ]),
    [
      mutateAgents,
      mutateDaemons,
      revalidateSessionLists,
      mutateCrons,
      mutateIntegrations,
      mutateBots,
      mutateMcpProviders,
      mutateMembers,
      mutateUsage24h
    ]
  )
  const refresh = useCallback(() => {
    void revalidateConsole()
  }, [revalidateConsole])
  const refreshSessions = useCallback(() => {
    void revalidateSessionLists()
  }, [revalidateSessionLists])
  const refreshDaemons = useCallback(() => mutateDaemons().then(() => undefined), [mutateDaemons])

  const drainSessionRefreshes = useCallback(
    async (generation: number) => {
      if (sessionRefreshGenerationRef.current !== generation) return
      if (sessionRefreshInFlightRef.current) {
        sessionRefreshDirtyRef.current = true
        return
      }

      sessionRefreshInFlightRef.current = true
      try {
        do {
          sessionRefreshDirtyRef.current = false
          try {
            await revalidateSessionLists()
          } catch {
            // SWR retains the last good pages and exposes the revalidation error.
          }
        } while (sessionRefreshDirtyRef.current && sessionRefreshGenerationRef.current === generation)
      } finally {
        if (sessionRefreshGenerationRef.current === generation) sessionRefreshInFlightRef.current = false
      }
    },
    [revalidateSessionLists]
  )

  useEffect(() => {
    const generation = ++sessionRefreshGenerationRef.current
    sessionRefreshInFlightRef.current = false
    sessionRefreshDirtyRef.current = false
    setSessionActivityVersionById({})
    if (orgLoading || !activeOrg) return

    const scheduleSessionRefresh = () => {
      if (sessionRefreshGenerationRef.current !== generation || sessionRefreshTimerRef.current) return
      sessionRefreshTimerRef.current = setTimeout(() => {
        sessionRefreshTimerRef.current = null
        void drainSessionRefreshes(generation)
      }, SESSION_EVENT_REFRESH_DEBOUNCE_MS)
    }
    const unsubscribe = subscribeSessionEvents(activeOrg.id, {
      onConnect: () => {
        scheduleSessionRefresh()
        setSessionStreamGeneration((current) => current + 1)
      },
      onSession: scheduleSessionRefresh,
      onActivity: ({ sessionId }) =>
        setSessionActivityVersionById((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? 0) + 1
        }))
    })
    return () => {
      sessionRefreshGenerationRef.current++
      sessionRefreshDirtyRef.current = false
      unsubscribe()
      if (sessionRefreshTimerRef.current) {
        clearTimeout(sessionRefreshTimerRef.current)
        sessionRefreshTimerRef.current = null
      }
    }
  }, [orgLoading, activeOrg?.id, drainSessionRefreshes])

  const members = MOCK_MODE ? MOCK_MEMBERS : (fetchedMembers ?? [])
  const membersLoaded = MOCK_MODE || fetchedMembers !== undefined
  const usage24h = usage24hData ?? null
  const usageAccessSnapshot = useMemo(
    () =>
      accessNotificationSnapshot(usage24hData, {
        authoritative: true,
        isLoading: usage24hIsLoading,
        isValidating: usage24hIsValidating,
        error: usage24hError
      }),
    [usage24hData, usage24hError, usage24hIsLoading, usage24hIsValidating]
  )
  useEffect(() => {
    setMemberDirectory(members)
  }, [members])

  // agents: live rows, plus the demo rows in mock mode. daemons: live fleet only.
  const agents = useMemo(() => {
    if (!MOCK_MODE) return realAgents
    const demo = AGENTS.map((a) => {
      const override = mockCallPolicy[a.id]
      return override ? { ...a, ...override } : a
    })
    return [...realAgents, ...demo]
  }, [realAgents, mockCallPolicy])
  // One `DaemonRow` again: views never learn the read was split. `modelCatalog` is absent
  // here by design — `useDaemonDetail` fetches the one daemon that needs it.
  const daemons = useMemo(
    () => realDaemons.map((d) => withDaemonCapability(d, daemonCapabilities?.get(d.daemonId))),
    [realDaemons, daemonCapabilities]
  )

  // Resolve an agent by id. Falls back to a demo agent only in mock mode; a live
  // console returns undefined for an unknown id (e.g. a stale deep link).
  const getAgent = useCallback(
    (id: string) => agents.find((a) => a.id === id) ?? (MOCK_MODE ? mockGetAgent(id) : undefined),
    [agents]
  )

  const allSessions = useMemo(() => {
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
    const enriched = realSessions.map((session) =>
      enrichSessionWithAgent(session, session.agentId ? agentsById.get(session.agentId) : undefined)
    )
    return MOCK_MODE ? [...enriched, ...MOCK_SESSIONS] : enriched
  }, [realSessions, agents])

  const getSessions = useCallback((id: string) => allSessions.filter((s) => s.agentId === id), [allSessions])

  // crons: live rows, plus the demo roster in mock mode — so Home's "Scheduled runs"
  // card and the Schedules view are populated with no CP running.
  const crons = useMemo(() => (MOCK_MODE ? [...realCrons, ...MOCK_CRONS] : realCrons), [realCrons])

  // bots: live rows, plus the demo roster in mock mode — so the Settings platform
  // cards + the Add-integration reuse picker are populated with no CP running.
  const bots = useMemo(() => (MOCK_MODE ? [...realBots, ...MOCK_BOTS] : realBots), [realBots])

  // mcp providers / skill sources: live rows, plus the demo registries in mock mode —
  // so the Tools & Skills tiles (and the per-agent enable-lists that read the same
  // candidate set) render populated with no CP running.
  const mcpProviders = useMemo(
    () => (MOCK_MODE ? [...realMcpProviders, ...MOCK_MCP_PROVIDERS] : realMcpProviders),
    [realMcpProviders]
  )
  const skillSources = useMemo(
    () => (MOCK_MODE ? [...realSkillSources, ...MOCK_SKILL_SOURCES] : realSkillSources),
    [realSkillSources]
  )
  // The DTO IS the row here: a group has no derived state of its own, so projecting it would only
  // create a second shape to keep in step with the first.
  const groups = useMemo<MemberSetRow[]>(() => memberSets.map((s) => ({ ...s })), [memberSets])
  const orgSetIds = useMemo(() => new Set(groups.map((g) => g.setId)), [groups])

  // integrations: live rows (daemon resolved via the owning agent), plus the demo
  // rows in mock mode — so the view is populated even with no CP running (as with agents).
  const integrations = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]))
    const botsById = new Map(bots.map((b) => [b.id, b]))
    const live = realIntegrations.map((d) => integrationRowFromDto(d, byId, botsById))
    return MOCK_MODE ? [...live, ...INTEGRATIONS] : live
  }, [realIntegrations, agents, bots])

  const createAgent = useCallback(
    async (input: CreateAgentInput): Promise<string> => {
      const created = await apiCreateAgent(input)
      // `memberSets` too: a group's `agentCount` is what the console shows beside Cloud's and
      // what gates its delete, so every write that can move an agent onto or off a group has to
      // re-pull it — otherwise the count is stale and the delete stays blocked on a number.
      settleInBackground(mutateAgents(), mutateDaemons(), mutateMemberSets())
      return created.id // let the caller follow up with a /sharing write if restricted
    },
    [mutateAgents, mutateDaemons, mutateMemberSets]
  )

  // Set a resource's visibility + share set (PUT .../:id/sharing), then re-pull.
  // Separate from the content write so the sharing gate (canManageSharing) is
  // exercised on its own endpoint.
  const saveSharing = useCallback(
    async (kind: 'agents' | 'daemons' | 'crons' | 'mcp' | 'skill', id: string, body: SharingInput) => {
      if (kind === 'agents') await apiUpdateAgentSharing(id, body)
      else if (kind === 'daemons') await apiUpdateDaemonSharing(id, body)
      else if (kind === 'mcp') await apiUpdateMcpProviderSharing(id, body)
      else if (kind === 'skill') await apiUpdateSkillSourceSharing(id, body)
      else await apiUpdateCronSharing(id, body)
      if (kind === 'agents') settleInBackground(mutateAgents())
      else if (kind === 'daemons') settleInBackground(mutateDaemons())
      else if (kind === 'mcp') settleInBackground(mutateMcpProviders())
      else if (kind === 'skill') settleInBackground(mutateSkillSources())
      else settleInBackground(mutateCrons())
    },
    [mutateAgents, mutateDaemons, mutateCrons, mutateMcpProviders, mutateSkillSources]
  )

  const saveAgentCallPolicy = useCallback(
    async (agentId: string, body: AgentCallPolicyInput) => {
      if (MOCK_MODE && AGENTS.some((a) => a.id === agentId)) {
        setMockCallPolicy((cur) => ({ ...cur, [agentId]: body }))
        return
      }
      await apiUpdateAgentCallPolicy(agentId, body)
      refresh()
    },
    [refresh]
  )

  // Delete an agent (CP spec + daemon teardown), then re-pull so it drops from the list.
  const deleteAgent = useCallback(
    async (agentId: string) => {
      await apiDeleteAgent(agentId)
      settleInBackground(mutateAgents(), revalidateSessionLists(), mutateIntegrations(), mutateMemberSets())
    },
    [mutateAgents, revalidateSessionLists, mutateIntegrations, mutateMemberSets]
  )

  // Edit an agent's spec (PATCH), then re-pull so the change shows.
  const updateAgent = useCallback(
    async (agentId: string, patch: UpdateAgentInput) => {
      await apiUpdateAgent(agentId, patch)
      settleInBackground(mutateAgents())
    },
    [mutateAgents]
  )

  // A placement move changes the agent row, both daemons' hosted-agent counts,
  // and where live session bodies resolve. Refresh all three projections.
  const moveAgent = useCallback(
    async (agentId: string, target: AgentPlacementTarget, options?: { force?: boolean }) => {
      await apiMoveAgent(agentId, target, options)
      settleInBackground(mutateAgents(), mutateDaemons(), revalidateSessionLists(), mutateMemberSets())
    },
    [mutateAgents, mutateDaemons, revalidateSessionLists, mutateMemberSets]
  )

  // Install a platform integration (Slack / Telegram / Discord), then re-pull so it shows in the list.
  const createIntegration = useCallback(
    async (input: CreateIntegrationInput) => {
      await apiCreateIntegration(input)
      settleInBackground(mutateIntegrations(), mutateBots())
    },
    [mutateIntegrations, mutateBots]
  )

  // Finalize the config-token auto-install with the pasted app-level token (§Tier B),
  // then re-pull so the new integration shows in the list.
  const finalizeSlackInstall = useCallback(
    async (installId: string, opts?: { appToken?: string; shareable?: boolean }) => {
      await apiFinalizeSlackInstall(installId, opts)
      settleInBackground(mutateIntegrations(), mutateBots())
    },
    [mutateIntegrations, mutateBots]
  )

  // Delete an integration (CP row + secret + tell the owning daemon to drop it), then re-pull.
  const deleteIntegration = useCallback(
    async (id: string) => {
      await apiDeleteIntegration(id)
      settleInBackground(mutateIntegrations(), mutateBots())
    },
    [mutateIntegrations, mutateBots]
  )

  // Hook resources are agent-scoped. Invalidate their exact SWR key instead of
  // maintaining a parallel revision counter outside the server-state cache.
  const createHook = useCallback(
    async (input: CreateHookInput): Promise<CreatedHookDto> => {
      const created = await apiCreateHook(input)
      const hooksKey = consoleKeys.agentHooks(orgKey, input.agentId)
      if (hooksKey) settleInBackground(mutateCache(hooksKey))
      return created
    },
    [mutateCache, orgKey]
  )

  // GitHub subscription — same cache discipline; the CP validates the repo
  // against the org's App installations and resolves the numeric match key
  // server-side.
  const createGithubHook = useCallback(
    async (input: CreateGithubHookInput): Promise<CreatedHookDto> => {
      const created = await apiCreateGithubHook(input)
      const hooksKey = consoleKeys.agentHooks(orgKey, input.agentId)
      if (hooksKey) settleInBackground(mutateCache(hooksKey))
      return created
    },
    [mutateCache, orgKey]
  )

  // GitLab subscription — the CP validates the numeric project id against the
  // organization's own managed binding before it writes anything.
  const createGitlabHook = useCallback(
    async (input: CreateGitlabHookInput): Promise<CreatedHookDto> => {
      const created = await apiCreateGitlabHook(input)
      const hooksKey = consoleKeys.agentHooks(orgKey, input.agentId)
      if (hooksKey) settleInBackground(mutateCache(hooksKey))
      return created
    },
    [mutateCache, orgKey]
  )

  const deleteHook = useCallback(
    async (id: string, agentId?: string | null) => {
      await apiDeleteHook(id)
      const hooksKey = consoleKeys.agentHooks(orgKey, agentId)
      if (hooksKey) settleInBackground(mutateCache(hooksKey))
    },
    [mutateCache, orgKey]
  )

  // Forget a free bot (CP record + stored tokens), then re-pull the roster.
  const deleteBot = useCallback(
    async (id: string) => {
      await apiDeleteBot(id)
      settleInBackground(mutateBots())
    },
    [mutateBots]
  )

  // Register an upstream MCP server; the response carries the one-time grant key,
  // returned to the caller for its single reveal. Re-pull so the new row shows.
  const createMcpProvider = useCallback(
    async (input: CreateMcpProviderInput): Promise<McpProviderCreatedDto> => {
      const created = await apiCreateMcpProvider(input)
      settleInBackground(mutateMcpProviders())
      return created
    },
    [mutateMcpProviders]
  )

  const updateMcpProvider = useCallback(
    async (id: string, patch: UpdateMcpProviderInput) => {
      await apiUpdateMcpProvider(id, patch)
      settleInBackground(mutateMcpProviders())
    },
    [mutateMcpProviders]
  )

  // Create an open-connector connection; the CP records it as an open_connector MCP
  // provider, so re-pull the providers list to surface the new row.
  const createConnectorConnection = useCallback(
    async (input: CreateConnectorConnectionInput): Promise<ConnectorConnectionCreatedDto> => {
      const created = await apiCreateConnectorConnection(input)
      settleInBackground(mutateMcpProviders())
      return created
    },
    [mutateMcpProviders]
  )

  // Reconnect only refreshes the upstream credential/authorization; the open_connector
  // provider row is unchanged, so there's nothing to re-pull.
  const reconnectConnectorConnection = useCallback(
    (id: string, input: ReconnectConnectorConnectionInput): Promise<ReconnectConnectorConnectionResult> =>
      apiReconnectConnectorConnection(id, input),
    []
  )

  const deleteMcpProvider = useCallback(
    async (id: string) => {
      await apiDeleteMcpProvider(id)
      settleInBackground(mutateMcpProviders())
    },
    [mutateMcpProviders]
  )

  // Membership and placement move runtime authority, so a group write re-pulls the AGENTS and the
  // DAEMONS too, not just the group list: enrolling a daemon changes whether it is a placement
  // target, and both surfaces read that.
  const settleGroupWrite = useCallback(() => {
    settleInBackground(mutateMemberSets())
    settleInBackground(mutateDaemons())
    settleInBackground(mutateAgents())
  }, [mutateMemberSets, mutateDaemons, mutateAgents])

  const createGroup = useCallback(
    async (name: string): Promise<MemberSetRow> => {
      const created = await createMemberSet(name)
      settleGroupWrite()
      return created
    },
    [settleGroupWrite]
  )

  const renameGroup = useCallback(
    async (setId: string, name: string) => {
      await renameMemberSet(setId, name)
      settleGroupWrite()
    },
    [settleGroupWrite]
  )

  const deleteGroup = useCallback(
    async (setId: string) => {
      await deleteMemberSet(setId)
      settleGroupWrite()
    },
    [settleGroupWrite]
  )

  const enrollInGroup = useCallback(
    async (setId: string, daemonId: string) => {
      await enrollDaemonInMemberSet(setId, daemonId)
      settleGroupWrite()
    },
    [settleGroupWrite]
  )

  const withdrawFromGroup = useCallback(
    async (setId: string, daemonId: string) => {
      await withdrawDaemonFromMemberSet(setId, daemonId)
      settleGroupWrite()
    },
    [settleGroupWrite]
  )

  const createSkillSource = useCallback(
    async (input: CreateSkillSourceInput): Promise<SkillSourceDto> => {
      const created = await apiCreateSkillSource(input)
      settleInBackground(mutateSkillSources())
      return created
    },
    [mutateSkillSources]
  )

  const updateSkillSource = useCallback(
    async (id: string, patch: UpdateSkillSourceInput) => {
      await apiUpdateSkillSource(id, patch)
      settleInBackground(mutateSkillSources())
    },
    [mutateSkillSources]
  )

  const deleteSkillSource = useCallback(
    async (id: string) => {
      await apiDeleteSkillSource(id)
      settleInBackground(mutateSkillSources())
    },
    [mutateSkillSources]
  )

  // Flip one conversation's trigger. Shared bots project it bot-wide. Avoid a full
  // re-pull so the toggle does not flash.
  const setChannelTrigger = useCallback(
    async (integrationId: string, channelId: string, trigger: ChannelTrigger) => {
      await apiUpdateIntegrationChannel(integrationId, channelId, { trigger })
      settleInBackground(
        mutateIntegrations(
          (rows) => {
            const source = rows?.find((row) => row.id === integrationId)
            if (!rows || !source) return rows
            const botWide = realBots.some((bot) => bot.id === source.botId && bot.shareable)
            return rows.map((row) =>
              (botWide ? row.botId === source.botId : row.id === integrationId)
                ? {
                    ...row,
                    channels: row.channels.map((channel) =>
                      channel.channelId === channelId ? { ...channel, trigger } : channel
                    )
                  }
                : row
            )
          },
          { revalidate: false }
        )
      )
    },
    [mutateIntegrations, realBots]
  )

  /**
   * Drop a conversation from the cache. Both channel actions end the same way — the
   * row is gone — so they share one projection, applied bot-wide for a channel of a
   * shared bot because the server forgets it on every install.
   */
  const dropChannelsFromCache = useCallback(
    (integrationId: string, channelIds: readonly string[]) => {
      const gone = new Set(channelIds)
      settleInBackground(
        mutateIntegrations(
          (rows) => {
            const source = rows?.find((row) => row.id === integrationId)
            if (!rows || !source) return rows
            const botWide = realBots.some((bot) => bot.id === source.botId && bot.shareable)
            return rows.map((row) =>
              (botWide ? row.botId === source.botId : row.id === integrationId)
                ? { ...row, channels: row.channels.filter((channel) => !gone.has(channel.channelId)) }
                : row
            )
          },
          { revalidate: false }
        )
      )
    },
    [mutateIntegrations, realBots]
  )

  const forgetChannel = useCallback(
    async (integrationId: string, channelId: string) => {
      await apiForgetIntegrationChannel(integrationId, channelId)
      dropChannelsFromCache(integrationId, [channelId])
    },
    [dropChannelsFromCache]
  )

  /** Leave at the platform. Rejects with the platform's own refusal for the caller to
   *  show; on success every affected row goes — a whole Discord server takes its
   *  channels with it. */
  const leaveConversation = useCallback(
    async (
      integrationId: string,
      target: { kind: 'conversation'; channel: string } | { kind: 'space'; spaceId: string }
    ) => {
      await apiLeaveIntegrationConversation(integrationId, target)
      const rows = integrations.find((row) => row.id === integrationId)?.channels ?? []
      const gone =
        target.kind === 'space'
          ? rows.filter((channel) => channel.spaceId === target.spaceId).map((channel) => channel.channelId)
          : [target.channel]
      dropChannelsFromCache(integrationId, gone)
    },
    [dropChannelsFromCache, integrations]
  )

  // Set a shared conversation's sole owner. The API projects the effective bot-level
  // state onto every integration copy, so keep those cached copies in sync.
  const setChannelAgent = useCallback(
    async (integrationId: string, channelId: string, agentId: string) => {
      const updated = await apiUpdateIntegrationChannel(integrationId, channelId, { agentId })
      settleInBackground(
        mutateIntegrations(
          (rows) => {
            const source = rows?.find((row) => row.id === integrationId)
            if (!rows || !source) return rows
            return rows.map((row) =>
              row.botId === source.botId
                ? {
                    ...row,
                    channels: row.channels.map((channel) =>
                      channel.channelId === channelId
                        ? {
                            ...channel,
                            agentId,
                            trigger: updated.trigger
                          }
                        : channel
                    )
                  }
                : row
            )
          },
          { revalidate: false }
        )
      )
    },
    [mutateIntegrations]
  )

  // Flip a bot's shared-bot opt-in, then re-pull (it changes install semantics +
  // relay placement across every view that shows the bot / its integrations).
  const setBotShareable = useCallback(
    async (botId: string, shareable: boolean) => {
      await apiUpdateBot(botId, shareable)
      settleInBackground(mutateBots(), mutateIntegrations())
    },
    [mutateBots, mutateIntegrations]
  )

  // Create-or-update a cron. PUT /crons/:id is an idempotent upsert, so a create
  // just mints a fresh client-side UUID (the CP keys the row on it).
  const saveCron = useCallback(
    async (id: string | null, body: UpsertCronInput) => {
      await apiUpsertCron(id ?? randomUuid(), body)
      settleInBackground(mutateCrons())
    },
    [mutateCrons]
  )

  const deleteCron = useCallback(
    async (id: string) => {
      await apiDeleteCron(id)
      settleInBackground(mutateCrons())
    },
    [mutateCrons]
  )

  // One-shot: mint a connect token + start command. The daemon row shows up via
  // `refresh()` once the started process authenticates, so this doesn't refresh.
  const provisionDaemon = useCallback(() => apiProvisionDaemon(), [])

  // Assign a display name to a connected daemon, then re-pull the fleet.
  const renameDaemon = useCallback(
    async (daemonId: string, name: string) => {
      await apiRenameDaemon(daemonId, name)
      settleInBackground(mutateDaemons())
    },
    [mutateDaemons]
  )

  // Set the finished-session retention window ("Expire sessions"), then re-pull.
  const setDaemonSessionRetention = useCallback(
    async (daemonId: string, retention: DaemonSessionRetention) => {
      await apiUpdateDaemonSessionRetention(daemonId, retention)
      settleInBackground(mutateDaemons())
    },
    [mutateDaemons]
  )

  // Reconnect: mint a new key + start command for an existing daemon. Like
  // provision, the row flips back to `online` via `refresh()` once it re-auths, so
  // the caller polls rather than this refreshing eagerly.
  const reconnectDaemon = useCallback((daemonId: string) => apiMintDaemonKey(daemonId), [])

  // Delete an offline daemon, then re-pull the fleet so it drops from the grid.
  const deleteDaemon = useCallback(
    async (daemonId: string) => {
      await apiDeleteDaemon(daemonId)
      settleInBackground(mutateDaemons(), mutateAgents())
    },
    [mutateDaemons, mutateAgents]
  )

  // Command a restart / upgrade, then re-pull the fleet so the in-progress (pendingOp)
  // badge appears. The command only means the daemon ACCEPTED it; completion (the
  // daemon relaunching + re-registering) shows up as pendingOp clearing on a later
  // poll, so the caller polls rather than this resolving on completion.
  const restartDaemon = useCallback(
    async (daemonId: string) => {
      const op = await apiRestartDaemon(daemonId)
      settleInBackground(mutateDaemons())
      return op
    },
    [mutateDaemons]
  )
  const upgradeDaemon = useCallback(
    async (daemonId: string, version: string) => {
      const op = await apiUpgradeDaemon(daemonId, version)
      settleInBackground(mutateDaemons())
      return op
    },
    [mutateDaemons]
  )

  const coreError =
    orgError ?? agentsError ?? sessionsError ?? sessionFacetsError ?? daemonsError ?? cronsError ?? integrationsError
  const error = coreError ? (coreError instanceof Error ? coreError.message : String(coreError)) : null
  const agentsLoading = waitingForOrg || agentsIsLoading
  const sessionsLoading = waitingForOrg || sessionsIsLoading || sessionFacetsIsLoading
  // Capability is part of a complete daemon row here, so a view that gates on this never
  // renders a fleet row as "runs nothing" in the window before that read lands.
  const daemonsLoading = waitingForOrg || daemonsIsLoading || capabilitiesIsLoading
  const cronsLoading = waitingForOrg || cronsIsLoading
  // Mock mode never waits: the demo registries are always there, so the tiles render
  // immediately instead of sitting on a spinner while a CP that isn't running fails.
  const mcpProvidersLoading = !MOCK_MODE && (waitingForOrg || mcpProvidersIsLoading)
  const skillSourcesLoading = !MOCK_MODE && (waitingForOrg || skillSourcesIsLoading)
  const memberSetsLoading = !MOCK_MODE && (waitingForOrg || memberSetsIsLoading)
  const connectorsEnabled = connectorsConfig?.enabled ?? false
  const loading =
    waitingForOrg ||
    agentsIsLoading ||
    sessionsIsLoading ||
    sessionFacetsIsLoading ||
    daemonsIsLoading ||
    capabilitiesIsLoading ||
    cronsIsLoading ||
    integrationsIsLoading ||
    botsIsLoading ||
    membersIsLoading ||
    usage24hIsLoading

  const value = useMemo<ConsoleData>(
    () => ({
      agents,
      daemons,
      allSessions,
      orgHasSessions,
      sessionFacets,
      sessionsNextCursor,
      sessionActivityVersionById,
      sessionStreamGeneration,
      revalidateSessionLists,
      crons,
      integrations,
      bots,
      mcpProviders,
      mcpProvidersLoading,
      createMcpProvider,
      updateMcpProvider,
      deleteMcpProvider,
      skillSources,
      skillSourcesLoading,
      createSkillSource,
      updateSkillSource,
      deleteSkillSource,
      memberSets: groups,
      memberSetsLoading,
      orgSetIds,
      createGroup,
      renameGroup,
      deleteGroup,
      enrollInGroup,
      withdrawFromGroup,
      connectorsEnabled,
      createConnectorConnection,
      reconnectConnectorConnection,
      members,
      membersLoaded,
      usage24h,
      sessionAccessSnapshot,
      usageAccessSnapshot,
      getAgent,
      getSessions,
      createAgent,
      saveSharing,
      saveAgentCallPolicy,
      deleteAgent,
      updateAgent,
      moveAgent,
      createIntegration,
      finalizeSlackInstall,
      deleteIntegration,
      createHook,
      createGithubHook,
      createGitlabHook,
      deleteHook,
      deleteBot,
      setChannelTrigger,
      forgetChannel,
      leaveConversation,
      setChannelAgent,
      setBotShareable,
      saveCron,
      deleteCron,
      provisionDaemon,
      renameDaemon,
      setDaemonSessionRetention,
      reconnectDaemon,
      deleteDaemon,
      restartDaemon,
      upgradeDaemon,
      refresh,
      refreshSessions,
      refreshDaemons,
      loading,
      agentsLoading,
      sessionsLoading,
      daemonsLoading,
      cronsLoading,
      sessionsLoadingMore,
      loadMoreSessions,
      error
    }),
    [
      agents,
      daemons,
      allSessions,
      orgHasSessions,
      sessionFacets,
      sessionsNextCursor,
      sessionActivityVersionById,
      sessionStreamGeneration,
      revalidateSessionLists,
      crons,
      integrations,
      bots,
      mcpProviders,
      mcpProvidersLoading,
      createMcpProvider,
      updateMcpProvider,
      deleteMcpProvider,
      skillSources,
      skillSourcesLoading,
      createSkillSource,
      updateSkillSource,
      deleteSkillSource,
      groups,
      memberSetsLoading,
      orgSetIds,
      createGroup,
      renameGroup,
      deleteGroup,
      enrollInGroup,
      withdrawFromGroup,
      connectorsEnabled,
      createConnectorConnection,
      reconnectConnectorConnection,
      members,
      membersLoaded,
      usage24h,
      sessionAccessSnapshot,
      usageAccessSnapshot,
      getAgent,
      getSessions,
      createAgent,
      saveSharing,
      saveAgentCallPolicy,
      deleteAgent,
      updateAgent,
      moveAgent,
      createIntegration,
      finalizeSlackInstall,
      deleteIntegration,
      createHook,
      createGithubHook,
      createGitlabHook,
      deleteHook,
      deleteBot,
      setChannelTrigger,
      setChannelAgent,
      setBotShareable,
      saveCron,
      deleteCron,
      provisionDaemon,
      renameDaemon,
      setDaemonSessionRetention,
      reconnectDaemon,
      deleteDaemon,
      restartDaemon,
      upgradeDaemon,
      refresh,
      refreshSessions,
      refreshDaemons,
      loading,
      agentsLoading,
      sessionsLoading,
      sessionsLoadingMore,
      loadMoreSessions,
      daemonsLoading,
      cronsLoading,
      error
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useConsoleData(): ConsoleData {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useConsoleData must be used within <ConsoleDataProvider>')
  return ctx
}
