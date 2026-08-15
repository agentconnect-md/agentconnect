-- Placement becomes a target, not only a member id: `daemon` resolves through `Agent.daemonId`,
-- `pool` resolves to the install-wide member set. Additive and defaulted, so every existing row
-- stays a `daemon` placement naming the machine it already names.
CREATE TYPE "AgentPlacementKind" AS ENUM ('daemon', 'pool');

ALTER TABLE "agent" ADD COLUMN "placementKind" "AgentPlacementKind" NOT NULL DEFAULT 'daemon';
