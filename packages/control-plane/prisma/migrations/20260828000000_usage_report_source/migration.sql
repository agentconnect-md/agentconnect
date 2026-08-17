-- Trusted ingress provenance for a session's metered usage. Stamped by the adapter
-- that accepted the report (daemon EVT vs the service-authenticated batch endpoint),
-- never self-reported. Existing rows predate the gateway ingress, so `daemon` is both
-- the default and the correct backfill.

-- CreateEnum
CREATE TYPE "public"."UsageSource" AS ENUM ('daemon', 'gateway');

-- AlterTable
ALTER TABLE "public"."session_usage" ADD COLUMN "source" "public"."UsageSource" NOT NULL DEFAULT 'daemon';

-- AlterTable
ALTER TABLE "public"."session_spend" ADD COLUMN "source" "public"."UsageSource" NOT NULL DEFAULT 'daemon';
