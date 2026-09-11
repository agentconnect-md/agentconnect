import type { CodeHostHookMetadata } from '@agentconnect.md/protocol'
import type { HookDeliveryInput } from '../persistence/ports.js'

/** The GitHub subject columns a HookRun row records off a delivery's trusted member. */
export type GithubHookRunSubject = Pick<
  HookDeliveryInput,
  | 'repoId'
  | 'repoFullName'
  | 'sourceInstallationId'
  | 'subjectKind'
  | 'pullNumber'
  | 'headSha'
  | 'baseSha'
  | 'reportSha'
  | 'isDraft'
  | 'baseChanged'
>

/** The row's subject columns for this delivery; the columns are GitHub-shaped, so another host's member records none. */
export function githubHookRunSubject(host: CodeHostHookMetadata | undefined): GithubHookRunSubject {
  if (host?.provider !== 'github') return {}
  const github = host.metadata
  return {
    repoId: BigInt(github.repoId),
    repoFullName: github.repoFullName,
    sourceInstallationId: BigInt(github.sourceInstallationId),
    subjectKind: github.subjectKind,
    ...(github.pullNumber !== undefined ? { pullNumber: github.pullNumber } : {}),
    ...(github.headSha ? { headSha: github.headSha } : {}),
    ...(github.baseSha ? { baseSha: github.baseSha } : {}),
    ...(github.reportSha ? { reportSha: github.reportSha } : {}),
    ...(github.isDraft !== undefined ? { isDraft: github.isDraft } : {}),
    ...(github.baseChanged !== undefined ? { baseChanged: github.baseChanged } : {})
  }
}
