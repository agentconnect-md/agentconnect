ALTER TABLE "hook_def"
ADD COLUMN "githubSessionKey" TEXT;

-- Preserve every existing daemon session channel. New hooks use github:<repoId>,
-- while pre-migration hooks keep the exact owner/repo prefix they already used.
UPDATE "hook_def"
SET "githubSessionKey" = "repoFullName"
WHERE "kind" = 'github'
  AND "repoFullName" IS NOT NULL;
