// Platform strategies bind real conversations to a stable realm for platform permission checks.

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
  ],
  ...['telegram', 'discord'].map((platform): [string, ConversationAudience] => [
    platform,
    {
      platform,
      applies: () => true,
      realmKey: async (host, _integrationId, integration) => (integration ? host.tenantScope(integration) : undefined)
    }
  ])
])

/** The platform's conversation audience, or undefined — no registered audience
 *  means sessions there classify by local rules alone. */
export function conversationAudienceFor(platform: string): ConversationAudience | undefined {
  return AUDIENCES.get(platform)
}
