/** The minimum of an integration this lookup reads. */
export interface ScopedIntegration {
  id: string
  platform: string
}

/** The integration a persisted session resumes on (replyToSession / background-task wake).
 *  A session's transportScope comes from whichever integration the spawn-side resolution picked —
 *  requested platform preferred, else the agent's FIRST integration (`resolveAgentIntegration`).
 *  A channel-free identity (`hook`/`dream`) and an agent call minted on a platform its target has
 *  no integration for (a `webchat` a2a child of a Slack-only agent) both carry another platform's
 *  scope, so no platform filter can reconstruct the choice. The scope embeds its integration's real
 *  platform in the digest prefix, so matching it across ALL of the agent's integrations is
 *  unambiguous; a scope no integration owns stays unresolved (fail-closed). */
export function sessionIntegrationId<I extends ScopedIntegration>(
  integrations: readonly I[] | undefined,
  platform: string,
  transportScope: string | null | undefined,
  scopeOf: (integration: I) => string | undefined
): string | undefined {
  if (!integrations?.length) return undefined
  const owns = (integration: I): boolean => scopeOf(integration) === transportScope
  if (platform !== 'hook' && platform !== 'dream') {
    const onPlatform = integrations.filter((integration) => integration.platform === platform)
    if (!transportScope) return onPlatform[0]?.id
    return (onPlatform.find(owns) ?? integrations.find(owns))?.id
  }
  if (!transportScope) return integrations[0]?.id
  return integrations.find(owns)?.id
}
