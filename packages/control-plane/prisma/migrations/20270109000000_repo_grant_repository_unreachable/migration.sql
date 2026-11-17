-- A grant whose repository the App installation can no longer reach goes stale (docs/designs/agent-multi-repo-authorization.md, Re-attestation).
ALTER TYPE "RepoGrantStaleReason" ADD VALUE IF NOT EXISTS 'repository_unreachable';
