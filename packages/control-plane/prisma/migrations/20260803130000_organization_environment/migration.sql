-- Organization-owned variables and secrets, plus the per-agent monotonic
-- configuration revision that makes full-map env/secret replacement safe.
-- Design: docs/designs/organization-secrets-and-variables.md
--
-- Fully additive: existing agents have no assignments, so their effective
-- env/secret maps are unchanged and every agent starts at revision 0.

CREATE TYPE "OrganizationEnvironmentKind" AS ENUM ('variable', 'secret');
CREATE TYPE "OrganizationEnvironmentAudience" AS ENUM ('all', 'selected');

-- One ordering domain per agent for every CP-owned field assembled into AgentSpec.
ALTER TABLE "agent"
  ADD COLUMN "configRevision" BIGINT NOT NULL DEFAULT 0;

-- The composite uniqueness the same-organization assignment foreign key needs.
-- It makes a cross-organization binding impossible even for an internal caller.
CREATE UNIQUE INDEX "agent_id_orgId_key" ON "agent"("id", "orgId");

CREATE TABLE "organization_environment_entry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "kind" "OrganizationEnvironmentKind" NOT NULL,
  "variableValue" TEXT,
  "audience" "OrganizationEnvironmentAudience" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdByUserId" TEXT,
  "lastModifiedByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "organization_environment_entry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_environment_entry_version_check" CHECK ("version" > 0),
  -- A variable carries its value inline; a secret's value lives only in the
  -- sibling table, so it must never be readable from this metadata row.
  CONSTRAINT "organization_environment_entry_variable_value_check"
    CHECK (("kind" = 'variable') OR ("variableValue" IS NULL)),
  CONSTRAINT "organization_environment_entry_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "organization_environment_entry_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "organization_environment_entry_lastModifiedByUserId_fkey"
    FOREIGN KEY ("lastModifiedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- ONE organization keyspace across both kinds (design §3.1).
CREATE UNIQUE INDEX "organization_environment_entry_orgId_key_key"
  ON "organization_environment_entry"("orgId", "key");
CREATE UNIQUE INDEX "organization_environment_entry_id_orgId_key"
  ON "organization_environment_entry"("id", "orgId");
CREATE INDEX "organization_environment_entry_orgId_audience_idx"
  ON "organization_environment_entry"("orgId", "audience");

CREATE TABLE "organization_environment_secret" (
  "entryId" UUID NOT NULL,
  "value" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "organization_environment_secret_pkey" PRIMARY KEY ("entryId"),
  CONSTRAINT "organization_environment_secret_entryId_fkey"
    FOREIGN KEY ("entryId") REFERENCES "organization_environment_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "organization_environment_assignment" (
  "orgId" TEXT NOT NULL,
  "entryId" UUID NOT NULL,
  "agentId" UUID NOT NULL,
  "authorizedByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_environment_assignment_pkey" PRIMARY KEY ("entryId", "agentId"),
  -- Both foreign keys are composite on orgId, so the database itself refuses a
  -- binding that spans two organizations.
  CONSTRAINT "organization_environment_assignment_entryId_orgId_fkey"
    FOREIGN KEY ("entryId", "orgId") REFERENCES "organization_environment_entry"("id", "orgId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "organization_environment_assignment_agentId_orgId_fkey"
    FOREIGN KEY ("agentId", "orgId") REFERENCES "agent"("id", "orgId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "organization_environment_assignment_authorizedByUserId_fkey"
    FOREIGN KEY ("authorizedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "organization_environment_assignment_orgId_agentId_idx"
  ON "organization_environment_assignment"("orgId", "agentId");
