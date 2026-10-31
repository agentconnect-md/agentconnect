-- Removes agents' dedicated GitHub Apps (20261222000000_github_apps, 20261223000000_github_app_webhook) after their revert.
-- Their installations go first: without the column they would read as the deployment App's.
DELETE FROM "github_installation" WHERE "githubAppId" IS NOT NULL;

ALTER TABLE "agent" DROP CONSTRAINT "agent_githubAppId_fkey";
DROP INDEX "agent_githubAppId_key";
ALTER TABLE "agent" DROP COLUMN "githubAppId";

ALTER TABLE "github_installation" DROP CONSTRAINT "github_installation_githubAppId_fkey";
DROP INDEX "github_installation_githubAppId_idx";
ALTER TABLE "github_installation" DROP COLUMN "githubAppId";

DROP TABLE "github_app_secret";
DROP TABLE "github_app";
