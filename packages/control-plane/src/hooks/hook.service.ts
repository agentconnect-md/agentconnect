/**
 * `HookService` — compiles `HookDef` rows into relay-side rules and keeps the
 * pool converged (webhook-triggers-and-github-events.md decision 4).
 *
 * The relay is the ingress but holds no database: every enabled, placed hook is
 * pushed as an `rc/hook-assign` rule (upsert semantics) and dropped with
 * `rc/hook-remove`. Convergence points:
 *   - hook CRUD/enable          → `broadcast(hook)` (routes call it)
 *   - agent placement change    → `rebroadcastForAgent(agentId)` (daemon delete
 *     unplaces its agents via FK SetNull — the daemons route re-converges)
 *   - relay (re)register        → `replayTo(channel)` — the relay's table is a
 *     memory copy, so a fresh connection gets the full enabled set
 *
 * A hook that cannot fire (disabled / legacy orphaned / agent unplaced)
 * compiles to null and is actively removed from the pool — a rule the relay
 * holds is always dispatchable. Compiled rules carry the hook's hmacSecret:
 * NEVER log.
 */
import { type RcHookAssign } from '@agentconnect.md/protocol'
import { advertises, requiredGitlabFeatures } from '../domain/daemon-features.js'
import type { AgentId, OrgId } from '../domain/ids.js'
import type {
  AgentRecord,
  GithubInstallationRepo,
  GitlabAgentAccountRepo,
  GitlabProjectBindingRepo,
  GitlabWebhookSecretStore,
  HookRecord,
  HookRepo,
  HookSecretStore
} from '../persistence/ports.js'
import type { RelayControlSender } from '../orchestrator/relayControl.js'
import { PLACEMENT_ONLY, type PlacementResolver } from '../orchestrator/placementResolver.js'
import type { RelayChannel } from '../ws/relay-registry.js'
import { toDbPlatform } from '../persistence/platform.js'

/** The narrow agent read the compiler needs (placement lookup). */
export interface HookAgentReads {
  getUnscoped(agentId: AgentId): Promise<AgentRecord | null>
}

export interface HookServiceLog {
  warn(obj: unknown, msg?: string): void
}

export class HookService {
  constructor(
    private readonly hooks: HookRepo,
    private readonly secrets: HookSecretStore,
    private readonly agents: HookAgentReads,
    private readonly relayControl: RelayControlSender,
    /** Names the member a compiled rule dispatches to (placement, or the current duty holder). */
    private readonly placement: Pick<PlacementResolver, 'routableDaemon'> = PLACEMENT_ONLY,
    /** github-kind compile source: the org's live installation set (the relay's
     *  runtime attribution gate, decision 6). Absent ⇒ github hooks never compile
     *  (deployment without the GitHub App). */
    private readonly installations?: Pick<GithubInstallationRepo, 'listForOrg'>,
    /** The App's slug (GITHUB_APP_SLUG) — compiled into github rules as the
     *  broadcast mention handle (P3). The agent record supplies the targeted
     *  handle. */
    private readonly appSlug?: string,
    private readonly log?: HookServiceLog,
    /** gitlab-kind compile sources (gitlab-com-integration.md §11.3): the org's
     *  managed bindings, the sealed signing keys, and the per-agent accounts.
     *  Absent ⇒ gitlab hooks never compile (deployment without the OAuth app). */
    private readonly gitlabBindings?: Pick<GitlabProjectBindingRepo, 'byProject'>,
    private readonly gitlabWebhookSecrets?: GitlabWebhookSecretStore,
    private readonly gitlabAccounts?: Pick<GitlabAgentAccountRepo, 'listForBinding'>,
    /** The deployment's normalized GitLab instance base URL (§24.1); it rides every
     *  compiled gitlab rule as the turn-time fence host. */
    private readonly gitlabHost?: string,
    /** Re-project the hook agent's spec (§24.4). An enabled gitlab hook is a GitLab consumer,
     *  so it puts `gitlabHost` on that agent's spec — and the spec is what the daemon fences a
     *  delivery against. It lives HERE rather than in the CRUD routes because a route is not
     *  the only thing that assigns a rule: the gitlab provisioning bracket commits the row and
     *  rebroadcasts from inside the write, before any route code after it runs. Best-effort. */
    private readonly projectAgentSpec?: (orgId: OrgId, agentId: AgentId) => Promise<void>
  ) {}

  /**
   * HookDef → relay rule, or null when it must not be in the pool (disabled,
   * legacy orphaned, paused, unplaced, missing kind columns, or — github kind —
   * no valid installation left to attribute events with).
   */
  async compile(hook: HookRecord): Promise<RcHookAssign | null> {
    if (!hook.enabled || !hook.agentId) return null
    const agent = await this.agents.getUnscoped(hook.agentId)
    // A paused agent rejects every fire at the daemon, so a rule left in the pool buys only a
    // dispatch that dies and, for a github hook, a Check that reports nothing anyone can act on.
    // Pause leaves the pool the same way an unplaced agent does, and resuming re-assigns it.
    if (agent?.pause === true) return null
    // The relay needs one member to address; for a pool agent that is the current duty holder,
    // since placement names none. Nothing serving it ⇒ the rule leaves the relay pool, exactly as
    // an unplaced agent's does.
    const agentDaemonId = agent ? await this.placement.routableDaemon(agent) : null
    if (!agent || !agentDaemonId) return null
    const snapshot =
      typeof hook.configRevision === 'bigint' &&
      typeof hook.dispatchRevision === 'bigint' &&
      hook.reviewPolicy !== undefined &&
      hook.reportingMode !== undefined &&
      hook.gateMode !== undefined
        ? {
            configRevision: hook.configRevision.toString(),
            dispatchRevision: hook.dispatchRevision.toString(),
            dispatchDaemonId: agentDaemonId,
            // Both code hosts carry their own effect axes; a generic webhook has none.
            reviewPolicy: hook.kind === 'webhook' ? ('off' as const) : hook.reviewPolicy,
            reportingMode: hook.kind === 'webhook' ? ('off' as const) : hook.reportingMode,
            // Only github has a gate axis; GitLab has no required-gate surface and webhooks none at all.
            gateMode: hook.kind === 'github' ? hook.gateMode : ('informational' as const)
          }
        : ({ reviewPolicy: 'off', reportingMode: 'off', gateMode: 'informational' } as const)
    const base = {
      hookId: hook.id,
      agentId: hook.agentId,
      daemonId: agentDaemonId,
      ...snapshot,
      sessionMode: hook.sessionMode,
      // Anchoring target only when a channel is set (null channel ⇒ headless);
      // platform narrowed the same way the cron wire mapping does.
      ...(hook.targetChannel
        ? {
            target: {
              platform: toDbPlatform(hook.targetPlatform),
              channel: hook.targetChannel,
              ...(hook.targetIntegrationId ? { integrationId: hook.targetIntegrationId } : {})
            }
          }
        : {})
    }
    if (hook.kind === 'webhook') {
      if (!hook.urlToken) return null
      const hmacSecret = await this.secrets.get(hook.orgId, hook.id)
      return {
        ...base,
        kind: 'webhook',
        webhook: {
          urlToken: hook.urlToken,
          ...(hmacSecret ? { hmacSecret } : {})
        }
      }
    }
    if (hook.kind === 'gitlab') {
      // gitlab (§11.3): the rule carries the hook agent's runtime identity and
      // the inline signing token. A hook without a working ingress (no webhook,
      // no signing key, no ready agent account, or entering cleanup) must leave
      // the pool — a rule the relay holds is always verifiable and dispatchable.
      if (hook.repoId === null || !this.gitlabBindings || !this.gitlabWebhookSecrets || !this.gitlabAccounts) {
        return null
      }
      const binding = await this.gitlabBindings.byProject(hook.orgId, hook.repoId)
      if (!binding || binding.state === 'cleanup_pending' || binding.webhookId === null) return null
      // §7.2: the rule names the HOOK AGENT's own account, and vetoes every
      // account bound to the project — one agent's replies never wake a sibling.
      const accounts = await this.gitlabAccounts.listForBinding(binding.id)
      const account = accounts.find((candidate) => candidate.agentId === hook.agentId)
      if (!account || account.serviceAccountUserId === null || account.state !== 'ready') return null
      const bound = accounts
        .map((candidate) => candidate.serviceAccountUserId)
        .filter((userId): userId is bigint => userId !== null)
        .map((userId) => userId.toString())
      const signingToken = await this.gitlabWebhookSecrets.get(hook.orgId, binding.id)
      if (!signingToken) return null
      return {
        ...base,
        kind: 'gitlab',
        gitlab: {
          projectId: hook.repoId.toString(),
          projectPath: binding.projectPath,
          sessionKeyPrefix: hook.githubSessionKey ?? `gitlab:${hook.repoId}`,
          events: hook.events,
          ...(hook.commentFamilies.length > 0
            ? {
                commentFamilies: hook.commentFamilies.filter(
                  (family): family is 'issues' | 'merge_request' => family !== 'pull_request'
                )
              }
            : {}),
          // Removed feature: a stored value is read tolerantly and ignored. The empty
          // array still rides the wire because a relay predating this release requires it.
          labelFilter: [],
          mentionOnly: hook.mentionOnly,
          agentName: agent.name,
          serviceAccountUserId: account.serviceAccountUserId.toString(),
          serviceAccountUsername: account.username,
          // §12.1 veto set: every managed account bound to the project.
          boundServiceAccountUserIds: [...new Set(bound)],
          signingToken,
          ...(this.gitlabHost !== undefined ? { host: this.gitlabHost } : {})
        }
      }
    }
    // github (P2): the rule carries the org's VALID installation ids — the
    // relay's runtime attribution gate. Suspended/revoked installations are
    // excluded; an empty set means no event could ever prove attribution, so
    // the rule must leave the pool (broadcast converges to hook-remove).
    if (hook.repoId === null || !hook.repoFullName || !this.installations) return null
    const valid = (await this.installations.listForOrg(hook.orgId)).filter((i) => !i.suspendedAt)
    if (valid.length === 0) return null
    return {
      ...base,
      kind: 'github',
      github: {
        repoId: hook.repoId.toString(),
        repoFullName: hook.repoFullName,
        sessionKeyPrefix: hook.githubSessionKey ?? hook.repoFullName,
        events: hook.events,
        // Empty is the published API's legacy repo-wide comment behavior; omit
        // the optional wire field so older persisted rows keep that meaning.
        // The filter is a type proof: a github row only ever stores its own vocabulary.
        ...(hook.commentFamilies.length > 0
          ? {
              commentFamilies: hook.commentFamilies.filter(
                (family): family is 'issues' | 'pull_request' => family !== 'merge_request'
              )
            }
          : {}),
        labelFilter: hook.labelFilter,
        // P3: the App slug broadcasts to every matching rule; the immutable
        // agent slug targets this rule. Thread actors also pass live maintainer auth.
        mentionOnly: hook.mentionOnly,
        ...(this.appSlug ? { appSlug: this.appSlug } : {}),
        agentName: agent.name,
        installationIds: valid.map((i) => i.installationId.toString())
      }
    }
  }

  /**
   * Converge the pool on one hook: assign when compilable, remove otherwise.
   *
   * The spec projection is ordered against the rule, never merely paired with it (§24.4): the
   * agent must carry the host for as long as a rule that can fire exists, so a GAINING
   * projection lands before the assign and a LOSING one after the remove. Every caller
   * inherits that — the CRUD routes, the gitlab provisioning rebroadcast, and a placement
   * re-converge alike — which is the point of it living here.
   */
  async broadcast(hook: HookRecord): Promise<void> {
    const rule = await this.compile(hook)
    if (rule) {
      if (hook.agentId) await this.projectAgentSpec?.(hook.orgId, hook.agentId)
      this.relayControl.hookAssign(rule)
    } else {
      this.relayControl.hookRemove(hook.id)
      if (hook.agentId) await this.projectAgentSpec?.(hook.orgId, hook.agentId)
    }
  }

  /** Explicit pool-wide removal (hook deleted — no row left to compile). */
  remove(hookId: string): void {
    this.relayControl.hookRemove(hookId)
  }

  /** Re-converge every hook firing `agentId` (its placement changed). */
  async rebroadcastForAgent(agentId: AgentId): Promise<void> {
    for (const hook of await this.hooks.listForAgent(agentId)) {
      await this.broadcast(hook)
    }
  }

  /**
   * Re-converge the org's github hooks — the installation set baked into each
   * rule changed (doorbell pull / sync). broadcast() converges to assign OR
   * remove per hook, which covers suspend/uninstall (compile → null → remove)
   * and unsuspend/reinstall (compile succeeds with the fresh set) alike.
   */
  async rebroadcastGithubForOrg(orgId: OrgId): Promise<void> {
    for (const hook of await this.hooks.listForOrgKind(orgId, 'github')) {
      await this.broadcast(hook)
    }
  }

  /**
   * Full replay to ONE relay that just (re)registered — its in-memory table
   * starts empty. Only compilable rules are sent (a fresh table has nothing to
   * remove). Per-hook failures are logged and skipped: one bad row must not
   * starve the rest of the pool's config.
   */
  async replayTo(ch: RelayChannel): Promise<void> {
    for (const hook of await this.hooks.listEnabled()) {
      try {
        const rule = await this.compile(hook)
        // The §17.3/§24.4 negotiation gate, per channel (mirrors RelayControlSender).
        if (rule?.kind === 'gitlab' && !advertises(ch.features, requiredGitlabFeatures(rule.gitlab?.host))) continue
        if (rule) ch.send('rc/hook-assign', rule)
      } catch (err) {
        this.log?.warn({ hookId: hook.id, err }, 'hook replay: compile/send failed — skipped')
      }
    }
  }
}
