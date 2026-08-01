-- Organization-level default for both directional policies on newly created agents.
-- Existing agent rows are intentionally untouched.
ALTER TABLE "org"
  ADD COLUMN "defaultAgentVisibility" "AgentCallPolicy" NOT NULL DEFAULT 'selected';
