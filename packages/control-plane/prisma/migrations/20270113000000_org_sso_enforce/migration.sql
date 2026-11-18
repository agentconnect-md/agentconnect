-- Enforcing an active connection per session is its own step (docs/designs/organization-sso.md §4.5).
ALTER TABLE "org_sso_connection" ADD COLUMN "enforcedAt" TIMESTAMPTZ(6);
