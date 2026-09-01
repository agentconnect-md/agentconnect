-- The operator's chosen default member of a shared bot: the HTTP-bot compile prefers it
-- over its earliest-member derivation while it still resolves to a placed, non-gated
-- member. Additive and nullable, so every existing bot keeps that derivation.
ALTER TABLE "bot" ADD COLUMN "preferredAgentId" UUID;
CREATE INDEX "bot_preferredAgentId_idx" ON "bot"("preferredAgentId");
-- SET NULL, not CASCADE: the bot row outlives the agent, and a deleted agent must leave
-- the bot on its fallback rather than take the bot with it.
ALTER TABLE "bot" ADD CONSTRAINT "bot_preferredAgentId_fkey" FOREIGN KEY ("preferredAgentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
