-- AgentConnect v1 clear-install baseline.
--
-- Pre-v1 migrations were intentionally squashed before the first stable
-- release. This migration targets an empty PostgreSQL database; databases
-- created from release candidates must be reset instead of upgraded in place.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."AcpSupport" AS ENUM ('full', 'partial', 'none');

-- CreateEnum
CREATE TYPE "public"."ActivityState" AS ENUM ('thinking', 'tool_call', 'awaiting_permission', 'idle');

-- CreateEnum
CREATE TYPE "public"."AgentCallPolicy" AS ENUM ('all', 'selected');

-- CreateEnum
CREATE TYPE "public"."AgentStatus" AS ENUM ('active', 'inactive', 'paused');

-- CreateEnum
CREATE TYPE "public"."AssignmentState" AS ENUM ('active', 'draining', 'released', 'frozen');

-- CreateEnum
CREATE TYPE "public"."AuditKind" AS ENUM ('daemon_auth', 'daemon_register', 'daemon_unreachable', 'route_assign', 'route_release', 'drain', 'agent_launch', 'agent_stop', 'scope_denied', 'secret_grant', 'secret_revoke', 'cron_change', 'protocol_error', 'api_key_create', 'api_key_rotate', 'api_key_revoke', 'hook_change', 'agent_repo_change', 'mcp_tool_call');

-- CreateEnum
CREATE TYPE "public"."ChannelTrigger" AS ENUM ('mention', 'any');

-- CreateEnum
CREATE TYPE "public"."CronRunStatus" AS ENUM ('running', 'success', 'failed');

-- CreateEnum
CREATE TYPE "public"."DaemonStatus" AS ENUM ('provisioned', 'authenticating', 'ready', 'draining', 'unreachable', 'disabled');

-- CreateEnum
CREATE TYPE "public"."GitAccess" AS ENUM ('read', 'write');

-- CreateEnum
CREATE TYPE "public"."HealthState" AS ENUM ('ok', 'degraded');

-- CreateEnum
CREATE TYPE "public"."HookGateMode" AS ENUM ('informational', 'required');

-- CreateEnum
CREATE TYPE "public"."HookKind" AS ENUM ('webhook', 'github');

-- CreateEnum
CREATE TYPE "public"."HookReportingMode" AS ENUM ('off', 'check', 'status');

-- CreateEnum
CREATE TYPE "public"."HookReviewPolicy" AS ENUM ('off', 'comment', 'request_changes', 'full');

-- CreateEnum
CREATE TYPE "public"."HookSessionMode" AS ENUM ('perDelivery', 'perThread', 'shared');

-- CreateEnum
CREATE TYPE "public"."IntegrationStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "public"."LaunchMode" AS ENUM ('long_lived', 'per_turn');

-- CreateEnum
CREATE TYPE "public"."LaunchStatus" AS ENUM ('launching', 'running', 'stopped', 'crashed');

-- CreateEnum
CREATE TYPE "public"."LeaseStatus" AS ENUM ('active', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "public"."OrgRole" AS ENUM ('owner', 'collaborator', 'viewer');

-- CreateEnum
CREATE TYPE "public"."Platform" AS ENUM ('slack', 'telegram', 'discord');

-- CreateEnum
CREATE TYPE "public"."PrincipalType" AS ENUM ('daemon', 'user', 'relay', 'oauth');

-- CreateEnum
CREATE TYPE "public"."RepoAccess" AS ENUM ('read', 'comment', 'write');

-- CreateEnum
CREATE TYPE "public"."ResourceVisibility" AS ENUM ('org', 'restricted');

-- CreateEnum
CREATE TYPE "public"."SessionPhase" AS ENUM ('start', 'plan', 'problem', 'end');

-- CreateEnum
CREATE TYPE "public"."WorkspaceMode" AS ENUM ('scratch', 'github');

-- CreateTable
CREATE TABLE "public"."agent" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "runtime" TEXT NOT NULL,
    "status" "public"."AgentStatus" NOT NULL DEFAULT 'inactive',
    "daemonId" UUID,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "runtimeOverrides" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "description" TEXT,
    "workspaceMode" "public"."WorkspaceMode" NOT NULL DEFAULT 'scratch',
    "gitRepo" TEXT,
    "gitBranch" TEXT DEFAULT 'main',
    "agentDir" TEXT,
    "createdByUserId" TEXT,
    "displayName" TEXT,
    "lastModifiedByUserId" TEXT,
    "lastModifiedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visibility" "public"."ResourceVisibility" NOT NULL DEFAULT 'org',
    "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "installationId" TEXT,
    "gitAccess" "public"."GitAccess" NOT NULL DEFAULT 'write',
    "callPolicy" "public"."AgentCallPolicy" NOT NULL DEFAULT 'all',
    "allowedCallerAgentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "workspaceRepoId" BIGINT,
    "icon" JSONB,

    CONSTRAINT "agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_launch" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "daemonId" UUID NOT NULL,
    "runtime" TEXT NOT NULL,
    "mode" "public"."LaunchMode" NOT NULL DEFAULT 'long_lived',
    "acpSessionId" TEXT,
    "activeCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "public"."LaunchStatus" NOT NULL DEFAULT 'launching',
    "launchEpoch" BIGINT NOT NULL,
    "startedAt" TIMESTAMPTZ(6),
    "stoppedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_launch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_repo_authorization" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "repoId" BIGINT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "access" "public"."RepoAccess" NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_repo_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."api_key" (
    "id" TEXT NOT NULL,
    "principalType" "public"."PrincipalType" NOT NULL,
    "orgId" TEXT,
    "daemonId" UUID,
    "userId" TEXT,
    "hash" TEXT NOT NULL,
    "displayTail" TEXT NOT NULL,
    "name" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" TEXT,
    "oauthGrantId" TEXT,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."app_user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "oidcSubject" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "picture" TEXT,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."assignment" (
    "id" TEXT NOT NULL,
    "platform" "public"."Platform" NOT NULL,
    "channel" TEXT NOT NULL,
    "thread" TEXT,
    "agentId" UUID NOT NULL,
    "daemonId" UUID,
    "workspaceId" TEXT NOT NULL,
    "assignedEpoch" BIGINT NOT NULL,
    "assignedSeq" BIGINT,
    "routingEpoch" BIGINT NOT NULL,
    "state" "public"."AssignmentState" NOT NULL DEFAULT 'active',
    "bindRules" JSONB NOT NULL DEFAULT '[]',
    "releasedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "threadKey" TEXT NOT NULL GENERATED ALWAYS AS (COALESCE("thread", '')) STORED,

    CONSTRAINT "assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."audit_event" (
    "id" BIGSERIAL NOT NULL,
    "orgId" TEXT,
    "kind" "public"."AuditKind" NOT NULL,
    "daemonId" UUID,
    "agentId" UUID,
    "sessionId" UUID,
    "actorUserId" TEXT,
    "frameType" TEXT,
    "frameCorr" UUID,
    "message" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."bot" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "platform" "public"."Platform" NOT NULL DEFAULT 'slack',
    "name" TEXT NOT NULL,
    "prebuilt" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "lastUsedAt" TIMESTAMPTZ(6),
    "lastAgentName" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "slackAppId" TEXT,
    "shareable" BOOLEAN NOT NULL DEFAULT false,
    "relayId" UUID,
    "discordAppId" TEXT,

    CONSTRAINT "bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."bot_secret" (
    "botId" UUID NOT NULL,
    "botToken" TEXT NOT NULL,
    "appToken" TEXT,

    CONSTRAINT "bot_secret_pkey" PRIMARY KEY ("botId")
);

-- CreateTable
CREATE TABLE "public"."cron_def" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID,
    "schedule" TEXT NOT NULL,
    "targetPlatform" "public"."Platform" NOT NULL DEFAULT 'slack',
    "targetChannel" TEXT,
    "trigger" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "targetIntegrationId" UUID,
    "createdByUserId" TEXT,
    "name" TEXT,
    "lastModifiedByUserId" TEXT,
    "lastModifiedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visibility" "public"."ResourceVisibility" NOT NULL DEFAULT 'org',
    "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "cron_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."cron_run" (
    "id" TEXT NOT NULL,
    "cronId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "public"."CronRunStatus" NOT NULL DEFAULT 'running',
    "durationMs" INTEGER,
    "sessionId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cron_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."daemon" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "host" TEXT,
    "agentVersion" TEXT,
    "machineId" UUID,
    "tokenFp" TEXT,
    "attestationFp" TEXT,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "maxAgents" INTEGER NOT NULL DEFAULT 0,
    "sessionEpoch" BIGINT NOT NULL DEFAULT 0,
    "routingEpoch" BIGINT NOT NULL DEFAULT 0,
    "status" "public"."DaemonStatus" NOT NULL DEFAULT 'provisioned',
    "health" "public"."HealthState" NOT NULL DEFAULT 'ok',
    "load" JSONB,
    "activeSessions" INTEGER NOT NULL DEFAULT 0,
    "degradedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSeenAt" TIMESTAMPTZ(6),
    "unreachableAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "name" TEXT,
    "createdByUserId" TEXT,
    "lastModifiedByUserId" TEXT,
    "lastModifiedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visibility" "public"."ResourceVisibility" NOT NULL DEFAULT 'org',
    "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "mcpServers" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "daemon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."github_install_state" (
    "nonce" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_install_state_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "public"."github_installation" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "repositorySelection" TEXT NOT NULL,
    "suspendedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "github_installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hook_def" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID,
    "kind" "public"."HookKind" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sessionMode" "public"."HookSessionMode" NOT NULL,
    "urlToken" TEXT,
    "repoId" BIGINT,
    "repoFullName" TEXT,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "labelFilter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mentionOnly" BOOLEAN NOT NULL DEFAULT false,
    "targetPlatform" "public"."Platform" NOT NULL DEFAULT 'slack',
    "targetChannel" TEXT,
    "targetIntegrationId" UUID,
    "lastFiredAt" TIMESTAMPTZ(6),
    "createdByUserId" TEXT,
    "lastModifiedByUserId" TEXT,
    "lastModifiedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "commentFamilies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "configRevision" BIGINT NOT NULL DEFAULT 1,
    "dispatchRevision" BIGINT NOT NULL DEFAULT 1,
    "projectionEpoch" BIGINT NOT NULL DEFAULT 1,
    "reviewPolicy" "public"."HookReviewPolicy" NOT NULL DEFAULT 'off',
    "reportingMode" "public"."HookReportingMode" NOT NULL DEFAULT 'off',
    "gateMode" "public"."HookGateMode" NOT NULL DEFAULT 'informational',
    "requiredAcknowledgedAt" TIMESTAMPTZ(6),
    "requiredAcknowledgedByUserId" TEXT,
    "requiredAcknowledgedConfigRevision" BIGINT,

    CONSTRAINT "hook_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hook_review_projection" (
    "id" UUID NOT NULL,
    "hookId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "lastResolvedInstallationId" BIGINT,
    "repoId" BIGINT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "reportSha" TEXT NOT NULL,
    "projectionEpoch" BIGINT NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "currentHookRunId" TEXT,
    "externalId" TEXT NOT NULL,
    "checkRunId" TEXT,
    "mode" "public"."HookReportingMode" NOT NULL,
    "gateMode" "public"."HookGateMode" NOT NULL,
    "desiredState" TEXT NOT NULL,
    "observedState" TEXT,
    "sealedThrough" BIGINT NOT NULL DEFAULT 0,
    "subjectSyncGeneration" BIGINT NOT NULL DEFAULT 0,
    "subjectSyncErrorCode" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMPTZ(6),
    "nextAttemptAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "pendingIntent" JSONB,
    "writeMarker" TEXT,
    "writePhase" TEXT,
    "writeStartedAt" TIMESTAMPTZ(6),
    "tombstonedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "agentName" TEXT,

    CONSTRAINT "hook_review_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hook_review_subject" (
    "projectionId" UUID NOT NULL,
    "pullNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseSha" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hook_review_subject_pkey" PRIMARY KEY ("projectionId","pullNumber")
);

-- CreateTable
CREATE TABLE "public"."hook_run" (
    "id" TEXT NOT NULL,
    "hookId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "event" TEXT,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "public"."CronRunStatus" NOT NULL DEFAULT 'running',
    "durationMs" INTEGER,
    "sessionId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentId" UUID,
    "configRevision" BIGINT,
    "dispatchRevision" BIGINT,
    "projectionEpoch" BIGINT,
    "dispatchDaemonId" UUID,
    "reviewPolicySnapshot" "public"."HookReviewPolicy",
    "reportingModeSnapshot" "public"."HookReportingMode",
    "gateModeSnapshot" "public"."HookGateMode",
    "projectionIntent" TEXT,
    "repoId" BIGINT,
    "repoFullName" TEXT,
    "sourceInstallationId" BIGINT,
    "subjectKind" TEXT,
    "pullNumber" INTEGER,
    "headSha" TEXT,
    "baseSha" TEXT,
    "reportSha" TEXT,
    "isDraft" BOOLEAN,
    "baseChanged" BOOLEAN,
    "turnStartedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "orphanedAt" TIMESTAMPTZ(6),
    "projectionId" UUID,
    "projectionGeneration" BIGINT,
    "reviewAttemptId" UUID,
    "reviewAttemptState" TEXT,
    "reviewErrorCode" TEXT,
    "reviewId" TEXT,
    "reviewEvent" TEXT,
    "verdict" TEXT,
    "reviewCommitId" TEXT,
    "redeliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "redeliveryLastRequestedAt" TIMESTAMPTZ(6),
    "redeliveryNextAttemptAt" TIMESTAMPTZ(6),

    CONSTRAINT "hook_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hook_secret" (
    "hookId" UUID NOT NULL,
    "hmacSecret" TEXT NOT NULL,

    CONSTRAINT "hook_secret_pkey" PRIMARY KEY ("hookId")
);

-- CreateTable
CREATE TABLE "public"."integration" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "platform" "public"."Platform" NOT NULL DEFAULT 'slack',
    "name" TEXT NOT NULL,
    "status" "public"."IntegrationStatus" NOT NULL DEFAULT 'active',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "botId" UUID NOT NULL,

    CONSTRAINT "integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."integration_channel" (
    "integrationId" UUID NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "trigger" "public"."ChannelTrigger" NOT NULL DEFAULT 'mention',
    "firstSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "agentId" UUID,

    CONSTRAINT "integration_channel_pkey" PRIMARY KEY ("integrationId","channelId")
);

-- CreateTable
CREATE TABLE "public"."membership" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "public"."OrgRole" NOT NULL DEFAULT 'collaborator',

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."oauth_client" (
    "clientId" TEXT NOT NULL,
    "clientName" TEXT,
    "redirectUris" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "grantTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "oauth_client_pkey" PRIMARY KEY ("clientId")
);

-- CreateTable
CREATE TABLE "public"."oauth_code" (
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL,
    "resource" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),

    CONSTRAINT "oauth_code_pkey" PRIMARY KEY ("codeHash")
);

-- CreateTable
CREATE TABLE "public"."oauth_grant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "resource" TEXT,
    "rtHash" TEXT,
    "prevRtHash" TEXT,
    "rtExpiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "oauth_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."org" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."relay" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "daemonUrl" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."runtime_profile" (
    "id" TEXT NOT NULL,
    "daemonId" UUID NOT NULL,
    "runtime" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contextWindow" INTEGER,
    "acpSupport" "public"."AcpSupport" NOT NULL DEFAULT 'none',
    "toolCalling" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acpProtocolVersion" INTEGER,
    "mcpCapabilities" JSONB,

    CONSTRAINT "runtime_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."secret_lease" (
    "id" UUID NOT NULL,
    "daemonId" UUID NOT NULL,
    "scopePlatform" "public"."Platform" NOT NULL,
    "scopeWorkspaceId" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "ttlSec" INTEGER NOT NULL,
    "renewBeforeSec" INTEGER NOT NULL DEFAULT 60,
    "status" "public"."LeaseStatus" NOT NULL DEFAULT 'active',
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedReason" TEXT,

    CONSTRAINT "secret_lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."session_meta" (
    "id" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "launchId" UUID,
    "platform" TEXT,
    "channel" TEXT,
    "thread" TEXT,
    "phase" "public"."SessionPhase" NOT NULL DEFAULT 'start',
    "link" TEXT,
    "summary" TEXT,
    "activityState" "public"."ActivityState" NOT NULL DEFAULT 'idle',
    "lastActivityAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "title" TEXT,
    "status" TEXT,
    "triggeredBy" TEXT,
    "channelName" TEXT,
    "triggeredByName" TEXT,
    "threadUrl" TEXT,
    "runtime" TEXT,
    "model" TEXT,
    "effort" TEXT,
    "fastMode" BOOLEAN,
    "permissionMode" TEXT,
    "outputMode" TEXT,
    "daemonId" UUID,

    CONSTRAINT "session_meta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."session_usage" (
    "agentId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "platform" TEXT,
    "channel" TEXT,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "thoughtTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "contextUsed" INTEGER,
    "contextSize" INTEGER,
    "costAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costCurrency" TEXT,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "session_usage_pkey" PRIMARY KEY ("agentId","sessionId")
);

-- CreateTable
CREATE TABLE "public"."slack_install" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "appId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "botToken" TEXT,
    "name" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_install_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."slack_user_config" (
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "accessExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "slack_user_config_pkey" PRIMARY KEY ("orgId","userId")
);

-- CreateIndex
CREATE INDEX "agent_allowedCallerAgentIds_gin_idx" ON "public"."agent" USING GIN ("allowedCallerAgentIds");

-- CreateIndex
CREATE INDEX "agent_daemonId_idx" ON "public"."agent"("daemonId" ASC);

-- CreateIndex
CREATE INDEX "agent_orgId_idx" ON "public"."agent"("orgId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "agent_orgId_name_key" ON "public"."agent"("orgId" ASC, "name" ASC);

-- CreateIndex
CREATE INDEX "agent_sharedWith_gin_idx" ON "public"."agent" USING GIN ("sharedWith");

-- CreateIndex
CREATE INDEX "agent_launch_agentId_status_idx" ON "public"."agent_launch"("agentId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "agent_launch_daemonId_idx" ON "public"."agent_launch"("daemonId" ASC);

-- CreateIndex
CREATE INDEX "agent_repo_authorization_agentId_idx" ON "public"."agent_repo_authorization"("agentId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "agent_repo_authorization_agentId_repoId_key" ON "public"."agent_repo_authorization"("agentId" ASC, "repoId" ASC);

-- CreateIndex
CREATE INDEX "api_key_daemonId_idx" ON "public"."api_key"("daemonId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "api_key_hash_key" ON "public"."api_key"("hash" ASC);

-- CreateIndex
CREATE INDEX "api_key_oauthGrantId_idx" ON "public"."api_key"("oauthGrantId" ASC);

-- CreateIndex
CREATE INDEX "api_key_orgId_revokedAt_idx" ON "public"."api_key"("orgId" ASC, "revokedAt" ASC);

-- CreateIndex
CREATE INDEX "api_key_userId_idx" ON "public"."api_key"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "public"."app_user"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_oidcSubject_key" ON "public"."app_user"("oidcSubject" ASC);

-- CreateIndex
CREATE INDEX "assignment_agentId_idx" ON "public"."assignment"("agentId" ASC);

-- CreateIndex
CREATE INDEX "assignment_daemonId_state_idx" ON "public"."assignment"("daemonId" ASC, "state" ASC);

-- CreateIndex
CREATE INDEX "assignment_platform_channel_threadKey_idx" ON "public"."assignment"("platform" ASC, "channel" ASC, "threadKey" ASC);

-- CreateIndex
-- At most one live assignment may own a platform session. This partial
-- unique index and the generated threadKey column above are not faithfully
-- expressible by Prisma schema/introspection, so keep both hand-edited.
CREATE UNIQUE INDEX "assignment_session_active_uq"
    ON "public"."assignment"("platform" ASC, "channel" ASC, "threadKey" ASC)
    WHERE "state" IN ('active', 'draining', 'frozen');

-- CreateIndex
CREATE INDEX "audit_event_daemonId_createdAt_idx" ON "public"."audit_event"("daemonId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "audit_event_kind_createdAt_idx" ON "public"."audit_event"("kind" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "audit_event_orgId_createdAt_idx" ON "public"."audit_event"("orgId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "bot_orgId_idx" ON "public"."bot"("orgId" ASC);

-- CreateIndex
CREATE INDEX "bot_relayId_idx" ON "public"."bot"("relayId" ASC);

-- CreateIndex
CREATE INDEX "cron_def_agentId_idx" ON "public"."cron_def"("agentId" ASC);

-- CreateIndex
CREATE INDEX "cron_def_orgId_idx" ON "public"."cron_def"("orgId" ASC);

-- CreateIndex
CREATE INDEX "cron_def_sharedWith_gin_idx" ON "public"."cron_def" USING GIN ("sharedWith");

-- CreateIndex
CREATE INDEX "cron_def_targetIntegrationId_idx" ON "public"."cron_def"("targetIntegrationId" ASC);

-- CreateIndex
CREATE INDEX "cron_run_cronId_startedAt_idx" ON "public"."cron_run"("cronId" ASC, "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cron_run_cronId_startedAt_key" ON "public"."cron_run"("cronId" ASC, "startedAt" ASC);

-- CreateIndex
CREATE INDEX "daemon_lastSeenAt_idx" ON "public"."daemon"("lastSeenAt" ASC);

-- CreateIndex
CREATE INDEX "daemon_orgId_idx" ON "public"."daemon"("orgId" ASC);

-- CreateIndex
CREATE INDEX "daemon_sharedWith_gin_idx" ON "public"."daemon" USING GIN ("sharedWith");

-- CreateIndex
CREATE INDEX "daemon_status_idx" ON "public"."daemon"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "github_installation_installationId_key" ON "public"."github_installation"("installationId" ASC);

-- CreateIndex
CREATE INDEX "github_installation_orgId_idx" ON "public"."github_installation"("orgId" ASC);

-- CreateIndex
CREATE INDEX "hook_def_agentId_idx" ON "public"."hook_def"("agentId" ASC);

-- CreateIndex
CREATE INDEX "hook_def_kind_repoId_idx" ON "public"."hook_def"("kind" ASC, "repoId" ASC);

-- CreateIndex
CREATE INDEX "hook_def_orgId_idx" ON "public"."hook_def"("orgId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "hook_def_urlToken_key" ON "public"."hook_def"("urlToken" ASC);

-- CreateIndex
CREATE INDEX "hook_review_projection_agentId_repoId_idx" ON "public"."hook_review_projection"("agentId" ASC, "repoId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "hook_review_projection_checkRunId_key" ON "public"."hook_review_projection"("checkRunId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "hook_review_projection_externalId_key" ON "public"."hook_review_projection"("externalId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "hook_review_projection_hookId_repoId_reportSha_projectionEpoch_" ON "public"."hook_review_projection"("hookId" ASC, "repoId" ASC, "reportSha" ASC, "projectionEpoch" ASC);

-- CreateIndex
CREATE INDEX "hook_review_projection_lastResolvedInstallationId_idx" ON "public"."hook_review_projection"("lastResolvedInstallationId" ASC);

-- CreateIndex
CREATE INDEX "hook_review_projection_nextAttemptAt_leaseUntil_idx" ON "public"."hook_review_projection"("nextAttemptAt" ASC, "leaseUntil" ASC);

-- CreateIndex
CREATE INDEX "hook_review_projection_orgId_idx" ON "public"."hook_review_projection"("orgId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "hook_review_projection_writeMarker_key" ON "public"."hook_review_projection"("writeMarker" ASC);

-- CreateIndex
CREATE INDEX "hook_review_subject_headSha_idx" ON "public"."hook_review_subject"("headSha" ASC);

-- CreateIndex
CREATE INDEX "hook_run_deliveryKey_status_redeliveryNextAttemptAt_idx" ON "public"."hook_run"("deliveryKey" ASC, "status" ASC, "redeliveryNextAttemptAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "hook_run_hookId_deliveryKey_key" ON "public"."hook_run"("hookId" ASC, "deliveryKey" ASC);

-- CreateIndex
CREATE INDEX "hook_run_hookId_repoId_reportSha_startedAt_idx" ON "public"."hook_run"("hookId" ASC, "repoId" ASC, "reportSha" ASC, "startedAt" DESC);

-- CreateIndex
CREATE INDEX "hook_run_hookId_startedAt_idx" ON "public"."hook_run"("hookId" ASC, "startedAt" DESC);

-- CreateIndex
CREATE INDEX "hook_run_orgId_idx" ON "public"."hook_run"("orgId" ASC);

-- CreateIndex
CREATE INDEX "hook_run_projectionId_projectionGeneration_idx" ON "public"."hook_run"("projectionId" ASC, "projectionGeneration" ASC);

-- CreateIndex
CREATE INDEX "hook_run_redelivery_due_idx" ON "public"."hook_run"("status" ASC, "redeliveryNextAttemptAt" ASC, "redeliveryAttempts" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "hook_run_reviewAttemptId_key" ON "public"."hook_run"("reviewAttemptId" ASC);

-- CreateIndex
CREATE INDEX "hook_run_status_startedAt_idx" ON "public"."hook_run"("status" ASC, "startedAt" ASC);

-- CreateIndex
CREATE INDEX "integration_agentId_idx" ON "public"."integration"("agentId" ASC);

-- CreateIndex
CREATE INDEX "integration_botId_idx" ON "public"."integration"("botId" ASC);

-- CreateIndex
CREATE INDEX "integration_orgId_idx" ON "public"."integration"("orgId" ASC);

-- CreateIndex
CREATE INDEX "integration_channel_agentId_idx" ON "public"."integration_channel"("agentId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "membership_orgId_userId_key" ON "public"."membership"("orgId" ASC, "userId" ASC);

-- CreateIndex
CREATE INDEX "membership_userId_idx" ON "public"."membership"("userId" ASC);

-- CreateIndex
CREATE INDEX "oauth_client_expiresAt_idx" ON "public"."oauth_client"("expiresAt" ASC);

-- CreateIndex
CREATE INDEX "oauth_code_expiresAt_idx" ON "public"."oauth_code"("expiresAt" ASC);

-- CreateIndex
CREATE INDEX "oauth_grant_prevRtHash_idx" ON "public"."oauth_grant"("prevRtHash" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_grant_rtHash_key" ON "public"."oauth_grant"("rtHash" ASC);

-- CreateIndex
CREATE INDEX "oauth_grant_userId_idx" ON "public"."oauth_grant"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "org_slug_key" ON "public"."org"("slug" ASC);

-- CreateIndex
CREATE INDEX "relay_lastSeenAt_idx" ON "public"."relay"("lastSeenAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "relay_name_key" ON "public"."relay"("name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "runtime_profile_daemonId_runtime_key" ON "public"."runtime_profile"("daemonId" ASC, "runtime" ASC);

-- CreateIndex
CREATE INDEX "secret_lease_daemonId_status_idx" ON "public"."secret_lease"("daemonId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "secret_lease_status_expiresAt_idx" ON "public"."secret_lease"("status" ASC, "expiresAt" ASC);

-- CreateIndex
CREATE INDEX "session_meta_agentId_lastActivityAt_idx" ON "public"."session_meta"("agentId" ASC, "lastActivityAt" ASC);

-- CreateIndex
CREATE INDEX "session_meta_agentId_startedAt_idx" ON "public"."session_meta"("agentId" ASC, "startedAt" ASC);

-- CreateIndex
CREATE INDEX "session_meta_daemonId_idx" ON "public"."session_meta"("daemonId" ASC);

-- CreateIndex
CREATE INDEX "session_meta_launchId_idx" ON "public"."session_meta"("launchId" ASC);

-- CreateIndex
CREATE INDEX "session_meta_platform_channel_idx" ON "public"."session_meta"("platform" ASC, "channel" ASC);

-- CreateIndex
CREATE INDEX "session_usage_agentId_lastActivityAt_idx" ON "public"."session_usage"("agentId" ASC, "lastActivityAt" ASC);

-- CreateIndex
CREATE INDEX "slack_install_createdAt_idx" ON "public"."slack_install"("createdAt" ASC);

-- AddForeignKey
ALTER TABLE "public"."agent" ADD CONSTRAINT "agent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent" ADD CONSTRAINT "agent_daemonId_fkey" FOREIGN KEY ("daemonId") REFERENCES "public"."daemon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent" ADD CONSTRAINT "agent_lastModifiedByUserId_fkey" FOREIGN KEY ("lastModifiedByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent" ADD CONSTRAINT "agent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_launch" ADD CONSTRAINT "agent_launch_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_launch" ADD CONSTRAINT "agent_launch_daemonId_fkey" FOREIGN KEY ("daemonId") REFERENCES "public"."daemon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_repo_authorization" ADD CONSTRAINT "agent_repo_authorization_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_repo_authorization" ADD CONSTRAINT "agent_repo_authorization_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."api_key" ADD CONSTRAINT "api_key_daemonId_fkey" FOREIGN KEY ("daemonId") REFERENCES "public"."daemon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."api_key" ADD CONSTRAINT "api_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."api_key" ADD CONSTRAINT "api_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."assignment" ADD CONSTRAINT "assignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."assignment" ADD CONSTRAINT "assignment_daemonId_fkey" FOREIGN KEY ("daemonId") REFERENCES "public"."daemon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bot" ADD CONSTRAINT "bot_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bot" ADD CONSTRAINT "bot_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bot_secret" ADD CONSTRAINT "bot_secret_botId_fkey" FOREIGN KEY ("botId") REFERENCES "public"."bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cron_def" ADD CONSTRAINT "cron_def_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cron_def" ADD CONSTRAINT "cron_def_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cron_def" ADD CONSTRAINT "cron_def_lastModifiedByUserId_fkey" FOREIGN KEY ("lastModifiedByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cron_def" ADD CONSTRAINT "cron_def_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cron_def" ADD CONSTRAINT "cron_def_targetIntegrationId_fkey" FOREIGN KEY ("targetIntegrationId") REFERENCES "public"."integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cron_run" ADD CONSTRAINT "cron_run_cronId_fkey" FOREIGN KEY ("cronId") REFERENCES "public"."cron_def"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."daemon" ADD CONSTRAINT "daemon_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."daemon" ADD CONSTRAINT "daemon_lastModifiedByUserId_fkey" FOREIGN KEY ("lastModifiedByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."daemon" ADD CONSTRAINT "daemon_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."github_installation" ADD CONSTRAINT "github_installation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hook_def" ADD CONSTRAINT "hook_def_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hook_def" ADD CONSTRAINT "hook_def_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hook_def" ADD CONSTRAINT "hook_def_lastModifiedByUserId_fkey" FOREIGN KEY ("lastModifiedByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hook_def" ADD CONSTRAINT "hook_def_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hook_def" ADD CONSTRAINT "hook_def_targetIntegrationId_fkey" FOREIGN KEY ("targetIntegrationId") REFERENCES "public"."integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hook_review_subject" ADD CONSTRAINT "hook_review_subject_projectionId_fkey" FOREIGN KEY ("projectionId") REFERENCES "public"."hook_review_projection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hook_secret" ADD CONSTRAINT "hook_secret_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "public"."hook_def"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."integration" ADD CONSTRAINT "integration_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."integration" ADD CONSTRAINT "integration_botId_fkey" FOREIGN KEY ("botId") REFERENCES "public"."bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."integration" ADD CONSTRAINT "integration_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."integration" ADD CONSTRAINT "integration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."integration_channel" ADD CONSTRAINT "integration_channel_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "public"."integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."membership" ADD CONSTRAINT "membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."membership" ADD CONSTRAINT "membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."runtime_profile" ADD CONSTRAINT "runtime_profile_daemonId_fkey" FOREIGN KEY ("daemonId") REFERENCES "public"."daemon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."secret_lease" ADD CONSTRAINT "secret_lease_daemonId_fkey" FOREIGN KEY ("daemonId") REFERENCES "public"."daemon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."session_meta" ADD CONSTRAINT "session_meta_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."session_meta" ADD CONSTRAINT "session_meta_daemonId_fkey" FOREIGN KEY ("daemonId") REFERENCES "public"."daemon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."session_meta" ADD CONSTRAINT "session_meta_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "public"."agent_launch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."session_usage" ADD CONSTRAINT "session_usage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."slack_user_config" ADD CONSTRAINT "slack_user_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."slack_user_config" ADD CONSTRAINT "slack_user_config_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
