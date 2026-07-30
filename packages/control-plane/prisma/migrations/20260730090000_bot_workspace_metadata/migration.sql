-- Display-only external workspace metadata for grouping bot identities in the
-- Console. Keep it separate from bot.teamId: teamId is also a platform-app
-- admission/demux marker, while custom Slack apps need workspace labels without
-- changing those semantics.
ALTER TABLE "bot"
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "workspaceName" TEXT;

-- A Settings reauthorization is bound to an existing bot rather than a target
-- agent. Keeping agentId nullable lets a freed bot rotate its workspace
-- credential without silently reattaching it to the default preset agent.
ALTER TABLE "slack_platform_install"
  ALTER COLUMN "agentId" DROP NOT NULL;

-- Tie each revoked membership to the credential generation whose uninstall
-- revoked it. A later Settings reauthorization can then revive only the
-- memberships from the credential it replaces, while a deliberately freed bot
-- (whose integration row was deleted) stays free.
ALTER TABLE "integration"
  ADD COLUMN "revokedCredentialRevision" INTEGER;

-- Preserve the currently revoked membership set on upgrades. Prisma stamps an
-- integration's updatedAt when the same revoke transaction flips it, so this
-- excludes older revoked history (and a later revoke of an already-free bot).
UPDATE "integration" AS i
SET "revokedCredentialRevision" = b."credentialRevision"
FROM "bot" AS b
WHERE
  i."botId" = b."id"
  AND i."status" = 'revoked'
  AND b."revokedAt" IS NOT NULL
  AND i."updatedAt" >= b."revokedAt";

-- Existing platform-app rows already have the stable workspace id, and their
-- generated name carries the OAuth team name. This makes current installations
-- groupable immediately; custom legacy apps converge through the existing Slack
-- identity reconciliation loop.
UPDATE "bot"
SET
  "workspaceId" = "teamId",
  "workspaceName" = CASE
    WHEN "prebuilt" = TRUE AND "name" LIKE 'AgentConnect (%)'
      THEN substring("name" FROM 15 FOR char_length("name") - 15)
    ELSE NULL
  END
WHERE "teamId" IS NOT NULL;
