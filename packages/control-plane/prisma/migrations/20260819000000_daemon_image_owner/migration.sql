-- A cluster upgrade's rollback has to identify the WRITE it is undoing, not merely the
-- value that write produced. Identifying it by image alone is ambiguous: an operator's
-- chosen target and the release channel's newest version are usually the SAME version, so
-- an obligation left by a crashed command would happily revert the identical image the
-- fleet version sweep had since written on its own — a silent downgrade.
--
-- This column names the lifecycle operation that wrote the current image, and only that
-- operation's compensation matches it. Every other writer clears it, so an independent
-- write is never mistaken for a command's.

-- AlterTable
ALTER TABLE "org_cluster_execution" ADD COLUMN "daemonImageOwner" TEXT;
