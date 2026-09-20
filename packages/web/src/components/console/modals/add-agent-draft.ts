import type { AgentSetupDraft } from '@agentconnect.md/protocol/mcp-app'
import { groupPlacementValue } from '@/lib/data'
import type { WorkspaceMode } from '@/components/console/WorkspaceFormFields'

/** The Add-agent form's own starting point, derived from what a `createAgent` card proposed. Every
 *  field stays editable: the draft seeds the dialog, it does not stand in for the reader's submit. */
export interface AddAgentDraftSeed {
  name: string
  displayName: string
  description: string
  runtime: string
  model: string
  effort: string
  fastMode: boolean
  permissionMode: string | null
  outputMode: AgentSetupDraft['outputMode']
  /** What the placement picker opens on: a daemon id, a group value, or '' for the managed pool. */
  daemonValue: string
  wsMode: WorkspaceMode
  /** The repository address, on whichever of the two free-text tiles claims it. */
  repo: string
  url: string
  branch: string
  agentDir: string
  worktree: boolean
  push: boolean
}

/** Which tile a drafted address lands on: a bare `owner/repo` or a github.com address belongs to the
 *  GitHub tile; any other clone URL is the Git URL tile's, which clones it with the host's own
 *  credentials. A managed GitLab or Gitea project is picked from a live roster, never from an
 *  address, so a draft never preselects one of those tiles. */
export function draftWorkspaceTile(gitRepo: string): WorkspaceMode {
  const address = gitRepo.trim()
  if (!address) return 'scratch'
  if (/^[^\s/]+\/[^\s/]+$/.test(address)) return 'github'
  return /^(https?:\/\/|git@|ssh:\/\/)([^@/]*@)?github\.com[/:]/i.test(address) ? 'github' : 'giturl'
}

export function addAgentDraftSeed(draft?: AgentSetupDraft): AddAgentDraftSeed {
  const workspace = draft?.workspace
  const address = workspace?.mode === 'git' ? (workspace.gitRepo ?? '').trim() : ''
  const wsMode = address ? draftWorkspaceTile(address) : 'scratch'
  return {
    name: draft?.name ?? '',
    displayName: draft?.displayName ?? '',
    description: draft?.description ?? '',
    runtime: draft?.runtime ?? '',
    model: draft?.model ?? '',
    effort: draft?.reasoningEffort ?? '',
    fastMode: draft?.fastMode ?? false,
    // null leaves the form's own runtime-derived default in place — a draft that named no mode has
    // no opinion, and guessing one here would show the reader a choice nobody made.
    permissionMode: draft?.permissionMode ?? null,
    outputMode: draft?.outputMode,
    daemonValue:
      draft?.placementKind === 'set' && draft.setId
        ? groupPlacementValue(draft.setId)
        : draft?.placementKind === 'pool'
          ? ''
          : (draft?.daemonId ?? ''),
    wsMode,
    repo: wsMode === 'github' ? address : '',
    url: wsMode === 'giturl' ? address : '',
    branch: workspace?.gitBranch ?? 'main',
    agentDir: workspace?.agentDir ?? '',
    worktree: workspace?.worktree ?? true,
    push: workspace?.access === 'write'
  }
}
