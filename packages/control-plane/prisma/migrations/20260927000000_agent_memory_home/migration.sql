-- The managed memory home in the Control Plane (memory-evolution.md §3.2.1): one row per memory
-- file under a `control-plane` home, and the change log as an event table instead of a sidecar.
CREATE TABLE "agent_memory_file" (
    "agentId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "mtime" TIMESTAMPTZ(3) NOT NULL,
    "stagedAt" TIMESTAMPTZ(3),

    CONSTRAINT "agent_memory_file_pkey" PRIMARY KEY ("agentId","path")
);

CREATE INDEX "agent_memory_file_orgId_idx" ON "agent_memory_file"("orgId");
CREATE INDEX "agent_memory_file_stagedAt_idx" ON "agent_memory_file"("stagedAt");

ALTER TABLE "agent_memory_file" ADD CONSTRAINT "agent_memory_file_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_memory_file" ADD CONSTRAINT "agent_memory_file_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_memory_history" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "agentId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "truncated" BOOLEAN,
    "bytes" INTEGER NOT NULL,

    CONSTRAINT "agent_memory_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_memory_history_agentId_root_path_at_idx" ON "agent_memory_history"("agentId", "root", "path", "at");
CREATE INDEX "agent_memory_history_orgId_idx" ON "agent_memory_history"("orgId");

ALTER TABLE "agent_memory_history" ADD CONSTRAINT "agent_memory_history_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_memory_history" ADD CONSTRAINT "agent_memory_history_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
