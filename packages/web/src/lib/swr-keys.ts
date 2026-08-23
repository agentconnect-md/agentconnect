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
  memberSets: (orgId: string | null | undefined) => consoleKey(orgId, 'member-sets'),
  agentLocalSkills: (orgId: string | null | undefined, agentId: string) =>
    consoleKey(orgId, 'agent-local-skills', agentId),
  agentRuntimeCommands: (orgId: string | null | undefined, agentId: string) =>
    consoleKey(orgId, 'agent-runtime-commands', agentId),
  managedSkills: (orgId: string | null | undefined, includeArchived: boolean) =>
    consoleKey(orgId, 'managed-skills', includeArchived ? 'include-archived' : 'active'),
  organizationEnvironment: (orgId: string | null | undefined) => consoleKey(orgId, 'organization-environment'),
  /** The install wizard's deployment-capability probe (`GET /slack/config`) —
   *  Slack-NAMED but answered per organization AND per caller, so it is
   *  org-scoped like every other row here. */
  deploymentConfig: (orgId: string | null | undefined) => consoleKey(orgId, 'deployment-config'),
  /** The deployment GitHub App enabled-probe (`GET /github/installations`, 404 ⇒ off). */
  githubApp: (orgId: string | null | undefined) => consoleKey(orgId, 'github-app'),
  connectorsConfig: (orgId: string | null | undefined) => consoleKey(orgId, 'connectors-config'),
  memoryPluginInstallations: (orgId: string | null | undefined) => consoleKey(orgId, 'memory-plugin-installations'),
  externalMemoryConnections: (orgId: string | null | undefined) => consoleKey(orgId, 'external-memory-connections'),
  members: (orgId: string | null | undefined) => consoleKey(orgId, 'members'),
  inviteLink: (orgId: string | null | undefined) => consoleKey(orgId, 'invite-link'),
  sessionAccess: <const Provider extends 'slack' | 'github' | 'feishu'>(
    orgId: string | null | undefined,
    provider: Provider
  ) => consoleKey(orgId, 'session-access', provider),
  usage: <const Range extends string>(orgId: string | null | undefined, range: Range) =>
    consoleKey(orgId, 'usage', range),
  /** Billing rows come from the separate billing service (lib/billing-api), but they
   *  are org-scoped like everything else here, so they key the same way. */
  billingAccount: (orgId: string | null | undefined) => consoleKey(orgId, 'billing-account'),
  billingTransactions: (orgId: string | null | undefined) => consoleKey(orgId, 'billing-transactions'),
  /** The credit rows of the last 30 days — paged out of the same feed, so it keys apart
   *  from the first page `billingTransactions` serves the Billing table. */
  billingTopUps: (orgId: string | null | undefined) => consoleKey(orgId, 'billing-top-ups'),
  sessions: (
    orgId: string | null | undefined,
    cursor: string,
    limit: string,
    agentId: string,
    integration: string,
    platform: string,
    channel: string,
    triggeredBy: string,
    githubRepoId: string,
    view: string
  ) =>
    consoleKey(
      orgId,
      'sessions',
      cursor,
      limit,
      agentId,
      integration,
      platform,
      channel,
      triggeredBy,
      githubRepoId,
      view
    ),
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
  /** The org's managed GitLab project bindings — one read, shared by every surface that names a project's bots. */
  gitlabProjects: (orgId: string | null | undefined) => consoleKey(orgId, 'gitlab-projects'),
  agentPermissionRequests: (orgId: string | null | undefined, agentId: string | null | undefined) =>
    agentId ? consoleKey(orgId, 'agent-permission-requests', agentId) : null,
  hookRuns: (orgId: string | null | undefined, hookId: string) => consoleKey(orgId, 'hook-runs', hookId)
}

export const profileKeys = {
  apiKeys: ['profile', 'api-keys'] as const
}
