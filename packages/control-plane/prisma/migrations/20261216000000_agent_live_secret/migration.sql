-- Live agent secrets (capability-requests.md §4.9.2): every existing row stays a spawn-time secret.
ALTER TABLE "agent_secret" ADD COLUMN "delivery" TEXT NOT NULL DEFAULT 'spawn';
ALTER TABLE "agent_secret" ADD COLUMN "description" TEXT;
