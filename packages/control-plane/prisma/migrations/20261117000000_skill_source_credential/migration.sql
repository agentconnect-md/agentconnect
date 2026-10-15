-- A skill source names who vouches for it as a provider-qualified repository reference; absent means anonymous.
ALTER TABLE "skill_source"
    ADD COLUMN "credentialProvider" TEXT,
    ADD COLUMN "credentialRepoId" BIGINT;

-- Every credentialed source so far is a private GitHub repository bound to its numeric id.
UPDATE "skill_source"
SET "credentialProvider" = 'github', "credentialRepoId" = "githubRepoId"
WHERE "private" AND "githubRepoId" IS NOT NULL;
