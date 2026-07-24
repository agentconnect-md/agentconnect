-- The no-auth Control Plane uses this fixed local principal. These rows are
-- operational bootstrap data, not sample content. Keep the ids in sync with
-- packages/control-plane/src/config/defaults.ts.
BEGIN;

INSERT INTO "public"."org" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES (
  'org_default00000000000000000',
  'Default',
  '-',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT DO NOTHING;

INSERT INTO "public"."app_user" ("id", "email", "displayName")
VALUES (
  'usr_owner000000000000000000',
  'owner@agentconnect.local',
  'Owner'
)
ON CONFLICT DO NOTHING;

INSERT INTO "public"."membership" ("id", "orgId", "userId", "role")
VALUES (
  'membership_default_owner',
  'org_default00000000000000000',
  'usr_owner000000000000000000',
  'owner'
)
ON CONFLICT ("orgId", "userId") DO UPDATE
SET "role" = EXCLUDED."role";

COMMIT;
