/** GitLab's half of event wake (assistant-mode.md §5.14): a ready project binding of the organization reaches the object, and the project's feedback watch carries its events. */
import type { FollowUpWatchProvider } from '../codehost/follow-up-watch.service.js'
import {
  isHonoredRepoGrant,
  type AgentRecord,
  type AgentRepoAuthorizationRepo,
  type GitlabProjectBindingRecord,
  type GitlabProjectBindingRepo
} from '../persistence/ports.js'
import { GitlabApiError, gitlabWatchedObject, type GitlabApiClient } from './api.js'
import type { GitlabFeedbackProvider } from './feedback-provider.js'

/** A binding that still serves: neither being removed nor degraded at runtime. */
const serves = (binding: GitlabProjectBindingRecord | null): binding is GitlabProjectBindingRecord =>
  !!binding && binding.state !== 'cleanup_pending' && binding.state !== 'runtime_degraded'

export function gitlabFollowUpWatchProvider(deps: {
  api: GitlabApiClient
  bindings: Pick<GitlabProjectBindingRepo, 'byProject' | 'byProjectPath'>
  repoAuths: Pick<AgentRepoAuthorizationRepo, 'listForAgent'>
  feedback: Pick<GitlabFeedbackProvider, 'readToken'>
}): FollowUpWatchProvider {
  // The agent's two credential authorities on a project: its workspace project, or an explicit authorization.
  const authorized = async (agent: AgentRecord, projectId: bigint): Promise<boolean> => {
    const workspace = agent.workspace
    if (workspace.mode === 'git' && workspace.credential?.provider === 'gitlab' && agent.workspaceRepoId === projectId)
      return true
    const rows = await deps.repoAuths.listForAgent(agent.id)
    return rows.some((row) => row.provider === 'gitlab' && row.repoId === projectId && isHonoredRepoGrant(row))
  }
  const instance = new URL(deps.api.baseUrl).host.toLowerCase()
  return {
    provider: 'gitlab',
    async resolve(agent, target) {
      if (target.host.toLowerCase() !== instance) return 'unsupported'
      const binding = await deps.bindings.byProjectPath(agent.orgId, target.repoPath)
      // Installing the project's webhook needs a binding, so a project without one sends no events here.
      if (!serves(binding)) return 'unsupported'
      if (!(await authorized(agent, binding.projectId))) return 'no_access'
      try {
        const token = await deps.feedback.readToken(agent.orgId, binding.id)
        await gitlabWatchedObject(token, binding.projectId, target.subject, target.number, deps.api)
      } catch (err) {
        if (err instanceof GitlabApiError && err.status === 404) return 'not_found'
        if (err instanceof GitlabApiError && !err.retryable) return 'no_access'
        return 'unavailable'
      }
      return {
        installationId: null,
        bindingId: binding.id,
        host: deps.api.baseUrl,
        repoId: binding.projectId,
        repoPath: binding.projectPath,
        subject: target.subject,
        number: target.number
      }
    },
    async covers(agent, watch) {
      const binding = await deps.bindings.byProject(agent.orgId, watch.repoId)
      return serves(binding) && binding.id === watch.bindingId && (await authorized(agent, watch.repoId))
    }
  }
}
