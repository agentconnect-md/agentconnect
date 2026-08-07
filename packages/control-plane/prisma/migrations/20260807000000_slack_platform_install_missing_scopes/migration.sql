-- Record WHICH required bot scopes a platform Slack app install failed to obtain.
-- The console polls this row for the install's outcome, and "reinstall the app"
-- is only actionable when the failure names the permissions that are absent.
ALTER TABLE "slack_platform_install"
  ADD COLUMN "missingScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
