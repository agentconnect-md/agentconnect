// AgentConnect Console — demo data + lookups.
// Ported from the AgentConnect design (static demo content for the console UI).

import type { AgentIcon } from '@/lib/agent-icon'
import { gitRepoHostname } from './git-url-tile'
import { isCodeHostHookKind, type HookKind } from '@agentconnect.md/protocol/code-host'
import type { DaemonSessionRetention, ManagedMemoryScope, MemoryDreamingConfig } from '@/lib/api'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { platformLabel } from '@/lib/platform-labels'
import { randomUuid } from '@/lib/random-uuid'

export type LifecycleStatusKey = 'upgrading' | 'restarting'
export type ConnectionStatusKey = 'online' | 'paused' | 'offline'
export type StatusKey = ConnectionStatusKey | LifecycleStatusKey

export interface StatusInfo {
  dot: string
  label: string
  bg: string
  text: string
}

const STATUS_MAP: Record<StatusKey, StatusInfo> = {
  online: { dot: 'var(--status-online)', label: 'online', bg: 'var(--status-online-soft)', text: '#0f7a48' },
  paused: { dot: 'var(--status-paused)', label: 'paused', bg: 'var(--status-paused-soft)', text: '#9a6500' },
  offline: {
    dot: 'var(--status-error)',
    label: 'offline',
    bg: 'var(--status-error-soft)',
    text: 'var(--status-error)'
  },
  upgrading: {
    dot: 'var(--status-paused)',
    label: 'upgrading',
    bg: 'var(--status-paused-soft)',
    text: '#9a6500'
  },
  restarting: {
    dot: 'var(--status-paused)',
    label: 'restarting',
    bg: 'var(--status-paused-soft)',
    text: '#9a6500'
  }
}

export function status(s: string): StatusInfo {
  return STATUS_MAP[s as StatusKey] ?? STATUS_MAP.offline
}

export function lifecycleStatus(
  op: Pick<DaemonLifecycleOp, 'op' | 'status'> | null | undefined
): LifecycleStatusKey | undefined {
  if (op?.status !== 'pending') return undefined
  return op.op === 'upgrade' ? 'upgrading' : 'restarting'
}

export function presentedDaemonStatus(daemon: Pick<DaemonRow, 'status' | 'lifecycleStatus'>): StatusKey {
  return daemon.lifecycleStatus ?? daemon.status
}

/** What a MANAGED deployment calls the pool: it is AgentConnect's own infrastructure, so it is
 *  named after the product. The CP names pool rows after the Pod they run in, which is churn
 *  nobody outside the cluster should read — the pool is one thing wherever it is named. */
export const POOL_LABEL = 'AgentConnect Cloud'
/** What a SELF-HOSTED deployment calls the same pool: the operator's own cluster, not a product
 *  they bought. No cluster identity reaches the console (the CP carries one bit, not a name —
 *  k8s-daemon-pool.md §3), so this names what it is rather than inventing which one it is. */
export const CLUSTER_LABEL = 'Kubernetes cluster'
/** The pool's name for THIS deployment. Not a constant, because the same pool is a product on the
 *  managed install and the operator's own cluster everywhere else (lib/feature-flags.ts `managed`).
 *  Every surface that names the pool goes through here, so no two of them disagree. */
export function poolLabel(): string {
  return featureFlagEnabled('managed') ? POOL_LABEL : CLUSTER_LABEL
}
/** One line on what placing an agent there buys you — included model usage on the managed
 *  install, the operator's own cluster everywhere else. */
export function poolTagline(): string {
  return featureFlagEnabled('managed')
    ? 'Model usage included — no API key needed.'
    : 'Runs your agents on your own cluster.'
}
/** `Agent.daemon` for a pool placement. It names the POOL, never a member: no member id survives
 *  a rollout, which is precisely why the placement stopped carrying one. */
export const POOL_PLACEMENT = 'pool'

/** What a placement NAMES. The CP stores and emits `set` (daemon-groups.md §2); `pool` stays
 *  accepted API sugar on the way IN, so the console keeps submitting it and tolerates both. */
export type PlacementKindValue = 'daemon' | 'set' | 'pool'

/** What the console calls one of an organization's own member sets. The model名 is "member set";
 *  the reader-facing one is the design's own opening sentence — a named group of daemons. */
export const GROUP_NOUN = 'group'
/** The selectable value for an org group: the pool keeps the bare `pool` sentinel, so no existing
 *  stored value changes meaning and a group can never collide with a daemon id. */
export const GROUP_PLACEMENT_PREFIX = 'set:'
export const groupPlacementValue = (setId: string): string => `${GROUP_PLACEMENT_PREFIX}${setId}`
/** The set id inside a group placement value, or null when the value names something else. */
export function groupSetIdOf(value: string | null | undefined): string | null {
  return value?.startsWith(GROUP_PLACEMENT_PREFIX) ? value.slice(GROUP_PLACEMENT_PREFIX.length) : null
}

/** Is this placement a member set at all — the pool or one of the org's groups? */
export function isSetPlacementKind(kind?: PlacementKindValue): boolean {
  return kind === 'set' || kind === 'pool'
}

/**
 * Is this placement the POOL specifically? A `set` placement naming one of the org's own groups is
 * not, and telling them apart is what `orgSetIds` is for: the pool is org-less, so it is never in
 * the list `GET /member-sets` returns. An unknown or still-loading list therefore reads as the
 * pool — which is what every `set` placement was before groups existed, so the default is the
 * pre-groups behavior rather than a guess.
 */
export function isPoolPlacementKind(kind?: PlacementKindValue, setId?: string | null, orgSetIds?: ReadonlySet<string>) {
  if (!isSetPlacementKind(kind)) return false
  return !(setId && orgSetIds?.has(setId))
}

/**
 * The ONE mapping from a DTO's placement pair to the value the console selects on: the pool
 * sentinel, a group value, a member id, or null when the agent is unplaced. Every reader of the raw
 * DTO uses it — the list projection AND the editor's own reload — so a reload cannot disagree with
 * the row it reloaded. Deriving "is this the pool?" from `daemonId` being null is what made a
 * reloaded pool agent read as unplaced; `placementKind` is the only thing that says it.
 */
export function placementValueOf(
  dto: { placementKind?: PlacementKindValue; daemonId: string | null; setId?: string | null },
  orgSetIds?: ReadonlySet<string>
): string | null {
  if (!isSetPlacementKind(dto.placementKind)) return dto.daemonId ?? null
  return dto.setId && orgSetIds?.has(dto.setId) ? groupPlacementValue(dto.setId) : POOL_PLACEMENT
}

/** Resolve placement display text without exposing an unresolved daemon id or a raw set id.
 *  `groups` is REQUIRED, and deliberately so: defaulting it to `[]` made every caller that had not
 *  been updated silently label a group placement "AgentConnect Cloud" — a wrong answer that looks
 *  like a right one. An empty array is still the correct argument while the list is loading. */
export function agentDaemonLabel(
  agent: Pick<Agent, 'daemon' | 'daemonName' | 'placementKind' | 'setId'>,
  daemons: readonly Pick<DaemonRow, 'daemonId' | 'name'>[],
  groups: readonly Pick<MemberSetRow, 'setId' | 'name'>[]
): string {
  if (isSetPlacementKind(agent.placementKind)) {
    const group = agent.setId ? groups.find((candidate) => candidate.setId === agent.setId) : undefined
    return group?.name ?? poolLabel()
  }
  return daemons.find((daemon) => daemon.daemonId === agent.daemon)?.name ?? agent.daemonName ?? '—'
}

/** What a placement TARGET is, as the console draws it: the install-wide pool, one of the org's
 *  own groups, or a single machine. Same three cases `agentDaemonLabel` names. */
export type PlacementIconKind = 'pool' | 'group' | 'daemon'

/** The pool's own glyph — the product's cloud on a managed install, a cluster everywhere else,
 *  matching how the pool draws itself on the Infra list and its detail page. */
export function poolIcon(): string {
  return featureFlagEnabled('managed') ? 'cloud' : 'boxes'
}

/** The ONE icon language for placements, so the picker, the list and every header agree. */
export function placementIcon(kind: PlacementIconKind): string {
  return kind === 'pool' ? poolIcon() : kind === 'group' ? 'layers' : 'server'
}

/** Which of the three a given agent is placed on — the icon half of `agentDaemonLabel`, resolved
 *  from the same pair, so a row's glyph can never disagree with the name beside it. */
export function agentPlacementKind(
  agent: Pick<Agent, 'placementKind' | 'setId'>,
  groups: readonly Pick<MemberSetRow, 'setId'>[]
): PlacementIconKind {
  if (!isSetPlacementKind(agent.placementKind)) return 'daemon'
  return agent.setId && groups.some((candidate) => candidate.setId === agent.setId) ? 'group' : 'pool'
}

/** The glyph for an agent's placement. */
export function agentPlacementIcon(
  agent: Pick<Agent, 'placementKind' | 'setId'>,
  groups: readonly Pick<MemberSetRow, 'setId'>[]
): string {
  return placementIcon(agentPlacementKind(agent, groups))
}

/** The daemon whose REPORTED capabilities describe an agent's placement — runtimes, model catalog,
 *  and whether that runtime is signed in. A set target resolves to one SERVING member standing in
 *  for the set (the rule `editAgentCapabilitySource` already uses), never to the placement:
 *  `POOL_PLACEMENT` matches no daemon id, and the `undefined` that yields reads as "nothing to
 *  report" rather than "not known" — which is what let a pool agent needing a login look ready. */
export function agentCapabilitySource<T extends Pick<DaemonRow, 'daemonId' | 'pool' | 'memberSetId' | 'status'>>(
  agent: Pick<Agent, 'daemon' | 'placementKind' | 'setId'>,
  daemons: readonly T[],
  groups: readonly Pick<MemberSetRow, 'setId'>[]
): T | undefined {
  const kind = agentPlacementKind(agent, groups)
  if (kind === 'daemon') return daemons.find((daemon) => daemon.daemonId === agent.daemon)
  const members = daemons.filter((daemon) =>
    kind === 'pool' ? daemon.pool : !daemon.pool && daemon.memberSetId === agent.setId
  )
  return members.find((daemon) => daemon.status === 'online') ?? members[0]
}

/**
 * One of the organization's own member sets, as the console holds it (daemon-groups.md §2).
 *
 * Deliberately NOT a `DaemonRow`: a group is a placement TARGET, not a machine — it has no host,
 * version, CPU or uptime of its own, and the moment it borrows those it starts reading like the
 * one member that happens to answer for it.
 */
export interface MemberSetRow {
  setId: string
  name: string
  /** Daemon ids enrolled. A daemon is in at most one group. */
  memberDaemonIds: string[]
  /** Agents placed on the group — the same count Cloud shows. */
  agentCount: number
}

/** One status for a group: online while any of its members is serving — the same rule the pool
 *  uses, and for the same reason (whichever member holds the duty is the one serving). */
export function groupFleetStatus(
  group: Pick<MemberSetRow, 'memberDaemonIds'>,
  daemons: readonly Pick<DaemonRow, 'daemonId' | 'status'>[]
): ConnectionStatusKey {
  const members = new Set(group.memberDaemonIds)
  return daemons.some((d) => members.has(d.daemonId) && d.status === 'online') ? 'online' : 'offline'
}

/** The daemons that are MACHINES this org connected. Pool members are install-wide, replaceable
 *  Pods carried in every org's fleet and hidden wherever the deployment does not offer the pool —
 *  so every "does this org have a daemon to run on?" decision projects them out first. */
export function localDaemons<T extends { pool?: boolean }>(daemons: readonly T[]): T[] {
  return daemons.filter((daemon) => !daemon.pool)
}

/** One status for the whole pool: online while any member is serving. */
export function poolFleetStatus(members: Pick<DaemonRow, 'status'>[]): ConnectionStatusKey {
  return members.some((m) => m.status === 'online') ? 'online' : 'offline'
}

// An agent runs *inside* its owning daemon, so it can't really be online when that
// daemon is offline. A planned restart/upgrade is different: placement and sessions
// remain intact while the daemon drains and relaunches, so carry that explicit amber
// transition onto the agent instead of flashing it red. When the owning daemon isn't
// in the fleet (e.g. the demo agents' placeholder daemons), trust the stored status.
//
// An UNPLACED agent is offline regardless of what the stored status says: no daemon
// means nothing is hosting it. That is a deliberate belt-and-braces read — the CP is
// supposed to flip `status` on unplacement, but any path that clears the placement
// without writing the status (a bare FK SetNull, say) would otherwise paint a green
// dot on an agent that cannot run.
export function effectiveAgentStatus(
  agent: Pick<Agent, 'status' | 'daemon' | 'placementKind' | 'placementReady'>,
  owningDaemon: Pick<DaemonRow, 'status' | 'lifecycleStatus'> | undefined
): StatusKey {
  if (agent.status === 'online') {
    // A pool placement names no member, so there is no owning daemon to consult: the CP already
    // answered "could anything serve this now" and that answer is the whole story (#987 — asking
    // a placed member's liveness is what kept a rolled-over agent permanently offline).
    if (isPoolPlacementKind(agent.placementKind)) return agent.placementReady ? agent.status : 'offline'
    if (agent.daemon === '—') return 'offline'
    if (owningDaemon !== undefined) {
      if (owningDaemon.lifecycleStatus) return owningDaemon.lifecycleStatus
      if (owningDaemon.status !== 'online') return 'offline'
    }
  }
  return agent.status
}

// "Placed" = the agent has a daemon AND a runtime, so it can actually run. Every org
// ships the built-in `agentconnect` preset UNPLACED (daemon '—', deferred runtime '');
// configuring it (onboarding's agent step) or creating a user agent flips this true. It
// is the signal for "the org is set up" — used by the onboarding gate + getting-started.
export function agentIsPlaced(agent: Pick<Agent, 'daemon' | 'runtime' | 'placementKind'>): boolean {
  return (isPoolPlacementKind(agent.placementKind) || agent.daemon !== '—') && agent.runtime !== ''
}

export type LaneKind = 'msg' | 'plan' | 'tool' | 'edit' | 'done' | 'notice'

export interface LaneInfo {
  lane: string
  laneColor: string
  dot: string
  weight: number
  textColor: string
  codeColor: string
}

const LANE_MAP: Record<LaneKind, LaneInfo> = {
  msg: {
    lane: 'MSG',
    laneColor: 'var(--text-tertiary)',
    dot: 'var(--text-disabled)',
    weight: 600,
    textColor: 'var(--text-primary)',
    codeColor: 'var(--text-secondary)'
  },
  plan: {
    lane: 'PLAN',
    laneColor: 'var(--brand)',
    // Purple, not brand magenta — a magenta dot reads as an error marker.
    dot: 'var(--purple-500)',
    weight: 500,
    textColor: 'var(--text-secondary)',
    codeColor: 'var(--text-secondary)'
  },
  tool: {
    lane: 'TOOL',
    laneColor: 'var(--blue-500)',
    dot: 'var(--blue-500)',
    weight: 500,
    textColor: 'var(--text-secondary)',
    codeColor: 'var(--text-secondary)'
  },
  edit: {
    lane: 'EDIT',
    laneColor: 'var(--amber-500)',
    dot: 'var(--amber-500)',
    weight: 500,
    textColor: 'var(--text-secondary)',
    codeColor: 'var(--text-secondary)'
  },
  // Daemon chrome for a wait the agent has nothing else to show for (a sandbox pod coming
  // up). Not the agent's work — it renders as its own standalone line, never inside the
  // collapsible work panel (see WORK_LANES).
  notice: {
    lane: 'NOTICE',
    laneColor: 'var(--text-tertiary)',
    dot: 'var(--text-disabled)',
    weight: 400,
    textColor: 'var(--text-tertiary)',
    codeColor: 'var(--text-tertiary)'
  },
  // An assistant's completed reply — rendered neutrally, identical to a real transcript
  // text row (see SessionDetailView.msgStep). Keeping this in sync means a live playground
  // / resumed-webchat turn reads the same as its persisted history (no lingering green
  // "DONE" highlight once the turn is over).
  done: {
    lane: '',
    laneColor: 'var(--text-tertiary)',
    dot: 'var(--text-disabled)',
    weight: 400,
    textColor: 'var(--text-primary)',
    codeColor: 'var(--text-secondary)'
  }
}

export function lane(kind: string): LaneInfo {
  return LANE_MAP[kind as LaneKind] ?? LANE_MAP.tool
}

export function fileColor(tag: string): string {
  if (tag === 'A') return 'var(--green-500)'
  if (tag === 'C') return 'var(--blue-500)'
  return 'var(--amber-500)'
}

export interface Integration {
  platform: string
  name: string
  channel: string
  workMode: string
}

// A single entry in the agent's working tree (Workspace tab). `tag` is the git
// status letter (A/M/C) shown as a small badge via `fileColor`. `content`, when
// present, is previewed in the two-pane Files browser; folders and files without
// it show the "No preview" empty state (mock rows only — live files stream their
// bytes from the daemon).
export interface WorkspaceFile {
  icon: string
  name: string
  meta: string
  tag?: string
  content?: string
  /** Present ⇒ this row is a folder; rendered as an expandable tree level. */
  children?: WorkspaceFile[]
}

/** Depth-first flatten of a mock workspace tree (for counts/summaries). */
export function flattenFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  return files.flatMap((f) => [f, ...(f.children ? flattenFiles(f.children) : [])])
}

// Where the agent runs — two modes, mirroring the host-neutral workspace model
// (git-workspace-model.md: scratch | git + orthogonal credential). The path is
// daemon-generated; the UI picks the mode plus repo/branch/subdir.
export interface GitWorkspace {
  mode: 'git'
  worktree?: boolean
  /** Who vouches for the repository (persisted credential); absent ⇒ anonymous clone. */
  provider?: 'github' | 'gitlab'
  /** Rename-proof numeric repository/project id, when the credential carries one. */
  repoId?: string
  gitAccess?: 'read' | 'write'
  /** Full stored clone address — drives the display-tile derivation (§7). */
  gitRepo: string
  repo: string // short display form, e.g. acme/infra
  /** Browsable https URL derived from the stored full git address. */
  repoUrl?: string
  branch: string // e.g. main
  agentDir: string // subdir within the repo; '/' ⇒ repo root
  lastPull: string
  commit: string
  commitMsg: string
  commitTime: string
  clean: boolean
  files: WorkspaceFile[]
}

export interface ScratchWorkspace {
  mode: 'scratch'
  created: string
  size: string
  files: WorkspaceFile[]
}

export type Workspace = GitWorkspace | ScratchWorkspace

// Which provider tile a workspace displays as (§7) — DERIVED from host + credential,
// never stored: a provider names its tile; anonymous on a managed host shows that
// tile with a public badge; anonymous anywhere else is the Git URL tile.
export type WorkspaceSource = 'scratch' | 'github' | 'gitlab' | 'giturl'

export function workspaceSourceOf(
  ws: Pick<Workspace, 'mode'> & Partial<Pick<GitWorkspace, 'provider' | 'gitRepo'>>
): WorkspaceSource {
  if (ws.mode === 'scratch') return 'scratch'
  if (ws.provider === 'github' || ws.provider === 'gitlab') return ws.provider
  const host = ws.gitRepo !== undefined ? gitRepoHostname(ws.gitRepo) : undefined
  if (host === 'github.com') return 'github'
  if (host === 'gitlab.com') return 'gitlab'
  // Bare `owner/repo` shorthand (legacy rows) is GitHub-only sugar.
  if (host === undefined && ws.gitRepo !== undefined && /^[^/\s]+\/[^/\s]+$/.test(ws.gitRepo.trim())) return 'github'
  return 'giturl'
}

/** Whether the workspace is a clone rather than an empty directory. Everything that
 *  reads a checkout — the files view, session worktrees, branch scope — keys off this
 *  rather than off one code host's name, which is how GitLab workspaces used to read
 *  as scratch. Host-specific facts (App installations, repo grants) still ask by mode. */
export function isGitWorkspace(ws: Pick<Workspace, 'mode'>): ws is GitWorkspace {
  return ws.mode !== 'scratch'
}

export interface WorkspaceStatusInfo {
  dot: string
  bg: string
  text: string
  label: string
}

// Badge styling for the workspace card: github clean/dirty, or scratch (neutral).
export function workspaceStatus(ws: Workspace): WorkspaceStatusInfo {
  if (ws.mode === 'scratch') {
    return { dot: 'var(--text-tertiary)', bg: 'var(--surface-sunken)', text: 'var(--text-secondary)', label: 'scratch' }
  }
  if (ws.clean) return { dot: 'var(--status-online)', bg: 'var(--status-online-soft)', text: '#0f7a48', label: 'clean' }
  return { dot: 'var(--amber-500)', bg: 'var(--status-paused-soft)', text: '#9a6500', label: 'uncommitted' }
}

/** Per-resource visibility (docs/designs/resource-visibility.md). */
export type ResourceVisibility = 'org' | 'restricted'
export type AgentCallPolicy = 'all' | 'selected'

export interface Agent {
  id: string
  /** Slug identifier — lowercase [a-z0-9-], unique per org; the daemon-facing handle. */
  name: string
  /** Optional human-readable label ("Acme Network Bot"); render via agentLabel(). */
  displayName?: string
  /** True for a built-in preset agent: shows the "builtin" label and hides Delete. */
  builtin?: boolean
  /** Console avatar descriptor; null ⇒ legacy default (the runtime mark). Rendered by <AgentIconView>. */
  icon?: AgentIcon | null
  model: string
  /** Authoritative runtime id (e.g. 'claude' | 'codex' | 'opencode' | 'claude-acp').
   * This is a distinct field from `model` — never derive one from the other. */
  runtime: string
  /** One-line summary shown on the detail page's General card. */
  desc: string
  /** Platform output verbosity: low | medium | high; '—' when unset (daemon default). */
  outputMode: string
  /** Whether platform replies include attribution/session footer chrome. */
  showFooter: boolean
  /** Whether Slack threads include the persistent model/context/session status row. */
  showStatusBar: boolean
  /** Reasoning-effort level (runtime-specific vocabulary, see effortField); '' when unset. */
  reasoning: string
  /** Runtime fast mode toggle; unset reads as false (runtime default). */
  fastMode: boolean
  /** Operational message-processing toggle; true ⇒ the agent skips all messages
   *  (stays connected but answers nothing). Orthogonal to `status`. */
  pause: boolean
  /** Memory backend: 'managed' (our directory) | 'native' (runtime's own) | 'none' | 'external'. */
  memoryProvider: string
  /** Opt-in managed-memory extraction after each completed turn. */
  memoryAutoDistill: boolean
  /** Managed-memory partitioning; 'channel' ⇒ per-channel folders (#653). Absent ⇒ agent. */
  memoryScope?: ManagedMemoryScope
  /** Managed-memory dreaming policy; present only when configured (managed provider). */
  memoryDreaming?: MemoryDreamingConfig
  /** External-memory binding metadata; present only when memoryProvider='external'. */
  memoryConnectionId?: string
  memoryRecall?: {
    mode: 'auto' | 'tool-only'
    topK: number
    maxBytes: number
    timeoutMs: number
  }
  memoryCaptureMode?: 'turn' | 'manual'
  /** Runtime permission/approval mode; 'default' means the runtime default. */
  permissionMode: string
  /** Explicit opt-in for chat-side runtime changes and approval controls. */
  allowRuntimeChangesInChat: boolean
  /** The agent's OWN variables, in display order. A row here may be inactive while
   *  a same-key organization entry is assigned (shown "Overridden by Organization")
   *  and becomes effective again once that assignment goes away. */
  env: { k: string; v: string }[]
  /** Names of the agent's write-only secret env vars (values are never returned). */
  secretKeys: string[]
  /** Organization-owned variables assigned to this agent (design §8.2). Read-only
   *  here — only Organization Settings can change them or their audience. */
  organizationVariables: { k: string; v: string }[]
  /** Names of organization-owned secrets assigned to this agent. Values are never
   *  returned for these either. */
  organizationSecretKeys: string[]
  /** What the placement NAMES. A `set` carries `daemon: POOL_PLACEMENT` and no member id.
   *  Absent (a mock row, an older CP) reads as `daemon`, which is the pre-pool behavior. */
  placementKind?: PlacementKindValue
  /** Which member set, when the kind is `set`. The pool is the one that is not the org's, so this
   *  plus the org's own list is what tells Cloud from a group (daemon-groups.md §2). */
  setId?: string | null
  /** Server-computed: can a session start right now? For a set placement that is "some member is
   *  live", which is the question the console used to answer with a dead member's liveness. */
  placementReady?: boolean
  daemon: string
  /** Display name projected with the Agent; available even when the daemon itself is not visible. */
  daemonName?: string
  region: string
  /** Convenience mirror of the workspace for list views: the cloned repository or
   *  project path on either code host, else '—'. */
  repo: string
  /** On-disk working dir (the checkout's agentDir, or the scratch path). */
  workdir: string
  status: StatusKey
  tokens: string
  cost: string
  /** Creator's userId — resolved to a name / "You" at render via creatorLabel; '' when CLI/self-created. */
  createdBy: string
  createdAt: string
  /** Last editor's userId — resolved to a name / "You" at render via creatorLabel; '' when CLI/self-created. */
  lastModifiedBy: string
  lastModifiedAt: string
  /** 'org' = visible to all members; 'restricted' = the complete sharedWith audience. */
  visibility: ResourceVisibility
  /** Complete app_user.id audience when restricted. */
  sharedWith: string[]
  /** Whether the caller may change non-sharing agent settings. */
  canEdit: boolean
  /** Whether the caller may change this agent's sharing. */
  canManageSharing: boolean
  /** Which peer agents may call this agent as a sub-agent. */
  callPolicy: AgentCallPolicy
  /** Agent ids allowed to call this agent when callPolicy='selected'. */
  allowedCallerAgentIds: string[]
  /** Which peer agents this agent may discover and call. */
  outboundPolicy: AgentCallPolicy
  /** Agent ids this agent may target when outboundPolicy='selected'. */
  allowedTargetAgentIds: string[]
  /** #536: when true, the agent introduces itself to peers on a genuine channel join. */
  introduceOnJoin: boolean
  /** #642: persisted per-agent Run in sandbox preference. */
  runInSandbox: boolean
  /** #642: whether the placed daemon can provide the sandbox (else the toggle is disabled). */
  sandboxSupported: boolean
  /** #642: whether daemon policy forces the effective value on and locks the toggle. */
  sandboxRequired: boolean
  integrations: Integration[]
  /** Distinct kinds of enabled inbound triggers (hooks) — list-view marks. */
  hookKinds?: HookKind[]
  workspace: Workspace
}

// Model display label: the ACP value verbatim — including a literal `default`
// when the runtime advertises one (claude does), because that IS the id the agent
// stores and the runtime answers to. We never re-case or re-word an advertised id,
// and never fabricate one: no model at all renders as the em-dash placeholder.
export function modelLabel(model: string): string {
  return model || '—'
}

// What the console calls an agent: the human-readable display name when set, else
// the slug. Identifier contexts (API samples, workspace paths) keep `name` itself.
export function agentLabel(a: { name: string; displayName?: string }): string {
  return a.displayName || a.name
}

// Live slug sanitizer for agent-name inputs: mirrors the CP's
// ^[a-z0-9]+(-[a-z0-9]+)*$ rule as the user types — lowercase, whitespace →
// hyphen, everything else dropped, no leading/double hyphens. A trailing hyphen
// is allowed mid-typing; strip it via agentSlugFinalize before submit.
export function agentSlugSanitize(v: string): string {
  return v
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
}

/** Submit-ready form of a sanitized slug ('' means no usable name). */
export function agentSlugFinalize(v: string): string {
  return agentSlugSanitize(v).replace(/-+$/, '')
}

// Runtime ids offered when no daemon is selected (or it reports no profiles). When a
// daemon IS selected, the ids come from its reported runtime profiles instead. Spelled as
// the public ACP registry spells them — Claude and Codex carry its `-acp` suffix and
// opencode does not — because a chosen id that no daemon reports is one the daemon rejects
// at activation ("runtime is unavailable"), and nothing between here and there rewrites it.
export const FALLBACK_RUNTIME_IDS = ['claude-acp', 'codex-acp', 'opencode']

const REGISTRY_RUNTIME_NAME_OVERRIDES: Record<string, string> = {
  'Claude Agent': 'Claude Code'
}

// Map a runtime id to a display label. The Web registry lookup supplies the ACP
// name; the small override list captures intentional product wording. Missing
// registry metadata and user-defined runtimes retain the established fallbacks.
export function runtimeLabel(id: string, registryName?: string | null): string {
  // Deferred exec config (an unplaced preset agent, preset-agents.md §3.2): the
  // runtime is not chosen yet — every display site renders the placement dash.
  if (!id) return '—'
  const name = registryName?.trim()
  if (name) return REGISTRY_RUNTIME_NAME_OVERRIDES[name] ?? name
  switch (id.replace(/-acp$/, '')) {
    case 'claude':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'opencode':
      return 'opencode'
    default:
      return id
  }
}

// Whether a runtime exposes reasoning-effort / fast-mode tuning in the console
// (design: everything but opencode).
export function supportsModes(runtime: string): boolean {
  return runtimeLabel(runtime) !== 'opencode'
}

// The reasoning-effort control per runtime: Codex calls it "Reasoning", Claude
// Code (and unknown runtimes) "Effort" — each with its own level vocabulary.
export interface EffortField {
  label: string
  options: { v: string; l: string }[]
}

export function effortField(runtime: string): EffortField {
  if (runtimeLabel(runtime) === 'Codex') {
    // Labels mirror the Codex desktop app's Reasoning menu; values are codex-acp's
    // real `thought_level` (reasoning_effort) enum (low/medium/high/xhigh) so the
    // daemon matches them 1:1. (codex-acp 1.1.0 has no "light"/"extra-high" — those
    // silently fell back to the model default.)
    return {
      label: 'Reasoning',
      options: [
        { v: 'low', l: 'Light' },
        { v: 'medium', l: 'Medium' },
        { v: 'high', l: 'High' },
        { v: 'xhigh', l: 'Extra High' }
      ]
    }
  }
  // Values are the claude-acp `thought_level` select values verbatim
  // (low/medium/high/xhigh/max) so the daemon matches them 1:1 — "Extra" is the
  // runtime's `xhigh`. "Ultracode" is the exception: it carries no thought_level
  // value (the runtime rejects effort="ultracode"), so the daemon turns it into
  // Claude Code "ultracode" — xhigh + dynamic-workflow orchestration — via session
  // `_meta`. The value matches Claude Code's own `ultracode` settings key.
  return {
    label: 'Effort',
    options: [
      { v: 'low', l: 'Low' },
      { v: 'medium', l: 'Medium' },
      { v: 'high', l: 'High' },
      { v: 'xhigh', l: 'Extra' },
      { v: 'max', l: 'Max' },
      { v: 'ultracode', l: 'Ultracode' }
    ]
  }
}

// Display label of a stored effort level: the option label when known, the raw
// value capitalized otherwise (a level this console's vocabulary predates), and
// the em-dash placeholder when unset (runtime default).
export function effortLabel(runtime: string, v: string): string {
  const o = effortField(runtime).options.find((x) => x.v === v)
  if (o) return o.l
  return v ? v[0]!.toUpperCase() + v.slice(1) : '—'
}

export function permissionModeOptions(runtime: string): { v: string; l: string }[] {
  if (runtimeLabel(runtime) === 'Codex') {
    // Labels are matched to Codex's own names by policy, not menu position, so the
    // console can't misrepresent them. Values are codex-acp's runtime-owned ids: `agent`
    // is Codex's default (on-request approvals, reviewed by the runtime itself), and
    // `agent-full-access` is danger-full-access — out-of-workspace + network. `read-only`
    // keeps the daemon's read-only sandbox profile.
    return [
      { v: 'read-only', l: 'Read Only' },
      { v: 'agent', l: 'Approve for me' },
      { v: 'agent-full-access', l: 'Full Access' }
    ]
  }
  // Labels mirror claude-agent-acp's own mode names so the console can't misrepresent
  // them. In particular `dontAsk` is "don't prompt, DENY anything not pre-approved" — the
  // opposite of auto-approve — and `acceptEdits` auto-accepts edits rather than asking.
  return [
    { v: 'default', l: 'Default' },
    { v: 'acceptEdits', l: 'Accept Edits' },
    { v: 'auto', l: 'Auto' },
    { v: 'dontAsk', l: "Don't Ask" },
    { v: 'plan', l: 'Plan' },
    { v: 'bypassPermissions', l: 'Bypass' }
  ]
}

export function permissionModeDefault(runtime: string): string {
  return runtimeLabel(runtime) === 'Codex' ? 'agent' : 'default'
}

export function permissionModeLabel(runtime: string, v: string): string {
  const mode = v || permissionModeDefault(runtime)
  const o = permissionModeOptions(runtime).find((x) => x.v === mode)
  return o?.l ?? mode
}

// ── dynamic model catalog (runtime-model-catalog.md §7) ─────────────────────
// The daemon-discovered per-model capability matrix, carried on each
// (daemon, runtime) profile. The static tables above are demoted to the
// last-resort fallback: the helpers below prefer the catalog when present so
// the controls reflect what the runtime advertises for the SELECTED model.

/** One thought-level choice a model offers (protocol `EffortOption`). */
export interface EffortOption {
  value: string
  name?: string
  description?: string
}

/** Per-model capability entry of a runtime's catalog (protocol
 *  `RuntimeModelCapability`). `efforts: []` = the model has no effort selector;
 *  absent = not yet discovered. `fastMode` absent = unknown. */
export interface RuntimeModelCapability {
  id: string
  name?: string
  efforts?: EffortOption[]
  defaultEffort?: string
  fastMode?: boolean
}

/** A runtime's discovered model × config capability matrix (protocol
 *  `RuntimeModelCatalog` — one shape on the wire, in the CP, and here). */
export interface RuntimeModelCatalog {
  models: RuntimeModelCapability[]
  defaultModel?: string
  permissionModes?: { value: string; name?: string; description?: string }[]
  /** The runtime's own default permission mode (probe-session currentValue). */
  defaultPermissionMode?: string
  source: 'native' | 'acp'
  observedAt: string
}

/** The catalog entry for `modelId` on (daemon, runtime). `''` (the UI "Default"
 *  choice) resolves through the catalog's defaultModel. undefined = no catalog /
 *  model not discovered ⇒ callers fall back to the static tables. */
export function modelCapability(
  daemon: Pick<DaemonRow, 'runtimeModels'> | undefined,
  runtime: string,
  modelId: string
): RuntimeModelCapability | undefined {
  const catalog = daemon?.runtimeModels.find((r) => r.runtime === runtime)?.modelCatalog
  if (!catalog) return undefined
  const id = modelId || catalog.defaultModel
  if (!id) return undefined
  return catalog.models.find((m) => m.id === id)
}

/** The model the picker preselects when no explicit choice is stored: the
 *  catalog's resolved default when it is in the advertised list, else the FIRST
 *  advertised model. '' only when nothing is advertised at all — there is then no
 *  model to express and the picker offers none (design: the console never invents
 *  a "Default" entry the runtime did not advertise). */
export function preferredModelFor(daemon: Pick<DaemonRow, 'runtimeModels'> | undefined, runtime: string): string {
  const entry = daemon?.runtimeModels.find((r) => r.runtime === runtime)
  const models = entry?.models ?? []
  if (models.length === 0) return ''
  const dflt = entry?.modelCatalog?.defaultModel
  return dflt && models.includes(dflt) ? dflt : models[0]!
}

/** Runtime ids the daemon reports as needing a login on its host — its probe (or a
 *  live turn) was rejected with the ACP auth-required error.
 *
 *  This is NOT a launchability signal, and must not be used to gate a choice. The flag
 *  covers two states the facts snapshot cannot tell apart: a curated candidate whose
 *  probe never succeeded (unadmitted), and an admitted, perfectly launchable runtime
 *  whose last live turn happened to be rejected for login. Placement is deliberately
 *  independent of readiness either way — `docs/designs/preset-agents.md` §3.2 makes an
 *  agent on a logged-out runtime an ordinary supported state, and creation/placement
 *  never gate on it. So the pickers MARK these and prefer a signed-in default; they do
 *  not disable them. */
export function loginRequiredRuntimeIds(daemon: Pick<DaemonRow, 'runtimeModels'> | undefined): string[] {
  return (daemon?.runtimeModels ?? []).filter((r) => r.authRequired).map((r) => r.runtime)
}

/** One rendered effort choice; `description` (when the runtime provides one)
 *  goes on the control's title attribute. */
export interface EffortChoice {
  value: string
  label: string
  description?: string
}

const capitalize = (v: string): string => (v ? v[0]!.toUpperCase() + v.slice(1) : v)

/** Effort options for the selected model: the discovered vocabulary when the
 *  capability carries one (label: runtime-provided name → static table →
 *  capitalized value), else exactly the static effortField list. `[]` = the
 *  model has no effort selector — the UI hides the control. */
/** Strip label chrome a runtime repeats on EVERY choice (pi's "Thinking: off" /
 *  "Thinking: minimal" / …): when all labels share a common prefix ending in
 *  ": ", the shared part carries no information — drop it and re-capitalize the
 *  remainder. Only colon-separated prefixes are stripped (a shared plain word
 *  like "Very High"/"Very Low" may be meaningful), and never when a label would
 *  end up empty. */
function stripSharedLabelChrome(labels: string[]): string[] {
  if (labels.length < 2) return labels
  let lcp = labels[0]!
  for (const l of labels) {
    let i = 0
    while (i < Math.min(lcp.length, l.length) && lcp[i] === l[i]) i++
    lcp = lcp.slice(0, i)
    if (!lcp) return labels
  }
  const sepAt = lcp.lastIndexOf(': ')
  if (sepAt === -1) return labels
  const cut = sepAt + 2
  if (labels.some((l) => l.length <= cut)) return labels
  return labels.map((l) => capitalize(l.slice(cut)))
}

export function effortChoicesFor(runtime: string, capability: RuntimeModelCapability | undefined): EffortChoice[] {
  const efforts = capability?.efforts
  if (!efforts) return effortField(runtime).options.map((o) => ({ value: o.v, label: o.l }))
  const staticLabels = new Map(effortField(runtime).options.map((o) => [o.v, o.l]))
  const labels = stripSharedLabelChrome(efforts.map((e) => e.name ?? staticLabels.get(e.value) ?? capitalize(e.value)))
  return efforts.map((e, i) => ({
    value: e.value,
    label: labels[i]!,
    ...(e.description ? { description: e.description } : {})
  }))
}

/** Whether the selected model offers the fast toggle — the catalog verdict when
 *  discovered, else the static supportsModes(runtime) behavior. */
export function fastModeAvailableFor(runtime: string, capability: RuntimeModelCapability | undefined): boolean {
  return capability?.fastMode ?? supportsModes(runtime)
}

/** The effort pill to light up: the stored selection, else the vocabulary's
 *  'default' entry when it offers one. Display-only unification of the
 *  "nothing selected" state with the runtime's default sentinel (behaviorally
 *  identical where the sentinel exists — e.g. claude's adaptive thinking);
 *  vocabularies without a 'default' entry keep the unselected state. */
export function displayedEffort(effort: string, choices: EffortChoice[], defaultEffort?: string): string {
  if (effort) return effort
  if (choices.some((o) => o.value === 'default')) return 'default'
  // No sentinel (e.g. copilot): light the model's own observed default level.
  if (defaultEffort && choices.some((o) => o.value === defaultEffort)) return defaultEffort
  return ''
}

/** Known effort tiers in ascending order, used to degrade an unavailable
 *  selection to its nearest offered neighbor (step DOWN first, then up). */
const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

/** Resolve the effort selection after the user picks a model: keep it when the
 *  model offers it; otherwise drop to the model's own default level; otherwise
 *  degrade along the ladder; otherwise fall back to '' (runtime default). Only
 *  invoked on a user-driven model change — catalog ARRIVAL never mutates an
 *  in-progress selection. */
export function resolveEffortForModel(
  runtime: string,
  capability: RuntimeModelCapability | undefined,
  current: string
): string {
  if (!current) return ''
  const offered = new Set(effortChoicesFor(runtime, capability).map((o) => o.value))
  if (offered.has(current)) return current
  const dflt = capability?.defaultEffort
  if (dflt && offered.has(dflt)) return dflt
  const at = EFFORT_LADDER.indexOf(current)
  if (at !== -1) {
    for (let i = at - 1; i >= 0; i--) if (offered.has(EFFORT_LADDER[i]!)) return EFFORT_LADDER[i]!
    for (let i = at + 1; i < EFFORT_LADDER.length; i++) if (offered.has(EFFORT_LADDER[i]!)) return EFFORT_LADDER[i]!
  }
  return ''
}

/** Permission modes for the runtime: the catalog's runtime-level list when
 *  present (labels resolved like effortChoicesFor), else the static table. */
export function permissionModeChoicesFor(
  runtime: string,
  catalog: RuntimeModelCatalog | undefined
): { v: string; l: string; description?: string }[] {
  const modes = catalog?.permissionModes
  if (!modes?.length) return permissionModeOptions(runtime)
  const staticLabels = new Map(permissionModeOptions(runtime).map((o) => [o.v, o.l]))
  const labels = stripSharedLabelChrome(modes.map((m) => m.name ?? staticLabels.get(m.value) ?? capitalize(m.value)))
  return modes.map((m, i) => ({
    v: m.value,
    l: labels[i]!,
    ...(m.description ? { description: m.description } : {})
  }))
}

/** The permission-mode pill the Add flow preselects: the current value when the
 *  vocabulary offers it, else the runtime's own default (probe currentValue),
 *  else the first offered mode. With no dynamic vocabulary the static default
 *  passes through unchanged. Keeps a statically-guessed initial value from
 *  rendering as a phantom "(unavailable)" selection. */
export function resolvedPermissionMode(
  mode: string,
  choices: { v: string; l: string }[],
  catalog: RuntimeModelCatalog | undefined
): string {
  if (!catalog?.permissionModes?.length) return mode
  if (choices.some((o) => o.v === mode)) return mode
  const dflt = catalog.defaultPermissionMode
  if (dflt && choices.some((o) => o.v === dflt)) return dflt
  return choices[0]?.v ?? mode
}

// ── read-only display of an agent's effective runtime config ────────────────
// The Add/Edit pickers resolve a blank model to the owning daemon's advertised
// default and label effort/permission with the runtime's OWN catalog names
// (runtime-model-catalog.md §7). The read-only surfaces (detail card rows, list
// sub-labels) must reproduce that exact resolution, or the same placed agent
// reads "Default / Extra High / Full Access" in the card yet "gpt-5.6-sol /
// Xhigh / Agent (full access)" in the editor. Each helper degrades to the static
// tables when the owning daemon reports no catalog (offline / unplaced / a
// pre-catalog daemon), so nothing regresses where the catalog is absent.

/** The model id the pickers treat as selected: the stored id when the owning
 *  daemon advertises it — a runtime-surfaced literal `default` counts as an
 *  advertised option, NOT the blank sentinel — else the daemon's advertised
 *  default (`preferredModelFor`). Byte-for-byte the editor's `selectedModel`
 *  resolution (minus the move-only `daemonChanged` escape), so the read-only
 *  label and its effort capability track the same model the editor shows. */
function selectedModelId(daemon: Pick<DaemonRow, 'runtimeModels'> | undefined, runtime: string, model: string): string {
  const reportedModels = daemon?.runtimeModels.find((r) => r.runtime === runtime)?.models ?? []
  return model && reportedModels.includes(model) ? model : preferredModelFor(daemon, runtime)
}

/** Effective model label: the selected model's advertised id, verbatim. Mirrors
 *  the editor's `selectedModel` display — including the em-dash when the runtime
 *  advertises no models at all (the editor then offers no choice either). */
export function agentModelDisplay(
  daemon: Pick<DaemonRow, 'runtimeModels'> | undefined,
  runtime: string,
  model: string
): string {
  return modelLabel(selectedModelId(daemon, runtime, model))
}

/** Effective reasoning-effort label, resolved against the selected model's
 *  discovered capability (the picker's per-model effort vocabulary and its
 *  default-level sentinel), else the static effort table. Mirrors the pill the
 *  editor lights up. */
export function agentEffortDisplay(
  daemon: Pick<DaemonRow, 'runtimeModels'> | undefined,
  runtime: string,
  model: string,
  effort: string
): string {
  const capability = modelCapability(daemon, runtime, selectedModelId(daemon, runtime, model))
  const choices = effortChoicesFor(runtime, capability)
  const shown = displayedEffort(effort, choices, capability?.defaultEffort)
  return choices.find((o) => o.value === shown)?.label ?? effortLabel(runtime, effort)
}

/** Effective permission-mode label using the runtime catalog's own mode names
 *  (the picker's labels), else the static table. A blank stored mode resolves
 *  through the catalog's own default, else the static runtime default. */
export function agentPermissionDisplay(
  daemon: Pick<DaemonRow, 'runtimeModels'> | undefined,
  runtime: string,
  permissionMode: string
): string {
  const catalog = daemon?.runtimeModels.find((r) => r.runtime === runtime)?.modelCatalog ?? undefined
  const choices = permissionModeChoicesFor(runtime, catalog)
  const mode = permissionMode || catalog?.defaultPermissionMode || permissionModeDefault(runtime)
  return choices.find((o) => o.v === mode)?.l ?? permissionModeLabel(runtime, permissionMode)
}

export interface SessionFile {
  tag: string
  path: string
}

/** Bounded image on a live or daemon-backed Playground/WebChat user turn. */
export interface SessionImage {
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  data: string
}

export interface SessionStep {
  kind: LaneKind
  who?: string
  /** Stable identity of the turn this step belongs to — the wire/user turnId for a live webchat
   *  turn, or a minted id for a standalone step (a locally-pushed warning is its own trivial
   *  turn). Guaranteed present: `stampStep` mints one when a producer omits it, so consumers
   *  (lane grouping, transcript turn keys) can rely on it. Pair with `agentId` when folding
   *  interleaved participant streams into conversation blocks. */
  turnId: string
  /** Authoring participant of a live multi-agent webchat step — keys the per-agent
   *  stream lane accumulation and the per-block attribution label. */
  agentId?: string
  /** Hard lane boundary (the supersession marker): chunk accumulation for this
   *  step's lane never merges across it, so a replacement generation starts
   *  fresh blocks while the marker stays a visible part of the conversation. */
  boundary?: boolean
  /** A superseded answer's streamed `done` blocks, re-tagged 'plan' to collapse into the work
   *  lane. Still MESSAGE text — renderers must not apply reasoning-only treatment to it. */
  demoted?: boolean
  /** Display timestamp for live/mock-only steps. Persisted transcripts use their raw ts. */
  time?: string
  text: string
  code?: string
  files?: SessionFile[]
  image?: SessionImage
  /** Client-side timestamp for live playground/webchat steps. Persisted transcripts
   *  carry their own message `ts`; this only keeps in-memory live stats moving. */
  observedAtMs?: number
  /** Live-webchat tool-call identity + latest ACP status, mirrored straight off the
   *  WebchatEvent. The live wire frame never carries input/output/content (kept off
   *  the hot path — see protocol webchat.ts) but the daemon persists the full body
   *  unconditionally as it streams, so this id is enough to pull the same detail a
   *  history view gets, via the existing `fetchToolBody` read. */
  toolCallId?: string
  toolStatus?: string
  /** The daemon session that recorded this tool call — set on live multi-agent
   *  steps where the owning participant's session differs from the row's
   *  primary `realSessionId`; the on-demand tool-body read targets it. */
  toolSessionId?: string
  /** Canonical webchat post id (#753) — set on a live step rendered from an
   *  agent-initiated `rd/webchat-post` frame, which has no preceding optimistic
   *  `msg` prompt to anchor a turn-shaped reconciliation. `reconcilePersistedLiveSteps`
   *  drops the step outright once a persisted row carries the same `postId`, from
   *  ANY conversation participant's session — not just this step's own author. */
  postId?: string
}

// Per-session token accounting (protocol `SessionUsage`), metered by the daemon.
// Token counts are session-cumulative; context/cost are the latest snapshot.
export interface SessionUsage {
  /** Daemon timestamp of this cumulative snapshot (orders list/detail refreshes). */
  reportedAt?: string
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  thoughtTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  contextUsed?: number
  contextSize?: number
  costAmount?: number
  costCurrency?: string
}

export interface Session {
  id: string
  title: string
  /** Raw ISO timestamp used for ordering; `time` is the compact display label. */
  lastActivityAt?: string | null
  time: string
  status: StatusKey
  platform: string
  channel: string
  /** Raw platform channel id ("C…"), set only when `channel` is a resolved name —
   *  rendered as the secondary gray id next to the name. */
  channelId?: string
  /** Platform-native deep link back to the source message/thread, captured or
   *  derived by the daemon. Absent when the platform exposes none. */
  threadUrl?: string
  user: string
  /** Raw platform sender id behind `user` — e.g. `cron:<id>` for a scheduled
   *  fire. Lets the Sessions list link a run back to its schedule. */
  triggeredBy?: string
  /** Stable source kind for a `hook:<id>` trigger, enriched by the Control Plane. */
  hookKind?: HookKind
  /** Session-level visibility (lock badge / detail toggle). Absent on mock and
   *  pre-feature CP rows — treated as 'org', matching the server-side backfill. */
  visibility?: 'private' | 'org' | 'external'
  duration: string
  tokens: string
  cost: string
  toolCount: string
  statusLabel: string
  steps: SessionStep[]
  /** Token-usage breakdown from the daemon; absent when the runtime reports none.
   *  `tokens`/`cost` above are the formatted headline values derived from this. */
  usage?: SessionUsage
  // attached when flattened across agents
  agentId?: string
  agentName?: string
  model?: string
  /** Selectable models for the in-session model switch (webchat status frame). */
  availableModels?: string[]
  /** Current reasoning effort + the selectable levels for the in-session effort switch
   *  (webchat status frame). `availableEfforts` empty/absent ⇒ no effort selector. */
  effort?: string
  availableEfforts?: string[]
  /** Current permission preset + selectable presets for the in-session switch
   *  (webchat status frame). Codex Auto is composite; an empty/absent
   *  `availablePermissionModes` means no selector. */
  permissionMode?: string
  availablePermissionModes?: string[]
  /** Current fast-mode state + whether the selected model offers a fast toggle (webchat
   *  status frame). `fastModeAvailable` false/absent ⇒ no fast toggle shown. */
  fastMode?: boolean
  fastModeAvailable?: boolean
  /** Daemon-side output verbosity the session ran with (low/medium/high) — the
   *  CP-stored execution-config snapshot; absent on legacy rows. */
  outputMode?: string
  /** Checkout choice pinned for this logical session. `session` means its
   * daemon-local Git worktree can be opened from Session and Workspace views. */
  workspaceIsolation?: 'shared' | 'session'
  /** The daemon's real session id for a live (playground) conversation — used to replace
   *  its synthetic route with a refresh-safe URL. Absent until the first turn creates it. */
  realSessionId?: string
  /** Multi-agent webchat roster (webchat-multi-agents.md §3.1), primary first —
   *  present on live conversations with more than one participant. */
  participants?: Array<{ agentId: string; name: string; primary?: boolean }>
  /** merged-conversation-view.md §5.1 key — the conversation a grouped-list row
   *  stands for, whatever its member count. It is IDENTITY, not a claim that the
   *  row is a merged view: that is `participants`. A single-participant row still
   *  carries it, because filtering to one agent narrows the members, not the
   *  conversation they belong to. */
  conversationKey?: string
  /** Every member session of a grouped-list row's conversation, representative
   *  first. The row's own `id` is only the representative, which moves as
   *  participants take turns; anything that must survive that — a pin, an
   *  already-loaded check — matches against this instead. */
  memberSessionIds?: string[]
  /** Runtime id + daemonId the session ran with: the session-recorded snapshot,
   *  with the owning agent's current values as the legacy-row fallback (attached
   *  at flatten time, like `model`). Views resolve `daemon` to a display name. */
  runtime?: string
  daemon?: string
  /** Retention GC (#485): ISO timestamp at which the owning daemon deleted this
   *  session's local content. Set ⇒ the transcript is gone for good, so the views
   *  mark the row and explain the empty replay instead of offering one. On a
   *  grouped conversation row this is the EARLIEST mark across its visible members,
   *  not the representative's. Absent on live rows, mock rows, and a CP that
   *  predates the field. */
  contentPurgedAt?: string
  /** Set when only SOME of a grouped row's members are purged, so the copy can say
   *  part of the history is missing rather than all of it. */
  contentPurgedPartial?: boolean
}

/** A live Playground row starts with a synthetic id, then learns the durable ACP
 * session id. Treat both shapes as one session everywhere that merges local and
 * persisted rows. Later rows win so callers can put the freshest representation last. */
export function canonicalSessionId(session: Pick<Session, 'id' | 'realSessionId'>): string {
  return session.realSessionId ?? session.id
}

/**
 * What a row IS, for lists that must not show one conversation twice: its
 * conversation where it has one, and otherwise the session itself.
 *
 * Two rows of the same conversation can disagree about which session represents
 * it — a filtered list names the newest member the filter still covers, while the
 * open page names the newest member outright — so the session id cannot be the
 * identity a list deduplicates on.
 */
export function conversationRowKey(session: Pick<Session, 'id' | 'realSessionId' | 'conversationKey'>): string {
  return session.conversationKey ?? canonicalSessionId(session)
}

/**
 * Whether a row's only surfaced view is the merged conversation page
 * (merged-conversation-view.md §5.3), i.e. whether it should link there rather
 * than to a member session that would bounce straight back through the redirect.
 *
 * The test is MEMBERSHIP, which the CP reports over everything the caller can
 * see. Not the key — every grouped row carries one now, including conversations
 * of one. Not `participants` either: an agent filter narrows that to the rows it
 * returned, so a shared thread would read as a single-agent session precisely
 * when a filter is what made it look like one.
 */
export function isMergedConversationRow(session: Pick<Session, 'conversationKey' | 'memberSessionIds'>): boolean {
  return (session.memberSessionIds?.length ?? 0) > 1 && Boolean(session.conversationKey)
}

/**
 * A roster entry's display name. The wire roster carries ids, not names — a
 * grouped list row names its members from rows that have not been enriched yet,
 * and conversation mode synthesizes the roster from member ids alone — so the
 * org agent list is the real name source and `participant.name` is only what
 * survived of it. A name that is still the id (or its short-id fallback) is not
 * a name, and rendering it would put a uuid where an agent belongs.
 */
export function rosterParticipantName(
  participant: { agentId: string; name?: string },
  agent?: Pick<Agent, 'name' | 'displayName'>
): string {
  if (agent) return agentLabel(agent)
  const name = participant.name?.trim() ?? ''
  return name && name !== participant.agentId && name !== participant.agentId.slice(0, 8) ? name : 'Agent'
}

export function mergeCanonicalSessions(sessions: readonly Session[]): Session[] {
  const byId = new Map<string, Session>()
  for (const session of sessions) {
    const id = canonicalSessionId(session)
    byId.set(id, id === session.id ? session : { ...session, id })
  }
  return [...byId.values()]
}

/** Attach owning-agent display metadata to a CP session row. Recorded runtime
 *  values remain authoritative; only legacy rows fall back to current agent config. */
export function enrichSessionWithAgent(
  session: Session,
  agent?: Pick<Agent, 'name' | 'displayName' | 'model' | 'runtime' | 'daemon'>
): Session {
  return {
    ...session,
    agentName: agent ? agentLabel(agent) : (session.agentName ?? session.agentId),
    model: session.model ?? (session.runtime ? '' : (agent?.model ?? '—')),
    runtime: session.runtime ?? agent?.runtime ?? '',
    daemon: session.daemon ?? agent?.daemon
  }
}

// Mock/demo content is hidden by default — the console shows only live Control
// Plane data. Set `NEXT_PUBLIC_MOCK=1` (or `true`) to populate every view with the
// static demo rows below, useful for design/dev work with no CP running. Read from
// the build-time-inlined var so it's identical on the server and client (no
// hydration mismatch). Everything gated on this flag carries the `mocked-` prefix.
export const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK === '1' || process.env.NEXT_PUBLIC_MOCK === 'true'

// Mock records carry a `mocked-` prefix on their display label so they're easy
// to tell apart from live Control Plane data once the two are merged in the
// console (see lib/data-context). Ids/keys/handles are untouched — only the
// human-visible name/title is tagged.
export const MOCK_PREFIX = 'mocked-'
const tagName = <T extends { name: string }>(x: T): T => ({ ...x, name: MOCK_PREFIX + x.name })
const tagTitle = <T extends { title: string }>(x: T): T => ({ ...x, title: MOCK_PREFIX + x.title })

export const AGENTS: Agent[] = (
  [
    {
      // The built-in `agentconnect` preset every org is born with (preset-agents.md
      // §3): native brand diamond icon, "builtin" label, no Delete, unplaced
      // (deferred runtime) until placement picks a daemon.
      id: 'agentconnect',
      visibility: 'org',
      sharedWith: [],
      canEdit: true,
      canManageSharing: false,
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      introduceOnJoin: false,
      runInSandbox: false,
      sandboxSupported: false,
      sandboxRequired: false,
      name: 'agentconnect',
      builtin: true,
      icon: { kind: 'glyph', glyph: 'agentconnect', color: '#1a212b' },
      model: '',
      runtime: '',
      desc: 'A general-purpose development agent for this organization: code review, coding tasks, and everyday questions.',
      outputMode: '—',
      showFooter: true,
      showStatusBar: false,
      reasoning: '',
      fastMode: false,
      pause: false,
      memoryProvider: 'managed',
      memoryAutoDistill: false,
      permissionMode: '',
      allowRuntimeChangesInChat: false,
      env: [],
      secretKeys: [],
      organizationVariables: [],
      organizationSecretKeys: [],
      daemon: '—',
      region: '—',
      repo: '—',
      workdir: '—',
      status: 'offline',
      tokens: '0',
      cost: '$0.00',
      createdBy: '',
      createdAt: 'Jun 1, 2026',
      lastModifiedBy: '',
      lastModifiedAt: 'Jun 1, 2026',
      integrations: [],
      workspace: {
        mode: 'scratch',
        created: '—',
        size: '0 B',
        files: []
      }
    },
    {
      id: 'deploy',
      visibility: 'restricted',
      sharedWith: ['u_sam', 'u_ana', 'u_noah'],
      canEdit: true,
      canManageSharing: true,
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      introduceOnJoin: false,
      runInSandbox: false,
      sandboxSupported: true,
      sandboxRequired: false,
      name: 'deploy-bot',
      model: 'Claude Sonnet 4.5',
      runtime: 'claude',
      desc: 'Ships and rolls back deploys from chat.',
      outputMode: 'high',
      showFooter: true,
      showStatusBar: false,
      reasoning: 'high',
      fastMode: false,
      pause: false,
      memoryProvider: 'managed',
      memoryAutoDistill: false,
      permissionMode: 'default',
      allowRuntimeChangesInChat: false,
      env: [
        { k: 'GITHUB_TOKEN', v: 'ghp_••••' },
        { k: 'DEPLOY_ENV', v: 'production' }
      ],
      secretKeys: ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY'],
      organizationVariables: [],
      organizationSecretKeys: [],
      daemon: 'edge-1',
      daemonName: 'edge-1',
      region: 'us-west',
      repo: 'acme/infra',
      workdir: './services/api',
      status: 'online',
      tokens: '1.24M',
      cost: '$18.60',
      createdBy: 'Dana Reyes',
      createdAt: 'Mar 4, 2026',
      lastModifiedBy: 'Dana Reyes',
      lastModifiedAt: 'Jun 28, 2026',
      integrations: [
        { platform: 'slack', name: 'slackconnect', channel: '#deploys', workMode: '@-mention' },
        { platform: 'discord', name: 'acme-ops', channel: '#ops', workMode: '@-mention' }
      ],
      workspace: {
        mode: 'git',
        provider: 'github',
        gitRepo: 'https://github.com/acme/infra',
        repo: 'acme/infra',
        branch: 'main',
        agentDir: './services/api',
        lastPull: '12m ago',
        commit: '9f2c1a4',
        commitMsg: 'bump api to 1.4.2',
        commitTime: '12m ago',
        clean: true,
        files: [
          {
            icon: 'folder',
            name: 'services/api',
            meta: '14 files',
            children: [
              {
                icon: 'file-code',
                name: 'package.json',
                meta: 'v1.4.2',
                tag: 'M',
                content:
                  '{\n  "name": "@acme/api",\n  "version": "1.4.2",\n  "scripts": {\n    "start": "node dist/server.js",\n    "deploy": "tsx scripts/deploy.ts"\n  }\n}'
              }
            ]
          },
          { icon: 'folder', name: 'scripts', meta: '3 files', children: [] },
          {
            icon: 'file-text',
            name: 'CHANGELOG.md',
            meta: '4.1 KB',
            tag: 'M',
            content:
              '# Changelog\n\n## 1.4.2 — 2026-07-01\n- Pin deploy image by digest, never by tag\n- Roll back via scripts/rollback.ts\n\n## 1.4.1\n- Canary rollout for prod'
          },
          {
            icon: 'file-text',
            name: 'CLAUDE.md',
            meta: 'project guide · 2.1 KB',
            content:
              '# deploy-bot — project guide\n\nShips and rolls back deploys for acme/infra.\n\n- Deploy only from `main`; never a dirty tree.\n- Pin images by digest (`sha256:…`), never by tag.\n- Ask in #deploys before touching prod off-hours.'
          }
        ]
      }
    },
    {
      id: 'review',
      visibility: 'org',
      sharedWith: [],
      canEdit: true,
      canManageSharing: true,
      callPolicy: 'selected',
      allowedCallerAgentIds: ['deploy'],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      introduceOnJoin: true,
      runInSandbox: false,
      sandboxSupported: true,
      sandboxRequired: false,
      name: 'review-bot',
      model: 'Codex (GPT-5)',
      runtime: 'codex',
      desc: 'Reviews open pull requests and leaves inline comments.',
      outputMode: 'medium',
      showFooter: true,
      showStatusBar: false,
      reasoning: 'medium',
      fastMode: true,
      pause: false,
      memoryProvider: 'managed',
      memoryAutoDistill: false,
      permissionMode: 'agent',
      allowRuntimeChangesInChat: false,
      env: [{ k: 'GITHUB_TOKEN', v: 'ghp_••••' }],
      secretKeys: ['OPENAI_API_KEY'],
      organizationVariables: [],
      organizationSecretKeys: [],
      daemon: 'edge-1',
      daemonName: 'edge-1',
      region: 'us-west',
      repo: 'acme/web',
      workdir: './',
      status: 'online',
      tokens: '480K',
      cost: '$7.20',
      createdBy: 'Sam Lin',
      createdAt: 'Mar 18, 2026',
      lastModifiedBy: 'Sam Lin',
      lastModifiedAt: 'Jun 21, 2026',
      integrations: [{ platform: 'slack', name: 'slackconnect', channel: '#pull-requests', workMode: 'all messages' }],
      workspace: {
        mode: 'git',
        provider: 'github',
        gitRepo: 'https://github.com/acme/web',
        repo: 'acme/web',
        branch: 'main',
        agentDir: './',
        lastPull: '1h ago',
        commit: '3f9a1c2',
        commitMsg: 'merge PR #1284 auth refactor',
        commitTime: '1h ago',
        clean: true,
        files: [
          {
            icon: 'folder',
            name: 'src',
            meta: '128 files',
            children: [{ icon: 'folder', name: 'auth', meta: '6 files', children: [] }]
          },
          {
            icon: 'file-code',
            name: 'package.json',
            meta: '2.4 KB',
            content:
              '{\n  "name": "@acme/web",\n  "version": "2.4.0",\n  "private": true,\n  "scripts": {\n    "dev": "next dev",\n    "build": "next build"\n  }\n}'
          },
          {
            icon: 'file-text',
            name: 'README.md',
            meta: '4.0 KB',
            content:
              '# acme/web\n\nThe customer-facing web app. review-bot reviews every\nopen PR and leaves inline comments.\n\nSee docs/ for architecture and the auth refactor notes.'
          }
        ]
      }
    },
    {
      id: 'oncall',
      visibility: 'restricted',
      sharedWith: ['u_sam'],
      canEdit: true,
      canManageSharing: true,
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: ['deploy'],
      introduceOnJoin: false,
      runInSandbox: false,
      sandboxSupported: true,
      sandboxRequired: false,
      name: 'oncall-bot',
      model: 'Claude Opus 4.1',
      runtime: 'claude',
      desc: 'Triages incidents from on-call alerts.',
      outputMode: 'high',
      showFooter: true,
      showStatusBar: false,
      reasoning: 'high',
      fastMode: false,
      pause: false,
      memoryProvider: 'managed',
      memoryAutoDistill: false,
      permissionMode: 'default',
      allowRuntimeChangesInChat: false,
      env: [{ k: 'PAGERDUTY_KEY', v: 'pd_••••' }],
      secretKeys: [],
      organizationVariables: [],
      organizationSecretKeys: [],
      daemon: 'edge-2',
      daemonName: 'edge-2',
      region: 'us-east',
      repo: '—',
      workdir: '/var/agentconnect/ws/oncall-bot',
      status: 'offline',
      tokens: '0',
      cost: '$0.00',
      createdBy: 'Dana Reyes',
      createdAt: 'Feb 22, 2026',
      lastModifiedBy: 'Dana Reyes',
      lastModifiedAt: 'May 7, 2026',
      integrations: [],
      workspace: {
        mode: 'scratch',
        created: 'Mon',
        size: '1.8 MB',
        files: [
          {
            icon: 'file-text',
            name: 'notes.md',
            meta: '1.2 KB',
            tag: 'A',
            content:
              '# On-call notes\n\n- 02:14 — api latency alert, p99 1.8s\n- 02:22 — traced to slow targets.yaml lookup\n- 02:31 — mitigated, watching'
          },
          {
            icon: 'file-code',
            name: 'query.sql',
            meta: '420 B',
            tag: 'A',
            content: 'select service, p99_ms\nfrom latency_5m\nwhere p99_ms > 1000\norder by p99_ms desc;'
          }
        ]
      }
    },
    {
      id: 'docs',
      visibility: 'org',
      sharedWith: [],
      canEdit: true,
      canManageSharing: true,
      callPolicy: 'selected',
      allowedCallerAgentIds: ['deploy', 'review'],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: ['review'],
      introduceOnJoin: false,
      runInSandbox: false,
      sandboxSupported: true,
      sandboxRequired: false,
      name: 'docs-bot',
      model: 'opencode',
      runtime: 'opencode',
      desc: 'Answers product questions and drafts docs.',
      outputMode: 'low',
      showFooter: true,
      showStatusBar: false,
      reasoning: 'off',
      fastMode: false,
      pause: false,
      memoryProvider: 'managed',
      memoryAutoDistill: false,
      permissionMode: 'default',
      allowRuntimeChangesInChat: false,
      env: [{ k: 'NOTION_TOKEN', v: 'secret_••••' }],
      secretKeys: ['SLACK_SIGNING_SECRET'],
      organizationVariables: [],
      organizationSecretKeys: [],
      daemon: 'edge-1',
      daemonName: 'edge-1',
      region: 'us-west',
      repo: 'acme/docs',
      workdir: './',
      status: 'paused',
      tokens: '92K',
      cost: '$1.40',
      createdBy: 'Ana Kim',
      createdAt: 'Apr 1, 2026',
      lastModifiedBy: 'Ana Kim',
      lastModifiedAt: 'Jun 12, 2026',
      integrations: [{ platform: 'telegram', name: 'acme-docs-bot', channel: '@acme_docs', workMode: '@-mention' }],
      workspace: {
        mode: 'git',
        provider: 'github',
        gitRepo: 'https://github.com/acme/docs',
        repo: 'acme/docs',
        branch: 'main',
        agentDir: './',
        lastPull: 'Mon',
        commit: 'a17b3e9',
        commitMsg: 'refresh cache-flush runbook',
        commitTime: '2d ago',
        clean: false,
        files: [
          {
            icon: 'folder',
            name: 'docs/runbooks',
            meta: '12 files',
            children: [
              {
                icon: 'file-text',
                name: 'cache.md',
                meta: '3.0 KB',
                tag: 'M',
                content:
                  '# Cache flush runbook\n\n1. Drain traffic from the node.\n2. Run `acme cache flush --scope=region`.\n3. Verify hit-rate recovers above 90%.\n4. Restore traffic.\n\nRollback: re-warm from the last snapshot.'
              }
            ]
          },
          {
            icon: 'file-text',
            name: 'README.md',
            meta: '2.8 KB',
            content:
              '# acme/docs\n\nProduct docs and runbooks. docs-bot keeps the\ncache-flush runbook and FAQ in sync.'
          }
        ]
      }
    }
  ] satisfies Agent[]
).map(tagName)

export function getAgent(id: string): Agent {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[0]!
}

// Mock sessions author steps without a stream turnId; the transform below mints one so demo data
// satisfies the `SessionStep.turnId` invariant exactly as `stampStep` does for live steps.
type MockStep = Omit<SessionStep, 'turnId'> & { turnId?: string }
type MockSession = Omit<Session, 'steps'> & { steps: MockStep[] }
const RAW_SESSIONS_BY_AGENT: Record<string, MockSession[]> = {
  deploy: [
    {
      id: 'd1',
      title: 'Roll out api@1.4.2 to prod',
      time: '2:14 PM',
      status: 'online',
      platform: 'slack',
      channel: '#deploys',
      channelId: 'C-deploys',
      threadUrl: 'https://acme.slack.com/archives/C-deploys/p1710799200123456',
      user: '@dana',
      duration: '3m 12s',
      tokens: '4.8K',
      cost: '$0.58',
      toolCount: '9',
      statusLabel: 'completed',
      steps: [
        { kind: 'msg', who: '@dana', text: '@deploy-bot roll out api@1.4.2 to prod' },
        { kind: 'plan', text: 'Planned 4 steps — pull main, run migrations, deploy, smoke test.' },
        {
          kind: 'tool',
          text: 'bash · git pull origin main',
          code: 'Already up to date. HEAD now at 9f2c1a4 — "bump api to 1.4.2"'
        },
        { kind: 'tool', text: 'bash · ./scripts/migrate.sh', code: '✓ 3 migrations applied in 412ms' },
        { kind: 'msg', who: '@sam', text: 'hold on — did the migration touch the orders table? @deploy-bot' },
        { kind: 'plan', text: 'Checked the migration set — orders table untouched; safe to continue.' },
        {
          kind: 'edit',
          text: 'edit · bumped version and changelog',
          files: [
            { tag: 'M', path: 'services/api/package.json' },
            { tag: 'M', path: 'CHANGELOG.md' }
          ]
        },
        {
          kind: 'tool',
          text: 'bash · kubectl rollout restart deploy/api',
          code: 'deployment "api" successfully rolled out'
        },
        {
          kind: 'done',
          text: 'Deploy complete — all smoke tests passed in 3m 12s. @sam orders table was not affected.'
        }
      ]
    },
    {
      id: 'd2',
      title: 'Why did the 2pm deploy fail?',
      time: '1:58 PM',
      status: 'online',
      platform: 'slack',
      channel: '#deploys',
      user: '@dana',
      duration: '48s',
      tokens: '1.2K',
      cost: '$0.14',
      toolCount: '3',
      statusLabel: 'completed',
      steps: [
        { kind: 'msg', text: '@deploy-bot why did the 2pm deploy fail?' },
        {
          kind: 'tool',
          text: 'bash · kubectl logs deploy/api --since=20m',
          code: 'Error: migration 0042 timed out waiting for lock'
        },
        { kind: 'done', text: "The 2pm deploy failed on migration 0042 — a lock timeout. Retried and it's green now." }
      ]
    },
    {
      id: 'd3',
      title: 'Rollback checkout to last good',
      time: '11:02 AM',
      status: 'online',
      platform: 'discord',
      channel: '#ops',
      user: '@sam',
      duration: '1m 04s',
      tokens: '2.1K',
      cost: '$0.26',
      toolCount: '5',
      statusLabel: 'completed',
      steps: [
        { kind: 'msg', text: '@deploy-bot rollback checkout to the last good build' },
        { kind: 'plan', text: 'Identify last green build, then roll the deployment back to it.' },
        {
          kind: 'tool',
          text: 'bash · kubectl rollout undo deploy/checkout',
          code: 'rolled back to revision 87 (build 3f9a1c)'
        },
        { kind: 'done', text: 'Rolled checkout back to build 3f9a1c. Health checks passing.' }
      ]
    },
    {
      id: 'd4',
      title: 'Scale workers for the sale',
      time: 'Yesterday',
      status: 'paused',
      platform: 'slack',
      channel: '#deploys',
      user: '@dana',
      duration: '22s',
      tokens: '640',
      cost: '$0.08',
      toolCount: '1',
      statusLabel: 'awaiting approval',
      steps: [
        { kind: 'msg', text: '@deploy-bot scale workers to 12 for the flash sale' },
        { kind: 'plan', text: 'Scaling production workers needs an approval — paused for a maintainer.' }
      ]
    }
  ],
  review: [
    {
      id: 'r1',
      title: 'Review PR #1284 — auth refactor',
      time: '3:31 PM',
      status: 'online',
      platform: 'slack',
      channel: '#pull-requests',
      user: '@lee',
      duration: '1m 51s',
      tokens: '3.1K',
      cost: '$0.37',
      toolCount: '6',
      statusLabel: 'completed',
      steps: [
        { kind: 'msg', text: '@review-bot take a look at PR #1284' },
        { kind: 'tool', text: 'git · fetch + diff origin/pr-1284', code: '14 files changed, +402 −118' },
        {
          kind: 'edit',
          text: 'left 3 inline comments',
          files: [
            { tag: 'C', path: 'src/auth/session.ts' },
            { tag: 'C', path: 'src/auth/token.ts' }
          ]
        },
        { kind: 'done', text: 'Reviewed — LGTM with two nits on error handling. Comments posted to the PR.' }
      ]
    },
    {
      id: 'r2',
      title: 'Is the flaky test fixed?',
      time: '2:05 PM',
      status: 'online',
      platform: 'slack',
      channel: '#pull-requests',
      user: '@lee',
      duration: '39s',
      tokens: '880',
      cost: '$0.10',
      toolCount: '2',
      statusLabel: 'completed',
      steps: [
        { kind: 'msg', text: '@review-bot is the flaky checkout test fixed on main?' },
        { kind: 'tool', text: 'bash · run checkout.spec.ts x20', code: '20/20 passed (no flakes)' },
        { kind: 'done', text: 'Ran it 20 times on main — all green. The retry shim did the trick.' }
      ]
    },
    {
      id: 'r3',
      title: 'Summarize the review queue',
      time: '1:12 PM',
      status: 'online',
      platform: 'slack',
      channel: '#pull-requests',
      user: '@dana',
      duration: '27s',
      tokens: '740',
      cost: '$0.09',
      toolCount: '1',
      statusLabel: 'completed',
      steps: [
        { kind: 'msg', text: '@review-bot what is still waiting on review?' },
        { kind: 'tool', text: 'gh · pr list --search "review:required"', code: '4 open pull requests' },
        { kind: 'done', text: 'Four PRs are waiting — #1284, #1291, #1293 and #1298. Two are older than a day.' }
      ]
    },
    {
      id: 'r4',
      title: 'Backport the auth fix to 1.3',
      time: 'Yesterday',
      status: 'online',
      platform: 'telegram',
      channel: '@acme_reviews',
      user: '@sam',
      duration: '1m 12s',
      tokens: '1.9K',
      cost: '$0.22',
      toolCount: '4',
      statusLabel: 'completed',
      steps: [
        { kind: 'msg', text: '@review-bot backport the auth fix to release/1.3' },
        { kind: 'tool', text: 'git · cherry-pick 9f2c1ab', code: '1 file changed, +18 −4' },
        { kind: 'done', text: 'Backported to release/1.3 and opened PR #1301 with the cherry-picked commit.' }
      ]
    }
  ],
  docs: [
    {
      id: 'k1',
      title: 'Update the runbook for cache flush',
      time: 'Mon',
      status: 'paused',
      platform: 'telegram',
      channel: '@acme_docs',
      user: '@ana',
      duration: '57s',
      tokens: '1K',
      cost: '$0.12',
      toolCount: '2',
      statusLabel: 'completed',
      steps: [
        { kind: 'msg', text: '/edit update the cache-flush runbook with the new CLI' },
        { kind: 'edit', text: 'edit · refreshed runbook', files: [{ tag: 'M', path: 'docs/runbooks/cache.md' }] },
        { kind: 'done', text: 'Runbook updated with the new flush command and a rollback note.' }
      ]
    }
  ]
}

const mintStepTurnIds = (s: MockSession): Session => {
  // One turnId per LOGICAL turn, not per step: a `msg` opens a new turn and the agent's following
  // plan/tool/edit/done steps carry it, so an answer groups as ONE bot turn (the session-detail
  // builder folds bot output by turnId via liveBotTurnKey). This mirrors a real webchat turn, whose
  // reply steps all share the one wire turnId.
  let turnId = `mock:${randomUuid()}`
  return {
    ...s,
    steps: s.steps.map((step) => {
      if (step.turnId !== undefined) return step as SessionStep
      if (step.kind === 'msg') turnId = `mock:${randomUuid()}`
      return { ...step, turnId }
    })
  }
}
const SESSIONS_BY_AGENT: Record<string, Session[]> = Object.fromEntries(
  Object.entries(RAW_SESSIONS_BY_AGENT).map(([id, list]) => [id, list.map((s) => tagTitle(mintStepTurnIds(s)))])
)

export function getSessions(agentId: string): Session[] {
  return SESSIONS_BY_AGENT[agentId] ?? []
}

/** One conversation the integration's bot is in + how it activates there. */
export interface IntegrationChannelRow {
  channelId: string
  /** Bare channel name, no hash (e.g. "deploys"); the UI renders the leading "#".
   *  For a DM row (kind 'im') the counterpart's name. Falls back to the raw id. */
  name: string
  /** The Discord server this channel belongs to. One bot spans several servers, each
   *  with its own "#general", so the rows are grouped under it. `spaceId` is the
   *  identity — Discord permits two servers to share a NAME, so grouping on the label
   *  would merge them — and `space` is that label. Absent on platforms with one
   *  implicit container per bot, on DM rows, and until the daemon resolves them. */
  spaceId?: string
  space?: string
  /** 'im' = a DM conversation row, 'mpim' = a Slack group DM; absent = channel. */
  kind?: 'channel' | 'im' | 'mpim'
  trigger: 'off' | 'mention' | 'any'
  /** Effective per-conversation owner for a shared bot. */
  agentId?: string | null
}

/** A direct conversation — a DM or a Slack group DM. Neither is a place the bot can be
 *  invited to, so neither is ever enumerated: they are listed apart from channels and
 *  only appear once observed. A group DM still holds several humans, so unlike a DM it
 *  keeps a channel's @-mention trigger rather than a binary on/off. */
export function isDirectConversation(kind: IntegrationChannelRow['kind']): boolean {
  return kind === 'im' || kind === 'mpim'
}

export interface IntegrationRow {
  /** Integration id (present on live rows; absent on demo rows). Needed to delete. */
  id?: string
  /** Owning agent (present on live rows; absent on demo rows). Filters the per-agent panel. */
  agentId?: string
  /** The bot's identity id — needed to toggle sharing / find sibling installs. */
  botId?: string
  /** Whether the backing bot is shared (may serve many agents; per-conversation defaults apply). */
  shareable?: boolean
  /** Discord application (client) id from the backing bot — builds the "Add to Discord" invite URL. Null/absent for non-Discord or when unknown. */
  discordAppId?: string | null
  /** Feishu-family gateway identity. Lark and Feishu integrations remain separate rows even though they share the wire platform key. */
  region?: 'feishu' | 'lark'
  name: string
  platform: string
  kind: string
  workspace: string
  daemon: string
  status: StatusKey
  agentCount: string
  channels: IntegrationChannelRow[]
}

export const INTEGRATIONS: IntegrationRow[] = (
  [
    {
      name: 'slackconnect',
      platform: 'slack',
      kind: 'Shared bot',
      workspace: 'acme.slack.com',
      daemon: 'edge-1',
      status: 'online',
      agentCount: '3',
      channels: [
        { channelId: 'C-deploys', name: 'deploys', trigger: 'mention' },
        { channelId: 'C-pull-requests', name: 'pull-requests', trigger: 'mention' },
        { channelId: 'C-alerts', name: 'alerts', trigger: 'any' }
      ]
    },
    {
      name: 'acme-ops',
      platform: 'discord',
      kind: 'Custom app',
      workspace: 'acme guild',
      daemon: 'edge-1',
      status: 'online',
      agentCount: '1',
      discordAppId: '900000000000000001',
      channels: [
        { channelId: 'C-ops', name: 'ops', trigger: 'mention' },
        { channelId: 'C-incidents', name: 'incidents', trigger: 'mention' }
      ]
    },
    {
      name: 'acme-docs-bot',
      platform: 'telegram',
      kind: 'Custom app',
      workspace: '@acme_docs',
      daemon: 'edge-1',
      status: 'online',
      agentCount: '1',
      channels: [{ channelId: 'acme_docs', name: 'acme_docs', trigger: 'mention' }]
    }
  ] satisfies IntegrationRow[]
).map(tagName)

/** Daemon-wide capabilities the daemon uploads on connect (protocol register frame). */
export interface DaemonCaps {
  platforms: string[]
  runtimes: string[]
  acp: boolean
  features: string[]
}

/** One daemon-configured MCP server (protocol `FactsMcpServer`) — name +
 *  transport, derived from daemon config (not probed). */
export interface McpServerInfo {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  /** True when this row is a synthesized candidate from the org MCP-provider
   *  registry (not a daemon-configured server) — enable-able before the daemon
   *  reports it; the CP pushes the proxy def on enable. */
  registry?: boolean
}

/** A CP-commanded daemon restart/upgrade (cli-daemon-split.md §7) — structurally the
 *  wire `DaemonLifecycleOpDto`, defined here to keep data.ts free of an api.ts import. */
export interface DaemonLifecycleOp {
  id: string
  op: 'restart' | 'upgrade'
  status: 'pending' | 'succeeded' | 'failed'
  targetVersion: string | null
  outcome: string | null
}

export interface DaemonRow {
  /** Stable CP id — the rename target and the AddDaemon "connected?" match key. */
  daemonId: string
  /** Display label: human-assigned name, else hostname, else a short id. */
  name: string
  version: string
  /** Latest daemon version published in the deployment's release channel; null when
   *  unresolved (npm unreachable / cold start). Drives the "update available" hint. */
  latestVersion: string | null
  /** The deployment's daemon release channel (npm dist-tag, e.g. `latest`/`rc`). */
  releaseChannel: string
  /** True when `latestVersion` is a strictly newer release than `version`. */
  upgradeAvailable: boolean
  /** Every published dist-tag version (the upgrade picker's options), newest-first. */
  availableVersions: string[]
  /** The most recent CP-commanded restart/upgrade op (cli-daemon-split.md §7), or null.
   *  `status` is expiry-projected server-side; the modal tracks its own command by `id`
   *  and the daemon views derive the in-flight badge from `status === 'pending'`. */
  lifecycleOp: DaemonLifecycleOp | null
  /** Whether the caller may command restart/upgrade on this daemon (org owner only). */
  canManageLifecycle: boolean
  /** Actual daemon connection/readiness. Never replaced by a presentation-only lifecycle state. */
  status: ConnectionStatusKey
  /** An install-wide pool member: managed infrastructure every org shares, one row per
   *  pool member Pod. The daemons page collapses the whole pool into one Cloud entry, and
   *  nothing here is the org's to rename, restart, or detach (`canEdit` is false). */
  pool: boolean
  /** The member set this daemon is in (daemon-groups.md §2), or null when it owns its agents
   *  outright. A pool member is always in the org-less one; a group member is in one of the org's.
   *  A daemon in a set is not a placement target — its agents are placed on the set instead. */
  memberSetId: string | null
  /** Planned lifecycle presentation while the durable operation is pending. */
  lifecycleStatus: LifecycleStatusKey | null
  host: string
  cpu: number // 0-100 CPU utilization
  mem: number // 0-100 memory utilization
  /** Agents this daemon is currently running — the numerator the CP's own placement check
   *  compares against `conns` (its `maxAgents` ceiling). 0 until it reports load. */
  loadAgents: number
  caps: DaemonCaps
  /** Available models per runtime, observed from the daemon's runtime profiles.
   *  `version` is the runtime's own release (e.g. claude-agent-acp 0.54.1), '' when
   *  unreported; `acpProtocolVersion` is the ACP protocol version negotiated at
   *  initialize; `mcpCapabilities` is the MCP transport support advertised there —
   *  null ⇒ not probed (older daemon) ⇒ assume stdio-only. */
  runtimeModels: {
    runtime: string
    version: string
    models: string[]
    acpProtocolVersion?: number | null
    mcpCapabilities?: { http: boolean; sse: boolean } | null
    /** Discovered model × config capability matrix; null/absent ⇒ not yet
     *  discovered (older daemon) ⇒ the static tables drive the config controls. */
    modelCatalog?: RuntimeModelCatalog | null
    /** The daemon's last probe was rejected with the ACP auth-required error:
     *  the runtime needs a login on the daemon host (drives the warning strip
     *  on the daemon detail page). Absent ⇒ no warning. */
    authRequired?: boolean
  }[]
  /** Daemon-configured MCP servers (name + transport, facts/daemon-runtimes). */
  mcpServers: McpServerInfo[]
  /** Active session count — NOT the hosted-agent count (derive that by filtering the agents list by daemon). */
  activeSessions: string
  conns: string
  uptime: string
  /** Creator's userId — resolved to a name / "You" at render via creatorLabel; '' for CLI/self-registered. */
  createdBy: string
  createdAt: string
  /** Last editor's userId — resolved to a name / "You" at render via creatorLabel; '' for CLI/self-registered. */
  lastModifiedBy: string
  lastModifiedAt: string
  /** How long the daemon keeps finished sessions before deleting them ("Expire
   *  sessions"); 'never' disables the retention sweep. */
  sessionRetention: DaemonSessionRetention
  /** 'org' = visible to all members; 'restricted' = the complete sharedWith audience. */
  visibility: ResourceVisibility
  /** Complete app_user.id audience when restricted. */
  sharedWith: string[]
  /** Whether the caller may change non-sharing daemon settings. */
  canEdit: boolean
  /** Whether the caller may change this daemon's sharing. */
  canManageSharing: boolean
}

export interface Member {
  initials: string
  name: string
  email: string
  role: string
  access: string
  avBg: string
  avText: string
  roleBg: string
  roleText: string
}

export const MEMBERS: Member[] = [
  {
    initials: 'DR',
    name: 'Dana Reyes',
    email: 'dana@acme.dev',
    role: 'Admin',
    access: 'All daemons',
    avBg: 'var(--magenta-100)',
    avText: 'var(--magenta-700)',
    roleBg: 'var(--brand-soft)',
    roleText: 'var(--brand-soft-text)'
  },
  {
    initials: 'SL',
    name: 'Sam Lin',
    email: 'sam@acme.dev',
    role: 'Collaborator',
    access: 'edge-1, edge-2',
    avBg: 'var(--gray-100)',
    avText: 'var(--text-secondary)',
    roleBg: 'var(--surface-active)',
    roleText: 'var(--text-secondary)'
  },
  {
    initials: 'AK',
    name: 'Ana Kim',
    email: 'ana@acme.dev',
    role: 'Viewer',
    access: 'Read-only',
    avBg: 'var(--gray-100)',
    avText: 'var(--text-secondary)',
    roleBg: 'var(--surface-active)',
    roleText: 'var(--text-secondary)'
  }
].map(tagName)

/**
 * A platform's display name.
 *
 * The CORE kinds are matched by SUBSTRING because their ids are synthesized in
 * several places (`sessionPlatform` folds playground→webchat and hook+code-host→
 * that host; `sessionChannelDisplay` mints `schedule`); order is load-bearing, since
 * `hook` must be tested before `web` or `webhook` would read as "Playground".
 * The four CHAT platforms are an exact-id lookup into the one shared label table
 * (`lib/platform-labels.ts`) — their ids come off the wire, where the vocabulary
 * is closed, and the chain that used to live here was one of three copies.
 */
export function platName(p: string): string {
  const x = (p || '').toLowerCase()
  if (x.includes('sched')) return 'Schedule'
  if (x.includes('github')) return 'GitHub'
  if (x.includes('gitlab')) return 'GitLab'
  if (x.includes('dream')) return 'Memory dream'
  if (x.includes('hook')) return 'Webhook'
  // 'playground' (live sandbox) and 'webchat' (its persisted CP session) are the same
  // surface to a user — label both "Playground".
  if (x.includes('play') || x.includes('web')) return 'Playground'
  const chat = platformLabel(x)
  if (chat) return chat.name
  // A missing platform means Slack — the legacy fold predating the platform axis.
  if (x === '') return 'Slack'
  // Unknown platform ids render as themselves — falling back to 'Slack' was the
  // web mirror of the daemon's deleted narrowPlatform fold (S1a §6.3).
  return p.charAt(0).toUpperCase() + p.slice(1)
}

/** A session's display integration. Code hosts are hook sources rather than routing
 * Platforms, so the CP supplies the stable hook kind explicitly — without it a GitLab
 * session renders as a generic webhook. The promotion asks the shared vocabulary which
 * kinds are code hosts instead of listing them, so no future host can miss it. */
export function sessionPlatform(s: { platform: string; hookKind?: HookKind }): string {
  if (s.platform === 'playground') return 'webchat'
  if (s.platform !== 'hook') return s.platform
  return s.hookKind && isCodeHostHookKind(s.hookKind) ? s.hookKind : s.platform
}

/** Channel-cell identity (mark + label) for a session row. A headless schedule
 * fire has no real channel — the daemon keys it `cron:<scheduleId>` on the
 * legacy 'slack' platform — so resolve it to the schedule's name under a
 * schedule mark instead of a raw uuid with a Slack icon. `cronName` looks up
 * the schedule (the crons list may still be loading → short-id fallback). */
export function sessionChannelDisplay(
  s: { platform: string; channel: string; hookKind?: HookKind },
  cronName: (id: string) => string | null | undefined
): { platform: string; label: string } {
  if (s.channel.startsWith('cron:')) {
    const id = s.channel.slice('cron:'.length)
    return { platform: 'schedule', label: cronName(id)?.trim() || `Schedule ${id.slice(0, 8)}` }
  }
  return { platform: sessionPlatform(s), label: s.channel }
}

/** Playground conversations have unique internal ids but share one user-facing
 * channel filter. Other integrations keep filtering by their concrete channel id. */
export const PLAYGROUND_CHANNEL_FILTER = 'webchat'

export function sessionChannelFilterValue(s: {
  platform: string
  channel: string
  channelId?: string
  hookKind?: HookKind
}): string {
  return sessionPlatform(s) === 'webchat' ? PLAYGROUND_CHANNEL_FILTER : (s.channelId ?? s.channel)
}

export interface Speaker {
  name: string
  handle: string
  initials: string
  avBg: string
  avText: string
}

/** Speaker display card. `name` is the daemon-resolved display name when known;
 *  without one the handle/id itself is shown ('@you' is the playground user). */
export function speaker(handle: string, name?: string): Speaker {
  const isYou = handle === '@you'
  const display = name ?? (isYou ? 'You' : (handle || '@user').replace('@', ''))
  const avBg = isYou ? 'var(--magenta-100)' : 'var(--gray-100)'
  const avText = isYou ? 'var(--magenta-700)' : 'var(--text-secondary)'
  const initials = display
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  return { name: display, handle, initials, avBg, avText }
}

/** Is `sender` the signed-in viewer? Live Playground steps use the canonical local
 *  `@you` marker before a durable webchat sender id exists. Persisted webchat rows record
 *  the CP principal (`userId`); rows written between #912 and the fix that restored the
 *  principal instead hold the viewer's DISPLAY NAME, so that is accepted as a last resort
 *  to keep those sessions readable. Slack/Telegram/Discord senders are platform ids and
 *  never match any of the three. `me` is typed structurally to avoid an api ↔ data import
 *  cycle.
 *
 *  The display-name arm is deliberately last: a name is not an identity, so two members
 *  sharing one — or a member renaming themselves to another's name — would read that
 *  person's old rows as "You". Never reorder it ahead of the id/email match, and never
 *  extend it to an authorization decision; this is a presentation-only affordance for
 *  rows already written with the wrong key. */
export function isSelfSender(
  sender: string | null | undefined,
  me: { userId: string; email: string | null; name?: string | null } | null | undefined
): boolean {
  if (sender === '@you') return true
  if (!sender || !me) return false
  if (sender === me.userId || (!!me.email && sender === me.email)) return true
  return !!me.name && sender === me.name
}

// playground suggested prompts (the canned-reply mock is gone — replies now
// stream from the real agent over the webchat socket).
const PG_PROMPTS: Record<string, string[]> = {
  deploy: ['Roll out api@1.4.2 to prod', 'Why did the 2pm deploy fail?', 'Rollback checkout to last good'],
  review: ['Review PR #1284', 'Is the flaky checkout test fixed?'],
  oncall: ['Any active incidents?', "Summarize last night's alerts"],
  docs: ['Update the cache-flush runbook', 'List stale docs']
}

export function pgPrompts(agentId: string): string[] {
  return PG_PROMPTS[agentId] ?? ['Say hello']
}

export interface ApiEvent {
  name: string
  desc: string
}

export const API_EVENTS: ApiEvent[] = [
  { name: 'ready', desc: 'Socket accepted — carries the conversationId the CP allocated.' },
  { name: 'ack', desc: 'Your message was delivered to the agent — carries a turnId.' },
  { name: 'output', desc: 'A reply chunk: output.event is message / thinking / tool_call / tool_update.' },
  { name: 'done', desc: 'Turn finished — done.stopReason and done.usage (tokens / cost).' },
  { name: 'error', desc: 'Delivery failed — e.g. the agent has no live daemon.' }
]
