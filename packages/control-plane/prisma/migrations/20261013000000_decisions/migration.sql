CREATE TABLE "decision" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "question" JSONB NOT NULL,
    "visibility" "ResourceVisibility" NOT NULL DEFAULT 'org',
    "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "decision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "decision_selected_audience_nonempty" CHECK ("visibility" <> 'restricted' OR cardinality("sharedWith") > 0)
);
CREATE INDEX "decision_orgId_idx" ON "decision"("orgId");
CREATE INDEX "decision_sharedWith_idx" ON "decision" USING GIN ("sharedWith");
ALTER TABLE "decision" ADD CONSTRAINT "decision_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decision" ADD CONSTRAINT "decision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
