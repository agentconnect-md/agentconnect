function consoleKey<const Resource extends string, const Parts extends readonly string[]>(
  orgId: string | null | undefined,
  resource: Resource,
  ...parts: Parts
): readonly ['console', string, Resource, ...Parts] | null {
  return orgId ? (['console', orgId, resource, ...parts] as const) : null
}

/** Canonical org-scoped SWR keys. Fetchers must read every request parameter from these keys. */
export const consoleKeys = {
  agents: (orgId: string | null | undefined) => consoleKey(orgId, 'agents'),
  daemons: (orgId: string | null | undefined) => consoleKey(orgId, 'daemons'),
  crons: (orgId: string | null | undefined) => consoleKey(orgId, 'crons'),
  integrations: (orgId: string | null | undefined) => consoleKey(orgId, 'integrations'),
  bots: (orgId: string | null | undefined) => consoleKey(orgId, 'bots'),
  mcpProviders: (orgId: string | null | undefined) => consoleKey(orgId, 'mcp-providers'),
  skillSources: (orgId: string | null | undefined) => consoleKey(orgId, 'skill-sources'),
  managedSkills: (orgId: string | null | undefined, includeArchived: boolean) =>
    consoleKey(orgId, 'managed-skills', includeArchived ? 'include-archived' : 'active'),
  connectorsConfig: (orgId: string | null | undefined) => consoleKey(orgId, 'connectors-config'),
  memoryPluginInstallations: (orgId: string | null | undefined) => consoleKey(orgId, 'memory-plugin-installations'),
  externalMemoryConnections: (orgId: string | null | undefined) => consoleKey(orgId, 'external-memory-connections'),
  members: (orgId: string | null | undefined) => consoleKey(orgId, 'members'),
  inviteLink: (orgId: string | null | undefined) => consoleKey(orgId, 'invite-link'),
  usage: <const Range extends string>(orgId: string | null | undefined, range: Range) =>
    consoleKey(orgId, 'usage', range),
  sessions: (
    orgId: string | null | undefined,
    cursor: string,
    limit: string,
    agentId: string,
    integration: string,
    platform: string,
    channel: string,
    triggeredBy: string,
    githubRepoId: string
  ) => consoleKey(orgId, 'sessions', cursor, limit, agentId, integration, platform, channel, triggeredBy, githubRepoId),
  sessionFacets: (
    orgId: string | null | undefined,
    agentId: string,
    integration: string,
    platform: string,
    channel: string,
    triggeredBy: string,
    githubRepoId: string
  ) => consoleKey(orgId, 'session-facets', agentId, integration, platform, channel, triggeredBy, githubRepoId),
  sessionDetail: (orgId: string | null | undefined, sessionId: string | null | undefined) =>
    sessionId ? consoleKey(orgId, 'session-detail', sessionId) : null,
  cronRuns: (orgId: string | null | undefined, cronId: string) => consoleKey(orgId, 'cron-runs', cronId),
  agentHooks: (orgId: string | null | undefined, agentId: string | null | undefined) =>
    agentId ? consoleKey(orgId, 'agent-hooks', agentId) : null,
  agentRepos: (orgId: string | null | undefined, agentId: string | null | undefined) =>
    agentId ? consoleKey(orgId, 'agent-repos', agentId) : null,
  agentPermissionRequests: (orgId: string | null | undefined, agentId: string | null | undefined) =>
    agentId ? consoleKey(orgId, 'agent-permission-requests', agentId) : null,
  hookRuns: (orgId: string | null | undefined, hookId: string) => consoleKey(orgId, 'hook-runs', hookId)
}

export const profileKeys = {
  apiKeys: ['profile', 'api-keys'] as const
}
