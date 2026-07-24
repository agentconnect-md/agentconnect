CREATE TYPE "public"."MemoryPluginTransport" AS ENUM ('streamable_http', 'stdio');
CREATE TYPE "public"."ExternalMemoryConnectionStatus" AS ENUM ('probing', 'ready', 'degraded', 'invalid');

CREATE TABLE "public"."memory_plugin_installation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId" TEXT NOT NULL,
  "pluginId" TEXT NOT NULL,
  "transport" "public"."MemoryPluginTransport" NOT NULL DEFAULT 'streamable_http',
  "endpoint" TEXT,
  "commandRef" TEXT,
  "pinnedProfileMajor" INTEGER NOT NULL DEFAULT 1,
  "expectedManifestDigest" TEXT,
  "secretHeaders" JSONB NOT NULL DEFAULT '[]',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "memory_plugin_installation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "memory_plugin_installation_profile_major_check" CHECK ("pinnedProfileMajor" = 1),
  CONSTRAINT "memory_plugin_installation_transport_target_check" CHECK (
    ("transport" = 'streamable_http' AND "endpoint" IS NOT NULL AND "commandRef" IS NULL)
    OR ("transport" = 'stdio' AND "endpoint" IS NULL AND "commandRef" IS NOT NULL)
  ),
  CONSTRAINT "memory_plugin_installation_secret_headers_check" CHECK (jsonb_typeof("secretHeaders") = 'array')
);

CREATE TABLE "public"."external_memory_connection" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId" TEXT NOT NULL,
  "installationId" UUID NOT NULL,
  "config" JSONB NOT NULL DEFAULT '{}',
  "status" "public"."ExternalMemoryConnectionStatus" NOT NULL DEFAULT 'probing',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "probedRevision" INTEGER,
  "pluginVersion" TEXT,
  "profile" TEXT,
  "manifestDigest" TEXT,
  "capabilities" JSONB,
  "declaredEgressHosts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reasonCode" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "external_memory_connection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_memory_connection_config_check" CHECK (jsonb_typeof("config") = 'object'),
  CONSTRAINT "external_memory_connection_revision_check" CHECK (
    "revision" >= 1
    AND ("probedRevision" IS NULL OR ("probedRevision" >= 1 AND "probedRevision" <= "revision"))
  )
);

CREATE TABLE "public"."external_memory_connection_secret" (
  "connectionId" UUID NOT NULL,
  "values" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "external_memory_connection_secret_pkey" PRIMARY KEY ("connectionId"),
  CONSTRAINT "external_memory_connection_secret_values_check" CHECK (jsonb_typeof("values") = 'object')
);

CREATE TABLE "public"."external_memory_grant" (
  "id" TEXT NOT NULL,
  "connectionId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_memory_grant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_memory_grant_status_check" CHECK ("status" IN ('active', 'revoked'))
);

CREATE INDEX "memory_plugin_installation_orgId_pluginId_idx" ON "public"."memory_plugin_installation"("orgId", "pluginId");
CREATE INDEX "external_memory_connection_orgId_idx" ON "public"."external_memory_connection"("orgId");
CREATE INDEX "external_memory_connection_installationId_idx" ON "public"."external_memory_connection"("installationId");
CREATE UNIQUE INDEX "external_memory_grant_key_key" ON "public"."external_memory_grant"("key");
CREATE INDEX "external_memory_grant_connectionId_idx" ON "public"."external_memory_grant"("connectionId");

ALTER TABLE "public"."memory_plugin_installation"
  ADD CONSTRAINT "memory_plugin_installation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."memory_plugin_installation"
  ADD CONSTRAINT "memory_plugin_installation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."external_memory_connection"
  ADD CONSTRAINT "external_memory_connection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."external_memory_connection"
  ADD CONSTRAINT "external_memory_connection_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "public"."memory_plugin_installation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."external_memory_connection"
  ADD CONSTRAINT "external_memory_connection_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."external_memory_connection_secret"
  ADD CONSTRAINT "external_memory_connection_secret_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."external_memory_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."external_memory_grant"
  ADD CONSTRAINT "external_memory_grant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."external_memory_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
