-- The connect funnel's terminal outcome (docs/designs/linear-integration.md §7.1).
--
-- The OAuth tab is a throwaway, so the funnel row is the console's only channel for "the round trip
-- finished, and how" — including the tail refusals of §7.1 (identity taken, workspace claimed) that
-- leave an inert token row behind. The row therefore survives its callback instead of being
-- deleted, and `claimedAt` carries the one-shot fence: it is a compare-and-set the first callback
-- wins, so a replayed or concurrent delivery of the same state never reaches the token exchange.

CREATE TYPE "LinearInstallStatus" AS ENUM ('pending', 'completed', 'failed');

ALTER TABLE "linear_install_state"
    ADD COLUMN "status" "LinearInstallStatus" NOT NULL DEFAULT 'pending',
    ADD COLUMN "failureReason" TEXT,
    ADD COLUMN "botId" UUID,
    ADD COLUMN "claimedAt" TIMESTAMPTZ(6),
    ADD COLUMN "settledAt" TIMESTAMPTZ(6);
