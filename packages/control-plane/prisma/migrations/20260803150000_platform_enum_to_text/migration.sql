-- Platform enum → text (integration-plugin-architecture.md §11, stage S1b): the
-- persisted chat-platform id opens so a future platform id can be stored without a
-- migration. Values, NULLability, defaults, and every index carry over unchanged —
-- `USING …::text` rewrites the column in place. `session_meta.platform` was already
-- text. The closed-set guard moves to the application layer (`toDbPlatform` refuses
-- ids outside the served set, fail-closed) until the platform registry replaces it.

-- Enum-typed defaults must be dropped BEFORE the type change (they are cast-bound to
-- the enum) and re-created as text afterwards.
ALTER TABLE "cron_def" ALTER COLUMN "targetPlatform" DROP DEFAULT;
ALTER TABLE "hook_def" ALTER COLUMN "targetPlatform" DROP DEFAULT;
ALTER TABLE "bot" ALTER COLUMN "platform" DROP DEFAULT;
ALTER TABLE "integration" ALTER COLUMN "platform" DROP DEFAULT;

ALTER TABLE "assignment" ALTER COLUMN "platform" TYPE TEXT USING "platform"::text;
ALTER TABLE "secret_lease" ALTER COLUMN "scopePlatform" TYPE TEXT USING "scopePlatform"::text;
ALTER TABLE "cron_def" ALTER COLUMN "targetPlatform" TYPE TEXT USING "targetPlatform"::text;
ALTER TABLE "hook_def" ALTER COLUMN "targetPlatform" TYPE TEXT USING "targetPlatform"::text;
ALTER TABLE "bot" ALTER COLUMN "platform" TYPE TEXT USING "platform"::text;
ALTER TABLE "integration" ALTER COLUMN "platform" TYPE TEXT USING "platform"::text;

ALTER TABLE "cron_def" ALTER COLUMN "targetPlatform" SET DEFAULT 'slack';
ALTER TABLE "hook_def" ALTER COLUMN "targetPlatform" SET DEFAULT 'slack';
ALTER TABLE "bot" ALTER COLUMN "platform" SET DEFAULT 'slack';
ALTER TABLE "integration" ALTER COLUMN "platform" SET DEFAULT 'slack';

DROP TYPE "Platform";
