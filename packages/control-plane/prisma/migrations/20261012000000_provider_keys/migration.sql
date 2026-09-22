CREATE TABLE "provider_key" (
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "endpoint" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "provider_key_pkey" PRIMARY KEY ("orgId", "provider"),
    CONSTRAINT "provider_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "provider_key_header" (
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "provider_key_header_pkey" PRIMARY KEY ("orgId", "provider", "name"),
    CONSTRAINT "provider_key_header_orgId_provider_fkey" FOREIGN KEY ("orgId", "provider") REFERENCES "provider_key"("orgId", "provider") ON DELETE CASCADE ON UPDATE CASCADE
);
