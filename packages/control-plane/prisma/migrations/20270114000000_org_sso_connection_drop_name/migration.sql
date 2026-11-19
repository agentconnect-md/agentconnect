-- An organization has one connection, so it carries no name of its own (docs/designs/organization-sso.md §3).
ALTER TABLE "org_sso_connection" DROP COLUMN "name";
