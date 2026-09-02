/**
 * Which of an agent's workspace roots one console request addresses, and where that root IS.
 *
 * Two independent selectors ride every workspace REQ. `sessionId` picks a session's isolated Git
 * worktree instead of the checkout; `repo` picks one of the agent's AUTHORIZED additional
 * repositories — its secondary root under `<agentRoot>/repos/<owner>/<repo>` — instead of the
 * primary workspace (multi-repository-workspaces.md). They compose: a `repo` with a `sessionId`
 * is that root's own `worktrees/<sid>`, keyed by the SAME session id the primary's worktree uses,
 * because isolation applies to every root uniformly.
 *
 * One resolver for the file reader and the git seam, as before: the directory the console browses
 * and the one it commits must be the same directory, and describing them two different ways is what
 * broke both panels. Extracted from the CP client's wiring so the routing is testable on its own.
 */
import type { Agent } from '../agents/agent-schema.js'
import type { WorkspaceLocation } from '../workspace/workspace-files.js'
import type { WorkspaceManager } from '../workspace/workspace-manager.js'
import type { WorkspaceGitTarget } from './workspace-git.js'

/** What the scope needs of a session row: the key naming its worktrees, and whether it has any. */
export interface WorkspaceScopeSession {
  key: string
  workspaceIsolation?: 'shared' | 'session' | null
}

export interface WorkspaceScopeDeps {
  workspaces: WorkspaceManager
  agentOf: (agentId: string) => Agent | undefined
  /** Resolve a slot from the id the console addresses it by — its outward one (session-concept.md §1.1). */
  sessionOf: (agentId: string, sessionId: string) => Promise<WorkspaceScopeSession | undefined>
  /** The sandbox volume root a cluster agent's workspace lives on; undefined for a local daemon. */
  runtimeRootOf: (agentId: string) => string | undefined
}

/** A daemon-local root, plus the session key naming its worktree when the scope is isolated. */
type LocalLocation = WorkspaceLocation & { sessionKey?: string }

export interface WorkspaceScope {
  /** The root in EXECUTION coordinates — under `--k8s`, the sandbox pod's volume. */
  location(agentId: string, sessionId?: string, repo?: string): Promise<WorkspaceLocation | undefined>
  gitRoot(agentId: string, sessionId?: string, repo?: string): Promise<string | undefined>
  /** The origin and branch a network git operation on this scope may reach. */
  target(agentId: string, repo?: string): Promise<WorkspaceGitTarget | undefined>
  /** Whether git on this scope rides the daemon credential helper; answered without touching any volume. */
  usesGithubApp(agentId: string, repo?: string): boolean
}

export function createWorkspaceScope(deps: WorkspaceScopeDeps): WorkspaceScope {
  // This daemon's own coordinates: `agent.workspace.path` and the session worktrees beside it, or
  // the named secondary root's checkout and worktrees. The session KEY travels with an isolated
  // one, because the worktree is named by it in either filesystem and the pod's path is composed
  // rather than translated.
  const daemonLocation = async (
    agentId: string,
    sessionId?: string,
    repo?: string
  ): Promise<LocalLocation | undefined> => {
    const agent = deps.agentOf(agentId)
    if (!agent) return undefined
    if (repo !== undefined) return await secondaryLocation(agent, repo, sessionId)
    if (!sessionId) return { root: agent.workspace.path, scratch: agent.workspace.mode === 'from-scratch' }
    const session = await deps.sessionOf(agentId, sessionId)
    if (agent.workspace.mode !== 'git-repo' || session?.workspaceIsolation !== 'session') return undefined
    return { root: deps.workspaces.sessionWorktreePath(agent, session.key), scratch: false, sessionKey: session.key }
  }

  // A repository the agent does not authorize is refused HERE, so no root outside the set is ever
  // addressable. A root the agent does authorize but has not materialized yet still answers: its
  // checkout is simply absent, which reads as an empty workspace rather than an error.
  const secondaryLocation = async (
    agent: Agent,
    repo: string,
    sessionId?: string
  ): Promise<LocalLocation | undefined> => {
    const root = await deps.workspaces.consoleSecondaryRoot(agent, repo)
    if (!root) return undefined
    // A secondary root is a git checkout whatever the primary workspace mode is — never scratch.
    if (!sessionId) return { root: root.path, scratch: false }
    const session = await deps.sessionOf(agent.id, sessionId)
    if (session?.workspaceIsolation !== 'session') return undefined
    // The root's worktree at the session's id, or its clone in the session's own directory (§11).
    return {
      root: deps.workspaces.sessionRootDirectory(agent, root, session.key),
      scratch: false,
      sessionKey: session.key
    }
  }

  const location = async (
    agentId: string,
    sessionId?: string,
    repo?: string
  ): Promise<WorkspaceLocation | undefined> => {
    const agent = deps.agentOf(agentId)
    const local = await daemonLocation(agentId, sessionId, repo)
    if (!agent || !local) return undefined
    // A defined location for a sessionId means that session IS isolated, so on a cluster it names
    // the per-session worktree on the pod's volume rather than the shared checkout.
    const root = deps.workspaces.consoleWorkspaceRoot(
      agent,
      local.root,
      deps.runtimeRootOf(agentId),
      local.sessionKey === undefined ? undefined : { isolation: 'session', sessionKey: local.sessionKey },
      repo
    )
    return root === undefined ? undefined : { root, scratch: local.scratch }
  }

  return {
    location,
    gitRoot: async (agentId, sessionId, repo) => (await location(agentId, sessionId, repo))?.root,
    target: async (agentId, repo) => {
      const agent = deps.agentOf(agentId)
      if (!agent) return undefined
      if (repo !== undefined) {
        const root = await deps.workspaces.consoleSecondaryRoot(agent, repo)
        // Rows exist only for App-covered repositories, so a secondary root always rides the helper;
        // the branch is the one its `.materialization.json` attests, never the primary's.
        return root
          ? {
              repo: root.cloneUrl,
              branch: root.branch,
              githubApp: true,
              remoteProvider: 'github',
              ...(root.managed ? { managed: root.managed } : {})
            }
          : undefined
      }
      const workspace = agent.workspace
      if (workspace.mode !== 'git-repo' || !workspace.gitRepo) return undefined
      const remoteProvider = deps.workspaces.remoteProviderOf(agent, workspace.gitRepo)
      // The flag's name is historical: it means MANAGED credential, gitlab as much as github-app.
      return {
        repo: workspace.gitRepo,
        branch: workspace.gitBranch,
        githubApp: deps.workspaces.usesManagedCredential(agent),
        managed: deps.workspaces.managedScopeOf(agent),
        ...(remoteProvider !== undefined ? { remoteProvider } : {})
      }
    },
    usesGithubApp: (agentId, repo) => {
      const agent = deps.agentOf(agentId)
      // Rows exist only for App-covered repositories, so a secondary root always rides the helper.
      if (repo !== undefined) return agent !== undefined
      // Same historical name, same meaning: either managed provider rides the daemon helper.
      return agent !== undefined && deps.workspaces.usesManagedCredential(agent)
    }
  }
}
