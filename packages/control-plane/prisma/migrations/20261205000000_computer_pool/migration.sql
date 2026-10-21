-- Managed computers in the Kubernetes pool (computer-use.md §15.1): allocation modes, sleep and the pool controller's phase.
ALTER TYPE "ComputerStatus" ADD VALUE 'sleeping' BEFORE 'revoked';

CREATE TYPE "ComputerAllocation" AS ENUM ('ephemeral', 'per-agent', 'manual');

ALTER TABLE "computer" ADD COLUMN "allocation" "ComputerAllocation",
ADD COLUMN "ownerAgentId" UUID,
ADD COLUMN "poolSessionId" TEXT,
ADD COLUMN "poolPhase" TEXT,
ADD COLUMN "poolPhaseAt" TIMESTAMPTZ(6),
ADD COLUMN "poolActiveAt" TIMESTAMPTZ(6),
ADD COLUMN "poolError" TEXT;

CREATE INDEX "computer_poolPhase_idx" ON "computer"("poolPhase");
CREATE INDEX "computer_ownerAgentId_idx" ON "computer"("ownerAgentId");

-- One live per-agent computer per agent, and one live ephemeral computer per agent session; a reclaiming row makes room for its successor.
CREATE UNIQUE INDEX "computer_per_agent_key" ON "computer" ("ownerAgentId") WHERE "allocation" = 'per-agent' AND "poolPhase" IS DISTINCT FROM 'reclaiming';
CREATE UNIQUE INDEX "computer_ephemeral_session_key" ON "computer" ("ownerAgentId", "poolSessionId") WHERE "allocation" = 'ephemeral' AND "poolPhase" IS DISTINCT FROM 'reclaiming';
