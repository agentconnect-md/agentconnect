function consoleKey<const Resource extends string, const Parts extends readonly string[]>(
  orgId: string | null | undefined,
  resource: Resource,
  ...parts: Parts
): readonly ['console', string, Resource, ...Parts] | null {
  return orgId ? (['console', orgId, resource, ...parts] as const) : null
}

/** Canonical org-scoped SWR keys. Fetchers must read every request parameter from these keys. */
export const consoleKeys = {
  providerKeys: (orgId: string | null | undefined) => consoleKey(orgId, 'provider-keys'),
  agents: (orgId: string | null | undefined) => consoleKey(orgId, 'agents'),
  daemons: (orgId: string | null | undefined) => consoleKey(orgId, 'daemons'),
  /** Fleet capability — split off the liveness poll because it only moves when a daemon
   *  connects, upgrades, or re-probes. */
  daemonCapabilities: (orgId: string | null | undefined) => consoleKey(orgId, 'daemon-capabilities'),
  /** One daemon in full — the only read carrying a runtime's model catalog. */
  daemon: (orgId: string | null | undefined, daemonId: string) => consoleKey(orgId, 'daemon', daemonId),
  crons: (orgId: string | null | undefined) => consoleKey(orgId, 'crons'),
  integrations: (orgId: string | null | undefined) => consoleKey(orgId, 'integrations'),
  giteaConnections: (orgId: string | null | undefined) => consoleKey(orgId, 'gitea-connections'),
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
  organizationKnowledge: (orgId: string | null | undefined, includeArchived: boolean) =>
    consoleKey(orgId, 'organization-knowledge', includeArchived ? 'include-archived' : 'active'),
  organizationKnowledgeEntry: (orgId: string | null | undefined, id: string) =>
    consoleKey(orgId, 'organization-knowledge-entry', id),
  /** One artifact's metadata, shared by every card and the viewer that names it. */
  artifact: (orgId: string | null | undefined, id: string) => consoleKey(orgId, 'artifact', id),
  /** One revision's manifest; a revision never changes, so this never needs revalidating. */
  artifactRevision: (orgId: string | null | undefined, id: string, revision: number) =>
    consoleKey(orgId, 'artifact-revision', id, String(revision)),
  /** One artifact's active share links, for its Share dialog. */
  artifactShares: (orgId: string | null | undefined, id: string) => consoleKey(orgId, 'artifact-shares', id),
  /** One page of the Artifacts page's list under `filters` (`artifactFilterKey`); an empty cursor is the first page. */
  orgArtifacts: (orgId: string | null | undefined, filters: string, cursor: string) =>
    consoleKey(orgId, 'org-artifacts', filters, cursor),
  /** One page of the organization's active public shares, for its owners. */
  orgArtifactShares: (orgId: string | null | undefined, cursor: string) =>
    consoleKey(orgId, 'org-artifact-shares', cursor),
  /** One page of the artifacts a session published or updated; an empty cursor is the first page. */
  sessionArtifacts: (orgId: string | null | undefined, sessionId: string, cursor: string) =>
    consoleKey(orgId, 'session-artifacts', sessionId, cursor),
  /** The Handbook: research's status and the organization record's three entries. */
  organizationRecord: (orgId: string | null | undefined) => consoleKey(orgId, 'organization-record'),
  /** One capability request, as its page shows it. */
  capabilityRequest: (orgId: string | null | undefined, id: string) => consoleKey(orgId, 'capability-request', id),
  /** An agent's open capability requests. */
  agentCapabilityRequests: (orgId: string | null | undefined, agentId: string) =>
    consoleKey(orgId, 'agent-capability-requests', agentId),
  /** The caller's own People cards. */
  myPeopleEntries: (orgId: string | null | undefined, peopleId: string, revision: string) =>
    consoleKey(orgId, 'my-people-entries', peopleId, revision),
  /** The current revision is part of the key, so a revision published from the page refreshes an open history in place. */
  organizationKnowledgeRevisions: (orgId: string | null | undefined, id: string, currentRevision: string) =>
    consoleKey(orgId, 'organization-knowledge-revisions', id, currentRevision),
  organizationSuggestions: <const State extends 'pending' | 'accepted' | 'rejected'>(
    orgId: string | null | undefined,
    state: State
  ) => consoleKey(orgId, 'organization-suggestions', state),
  organizationSuggestionContent: (orgId: string | null | undefined, id: string) =>
    consoleKey(orgId, 'organization-suggestion-content', id),
  organizationEnvironment: (orgId: string | null | undefined) => consoleKey(orgId, 'organization-environment'),
  /** The install wizard's deployment-capability probe (`GET /slack/config`) —
   *  Slack-NAMED but answered per organization AND per caller, so it is
   *  org-scoped like every other row here. */
  deploymentConfig: (orgId: string | null | undefined) => consoleKey(orgId, 'deployment-config'),
  /** The deployment's own Google Chat app (`GET /integrations/googlechat/app`). */
  googleChatApp: (orgId: string | null | undefined) => consoleKey(orgId, 'googlechat-app'),
  /** The deployment's own Teams app (`GET /integrations/msteams/app`). */
  msTeamsApp: (orgId: string | null | undefined) => consoleKey(orgId, 'msteams-app'),
  /** Which registry platforms a deployment setting offers, as their modules' `offered` reads answer. */
  platformOffers: (orgId: string | null | undefined) => consoleKey(orgId, 'platform-offers'),
  /** One email address name's availability (`GET /integrations/email/address`); the empty name reads the mail domain alone. */
  emailAddress: (orgId: string | null | undefined, name: string) => consoleKey(orgId, 'email-address', name),
  /** One address's two settings (`GET /integrations/:id/email/settings`). */
  emailSettings: (orgId: string | null | undefined, integrationId: string) =>
    consoleKey(orgId, 'email-settings', integrationId),
  /** The deployment GitHub App enabled-probe (`GET /github/installations`, 404 ⇒ off). */
  githubApp: (orgId: string | null | undefined) => consoleKey(orgId, 'github-app'),
  /** The built-in App's slug (`GET /github/app`). */
  githubBuiltinApp: (orgId: string | null | undefined) => consoleKey(orgId, 'github-builtin-app'),
  /** The organization's GitHub Apps beside the built-in one. */
  githubApps: (orgId: string | null | undefined) => consoleKey(orgId, 'github-apps'),
  connectorsConfig: (orgId: string | null | undefined) => consoleKey(orgId, 'connectors-config'),
  memoryPluginInstallations: (orgId: string | null | undefined) => consoleKey(orgId, 'memory-plugin-installations'),
  externalMemoryConnections: (orgId: string | null | undefined) => consoleKey(orgId, 'external-memory-connections'),
  members: (orgId: string | null | undefined) => consoleKey(orgId, 'members'),
  serviceAccountMembers: (orgId: string | null | undefined) => consoleKey(orgId, 'serviceAccountMembers'),
  serviceAccounts: (orgId: string | null | undefined) => consoleKey(orgId, 'service-accounts'),
  serviceAccountKeys: (orgId: string | null | undefined, id: string) => consoleKey(orgId, 'service-account-keys', id),
  inviteLink: (orgId: string | null | undefined) => consoleKey(orgId, 'invite-link'),
  orgSso: (orgId: string | null | undefined) => consoleKey(orgId, 'org-sso'),
  sessionAccess: <
    const Provider extends
      'slack' | 'github' | 'gitlab' | 'feishu' | 'telegram' | 'discord' | 'googlechat' | 'msteams' | 'mattermost'
  >(
    orgId: string | null | undefined,
    provider: Provider
  ) => consoleKey(orgId, 'session-access', provider),
  /** `source` is a REQUEST parameter (the CP scopes the whole aggregate to one metering
   *  ingress), so it keys apart from the unscoped read rather than being filtered out of it. */
  usage: <const Range extends string, const Source extends string = 'all'>(
    orgId: string | null | undefined,
    range: Range,
    source: Source = 'all' as Source
  ) => consoleKey(orgId, 'usage', range, source),
  /** Billing rows come from the separate billing service (lib/billing-api), but they
   *  are org-scoped like everything else here, so they key the same way. */
  billingAccount: (orgId: string | null | undefined) => consoleKey(orgId, 'billing-account'),
  /** `side` is a REQUEST parameter — the service narrows the keyset feed to one ledger side —
   *  so each side is its own page one with its own cursor, not a filter over a shared cache. */
  billingTransactions: <const Side extends string = 'all'>(
    orgId: string | null | undefined,
    side: Side = 'all' as Side
  ) => consoleKey(orgId, 'billing-transactions', side),
  /** The credit rows of the last 30 days — paged out of the same feed, so it keys apart
   *  from the first page `billingTransactions` serves the Billing table. */
  billingTopUps: (orgId: string | null | undefined) => consoleKey(orgId, 'billing-top-ups'),
  /** The Activity chart's window, keyed per range: a wider range is not a superset it can
   *  slice, because the page cap truncates a long ledger and a 90-day answer may already
   *  have lost days a 24-hour answer carries in full. */
  billingActivity: <const Range extends string>(orgId: string | null | undefined, range: Range) =>
    consoleKey(orgId, 'billing-activity', range),
  billingSubscription: (orgId: string | null | undefined) => consoleKey(orgId, 'billing-subscription'),
  billingPlans: (orgId: string | null | undefined) => consoleKey(orgId, 'billing-plans'),
  /** The Increase-limit preview's quote, per target option. */
  billingUpgradeQuote: (orgId: string | null | undefined, tierId: string, optionId: string) =>
    consoleKey(orgId, 'billing-upgrade-quote', tierId, optionId),
  sessionMonthUsage: (orgId: string | null | undefined) => consoleKey(orgId, 'usage-sessions'),
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
    view: string,
    tasks: string,
    dreams: string
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
      view,
      tasks,
      dreams
    ),
  sessionFacets: (
    orgId: string | null | undefined,
    agentId: string,
    integration: string,
    platform: string,
    channel: string,
    triggeredBy: string,
    githubRepoId: string,
    tasks = '',
    dreams = ''
  ) =>
    consoleKey(
      orgId,
      'session-facets',
      agentId,
      integration,
      platform,
      channel,
      triggeredBy,
      githubRepoId,
      tasks,
      dreams
    ),
  sessionDetail: (orgId: string | null | undefined, sessionId: string | null | undefined) =>
    sessionId ? consoleKey(orgId, 'session-detail', sessionId) : null,
  cronRuns: (orgId: string | null | undefined, cronId: string) => consoleKey(orgId, 'cron-runs', cronId),
  agentHooks: (orgId: string | null | undefined, agentId: string | null | undefined) =>
    agentId ? consoleKey(orgId, 'agent-hooks', agentId) : null,
  agentApi: (orgId: string | null | undefined, agentId: string | null | undefined) =>
    agentId ? consoleKey(orgId, 'agent-api', agentId) : null,
  // Every Agent chat key the caller can see: their own, plus each service account's for an owner.
  agentChatKeys: (orgId: string | null | undefined, owner: boolean) =>
    consoleKey(orgId, 'agent-chat-keys', owner ? 'owner' : 'member'),
  // Per-repository list reached through one hook row (the settings dialog's).
  hookTrustedActors: (orgId: string | null | undefined, hookId: string | null | undefined) =>
    hookId ? consoleKey(orgId, 'hook-trusted-actors', hookId) : null,
  agentRepos: (orgId: string | null | undefined, agentId: string | null | undefined) =>
    agentId ? consoleKey(orgId, 'agent-repos', agentId) : null,
  agentInstallations: (orgId: string | null | undefined, agentId: string | null | undefined) =>
    agentId ? consoleKey(orgId, 'agent-installations', agentId) : null,
  /** The Integrations card's bot roster. The bound-project signature is part of the key, so
   *  binding or removing a project makes the entry recorded under the old set unreachable. */
  gitlabAccounts: (orgId: string | null | undefined, bindings: string) =>
    consoleKey(orgId, 'gitlab-accounts', bindings),
  agentPermissionRequests: (orgId: string | null | undefined, agentId: string | null | undefined) =>
    agentId ? consoleKey(orgId, 'agent-permission-requests', agentId) : null,
  /** One webchat conversation's requests, as its owner reads them. */
  sessionPermissionRequests: (orgId: string | null | undefined, sessionId: string) =>
    consoleKey(orgId, 'session-permission-requests', sessionId),
  assistantSubsessions: (orgId: string | null | undefined, agentId: string) =>
    consoleKey(orgId, 'assistant-subsessions', agentId),
  /** One task's row, for its own page. */
  assistantSubsession: (orgId: string | null | undefined, agentId: string, sessionId: string) =>
    consoleKey(orgId, 'assistant-subsession', agentId, sessionId),
  assistantDrafts: (orgId: string | null | undefined, agentId: string) =>
    consoleKey(orgId, 'assistant-drafts', agentId),
  /** One webchat conversation's proposals, for its pending-requests strip. */
  assistantConversationProposals: (orgId: string | null | undefined, agentId: string, sessionId: string) =>
    consoleKey(orgId, 'assistant-conversation-proposals', agentId, sessionId),
  /** The org's sessions waiting on an approval — the bell's feed (slack-approval-dm.md §7). */
  pendingApprovals: (orgId: string | null | undefined) => consoleKey(orgId, 'session-approvals'),
  hookRuns: (orgId: string | null | undefined, hookId: string) => consoleKey(orgId, 'hook-runs', hookId)
}

export const profileKeys = {
  apiKeys: ['profile', 'api-keys'] as const
}
