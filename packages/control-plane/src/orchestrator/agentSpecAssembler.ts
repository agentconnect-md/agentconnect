/**
 * `AgentSpecAssembler` — the ONE place a wire {@link AgentSpec} is assembled
 * from a C6 agent definition (docs/designs/secret-store-seams.md §5).
 *
 * Every CP→daemon spec emission goes through this class: the `register/ok`
 * reconcile roster, the live `agent/upsert` REST emit, the icon-refresh
 * replicate, and the agent-move `agent/activate` definition. Centralizing the
 * assembly makes secret loading structural — a new emission path CANNOT ship a
 * spec that silently omits the agent's write-only secrets, because the only
 * ways to get a spec are `assemble` (which fetches them from the
 * {@link AgentSecretStore} seam) and `project` (which demands them as an
 * argument, for the move path's snapshot-pinned bundle).
 *
 * The instance also owns the icon URL bases, so the four call sites stop
 * re-deriving `{cp, store}` from config independently.
 */
import {
  GitCloneUrlError,
  normalizeGitCloneUrl,
  normalizeGithubRepoUrl,
  redactGitUrlSecrets,
  type AgentSkillEntry,
  type ManagedSkillEntry,
  type AgentSpec
} from '@agentconnect.md/protocol'
import type { AgentRecord, AgentSecretStore, OrganizationKnowledgeRepo, SkillSourceRepo } from '../persistence/ports.js'
import { resolveAgentIconUrl, type IconUrlBases } from '../agents/agent-icon.js'
import { resolveAgentSkillEntries } from './skillSource.js'

/** The wire spec plus the id it is keyed by on `agent/upsert` / the roster. */
export type AssembledAgentSpec = AgentSpec & { agentId: string }

export class AgentSpecAssembler {
  constructor(
    private readonly secrets: AgentSecretStore,
    private readonly iconBases: IconUrlBases = {},
    // Optional: resolves the agent's skill enable-list into self-contained
    // AgentSpec.skills entries. Absent (some tests / minimal graphs) ⇒ no skills.
    private readonly skillSources?: SkillSourceRepo,
    // Optional for older/minimal test graphs. Production resolves explicitly
    // enabled centrally-managed skill ids into immutable revision metadata.
    private readonly organizationKnowledge?: OrganizationKnowledgeRepo
  ) {}

  /** Fetch the agent's secret values + resolve its skills, then project the spec. */
  async assemble(a: AgentRecord): Promise<AssembledAgentSpec> {
    const [secrets, skillEntries, managedSkillEntries] = await Promise.all([
      this.secrets.get(a.id),
      resolveAgentSkillEntries(a, this.skillSources),
      this.managedSkillsOf(a)
    ])
    return this.project(a, secrets, skillEntries, managedSkillEntries)
  }

  /** Batch form for the reconcile roster (one store read per owned agent).
   * Historical unsafe clone targets are quarantined individually; every other
   * failure still rejects the roster so infrastructure errors remain visible. */
  async assembleAll(
    agents: readonly AgentRecord[],
    onUnsafeAgent?: (agent: AgentRecord, error: GitCloneUrlError) => void
  ): Promise<AssembledAgentSpec[]> {
    const settled = await Promise.allSettled(agents.map((a) => this.assemble(a)))
    const assembled: AssembledAgentSpec[] = []
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        assembled.push(result.value)
      } else if (result.reason instanceof GitCloneUrlError) {
        onUnsafeAgent?.(agents[index]!, result.reason)
      } else {
        throw result.reason
      }
    }
    return assembled
  }

  /** The store read the agent-move snapshot pins into its {@link MoveBundle} —
   *  exposed here so move code needs no separate secrets dependency. */
  secretsOf(a: Pick<AgentRecord, 'id'>): Promise<Record<string, string>> {
    return this.secrets.get(a.id)
  }

  /** Resolve the agent's skill entries — pinned into the move {@link MoveBundle} so
   *  the authoritative `agent/activate` path ships them (a bare `project` would
   *  default to [], which `writeAgentSpec` reads as "clear", wiping skills on move). */
  skillsOf(a: Pick<AgentRecord, 'orgId' | 'skills'>): Promise<AgentSkillEntry[]> {
    return resolveAgentSkillEntries(a, this.skillSources)
  }

  /** Resolve enabled managed-skill ids into the exact immutable revisions the
   * daemon must fetch. Missing/archived/foreign ids are omitted defensively; the
   * HTTP write path rejects them, while this keeps legacy rows from breaking a
   * daemon's entire reconcile roster. */
  async managedSkillsOf(a: Pick<AgentRecord, 'orgId' | 'managedSkills'>): Promise<ManagedSkillEntry[]> {
    if (!this.organizationKnowledge || a.managedSkills.length === 0) return []
    const rows = await Promise.all(a.managedSkills.map((id) => this.organizationKnowledge!.getManagedSkill(id)))
    return rows.flatMap((row) =>
      row !== null && row.orgId === a.orgId && row.archivedAt === null
        ? [
            {
              id: row.id,
              name: row.name,
              revision: row.currentRevision,
              digest: row.digest
            }
          ]
        : []
    )
  }

  /**
   * Pure projection over ALREADY-FETCHED secrets. The agent-move path calls this
   * with its snapshotted `MoveBundle.secrets` so the activation fingerprint
   * compares stable inputs; everything else should prefer {@link assemble}.
   *
   * `skillEntries` is REQUIRED (not defaulted): the move/activation path is
   * authoritative and `writeAgentSpec` reads an omitted skills list as "clear", so
   * a silent default would wipe skills on every move/workspace edit. The move bundle
   * snapshots the resolved entries and passes them here; callers with none pass [].
   */
  project(
    a: AgentRecord,
    secrets: Record<string, string>,
    skillEntries: AgentSkillEntry[],
    managedSkillEntries: ManagedSkillEntry[] = []
  ): AssembledAgentSpec {
    return agentRecordToSpec(a, secrets, this.iconBases, skillEntries, managedSkillEntries)
  }
}

/**
 * Map a C6 agent definition to the wire {@link AgentSpec} (+ `agentId`) the daemon
 * replicates locally. `description` IS the system-prompt seed; `model` is flattened
 * out of `runtimeOverrides`. Exported for unit tests — production code reaches it
 * only through {@link AgentSpecAssembler}, which owns secret loading. `secrets`
 * comes from the AgentSecretStore seam (the record deliberately never carries
 * values) and rides the spec like env.
 */
export function agentRecordToSpec(
  a: AgentRecord,
  secrets: Record<string, string>,
  iconBases?: IconUrlBases,
  skillEntries: AgentSkillEntry[] = [],
  managedSkillEntries: ManagedSkillEntry[] = []
): AssembledAgentSpec {
  // Domain AgentWorkspace uses `gitBranch`; the wire AgentWorkspace uses `branch`.
  // App-backed GitHub workspaces have one implicit repo. Scratch workspaces have
  // no implicit repo, but still use the helper for explicit per-agent repo
  // grants. Installation resolution and the allowlist both stay CP-side.
  const workspace: AgentSpec['workspace'] =
    a.workspace.mode === 'github'
      ? {
          mode: 'github',
          // Defense in depth for historical/non-Prisma records: never send
          // credentials or an unsupported transport to any daemon version.
          gitRepo:
            a.workspace.installationId !== undefined
              ? normalizeGithubRepoUrl(a.workspace.gitRepo)
              : normalizeGitCloneUrl(redactGitUrlSecrets(a.workspace.gitRepo)),
          branch: a.workspace.gitBranch ?? 'main',
          ...(a.workspace.agentDir !== undefined ? { agentDir: a.workspace.agentDir } : {}),
          ...(a.workspace.installationId !== undefined ? { gitCredential: 'github-app' as const } : {})
        }
      : { mode: 'scratch', gitCredential: 'github-app' }
  return {
    agentId: a.id,
    name: a.name,
    // Always ship value or null: explicit null clears a previously replicated
    // daemon-local display name, while an absent wire key means "leave unchanged".
    displayName: a.displayName,
    // Public avatar URL for the Slack per-message icon (sibling of displayName→
    // username). Always ship value or null so clearing/switching the icon (or a
    // deploy with no PUBLIC_CP_URL) replicates as a cleared override. Cache-busted
    // by lastModified so a re-picked glyph/color refetches on Slack's side.
    iconUrl: resolveAgentIconUrl(a.id, a.icon, iconBases ?? {}, a.lastModifiedAt.getTime()),
    // Specs are only assembled for PLACED agents, and placement requires a runtime
    // (preset-agents.md §3.2) — the null→undefined map is a type-level formality.
    runtime: a.runtime ?? undefined,
    // Always ship a string: a cleared description (null in the DB) replicates as ""
    // so the daemon overwrites a stale value rather than seeing an absent key ("leave
    // unchanged"). Uses "" not null as the empty sentinel because older daemons parse
    // description as a non-nullable string and would reject a null register/ok entry,
    // failing the whole handshake. An empty prompt seed == "no description", lossless.
    description: a.description ?? '',
    // Always shipped (value or null): these are per-runtime override vocabularies, so
    // a runtime switch resets them to default. The daemon merge treats an absent key as
    // "leave alone", so a cleared override (null) must replicate as an explicit null —
    // otherwise the stale value from the previous runtime survives in agent.json. Same
    // rationale as env/mcpServers below.
    model: a.model,
    reasoningEffort: a.reasoningEffort,
    permissionMode: a.permissionMode,
    showFooter: a.showFooter,
    allowRuntimeChangesInChat: a.allowRuntimeChangesInChat,
    // Guarded (not just non-null): the wire field is an enum, and outputMode is a
    // plain string in the runtimeOverrides JSON — never let a stray value kill the frame.
    ...(a.outputMode === 'none' ||
    a.outputMode === 'minimal' ||
    a.outputMode === 'low' ||
    a.outputMode === 'medium' ||
    a.outputMode === 'high'
      ? { outputMode: a.outputMode }
      : {}),
    ...(a.fastMode !== null ? { fastMode: a.fastMode } : {}),
    ...(a.pause !== null ? { pause: a.pause } : {}),
    // Always ship env (even {}): the daemon merge treats an absent key as
    // "leave alone", so removing the last variable must still replicate.
    env: a.env,
    // Write-only secrets ride the same wire as env (values are plaintext on the TLS WS,
    // never in a DTO response). Always shipped (even {}) so a removed secret replicates.
    secrets,
    // Likewise always shipped (even []) so disabling the last MCP server replicates.
    mcpServers: a.mcpServers,
    // Self-contained skill sources (shared-skills.md), resolved from the agent's
    // enable-list against the org SkillSource registry. Always shipped (even []) so
    // disabling the last skill replicates.
    skills: skillEntries,
    // Immutable centrally-managed bundle metadata. Content is fetched separately
    // in bounded chunks, keeping reconcile/upsert frames small.
    managedSkills: managedSkillEntries,
    // Agent→agent call authorization (§2.5), replicated so the owning daemon enforces
    // it locally on same-daemon `messageAgent` delivery. Always ship both (allowedCallerAgentIds
    // even []) so a policy loosen/tighten or an emptied allow-list replicates.
    callPolicy: a.callPolicy,
    allowedCallerAgentIds: a.allowedCallerAgentIds,
    // Caller-side half of the same authorization edge. Same-daemon delivery can
    // enforce it without a CP hop; [] must replicate when the final target is removed.
    outboundPolicy: a.outboundPolicy,
    allowedTargetAgentIds: a.allowedTargetAgentIds,
    // #536: self-introduce-on-join. A definite column value, always shipped so a
    // toggle replicates to the owning daemon (which applies it to agent.json).
    introduceOnJoin: a.introduceOnJoin,
    // #642: sandbox toggle. Definite column, always shipped so the daemon applies it
    // to agent.json (the daemon then decides fail-open/closed based on host support).
    restrictFileAccess: a.restrictFileAccess,
    // Ship the memory backend only when set (like pause) — a switch isn't a
    // per-runtime-vocabulary reset, so absent ⇒ the daemon leaves agent.json alone.
    ...(a.memory !== null ? { memory: a.memory } : {}),
    workspace
  }
}
