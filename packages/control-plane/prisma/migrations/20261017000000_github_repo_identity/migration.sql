CREATE TABLE "github_repo_identity" (
    "userId" TEXT NOT NULL,
    "githubUserId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "github_repo_identity_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "github_repo_identity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "github_repo_identity_githubUserId_idx" ON "github_repo_identity"("githubUserId");

CREATE TABLE "github_repo_identity_state" (
    "nonce" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "github_repo_identity_state_pkey" PRIMARY KEY ("nonce"),
    CONSTRAINT "github_repo_identity_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "github_repo_identity_state_userId_key" ON "github_repo_identity_state"("userId");
CREATE INDEX "github_repo_identity_state_expiresAt_idx" ON "github_repo_identity_state"("expiresAt");
