// Platform strategies bind real conversations to a stable realm for platform permission checks.
import { IntegrationDiscordConfig } from '@agentconnect.md/protocol'

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
  // A provider may give a thread its own audience; otherwise the enclosing channel owns it.
  resourceKey?(msg: { channel: string; thread?: string }): string
  /** The realm the conversation lives in. Undefined ⇒ unattributable here and
   *  now; the caller decides whether that fails closed (system turns) or rides
   *  incomplete (human ingress). */
  realmKey(
    host: ConversationAudienceHost,
    integrationId: string | undefined,
    integration: { id: string; platform: string; config?: unknown } | undefined
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
  [
    'telegram',
    {
      platform: 'telegram',
      applies: () => true,
      realmKey: async (host, _integrationId, integration) => (integration ? host.tenantScope(integration) : undefined)
    }
  ],
  [
    'googlechat',
    {
      platform: 'googlechat',
      applies: () => true,
      realmKey: async (host, _integrationId, integration) => (integration ? host.tenantScope(integration) : undefined)
    }
  ],
  [
    'discord',
    {
      platform: 'discord',
      applies: () => true,
      resourceKey: (msg) => (msg.thread && /^[1-9]\d*$/.test(msg.thread) ? msg.thread : msg.channel),
      realmKey: async (_host, _integrationId, integration) => {
        const config = IntegrationDiscordConfig.safeParse(integration?.config)
        const id = config.success ? Buffer.from(config.data.botToken.split('.')[0]!, 'base64url').toString('utf8') : ''
        return /^\d{17,20}$/.test(id) ? `bot${id}` : undefined
      }
    }
  ]
])

/** The platform's conversation audience, or undefined — no registered audience
 *  means sessions there classify by local rules alone. */
export function conversationAudienceFor(platform: string): ConversationAudience | undefined {
  return AUDIENCES.get(platform)
}
