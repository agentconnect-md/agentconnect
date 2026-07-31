-- Organization Knowledge and immutable managed Agent Skills revisions.
-- Pending suggestion bodies remain daemon-local; accepted content is the
-- explicit shared-content exception described in organization-knowledge.md.

CREATE TYPE "OrganizationArtifactSource" AS ENUM ('manual', 'dream');
CREATE TYPE "OrganizationSuggestionKind" AS ENUM ('knowledge', 'skill');
CREATE TYPE "OrganizationSuggestionOperation" AS ENUM ('create', 'update');
CREATE TYPE "OrganizationSuggestionState" AS ENUM ('pending', 'accepted', 'rejected');

ALTER TABLE "agent"
  ADD COLUMN "managedSkills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "organization_knowledge" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "currentRevision" INTEGER NOT NULL DEFAULT 1,
  "archivedAt" TIMESTAMPTZ(6),
  "archivedByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "organization_knowledge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_knowledge_currentRevision_check" CHECK ("currentRevision" > 0),
  CONSTRAINT "organization_knowledge_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "organization_knowledge_revision" (
  "knowledgeId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "summary" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "digest" TEXT NOT NULL,
  "source" "OrganizationArtifactSource" NOT NULL,
  "sourceAgentId" UUID,
  "sourceDreamId" TEXT,
  "sourceCandidateId" UUID,
  "sourceSessionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdByUserId" TEXT,
  "reviewedByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_knowledge_revision_pkey" PRIMARY KEY ("knowledgeId", "revision"),
  CONSTRAINT "organization_knowledge_revision_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "organization_knowledge_revision_digest_check"
    CHECK ("digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "organization_knowledge_revision_knowledgeId_fkey"
    FOREIGN KEY ("knowledgeId") REFERENCES "organization_knowledge"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "managed_skill" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "currentRevision" INTEGER NOT NULL DEFAULT 1,
  "archivedAt" TIMESTAMPTZ(6),
  "archivedByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "managed_skill_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "managed_skill_currentRevision_check" CHECK ("currentRevision" > 0),
  CONSTRAINT "managed_skill_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "managed_skill_revision" (
  "managedSkillId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "archive" BYTEA NOT NULL,
  "digest" TEXT NOT NULL,
  "compressedBytes" INTEGER NOT NULL,
  "expandedBytes" INTEGER NOT NULL,
  "fileCount" INTEGER NOT NULL,
  "manifest" JSONB NOT NULL,
  "source" "OrganizationArtifactSource" NOT NULL,
  "sourceAgentId" UUID,
  "sourceDreamId" TEXT,
  "sourceCandidateId" UUID,
  "sourceSessionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdByUserId" TEXT,
  "reviewedByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "managed_skill_revision_pkey" PRIMARY KEY ("managedSkillId", "revision"),
  CONSTRAINT "managed_skill_revision_bounds_check" CHECK (
    "revision" > 0 AND
    "compressedBytes" BETWEEN 1 AND 524288 AND
    "expandedBytes" BETWEEN 1 AND 4194304 AND
    "fileCount" BETWEEN 1 AND 64 AND
    octet_length("archive") = "compressedBytes"
  ),
  CONSTRAINT "managed_skill_revision_digest_check"
    CHECK ("digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "managed_skill_revision_managedSkillId_fkey"
    FOREIGN KEY ("managedSkillId") REFERENCES "managed_skill"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "organization_suggestion" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId" TEXT NOT NULL,
  "sourceAgentId" UUID NOT NULL,
  "sourceDaemonId" UUID,
  "dreamId" TEXT NOT NULL,
  "candidateId" UUID NOT NULL,
  "kind" "OrganizationSuggestionKind" NOT NULL,
  "operation" "OrganizationSuggestionOperation" NOT NULL,
  "targetArtifactId" UUID,
  "targetRevision" INTEGER,
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "digest" TEXT NOT NULL,
  "contentBytes" INTEGER NOT NULL,
  "sessionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "state" "OrganizationSuggestionState" NOT NULL DEFAULT 'pending',
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMPTZ(6),
  "reviewReason" TEXT,
  "acceptedArtifactId" UUID,
  "acceptedArtifactRevision" INTEGER,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "organization_suggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_suggestion_target_check" CHECK (
    ("operation" = 'create' AND "targetArtifactId" IS NULL AND "targetRevision" IS NULL) OR
    ("operation" = 'update' AND "targetArtifactId" IS NOT NULL AND "targetRevision" > 0)
  ),
  CONSTRAINT "organization_suggestion_acceptance_check" CHECK (
    ("acceptedArtifactId" IS NULL AND "acceptedArtifactRevision" IS NULL) OR
    ("acceptedArtifactId" IS NOT NULL AND "acceptedArtifactRevision" > 0)
  ),
  CONSTRAINT "organization_suggestion_state_check" CHECK (
    ("state" = 'pending' AND "reviewedAt" IS NULL AND "acceptedArtifactId" IS NULL) OR
    ("state" = 'rejected' AND "reviewedAt" IS NOT NULL AND "acceptedArtifactId" IS NULL) OR
    ("state" = 'accepted' AND "reviewedAt" IS NOT NULL AND "acceptedArtifactId" IS NOT NULL)
  ),
  CONSTRAINT "organization_suggestion_content_check" CHECK (
    "contentBytes" BETWEEN 1 AND 4194304 AND cardinality("sessionIds") > 0 AND
    "digest" ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT "organization_suggestion_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "managed_skill_orgId_name_key" ON "managed_skill"("orgId", "name");
CREATE UNIQUE INDEX "organization_suggestion_source_key"
  ON "organization_suggestion"("sourceAgentId", "dreamId", "candidateId");

CREATE INDEX "organization_knowledge_orgId_archivedAt_updatedAt_idx"
  ON "organization_knowledge"("orgId", "archivedAt", "updatedAt");
CREATE INDEX "organization_knowledge_revision_createdAt_idx"
  ON "organization_knowledge_revision"("createdAt");
CREATE INDEX "organization_knowledge_revision_search_idx"
  ON "organization_knowledge_revision"
  USING GIN (to_tsvector('simple', coalesce("content", '') || ' ' || coalesce("summary", '')));
CREATE INDEX "managed_skill_orgId_archivedAt_updatedAt_idx"
  ON "managed_skill"("orgId", "archivedAt", "updatedAt");
CREATE INDEX "managed_skill_revision_createdAt_idx" ON "managed_skill_revision"("createdAt");
CREATE INDEX "organization_suggestion_orgId_state_createdAt_idx"
  ON "organization_suggestion"("orgId", "state", "createdAt");
CREATE INDEX "organization_suggestion_sourceDaemonId_state_idx"
  ON "organization_suggestion"("sourceDaemonId", "state");
