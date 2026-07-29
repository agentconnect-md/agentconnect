-- Preset agents, M0 (docs/designs/preset-agents.md §3).
--
-- 1. `agent.runtime` becomes NULLABLE — "deferred exec config": an agent may exist
--    unplaced with no runtime chosen; the invariant moves to placement. Additive —
--    every existing row keeps its value and the API create path still requires one.
-- 2. `preset_agent` — per-org, per-preset provisioning state. The row is the
--    idempotency marker: written transactionally with the agent row (org-creation
--    seam) or by the one-time backfill; its presence — `created` OR `skipped` —
--    permanently stops re-provisioning, so a deleted preset is never resurrected.

-- AlterTable
ALTER TABLE "agent" ALTER COLUMN "runtime" DROP NOT NULL;

-- CreateEnum
CREATE TYPE "PresetAgentKind" AS ENUM ('general', 'assistant');

-- CreateEnum
CREATE TYPE "PresetAgentState" AS ENUM ('created', 'skipped');

-- CreateTable
CREATE TABLE "preset_agent" (
    "orgId" TEXT NOT NULL,
    "preset" "PresetAgentKind" NOT NULL,
    "agentId" UUID,
    "status" "PresetAgentState" NOT NULL,
    "placementSettledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preset_agent_pkey" PRIMARY KEY ("orgId", "preset")
);

-- CreateIndex
CREATE INDEX "preset_agent_agentId_idx" ON "preset_agent"("agentId");

-- AddForeignKey
ALTER TABLE "preset_agent" ADD CONSTRAINT "preset_agent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preset_agent" ADD CONSTRAINT "preset_agent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
