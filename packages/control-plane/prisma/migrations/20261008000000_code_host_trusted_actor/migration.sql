-- webhook-triggers-and-github-events.md, "Trusted users": a user a maintainer vouched for
-- on one repository may fire its hooks as a role-holder would. Repository-wide by design
-- (trust is in a person, not a subject family); the numeric user id is the match key and
-- the login is display only.
CREATE TABLE "code_host_trusted_actor" (
  "id"              UUID NOT NULL,
  "orgId"           TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  "repoExternalId"  BIGINT NOT NULL,
  "actorExternalId" BIGINT NOT NULL,
  "actorLogin"      TEXT NOT NULL,
  "addedByUserId"   TEXT,
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "code_host_trusted_actor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "code_host_trusted_actor_orgId_provider_repoExternalId_actorExternalId_key"
  ON "code_host_trusted_actor"("orgId", "provider", "repoExternalId", "actorExternalId");

CREATE INDEX "code_host_trusted_actor_orgId_provider_repoExternalId_idx"
  ON "code_host_trusted_actor"("orgId", "provider", "repoExternalId");

ALTER TABLE "code_host_trusted_actor"
  ADD CONSTRAINT "code_host_trusted_actor_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "code_host_trusted_actor"
  ADD CONSTRAINT "code_host_trusted_actor_addedByUserId_fkey"
  FOREIGN KEY ("addedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
