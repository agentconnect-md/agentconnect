-- Gitea code-host hooks (gitea-integration.md §5, §12): the third provider discriminator joins
-- the enum, so the shared hook vocabulary stays total over CODE_HOST_PROVIDERS. Gitea-only state
-- arrives with its own tables in G2; nothing can write a row of this kind before then.
ALTER TYPE "HookKind" ADD VALUE IF NOT EXISTS 'gitea';
