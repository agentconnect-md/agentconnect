// Google Chat's half of Session visibility: the console user whose Google account sent a DM opens it (google-chat-integration.md §10.6).
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { BotRepo, UserRepo } from '../persistence/ports.js'
import { type GoogleAccountIdentity, syncGoogleAccountId } from './google-account-id.js'
import type { SessionAccessPlugin, SessionAccessResult, SessionAccessViewer } from './session-access-plugin.js'

/** The private owner a DM from this Google account records under this Chat app: `<platform>:<project number>:users/<id>` (session-visibility.md §2). */
export function googleChatOwnerIdentity(projectNumber: string, googleAccountId: string): string {
  return `${GOOGLE_CHAT_PLATFORM}:${projectNumber}:users/${googleAccountId}`
}

/** Ownership is proven by identity equality alone, so no Google API is called and no scope is resolved. */
export class GoogleChatSessionAccessService implements SessionAccessPlugin {
  readonly provider = GOOGLE_CHAT_PLATFORM

  constructor(
    private readonly deps: {
      bots: Pick<BotRepo, 'listForOrg'>
      users: Pick<UserRepo, 'getGoogleAccountId' | 'setGoogleAccountId'>
      identity?: GoogleAccountIdentity
    }
  ) {}

  get available(): boolean {
    return this.deps.identity !== undefined
  }

  async addViewerIdentities({ request, orgId, userId, identitySet }: SessionAccessViewer): Promise<void> {
    const subject = request.oidcSubject
    if (!subject || !this.deps.identity) return
    // Every Chat app of the org, revoked or not: a DM owner's middle segment is its app's project number, fixed at ingest.
    const projects = new Set(
      (await this.deps.bots.listForOrg(orgId)).flatMap((bot) =>
        bot.platform === GOOGLE_CHAT_PLATFORM && bot.externalAppId ? [bot.externalAppId] : []
      )
    )
    if (projects.size === 0) return
    // Served under the identity lease the Slack and Feishu identities share, so an unlink also clears the recorded id.
    const accountId = await syncGoogleAccountId(
      { identity: this.deps.identity, users: this.deps.users },
      { userId, oidcSubject: subject }
    )
    if (!accountId) return
    for (const project of projects) identitySet.add(googleChatOwnerIdentity(project, accountId))
  }

  /** Google Chat binds no conversation audience: a DM matches its owner in the identity set and a Space follows organization visibility. */
  async resolve(): Promise<SessionAccessResult> {
    return { allowedScopes: [], degraded: false, accessIssues: [] }
  }
}
