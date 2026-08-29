import { normalizeGitCloneUrl } from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'

/** Stable identity-free signature of an agent's effective config. Excludes the
 *  loader-only `dir` field (present on `LoadedAgent`) so the comparison is over
 *  the agent's behaviour, not where it was found. Both sides have an absolutized
 *  workspace path, so this is apples-to-apples and stable across re-serialization
 *  (zod key order is fixed by the schema). */
function signature(a: Agent): string {
  const { dir, ...rest } = a as Agent & { dir?: unknown }
  void dir
  return JSON.stringify(rest)
}

/** Sub-signature over the dimensions that determine the ACP host subprocess or
 *  must be materialized before it starts — the spawn binary (`runtime`), workspace
 *  skills, and the knobs baked into the host at construction: child env /
 *  system-prompt seed (agentChildEnv + cpRuntimeEnv), session config prefs (model /
 *  reasoningEffort / fastMode / permissionMode, applied per
 *  session via ACP set_config_option), and the OS sandbox wrapper. A change here
 *  means the cached host must be evicted so the next session respawns it fresh. */
function hostSpawnSig(a: Agent): string {
  return JSON.stringify({
    runtime: a.runtime,
    runInSandbox: a.runInSandbox,
    model: a.runtimeOverrides?.model,
    description: a.description,
    reasoningEffort: a.reasoningEffort,
    executionMode: a.executionMode,
    fastMode: a.fastMode,
    permissionMode: a.permissionMode,
    // Memory backend bakes env into the child (disable vs redirect the runtime's own
    // memory — see memoryProviderFor), so a provider change must respawn the host.
    // An external connection switch also changes the trusted scope/client captured
    // by the host. Recall/capture limits stay out: those policy-only edits are hot.
    memory:
      a.memory?.provider === 'external'
        ? { provider: 'external', connectionId: a.memory.connectionId }
        : a.memory?.provider,
    env: a.runtimeOverrides?.env,
    // Secrets are baked into the child env at spawn (agentChildEnv) and
    // materialized as config files (config-file-env.ts) — a value edit that
    // doesn't evict the host would leave the child running on the stale value.
    secrets: a.runtimeOverrides?.secrets,
    // Workspace skills are reconciled before host startup. Evict a live host
    // before changing them so the runtime never observes the remove/reinstall
    // transaction halfway through and always discovers the final set.
    skills: a.skills,
    managedSkills: a.managedSkills
  })
}

/** Sub-signature over the workspace dimension — cwd is materialized per session by
 *  prepareWorkspace(agent), so a workspace change must also evict the host so the
 *  next session re-materializes the (possibly re-pointed/re-cloned) checkout. */
function workspaceSig(a: Agent): string {
  return JSON.stringify(a.workspace)
}

function isGithubRepoLocation(input: string): boolean {
  try {
    const normalized = normalizeGitCloneUrl(input)
    const scp = /^[\w.-]+@([\w.-]+):/.exec(normalized)
    if (scp) return scp[1]!.toLowerCase() === 'github.com'
    if (!/^(?:https|ssh):\/\//i.test(input.trim())) return false
    return new URL(normalized).hostname.toLowerCase() === 'github.com'
  } catch {
    return false
  }
}

/**
 * A GitHub App workspace keeps the same checkout when GitHub changes only the
 * repository's canonical name. Genuine workspace edits are cold-fenced by the
 * CP's agent/detach → agent/activate flow; the live upsert/reconnect path may
 * therefore treat this one-field canonical URL convergence as non-destructive.
 */
function isGithubAppRepoRename(before: Agent, after: Agent): boolean {
  const left = before.workspace
  const right = after.workspace
  if (
    left.mode !== 'git-repo' ||
    right.mode !== 'git-repo' ||
    left.gitCredential !== 'github-app' ||
    right.gitCredential !== 'github-app' ||
    !left.gitRepo ||
    !right.gitRepo ||
    left.gitRepo === right.gitRepo ||
    !isGithubRepoLocation(left.gitRepo) ||
    !isGithubRepoLocation(right.gitRepo)
  ) {
    return false
  }
  const { gitRepo: leftRepo, ...leftRest } = left
  const { gitRepo: rightRepo, ...rightRest } = right
  void leftRepo
  void rightRepo
  return JSON.stringify(leftRest) === JSON.stringify(rightRest)
}

/** Sub-signature over the integration dimension — Slack app/bot tokens + bindRules.
 *  A change here rebuilds routing (and, where safe, re-opens Slack connections) but
 *  does NOT by itself touch the host. */
function integrationsSig(a: Agent): string {
  // `origin` is replica bookkeeping only. Adding the marker during a rolling
  // upgrade must not flap an otherwise-identical live platform connection.
  return JSON.stringify(
    a.integrations.map(({ origin, ...integration }) => {
      void origin
      return integration
    })
  )
}

/** A still-running agent whose effective config changed, with per-dimension flags
 *  saying which dimensions moved. `hostRespawn || workspace` ⇒ evict the host;
 *  `integrations` ⇒ rebuild routing / reconnect Slack; all three false ⇒ a soft-only
 *  change (output/permissions/status/name/crons/…) — update in-memory config only. */
export interface AgentChange {
  agent: Agent
  hostRespawn: boolean
  workspace: boolean
  /** App-backed canonical repo URL refresh: update origin without interrupting turns. */
  workspaceRepoRename: boolean
  integrations: boolean
}

export interface AgentDiff {
  toStart: Agent[]
  toStop: string[]
  toChange: AgentChange[]
}

/**
 * Diff desired (freshly loaded active agents) against the running set.
 * - `toStart`  — desired ids not currently running.
 * - `toStop`   — running ids no longer desired.
 * - `toChange` — same id, changed effective config. Emitted whenever the overall
 *   signature differs; the three booleans classify which dimensions moved so the
 *   caller can react minimally (evict host vs rebuild routing vs nothing). All
 *   three false ⇒ a soft-only change. Without `toChange` an in-place agent.json
 *   edit would silently be a no-op.
 */
export function diffAgents(desired: Agent[], actual: Map<string, Agent>): AgentDiff {
  const desiredIds = new Set(desired.map((a) => a.id))
  const toStart: Agent[] = []
  const toChange: AgentChange[] = []
  for (const a of desired) {
    const cur = actual.get(a.id)
    if (!cur) {
      toStart.push(a)
    } else if (signature(cur) !== signature(a)) {
      const workspaceRepoRename = isGithubAppRepoRename(cur, a)
      toChange.push({
        agent: a,
        hostRespawn: hostSpawnSig(cur) !== hostSpawnSig(a),
        workspace: workspaceSig(cur) !== workspaceSig(a) && !workspaceRepoRename,
        workspaceRepoRename,
        integrations: integrationsSig(cur) !== integrationsSig(a)
      })
    }
  }
  const toStop = [...actual.keys()].filter((id) => !desiredIds.has(id))
  return { toStart, toStop, toChange }
}
