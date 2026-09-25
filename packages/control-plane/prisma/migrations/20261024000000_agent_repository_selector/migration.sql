-- The evaluator the per-session repository selector asks (docs/designs/multi-repository-workspaces.md decision 15).
-- Additive: every existing agent has none, and the pair is set or cleared together.
BEGIN;

ALTER TABLE "agent"
  ADD COLUMN "repositorySelectorProviderId" TEXT,
  ADD COLUMN "repositorySelectorModel" TEXT,
  ADD CONSTRAINT "agent_repository_selector_pair"
    CHECK (("repositorySelectorProviderId" IS NULL) = ("repositorySelectorModel" IS NULL));

COMMIT;
