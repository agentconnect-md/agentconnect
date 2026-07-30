-- Display-only external workspace metadata for grouping bot identities in the
-- Console. Keep it separate from bot.teamId: teamId is also a platform-app
-- admission/demux marker, while custom Slack apps need workspace labels without
-- changing those semantics.
ALTER TABLE "bot"
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "workspaceName" TEXT;

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
