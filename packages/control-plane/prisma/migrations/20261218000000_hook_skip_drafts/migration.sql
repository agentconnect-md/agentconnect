-- Draft PR revisions skipped until the PR is marked ready (product-conventions.md, pull request review).
ALTER TABLE "hook_def" ADD COLUMN "skipDrafts" BOOLEAN NOT NULL DEFAULT false;
