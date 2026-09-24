ALTER TABLE "bot_decision_routing" ADD COLUMN "steps" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "code_host_decision_routing" ADD COLUMN "steps" JSONB NOT NULL DEFAULT '[]';
