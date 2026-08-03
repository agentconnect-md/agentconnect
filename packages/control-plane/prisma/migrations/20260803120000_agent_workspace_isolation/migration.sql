CREATE TYPE "WorkspaceIsolation" AS ENUM ('shared', 'session');

ALTER TABLE "agent"
ADD COLUMN "workspaceIsolation" "WorkspaceIsolation" NOT NULL DEFAULT 'shared';
