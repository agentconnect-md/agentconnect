// What an agent works on through GitHub — the coverage an organization App must have before the agent switches to it (§Organization GitHub Apps).
import { gitRepoLabel } from '@agentconnect.md/protocol'
import type {
  AgentInstallationAuthorizationRepo,
  AgentRecord,
  AgentRepoAuthorizationRepo,
  HookRepo
} from '../persistence/ports.js'
import { AgentId } from '../domain/ids.js'
import type { AgentGithubScope } from './apps.service.js'

export interface AgentGithubScopeDeps {
  repoAuths: Pick<AgentRepoAuthorizationRepo, 'listForAgent'>
  installationAuths: Pick<AgentInstallationAuthorizationRepo, 'listForAgent'>
  hooks: Pick<HookRepo, 'listForAgent'>
}

export function agentGithubScope(deps: AgentGithubScopeDeps): (agent: AgentRecord) => Promise<AgentGithubScope> {
  return async (agent) => {
    const repositories = new Map<string, AgentGithubScope['repositories'][number]>()
    const accounts = new Map<string, AgentGithubScope['accounts'][number]>()
    // The first kind a target is seen under names it: workspace, then authorized, then watched.
    const addRepository = (fullName: string, kind: AgentGithubScope['repositories'][number]['kind']) => {
      if (!repositories.has(fullName.toLowerCase())) repositories.set(fullName.toLowerCase(), { fullName, kind })
    }
    const addAccount = (login: string, kind: AgentGithubScope['accounts'][number]['kind']) => {
      if (!accounts.has(login.toLowerCase())) accounts.set(login.toLowerCase(), { login, kind })
    }
    if (agent.workspace.mode === 'git' && agent.workspace.credential?.provider === 'github') {
      addRepository(gitRepoLabel(agent.workspace.gitRepo), 'workspace')
    }
    for (const row of await deps.repoAuths.listForAgent(AgentId(agent.id))) {
      if (row.provider === 'github') addRepository(row.repoFullName, 'repository')
    }
    for (const row of await deps.installationAuths.listForAgent(AgentId(agent.id))) {
      if (row.provider === 'github') addAccount(row.accountLogin, 'installation')
    }
    for (const hook of await deps.hooks.listForAgent(AgentId(agent.id))) {
      if (hook.kind !== 'github') continue
      if (hook.installationAccount) addAccount(hook.installationAccount, 'review')
      else if (hook.repoFullName) addRepository(hook.repoFullName, 'review')
    }
    return { repositories: [...repositories.values()], accounts: [...accounts.values()] }
  }
}
