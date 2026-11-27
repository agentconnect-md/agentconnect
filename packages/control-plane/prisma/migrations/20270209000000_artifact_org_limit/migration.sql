-- An organization's artifact total, delivered with its session policy (artifacts.md §10.2); null is no limit.
ALTER TABLE "org_session_policy" ADD COLUMN "artifactBytesLimit" BIGINT;
ALTER TABLE "org_session_policy" ADD CONSTRAINT "org_session_policy_artifact_bytes_limit_nonnegative" CHECK ("artifactBytesLimit" >= 0);
