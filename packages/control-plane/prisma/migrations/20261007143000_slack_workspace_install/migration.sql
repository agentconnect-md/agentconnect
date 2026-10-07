ALTER TABLE "slack_platform_install" ALTER COLUMN "orgId" DROP NOT NULL;

CREATE TABLE "slack_workspace_install" (
    "id" UUID NOT NULL,
    "appId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "teamName" TEXT,
    "botUserId" TEXT NOT NULL,
    "installerUserId" TEXT NOT NULL,
    "botToken" TEXT NOT NULL,
    "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "credentialRevision" INTEGER NOT NULL DEFAULT 1,
    "installedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "slack_workspace_install_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "slack_workspace_install_appId_teamId_key"
    ON "slack_workspace_install"("appId", "teamId");
