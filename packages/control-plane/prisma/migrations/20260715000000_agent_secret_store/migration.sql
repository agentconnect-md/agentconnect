-- Agent write-only secrets move out of the agent.runtimeOverrides JSONB bag into a
-- dedicated row-per-key table behind the AgentSecretStore seam (BotSecret discipline:
-- store-only reads/writes, never joined into list/DTO queries), so at-rest encryption
-- (SecretCipher) covers every secret value in one place. See
-- docs/designs/secret-store-seams.md.

-- CreateTable
CREATE TABLE "public"."agent_secret" (
    "agentId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_secret_pkey" PRIMARY KEY ("agentId","key")
);

-- AddForeignKey
ALTER TABLE "public"."agent_secret" ADD CONSTRAINT "agent_secret_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the JSONB bag…
INSERT INTO "public"."agent_secret" ("agentId", "key", "value", "updatedAt")
SELECT a."id", kv."key", kv."value", now()
FROM "public"."agent" a,
     LATERAL jsonb_each_text(a."runtimeOverrides" -> 'secrets') AS kv("key", "value")
WHERE jsonb_typeof(a."runtimeOverrides" -> 'secrets') = 'object';

-- …then strip the bag so no secret value lingers outside the seam.
UPDATE "public"."agent"
SET "runtimeOverrides" = "runtimeOverrides" - 'secrets'
WHERE "runtimeOverrides" ? 'secrets';
