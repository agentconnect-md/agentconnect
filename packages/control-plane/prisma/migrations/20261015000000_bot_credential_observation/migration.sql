-- Credential probe observations per relay (preset-agents.md §5.3).
--
-- Slack's ambiguous `invalid_auth` depends on the caller's address, so relay
-- replicas can legitimately disagree: one outside the app's IP allowlist is
-- rejected while another passes. One bot-level watermark let whichever report
-- landed last win, so each relay now keeps its own latest observation of the
-- bot's current credential, and the bot's rejected mark is aggregated from
-- them: any rejected row marks the bot (first sighting kept, newest code), none
-- clears it. A row leaves with its relay when the failover sweeper deletes it,
-- and with its bot; a fresh credential deletes the bot's rows.
--
-- `bot.credentialCheckedAt`, the single watermark this replaces, has no other
-- reader. No relay has sent a credential check yet, so there is nothing to carry.
BEGIN;

ALTER TABLE "bot" DROP COLUMN "credentialCheckedAt";

CREATE TABLE "bot_credential_observation" (
    "botId" UUID NOT NULL,
    "relayId" UUID NOT NULL,
    "credentialRevision" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "code" TEXT,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bot_credential_observation_pkey" PRIMARY KEY ("botId","relayId")
);

CREATE INDEX "bot_credential_observation_relayId_idx" ON "bot_credential_observation"("relayId");

ALTER TABLE "bot_credential_observation" ADD CONSTRAINT "bot_credential_observation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_credential_observation" ADD CONSTRAINT "bot_credential_observation_relayId_fkey" FOREIGN KEY ("relayId") REFERENCES "relay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
