import { GITLAB_DEFAULT_BASE_URL, type ExternalSessionOrigin } from '@agentconnect.md/protocol'
import type { HookDispatchContext } from '../github/hook-coords.js'

// Only trusted delivery metadata can bind a code-host session to a repository audience.
export function codeHostExternalSource(context: HookDispatchContext | undefined) {
  if (!context) return undefined
  const proof = { hookId: context.hookId, deliveryKey: context.deliveryKey }
  let externalOrigin: ExternalSessionOrigin
  if (context.github) {
    externalOrigin = {
      ...proof,
      provider: 'github',
      realmKey: 'github.com',
      resourceKind: 'repository',
      resourceKey: context.github.repoId,
      sourceInstallationId: context.github.sourceInstallationId,
      repoFullName: context.github.repoFullName
    }
  } else if (context.gitlab) {
    externalOrigin = {
      ...proof,
      provider: 'gitlab',
      realmKey: context.gitlab.host ?? GITLAB_DEFAULT_BASE_URL,
      resourceKind: 'repository',
      resourceKey: context.gitlab.projectId
    }
  } else return undefined
  return {
    externalProvider: externalOrigin.provider,
    externalRealmKey: externalOrigin.realmKey,
    externalResourceKind: externalOrigin.resourceKind,
    externalResourceKey: externalOrigin.resourceKey,
    externalOrigin
  }
}
