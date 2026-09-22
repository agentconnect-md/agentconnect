CREATE TABLE "provider_key" (
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "provider_key_pkey" PRIMARY KEY ("orgId", "provider"),
    CONSTRAINT "provider_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
