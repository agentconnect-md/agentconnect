-- By decision joins the conversation trigger (decisions.md §6.2); a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "ChannelTrigger" ADD VALUE IF NOT EXISTS 'decision';
