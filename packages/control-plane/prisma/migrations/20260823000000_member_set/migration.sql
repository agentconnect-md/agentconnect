-- Fold the install-wide pool into the unified member-set model (docs/designs/daemon-groups.md §8).
-- A member set is a named set of daemons within which an agent's duty may be claimed; the pool is
-- one row of it, org-less, and `placementKind = 'pool'` stops being a stored value.
CREATE TABLE "member_set" (
    "id" UUID NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_set_pkey" PRIMARY KEY ("id")
);

-- One daemon in at most one set: the daemon IS the primary key.
CREATE TABLE "member_set_member" (
    "setId" UUID NOT NULL,
    "daemonId" UUID NOT NULL,
    "joinedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_set_member_pkey" PRIMARY KEY ("daemonId")
);

CREATE INDEX "member_set_orgId_idx" ON "member_set"("orgId");
CREATE INDEX "member_set_member_setId_idx" ON "member_set_member"("setId");

-- One cross-org set per install: `orgId IS NULL` means the pool, and there is exactly one pool.
CREATE UNIQUE INDEX "member_set_cross_org_key" ON "member_set" (("orgId" IS NULL)) WHERE "orgId" IS NULL;

ALTER TABLE "member_set" ADD CONSTRAINT "member_set_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_set_member" ADD CONSTRAINT "member_set_member_setId_fkey" FOREIGN KEY ("setId") REFERENCES "member_set"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Retiring a member's daemon row removes its membership with it, so a dead Pod is never eligible.
ALTER TABLE "member_set_member" ADD CONSTRAINT "member_set_member_daemonId_fkey" FOREIGN KEY ("daemonId") REFERENCES "daemon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The `set`-kind ref, nullable exactly as `daemonId` is nullable for a `set`-kind agent.
ALTER TABLE "agent" ADD COLUMN "setId" UUID;
CREATE INDEX "agent_setId_idx" ON "agent"("setId");
ALTER TABLE "agent" ADD CONSTRAINT "agent_setId_fkey" FOREIGN KEY ("setId") REFERENCES "member_set"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The install-wide pool, as a row.
INSERT INTO "member_set" ("id", "orgId", "name") VALUES (gen_random_uuid(), NULL, 'AgentConnect Cloud');

-- Every pool agent points at it, and every org-less daemon row is one of its members.
UPDATE "agent" SET "setId" = (SELECT "id" FROM "member_set" WHERE "orgId" IS NULL) WHERE "placementKind" = 'pool';
INSERT INTO "member_set_member" ("setId", "daemonId")
SELECT (SELECT "id" FROM "member_set" WHERE "orgId" IS NULL), "id" FROM "daemon" WHERE "orgId" IS NULL;

-- Contract the enum. `ALTER TYPE … ADD VALUE` cannot be used in the transaction that adds it, so
-- the rewrite goes through a replacement type, which is also what drops `pool` in the same step.
CREATE TYPE "AgentPlacementKind_new" AS ENUM ('daemon', 'set');
ALTER TABLE "agent" ALTER COLUMN "placementKind" DROP DEFAULT;
ALTER TABLE "agent" ALTER COLUMN "placementKind" TYPE "AgentPlacementKind_new"
  USING (CASE "placementKind"::text WHEN 'pool' THEN 'set' ELSE "placementKind"::text END)::"AgentPlacementKind_new";
ALTER TYPE "AgentPlacementKind" RENAME TO "AgentPlacementKind_old";
ALTER TYPE "AgentPlacementKind_new" RENAME TO "AgentPlacementKind";
DROP TYPE "AgentPlacementKind_old";
ALTER TABLE "agent" ALTER COLUMN "placementKind" SET DEFAULT 'daemon';
