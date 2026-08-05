-- Deployment-wide desired state is a singleton, versioned document. Secret
-- material stays in a side table so ordinary configuration reads cannot select
-- it accidentally.
CREATE TABLE "deployment_config" (
    "id" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "adminClaimedFor" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deployment_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "deployment_config_singleton_check" CHECK ("id" = 1),
    CONSTRAINT "deployment_config_schema_version_check" CHECK ("schemaVersion" > 0),
    CONSTRAINT "deployment_config_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "deployment_secret" (
    "deploymentConfigId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deployment_secret_pkey" PRIMARY KEY ("deploymentConfigId", "key")
);

ALTER TABLE "deployment_secret"
ADD CONSTRAINT "deployment_secret_deploymentConfigId_fkey"
FOREIGN KEY ("deploymentConfigId") REFERENCES "deployment_config"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
