-- GitLab.com OAuth administration identity (gitlab-com-integration.md §8.2, §9):
-- connection metadata, its sealed token side-table, and the one-shot OAuth state.

CREATE TABLE "gitlab_connection" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "gitlabUserId" BIGINT NOT NULL,
    "gitlabUsername" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "accessExpiresAt" TIMESTAMPTZ(6),
    "state" TEXT NOT NULL,
    "tokenVersion" BIGINT NOT NULL DEFAULT 1,
    "refreshLeaseOwner" TEXT,
    "refreshLeaseUntil" TIMESTAMPTZ(6),
    "lastSyncAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gitlab_connection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gitlab_connection_orgId_gitlabUserId_key" ON "gitlab_connection"("orgId", "gitlabUserId");
CREATE INDEX "gitlab_connection_orgId_idx" ON "gitlab_connection"("orgId");

ALTER TABLE "gitlab_connection" ADD CONSTRAINT "gitlab_connection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gitlab_connection" ADD CONSTRAINT "gitlab_connection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Sealed OAuth pair: read only through the secret store, never joined by DTO queries.
CREATE TABLE "gitlab_connection_secret" (
    "connectionId" UUID NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,

    CONSTRAINT "gitlab_connection_secret_pkey" PRIMARY KEY ("connectionId")
);

ALTER TABLE "gitlab_connection_secret" ADD CONSTRAINT "gitlab_connection_secret_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "gitlab_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One-shot OAuth authorization state; consumed exactly once at the callback.
CREATE TABLE "gitlab_oauth_state" (
    "nonce" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "browserHash" TEXT,
    "returnPath" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gitlab_oauth_state_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "gitlab_oauth_state_expiresAt_idx" ON "gitlab_oauth_state"("expiresAt");

-- §9.4 enforcement at the database layer: OAuth authority must not survive
-- organization membership, HOWEVER membership ends — the repository method, a
-- raw membership delete, or an app_user deletion cascading its memberships.
-- The trigger runs inside the same transaction as the removal, and the version
-- bump defeats any in-flight refresh CAS.
CREATE OR REPLACE FUNCTION gitlab_connection_disconnect_on_membership_delete() RETURNS trigger AS $$
BEGIN
    UPDATE "gitlab_connection"
       SET "state" = 'disconnected', "tokenVersion" = "tokenVersion" + 1
     WHERE "orgId" = OLD."orgId" AND "userId" = OLD."userId" AND "state" <> 'disconnected';
    DELETE FROM "gitlab_connection_secret" s
     USING "gitlab_connection" c
     WHERE s."connectionId" = c."id" AND c."orgId" = OLD."orgId" AND c."userId" = OLD."userId";
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gitlab_connection_membership_guard
AFTER DELETE ON "membership"
FOR EACH ROW EXECUTE FUNCTION gitlab_connection_disconnect_on_membership_delete();

-- Account deletion sets userId NULL through the FK; the membership trigger may
-- fire before or after that action, so this second guard closes the other
-- ordering: an owning user disappearing disconnects the row regardless.
CREATE OR REPLACE FUNCTION gitlab_connection_disconnect_on_user_detach() RETURNS trigger AS $$
BEGIN
    IF NEW."userId" IS NULL AND OLD."userId" IS NOT NULL AND NEW."state" <> 'disconnected' THEN
        NEW."state" := 'disconnected';
        NEW."tokenVersion" := OLD."tokenVersion" + 1;
        DELETE FROM "gitlab_connection_secret" WHERE "connectionId" = OLD."id";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gitlab_connection_user_detach_guard
BEFORE UPDATE OF "userId" ON "gitlab_connection"
FOR EACH ROW EXECUTE FUNCTION gitlab_connection_disconnect_on_user_detach();
