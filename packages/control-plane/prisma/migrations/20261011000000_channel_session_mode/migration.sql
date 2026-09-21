-- Per-conversation session mode (docs/designs/channel-session-mode.md §5). Additive:
-- every existing conversation defaults to createNew, which is the behavior it already had.
BEGIN;

CREATE TYPE "ChannelSessionMode" AS ENUM ('createNew', 'append');

ALTER TABLE "integration_channel"
  ADD COLUMN "sessionMode" "ChannelSessionMode" NOT NULL DEFAULT 'createNew';

COMMIT;
