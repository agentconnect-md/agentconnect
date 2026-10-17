-- The organization record in knowledge (assistant-mode.md §5.16): agent visibility on every entry, three record kinds, research's claim and People's opt-out.
CREATE TYPE "OrganizationKnowledgeVisibility" AS ENUM ('all', 'selected');
CREATE TYPE "OrganizationKnowledgeKind" AS ENUM ('entry', 'organization', 'channels', 'people');
CREATE TYPE "OrganizationKnowledgeWriterKind" AS ENUM ('research', 'first-look', 'conversation', 'person');

ALTER TYPE "OrganizationArtifactSource" ADD VALUE 'agent';
ALTER TYPE "OrganizationArtifactSource" ADD VALUE 'migration';

-- Existing entries are ordinary ones that every agent reads.
ALTER TABLE "organization_knowledge" ADD COLUMN     "kind" "OrganizationKnowledgeKind" NOT NULL DEFAULT 'entry',
ADD COLUMN     "readers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "readersFollowAssistantMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "visibility" "OrganizationKnowledgeVisibility" NOT NULL DEFAULT 'all';

ALTER TABLE "organization_knowledge_revision" ADD COLUMN     "writerKind" "OrganizationKnowledgeWriterKind";

-- One record entry of each kind per organization; Prisma cannot express the partial predicate.
CREATE UNIQUE INDEX "organization_knowledge_record_kind_key" ON "organization_knowledge" ("orgId", "kind") WHERE "kind" <> 'entry';

CREATE TABLE "organization_record" (
    "orgId" TEXT NOT NULL,
    "researchAgentId" UUID,
    "researchClaimedAt" TIMESTAMPTZ(6),
    "researchedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organization_record_pkey" PRIMARY KEY ("orgId")
);

CREATE TABLE "organization_people_opt_out" (
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "clearedOn" DATE NOT NULL,
    CONSTRAINT "organization_people_opt_out_pkey" PRIMARY KEY ("orgId","key")
);

ALTER TABLE "organization_record" ADD CONSTRAINT "organization_record_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_record" ADD CONSTRAINT "organization_record_researchAgentId_fkey" FOREIGN KEY ("researchAgentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "organization_people_opt_out" ADD CONSTRAINT "organization_people_opt_out_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
