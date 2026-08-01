-- Keep the historical open collaboration experience as the product default.
-- Organization owners may still opt future agents into the isolated policy.
ALTER TABLE "public"."agent"
  ALTER COLUMN "callPolicy" SET DEFAULT 'all',
  ALTER COLUMN "outboundPolicy" SET DEFAULT 'all';

-- The organization setting was introduced with the isolated rollout default.
-- Normalize existing organizations to the intended open default without
-- rewriting any agent's persisted directional policy.
UPDATE "public"."org"
SET "defaultAgentVisibility" = 'all';

ALTER TABLE "public"."org"
  ALTER COLUMN "defaultAgentVisibility" SET DEFAULT 'all';
