-- Private skill sources (docs/designs/shared-skills.md §3): record whether the repository was
-- private when the CP bound its numeric identity. A private source is acquired by the daemon
-- through the org GitHub App (a contents:read token scoped to exactly that repository, minted
-- because the agent enables the source) instead of anonymously.
--
-- Defaults to false: every existing row was admitted under the public-only rule and keeps its
-- anonymous acquisition path.
ALTER TABLE "skill_source" ADD COLUMN "private" BOOLEAN NOT NULL DEFAULT false;
