/**
 * What still points at a managed Gitea repository (gitea-integration.md §6): the triggers, agent
 * workspaces and additional-repository grants that consume it. A binding is bound on first use but
 * never unbound on last use, so the operator's Remove is refused while any of these stands — and the
 * refusal names them, because "in use" alone sends a reader hunting.
 */
import type { OrgId } from '../domain/ids.js'
import type { AgentRecord, AgentRepoAuthorizationRepo, AgentRepo, HookRepo } from '../persistence/ports.js'

export type GiteaBindingReference =
  | { kind: 'trigger'; hookName: string; agentName: string }
  | { kind: 'workspace'; agentName: string }
  | { kind: 'additional_repository'; agentName: string }

/** How many references a refusal names before it counts the rest. */
const NAMED_REFERENCES = 4

export interface GiteaReferenceReads {
  hook: Pick<HookRepo, 'listForOrgKind'>
  agent: Pick<AgentRepo, 'list'>
  agentRepoAuth: Pick<AgentRepoAuthorizationRepo, 'listForRepository'>
}

/** Every consumer of one repository in the organization, workspaces first, then grants, then triggers. */
export async function collectGiteaReferences(
  repos: GiteaReferenceReads,
  orgId: OrgId,
  repoId: bigint
): Promise<GiteaBindingReference[]> {
  const [agents, grants, hooks] = await Promise.all([
    repos.agent.list(orgId),
    repos.agentRepoAuth.listForRepository(orgId, 'gitea', repoId),
    repos.hook.listForOrgKind(orgId, 'gitea')
  ])
  const nameOf = new Map<string, string>(agents.map((agent): [string, string] => [agent.id, agent.name]))
  const consumesAsWorkspace = (agent: AgentRecord): boolean =>
    agent.workspace.mode === 'git' &&
    agent.workspace.credential?.provider === 'gitea' &&
    agent.workspaceRepoId === repoId
  return [
    ...agents
      .filter(consumesAsWorkspace)
      .map((agent): GiteaBindingReference => ({ kind: 'workspace', agentName: agent.name })),
    ...grants.map((grant): GiteaBindingReference => ({
      kind: 'additional_repository',
      agentName: nameOf.get(grant.agentId) ?? grant.agentId
    })),
    ...hooks
      .filter((hook) => hook.repoId === repoId && hook.agentId !== null)
      .map((hook): GiteaBindingReference => ({
        kind: 'trigger',
        hookName: hook.name,
        agentName: nameOf.get(hook.agentId!) ?? hook.agentId!
      }))
  ]
}

function describeReference(reference: GiteaBindingReference): string {
  switch (reference.kind) {
    case 'trigger':
      return `trigger “${reference.hookName}” of agent ${reference.agentName}`
    case 'workspace':
      return `the workspace of agent ${reference.agentName}`
    case 'additional_repository':
      return `an additional repository of agent ${reference.agentName}`
  }
}

/** The refusal a referenced binding's removal answers; a reference that left between the refusal and this read is still a refusal. */
export function describeGiteaReferences(repoPath: string, references: readonly GiteaBindingReference[]): string {
  if (references.length === 0) return `${repoPath} was still in use when its removal was refused — retry`
  const named = references.slice(0, NAMED_REFERENCES).map(describeReference)
  const rest = references.length - named.length
  const list = rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ')
  return `${repoPath} is still in use — ${list} — remove those first`
}
