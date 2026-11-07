-- Azure DevOps service hooks (azure-devops-integration.md §11): the hook kind, the binding's subscription state, its sealed keys, and its recorded subscriptions.
ALTER TYPE "HookKind" ADD VALUE IF NOT EXISTS 'azure-devops';

ALTER TABLE "azure_devops_repository_binding"
    ADD COLUMN "hookReason" TEXT,
    ADD COLUMN "lastVerifiedDeliveryAt" TIMESTAMPTZ(6),
    ADD COLUMN "hookLeaseOwner" TEXT,
    ADD COLUMN "hookLeaseUntil" TIMESTAMPTZ(6),
    ADD COLUMN "hookConvergeOwedAt" TIMESTAMPTZ(6);

CREATE INDEX "azure_devops_repository_binding_hookConvergeOwedAt_idx" ON "azure_devops_repository_binding"("hookConvergeOwedAt");

-- Relay-only key material, read only through the hook secret store.
CREATE TABLE "azure_devops_hook_secret" (
    "bindingId" UUID NOT NULL,
    "signingKey" TEXT NOT NULL,
    "keyGeneration" BIGINT NOT NULL DEFAULT 1,
    "nextSigningKey" TEXT,
    "nextSuspectedLeak" BOOLEAN NOT NULL DEFAULT false,
    "previousSigningKey" TEXT,
    "previousExpiresAt" TIMESTAMPTZ(6),

    CONSTRAINT "azure_devops_hook_secret_pkey" PRIMARY KEY ("bindingId")
);

CREATE TABLE "azure_devops_hook_subscription" (
    "id" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT,
    "keyGeneration" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "azure_devops_hook_subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "azure_devops_hook_subscription_subscriptionId_key" ON "azure_devops_hook_subscription"("subscriptionId");
CREATE UNIQUE INDEX "azure_devops_hook_subscription_bindingId_kind_key" ON "azure_devops_hook_subscription"("bindingId", "kind");

ALTER TABLE "azure_devops_hook_secret" ADD CONSTRAINT "azure_devops_hook_secret_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "azure_devops_repository_binding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "azure_devops_hook_subscription" ADD CONSTRAINT "azure_devops_hook_subscription_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "azure_devops_repository_binding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
