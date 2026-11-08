import { CommitAuthor } from '@agentconnect.md/protocol'
import type { SocialAccount } from '../github/logto-identity.js'
import type { GitlabCurrentUser } from '../gitlab/api.js'
import type { GitlabConnectionRepo } from '../persistence/ports.js'

export interface CommitAuthorsDeps {
  githubAccount?(userId: string): Promise<SocialAccount | null>
  gitlab?: {
    host: string
    connections: Pick<GitlabConnectionRepo, 'listForOrg'>
    currentUser(orgId: string, connectionId: string): Promise<GitlabCurrentUser>
  }
}

/** Only explicit person-account links supply authors; installers and service accounts supply none. */
export async function resolveCommitAuthors(
  viewer: { orgId: string; userId: string },
  deps: CommitAuthorsDeps
): Promise<CommitAuthor[]> {
  const results = await Promise.allSettled([
    githubAuthor(viewer.userId, deps),
    gitlabAuthor(viewer.orgId, viewer.userId, deps)
  ])
  return results.flatMap((result) => {
    if (result.status !== 'fulfilled') return []
    const parsed = CommitAuthor.safeParse(result.value)
    return parsed.success ? [parsed.data] : []
  })
}

async function githubAuthor(userId: string, deps: CommitAuthorsDeps): Promise<CommitAuthor | undefined> {
  const account = await deps.githubAccount?.(userId)
  const social = account?.identities.find((identity) => identity.target === 'github')
  const id = social?.userId ?? account?.githubRepoIdentity?.githubUserId
  const login = social
    ? social.profileUrl?.match(/^https:\/\/github\.com\/([a-zA-Z0-9-]+)$/)?.[1]
    : account?.githubRepoIdentity?.login
  if (!id || !/^[1-9][0-9]*$/.test(id) || !login || !/^[a-zA-Z0-9-]+$/.test(login)) return undefined
  return { provider: 'github', host: 'github.com', name: login, email: `${id}+${login}@users.noreply.github.com` }
}

async function gitlabAuthor(orgId: string, userId: string, deps: CommitAuthorsDeps): Promise<CommitAuthor | undefined> {
  const source = deps.gitlab
  if (!source) return undefined
  const linked = (await source.connections.listForOrg(orgId)).filter(
    (connection) => connection.userId === userId && connection.state === 'connected'
  )
  if (linked.length !== 1) return undefined
  const connection = linked[0]!
  const user = await source.currentUser(orgId, connection.id)
  if (String(user.id) !== String(connection.gitlabUserId)) return undefined
  const email = user.public_email
  if (!email) return undefined
  return { provider: 'gitlab', host: source.host, name: user.username, email }
}
