/** GitHub's half of event wake (assistant-mode.md §5.14): the App installation reaches the object, and the relay matches it by numeric repository id. */
import type { FollowUpWatchProvider } from '../codehost/follow-up-watch.service.js'
import type { GithubService } from './service.js'

export function githubFollowUpWatchProvider(
  github: Pick<GithubService, 'resolveWatchedObject' | 'coversWatchedRepo'>
): FollowUpWatchProvider {
  return {
    provider: 'github',
    async resolve(agent, target) {
      if (target.host !== 'github.com') return 'unsupported'
      const resolved = await github.resolveWatchedObject(agent, target.repoPath, target.subject, target.number)
      if (typeof resolved === 'string') return resolved
      return {
        installationId: resolved.installationId,
        bindingId: '',
        host: 'github.com',
        repoId: resolved.repoId,
        repoPath: resolved.repoFullName,
        subject: resolved.subject,
        number: target.number
      }
    },
    covers: (agent, watch) =>
      watch.installationId === null
        ? Promise.resolve(false)
        : github.coversWatchedRepo(agent, watch.installationId, watch.repoId),
    relayWatch: (object, watched) =>
      object.installationId === null
        ? null
        : {
            provider: 'github',
            installationId: object.installationId.toString(),
            repoId: object.repoId.toString(),
            subject: object.subject,
            number: object.number,
            watched
          }
  }
}
