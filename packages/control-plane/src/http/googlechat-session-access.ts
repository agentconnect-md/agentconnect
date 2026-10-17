// Google identities own historical DMs; current conversation access follows Chat membership.
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { UserRepo } from '../persistence/ports.js'
import { BotSessionAccessService, type BotSessionAccessDeps } from '../platforms/bot-session-access.js'
import { checkGoogleChatMembership } from '../platforms/googlechat/session-access.js'
import { type GoogleAccountIdentity, syncGoogleAccountId } from './google-account-id.js'
import type { SessionAccessViewer } from './session-access-plugin.js'

/** The private owner a DM from this Google account records under this Chat app: `<platform>:<project number>:users/<id>` (session-visibility.md §2). */
export function googleChatOwnerIdentity(projectNumber: string, googleAccountId: string): string {
  return `${GOOGLE_CHAT_PLATFORM}:${projectNumber}:users/${googleAccountId}`
}

export class GoogleChatSessionAccessService extends BotSessionAccessService {
  constructor(
    private readonly googleDeps: BotSessionAccessDeps & {
      users: Pick<UserRepo, 'getGoogleAccountId' | 'setGoogleAccountId'>
      identity?: GoogleAccountIdentity
    },
    fetchImpl: typeof fetch = fetch
  ) {
    super(
      GOOGLE_CHAT_PLATFORM,
      googleDeps,
      (_token, bot) => bot.externalAppId,
      ({ token, resource, member }, signal) =>
        checkGoogleChatMembership(token, resource, member, signal, fetchImpl, () => new Date(googleDeps.clock.now()))
    )
  }

  async addViewerIdentities({ request, orgId, userId, identitySet }: SessionAccessViewer): Promise<void> {
    const subject = request.oidcSubject
    if (!subject || !this.googleDeps.identity) return
    // Every Chat app of the org, revoked or not: a DM owner's middle segment is its app's project number, fixed at ingest.
    const projects = new Set(
      (await this.googleDeps.bots.listForOrg(orgId)).flatMap((bot) =>
        bot.platform === GOOGLE_CHAT_PLATFORM && bot.externalAppId ? [bot.externalAppId] : []
      )
    )
    if (projects.size === 0) return
    // Served under the identity lease the Slack and Feishu identities share, so an unlink also clears the recorded id.
    const accountId = await syncGoogleAccountId(
      { identity: this.googleDeps.identity, users: this.googleDeps.users },
      { userId, oidcSubject: subject }
    )
    if (!accountId || !/^[1-9]\d*$/.test(accountId)) return
    identitySet.add(`${GOOGLE_CHAT_PLATFORM}:global:users/${accountId}`)
    for (const project of projects) identitySet.add(googleChatOwnerIdentity(project, accountId))
  }
}
