-- Exact money. A cost is metered by one party, accumulated here, and billed by
-- another, so the two usage tables hold it as NUMERIC(38,18) instead of double
-- precision: 20 integer digits for any plausible amount, 18 fractional for the
-- sub-cent per-token prices the smallest reports carry.
--
-- Postgres casts float8 to numeric through the double's shortest round-tripping
-- decimal, so an amount written as 0.41 lands as 0.41 rather than its binary tail.
-- An existing amount with more than 20 integer digits would overflow the new type
-- and fail this statement — that is corrupt data, and refusing it is the point.

-- AlterTable
ALTER TABLE "public"."session_usage"
  ALTER COLUMN "costAmount" SET DATA TYPE NUMERIC(38,18),
  ALTER COLUMN "costAmount" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."session_spend"
  ALTER COLUMN "cumulativeCost" SET DATA TYPE NUMERIC(38,18);
