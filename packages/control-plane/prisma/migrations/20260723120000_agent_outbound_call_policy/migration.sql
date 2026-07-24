ALTER TABLE "public"."agent"
ADD COLUMN "outboundPolicy" "public"."AgentCallPolicy" NOT NULL DEFAULT 'all',
ADD COLUMN "allowedTargetAgentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
