-- Session visibility (docs/designs/session-visibility.md §3): every session gets
-- its own visibility tier ('private' | 'org'), a namespaced owner identity, the
-- A2A reconciliation state marker, and the §5.1 push revision + daemon-ack
-- watermark. orgId is denormalized from the owning agent so the org-wide list
-- predicate and its index never join "agent".

-- CreateEnum
CREATE TYPE "SessionVisibility" AS ENUM ('private', 'org');

-- CreateEnum
CREATE TYPE "VisibilitySource" AS ENUM ('default', 'inherited_pending', 'inherited', 'explicit');

-- AlterTable ("orgId" is added nullable, backfilled, then made NOT NULL below)
ALTER TABLE "session_meta"
  ADD COLUMN "orgId" TEXT,
  ADD COLUMN "visibility" "SessionVisibility" NOT NULL DEFAULT 'org',
  ADD COLUMN "ownerIdentity" TEXT,
  ADD COLUMN "visibilitySource" "VisibilitySource" NOT NULL DEFAULT 'default',
  ADD COLUMN "visibilityRev" INTEGER NOT NULL DEFAULT 0,
  -- -1, not 0: rev 0 is a real revision (a session ingested and never changed),
  -- so the watermark needs a distinct "never acknowledged" value.
  ADD COLUMN "visibilityAckedRev" INTEGER NOT NULL DEFAULT -1;

-- Backfill orgId from the owning agent. Legacy rows keep visibility='org' — do
-- NOT retro-classify DMs (the `thread === 'dm'` convention is platform-
-- inconsistent, and flipping a row private would yank it from members who can
-- see it today); tightening applies to new sessions only (§3).
UPDATE "session_meta" AS sm
SET "orgId" = a."orgId"
FROM "agent" AS a
WHERE a."id" = sm."agentId"
  AND sm."orgId" IS NULL;

-- Rows without a matching agent are unreachable today (agentId has a CASCADE
-- FK), but a NULL orgId row would fail the NOT NULL flip — drop defensively.
DELETE FROM "session_meta" WHERE "orgId" IS NULL;

ALTER TABLE "session_meta" ALTER COLUMN "orgId" SET NOT NULL;

-- CreateIndex — org-wide keyset paging under the visibility predicate; the
-- trailing tuple mirrors the existing page indexes exactly.
CREATE INDEX "session_meta_org_visibility_page_idx"
  ON "session_meta"(
    "orgId",
    "visibility",
    "lastActivityAt" DESC,
    "startedAt" DESC,
    "id" DESC
  );

-- Web API launch provenance (session-visibility.md §4.4). correlationId is
-- minted by the CP and echoed by the daemon on `event/session` — distinct from
-- the fencing launch id. createdByUserId is a raw scalar (no FK) so a deleted
-- user never breaks provenance.
ALTER TABLE "agent_launch"
  ADD COLUMN "correlationId" UUID,
  ADD COLUMN "createdByUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "agent_launch_correlationId_key" ON "agent_launch"("correlationId");
