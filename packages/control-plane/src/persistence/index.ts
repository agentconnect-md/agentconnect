/**
 * Persistence barrel (design §2 `persistence/`).
 *
 * The ONLY place above this directory should import is this barrel and
 * `persistence/ports.ts`. The concrete `Pg*Repo` classes are the sole importers
 * of `@prisma/client`; services depend on the port interfaces.
 */
export * from './ports.js'
export * from './errors.js'
export * from './deployment-config.js'
export { createPrisma, withTx, disconnectPrisma, type PrismaLike } from './prisma.js'

export { PgDaemonRepo } from './repositories/daemon.repo.js'
export { PgDaemonLifecycleOpRepo } from './repositories/daemon-lifecycle-op.repo.js'
export { PgApiKeyRepo } from './repositories/api-key.repo.js'
export { PgOAuthRepo } from './repositories/oauth.repo.js'
export { PgRelayRepo } from './repositories/relay.repo.js'
export { PgAgentRepo } from './repositories/agent.repo.js'
export { PgGithubInstallationRepo, PgGithubInstallStateStore } from './repositories/github.repo.js'
export { PgAgentRepoAuthorizationRepo } from './repositories/agent-repo-auth.repo.js'
export { PgCodeHostRepositoryRepo } from './repositories/code-host-repository.repo.js'
export { PgCodeHostRunProjectionRepo } from './repositories/code-host-projection.repo.js'
export {
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore,
  PgGitlabOauthStateStore,
  PgGitlabInstanceStateStore,
  PgGitlabAgentAccountRepo,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore
} from './repositories/gitlab.repo.js'
export { PgCodeHostReviewLeaseRepo } from './repositories/code-host-review.repo.js'
export { PgSocialIdentityMutationGate } from './repositories/social-identity-mutation.gate.js'
export { PgAssignmentRepo } from './repositories/assignment.repo.js'
export { PgSessionRepo } from './repositories/session.repo.js'
export { PgSessionPullRequestFeedbackRepo } from './repositories/session-pull-request-feedback.repo.js'
export { PgSessionUsageRepo } from './repositories/session-usage.repo.js'
export { PgWebchatConversationRepo } from './repositories/webchat-conversation.repo.js'
export { PgWebchatMcpDelegationRepo } from './repositories/webchat-mcp-delegation.repo.js'
export { PgWebchatMcpOperationRepo } from './repositories/webchat-mcp-operation.repo.js'
export { PgWebchatMcpAccessGrantRepo } from './repositories/webchat-mcp-access-grant.repo.js'
export { PgLaunchRepo } from './repositories/launch.repo.js'
export { PgSecretLeaseRepo } from './repositories/secret-lease.repo.js'
export { PgAgentSecretStore } from './repositories/agent-secret.repo.js'
export { PgAgentConfigWriter } from './repositories/agent-config.writer.js'
export { PgMemoryConnectionWriter } from './repositories/memory-connection.writer.js'
export { PgBotCredentialWriter } from './repositories/bot-credential.writer.js'
export {
  PgBotRepo,
  PgBotSecretStore,
  PgIntegrationRepo,
  PgIntegrationChannelRepo
} from './repositories/integration.repo.js'
export { PgMcpProviderRepo, PgMcpProviderSecretStore, PgMcpGrantRepo } from './repositories/mcp.repo.js'
export { PgSkillSourceRepo } from './repositories/skill-source.repo.js'
export { PgOrganizationKnowledgeRepo } from './repositories/organization-knowledge.repo.js'
export {
  PgOrganizationEnvironmentRepo,
  PgOrganizationEnvironmentResolver,
  PgOrganizationEnvironmentSecretStore
} from './repositories/organization-environment.repo.js'
export {
  PgMemoryPluginInstallationRepo,
  PgExternalMemoryConnectionRepo,
  PgExternalMemoryConnectionSecretStore,
  PgExternalMemoryGrantRepo
} from './repositories/memory-connection.repo.js'
export { PgThreadAffinityStore } from './repositories/thread-affinity.repo.js'
export { PgSlackInstallStore } from './repositories/slack-install.repo.js'
export { PgSlackPlatformInstallStore } from './repositories/slack-platform-install.repo.js'
export { PgFeishuAppRegistrationStore } from './repositories/feishu-app-registration.repo.js'
export { PgSlackUserConfigStore } from './repositories/slack-user-config.repo.js'
export { PgLinearTokenStore, PgLinearInstallStateStore } from './repositories/linear.repo.js'
export {
  GENERAL_PRESET,
  PRESET_AGENT_SKILLS,
  PRESET_SKILL_SOURCE,
  RESERVED_AGENT_SLUGS,
  PgPresetAgentStore,
  provisionPresetAgents
} from './preset-agents.js'
export type { PresetPoolPlacement } from './preset-agents.js'
export { PresetAgentBackfill } from './preset-agent-backfill.js'
export { PgCronRepo } from './repositories/cron.repo.js'
export { PgDutyGroupRepo } from './repositories/duty-group.repo.js'
export { PgMemberSetRepo } from './repositories/member-set.repo.js'
export { PgHookRepo, PgHookSecretStore } from './repositories/hook.repo.js'
export { PgRuntimeProfileRepo } from './repositories/runtime-profile.repo.js'
export { PgAuditRepo } from './repositories/audit.repo.js'
export { PgUserRepo } from './repositories/user.repo.js'
export { PgOrgRepo } from './repositories/org.repo.js'
export { PgOrgInviteLinkRepo } from './repositories/org-invite-link.repo.js'
export { PgWaitlistRepo } from './repositories/waitlist.repo.js'
export { PgDeploymentConfigRepository, PgDeploymentConfigStore } from './repositories/deployment-config.repo.js'
