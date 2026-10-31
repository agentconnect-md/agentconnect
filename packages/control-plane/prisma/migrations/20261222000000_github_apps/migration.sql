-- Agents' dedicated GitHub Apps beside the deployment App (github-app-git-credentials.md §Dedicated Apps).
CREATE TABLE "github_app" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "appId" BIGINT NOT NULL,
    "slug" TEXT NOT NULL,
    "clientId" TEXT,
    "botUserId" BIGINT,
    "retiredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "github_app_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "github_app_appId_key" ON "github_app"("appId");
CREATE UNIQUE INDEX "github_app_id_orgId_key" ON "github_app"("id", "orgId");
CREATE INDEX "github_app_orgId_idx" ON "github_app"("orgId");

ALTER TABLE "github_app" ADD CONSTRAINT "github_app_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "github_app_secret" (
    "githubAppId" UUID NOT NULL,
    "privateKey" TEXT NOT NULL,

    CONSTRAINT "github_app_secret_pkey" PRIMARY KEY ("githubAppId")
);

ALTER TABLE "github_app_secret" ADD CONSTRAINT "github_app_secret_githubAppId_fkey" FOREIGN KEY ("githubAppId") REFERENCES "github_app"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_installation" ADD COLUMN "githubAppId" UUID;
CREATE INDEX "github_installation_githubAppId_idx" ON "github_installation"("githubAppId");
ALTER TABLE "github_installation" ADD CONSTRAINT "github_installation_githubAppId_fkey" FOREIGN KEY ("githubAppId") REFERENCES "github_app"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent" ADD COLUMN "githubAppId" UUID;
CREATE UNIQUE INDEX "agent_githubAppId_key" ON "agent"("githubAppId");
ALTER TABLE "agent" ADD CONSTRAINT "agent_githubAppId_fkey" FOREIGN KEY ("githubAppId") REFERENCES "github_app"("id") ON DELETE SET NULL ON UPDATE CASCADE;
