-- Shared skills registry (docs/designs/shared-skills.md). The CP records only the
-- SOURCE (repo / git URL / tree path) + optional ref + skill filter; skill CONTENT
-- never touches the CP. No secret side-table or grant — skills are plain content and
-- private-repo reads reuse the daemon's existing GitHub App token path. The per-agent
-- enable-list lives in agent.runtimeOverrides.skills[] (no schema change here).

-- CreateTable
CREATE TABLE "public"."skill_source" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "githubRepoId" BIGINT,
    "ref" TEXT,
    "subDir" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "public"."ResourceVisibility" NOT NULL DEFAULT 'org',
    "sharedWith" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "skill_source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skill_source_orgId_idx" ON "public"."skill_source"("orgId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "skill_source_orgId_name_key" ON "public"."skill_source"("orgId" ASC, "name" ASC);

-- AddForeignKey
ALTER TABLE "public"."skill_source" ADD CONSTRAINT "skill_source_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."skill_source" ADD CONSTRAINT "skill_source_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
