/**
 * The **conversation-audience strategy** (§7.4, stage S2; the daemon-side
 * counterpart of §9's per-platform session-audience resolvers).
 *
 * A session born in a real shared platform conversation is externally bound:
 * its visibility follows the CONVERSATION's audience, resolved by the CP
 * against the platform (who can see this channel?). Which platforms support
 * that binding, which of their conversations qualify, and what identifies the
 * REALM the conversation lives in (workspace, tenant) are platform facts:
 *
 *  - Slack binds channels but not DMs (a Slack DM's audience is the DM itself,
 *    already private); realm = the live connection's workspace id.
 *  - Feishu/Lark binds every conversation; realm = the durable tenant anchor
 *    (`region:appId`).
 *  - Telegram and Discord (and anything unregistered) bind nothing — their
 *    sessions classify by the local rules alone, exactly as before this seam.
 */

/** Core-owned inputs an audience strategy may consult. */
export interface ConversationAudienceHost {
  /** The live connection's workspace/team id, where the platform exposes one. */
  liveWorkspaceId(integrationId: string): string | undefined
  /** The integration's durable tenant scope (transport-identity strategy). */
  tenantScope(integration: { id: string; platform: string }): Promise<string | undefined>
}

export interface ConversationAudience {
  readonly platform: string
  /** Does THIS conversation carry an external audience? */
  applies(msg: { isDm: boolean }): boolean
  /** The realm the conversation lives in. Undefined ⇒ unattributable here and
   *  now; the caller decides whether that fails closed (system turns) or rides
   *  incomplete (human ingress). */
  realmKey(
    host: ConversationAudienceHost,
    integrationId: string | undefined,
    integration: { id: string; platform: string } | undefined
  ): Promise<string | undefined>
}

const AUDIENCES = new Map<string, ConversationAudience>([
  [
    'slack',
    {
      platform: 'slack',
      applies: (msg) => !msg.isDm,
      realmKey: async (host, integrationId) => (integrationId ? host.liveWorkspaceId(integrationId) : undefined)
    }
  ],
  [
    'feishu',
    {
      platform: 'feishu',
      applies: () => true,
      realmKey: async (host, _integrationId, integration) =>
        integration ? await host.tenantScope(integration) : undefined
    }
  ]
])

/** The platform's conversation audience, or undefined — no registered audience
 *  means sessions there classify by local rules alone. */
export function conversationAudienceFor(platform: string): ConversationAudience | undefined {
  return AUDIENCES.get(platform)
}
