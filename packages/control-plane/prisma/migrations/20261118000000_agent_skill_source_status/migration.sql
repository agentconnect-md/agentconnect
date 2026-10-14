-- The latest install failure code per agent and enabled skill Source, reported by its daemon (source-cache.md §11).
CREATE TABLE "agent_skill_source_status" (
    "agentId" UUID NOT NULL,
    "sourceName" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "reportedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_skill_source_status_pkey" PRIMARY KEY ("agentId","sourceName")
);

ALTER TABLE "agent_skill_source_status" ADD CONSTRAINT "agent_skill_source_status_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
