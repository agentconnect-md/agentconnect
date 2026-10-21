-- Agent access to a Computer as one relation (computer-use.md §4.1): none, the selected agents, or every agent of the org.
CREATE TYPE "ComputerAgentAccess" AS ENUM ('none', 'selected', 'all');

ALTER TABLE "computer" ADD COLUMN "agentAccess" "ComputerAgentAccess" NOT NULL DEFAULT 'none',
ADD COLUMN "accessAgentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "computer_accessAgentIds_idx" ON "computer" USING GIN ("accessAgentIds");
