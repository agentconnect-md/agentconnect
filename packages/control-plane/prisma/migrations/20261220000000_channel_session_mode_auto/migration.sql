-- The coordinator's session mode (auto-session-mode.md §3.1); a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "ChannelSessionMode" ADD VALUE IF NOT EXISTS 'auto';
