CREATE TABLE "azure_devops_user_identity" (
    "userId" TEXT NOT NULL,
    "tenantId" UUID NOT NULL,
    "linkedObjectId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "refreshToken" TEXT NOT NULL,
    CONSTRAINT "azure_devops_user_identity_pkey" PRIMARY KEY ("userId", "tenantId"),
    CONSTRAINT "azure_devops_user_identity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "azure_devops_user_identity_state" (
    "nonce" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "linkedObjectId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "verifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "azure_devops_user_identity_state_pkey" PRIMARY KEY ("nonce"),
    CONSTRAINT "azure_devops_user_identity_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "azure_devops_user_identity_state_userId_key" ON "azure_devops_user_identity_state"("userId");
CREATE INDEX "azure_devops_user_identity_state_expiresAt_idx" ON "azure_devops_user_identity_state"("expiresAt");
